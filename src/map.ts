import * as maplibregl from 'maplibre-gl';
// bundle MapLibre's worker ourselves so it works under the dev server and from any Pages path
import mlWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';

maplibregl.setWorkerUrl(mlWorkerUrl);

const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

// A quiet paper basemap: the inks are the only strong colour on screen.
const PAPER = {
  land: '#F3EEE4',
  water: '#D3DDDF',
  park: '#E7E6D5',
  building: '#E8E1D3',
  buildingLine: '#DDD4C4',
  road: '#FFFDF8',
  roadCasing: '#E2D9C8',
  rail: '#C9BFAE',
  label: '#7A7266',
  halo: '#F3EEE4',
};

export async function createMap(container: HTMLElement, center: [number, number], zoom: number) {
  const style = await fetch(STYLE_URL).then((r) => {
    if (!r.ok) throw new Error(`basemap style: HTTP ${r.status}`);
    return r.json();
  });
  for (const l of style.layers as { id: string; type: string; paint?: Record<string, unknown>; layout?: Record<string, unknown> }[]) {
    const p = (l.paint ??= {});
    if (l.type === 'background') p['background-color'] = PAPER.land;
    else if (l.id === 'water') p['fill-color'] = PAPER.water;
    else if (l.id === 'waterway') p['line-color'] = PAPER.water;
    else if (l.id === 'park' || l.id.startsWith('landcover')) { p['fill-color'] = PAPER.park; p['fill-opacity'] = 0.7; }
    else if (l.id === 'landuse_residential') p['fill-opacity'] = 0;
    else if (l.id === 'building') { p['fill-color'] = PAPER.building; p['fill-outline-color'] = PAPER.buildingLine; }
    else if (l.type === 'line' && l.id.includes('casing')) p['line-color'] = PAPER.roadCasing;
    else if (l.type === 'line' && (l.id.startsWith('highway') || l.id.startsWith('road') || l.id.startsWith('tunnel'))) p['line-color'] = PAPER.road;
    else if (l.type === 'line' && l.id.startsWith('railway')) p['line-color'] = PAPER.rail;
    else if (l.type === 'symbol') {
      p['text-color'] = PAPER.label;
      p['text-halo-color'] = PAPER.halo;
      p['text-halo-width'] = 1.5;
      if (l.id.startsWith('highway-shield') || l.id === 'road_shield_us') (l.layout ??= {}).visibility = 'none';
    }
  }
  const map = new maplibregl.Map({
    container,
    style,
    center: [center[1], center[0]],
    zoom,
    minZoom: 12,
    maxZoom: 19,
    pitchWithRotate: false,
    dragRotate: false,
    touchPitch: false,
    attributionControl: false,
    canvasContextAttributes: { preserveDrawingBuffer: true },
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  await new Promise<void>((res) => map.once('load', () => res()));
  return map;
}
