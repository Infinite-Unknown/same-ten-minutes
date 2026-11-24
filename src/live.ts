// Fetch any other place live: OpenStreetMap through Overpass, terrain tiles for
// elevation. Every response is cached in the browser so a place is fetched once.

import { bboxAround, compactOverpass, overpassQuery, type AreaData } from './engine/area.ts';
import { ELEVATION_ZOOM, makeSampler, terrariumUrl, tilesForBbox, type TilePixels } from './engine/elevation.ts';

const SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
export const AREA_HALF_KM = 1.35;
const CACHE = 'same-ten-minutes-v1';

export class LiveError extends Error {
  constructor(public kind: 'busy' | 'offline' | 'empty' | 'failed', message: string) {
    super(message);
  }
}

async function cached<T>(key: string, make: () => Promise<T>): Promise<T> {
  let cache: Cache | null = null;
  try { cache = await caches.open(CACHE); } catch { /* storage blocked: fetch every time */ }
  const url = `https://cache.local/${encodeURIComponent(key)}`;
  const hit = cache && (await cache.match(url));
  if (hit) return hit.json();
  const v = await make();
  try { await cache?.put(url, new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } })); } catch { /* quota: fine */ }
  return v;
}

async function overpass(query: string, signal: AbortSignal): Promise<{ elements: never[] }> {
  if (!navigator.onLine) throw new LiveError('offline', 'You are offline. The bundled places still work.');
  let last = 0;
  for (const url of SERVERS) {
    try {
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), signal });
      if (res.ok) return res.json();
      last = res.status;
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
    }
  }
  if (last === 429 || last === 502 || last === 503 || last === 504)
    throw new LiveError('busy', 'The OpenStreetMap server is busy right now. Try again in a minute.');
  throw new LiveError('failed', 'Could not reach the OpenStreetMap server.');
}

async function tile(z: number, x: number, y: number): Promise<Uint8ClampedArray> {
  const res = await fetch(terrariumUrl(z, x, y));
  if (!res.ok) throw new LiveError('failed', 'Terrain data did not load.');
  const bmp = await createImageBitmap(await res.blob());
  const c = new OffscreenCanvas(256, 256);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  return ctx.getImageData(0, 0, 256, 256).data;
}

export async function fetchArea(lat: number, lon: number, name: string, onStep: (s: string) => void, signal: AbortSignal): Promise<AreaData> {
  const key = `area:${lat.toFixed(3)},${lon.toFixed(3)}`;
  return cached(key, async () => {
    const bbox = bboxAround(lat, lon, AREA_HALF_KM);
    onStep('Fetching streets from OpenStreetMap');
    const raw = await overpass(overpassQuery(bbox), signal);
    if (!raw.elements.length) throw new LiveError('empty', 'No walkable streets are mapped here yet.');
    onStep('Reading the terrain');
    let s = 90, w = 180, n = -90, e = -180;
    for (const el of raw.elements as { type: string; lat?: number; lon?: number }[]) {
      if (el.type !== 'node' || el.lat === undefined || el.lon === undefined) continue;
      s = Math.min(s, el.lat); n = Math.max(n, el.lat); w = Math.min(w, el.lon); e = Math.max(e, el.lon);
    }
    const tiles: TilePixels = new Map();
    for (const t of tilesForBbox([s, w, n, e])) tiles.set(`${t.x}/${t.y}`, await tile(ELEVATION_ZOOM, t.x, t.y));
    const area = compactOverpass(raw, { id: `live-${lat.toFixed(3)}-${lon.toFixed(3)}`, name, center: [lat, lon], bbox }, makeSampler(tiles));
    if (!area.ways.length) throw new LiveError('empty', 'No walkable streets are mapped here yet.');
    return area;
  });
}

export interface Place { lat: number; lon: number; name: string }

/** Nominatim search: one request per submitted query, never per keystroke. */
export async function geocode(q: string, signal: AbortSignal): Promise<Place | null> {
  if (!navigator.onLine) throw new LiveError('offline', 'You are offline. Search needs a connection; the bundled places still work.');
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { signal, headers: { 'Accept-Language': navigator.language || 'en' } });
  if (!res.ok) throw new LiveError(res.status === 429 ? 'busy' : 'failed', 'Place search is not answering. Try again in a moment.');
  const list = (await res.json()) as { lat: string; lon: string; display_name: string; name?: string }[];
  if (!list.length) return null;
  const r = list[0];
  return { lat: +r.lat, lon: +r.lon, name: r.name || r.display_name.split(',')[0] };
}
