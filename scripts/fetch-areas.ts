// Fetch the bundled demo areas once, politely: one Overpass request at a time, raw
// responses cached in data-cache/ so a re-run never asks the server again, and backoff
// when a server is busy. Output: public/areas/<id>.json and public/areas/index.json.
//
//   node scripts/fetch-areas.ts            fetch every area not cached yet
//   node scripts/fetch-areas.ts kl-pasar-seni lisbon-baixa   only these

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { bboxAround, compactOverpass, overpassQuery } from '../src/engine/area.ts';
import { ELEVATION_ZOOM, makeSampler, terrariumUrl, tilesForBbox, type TilePixels } from '../src/engine/elevation.ts';

const UA = 'same-ten-minutes-data-script/0.1 (one-off extract of a few small areas)';
const SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
// half-width of each extract: big enough that 15 minutes on foot from the centre stays inside
const HALF_KM = 1.6;

export const AREAS: { id: string; name: string; place: string; lat: number; lon: number }[] = [
  { id: 'kl-masjid-jamek', name: 'Masjid Jamek', place: 'Kuala Lumpur, Malaysia', lat: 3.1473, lon: 101.69497 },
  { id: 'lisbon-martim-moniz', name: 'Martim Moniz', place: 'Lisbon, Portugal', lat: 38.71411, lon: -9.13566 },
  { id: 'hk-central', name: 'Central', place: 'Hong Kong', lat: 22.28195, lon: 114.15805 },
  { id: 'berlin-alexanderplatz', name: 'Alexanderplatz', place: 'Berlin, Germany', lat: 52.52155, lon: 13.41155 },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function overpass(query: string): Promise<unknown> {
  let wait = 20_000;
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = SERVERS[attempt % SERVERS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(150_000),
      });
      if (res.ok) return await res.json();
      console.log(`  ${url} -> HTTP ${res.status}; waiting ${wait / 1000}s`);
    } catch (e) {
      console.log(`  ${url} -> ${(e as Error).message}; waiting ${wait / 1000}s`);
    }
    await sleep(wait);
    wait = Math.min(wait * 2, 160_000);
  }
  throw new Error('Overpass unavailable after retries');
}

async function tilePixels(bbox: [number, number, number, number]): Promise<TilePixels> {
  const tiles: TilePixels = new Map();
  for (const { x, y } of tilesForBbox(bbox)) {
    const file = `data-cache/terrarium-${ELEVATION_ZOOM}-${x}-${y}.png`;
    if (!existsSync(file)) {
      const res = await fetch(terrariumUrl(ELEVATION_ZOOM, x, y), { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`elevation tile ${x}/${y}: HTTP ${res.status}`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      await sleep(200);
    }
    const png = PNG.sync.read(readFileSync(file));
    tiles.set(`${x}/${y}`, png.data);
  }
  return tiles;
}

async function main() {
  mkdirSync('data-cache', { recursive: true });
  mkdirSync('public/areas', { recursive: true });
  const only = process.argv.slice(2);
  for (const a of AREAS) {
    if (only.length && !only.includes(a.id)) continue;
    const bbox = bboxAround(a.lat, a.lon, HALF_KM);
    const rawFile = `data-cache/overpass-${a.id}-${HALF_KM}.json`;
    if (!existsSync(rawFile)) {
      console.log(`Overpass: ${a.id} ${bbox.join(',')}`);
      let raw: unknown;
      try {
        raw = await overpass(overpassQuery(bbox));
      } catch (e) {
        console.log(`  skipped ${a.id}: ${(e as Error).message}`);
        continue;
      }
      writeFileSync(rawFile, JSON.stringify(raw));
      await sleep(5_000);
    } else console.log(`cached: ${a.id}`);
    const raw = JSON.parse(readFileSync(rawFile, 'utf8'));
    // ways run past the bbox edge, so cover the extent of every returned node
    let s = 90, w = 180, n = -90, e = -180;
    for (const el of raw.elements) if (el.type === 'node') { s = Math.min(s, el.lat); n = Math.max(n, el.lat); w = Math.min(w, el.lon); e = Math.max(e, el.lon); }
    const sampler = makeSampler(await tilePixels([s, w, n, e]));
    const area = compactOverpass(raw, { id: a.id, name: `${a.name}, ${a.place}`, center: [a.lat, a.lon], bbox }, sampler);
    area.fetchedAt = raw.osm3s?.timestamp_osm_base ?? area.fetchedAt;
    writeFileSync(`public/areas/${a.id}.json`, JSON.stringify(area));
    console.log(`  ${a.id}: ${area.ways.length} ways, ${area.nodes.length} nodes, ${area.pois.length} places`);
  }
  // index of whatever areas exist on disk
  const index = AREAS.filter((a) => existsSync(`public/areas/${a.id}.json`)).map((a) => {
    const d = JSON.parse(readFileSync(`public/areas/${a.id}.json`, 'utf8'));
    return { id: a.id, name: a.name, place: a.place, center: [a.lat, a.lon], fetchedAt: d.fetchedAt };
  });
  writeFileSync('public/areas/index.json', JSON.stringify(index, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
