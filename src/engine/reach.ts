// Time-budgeted Dijkstra per profile, reach statistics, and the barrier-removal ranking.

import type { Graph } from './graph.ts';
import type { PoiCategory } from './area.ts';
import type { Profile } from './profiles.ts';

/** Binary min-heap of (key, node) with lazy deletion. */
class Heap {
  keys = new Float64Array(1024);
  vals = new Uint32Array(1024);
  size = 0;
  push(k: number, v: number) {
    if (this.size === this.keys.length) {
      const nk = new Float64Array(this.size * 2); nk.set(this.keys); this.keys = nk;
      const nv = new Uint32Array(this.size * 2); nv.set(this.vals); this.vals = nv;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= k) break;
      this.keys[i] = this.keys[p]; this.vals[i] = this.vals[p]; i = p;
    }
    this.keys[i] = k; this.vals[i] = v;
  }
  pop(): number {
    const top = this.vals[0];
    const k = this.keys[--this.size], v = this.vals[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= k) break;
      this.keys[i] = this.keys[c]; this.vals[i] = this.vals[c]; i = c;
    }
    this.keys[i] = k; this.vals[i] = v;
    return top;
  }
  get minKey() { return this.keys[0]; }
}

export interface ReachOptions {
  profile: Profile;
  start: number;
  /** seconds */
  budget: number;
  /** barrier index treated as fixed (wheelchair only) */
  open?: number;
}

/** Edge travel seconds in the given direction for a profile. */
export function edgeTime(g: Graph, e: number, forward: boolean, profile: Profile, open = -1): number {
  if (profile === 'walk') return forward ? g.walkAB[e] : g.walkBA[e];
  if (open >= 0 && g.edgeBarrier[e] === open) return forward ? g.fixAB[e] : g.fixBA[e];
  return forward ? g.wcAB[e] : g.wcBA[e];
}

/** Arrival time (seconds) at every node; Infinity beyond the budget or unreachable. */
export function reach(g: Graph, o: ReachOptions): Float32Array {
  const arr = new Float32Array(g.n).fill(Infinity);
  const open = o.open ?? -1;
  const wc = o.profile === 'wheelchair';
  const heap = new Heap();
  arr[o.start] = 0;
  heap.push(0, o.start);
  while (heap.size) {
    const t = heap.minKey;
    const v = heap.pop();
    if (t > arr[v]) continue;
    for (let i = g.adjStart[v]; i < g.adjStart[v + 1]; i++) {
      const e = g.adjEdge[i];
      const fwd = g.ea[e] === v;
      const w = fwd ? g.eb[e] : g.ea[e];
      if (wc && g.nodeBarrier[w] >= 0 && g.nodeBarrier[w] !== open) continue;
      // keys are stored at float32 precision, the same as arr, so the stale-entry check is exact
      const nt = Math.fround(t + edgeTime(g, e, fwd, o.profile, open));
      if (nt <= o.budget && nt < arr[w]) {
        arr[w] = nt;
        heap.push(nt, w);
      }
    }
  }
  return arr;
}

/** Fraction [0,1] of edge e covered by time T, from both ends. */
export function edgeCover(g: Graph, arr: Float32Array, e: number, T: number, profile: Profile, open = -1): number {
  const a = g.ea[e], b = g.eb[e];
  let c = 0;
  const ta = arr[a], tb = arr[b];
  if (ta <= T) {
    const d = edgeTime(g, e, true, profile, open);
    if (d < Infinity) c += d > 0 ? (T - ta) / d : 1;
  }
  if (tb <= T) {
    const d = edgeTime(g, e, false, profile, open);
    if (d < Infinity) c += d > 0 ? (T - tb) / d : 1;
  }
  return c > 1 ? 1 : c;
}

export type PoiCounts = Record<PoiCategory, number>;

export interface ReachStats {
  /** metres of street reached */
  length: number;
  /** metres of reached street with explicit tags (wheelchair confidence) */
  verifiedLength: number;
  pois: PoiCounts;
  poiIds: string[];
}

export function stats(g: Graph, arr: Float32Array, T: number, profile: Profile, open = -1): ReachStats {
  let length = 0, verified = 0;
  for (let e = 0; e < g.m; e++) {
    if (arr[g.ea[e]] > T && arr[g.eb[e]] > T) continue;
    const l = edgeCover(g, arr, e, T, profile, open) * g.len[e];
    length += l;
    if (!g.unverified[e]) verified += l;
  }
  const pois: PoiCounts = { health: 0, school: 0, transit: 0 };
  const poiIds: string[] = [];
  for (const p of g.pois) {
    if (p.at >= 0 && arr[p.at] <= T) { pois[p.cat]++; poiIds.push(p.id); }
  }
  return { length, verifiedLength: verified, pois, poiIds };
}

export interface FixResult {
  barrier: number;
  gainLength: number;
  gainPois: number;
  /** POI ids newly reached */
  newPois: string[];
  arr: Float32Array;
  stats: ReachStats;
}

/** Barriers that a wheelchair user reaches within the budget (the edge of their reach). */
export function frontierBarriers(g: Graph, wcArr: Float32Array, budget: number): number[] {
  const seen = new Set<number>();
  for (let e = 0; e < g.m; e++) {
    const b = g.edgeBarrier[e];
    if (b >= 0 && (wcArr[g.ea[e]] <= budget || wcArr[g.eb[e]] <= budget)) seen.add(b);
  }
  for (let v = 0; v < g.n; v++) {
    const b = g.nodeBarrier[v];
    if (b < 0) continue;
    for (let i = g.adjStart[v]; i < g.adjStart[v + 1]; i++) {
      const e = g.adjEdge[i];
      const w = g.ea[e] === v ? g.eb[e] : g.ea[e];
      if (wcArr[w] <= budget) { seen.add(b); break; }
    }
  }
  return [...seen];
}

function rankKey(a: FixResult, b: FixResult) {
  return b.gainLength - a.gainLength || b.gainPois - a.gainPois || a.barrier - b.barrier;
}

/**
 * Try fixing each candidate barrier alone and rank by street length then places gained.
 * Only barriers on the edge of the current reach can change it, so only those are tried
 * (`rankFixesBruteForce` checks every barrier and must agree).
 */
export function rankFixes(g: Graph, start: number, budget: number, base: Float32Array, limit = 3): FixResult[] {
  const candidates = frontierBarriers(g, base, budget).filter((b) => g.barriers[b].fixable);
  return evaluate(g, start, budget, base, candidates).slice(0, limit);
}

export function rankFixesBruteForce(g: Graph, start: number, budget: number, base: Float32Array, limit = 3): FixResult[] {
  const all = g.barriers.map((_, i) => i).filter((b) => g.barriers[b].fixable);
  return evaluate(g, start, budget, base, all).slice(0, limit);
}

function evaluate(g: Graph, start: number, budget: number, base: Float32Array, candidates: number[]): FixResult[] {
  const baseStats = stats(g, base, budget, 'wheelchair');
  const baseSet = new Set(baseStats.poiIds);
  const out: FixResult[] = [];
  for (const b of candidates) {
    const arr = reach(g, { profile: 'wheelchair', start, budget, open: b });
    const s = stats(g, arr, budget, 'wheelchair', b);
    const gainLength = s.length - baseStats.length;
    const newPois = s.poiIds.filter((id) => !baseSet.has(id));
    if (gainLength < 1 && newPois.length === 0) continue;
    out.push({ barrier: b, gainLength, gainPois: newPois.length, newPois, arr, stats: s });
  }
  return out.sort(rankKey);
}
