// Demo video, step 1 of 2: records the built site. scripts/video/edit.mjs turns the recording into the film.
//
// A scripted Chromium session (1600x900 CSS px at device scale 2) is captured frame by frame through the
// DevTools screencast at 3200x1800. The page runs on a stretched clock (SLOW times slower than real: its
// timers, animation frames, performance.now and CSS animations), so the capture rate is SLOW times higher
// in page time and every animation is sampled smoothly. Against the page clock the script logs:
//   - scenes, each with its narration, one sentence per audio file (Kokoro, voice af_heart), so camera
//     moves are cued to the sentence they belong to;
//   - camera targets, taken from real on-screen rectangles (DOM elements, or map points projected by the map);
//   - a caption per scene.
// The cursor is drawn into the page and moved along eased paths, so it is part of the capture. When the
// narration names something, a callout is drawn on its real box at that word: the rest dims, a ring draws on,
// numbers read aloud get an underline and a pulse, small things get a label on a leader line.
// Every figure in the narration is read from the running build first.
// Only the bundled sample places are used. Basemap tiles are cached in .cache/tiles, so a second take
// does not fetch them again.
//
//   npm run build
//   CHROME_PATH=... KOKORO_PY=... KOKORO_TTS=... node scripts/video/record.mjs
//   node scripts/video/edit.mjs
//
// KOKORO_PY is a Python with kokoro-onnx; KOKORO_TTS a script taking: "text" out.wav --voice af_heart.
import { chromium } from 'playwright-core';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const root = resolve(import.meta.dirname, '../..');
const work = join(root, '.cache/video');
const frames = join(work, 'frames');
const ttsDir = join(root, '.cache/tts');
const tileDir = join(root, '.cache/tiles');
rmSync(work, { recursive: true, force: true });
for (const d of [frames, ttsDir, tileDir]) mkdirSync(d, { recursive: true });

const CHROME = process.env.CHROME_PATH;
const KOKORO_PY = process.env.KOKORO_PY;
const KOKORO_TTS = process.env.KOKORO_TTS;
if (!CHROME || !KOKORO_PY || !KOKORO_TTS) {
  console.error('Set CHROME_PATH, KOKORO_PY and KOKORO_TTS.');
  process.exit(2);
}
const W = 1600;
const H = 900;
const SCALE = 2;
const MAX_Z = 2.2;
const SLOW = Number(process.env.SLOW ?? 2);
const PORT = 4293;
// never touch the OS keychain
// the screencast follows the window, not the emulated viewport: size the window and its scale to match
const ARGS = ['--use-mock-keychain', '--password-store=basic', `--window-size=${W},${H}`, `--force-device-scale-factor=${SCALE}`];

/* ---------- narration ---------- */
const run = promisify(execFile);
const probe = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
const voices = new Map();
let queue = Promise.resolve();
/** One sentence, synthesised once (cached by its text), one synthesis at a time. */
function voice(text) {
  let p = voices.get(text);
  if (p) return p;
  const file = join(ttsDir, createHash('sha1').update('af_heart\n' + text).digest('hex').slice(0, 16) + '.wav');
  p = queue = queue.then(async () => {
    if (!existsSync(file)) await run(KOKORO_PY, ['-I', KOKORO_TTS, text, file, '--voice', 'af_heart']);
    return { text, file, dur: probe(file) };
  });
  voices.set(text, p);
  return p;
}
const GAP = 0.14; // pause between sentences, on top of the short silence each file ends with

const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const say = (k) => (k < 20 ? words[k] : k < 100 ? tens[Math.floor(k / 10)] + (k % 10 ? '-' + words[k % 10] : '') : String(k));
const sayKm = (s) => { const [a, b] = s.split('.'); return b && b !== '0' ? `${say(+a)} point ${say(+b)}` : say(+a); };

/* ---------- static server: the built site at /, the video cards at /cards/ ---------- */
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
const dist = join(root, 'dist');
if (!existsSync(join(dist, 'index.html'))) { console.error('Run npm run build first.'); process.exit(2); }
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  let file = path.startsWith('/cards/') ? join(root, 'scripts/video', path) : join(dist, path);
  if (!path.startsWith('/cards/') && (!existsSync(file) || statSync(file).isDirectory())) file = join(dist, 'index.html');
  if (!existsSync(file)) return void res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, r));
const APP = `http://localhost:${PORT}/?debug`;

const browser = await chromium.launch({ executablePath: CHROME, args: ARGS });

/** Basemap style, sprites, glyphs and tiles: fetched once, then served from .cache/tiles. */
async function cacheTiles(ctx) {
  await ctx.route(/^https:\/\/tiles\.openfreemap\.org\//, async (route) => {
    const url = route.request().url();
    const key = join(tileDir, createHash('sha1').update(url).digest('hex'));
    if (existsSync(key + '.bin')) {
      const meta = JSON.parse(readFileSync(key + '.json', 'utf8'));
      return route.fulfill({ status: 200, headers: { 'content-type': meta.type, 'access-control-allow-origin': '*' }, body: readFileSync(key + '.bin') });
    }
    try {
      const resp = await route.fetch();
      const body = await resp.body();
      if (resp.ok()) {
        writeFileSync(key + '.bin', body);
        writeFileSync(key + '.json', JSON.stringify({ url, type: resp.headers()['content-type'] ?? 'application/octet-stream' }));
      }
      await route.fulfill({ response: resp, body });
    } catch {
      await route.abort().catch(() => {}); // the page went away while the tile was in flight
    }
  });
}

/* ---------- figures, read from the running build ---------- */
const sentence = (page) => page.locator('#sentence').textContent().then((s) => s ?? '');
/** Runs an action and waits for the result it causes (a new result object with its sentence). */
async function fresh(page, action, has = '%', ms = 60000) {
  await page.evaluate(() => { window.__prev = window.stm?.state.result ?? null; });
  await action();
  await page.waitForFunction((has) => {
    const st = window.stm?.state;
    return !!st && !!st.result && st.result !== window.__prev && (document.getElementById('sentence')?.textContent ?? '').includes(has);
  }, has, { timeout: ms, polling: 100 });
}
const read = (page) => page.evaluate(() => {
  const st = window.stm.state;
  const r = st.result;
  const pct = (a, b) => Math.round((100 * a) / b);
  const f = r.fixes[0];
  return {
    pct: pct(r.wcStats.length, r.walkStats.length),
    wcKm: (r.wcStats.length / 1000).toFixed(1),
    walkKm: (r.walkStats.length / 1000).toFixed(1),
    health: [r.wcStats.pois.health, r.walkStats.pois.health],
    transit: [r.wcStats.pois.transit, r.walkStats.pois.transit],
    conf: pct(r.wcStats.verifiedLength, r.wcStats.length),
    fixLabel: f ? st.barriers[f.barrier].label : '',
    fixKind: f ? st.barriers[f.barrier].kind : '',
    fixAfter: f ? pct(f.stats.length, r.walkStats.length) : 0,
    fixPlaces: f ? f.newPois.length : 0,
    fixKm: f ? (f.gainLength / 1000).toFixed(1) : '0',
    budget: r.budget / 60,
    hills: st.hills,
    sentence: document.getElementById('sentence').textContent,
  };
});
const pre = await browser.newContext({ viewport: { width: W, height: H } });
await cacheTiles(pre);
const pp = await pre.newPage();
await pp.goto(`${APP}#place=lisbon-martim-moniz`);
await pp.waitForFunction(() => (document.getElementById('sentence')?.textContent ?? '').includes('Martim'), null, { timeout: 60000 });
const lis = await read(pp);
await fresh(pp, () => pp.click('label[for=b15]'), '15 minutes');
const lis15 = await read(pp);
await fresh(pp, () => pp.click('label[for=b10]'), '10 minutes');
await fresh(pp, () => pp.locator('#hills').check(), 'Martim');
const lisHills = await read(pp);
await fresh(pp, () => pp.locator('#hills').uncheck(), 'Martim');
const lisBack = await read(pp);
await fresh(pp, () => pp.locator('.chip', { hasText: 'Masjid Jamek' }).click(), 'Masjid');
const kl = await read(pp);
await fresh(pp, () => pp.locator('.chip', { hasText: 'Alexanderplatz' }).click(), 'Alexanderplatz');
const ber = await read(pp);
await pre.unrouteAll({ behavior: 'ignoreErrors' });
await pre.close();
if (lisBack.pct !== lis.pct || lisHills.hills !== 'block' || lis15.budget !== 15) throw new Error('figures did not settle');
const figures = { lis, lis15, lisHills, kl, ber };
console.log(JSON.stringify(figures, null, 1));

/* ---------- the script; every number above came from the build ---------- */
const script = {
  hook: ['Two people leave Martim Moniz, in Lisbon, at the same moment.', 'One walks, in blue. The other uses a wheelchair, in orange.',
    `Ten minutes later, the wheelchair user has reached ${say(lis.pct)} percent of the streets the walker has.`],
  title: ['This is Same Ten Minutes.', 'It measures how much of a place a wheelchair user can really reach, compared with someone on foot, in the same time.'],
  barriers: ['The orange ink does not stop because of distance.', 'It stops at barriers: staircases, raised kerbs, rough or narrow paths.', 'Each black mark is one of them, straight from Open Street Map.'],
  gap: [`So the gap has a number. ${say(lis.pct)} percent.`,
    `That is ${sayKm(lis.wcKm)} of ${sayKm(lis.walkKm)} kilometres of street, and ${say(lis.health[0])} of the ${say(lis.health[1])} clinics, hospitals and pharmacies a walker reaches.`,
    `Give them fifteen minutes, and it is still only ${say(lis15.pct)} percent.`],
  honest: ['Where the map is silent about a surface or a kerb, the orange line is dashed.', `And the app says how much of the route the map confirms. Here, ${say(lis.conf)} percent.`],
  fix: ['Then it asks the question a council needs answered.', 'Which single fix gives back the most?',
    'Every barrier at the edge of the reach is removed in turn, and the reach is measured again.',
    `Here, it is one staircase. With a ramp or a lift, reach goes from ${say(lis.pct)} to ${say(lis.fixAfter)} percent, and ${say(lis.fixPlaces)} more places come within reach.`],
  hills: ['Lisbon is steep, and terrain data is coarse.', 'So by default, a steep street is flagged, not blocked.',
    `Count steep terrain as impassable, and the reach falls to ${say(lisHills.pct)} percent.`],
  kl: ['It works wherever the open map reaches.', `In Kuala Lumpur, from Masjid Jamek, a wheelchair user reaches ${say(kl.pct)} percent.`,
    `The best single fix would raise that to ${say(kl.fixAfter)}.`],
  berlin: [`In Berlin, where the map records nearly every kerb, it can confirm ${say(ber.conf)} percent of the route.`],
  access: ['A tool about access has to be accessible.', 'Everything works from the keyboard.', 'And the result is read out as a plain sentence.'],
  phone: ['On a phone, the figure stays pinned beside the map.', 'It all runs in the browser. No account, no key.'],
  audit: ['And it prints a one-page audit sheet for the council, with every barrier linked to Open Street Map, so anyone can check it, or fix the map.'],
  end: ['Same Ten Minutes.', 'Because ten minutes should be the same ten minutes, for everyone.'],
};
const captions = {
  hook: 'Martim Moniz, Lisbon. Blue: on foot. Orange: wheelchair. Same 10 minutes.',
  barriers: 'Black marks: steps, raised kerbs, rough or narrow paths, from OpenStreetMap',
  gap: `${lis.pct}% of the street a walker reaches: ${lis.wcKm} of ${lis.walkKm} km`,
  honest: `Dashed: the map does not confirm it. ${lis.conf}% of this route is confirmed.`,
  fix: `Fix first: one staircase. ${lis.pct}% becomes ${lis.fixAfter}%, +${lis.fixPlaces} places`,
  hills: `Steep terrain counted as impassable: ${lisHills.pct}%`,
  kl: `Masjid Jamek, Kuala Lumpur: ${kl.pct}%. Top fix: ${kl.fixAfter}%`,
  berlin: `Alexanderplatz, Berlin: the map confirms ${ber.conf}% of the route`,
  access: 'Keyboard only. The result is also a sentence for screen readers.',
  phone: 'Phone layout, 390 px wide',
  audit: 'A one-page audit sheet. Every barrier links to OpenStreetMap.',
};
console.log('synthesising narration');
await Promise.all(Object.values(script).flat().map(voice));

/* ---------- the recording context: stretched clock, cursor, overlays ---------- */
const initScript = `(() => {
  const K = ${SLOW};
  const pn = performance.now.bind(performance);
  const base = pn();
  const now = () => base + (pn() - base) / K;
  performance.now = now;
  const dn = Date.now.bind(Date), d0 = dn();
  Date.now = () => Math.round(d0 + (dn() - d0) / K);
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf(() => cb(now()));
  const st = window.setTimeout.bind(window), si = window.setInterval.bind(window);
  window.setTimeout = (fn, ms, ...a) => st(fn, (Number(ms) || 0) * K, ...a);
  window.setInterval = (fn, ms, ...a) => si(fn, (Number(ms) || 0) * K, ...a);
  const ripple = (x, y) => {
    const r = document.createElement('div');
    r.style.cssText = 'position:fixed;left:' + (x - 22) + 'px;top:' + (y - 22) + 'px;width:44px;height:44px;border-radius:50%;border:2px solid #1F4FA3;background:rgba(31,79,163,.14);z-index:2147483646;pointer-events:none;transform:scale(.3);opacity:1;transition:transform 560ms cubic-bezier(.23,1,.32,1),opacity 560ms ease-out';
    document.body.append(r);
    raf(() => raf(() => { r.style.transform = 'scale(1.5)'; r.style.opacity = '0'; }));
    st(() => r.remove(), 700 * K);
  };
  if (window.top !== window) {
    // inside the phone frame: a touch shows a ripple, there is no arrow
    addEventListener('mousedown', (e) => ripple(e.clientX, e.clientY), true);
    return;
  }
  addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div');
    c.id = 'rec-cursor';
    c.innerHTML = '<svg width="26" height="32" viewBox="0 0 24 30"><path d="M3 2.6v21.6l5.4-5.2 3.7 8.5 4-1.8-3.7-8.3h7.4z" fill="#1B1A17" stroke="#FBF8F2" stroke-width="1.7" stroke-linejoin="round"/></svg>';
    c.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;opacity:0;transform-origin:3px 3px;transition:opacity 180ms;filter:drop-shadow(0 1px 2px rgba(27,26,23,.35))';
    document.body.append(c);
    let x = 0, y = 0, s = 1;
    const put = () => { c.style.transform = 'translate(' + (x - 3) + 'px,' + (y - 3) + 'px) scale(' + s + ')'; };
    addEventListener('mousemove', (e) => { x = e.clientX; y = e.clientY; if (!window.__noCursor) c.style.opacity = '1'; put(); }, true);
    addEventListener('mousedown', (e) => { s = 0.84; put(); ripple(e.clientX, e.clientY); }, true);
    addEventListener('mouseup', () => { s = 1; put(); }, true);
    window.__hideCursor = (h) => { window.__noCursor = h; c.style.opacity = h ? '0' : '1'; };
  });
})();`;
const OVERLAY_CSS = `
#map-hint{display:none!important}
#rec-title{position:fixed;inset:0;display:grid;place-items:center;background:rgba(243,238,228,.95);z-index:2147483000;opacity:0;transition:opacity .5s cubic-bezier(.23,1,.32,1);pointer-events:none}
#rec-title.on{opacity:1}
#rec-title .t{text-align:center;font-family:'Atkinson Hyperlegible Next Variable',sans-serif;color:#1B1A17;transform:translateY(10px);transition:transform .7s cubic-bezier(.23,1,.32,1)}
#rec-title.on .t{transform:none}
#rec-title h1{font-size:104px;font-weight:760;letter-spacing:-.035em;margin:0;line-height:1}
#rec-title p{font-size:30px;line-height:1.35;color:#4D483F;margin:26px auto 0;max-width:900px}
#rec-title .inks{display:flex;flex-direction:column;gap:10px;align-items:flex-start;width:420px;margin:44px auto 0}
#rec-title .inks span{display:block;border-radius:8px;transform-origin:left center;transform:scaleX(0);transition:transform 1.4s cubic-bezier(.23,1,.32,1)}
#rec-title.on .inks span{transform:scaleX(1)}
#rec-title .inks .w{width:420px;height:16px;background:rgba(31,79,163,.32)}
#rec-title .inks .c{width:${Math.max(24, Math.round((420 * lis.pct) / 100))}px;height:6px;background:#E4572E;transition-delay:.25s}
#rec-title .small{font-size:20px;color:#6B6458;margin-top:48px}
#rec-sr{position:fixed;left:calc(416px + (100vw - 416px)/2);top:56px;transform:translate(-50%,8px);width:860px;background:#FBF8F2;border:2px solid #1B1A17;border-radius:14px;
padding:20px 26px;font:400 22px/1.5 'Atkinson Hyperlegible Next Variable',sans-serif;color:#1B1A17;z-index:2147483000;opacity:0;transition:opacity .3s ease,transform .3s cubic-bezier(.23,1,.32,1);box-shadow:0 1px 2px rgba(27,26,23,.06),0 12px 32px -12px rgba(27,26,23,.28)}
#rec-sr.on{opacity:1;transform:translate(-50%,0)}
#rec-sr b{display:block;font-size:15px;color:#4D483F;margin-bottom:8px;font-weight:600}
`;
// Callouts drawn into the page, on the element's real box: a spotlight that dims the rest, a ring that draws
// on in the accent colour, an underline that draws under a number read aloud, and a label on a leader line
// for small things. Sizes are divided by the camera zoom, so they look the same size in the film.
const CALLOUT_JS = `(() => {
  if (window.__co) return;
  const NS = 'http://www.w3.org/2000/svg';
  const ACC = '#E4572E', PAPER = '#FBF8F2', INK = '#1B1A17';
  const st = document.createElement('style');
  st.textContent = '#co-hole{transition:x .45s cubic-bezier(.65,0,.35,1),y .45s cubic-bezier(.65,0,.35,1),width .45s cubic-bezier(.65,0,.35,1),height .45s cubic-bezier(.65,0,.35,1),rx .45s}' +
    '#co-dim{transition:opacity .35s ease}' +
    '.co-g{transition:opacity .22s ease}.co-ring{transition:stroke-dashoffset .38s cubic-bezier(.65,0,.35,1)}.co-u{transition:stroke-dashoffset .32s cubic-bezier(.23,1,.32,1) .28s}' +
    '.co-pulse{transform-box:fill-box;transform-origin:center;animation:co-pulse .9s cubic-bezier(.23,1,.32,1) .3s 2}' +
    '@keyframes co-pulse{0%{transform:scale(1)}35%{transform:scale(1.045)}100%{transform:scale(1)}}' +
    '.co-label{position:fixed;z-index:2147482001;pointer-events:none;background:' + INK + ';color:' + PAPER + ';font-family:"Atkinson Hyperlegible Next Variable",sans-serif;font-weight:650;white-space:nowrap;opacity:0;transition:opacity .24s ease .22s,transform .3s cubic-bezier(.23,1,.32,1) .22s;box-shadow:0 6px 18px -6px rgba(27,26,23,.5)}';
  document.head.append(st);
  const svg = document.createElementNS(NS, 'svg');
  svg.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:2147482000;overflow:visible';
  svg.innerHTML = '<defs><filter id="co-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur id="co-std" stdDeviation="8"/></filter>' +
    '<mask id="co-mask" maskUnits="userSpaceOnUse" x="-100" y="-100" width="10000" height="10000"><rect x="-100" y="-100" width="10000" height="10000" fill="#fff"/><rect id="co-hole" fill="#000" filter="url(#co-blur)"/></mask></defs>' +
    '<rect id="co-dim" x="-100" y="-100" width="10000" height="10000" fill="' + INK + '" mask="url(#co-mask)" opacity="0"/>';
  document.body.append(svg);
  const hole = svg.querySelector('#co-hole'), dim = svg.querySelector('#co-dim'), std = svg.querySelector('#co-std');
  let cur = null;
  const el = (n, a) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };
  const drop = () => { if (!cur) return; const c = cur; cur = null; c.g.style.opacity = '0'; if (c.label) c.label.style.opacity = '0'; setTimeout(() => { c.g.remove(); c.label?.remove(); }, 300); };
  window.__co = {
    show(o) {
      drop();
      const s = 1 / (o.z || 1);
      const pad = (o.pad ?? 8) * s;
      const r = { x: o.x - pad, y: o.y - pad, w: o.w + 2 * pad, h: o.h + 2 * pad };
      const rx = o.round ? Math.min(r.w, r.h) / 2 : Math.min(12 * s, Math.min(r.w, r.h) / 2);
      const soft = 6 * s;
      hole.style.x = (r.x - soft) + 'px'; hole.style.y = (r.y - soft) + 'px';
      hole.style.width = (r.w + 2 * soft) + 'px'; hole.style.height = (r.h + 2 * soft) + 'px';
      hole.style.rx = (rx + soft) + 'px';
      std.setAttribute('stdDeviation', String(9 * s));
      dim.style.opacity = o.dim === false ? '0' : '0.6';
      const g = el('g', { class: 'co-g' });
      const shape = { x: r.x, y: r.y, width: r.w, height: r.h, rx, fill: 'none' };
      const under = el('rect', { ...shape, stroke: PAPER, 'stroke-width': 7 * s, pathLength: 1, 'stroke-dasharray': 1, 'stroke-dashoffset': 1, class: 'co-ring', opacity: 0.9 });
      const ring = el('rect', { ...shape, stroke: ACC, 'stroke-width': 3.5 * s, pathLength: 1, 'stroke-dasharray': 1, 'stroke-dashoffset': 1, class: 'co-ring' });
      g.append(under, ring);
      let u = null;
      if (o.num) {
        const y = r.y + r.h + 7 * s;
        u = el('line', { x1: r.x + 6 * s, x2: r.x + r.w - 6 * s, y1: y, y2: y, stroke: ACC, 'stroke-width': 5 * s, 'stroke-linecap': 'round', pathLength: 1, 'stroke-dasharray': 1, 'stroke-dashoffset': 1, class: 'co-u' });
        g.append(u);
      }
      svg.append(g);
      let label = null;
      if (o.label) {
        label = document.createElement('div');
        label.className = 'co-label';
        label.textContent = o.label;
        label.style.fontSize = (21 * s) + 'px';
        label.style.padding = (8 * s) + 'px ' + (14 * s) + 'px';
        label.style.borderRadius = (10 * s) + 'px';
        label.style.left = '0px'; label.style.top = '0px';
        document.body.append(label);
        const lw = label.offsetWidth, lh = label.offsetHeight;
        const v = o.view || { x: 0, y: 0, w: innerWidth, h: innerHeight };
        const m = 14 * s, bottom = 150 * s, gap = 54 * s;
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        const clampX = (x) => Math.max(v.x + m, Math.min(v.x + v.w - m - lw, x));
        const clampY = (y) => Math.max(v.y + m, Math.min(v.y + v.h - bottom - lh, y));
        const place = {
          top: () => ({ x: clampX(cx - lw / 2), y: r.y - gap - lh, ok: r.y - gap - lh >= v.y + m }),
          bottom: () => ({ x: clampX(cx - lw / 2), y: r.y + r.h + gap, ok: r.y + r.h + gap + lh <= v.y + v.h - bottom }),
          right: () => ({ x: r.x + r.w + gap, y: clampY(cy - lh / 2), ok: r.x + r.w + gap + lw <= v.x + v.w - m }),
          left: () => ({ x: r.x - gap - lw, y: clampY(cy - lh / 2), ok: r.x - gap - lw >= v.x + m }),
        };
        const order = [o.side, 'top', 'right', 'left', 'bottom'].filter((k, i, a) => k && a.indexOf(k) === i);
        let p = null;
        for (const k of order) { const q = place[k](); if (q.ok) { p = { ...q, k }; break; } }
        if (!p) p = { ...place.top(), k: 'top' };
        label.style.left = p.x + 'px'; label.style.top = p.y + 'px';
        label.style.transform = 'translateY(' + (p.k === 'bottom' ? -6 : 6) * s + 'px)';
        // leader from the label to the ring, with an arrowhead at the ring
        const lx = p.k === 'right' ? p.x : p.k === 'left' ? p.x + lw : Math.max(p.x + 12 * s, Math.min(p.x + lw - 12 * s, cx));
        const ly = p.k === 'top' ? p.y + lh : p.k === 'bottom' ? p.y : p.y + lh / 2;
        const tx = Math.max(r.x, Math.min(r.x + r.w, lx)), ty = Math.max(r.y, Math.min(r.y + r.h, ly));
        const ex = p.k === 'right' ? r.x + r.w + 3 * s : p.k === 'left' ? r.x - 3 * s : tx;
        const ey = p.k === 'top' ? r.y - 3 * s : p.k === 'bottom' ? r.y + r.h + 3 * s : ty;
        const a = Math.atan2(ey - ly, ex - lx), hl = 11 * s;
        const lead = el('path', { d: 'M' + lx + ' ' + ly + 'L' + ex + ' ' + ey, stroke: ACC, 'stroke-width': 3 * s, fill: 'none', 'stroke-linecap': 'round', pathLength: 1, 'stroke-dasharray': 1, 'stroke-dashoffset': 1, class: 'co-u' });
        const head = el('path', { d: 'M' + ex + ' ' + ey + 'L' + (ex - hl * Math.cos(a - 0.45)) + ' ' + (ey - hl * Math.sin(a - 0.45)) + 'L' + (ex - hl * Math.cos(a + 0.45)) + ' ' + (ey - hl * Math.sin(a + 0.45)) + 'Z', fill: ACC, opacity: 0, style: 'transition:opacity .15s ease .5s' });
        g.append(lead, head);
        requestAnimationFrame(() => requestAnimationFrame(() => { lead.style.strokeDashoffset = '0'; head.setAttribute('opacity', '1'); label.style.opacity = '1'; label.style.transform = 'none'; }));
      }
      requestAnimationFrame(() => requestAnimationFrame(() => {
        under.style.strokeDashoffset = '0'; ring.style.strokeDashoffset = '0';
        if (u) u.style.strokeDashoffset = '0';
        if (o.num) g.classList.add('co-pulse');
      }));
      cur = { g, label };
    },
    hide() { drop(); dim.style.opacity = '0'; },
  };
})();`;
async function setupPage(p) {
  await p.addStyleTag({ content: OVERLAY_CSS });
  await p.evaluate(() => { for (const id of ['rec-title', 'rec-sr']) { const d = document.createElement('div'); d.id = id; document.body.append(d); } });
  await p.evaluate(CALLOUT_JS);
  const s = await p.context().newCDPSession(p);
  await s.send('Animation.enable');
  await s.send('Animation.setPlaybackRate', { playbackRate: 1 / SLOW });
}

const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE });
await cacheTiles(context);
await context.addInitScript(initScript);
const page = await context.newPage();
page.on('pageerror', (e) => console.error('page error', e.message));

/* ---------- frame capture via the DevTools screencast, on the page clock ---------- */
const cdp = await context.newCDPSession(page);
const captured = [];
let n = 0;
let T0 = Date.now() / 1000;
const now = () => (Date.now() / 1000 - T0) / SLOW;
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms * SLOW)));
cdp.on('Page.screencastFrame', async (f) => {
  const file = join(frames, `f${String(n++).padStart(6, '0')}.jpg`);
  writeFileSync(file, Buffer.from(f.data, 'base64'));
  captured.push({ t: (f.metadata.timestamp - T0) / SLOW, file });
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});

/* ---------- scenes ---------- */
const scenes = [];
let open = null;
async function scene(name, opts = {}) {
  const start = now();
  const prev = scenes.at(-1);
  if (prev && start - prev.end > 0.1) cam.cut(start);
  const text = script[name] ?? [];
  const ls = await Promise.all(text.map(voice));
  const offsets = [];
  let t = 0;
  for (const l of ls) { offsets.push(t); t += l.dur + GAP; }
  open = { name, start, end: 0, lead: opts.lead ?? 0.35, caption: opts.caption === null ? undefined : captions[name], card: !!opts.card, lines: ls, offsets, total: Math.max(0, t - GAP) };
  scenes.push(open);
}
async function cue(i, early = 0.25) { await sleep((open.start + open.lead + open.offsets[i] - early - now()) * 1000); }
async function settle(before = 0.2) { await sleep((open.start + open.lead + open.total - before - now()) * 1000); }
async function done({ tail = 0.6 } = {}) {
  await sleep((open.start + open.lead + open.total + tail - now()) * 1000);
  open.end = now();
  open = null;
}

/* ---------- camera ---------- */
const shots = [];
/** What the camera shows once it lands, in CSS px of the page (the editor clamps the crop the same way). */
const viewOf = (cx, cy, z) => {
  const w = W / z, h = H / z;
  return { x: Math.min(W - w, Math.max(0, cx - w / 2)), y: Math.min(H - h, Math.max(0, cy - h / 2)), w, h };
};
const cam = {
  z: 1,
  view: { x: 0, y: 0, w: W, h: H },
  wide(d = 0.9) { shots.push({ t: now(), d, cx: W / 2, cy: H / 2, z: 1 }); this.z = 1; this.view = viewOf(W / 2, H / 2, 1); return sleep(d * 1000); },
  cut(t) { shots.push({ t, d: 0, cx: W / 2, cy: H / 2, z: 1 }); this.z = 1; this.view = viewOf(W / 2, H / 2, 1); },
  set(r, opts = {}) { return this.to(r, { ...opts, d: 0 }); },
  to(r, { z, pad = 1.18, d = 1.0, dx = 0, dy = 0 } = {}) {
    const fit = Math.min(W / (r.w * pad), H / (r.h * pad));
    const zz = Math.max(1, Math.min(MAX_Z, z ?? fit));
    const cx = r.x + r.w / 2 + dx, cy = r.y + r.h / 2 + dy;
    shots.push({ t: now(), d, cx, cy, z: zz });
    this.z = zz;
    this.view = viewOf(cx, cy, zz);
    return sleep(d * 1000);
  },
};
const union = (...rs) => {
  const x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
  const x1 = Math.max(...rs.map((r) => r.x + r.w)), y1 = Math.max(...rs.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};
async function rect(sel) {
  const b = await page.locator(sel).first().boundingBox({ timeout: 10000 });
  if (!b) throw new Error('not visible: ' + sel);
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}
/** Screen rectangle around map points ([lng, lat]), padded by m CSS px. */
async function mapRect(points, m = 40) {
  const ps = await page.evaluate((pts) => pts.map((p) => { const q = window.stm.map.project(p); return [q.x, q.y]; }), points);
  const xs = ps.map((p) => p[0]), ys = ps.map((p) => p[1]);
  return { x: Math.min(...xs) - m, y: Math.min(...ys) - m, w: Math.max(...xs) - Math.min(...xs) + 2 * m, h: Math.max(...ys) - Math.min(...ys) + 2 * m };
}
const pinLL = () => page.evaluate(() => [window.stm.state.pin.lon, window.stm.state.pin.lat]);
const fixLL = (i = 0) => page.evaluate((i) => window.stm.ink.markLngLat(window.stm.state.result.fixes[i].barrier), i);
const fixPoisLL = (i = 0) => page.evaluate((i) => {
  const st = window.stm.state;
  return st.result.fixes[i].newPois.map((id) => st.pois.find((p) => p.id === id)).filter(Boolean).map((p) => [p.lon, p.lat]);
}, i);


/* ---------- callouts, timed to the word that names the thing ---------- */
/** Waits until word w of sentence i of the current scene is about to be heard (spoken time is spread by characters). */
async function word(i, w, early = 0.15) {
  const l = open.lines[i];
  const k = l.text.indexOf(w);
  if (k < 0) throw new Error(`"${w}" is not in: ${l.text}`);
  const speak = Math.max(0.2, l.dur - 0.17);
  await sleep((open.start + open.lead + open.offsets[i] + (speak * k) / l.text.length - early - now()) * 1000);
}
/** A target: a selector, {ll: [lng, lat], r}, {lls: [...], m}, {frame, sel}, or a rect. */
async function box(t) {
  if (typeof t === 'string') return rect(t);
  if (t.ll) { const r = await mapRect([t.ll], t.r ?? 16); return r; }
  if (t.lls) return mapRect(t.lls, t.m ?? 24);
  if (t.frame) {
    const f = await rect(t.frame);
    const b = await page.frameLocator(t.frame).locator(t.sel).first().boundingBox();
    // boundingBox inside a frame is already in page coordinates
    return { x: b.x, y: b.y, w: b.width, h: b.height, f };
  }
  if (t.all) {
    const bs = await page.locator(t.all).evaluateAll((es, n) => es.slice(0, n).map((e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }), t.n ?? 99);
    return union(...bs);
  }
  return t;
}
const calls = [];
async function co(t, o = {}) {
  const r = await box(t);
  calls.push({ t: now(), scene: open?.name, label: o.label ?? null, r: { x: r.x, y: r.y, w: r.w, h: r.h } });
  await page.evaluate(([r, o]) => window.__co.show({ ...r, ...o }), [{ x: r.x, y: r.y, w: r.w, h: r.h }, { ...o, z: cam.z, view: cam.view }]);
}
const coOff = () => page.evaluate(() => window.__co?.hide());
/** A point on the ink, from the routing result: 'walk' (reached on foot only) or 'wc' (wheelchair, confirmed),
 *  nearest to a spot given as an offset in CSS px from the pin, and inside the camera view. */
const inkPoint = (kind, off, view) => page.evaluate(([kind, off, view]) => {
  const { ink, map, state } = window.stm;
  const g = ink.geo, res = ink.res, B = res.budget;
  const p0 = map.project([state.pin.lon, state.pin.lat]);
  const want = { x: p0.x + off[0], y: p0.y + off[1] };
  let best = null, bd = Infinity;
  for (let e = 0; e < g.m; e++) {
    const a = g.ea[e], b = g.eb[e];
    const walkOk = res.walk[a] <= B * 0.85 && res.walk[b] <= B * 0.85;
    const wcOk = res.wc[a] <= B && res.wc[b] <= B;
    if (kind === 'walk' ? !(walkOk && !(res.wc[a] <= B) && !(res.wc[b] <= B)) : !(wcOk && !g.unverified[e])) continue;
    if (g.len[e] < 12) continue;
    const ll = [(g.lon[a] + g.lon[b]) / 2, (g.lat[a] + g.lat[b]) / 2];
    const q = map.project(ll);
    if (q.x < view.x + 60 || q.x > view.x + view.w - 60 || q.y < view.y + 60 || q.y > view.y + view.h - 140) continue;
    const d = Math.hypot(q.x - want.x, q.y - want.y);
    if (d < bd) { bd = d; best = ll; }
  }
  return best;
}, [kind, off, view]);
/** The drawn barrier mark of a kind ('steps', 'kerb', ...) nearest the pin inside the view, as [lng, lat]. */
const markOf = (kind, view) => page.evaluate(([kind, view]) => {
  const { ink, map, state } = window.stm;
  const p0 = map.project([state.pin.lon, state.pin.lat]);
  let best = null, bd = Infinity;
  for (const m of ink.marks) {
    if (state.barriers[m.barrier]?.kind !== kind) continue;
    const ll = ink.markLngLat(m.barrier);
    if (!ll) continue;
    const q = map.project(ll);
    if (q.x < view.x + 40 || q.x > view.x + view.w - 40 || q.y < view.y + 40 || q.y > view.y + view.h - 140) continue;
    const d = Math.hypot(q.x - p0.x, q.y - p0.y);
    if (d < bd) { bd = d; best = ll; }
  }
  return best;
}, [kind, view]);
const PIN = '.maplibregl-marker';

/* ---------- the result card scrolls on its own ---------- */
async function panelTo(y, ms = 800) {
  await page.evaluate(([y, ms]) => new Promise((done) => {
    const p = document.getElementById('panel');
    const s = p.scrollTop, d = Math.max(0, Math.min(y, p.scrollHeight - p.clientHeight)) - s, t0 = performance.now();
    if (Math.abs(d) < 2) return done();
    const step = (t) => {
      const q = Math.min(1, (t - t0) / ms);
      const e = q < 0.5 ? 4 * q * q * q : 1 - Math.pow(-2 * q + 2, 3) / 2;
      p.scrollTop = s + d * e;
      q < 1 ? requestAnimationFrame(step) : done();
    };
    requestAnimationFrame(step);
  }), [y, ms]);
}
async function panelShow(sel, top = 96, ms = 800) {
  const y = await page.evaluate(([sel, top]) => {
    const p = document.getElementById('panel');
    const el = document.querySelector(sel);
    return el.getBoundingClientRect().top - p.getBoundingClientRect().top + p.scrollTop - top;
  }, [sel, top]);
  await panelTo(y, ms);
}

/* ---------- cursor: eased, slightly curved paths ---------- */
let mx = W * 0.6, my = H * 0.7;
const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
async function glide(x, y, ms) {
  const dx = x - mx, dy = y - my, dist = Math.hypot(dx, dy);
  const T = ms ?? Math.min(1100, 420 + dist * 0.55);
  const steps = Math.max(2, Math.round(T / 12));
  const bow = Math.min(50, dist * 0.08) * (dx > 0 ? 1 : -1);
  const qx = mx + dx / 2 - (dy / (dist || 1)) * bow, qy = my + dy / 2 + (dx / (dist || 1)) * bow;
  const sx = mx, sy = my, t0 = now();
  for (let i = 1; i <= steps; i++) {
    const p = ease(i / steps);
    await page.mouse.move((1 - p) * (1 - p) * sx + 2 * (1 - p) * p * qx + p * p * x, (1 - p) * (1 - p) * sy + 2 * (1 - p) * p * qy + p * p * y);
    await sleep((t0 + (i * T) / steps / 1000 - now()) * 1000);
  }
  mx = x; my = y;
}
async function pointAt(sel, ms, fx = 0.5, fy = 0.5) {
  const r = await rect(sel);
  await glide(r.x + r.w * fx, r.y + r.h * fy, ms);
}
async function press(sel, ms, fx, fy) {
  await pointAt(sel, ms, fx, fy);
  await sleep(150);
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
}
const hideCursor = (h) => page.evaluate((h) => window.__hideCursor?.(h), h);

/* ---------- overlays ---------- */
const titleCard = (html) => page.evaluate((html) => { const t = document.getElementById('rec-title'); t.innerHTML = html; void t.offsetWidth; t.classList.add('on'); }, html);
const titleOff = () => page.evaluate(() => document.getElementById('rec-title').classList.remove('on'));

async function loadApp(place) {
  await page.goto(`${APP}#place=${place}`);
  await setupPage(page);
  await page.waitForFunction(() => (document.getElementById('sentence')?.textContent ?? '').includes('%'), null, { timeout: 60000, polling: 100 });
  await page.evaluate(() => document.fonts.ready);
  await sleep(2500);
}

try {
  await loadApp('lisbon-martim-moniz');
  // clock zero: the first frame of the film
  T0 = Date.now() / 1000;
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 93, maxWidth: W * SCALE, maxHeight: H * SCALE, everyNthFrame: 1 });
  await sleep(300);

  /* 1. Hook: the two inks spread, then the figure */
  const pin = await pinLL();
  cam.set(await mapRect([pin], 230), { z: 1.75, dx: -20, dy: 60 });
  await scene('hook', { lead: 0.5 });
  await page.locator('.chip', { hasText: 'Martim Moniz' }).evaluate((b) => b.click());
  await word(0, 'Martim Moniz');
  await co(PIN, { pad: 10, label: 'Martim Moniz, Lisbon', side: 'right' });
  await word(0, 'at the same', 0.1);
  await coOff();
  await cam.to(await mapRect([pin], 330), { z: 1.3, d: 0.8, dx: -60, dy: 80 });
  await word(1, 'One walks', 0.2);
  await co({ ll: await inkPoint('walk', [-240, 120], cam.view), r: 20 }, { round: true, label: 'Blue: on foot', side: 'left' });
  await word(1, 'The other', 0.05);
  await co({ ll: await inkPoint('wc', [10, 170], cam.view), r: 20 }, { round: true, label: 'Orange: wheelchair', side: 'right' });
  await cue(2, 0.7);
  await coOff();
  await cam.to(union(await rect('.gap'), await rect('.gap-caption')), { z: 2.1, d: 1.0 });
  await word(2, `${say(lis.pct)} percent`, 0.25);
  await co('.gap', { num: true, pad: 6 });
  await done({ tail: 0.5 });
  await coOff();

  /* 2. Title */
  await scene('title', { lead: 0.6, caption: null, card: true });
  await cam.wide(0.9);
  await titleCard(`<div class="t"><h1>Same Ten Minutes</h1><p>How much of a neighbourhood can a wheelchair user really reach, in the time a walker does?</p><div class="inks"><span class="w"></span><span class="c"></span></div></div>`);
  await done({ tail: 0.2 });

  /* 3. Barriers: in on the marks where the orange ink stops */
  await scene('barriers', { lead: 0.6 });
  await titleOff();
  await sleep(450);
  const f0 = await fixLL(0);
  const marks = await page.evaluate(() => window.stm.state.result.fixes.slice(0, 3).map((f) => window.stm.ink.markLngLat(f.barrier)).filter(Boolean));
  await cam.to(await mapRect([...marks, pin], 90), { z: 1.9, d: 1.1 });
  await word(0, 'orange ink');
  await co({ ll: await inkPoint('wc', [-20, 150], cam.view), r: 20 }, { round: true, label: 'The wheelchair ink', side: 'left' });
  await word(1, 'staircases');
  await co({ ll: f0, r: 15 }, { round: true, label: 'A staircase', side: 'left' });
  const kerb = await markOf('kerb', cam.view);
  if (kerb) { await word(1, 'raised kerbs'); await co({ ll: kerb, r: 15 }, { round: true, label: 'A raised kerb', side: 'right' }); }
  const rough = (await markOf('surface', cam.view)) ?? (await markOf('narrow', cam.view));
  if (rough) { await word(1, 'rough or narrow'); await co({ ll: rough, r: 15 }, { round: true, label: 'A rough or narrow path', side: 'right' }); }
  await cue(2, 0.3);
  await coOff();
  await cam.to(await mapRect([...marks, pin], 150), { z: 1.6, d: 0.9 });
  await co({ lls: marks, m: 22 }, { label: 'Barrier marks, from OpenStreetMap', side: 'right' });
  await done({ tail: 0.3 });
  await coOff();

  /* 4. The gap figure, counted again for fifteen minutes */
  await scene('gap', { lead: 0.2 });
  await cam.to(union(await rect('.gap'), await rect('.gap-caption')), { z: 2.2, d: 1.0 });
  await word(0, `${say(lis.pct)} percent`, 0.25);
  await co('.gap', { num: true, pad: 6 });
  await cue(1, 0.5);
  await coOff();
  await cam.to(union(await rect('.gap'), await rect('.reached')), { pad: 1.1, d: 0.9 });
  await word(1, sayKm(lis.wcKm));
  await co('.meter', { num: true, pad: 8, label: `${lis.wcKm} of ${lis.walkKm} km`, side: 'top' });
  await word(1, `${say(lis.health[0])} of the`);
  await co('#reached tr:first-child', { num: true, pad: 6, label: `${lis.health[0]} of ${lis.health[1]} health places`, side: 'top' });
  await pointAt('label[for=b15]', 700);
  await cue(2, 0.6);
  await coOff();
  await cam.to(union(await rect('.seg'), await rect('.gap')), { z: 2.0, d: 0.8 });
  await co('label[for=b15]', { pad: 4 });
  await fresh(page, () => press('label[for=b15]', 250), '15 minutes');
  await word(2, `${say(lis15.pct)} percent`, 0.25);
  await co('.gap', { num: true, pad: 6 });
  await done({ tail: 1.2 });
  await coOff();
  // back to ten minutes, between scenes
  await fresh(page, () => page.click('label[for=b10]'), '10 minutes');
  await page.evaluate(() => window.stm.ink.finish());
  await glide(W * 0.62, H * 0.72, 300);
  await sleep(1200);

  /* 5. Honest about the data */
  await scene('honest', { lead: 0.2 });
  // where the dashed (unconfirmed) wheelchair streets are: the middle 60% of their midpoints, and the one nearest the middle
  const dashed = await page.evaluate(() => {
    const { ink } = window.stm;
    const g = ink.geo, arr = ink.res.wc, B = ink.res.budget;
    const pts = [];
    for (const e of ink.wcEdges) {
      if (!g.unverified[e] || !(arr[g.ea[e]] <= B) || !(arr[g.eb[e]] <= B) || g.len[e] < 15) continue;
      pts.push([(g.lon[g.ea[e]] + g.lon[g.eb[e]]) / 2, (g.lat[g.ea[e]] + g.lat[g.eb[e]]) / 2]);
    }
    const q = (k, f) => pts.map((p) => p[k]).sort((u, v) => u - v)[Math.floor(f * (pts.length - 1))];
    const box = [[q(0, 0.2), q(1, 0.2)], [q(0, 0.8), q(1, 0.8)]];
    const mid = [(box[0][0] + box[1][0]) / 2, (box[0][1] + box[1][1]) / 2];
    const one = pts.reduce((b, p) => (Math.hypot(p[0] - mid[0], p[1] - mid[1]) < Math.hypot(b[0] - mid[0], b[1] - mid[1]) ? p : b), pts[0]);
    return { box, one };
  });
  await cam.to(await mapRect(dashed.box, 60), { pad: 1.1, d: 1.0 });
  await word(0, 'orange line');
  await co({ ll: dashed.one, r: 22 }, { round: true, label: 'Dashed: the map does not confirm it', side: 'right' });
  await panelShow('#confidence', 220, 900);
  await cue(1, 0.5);
  await coOff();
  await cam.to(await rect('#confidence'), { pad: 1.15, d: 0.9 });
  await word(1, `${say(lis.conf)} percent`, 0.25);
  await co('#confidence strong', { num: true, pad: 5 });
  await done({ tail: 0.5 });
  await coOff();

  /* 6. Fix first: the barrier lifts and the ink floods */
  await scene('fix', { lead: 0.2 });
  await cam.wide(0.8);
  await panelShow('#fixes', 230, 900);
  await cam.to(union(await rect('#fixes h2'), await rect('.fix')), { z: 2.0, d: 0.9 });
  await word(0, 'question');
  await co('#fixes h2', { pad: 6 });
  await word(1, 'single fix');
  await co('.fix', { pad: 5, label: 'The fix that gives back the most', side: 'top' });
  await cue(2, 0.3);
  await coOff();
  const fixCard = await rect('.fix');
  const markR = await mapRect([f0], 60);
  await cam.to(union(fixCard, markR), { pad: 1.12, d: 1.0 });
  await co({ all: '.fix', n: 3 }, { pad: 5, label: 'Each barrier removed in turn, ranked', side: 'right' });
  await pointAt('.fix', 900, 0.5, 0.45);
  await word(3, 'one staircase');
  await co({ ll: f0, r: 15 }, { round: true, label: 'This staircase', side: 'right' });
  await word(3, 'With a ramp', 0.35);
  await press('.fix', 200, 0.5, 0.45);
  await sleep(350);
  await coOff();
  const flood = await mapRect([f0, ...(await fixPoisLL(0))], 90);
  await cam.to(union(await rect('#readout'), flood), { pad: 1.06, d: 1.0 });
  await word(3, `from ${say(lis.pct)}`, 0.2);
  await co('#readout .ro-fig', { num: true, pad: 6, label: `${lis.pct}% → ${lis.fixAfter}%`, side: 'right' });
  await word(3, `${say(lis.fixPlaces)} more places`, 0.4);
  await coOff();
  await cam.to(flood, { z: 1.7, d: 0.9 });
  await co({ lls: await fixPoisLL(0), m: 26 }, { label: `+${lis.fixPlaces} places within reach`, side: 'right' });
  await done({ tail: 0.6 });
  await coOff();

  /* 7. The steep-terrain switch */
  await scene('hills', { lead: 0.3 });
  await cam.wide(0.8);
  await panelTo(99999, 900);
  await cam.to(union(await rect('.toggle'), await rect('.foot > p')), { z: 2.2, d: 0.9 });
  await word(0, 'terrain data');
  await co('.foot > p', { pad: 5, label: 'About 30 m elevation data', side: 'bottom' });
  await pointAt('#hills', 700);
  await word(1, 'flagged');
  await co('.toggle', { pad: 6, label: 'Off by default', side: 'top' });
  await word(2, 'Count steep', 0.3);
  await fresh(page, () => press('#hills', 200), 'Martim');
  await coOff();
  await sleep(150);
  await cam.to(union(await rect('#readout'), await mapRect([pin], 160)), { pad: 1.08, d: 1.0 });
  await word(2, `${say(lisHills.pct)} percent`, 0.3);
  await co('#readout .ro-fig', { num: true, pad: 6, label: `${lisHills.pct}% with steep streets blocked`, side: 'right' });
  await done({ tail: 1.0 });
  await coOff();
  await fresh(page, () => page.locator('#hills').uncheck(), 'Martim');
  await page.evaluate(() => window.stm.ink.finish());
  await panelTo(0, 10);
  await glide(300, 330, 300);
  await sleep(800);

  /* 8. Kuala Lumpur */
  await scene('kl', { lead: 0.3 });
  await cam.to(await rect('.places'), { z: 2.0, d: 0.8 });
  await pointAt('.chip:has-text("Masjid Jamek")', 600);
  await word(0, 'wherever');
  await co('.chip:has-text("Masjid Jamek")', { pad: 5, label: 'A bundled sample place', side: 'right' });
  await cue(1, 1.5);
  await coOff();
  await fresh(page, () => press('.chip:has-text("Masjid Jamek")', 200), 'Masjid');
  await sleep(650); // the map settles on the new reach
  const klPin = await pinLL();
  await cam.to(await mapRect([klPin], 260), { z: 1.6, d: 0.8 });
  await co(PIN, { pad: 10, label: 'Masjid Jamek, Kuala Lumpur', side: 'right' });
  await word(1, `${say(kl.pct)} percent`, 0.7);
  await coOff();
  await cam.to(union(await rect('.gap'), await rect('.gap-caption')), { z: 2.0, d: 0.8 });
  await co('.gap', { num: true, pad: 6 });
  await cue(2, 0.5);
  await coOff();
  const klFix = await fixLL(0);
  await cam.to(await mapRect([klFix, klPin], 120), { z: 1.9, d: 0.9 });
  await co({ ll: klFix, r: 15 }, { round: true, num: true, label: `Fix 1: ${kl.pct}% → ${kl.fixAfter}%`, side: 'right' });
  await done({ tail: 0.4 });
  await coOff();

  /* 9. Berlin */
  await scene('berlin', { lead: 1.4 });
  await cam.wide(0.6);
  await fresh(page, () => press('.chip:has-text("Alexanderplatz")', 500), 'Alexanderplatz');
  await sleep(650);
  const berPin = await pinLL();
  await cam.to(await mapRect([berPin], 260), { z: 1.5, d: 0.7 });
  await word(0, 'Berlin', 0.1);
  await co(PIN, { pad: 10, label: 'Alexanderplatz, Berlin', side: 'right' });
  await word(0, 'it can confirm', 0.6);
  await coOff();
  await panelShow('#confidence', 240, 700);
  await cam.to(await rect('#confidence strong'), { z: 2.2, d: 0.8 });
  await word(0, `${say(ber.conf)} percent`, 0.25);
  await co('#confidence strong', { num: true, pad: 5 });
  await done({ tail: 0.6 });
  await coOff();

  /* 10. Keyboard and screen reader */
  await hideCursor(true);
  await cam.wide(0.01);
  await panelTo(0, 10);
  await page.focus('#q');
  await sleep(600);
  await scene('access', { lead: 0.3 });
  await cam.to(union(await rect('#q'), await rect('.places')), { pad: 1.15, d: 0.9 });
  await co('#q', { pad: 4, label: 'Tab', side: 'right' });
  for (let i = 0; i < 3; i++) {
    await sleep(480);
    await page.keyboard.press('Tab');
    await sleep(60);
    await co(':focus', { pad: 5, label: 'Tab', side: 'right' });
  }
  await word(1, 'keyboard');
  await co(':focus', { pad: 5, label: 'Enter', side: 'right' });
  await sleep(300);
  await fresh(page, () => page.keyboard.press('Enter'), 'Martim');
  await coOff();
  await sleep(700);
  await cam.wide(0.8);
  await cue(2, 0.5);
  const sen = await sentence(page);
  await page.evaluate((s) => { const d = document.getElementById('rec-sr'); d.innerHTML = '<b>What a screen reader announces</b>' + s; d.classList.add('on'); }, sen);
  await sleep(350);
  await cam.to(await rect('#rec-sr'), { pad: 1.1, d: 0.9 });
  await co('#rec-sr', { pad: 6, dim: true });
  await done({ tail: 1.6 });
  await coOff();
  await page.evaluate(() => document.getElementById('rec-sr').classList.remove('on'));

  /* 11. Phone */
  await page.goto(`http://localhost:${PORT}/cards/phone.html`);
  await setupPage(page);
  const frame = page.frameLocator('#phone');
  await frame.locator('#sentence').filter({ hasText: '%' }).waitFor({ state: 'attached', timeout: 60000 });
  await sleep(2500);
  await scene('phone', { lead: 0.4 });
  await cam.to(await rect('.phone'), { pad: 1.04, d: 0.01 });
  await sleep(500);
  await frame.locator('#panel').evaluate((p) => new Promise((done) => {
    const el = document.querySelector('.fixes');
    const target = el.getBoundingClientRect().top - p.getBoundingClientRect().top + p.scrollTop - 90;
    const s = p.scrollTop, t0 = performance.now();
    const step = (t) => { const q = Math.min(1, (t - t0) / 1000); const e = q < 0.5 ? 4 * q * q * q : 1 - Math.pow(-2 * q + 2, 3) / 2; p.scrollTop = s + (target - s) * e; q < 1 ? requestAnimationFrame(step) : done(); };
    requestAnimationFrame(step);
  }));
  await word(0, 'the figure');
  await co({ frame: '#phone', sel: '#readout .ro-fig' }, { num: true, pad: 6, label: 'The figure stays pinned', side: 'right' });
  await cue(1, 0.2);
  await frame.locator('.fix').first().click();
  await done({ tail: 1.4 });
  await coOff();

  /* 12. The audit sheet */
  await loadApp('lisbon-martim-moniz');
  await hideCursor(true);
  await page.evaluate(() => window.stm.ink.finish());
  await page.evaluate(() => { window.print = () => {}; });
  await page.click('#print');
  await sleep(400);
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => {
    document.body.style.background = '#E9E4DA';
    const s = document.getElementById('print-sheet');
    s.style.cssText = 'display:block;max-width:820px;margin:32px auto;background:#fff;padding:48px 60px;box-shadow:0 12px 40px -12px rgba(0,0,0,.35)';
  });
  await sleep(600);
  await scene('audit', { lead: 0.3 });
  await cam.to({ x: 390, y: 20, w: 820, h: 860 }, { pad: 1.02, d: 0.01 });
  await word(0, 'audit sheet');
  await co('#print-sheet h1', { pad: 8, label: 'One page, ready to print', side: 'right' });
  await sleep(900);
  await coOff();
  await page.evaluate(() => new Promise((done) => {
    const s = scrollY, target = Math.min(document.documentElement.scrollHeight - innerHeight, 560), t0 = performance.now();
    const step = (t) => { const q = Math.min(1, (t - t0) / 1300); const e = q < 0.5 ? 4 * q * q * q : 1 - Math.pow(-2 * q + 2, 3) / 2; scrollTo(0, s + (target - s) * e); q < 1 ? requestAnimationFrame(step) : done(); };
    requestAnimationFrame(step);
  }));
  const table = await page.locator('#print-sheet table').last().boundingBox();
  if (table && table.y < H - 60) await cam.to({ x: table.x, y: table.y, w: table.width, h: Math.min(table.height, H - table.y) }, { pad: 1.08, d: 0.9 });
  await word(0, 'every barrier', 0.2);
  await co({ all: '#print-sheet small' }, { pad: 6, label: 'Each barrier links to OpenStreetMap', side: 'top' });
  await done({ tail: 0.6 });
  await coOff();
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => { scrollTo(0, 0); document.body.style.background = ''; document.getElementById('print-sheet').style.cssText = ''; });

  /* 13. End card, over the fixed Lisbon map */
  await page.evaluate(() => { document.querySelector('.fix')?.click(); });
  await sleep(2600);
  await scene('end', { lead: 0.8, caption: null, card: true });
  await cam.wide(0.01);
  await titleCard(`<div class="t"><h1>Same Ten Minutes</h1><p>Ten minutes should be the same ten minutes for everyone.</p><p class="small">Open source, MIT licence &nbsp;·&nbsp; Map data © OpenStreetMap contributors, ODbL &nbsp;·&nbsp; Elevation: Terrain Tiles on AWS</p></div>`);
  await done({ tail: 2.2 });
} finally {
  await cdp.send('Page.stopScreencast').catch(() => {});
  await browser.close();
  server.close();
}

writeFileSync(join(work, 'timeline.json'), JSON.stringify({ W, H, scale: SCALE, maxZ: MAX_Z, slow: SLOW, figures, frames: captured, scenes, shots, callouts: calls }, null, 1));
const dims = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', captured.at(-1).file]).toString().trim();
if (dims !== `${W * SCALE},${H * SCALE}`) throw new Error(`frames are ${dims}, not ${W * SCALE}x${H * SCALE}`);
const span = captured.at(-1).t - captured[0].t;
console.log(`recorded ${captured.length} frames over ${span.toFixed(1)} s of page time (${(captured.length / span).toFixed(1)} fps); ${scenes.length} scenes, ${shots.length} camera targets`);
