// Area data: the compact form of one OpenStreetMap extract plus sampled elevation.
// The same format is produced by the offline script (bundled demo areas) and by the
// live fetch in the browser, so the graph builder only ever sees this shape.

export type Tags = Record<string, string>;

export type PoiCategory = 'health' | 'school' | 'transit';

export interface Poi {
  id: string;
  cat: PoiCategory;
  kind: string;
  name: string;
  lat: number;
  lon: number;
}

export interface AreaData {
  version: 1;
  id: string;
  name: string;
  /** [lat, lon] */
  center: [number, number];
  /** [south, west, north, east] */
  bbox: [number, number, number, number];
  fetchedAt: string;
  attribution: string;
  /** [osmId, lat, lon, elevation in metres] */
  nodes: [number, number, number, number][];
  /** tags of tagged nodes only, keyed by OSM node id */
  nodeTags: Record<string, Tags>;
  ways: { id: number; n: number[]; t: Tags }[];
  pois: Poi[];
}

export const ATTRIBUTION =
  'Map data © OpenStreetMap contributors, available under the Open Database Licence (ODbL). Elevation: Terrain Tiles on AWS (Mapzen terrarium).';

/** Highway values a person on foot can use. Motorways are never fetched. */
export const WALKABLE_HIGHWAYS = [
  'footway', 'path', 'pedestrian', 'steps', 'living_street', 'residential', 'service',
  'unclassified', 'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'primary',
  'primary_link', 'cycleway', 'track', 'road', 'corridor', 'bridleway',
];

const WAY_KEYS = new Set([
  'highway', 'footway', 'sidewalk', 'surface', 'smoothness', 'wheelchair', 'incline', 'width',
  'ramp', 'ramp:wheelchair', 'step_count', 'kerb', 'bridge', 'tunnel', 'foot', 'access',
  'name', 'crossing', 'conveying', 'indoor', 'area', 'level', 'layer',
]);
const NODE_KEYS = new Set(['barrier', 'kerb', 'highway', 'wheelchair', 'crossing', 'name', 'ramp', 'access', 'foot']);

export function bboxAround(lat: number, lon: number, halfKm: number): [number, number, number, number] {
  const dLat = halfKm / 111.32;
  const dLon = halfKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  const r = (v: number) => Math.round(v * 1e5) / 1e5;
  return [r(lat - dLat), r(lon - dLon), r(lat + dLat), r(lon + dLon)];
}

export function overpassQuery(bbox: [number, number, number, number]): string {
  const b = bbox.join(',');
  return `[out:json][timeout:90];
way["highway"~"^(${WALKABLE_HIGHWAYS.join('|')})$"](${b})->.w;
.w out body qt;
node(w.w)->.n;
.n out body qt;
(
  nwr["amenity"~"^(clinic|hospital|pharmacy|doctors|school|kindergarten)$"](${b});
  nwr["healthcare"~"^(clinic|hospital|pharmacy|doctor)$"](${b});
  nwr["railway"~"^(station|halt)$"](${b});
  nwr["public_transport"="station"](${b});
  node["highway"="bus_stop"](${b});
);
out center tags qt;`;
}

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  nodes?: number[];
  tags?: Tags;
}

function pick(tags: Tags | undefined, keys: Set<string>): Tags {
  const out: Tags = {};
  if (!tags) return out;
  for (const k of Object.keys(tags)) if (keys.has(k)) out[k] = tags[k];
  return out;
}

export function poiCategory(tags: Tags): { cat: PoiCategory; kind: string } | null {
  const a = tags.amenity ?? '';
  const h = tags.healthcare ?? '';
  if (['clinic', 'hospital', 'pharmacy', 'doctors'].includes(a)) return { cat: 'health', kind: a };
  if (['clinic', 'hospital', 'pharmacy', 'doctor'].includes(h)) return { cat: 'health', kind: h };
  if (a === 'school' || a === 'kindergarten') return { cat: 'school', kind: a };
  if (tags.railway === 'station' || tags.railway === 'halt' || tags.public_transport === 'station')
    return { cat: 'transit', kind: 'station' };
  if (tags.highway === 'bus_stop') return { cat: 'transit', kind: 'bus stop' };
  return null;
}

const KIND_LABEL: Record<string, string> = {
  clinic: 'Clinic', hospital: 'Hospital', pharmacy: 'Pharmacy', doctors: 'Doctor', doctor: 'Doctor',
  school: 'School', kindergarten: 'Kindergarten', station: 'Station', 'bus stop': 'Bus stop',
};

/**
 * Turn a raw Overpass response into the compact area form. `elevationAt` is called
 * once per kept node; it returns metres.
 */
export function compactOverpass(
  raw: { elements: OverpassElement[] },
  meta: { id: string; name: string; center: [number, number]; bbox: [number, number, number, number] },
  elevationAt: (lat: number, lon: number) => number,
): AreaData {
  const nodeById = new Map<number, OverpassElement>();
  const ways: AreaData['ways'] = [];
  const pois: Poi[] = [];
  const seenPoi = new Set<string>();

  for (const el of raw.elements) {
    if (el.type === 'node' && el.lat !== undefined) nodeById.set(el.id, el);
  }
  for (const el of raw.elements) {
    if (el.type === 'way' && el.nodes && el.tags?.highway && WALKABLE_HIGHWAYS.includes(el.tags.highway)) {
      ways.push({ id: el.id, n: el.nodes, t: pick(el.tags, WAY_KEYS) });
    }
    if (el.tags) {
      const pc = poiCategory(el.tags);
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (pc && lat !== undefined && lon !== undefined) {
        const id = `${el.type[0]}${el.id}`;
        if (seenPoi.has(id)) continue;
        seenPoi.add(id);
        pois.push({
          id, cat: pc.cat, kind: pc.kind,
          name: el.tags.name ?? el.tags['name:en'] ?? KIND_LABEL[pc.kind] ?? pc.kind,
          lat: round6(lat), lon: round6(lon),
        });
      }
    }
  }

  const used = new Set<number>();
  for (const w of ways) for (const id of w.n) used.add(id);
  const nodes: AreaData['nodes'] = [];
  const nodeTags: AreaData['nodeTags'] = {};
  for (const id of used) {
    const el = nodeById.get(id);
    if (!el || el.lat === undefined || el.lon === undefined) continue;
    nodes.push([id, round6(el.lat), round6(el.lon), Math.round(elevationAt(el.lat, el.lon) * 10) / 10]);
    const t = pick(el.tags, NODE_KEYS);
    if (Object.keys(t).length) nodeTags[id] = t;
  }
  // ways may reference nodes outside the response (rare); drop those references
  const have = new Set(nodes.map((n) => n[0]));
  const cleanWays = ways
    .map((w) => ({ ...w, n: w.n.filter((id) => have.has(id)) }))
    .filter((w) => w.n.length >= 2);

  return {
    version: 1,
    id: meta.id,
    name: meta.name,
    center: meta.center,
    bbox: meta.bbox,
    fetchedAt: new Date().toISOString(),
    attribution: ATTRIBUTION,
    nodes,
    nodeTags,
    ways: cleanWays,
    pois,
  };
}

function round6(v: number) {
  return Math.round(v * 1e6) / 1e6;
}
