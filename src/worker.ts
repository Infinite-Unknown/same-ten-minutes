/// <reference lib="webworker" />
// Routing runs here so the ink animation never waits on a search.

import type { AreaData } from './engine/area.ts';
import { UNVERIFIED_KERB, UNVERIFIED_SLOPE, UNVERIFIED_SURFACE, buildGraph, nearestNode, type Graph } from './engine/graph.ts';
import { frontierBarriers, rankFixes, reach, stats } from './engine/reach.ts';
import type { WorkerIn, WorkerOut, ReachResult } from './protocol.ts';

let graph: Graph | null = null;
let area: AreaData | null = null;

const post = (msg: WorkerOut) => (self as unknown as Worker).postMessage(msg);

self.onmessage = (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'load') {
      area = msg.area;
      graph = buildGraph(area, { hills: msg.hills });
      const g = graph;
      post({
        type: 'loaded', areaId: area.id,
        geo: {
          n: g.n, m: g.m, lat: g.lat, lon: g.lon, ea: g.ea, eb: g.eb, len: g.len,
          walkAB: g.walkAB, walkBA: g.walkBA, wcAB: g.wcAB, wcBA: g.wcBA, fixAB: g.fixAB, fixBA: g.fixBA,
          edgeBarrier: g.edgeBarrier, nodeBarrier: g.nodeBarrier, unverified: g.unverified,
        },
        barriers: g.barriers.map((b) => ({ kind: b.kind, osm: b.osm, label: b.label, fixable: b.fixable, node: b.node, edges: b.edges })),
        pois: g.pois,
      });
      return;
    }
    if (msg.type === 'reach') {
      if (!graph) throw new Error('No area loaded');
      const g = graph;
      const snap = nearestNode(g, msg.lat, msg.lon);
      if (snap.node < 0 || snap.dist > 250) {
        post({ type: 'reach', id: msg.id, error: 'far', startDist: snap.dist });
        return;
      }
      const B = msg.budget;
      const walk = reach(g, { profile: 'walk', start: snap.node, budget: B });
      const wc = reach(g, { profile: 'wheelchair', start: snap.node, budget: B });
      const ws = stats(g, walk, B, 'walk');
      const cs = stats(g, wc, B, 'wheelchair');
      const fixes = rankFixes(g, snap.node, B, wc, 3);
      // why unverified: share of wheelchair-reached length per reason
      const why = { surface: 0, kerb: 0, slope: 0 };
      for (let e = 0; e < g.m; e++) {
        const u = g.unverified[e];
        if (!u) continue;
        const ta = wc[g.ea[e]], tb = wc[g.eb[e]];
        if (ta > B && tb > B) continue;
        const l = g.len[e];
        if (u & UNVERIFIED_SURFACE) why.surface += l;
        if (u & UNVERIFIED_KERB) why.kerb += l;
        if (u & UNVERIFIED_SLOPE) why.slope += l;
      }
      const res: ReachResult = {
        type: 'reach', id: msg.id, start: snap.node, startDist: snap.dist, budget: B,
        walk, wc, walkStats: ws, wcStats: cs,
        frontier: frontierBarriers(g, wc, B),
        fixes: fixes.map((f) => ({ barrier: f.barrier, gainLength: f.gainLength, gainPois: f.gainPois, newPois: f.newPois, arr: f.arr, stats: f.stats })),
        unverifiedWhy: why,
      };
      post(res);
    }
  } catch (e) {
    post({ type: 'error', message: (e as Error).message });
  }
};
