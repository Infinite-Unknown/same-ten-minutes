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
// The cursor is drawn into the page and moved along eased paths, so it is part of the capture.
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
  hook: ['Two people leave Martim Moniz, in Lisbon, at the same moment.', 'One walks. The other uses a wheelchair.',
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
  access: ['A tool about access has to be accessible.', 'Everything works from the keyboard, even the map.', 'And the result is read out as a plain sentence.'],
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
async function setupPage(p) {
  await p.addStyleTag({ content: OVERLAY_CSS });
  await p.evaluate(() => { for (const id of ['rec-title', 'rec-sr']) { const d = document.createElement('div'); d.id = id; document.body.append(d); } });
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
const cam = {
  z: 1,
  wide(d = 0.9) { shots.push({ t: now(), d, cx: W / 2, cy: H / 2, z: 1 }); this.z = 1; return sleep(d * 1000); },
  cut(t) { shots.push({ t, d: 0, cx: W / 2, cy: H / 2, z: 1 }); this.z = 1; },
  set(r, opts = {}) { return this.to(r, { ...opts, d: 0 }); },
  to(r, { z, pad = 1.18, d = 1.0, dx = 0, dy = 0 } = {}) {
    const fit = Math.min(W / (r.w * pad), H / (r.h * pad));
    const zz = Math.max(1, Math.min(MAX_Z, z ?? fit));
    shots.push({ t: now(), d, cx: r.x + r.w / 2 + dx, cy: r.y + r.h / 2 + dy, z: zz });
    this.z = zz;
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
  await sleep(1900);
  await cam.to(await mapRect([pin], 330), { z: 1.3, d: 1.4, dx: -60, dy: 80 });
  await cue(2, 0.9);
  await cam.to(union(await rect('.gap'), await rect('.gap-caption')), { z: 2.1, d: 1.1 });
  await done({ tail: 0.5 });

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
  await cam.to(await mapRect([...marks, pin], 70), { z: 2.0, d: 1.3 });
  await cue(1, 0.2);
  await cam.to(await mapRect([f0], 120), { z: 2.2, d: 1.1 });
  await cue(2, 0.3);
  await cam.to(await mapRect([...marks, pin], 150), { z: 1.6, d: 1.1 });
  await done({ tail: 0.3 });

  /* 4. The gap figure, counted again for fifteen minutes */
  await scene('gap', { lead: 0.2 });
  await cam.to(union(await rect('.gap'), await rect('.gap-caption')), { z: 2.2, d: 1.1 });
  await cue(1, 0.3);
  await cam.to(union(await rect('.gap'), await rect('.reached')), { pad: 1.1, d: 1.1 });
  await pointAt('label[for=b15]', 900);
  await cue(2, 0.6);
  await cam.to(union(await rect('.seg'), await rect('.gap')), { z: 2.0, d: 0.8 });
  await fresh(page, () => press('label[for=b15]', 300), '15 minutes');
  await done({ tail: 1.2 });
  // back to ten minutes, between scenes
  await fresh(page, () => page.click('label[for=b10]'), '10 minutes');
  await page.evaluate(() => window.stm.ink.finish());
  await glide(W * 0.62, H * 0.72, 300);
  await sleep(1200);

  /* 5. Honest about the data */
  await scene('honest', { lead: 0.2 });
  // where the dashed (unconfirmed) wheelchair streets are: the middle 60% of their midpoints
  const dashed = await page.evaluate(() => {
    const { ink } = window.stm;
    const g = ink.geo, arr = ink.res.wc, B = ink.res.budget;
    const xs = [], ys = [];
    for (const e of ink.wcEdges) {
      if (!g.unverified[e] || !(arr[g.ea[e]] <= B) || !(arr[g.eb[e]] <= B)) continue;
      xs.push((g.lon[g.ea[e]] + g.lon[g.eb[e]]) / 2);
      ys.push((g.lat[g.ea[e]] + g.lat[g.eb[e]]) / 2);
    }
    const q = (a, f) => a.slice().sort((u, v) => u - v)[Math.floor(f * (a.length - 1))];
    return [[q(xs, 0.2), q(ys, 0.2)], [q(xs, 0.8), q(ys, 0.8)]];
  });
  await cam.to(await mapRect(dashed, 60), { pad: 1.1, d: 1.2 });
  await panelShow('#confidence', 220, 900);
  await cue(1, 0.5);
  await cam.to(await rect('#confidence'), { pad: 1.15, d: 1.1 });
  await done({ tail: 0.5 });

  /* 6. Fix first: the barrier lifts and the ink floods */
  await scene('fix', { lead: 0.2 });
  await cam.wide(0.9);
  await panelShow('#fixes', 230, 1000);
  await cam.to(union(await rect('#fixes h2'), await rect('.fix')), { z: 2.0, d: 1.0 });
  await cue(2, 0.3);
  const fixCard = await rect('.fix');
  const markR = await mapRect([f0], 60);
  await cam.to(union(fixCard, markR), { pad: 1.12, d: 1.1 });
  await pointAt('.fix', 1000, 0.5, 0.45);
  await cue(3, 0.4);
  await press('.fix', 250, 0.5, 0.45);
  await sleep(500);
  const flood = await mapRect([f0, ...(await fixPoisLL(0))], 90);
  await cam.to(union(await rect('#readout'), flood), { pad: 1.06, d: 1.3 });
  await sleep(1400);
  await cam.to(flood, { z: 1.7, d: 1.2 });
  await done({ tail: 0.6 });

  /* 7. The steep-terrain switch */
  await scene('hills', { lead: 0.3 });
  await cam.wide(0.9);
  await panelTo(99999, 1000);
  await cam.to(await rect('.toggle'), { z: 2.2, d: 1.0 });
  await pointAt('#hills', 900);
  await cue(2, 0.2);
  await fresh(page, () => press('#hills', 250), 'Martim');
  await sleep(200);
  await cam.to(union(await rect('#readout'), await mapRect([pin], 160)), { pad: 1.08, d: 1.2 });
  await done({ tail: 1.0 });
  await fresh(page, () => page.locator('#hills').uncheck(), 'Martim');
  await page.evaluate(() => window.stm.ink.finish());
  await panelTo(0, 10);
  await glide(300, 330, 300);
  await sleep(800);

  /* 8. Kuala Lumpur */
  await scene('kl', { lead: 0.3 });
  await pointAt('.chip:has-text("Masjid Jamek")', 800);
  await cue(1, 0.9);
  await fresh(page, () => press('.chip:has-text("Masjid Jamek")', 200), 'Masjid');
  await sleep(650); // the map settles on the new reach
  const klPin = await pinLL();
  await cam.to(await mapRect([klPin], 260), { z: 1.6, d: 0.9 });
  await sleep(600);
  await cam.to(union(await rect('.gap'), await rect('.gap-caption')), { z: 2.0, d: 1.1 });
  await cue(2, 0.4);
  await cam.wide(1.0);
  await done({ tail: 0.4 });

  /* 9. Berlin */
  await scene('berlin', { lead: 0.2 });
  await fresh(page, () => press('.chip:has-text("Alexanderplatz")', 700), 'Alexanderplatz');
  await sleep(2200);
  await panelShow('#confidence', 240, 900);
  await cam.to(await rect('#confidence strong'), { z: 2.2, d: 1.0 });
  await done({ tail: 0.6 });

  /* 10. Keyboard and screen reader */
  await hideCursor(true);
  await cam.wide(0.01);
  await panelTo(0, 10);
  await page.focus('#q');
  await sleep(600);
  await scene('access', { lead: 0.3 });
  await cam.to(union(await rect('#q'), await rect('.places')), { pad: 1.15, d: 1.0 });
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Tab'); await sleep(520); }
  await cue(1, 0.1);
  await fresh(page, () => page.keyboard.press('Enter'), 'Martim');
  await sleep(900);
  await cam.wide(1.0);
  await cue(2, 0.5);
  const sen = await sentence(page);
  await page.evaluate((s) => { const d = document.getElementById('rec-sr'); d.innerHTML = '<b>What a screen reader announces</b>' + s; d.classList.add('on'); }, sen);
  await sleep(150);
  await cam.to(await rect('#rec-sr'), { pad: 1.1, d: 1.0 });
  await done({ tail: 1.6 });
  await page.evaluate(() => document.getElementById('rec-sr').classList.remove('on'));

  /* 11. Phone */
  await page.goto(`http://localhost:${PORT}/cards/phone.html`);
  await setupPage(page);
  const frame = page.frameLocator('#phone');
  await frame.locator('#sentence').filter({ hasText: '%' }).waitFor({ state: 'attached', timeout: 60000 });
  await sleep(2500);
  await scene('phone', { lead: 0.4 });
  await cam.to(await rect('.phone'), { pad: 1.04, d: 0.01 });
  await sleep(700);
  await frame.locator('#panel').evaluate((p) => new Promise((done) => {
    const el = document.querySelector('.fixes');
    const target = el.getBoundingClientRect().top - p.getBoundingClientRect().top + p.scrollTop - 90;
    const s = p.scrollTop, t0 = performance.now();
    const step = (t) => { const q = Math.min(1, (t - t0) / 1100); const e = q < 0.5 ? 4 * q * q * q : 1 - Math.pow(-2 * q + 2, 3) / 2; p.scrollTop = s + (target - s) * e; q < 1 ? requestAnimationFrame(step) : done(); };
    requestAnimationFrame(step);
  }));
  await sleep(500);
  await frame.locator('.fix').first().click();
  await done({ tail: 1.4 });

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
  await sleep(1400);
  await page.evaluate(() => new Promise((done) => {
    const s = scrollY, target = Math.min(document.documentElement.scrollHeight - innerHeight, 560), t0 = performance.now();
    const step = (t) => { const q = Math.min(1, (t - t0) / 2200); const e = q < 0.5 ? 4 * q * q * q : 1 - Math.pow(-2 * q + 2, 3) / 2; scrollTo(0, s + (target - s) * e); q < 1 ? requestAnimationFrame(step) : done(); };
    requestAnimationFrame(step);
  }));
  const table = await page.locator('#print-sheet table').last().boundingBox();
  if (table && table.y < H - 60) await cam.to({ x: table.x, y: table.y, w: table.width, h: Math.min(table.height, H - table.y) }, { pad: 1.08, d: 1.1 });
  await done({ tail: 0.6 });
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

writeFileSync(join(work, 'timeline.json'), JSON.stringify({ W, H, scale: SCALE, maxZ: MAX_Z, slow: SLOW, figures, frames: captured, scenes, shots }, null, 1));
const dims = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', captured.at(-1).file]).toString().trim();
if (dims !== `${W * SCALE},${H * SCALE}`) throw new Error(`frames are ${dims}, not ${W * SCALE}x${H * SCALE}`);
const span = captured.at(-1).t - captured[0].t;
console.log(`recorded ${captured.length} frames over ${span.toFixed(1)} s of page time (${(captured.length / span).toFixed(1)} fps); ${scenes.length} scenes, ${shots.length} camera targets`);
