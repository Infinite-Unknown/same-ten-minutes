import { describe, expect, it } from 'vitest';
import type { AreaData } from '../src/engine/area.ts';
import { UNVERIFIED_KERB, UNVERIFIED_SLOPE, buildGraph, nearestNode, parseIncline } from '../src/engine/graph.ts';
import { rankFixes, rankFixesBruteForce, reach, stats } from '../src/engine/reach.ts';
import { MAX_WHEELCHAIR_SLOPE, walkSpeed, wheelchairSpeed } from '../src/engine/profiles.ts';

// ~111 m per 0.001 degree of latitude at the equator
const D = 0.001;

function area(
  nodes: [number, number, number, number][],
  ways: { id: number; n: number[]; t: Record<string, string> }[],
  nodeTags: AreaData['nodeTags'] = {},
  pois: AreaData['pois'] = [],
): AreaData {
  return {
    version: 1, id: 't', name: 'test', center: [0, 0], bbox: [-1, -1, 1, 1], fetchedAt: '', attribution: '',
    nodes, nodeTags, ways, pois,
  };
}

/** A straight street of k segments, each ~111 m, running north from (0,0). */
function line(k: number, ele: (i: number) => number = () => 0) {
  return Array.from({ length: k + 1 }, (_, i) => [i + 1, i * D, 0, ele(i)] as [number, number, number, number]);
}

describe('profiles', () => {
  it('wheelchair is never faster than walking and stops past 1:12', () => {
    for (let s = -0.2; s <= 0.2; s += 0.005) {
      const wc = wheelchairSpeed(s);
      expect(wc).toBeLessThanOrEqual(walkSpeed(s) + 1e-9);
      if (Math.abs(s) > MAX_WHEELCHAIR_SLOPE + 1e-6) expect(wc).toBe(0);
      else expect(wc).toBeGreaterThan(0);
    }
  });
  it('parses incline tags', () => {
    expect(parseIncline('10%')).toBeCloseTo(0.1);
    expect(parseIncline('-5%')).toBeCloseTo(-0.05);
    expect(parseIncline('up')).toBeNaN();
  });
});

describe('reach', () => {
  it('stairs block the wheelchair but not the walker', () => {
    const g = buildGraph(area(line(3), [
      { id: 1, n: [1, 2], t: { highway: 'footway', surface: 'paving_stones' } },
      { id: 2, n: [2, 3], t: { highway: 'steps' } },
      { id: 3, n: [3, 4], t: { highway: 'footway', surface: 'asphalt' } },
    ]));
    const start = nearestNode(g, 0, 0).node;
    const walk = reach(g, { profile: 'walk', start, budget: 600 });
    const wc = reach(g, { profile: 'wheelchair', start, budget: 600 });
    expect(walk[3]).toBeLessThan(Infinity);
    expect(wc[1]).toBeLessThan(Infinity);
    expect(wc[2]).toBe(Infinity);
    expect(wc[3]).toBe(Infinity);
    expect(g.barriers.find((b) => b.kind === 'steps')).toBeTruthy();
  });

  it('a slope beyond 1:12 blocks the wheelchair; a gentle one only slows it', () => {
    // 111 m segments: a 6 m rise is ~5.4%, a 12 m rise is ~10.8%
    const gentle = buildGraph(area(line(1, (i) => i * 6), [{ id: 1, n: [1, 2], t: { highway: 'residential' } }]));
    const steep = buildGraph(area(line(1, (i) => i * 12), [{ id: 1, n: [1, 2], t: { highway: 'residential' } }]), { hills: 'block' });
    const flagged = buildGraph(area(line(1, (i) => i * 12), [{ id: 1, n: [1, 2], t: { highway: 'residential' } }]));
    const tagged = buildGraph(area(line(1), [{ id: 1, n: [1, 2], t: { highway: 'residential', incline: '12%' } }]));
    const flat = buildGraph(area(line(1), [{ id: 1, n: [1, 2], t: { highway: 'residential' } }]));
    const t = (g: ReturnType<typeof buildGraph>) => reach(g, { profile: 'wheelchair', start: 0, budget: 1e6 })[1];
    expect(t(steep)).toBe(Infinity);
    expect(t(gentle)).toBeGreaterThan(t(flat));
    expect(t(gentle)).toBeLessThan(Infinity);
    expect(steep.barriers[0].kind).toBe('steep');
    expect(steep.barriers[0].fixable).toBe(false);
    // by default a terrain estimate is flagged as unverified, not blocked
    expect(t(flagged)).toBeLessThan(Infinity);
    expect(flagged.unverified[0] & UNVERIFIED_SLOPE).toBeTruthy();
    // an explicit incline tag always counts
    expect(t(tagged)).toBe(Infinity);
  });

  it('a tagged raised kerb blocks; an untagged kerb passes but is marked unverified', () => {
    const nodes = line(2);
    const raised = buildGraph(area(nodes, [{ id: 1, n: [1, 2, 3], t: { highway: 'footway', surface: 'asphalt' } }], { 2: { barrier: 'kerb', kerb: 'raised' } }));
    const unknown = buildGraph(area(nodes, [{ id: 1, n: [1, 2, 3], t: { highway: 'footway', surface: 'asphalt' } }], { 2: { barrier: 'kerb' } }));
    expect(reach(raised, { profile: 'wheelchair', start: 0, budget: 1e6 })[2]).toBe(Infinity);
    const arr = reach(unknown, { profile: 'wheelchair', start: 0, budget: 1e6 });
    expect(arr[2]).toBeLessThan(Infinity);
    expect([...unknown.unverified]).toEqual([UNVERIFIED_KERB, UNVERIFIED_KERB]);
    const s = stats(unknown, arr, 1e6, 'wheelchair');
    expect(s.verifiedLength).toBe(0);
    expect(s.length).toBeGreaterThan(200);
  });

  it('walking reach always contains wheelchair reach on a real-ish mesh', () => {
    for (const hills of ['flag', 'block'] as const) {
    const g = buildGraph(mesh(), { hills });
    for (const start of [0, 7, 20, 35]) {
      for (const budget of [120, 300, 600]) {
        const walk = reach(g, { profile: 'walk', start, budget });
        const wc = reach(g, { profile: 'wheelchair', start, budget });
        for (let v = 0; v < g.n; v++) if (wc[v] < Infinity) expect(walk[v]).toBeLessThanOrEqual(wc[v] + 1e-3);
        expect(stats(g, walk, budget, 'walk').length + 1e-6).toBeGreaterThanOrEqual(stats(g, wc, budget, 'wheelchair').length);
      }
    }
    }
  });
});

/** 6x6 grid with stairs, a raised kerb, a steep block and a clinic behind them. */
function mesh(): AreaData {
  const nodes: [number, number, number, number][] = [];
  const id = (r: number, c: number) => r * 6 + c + 1;
  for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) nodes.push([id(r, c), r * D, c * D, r >= 4 ? 25 : 0]);
  const ways: AreaData['ways'] = [];
  let wid = 1;
  for (let r = 0; r < 6; r++) for (let c = 0; c < 5; c++) {
    const t: Record<string, string> = { highway: 'footway', surface: 'asphalt' };
    if (r === 2 && c === 3) t.highway = 'steps';
    ways.push({ id: wid++, n: [id(r, c), id(r, c + 1)], t });
  }
  for (let c = 0; c < 6; c++) for (let r = 0; r < 5; r++) {
    const t: Record<string, string> = { highway: 'residential' };
    if (c === 4 && r === 1) t.highway = 'steps';
    if (c === 1 && r === 2) t.wheelchair = 'no';
    ways.push({ id: wid++, n: [id(r, c), id(r + 1, c)], t });
  }
  return area(nodes, ways, { [id(3, 2)]: { barrier: 'kerb', kerb: 'raised' } }, [
    { id: 'n1', cat: 'health', kind: 'clinic', name: 'Clinic', lat: 3 * D, lon: 5 * D },
    { id: 'n2', cat: 'school', kind: 'school', name: 'School', lat: 2 * D, lon: 4 * D },
  ]);
}

describe('fix ranking', () => {
  it('equals brute force over every barrier', () => {
    for (const hills of ['flag', 'block'] as const) {
    const g = buildGraph(mesh(), { hills });
    for (const start of [0, 3, 14, 30]) {
      for (const budget of [180, 400, 900]) {
        const base = reach(g, { profile: 'wheelchair', start, budget });
        const fast = rankFixes(g, start, budget, base, 99);
        const slow = rankFixesBruteForce(g, start, budget, base, 99);
        expect(fast.map((f) => [f.barrier, Math.round(f.gainLength)])).toEqual(slow.map((f) => [f.barrier, Math.round(f.gainLength)]));
      }
    }
    }
  });

  it('fixing a barrier never shrinks the reach, and the top fix gains street length', () => {
    const g = buildGraph(mesh());
    const base = reach(g, { profile: 'wheelchair', start: 0, budget: 900 });
    const baseLen = stats(g, base, 900, 'wheelchair').length;
    const fixes = rankFixes(g, 0, 900, base, 99);
    expect(fixes.length).toBeGreaterThan(0);
    for (const f of fixes) {
      expect(f.stats.length).toBeGreaterThanOrEqual(baseLen - 1e-6);
      for (let v = 0; v < g.n; v++) if (base[v] < Infinity) expect(f.arr[v]).toBeLessThanOrEqual(base[v] + 1e-3);
    }
    for (let i = 1; i < fixes.length; i++) expect(fixes[i - 1].gainLength).toBeGreaterThanOrEqual(fixes[i].gainLength);
  });
});
