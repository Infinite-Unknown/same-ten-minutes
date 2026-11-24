import type { AreaData } from './engine/area.ts';
import type { BarrierKind, SnappedPoi } from './engine/graph.ts';
import type { ReachStats } from './engine/reach.ts';

export type WorkerIn =
  | { type: 'load'; area: AreaData; hills: 'flag' | 'block' }
  | { type: 'reach'; id: number; lat: number; lon: number; budget: number };

export interface Geo {
  n: number;
  m: number;
  lat: Float64Array;
  lon: Float64Array;
  ea: Uint32Array;
  eb: Uint32Array;
  len: Float32Array;
  walkAB: Float32Array;
  walkBA: Float32Array;
  wcAB: Float32Array;
  wcBA: Float32Array;
  fixAB: Float32Array;
  fixBA: Float32Array;
  edgeBarrier: Int32Array;
  nodeBarrier: Int32Array;
  unverified: Uint8Array;
}

export interface BarrierInfo {
  kind: BarrierKind;
  osm: string;
  label: string;
  fixable: boolean;
  node: number;
  edges: number[];
}

export interface FixInfo {
  barrier: number;
  gainLength: number;
  gainPois: number;
  newPois: string[];
  arr: Float32Array;
  stats: ReachStats;
}

export interface ReachResult {
  type: 'reach';
  id: number;
  start: number;
  startDist: number;
  budget: number;
  walk: Float32Array;
  wc: Float32Array;
  walkStats: ReachStats;
  wcStats: ReachStats;
  frontier: number[];
  fixes: FixInfo[];
  unverifiedWhy: { surface: number; kerb: number; slope: number };
}

export type WorkerOut =
  | { type: 'loaded'; areaId: string; geo: Geo; barriers: BarrierInfo[]; pois: SnappedPoi[] }
  | ReachResult
  | { type: 'reach'; id: number; error: 'far'; startDist: number }
  | { type: 'error'; message: string };
