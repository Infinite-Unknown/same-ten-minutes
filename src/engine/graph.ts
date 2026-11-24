// Street graph with two travel profiles. One edge per consecutive node pair of an
// OpenStreetMap way, so the ink can follow every bend of the street.

import type { AreaData, Poi, Tags } from './area.ts';
import {
  BAD_SMOOTHNESS, BAD_SURFACES, BLOCKING_NODE_BARRIERS, MAX_WHEELCHAIR_SLOPE, MIN_WIDTH_M,
  STEPS_WALK_SPEED, WHEELCHAIR_SPEED, WHEELCHAIR_STEEP_FACTOR, walkSpeed, wheelchairSpeed,
} from './profiles.ts';

export type BarrierKind = 'steps' | 'kerb' | 'steep' | 'surface' | 'narrow' | 'no_access' | 'gate';

export interface Barrier {
  kind: BarrierKind;
  /** OSM object this barrier comes from, e.g. "way/123" or "node/456". */
  osm: string;
  label: string;
  /** a ramp, a dropped kerb or a resurfacing can remove it; a hill cannot be fixed by one change */
  fixable: boolean;
  edges: number[];
  /** node index for node barriers, otherwise -1 */
  node: number;
}

export interface SnappedPoi extends Poi {
  /** nearest graph node, or -1 when no walkable street is within reach */
  at: number;
}

export interface Graph {
  n: number;
  lat: Float64Array;
  lon: Float64Array;
  m: number;
  ea: Uint32Array;
  eb: Uint32Array;
  len: Float32Array;
  /** signed slope, a -> b */
  slope: Float32Array;
  /** travel seconds per direction; Infinity = impassable */
  walkAB: Float32Array;
  walkBA: Float32Array;
  wcAB: Float32Array;
  wcBA: Float32Array;
  /** wheelchair seconds if this edge's barrier were fixed */
  fixAB: Float32Array;
  fixBA: Float32Array;
  /** barrier index blocking this edge for a wheelchair, -1 none */
  edgeBarrier: Int32Array;
  /** barrier index blocking this node for a wheelchair, -1 none */
  nodeBarrier: Int32Array;
  /** bit flags: UNVERIFIED_SURFACE | UNVERIFIED_KERB | UNVERIFIED_SLOPE; 0 = the map says this edge is fine */
  unverified: Uint8Array;
  /** CSR adjacency: for node v, entries adjStart[v]..adjStart[v+1]-1 of adjEdge */
  adjStart: Uint32Array;
  adjEdge: Uint32Array;
  barriers: Barrier[];
  pois: SnappedPoi[];
  wayName: string[];
  edgeWay: Int32Array;
}

const R = 6371008.8;
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
  const p = Math.PI / 180;
  const dLat = (lat2 - lat1) * p;
  const dLon = (lon2 - lon1) * p;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

const FOOT_ONLY = new Set(['footway', 'path', 'pedestrian', 'cycleway', 'track', 'bridleway', 'corridor']);
export const SLOPE_BASELINE = { m: 80 };

function parseWidth(v: string | undefined): number {
  if (!v) return NaN;
  const m = /^\s*([\d.]+)\s*(m|cm)?\s*$/.exec(v);
  if (!m) return NaN;
  return m[2] === 'cm' ? parseFloat(m[1]) / 100 : parseFloat(m[1]);
}

/** Parse an incline tag to a signed fraction in way direction; NaN when not numeric. */
export function parseIncline(v: string | undefined): number {
  if (!v) return NaN;
  const pct = /^\s*(-?[\d.]+)\s*%\s*$/.exec(v);
  if (pct) return parseFloat(pct[1]) / 100;
  const deg = /^\s*(-?[\d.]+)\s*°\s*$/.exec(v);
  if (deg) return Math.tan((parseFloat(deg[1]) * Math.PI) / 180);
  return NaN;
}

function walkable(t: Tags): boolean {
  if (t.foot === 'no') return false;
  if ((t.access === 'no' || t.access === 'private') && t.foot !== 'yes' && t.foot !== 'designated') return false;
  if (t.area === 'yes' && t.highway !== 'pedestrian') return false;
  return true;
}

function wayLabel(t: Tags, kind: BarrierKind): string {
  const name = t.name ? ` on ${t.name}` : '';
  switch (kind) {
    case 'steps': return t.conveying ? `Escalator${name}` : `Steps${name}`;
    case 'steep': return `Steep section${name}`;
    case 'surface': return `Rough surface${name}`;
    case 'narrow': return `Narrow path${name}`;
    case 'no_access': return `Marked not wheelchair accessible${name}`;
    default: return `Barrier${name}`;
  }
}

/** Which wheelchair barrier, if any, a way's tags imply (slope is handled per edge). */
function wayBarrier(t: Tags): BarrierKind | null {
  if (t.wheelchair === 'yes' || t.wheelchair === 'designated') return null;
  if (t.highway === 'steps') {
    if (t['ramp:wheelchair'] === 'yes' || t.ramp === 'yes') return null;
    return 'steps';
  }
  if (t.wheelchair === 'no') return 'no_access';
  if (t.surface && BAD_SURFACES.has(t.surface)) return 'surface';
  if (t.smoothness && BAD_SMOOTHNESS.has(t.smoothness)) return 'surface';
  const w = parseWidth(t.width);
  if (!Number.isNaN(w) && w < MIN_WIDTH_M) return 'narrow';
  return null;
}

export const UNVERIFIED_SURFACE = 1;
export const UNVERIFIED_KERB = 2;
export const UNVERIFIED_SLOPE = 4;

export interface BuildOptions {
  /**
   * 'flag' (default): a slope estimated from terrain data beyond 1:12 is drawn as
   * unverified and slowed, not blocked, because ~30 m terrain data cannot judge one
   * street. 'block': treat it as impassable. Tagged inclines always count.
   */
  hills?: 'flag' | 'block';
}

export function buildGraph(area: AreaData, opts: BuildOptions = {}): Graph {
  const hills = opts.hills ?? 'flag';
  const idx = new Map<number, number>();
  const n = area.nodes.length;
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  const ele = new Float32Array(n);
  area.nodes.forEach(([id, la, lo, el], i) => {
    idx.set(id, i);
    lat[i] = la;
    lon[i] = lo;
    ele[i] = el;
  });
  const osmIds = area.nodes.map((x) => x[0]);

  // node barriers and unverified kerbs
  const barriers: Barrier[] = [];
  const nodeBarrier = new Int32Array(n).fill(-1);
  const nodeUnverified = new Uint8Array(n);
  const nodeKerbKnown = new Uint8Array(n);
  for (const [sid, t] of Object.entries(area.nodeTags)) {
    const i = idx.get(Number(sid));
    if (i === undefined) continue;
    const wcYes = t.wheelchair === 'yes' || t.wheelchair === 'designated';
    if (t.barrier === 'kerb' || t.kerb) {
      const k = t.kerb;
      if (k === 'raised' && !wcYes) {
        nodeBarrier[i] = barriers.length;
        barriers.push({ kind: 'kerb', osm: `node/${sid}`, label: 'Raised kerb', fixable: true, edges: [], node: i });
      } else if (!k || k === 'yes' || k === 'regular') {
        if (!wcYes) nodeUnverified[i] = 1;
      } else nodeKerbKnown[i] = 1;
    }
    if (t.barrier && BLOCKING_NODE_BARRIERS.has(t.barrier) && !wcYes && nodeBarrier[i] < 0) {
      nodeBarrier[i] = barriers.length;
      barriers.push({ kind: 'gate', osm: `node/${sid}`, label: t.barrier.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()), fixable: true, edges: [], node: i });
    }
    if (t.wheelchair === 'no' && nodeBarrier[i] < 0) {
      nodeBarrier[i] = barriers.length;
      barriers.push({ kind: 'no_access', osm: `node/${sid}`, label: 'Marked not wheelchair accessible', fixable: true, edges: [], node: i });
    }
  }

  const ea: number[] = [], eb: number[] = [], len: number[] = [], slope: number[] = [];
  const walkAB: number[] = [], walkBA: number[] = [], wcAB: number[] = [], wcBA: number[] = [];
  const fixAB: number[] = [], fixBA: number[] = [], edgeBarrier: number[] = [], unverified: number[] = [];
  const edgeWay: number[] = [];
  const wayName: string[] = [];

  area.ways.forEach((w, wi) => {
    const t = w.t;
    wayName.push(t.name ?? '');
    if (!walkable(t)) return;
    const ids = w.n.map((id) => idx.get(id)!).filter((v) => v !== undefined);
    if (ids.length < 2) return;
    // cumulative distance and elevation along the way
    const cum = [0];
    for (let k = 1; k < ids.length; k++) cum.push(cum[k - 1] + haversine(lat[ids[k - 1]], lon[ids[k - 1]], lat[ids[k]], lon[ids[k]]));
    const L = cum[cum.length - 1];
    const elevAt = (d: number) => {
      let k = 1;
      while (k < cum.length - 1 && cum[k] < d) k++;
      const d0 = cum[k - 1], d1 = cum[k];
      const f = d1 > d0 ? (d - d0) / (d1 - d0) : 0;
      return ele[ids[k - 1]] * (1 - f) + ele[ids[k]] * f;
    };
    const tagIncline = parseIncline(t.incline);
    const elevated = t.bridge && t.bridge !== 'no' || t.tunnel && t.tunnel !== 'no' || t.indoor === 'yes' || t.highway === 'corridor';
    const kind = wayBarrier(t);
    const footOnly = FOOT_ONLY.has(t.highway) || t.highway === 'steps';
    const isCrossing = t.footway === 'crossing' || t.highway === 'crossing';
    const crossingKerbKnown = !!t.kerb || t.wheelchair === 'yes' || t.wheelchair === 'no' ||
      nodeKerbKnown[ids[0]] === 1 || nodeKerbKnown[ids[ids.length - 1]] === 1;
    const surfaceKnown = !!t.surface || !!t.smoothness || t.wheelchair === 'yes' || t.wheelchair === 'designated';
    const wayUnverifiedSurface = footOnly && !surfaceKnown;
    const wayUnverifiedKerb = isCrossing && !crossingKerbKnown;

    let wayBarrierIdx = -1;
    if (kind) {
      wayBarrierIdx = barriers.length;
      barriers.push({ kind, osm: `way/${w.id}`, label: wayLabel(t, kind), fixable: true, edges: [], node: -1 });
    }
    let steepRun = -1; // barrier index of the current run of steep edges

    for (let k = 0; k + 1 < ids.length; k++) {
      const a = ids[k], b = ids[k + 1];
      const l = cum[k + 1] - cum[k];
      if (l < 0.01) continue;
      // slope: an explicit incline tag wins; otherwise terrain smoothed over a baseline
      // centred on this edge (terrain tiles are ~30 m data and noisy under tall buildings)
      let s: number;
      const tagged = !Number.isNaN(tagIncline);
      if (tagged) s = tagIncline;
      else if (elevated || L <= SLOPE_BASELINE.m) s = L > 1 ? (ele[ids[ids.length - 1]] - ele[ids[0]]) / L : 0;
      else {
        const mid = (cum[k] + cum[k + 1]) / 2;
        const h = Math.max(SLOPE_BASELINE.m / 2, l / 2);
        let d0 = mid - h, d1 = mid + h;
        if (d0 < 0) { d1 -= d0; d0 = 0; }
        if (d1 > L) { d0 -= d1 - L; d1 = L; d0 = Math.max(0, d0); }
        s = (elevAt(d1) - elevAt(d0)) / (d1 - d0);
      }
      if (!Number.isFinite(s)) s = 0;
      const e = ea.length;
      ea.push(a); eb.push(b); len.push(l); slope.push(s); edgeWay.push(wi);

      const steps = t.highway === 'steps';
      walkAB.push(steps ? l / STEPS_WALK_SPEED : l / walkSpeed(s));
      walkBA.push(steps ? l / STEPS_WALK_SPEED : l / walkSpeed(-s));

      const wcYes = t.wheelchair === 'yes' || t.wheelchair === 'designated';
      const tooSteep = Math.abs(s) > MAX_WHEELCHAIR_SLOPE && !wcYes;
      // a tagged incline always blocks; a terrain estimate blocks only in "block" mode
      const blocksBySlope = tooSteep && (tagged || hills === 'block');
      const flaggedSlope = tooSteep && !blocksBySlope;
      let bIdx = wayBarrierIdx;
      if (bIdx < 0 && blocksBySlope) {
        if (steepRun < 0) {
          steepRun = barriers.length;
          barriers.push({ kind: 'steep', osm: `way/${w.id}`, label: wayLabel(t, 'steep'), fixable: false, edges: [], node: -1 });
        }
        bIdx = steepRun;
      } else steepRun = -1;

      // speed once fixed (or on a ramp / flagged slope): a ramp at the 1:12 limit
      const fixV = WHEELCHAIR_SPEED * WHEELCHAIR_STEEP_FACTOR;
      const clampS = (x: number) => Math.max(-MAX_WHEELCHAIR_SLOPE, Math.min(MAX_WHEELCHAIR_SLOPE, x));
      if (bIdx >= 0) {
        barriers[bIdx].edges.push(e);
        wcAB.push(Infinity); wcBA.push(Infinity);
        fixAB.push(l / Math.min(fixV, steps ? fixV : walkSpeed(s))); fixBA.push(l / Math.min(fixV, steps ? fixV : walkSpeed(-s)));
      } else {
        const cap = steps ? fixV : Infinity;
        const vab = Math.min(wheelchairSpeed(clampS(s)), walkSpeed(s), cap);
        const vba = Math.min(wheelchairSpeed(clampS(-s)), walkSpeed(-s), cap);
        wcAB.push(vab > 0 ? l / vab : Infinity);
        wcBA.push(vba > 0 ? l / vba : Infinity);
        fixAB.push(Infinity); fixBA.push(Infinity);
      }
      edgeBarrier.push(bIdx);
      unverified.push(
        (wayUnverifiedSurface ? UNVERIFIED_SURFACE : 0) |
        (wayUnverifiedKerb || nodeUnverified[a] || nodeUnverified[b] ? UNVERIFIED_KERB : 0) |
        (flaggedSlope ? UNVERIFIED_SLOPE : 0),
      );
    }
  });

  const m = ea.length;
  // adjacency
  const deg = new Uint32Array(n + 1);
  for (let e = 0; e < m; e++) { deg[ea[e] + 1]++; deg[eb[e] + 1]++; }
  for (let v = 0; v < n; v++) deg[v + 1] += deg[v];
  const adjStart = deg.slice();
  const fill = deg.slice(0, n);
  const adjEdge = new Uint32Array(2 * m);
  for (let e = 0; e < m; e++) { adjEdge[fill[ea[e]]++] = e; adjEdge[fill[eb[e]]++] = e; }

  // name unnamed barriers after the street they sit on or lead off
  for (const b of barriers) {
    if (b.label.includes(' on ')) continue;
    const nodes = b.node >= 0 ? [b.node] : b.edges.flatMap((e) => [ea[e], eb[e]]);
    let street = '';
    for (const v of nodes) {
      for (let i = adjStart[v]; i < adjStart[v + 1] && !street; i++) street = wayName[edgeWay[adjEdge[i]]] ?? '';
      if (street) break;
    }
    if (street) b.label += b.kind === 'kerb' || b.kind === 'gate' ? ` at ${street}` : ` off ${street}`;
  }
  const pois = snapPois(area.pois, lat, lon, adjStart, n);
  // still unnamed: say which named place it is near
  const GENERIC = new Set(['Bus stop', 'Station', 'Clinic', 'Hospital', 'Pharmacy', 'Doctor', 'School', 'Kindergarten']);
  for (const b of barriers) {
    if (/ (on|off|at|near) /.test(b.label)) continue;
    const v = b.node >= 0 ? b.node : ea[b.edges[0]];
    if (v === undefined) continue;
    let best = '', bestD = 150;
    for (const p of area.pois) {
      if (GENERIC.has(p.name)) continue;
      const d = haversine(lat[v], lon[v], p.lat, p.lon);
      if (d < bestD) { bestD = d; best = p.name; }
    }
    if (best) b.label += ` near ${best}`;
  }
  void osmIds;

  return {
    n, lat, lon, m,
    ea: Uint32Array.from(ea), eb: Uint32Array.from(eb), len: Float32Array.from(len), slope: Float32Array.from(slope),
    walkAB: Float32Array.from(walkAB), walkBA: Float32Array.from(walkBA),
    wcAB: Float32Array.from(wcAB), wcBA: Float32Array.from(wcBA),
    fixAB: Float32Array.from(fixAB), fixBA: Float32Array.from(fixBA),
    edgeBarrier: Int32Array.from(edgeBarrier), nodeBarrier, unverified: Uint8Array.from(unverified),
    adjStart, adjEdge, barriers, pois, wayName, edgeWay: Int32Array.from(edgeWay),
  };
}

const SNAP_LIMIT_M = 100;

function snapPois(pois: Poi[], lat: Float64Array, lon: Float64Array, adjStart: Uint32Array, n: number): SnappedPoi[] {
  return pois.map((p) => {
    let best = -1, bestD = Infinity;
    const cos = Math.cos((p.lat * Math.PI) / 180);
    for (let v = 0; v < n; v++) {
      if (adjStart[v + 1] === adjStart[v]) continue;
      const dy = (lat[v] - p.lat) * 111320;
      const dx = (lon[v] - p.lon) * 111320 * cos;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = v; }
    }
    return { ...p, at: Math.sqrt(bestD) <= SNAP_LIMIT_M ? best : -1 };
  });
}

/** Nearest node that has at least one edge, with its distance in metres. */
export function nearestNode(g: Graph, la: number, lo: number): { node: number; dist: number } {
  let best = -1, bestD = Infinity;
  const cos = Math.cos((la * Math.PI) / 180);
  for (let v = 0; v < g.n; v++) {
    if (g.adjStart[v + 1] === g.adjStart[v]) continue;
    const dy = (g.lat[v] - la) * 111320;
    const dx = (g.lon[v] - lo) * 111320 * cos;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = v; }
  }
  return { node: best, dist: Math.sqrt(bestD) };
}
