import './styles.css';
import * as maplibregl from 'maplibre-gl';
import type { AreaData, PoiCategory } from './engine/area.ts';
import type { SnappedPoi } from './engine/graph.ts';
import {
  MAX_WHEELCHAIR_SLOPE, MIN_WIDTH_M, STEPS_WALK_SPEED, WALK_SPEED, WHEELCHAIR_SLOW_FROM, WHEELCHAIR_SPEED,
} from './engine/profiles.ts';
import { createMap } from './map.ts';
import { Ink, type InkFrame } from './ink.ts';
import { AREA_HALF_KM, LiveError, fetchArea, geocode } from './live.ts';
import type { BarrierInfo, ReachResult, WorkerIn, WorkerOut } from './protocol.ts';

interface IndexEntry { id: string; name: string; place: string; center: [number, number]; fetchedAt: string }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const BASE = import.meta.env.BASE_URL;
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const isPhone = () => matchMedia('(max-width: 767px)').matches;

const state = {
  index: [] as IndexEntry[],
  area: null as AreaData | null,
  geoReady: false,
  barriers: [] as BarrierInfo[],
  pois: [] as SnappedPoi[],
  pin: null as { lat: number; lon: number; name: string } | null,
  budget: 600,
  hills: 'flag' as 'flag' | 'block',
  result: null as ReachResult | null,
  fix: -1,
  req: 0,
  busy: null as AbortController | null,
  lastPct: -1,
};

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const send = (m: WorkerIn) => worker.postMessage(m);
let resolveLoaded: (() => void) | null = null;
let resolveReach: ((r: WorkerOut) => void) | null = null;

worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
  const msg = ev.data;
  if (msg.type === 'loaded') {
    state.barriers = msg.barriers;
    state.pois = msg.pois;
    ink.setGeo(msg.geo, msg.barriers, msg.pois);
    state.geoReady = true;
    resolveLoaded?.();
  } else if (msg.type === 'reach') {
    if (msg.id === state.req) resolveReach?.(msg);
  } else if (msg.type === 'error') {
    showStatus(`Something went wrong while routing: ${msg.message}`, true);
  }
};

const mapEl = $('map');
const initial = parseHash();
const map = await createMap(mapEl, initial ? [initial.lat, initial.lon] : [3.14245, 101.69545], 15.3).catch((e) => {
  showStatus(`The basemap did not load (${(e as Error).message}). Check the connection and reload.`, true);
  throw e;
});
applyPadding();
// the ink canvas lives inside the map's canvas container so the pin marker sits above it
const inkCanvas = $<HTMLCanvasElement>('ink');
map.getCanvasContainer().appendChild(inkCanvas);
const ink = new Ink(map, inkCanvas);
ink.onFrame = onFrame;

const pinEl = document.createElement('div');
pinEl.className = 'pin';
pinEl.innerHTML = '<svg viewBox="0 0 26 34" width="26" height="34" aria-hidden="true"><path d="M13 33s11-11.2 11-19.5C24 6.6 19.1 2 13 2S2 6.6 2 13.5C2 21.8 13 33 13 33z" fill="#1B1A17" stroke="#FBF8F2" stroke-width="2"/><circle cx="13" cy="13.5" r="4.2" fill="#FBF8F2"/></svg>';
const pin = new maplibregl.Marker({ element: pinEl, anchor: 'bottom' });

renderMethod();
wireControls();
// inspection hook for scripted checks and recordings: ?debug
if (new URLSearchParams(location.search).has('debug')) Object.assign(window, { stm: { map, state, ink } });
loadIndex().then(() => {
  if (initial) {
    setBudget(initial.minutes);
    if (initial.hills) { state.hills = 'block'; $<HTMLInputElement>('hills').checked = true; }
    dropPin(initial.lat, initial.lon, 'this spot');
  } else if (state.index[0]) {
    const want = hashPlace();
    choosePlace(state.index.find((p) => p.id === want) ?? state.index[0]);
  }
});

// ---------- areas ----------

async function loadIndex() {
  try {
    state.index = await fetch(`${BASE}areas/index.json`).then((r) => r.json());
  } catch {
    state.index = [];
  }
  const box = $('places');
  box.innerHTML = '';
  for (const p of state.index) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.id = p.id;
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = `${p.name} <span class="chip-sub">${p.place.split(',')[0]}</span>`;
    b.addEventListener('click', () => choosePlace(p));
    box.append(b);
  }
}

function choosePlace(p: IndexEntry) {
  for (const c of document.querySelectorAll<HTMLElement>('.chip')) c.setAttribute('aria-pressed', String(c.dataset.id === p.id));
  dropPin(p.center[0], p.center[1], `${p.name}, ${p.place.split(',')[0]}`, p.id);
}

/** metres of straight-line travel the budget could cover on foot, plus slack */
const reachRadiusKm = (budget: number) => (budget * WALK_SPEED) / 1000;

function covers(a: AreaData, lat: number, lon: number, budget: number) {
  const [s, w, n, e] = a.bbox;
  const m = reachRadiusKm(budget);
  const dLat = m / 111.32;
  const dLon = m / (111.32 * Math.cos((lat * Math.PI) / 180));
  return lat - dLat >= s && lat + dLat <= n && lon - dLon >= w && lon + dLon <= e;
}

async function loadArea(a: AreaData) {
  state.area = a;
  state.geoReady = false;
  const done = new Promise<void>((r) => (resolveLoaded = r));
  send({ type: 'load', area: a, hills: state.hills });
  await done;
  $('source').innerHTML = `Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>, ODbL, as of ${fmtDate(a.fetchedAt)}. Elevation: Terrain Tiles on AWS. Basemap: OpenFreeMap.`;
}

async function ensureArea(lat: number, lon: number, name: string, preferId: string | undefined, signal: AbortSignal) {
  if (state.area && covers(state.area, lat, lon, state.budget)) return;
  const bundled = state.index.find((p) => p.id === preferId) ??
    state.index.find((p) => Math.abs(p.center[0] - lat) < 0.02 && Math.abs(p.center[1] - lon) < 0.02);
  if (bundled) {
    const a: AreaData = await fetch(`${BASE}areas/${bundled.id}.json`).then((r) => r.json());
    if (covers(a, lat, lon, state.budget)) { await loadArea(a); return; }
  }
  const a = await fetchArea(lat, lon, name, (s) => showStatus(`${s}…`), signal);
  await loadArea(a);
}

// ---------- the core flow ----------

async function dropPin(lat: number, lon: number, name = 'this spot', preferId?: string) {
  state.busy?.abort();
  const ctl = new AbortController();
  state.busy = ctl;
  state.pin = { lat, lon, name };
  state.fix = -1;
  if (!preferId) for (const c of document.querySelectorAll<HTMLElement>('.chip')) c.setAttribute('aria-pressed', 'false');
  pin.setLngLat([lon, lat]).addTo(map);
  // restart the drop animation
  const svg = pinEl.querySelector('svg')!;
  svg.style.animation = 'none';
  void svg.getBoundingClientRect();
  svg.style.animation = '';
  $('map-hint').classList.add('gone');
  ink.clear();
  setProgress(true);
  showStatus('Finding the streets…');
  try {
    await ensureArea(lat, lon, name, preferId, ctl.signal);
    if (ctl.signal.aborted) return;
    showStatus('Routing both journeys…');
    const id = ++state.req;
    const res = await new Promise<WorkerOut>((r) => {
      resolveReach = r;
      send({ type: 'reach', id, lat, lon, budget: state.budget });
    });
    if (ctl.signal.aborted || id !== state.req) return;
    setProgress(false);
    if (res.type !== 'reach' || 'error' in res) {
      showStatus('There is no mapped street close to this spot. Drop the pin on a street.', true);
      return;
    }
    state.result = res;
    writeHash(preferId);
    framePin(res);
    renderResult(res);
    ink.setResult(res);
    ink.play();
  } catch (e) {
    if ((e as Error).name === 'AbortError') return;
    setProgress(false);
    const msg = e instanceof LiveError ? e.message : `Could not load this place: ${(e as Error).message}`;
    showStatus(msg, true, () => dropPin(lat, lon, name, preferId));
  }
}

function framePin(res: ReachResult) {
  // fit the walking reach so the whole spread is visible
  const g = state.area!;
  let s = 90, w = 180, n = -90, e = -180;
  const ids = new Map(g.nodes.map((x, i) => [i, x]));
  for (let v = 0; v < res.walk.length; v++) {
    if (!(res.walk[v] <= res.budget)) continue;
    const nd = ids.get(v)!;
    s = Math.min(s, nd[1]); n = Math.max(n, nd[1]); w = Math.min(w, nd[2]); e = Math.max(e, nd[2]);
  }
  if (s > n) return;
  const cam = map.cameraForBounds([[w, s], [e, n]], { padding: 32, maxZoom: 17 });
  if (!cam) return;
  if (reduced.matches) map.jumpTo(cam);
  else map.easeTo({ ...cam, duration: 600, easing: (t: number) => 1 - (1 - t) ** 3 });
}

function onFrame(f: InkFrame) {
  const r = state.result;
  if (!r) return;
  const walkFinal = r.walkStats.length;
  const fix = state.fix >= 0 ? r.fixes[state.fix] : null;
  const wc = fix && f.fixLen !== undefined ? Math.max(r.wcStats.length, f.fixLen) : f.wcLen;
  const pct = walkFinal > 0 ? Math.round((100 * wc) / walkFinal) : 0;
  if (pct !== state.lastPct) {
    $('gap-num').textContent = String(pct);
    state.lastPct = pct;
  }
  $('km-walk').textContent = km(f.walkLen);
  $('km-wheel').textContent = km(wc);
  if (f.done) $('sentence').textContent = sentence(r, fix ? fix.stats.length : r.wcStats.length);
}

function renderResult(r: ReachResult) {
  $('empty').hidden = true;
  $('status').hidden = true;
  $('filled').hidden = false;
  for (const el of document.querySelectorAll('[data-budget]')) el.textContent = String(r.budget / 60);
  $('filled').classList.remove('fade-in');
  void $('filled').offsetWidth;
  $('filled').classList.add('fade-in');
  renderReached(r);
  renderConfidence(r);
  renderFixes(r);
  ($('print') as HTMLButtonElement).disabled = false;
  ($('share') as HTMLButtonElement).disabled = false;
}

const CAT_LABEL: Record<PoiCategory, string> = { health: 'Clinics, hospitals, pharmacies', school: 'Schools', transit: 'Stations and stops' };

function renderReached(r: ReachResult) {
  const fix = state.fix >= 0 ? r.fixes[state.fix] : null;
  const rows = (['health', 'school', 'transit'] as PoiCategory[]).map((c) => {
    const m = r.walkStats.pois[c];
    const n = r.wcStats.pois[c];
    const plus = fix ? fix.stats.pois[c] - n : 0;
    const short = n < m;
    if (m === 0) return `<tr class="none"><td>${CAT_LABEL[c]}</td><td class="num" colspan="2">none mapped within reach</td></tr>`;
    return `<tr><td>${CAT_LABEL[c]}</td><td class="num wc${short ? ' short' : ''}">${n}${plus > 0 ? `<span class="gain">+${plus}</span>` : ''}</td><td class="num">${m}</td></tr>`;
  });
  $('reached').innerHTML = rows.join('');
}

function renderConfidence(r: ReachResult) {
  const L = r.wcStats.length;
  if (L < 1) {
    $('confidence').innerHTML = 'From this spot a wheelchair user cannot leave the first street: the map shows a barrier right here.';
    return;
  }
  const conf = Math.round((100 * r.wcStats.verifiedLength) / L);
  const why: string[] = [];
  const share = (x: number) => Math.round((100 * x) / L);
  if (r.unverifiedWhy.surface > 0) why.push(`${share(r.unverifiedWhy.surface)}% is footpath with no surface tag`);
  if (r.unverifiedWhy.kerb > 0) why.push(`${share(r.unverifiedWhy.kerb)}% crosses a kerb of unknown height`);
  if (r.unverifiedWhy.slope > 0) why.push(`${share(r.unverifiedWhy.slope)}% looks steeper than 1:12 on terrain data`);
  $('confidence').innerHTML = `<strong>The map confirms ${conf}% of the wheelchair route.</strong> ` +
    (why.length ? `Of the rest, ${why.join('; ')}. That part is drawn dashed: it may or may not be passable. ` : '') +
    `Figures follow OpenStreetMap as it stands.`;
}

function renderFixes(r: ReachResult) {
  const list = $('fix-list');
  list.innerHTML = '';
  $('fixes').hidden = false;
  $('fix-none').hidden = r.fixes.length > 0;
  const walkFinal = r.walkStats.length;
  const basePct = pct(r.wcStats.length, walkFinal);
  r.fixes.forEach((f, i) => {
    const b = state.barriers[f.barrier];
    const newPlaces = f.newPois.map((id) => state.pois.find((p) => p.id === id)).filter(Boolean) as SnappedPoi[];
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fix';
    btn.setAttribute('aria-pressed', 'false');
    const what = FIX_VERB[b.kind] ?? 'Fix';
    const places = newPlaces.length ? ` · <b>+${newPlaces.length}</b> ${newPlaces.length === 1 ? placeNoun(newPlaces[0]) : 'places'}` : '';
    btn.innerHTML = `<span class="fix-rank" aria-hidden="true">${i + 1}</span><span><span class="fix-name">${esc(b.label)}</span>` +
      `<span class="fix-gain">${what}: <b>+${km(f.gainLength)}</b> of street${places} · ${basePct}% → ${pct(f.stats.length, walkFinal)}%</span></span>`;
    btn.addEventListener('click', () => selectFix(state.fix === i ? -1 : i));
    const osm = document.createElement('a');
    osm.className = 'fix-osm';
    osm.href = `https://www.openstreetmap.org/${b.osm}`;
    osm.target = '_blank';
    osm.rel = 'noopener';
    osm.textContent = `Check it on OpenStreetMap (${b.osm})`;
    li.append(btn, osm);
    list.append(li);
  });
}

const FIX_VERB: Record<string, string> = {
  steps: 'Add a ramp or lift', kerb: 'Drop the kerb', gate: 'Widen the gate', surface: 'Resurface',
  narrow: 'Widen the path', no_access: 'Make it step-free', steep: 'Add a gentler route',
};

function placeNoun(p: SnappedPoi) {
  return p.kind === 'bus stop' ? 'bus stop' : p.kind === 'doctors' ? 'doctor' : p.kind;
}

function selectFix(i: number) {
  const r = state.result;
  if (!r) return;
  ink.finish();
  state.fix = i;
  for (const [k, b] of [...document.querySelectorAll('.fix')].entries()) b.setAttribute('aria-pressed', String(k === i));
  renderReached(r);
  if (i < 0) {
    ink.clearFix();
    $('sentence').textContent = sentence(r, r.wcStats.length);
    return;
  }
  ink.playFix(i);
}

// ---------- text ----------

function sentence(r: ReachResult, wcLen: number) {
  const name = state.pin?.name ?? 'this spot';
  const p = pct(wcLen, r.walkStats.length);
  const fix = state.fix >= 0 ? r.fixes[state.fix] : null;
  const counts = (['health', 'school', 'transit'] as PoiCategory[])
    .map((c) => `${fix ? fix.stats.pois[c] : r.wcStats.pois[c]} of ${r.walkStats.pois[c]} ${{ health: 'health places', school: 'schools', transit: 'stations and stops' }[c]}`)
    .join(', ');
  let s = `From ${name}, a wheelchair user reaches ${p}% of the street a person on foot reaches in ${r.budget / 60} minutes (${km(wcLen)} of ${km(r.walkStats.length)}), and ${counts}, according to OpenStreetMap as it stands.`;
  if (fix) s = `With ${lc(state.barriers[fix.barrier].label)} fixed: ` + s;
  else if (r.fixes[0]) s += ` The fix that gives back the most is ${lc(state.barriers[r.fixes[0].barrier].label)}, adding ${km(r.fixes[0].gainLength)}.`;
  return s;
}

function renderMethod() {
  const items = [
    `On foot: ${(WALK_SPEED * 3.6).toFixed(1)} km/h on the flat, slower uphill (Tobler's hiking function); stairs at ${(STEPS_WALK_SPEED * 3.6).toFixed(1)} km/h.`,
    `Manual wheelchair: ${(WHEELCHAIR_SPEED * 3.6).toFixed(1)} km/h on the flat, slowing from ${Math.round(WHEELCHAIR_SLOW_FROM * 100)}% gradient, never faster than walking.`,
    `Blocked for a wheelchair: steps without a ramp, kerbs tagged raised, turnstiles and stiles, ways tagged wheelchair=no, loose or rough surfaces, tagged widths under ${MIN_WIDTH_M} m, and tagged inclines over 1:12 (${(MAX_WHEELCHAIR_SLOPE * 100).toFixed(1)}%).`,
    'Unconfirmed (dashed): footpaths without a surface tag, crossings and kerbs without a kerb height, and terrain slopes over 1:12 unless steep terrain is counted as impassable.',
    'Fix first: each barrier at the edge of the wheelchair reach is removed alone and the reach recomputed; ranked by street length gained, then places gained. A fixed staircase is modelled as a 1:12 ramp.',
    'Places: amenities tagged clinic, hospital, pharmacy, doctors, school or kindergarten, railway stations and bus stops, each joined to the nearest street within 100 m.',
  ];
  $('method').innerHTML = items.map((t) => `<li>${t}</li>`).join('');
}

// ---------- controls ----------

function wireControls() {
  map.on("click", (e: maplibregl.MapMouseEvent) => dropPin(e.lngLat.lat, e.lngLat.lng));
  const canvas = map.getCanvas();
  canvas.setAttribute('aria-label', $('map').getAttribute('aria-label') ?? 'Map');
  canvas.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const c = map.getCenter();
      dropPin(c.lat, c.lng);
    }
  });

  $('search').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = ($('q') as HTMLInputElement).value.trim();
    if (!q) return;
    state.busy?.abort();
    const ctl = new AbortController();
    state.busy = ctl;
    setProgress(true);
    showStatus(`Looking up “${esc(q)}”…`);
    try {
      const p = await geocode(q, ctl.signal);
      setProgress(false);
      if (!p) { showStatus(`No place called “${esc(q)}” was found. Try a station or street name with the city.`, true); return; }
      map.jumpTo({ center: [p.lon, p.lat], zoom: 15.3 });
      dropPin(p.lat, p.lon, p.name);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setProgress(false);
      showStatus(err instanceof LiveError ? err.message : 'Place search failed. Check the connection.', true);
    }
  });

  for (const r of document.querySelectorAll<HTMLInputElement>('input[name=budget]')) {
    r.addEventListener('change', () => {
      state.budget = Number(r.value) * 60;
      if (state.pin) dropPin(state.pin.lat, state.pin.lon, state.pin.name, document.querySelector<HTMLElement>('.chip[aria-pressed=true]')?.dataset.id);
    });
  }

  $<HTMLInputElement>('hills').addEventListener('change', async (e) => {
    state.hills = (e.target as HTMLInputElement).checked ? 'block' : 'flag';
    if (state.area) {
      const a = state.area;
      await loadArea(a);
      if (state.pin) dropPin(state.pin.lat, state.pin.lon, state.pin.name, document.querySelector<HTMLElement>('.chip[aria-pressed=true]')?.dataset.id);
    }
  });

  $('share').addEventListener('click', async () => {
    const b = $('share');
    try {
      await navigator.clipboard.writeText(location.href);
      b.textContent = 'Link copied';
    } catch {
      b.textContent = 'Copy the address bar';
    }
    setTimeout(() => (b.textContent = 'Copy link'), 1600);
  });

  $('print').addEventListener('click', printSheet);
  window.addEventListener('resize', applyPadding);
}

function setBudget(min: number) {
  const m = [5, 10, 15].includes(min) ? min : 10;
  state.budget = m * 60;
  ($(`b${m}`) as HTMLInputElement).checked = true;
}

function applyPadding() {
  map.setPadding(isPhone() ? { left: 0, top: 0, right: 0, bottom: 16 } : { left: 400 + 16, top: 0, right: 0, bottom: 0 });
}

function showStatus(html: string, error = false, retry?: () => void) {
  const s = $('status');
  s.hidden = false;
  s.className = `status${error ? ' error' : ''}`;
  s.innerHTML = `<p>${html}</p>`;
  if (retry) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.type = 'button';
    b.textContent = 'Try again';
    b.addEventListener('click', retry);
    s.append(b);
  }
  $('empty').hidden = true;
  if (error || !state.result) $('filled').hidden = true;
  if (error) $('fixes').hidden = true;
}

function setProgress(on: boolean) {
  $('progress').classList.toggle('on', on);
  $('panel').setAttribute('aria-busy', String(on));
}

// ---------- link and print ----------

function writeHash(placeId?: string) {
  if (!state.pin) return;
  const h = placeId && state.budget === 600 && state.hills === 'flag'
    ? `#place=${placeId}`
    : `#${state.pin.lat.toFixed(5)},${state.pin.lon.toFixed(5)},${state.budget / 60}${state.hills === 'block' ? ',hills' : ''}`;
  history.replaceState(null, '', h);
}

function parseHash() {
  const m = /^#(-?[\d.]+),(-?[\d.]+),(\d+)(,hills)?$/.exec(location.hash);
  if (!m) return null;
  return { lat: +m[1], lon: +m[2], minutes: +m[3], hills: !!m[4] };
}

/** `#place=<sample id>` opens one of the sample places */
function hashPlace() {
  return /^#place=([\w-]+)$/.exec(location.hash)?.[1] ?? null;
}

function printSheet() {
  const r = state.result;
  if (!r) return;
  ink.finish();
  const mc = map.getCanvas();
  const out = document.createElement('canvas');
  out.width = mc.width;
  out.height = mc.height;
  const ctx = out.getContext('2d')!;
  ctx.drawImage(mc, 0, 0);
  ctx.drawImage($<HTMLCanvasElement>('ink'), 0, 0, out.width, out.height);
  const fix = r.fixes;
  const walkFinal = r.walkStats.length;
  const rows = fix.map((f, i) => {
    const b = state.barriers[f.barrier];
    return `<tr><td>${i + 1}</td><td>${esc(b.label)}<br><small>openstreetmap.org/${b.osm}</small></td><td>${FIX_VERB[b.kind] ?? 'Fix'}</td><td>+${km(f.gainLength)}</td><td>${pct(f.stats.length, walkFinal)}%</td></tr>`;
  }).join('');
  const cats = (['health', 'school', 'transit'] as PoiCategory[]).map((c) => `<div><b>${r.wcStats.pois[c]} of ${r.walkStats.pois[c]}</b>${CAT_LABEL[c].toLowerCase()}</div>`).join('');
  $('print-sheet').innerHTML = `
    <h1>Same Ten Minutes: ${esc(state.pin?.name ?? 'this spot')}</h1>
    <p class="ps-sub">${r.budget / 60} minutes on the move from ${state.pin!.lat.toFixed(5)}, ${state.pin!.lon.toFixed(5)}. Printed ${fmtDate(new Date().toISOString())}.</p>
    <img alt="" src="${out.toDataURL('image/png')}">
    <div class="ps-figs"><div><b>${pct(r.wcStats.length, walkFinal)}%</b>of the street reached on foot is reached by wheelchair (${km(r.wcStats.length)} of ${km(walkFinal)})</div>${cats}</div>
    <h2>Fix first</h2>
    <table><thead><tr><th>#</th><th>Barrier</th><th>Change</th><th>Street gained</th><th>Reach after</th></tr></thead><tbody>${rows || '<tr><td colspan="5">No single fixable barrier changes this reach.</td></tr>'}</tbody></table>
    <p class="ps-note">${$('confidence').textContent}</p>
    <p class="ps-note">Blue band: reached on foot. Orange line: reached by manual wheelchair; dashed where the map does not confirm the surface, kerb or slope. Black marks: barriers. Method: OpenStreetMap streets and tags, Terrain Tiles on AWS elevation, wheelchair limit 1:12. Map data © OpenStreetMap contributors, ODbL. Generated by Same Ten Minutes.</p>`;
  window.print();
}

// ---------- helpers ----------

function km(m: number) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`;
}
function lc(s: string) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}
function pct(a: number, b: number) {
  return b > 0 ? Math.round((100 * a) / b) : 0;
}
function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
function fmtDate(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(+d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

void AREA_HALF_KM;
