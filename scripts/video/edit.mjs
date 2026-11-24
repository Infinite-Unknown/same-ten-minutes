// Demo video, step 2 of 2: turns the recording from record.mjs into assets/demo.mp4 and assets/demo-upload.mp4.
//
//  - Each scene becomes a 60 fps segment cut from the 3200x1800 capture, using the frames' page-clock
//    timestamps. Gaps between scenes are cut out with a short dip through the paper colour.
//  - The camera is a per-frame crop of the 2x capture (ffmpeg perspective, cubic, sub-pixel), eased with an
//    ease-in-out cubic between targets that came from real element rectangles, then scaled to 1920x1080.
//  - Captions are rendered in the app's typeface and fade and rise in. The OpenStreetMap / ODbL credit
//    stays on screen whenever the map is.
//  - Narration sentences are placed at the times the recorder cued them, mixed, and normalised to -16 LUFS.
//  - assets/demo-upload.mp4 is a two-pass copy under 9.5 MB for upload forms with a size limit.
//
//   CHROME_PATH=... node scripts/video/edit.mjs
import { chromium } from 'playwright-core';
import { execFileSync, spawnSync } from 'node:child_process';
import { createReadStream, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const work = join(root, '.cache/video');
const out = join(root, 'assets/demo.mp4');
const outSmall = join(root, 'assets/demo-upload.mp4');
const CHROME = process.env.CHROME_PATH;
if (!CHROME) { console.error('Set CHROME_PATH.'); process.exit(2); }
const FPS = 60;
const OW = 1920;
const OH = 1080;
const PAPER = '0xF3EEE4';
const DIP = 0.25; // fade through paper at a cut, each side

const tl = JSON.parse(readFileSync(join(work, 'timeline.json'), 'utf8'));
const CW = tl.W * tl.scale;
const CH = tl.H * tl.scale;
const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
const probe = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());

/* ---------- plan: where each scene sits in the film ---------- */
const plan = tl.scenes.map((s, i) => {
  const len = Math.max(s.end - s.start, s.lead + s.total + 0.3);
  const cutIn = i > 0 && s.start - tl.scenes[i - 1].end > 0.1;
  return { s, len, cutIn, outStart: 0 };
});
let acc = 0;
for (const p of plan) { p.outStart = acc; acc += p.len; }
const total = acc;
for (const p of plan) console.log(`${p.s.name.padEnd(9)} at ${p.outStart.toFixed(1).padStart(6)} s  ${p.len.toFixed(1).padStart(5)} s${p.cutIn ? '  (cut)' : ''}`);
console.log(`total ${total.toFixed(1)} s`);
if (total > 180) throw new Error('over three minutes');

/* ---------- 1. one segment per scene, from the timestamped frames ---------- */
const frames = tl.frames;
const segs = [];
for (const [i, p] of plan.entries()) {
  const { s, len } = p;
  let k = frames.findLastIndex((f) => f.t <= s.start);
  if (k < 0) k = 0;
  const list = [];
  for (; k < frames.length && frames[k].t < s.end; k++) {
    const a = Math.max(frames[k].t, s.start);
    const b = Math.min(frames[k + 1]?.t ?? s.end, s.end);
    list.push(`file '${frames[k].file}'`, `duration ${Math.max(0.0005, b - a).toFixed(5)}`);
  }
  list.push(list.at(-2));
  writeFileSync(join(work, `s${i}.txt`), list.join('\n'));
  const fades = [];
  if (i === 0) fades.push(`fade=t=in:st=0:d=0.35:color=${PAPER}`);
  if (p.cutIn) fades.push(`fade=t=in:st=0:d=${DIP}:color=${PAPER}`);
  if (plan[i + 1]?.cutIn) fades.push(`fade=t=out:st=${(len - DIP).toFixed(3)}:d=${DIP}:color=${PAPER}`);
  if (i === plan.length - 1) fades.push(`fade=t=out:st=${(len - 0.8).toFixed(3)}:d=0.8:color=${PAPER}`);
  const vf = [`scale=${CW}:${CH}:flags=lanczos`, `fps=${FPS}`, `tpad=stop_mode=clone:stop_duration=${len.toFixed(3)}`, `trim=duration=${len.toFixed(4)}`, 'setpts=PTS-STARTPTS', ...fades, 'format=yuv420p'].join(',');
  const seg = join(work, `seg${i}.mp4`);
  ff(['-f', 'concat', '-safe', '0', '-i', join(work, `s${i}.txt`), '-vf', vf, '-r', String(FPS), '-c:v', 'libx264', '-crf', '10', '-preset', 'veryfast', '-an', seg]);
  segs.push(seg);
}
writeFileSync(join(work, 'segs.txt'), segs.map((f) => `file '${f}'`).join('\n'));
const body = join(work, 'body.mp4');
ff(['-f', 'concat', '-safe', '0', '-i', join(work, 'segs.txt'), '-c', 'copy', body]);

/* ---------- 2. camera: targets mapped to film time, eased one after another ---------- */
function outTime(t) {
  for (const p of plan) {
    if (t < p.s.start) return p.outStart; // in a gap before this scene: lands at the cut
    if (t <= p.s.end) return p.outStart + (t - p.s.start);
  }
  return total;
}
const clampCam = (cx, cy, z) => {
  const w = CW / Math.min(tl.maxZ, Math.max(1, z));
  const h = (w * CH) / CW;
  const x = Math.min(CW - w / 2, Math.max(w / 2, cx * tl.scale));
  const y = Math.min(CH - h / 2, Math.max(h / 2, cy * tl.scale));
  return [x, y, w];
};
const moves = [];
let cur = [CW / 2, CH / 2, CW];
let free = 0;
for (const sh of tl.shots.map((x) => ({ ...x, o: outTime(x.t) })).sort((a, b) => a.o - b.o)) {
  const to = clampCam(sh.cx, sh.cy, sh.z);
  const t0 = Math.max(sh.o, free);
  const d = Math.max(0.001, sh.d);
  if (to.every((v, k) => Math.abs(v - cur[k]) < 0.5)) continue;
  moves.push({ t0, d, from: cur, to });
  cur = to;
  free = t0 + d;
}
const term = (m, k) => {
  const delta = m.to[k] - m.from[k];
  if (Math.abs(delta) < 0.01) return '';
  return `+(${delta.toFixed(3)})*(st(0,clip((in/${FPS}-${m.t0.toFixed(4)})/${m.d.toFixed(4)},0,1));if(lt(ld(0),0.5),4*ld(0)^3,1-(2-2*ld(0))^3/2))`;
};
const sum = (k) => `${[CW / 2, CH / 2, CW][k]}${moves.map((m) => term(m, k)).join('')}`;
const pre = `st(1,${sum(0)});st(2,${sum(1)});st(3,${sum(2)});st(4,ld(3)*${CH}/${CW});`;
const X0 = `${pre}ld(1)-ld(3)/2`, X1 = `${pre}ld(1)+ld(3)/2`, Y0 = `${pre}ld(2)-ld(4)/2`, Y1 = `${pre}ld(2)+ld(4)/2`;
const camera = `perspective=x0='${X0}':y0='${Y0}':x1='${X1}':y1='${Y0}':x2='${X0}':y2='${Y1}':x3='${X1}':y3='${Y1}':interpolation=cubic:sense=source:eval=frame`;
writeFileSync(join(work, 'moves.json'), JSON.stringify(moves, null, 1));

/* ---------- 3. captions and the map credit, in the app's typeface ---------- */
const fontDir = join(root, 'node_modules/@fontsource-variable/atkinson-hyperlegible-next/files');
const fontServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'font/woff2', 'Access-Control-Allow-Origin': '*' });
  createReadStream(join(fontDir, req.url.includes('ext') ? 'atkinson-hyperlegible-next-latin-ext-wght-normal.woff2' : 'atkinson-hyperlegible-next-latin-wght-normal.woff2')).pipe(res);
});
await new Promise((r) => fontServer.listen(4320, r));
const browser = await chromium.launch({ executablePath: CHROME, args: ['--use-mock-keychain', '--password-store=basic'] });
const cpage = await browser.newPage({ viewport: { width: OW, height: OH }, deviceScaleFactor: 1 });
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const head = `<style>
  @font-face { font-family: A; src: url(http://localhost:4320/latin.woff2) format('woff2'); font-weight: 200 800; }
  @font-face { font-family: A; src: url(http://localhost:4320/latin-ext.woff2) format('woff2'); font-weight: 200 800; unicode-range: U+0100-024F, U+1E00-1EFF; }
  html, body { margin: 0; background: transparent; }
  .c { position: absolute; left: 0; top: 0; max-width: 1180px; font: 600 27px/36px A, sans-serif; color: #FBF8F2; background: rgba(27,26,23,.9);
       padding: 15px 28px 16px; border-radius: 14px; font-variant-numeric: tabular-nums; text-wrap: balance; text-align: center; }
  .a { position: absolute; left: 0; top: 0; font: 500 17px/22px A, sans-serif; color: #4D483F; background: rgba(251,248,242,.92);
       padding: 6px 12px; border-radius: 8px; box-shadow: 0 1px 2px rgba(27,26,23,.12); }
</style>`;
async function render(html, sel, file) {
  await cpage.setContent(`<html><head>${head}</head><body>${html}</body></html>`);
  await cpage.evaluate(() => document.fonts.ready);
  const el = cpage.locator(sel);
  await el.screenshot({ path: file, omitBackground: true });
  const b = await el.boundingBox();
  return { w: Math.round(b.width), h: Math.round(b.height) };
}
const caps = [];
for (const [i, p] of plan.entries()) {
  if (!p.s.caption) continue;
  const file = join(work, `cap${i}.png`);
  const { w, h } = await render(`<div class="c">${esc(p.s.caption)}</div>`, '.c', file);
  const a = p.outStart + Math.min(0.8, p.len * 0.15);
  const b = p.outStart + p.len - (p.cutIn || plan[i + 1]?.cutIn ? 0.45 : 0.3);
  caps.push({ file, a, b, w, h });
}
const credit = join(work, 'credit.png');
const cr = await render('<div class="a">Map data © OpenStreetMap contributors, ODbL</div>', '.a', credit);
await browser.close();
fontServer.close();
// the credit is on screen for every scene that shows the map (not the title and end cards, which carry it themselves)
const creditOn = plan.filter((p) => !p.s.card).map((p) => `between(t,${p.outStart.toFixed(3)},${(p.outStart + p.len).toFixed(3)})`).join('+');

/* ---------- 4. narration: sentences at their cued times, normalised to -16 LUFS ---------- */
const voiceIn = [];
const voiceF = [];
let vi = 0;
for (const p of plan) {
  for (const [j, l] of p.s.lines.entries()) {
    const at = Math.round((p.outStart + p.s.lead + p.s.offsets[j]) * 1000);
    voiceIn.push('-i', l.file);
    voiceF.push(`[${vi}:a]aresample=48000,aformat=channel_layouts=mono,adelay=${at}:all=1[a${vi}]`);
    vi++;
  }
}
const mix = `${voiceF.join(';')};${Array.from({ length: vi }, (_, k) => `[a${k}]`).join('')}amix=inputs=${vi}:normalize=0:duration=longest,apad=whole_dur=${total.toFixed(3)},atrim=duration=${total.toFixed(3)}`;
const rawVoice = join(work, 'voice-raw.wav');
ff([...voiceIn, '-filter_complex', mix + '[a]', '-map', '[a]', '-ar', '48000', '-c:a', 'pcm_s16le', rawVoice]);
const meas = spawnSync('ffmpeg', ['-hide_banner', '-i', rawVoice, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
const m = JSON.parse(meas.slice(meas.lastIndexOf('{'), meas.lastIndexOf('}') + 1));
const voiceWav = join(work, 'voice.wav');
ff(['-i', rawVoice, '-af', `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=48000`, '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', voiceWav]);

/* ---------- 5. picture: camera, scale, captions, credit; then the two files ---------- */
const inputs = ['-i', body, '-i', voiceWav, '-loop', '1', '-framerate', String(FPS), '-t', total.toFixed(3), '-i', credit];
const graph = [`[0:v]${camera},scale=${OW}:${OH}:flags=lanczos,setsar=1[v0]`];
graph.push(`[v0][2:v]overlay=x=${OW - 24 - cr.w}:y=${OH - 22 - cr.h}:enable='${creditOn}'[w0]`);
caps.forEach((c, k) => {
  inputs.push('-loop', '1', '-framerate', String(FPS), '-t', (c.b + 0.1).toFixed(3), '-i', c.file);
  const y0 = OH - 84 - c.h;
  graph.push(`[${k + 3}:v]format=rgba,fade=t=in:st=${c.a.toFixed(3)}:d=0.4:alpha=1,fade=t=out:st=${(c.b - 0.4).toFixed(3)}:d=0.4:alpha=1[c${k}]`);
  graph.push(`[w${k}][c${k}]overlay=x=${Math.round((OW - c.w) / 2)}:y='${y0}+14*pow(1-clip((t-${c.a.toFixed(3)})/0.5,0,1),3)':eval=frame:eof_action=pass:enable='between(t,${c.a.toFixed(3)},${c.b.toFixed(3)})'[w${k + 1}]`);
});
graph.push(`[w${caps.length}]format=yuv420p[v]`);
const graphFile = join(work, 'graph.txt');
writeFileSync(graphFile, graph.join(';\n'));
const master = join(work, 'master.mkv');
console.log('rendering camera, captions and credit');
ff([...inputs, '-/filter_complex', graphFile, '-map', '[v]', '-map', '1:a', '-c:v', 'libx264', '-crf', '8', '-preset', 'fast', '-r', String(FPS), '-c:a', 'pcm_s16le', '-t', total.toFixed(3), master]);
console.log('encoding assets/demo.mp4');
ff(['-i', master, '-c:v', 'libx264', '-crf', '17', '-preset', 'slow', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', out]);

// Upload copy under 9.5 MB: two-pass at a computed bitrate.
const LIMIT = 9.5e6;
const dur = probe(master);
const audioK = 64;
const smallH = Number(process.env.UPLOAD_HEIGHT ?? 1080);
const smallFps = Number(process.env.UPLOAD_FPS ?? 30);
const kbps = Math.floor((LIMIT * 0.95 * 8) / dur / 1000 - audioK - 4);
const common = ['-i', master, '-vf', `scale=-2:${smallH}:flags=lanczos,fps=${smallFps}`, '-c:v', 'libx264', '-preset', 'veryslow', '-b:v', `${kbps}k`, '-maxrate', `${kbps * 2}k`, '-bufsize', `${kbps * 4}k`, '-pix_fmt', 'yuv420p'];
const passlog = join(work, 'pass');
ff([...common, '-pass', '1', '-passlogfile', passlog, '-an', '-f', 'mp4', '/dev/null']);
ff([...common, '-pass', '2', '-passlogfile', passlog, '-c:a', 'aac', '-b:a', `${audioK}k`, '-ac', '2', '-movflags', '+faststart', outSmall]);
console.log(`upload copy: ${smallH}p${smallFps} at ${kbps} kb/s, ${(statSync(outSmall).size / 1e6).toFixed(2)} MB`);
if (statSync(outSmall).size >= LIMIT) throw new Error('upload copy is over the limit');

/* ---------- 6. stills from zoomed moments, for checking ---------- */
const grabs = join(work, 'grabs');
mkdirSync(grabs, { recursive: true });
for (const p of plan) {
  if (p.s.card) continue;
  // the last camera move that settles inside the scene, a beat after it lands
  const mv = moves.filter((x) => x.t0 >= p.outStart && x.t0 + x.d < p.outStart + p.len - 0.3).at(-1);
  const t = mv ? Math.min(mv.t0 + mv.d + 0.4, p.outStart + p.len - 0.2) : p.outStart + p.len / 2;
  ff(['-ss', t.toFixed(3), '-i', out, '-frames:v', '1', join(grabs, `${p.s.name}.png`)]);
}
console.log(`wrote assets/demo.mp4 ${probe(out).toFixed(1)} s, ${(statSync(out).size / 1e6).toFixed(1)} MB; stills in .cache/video/grabs`);
