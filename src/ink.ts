// The two inks, drawn on a canvas over the map. Every street segment fills at its real
// computed arrival time: the animation is the routing result played back.

import * as maplibregl from 'maplibre-gl';
import type { SnappedPoi } from './engine/graph.ts';
import type { BarrierInfo, Geo, ReachResult } from './protocol.ts';

const C = {
  walk: 'rgba(31,79,163,0.30)',
  walkEdge: 'rgba(31,79,163,0.55)',
  wheel: '#E4572E',
  ink: '#1B1A17',
  ink2: '#4D483F',
  paper: '#FBF8F2',
  walkSolid: '#1F4FA3',
};

const easeOutCubic = (p: number) => 1 - (1 - p) ** 3;
const easeOutQuad = (p: number) => 1 - (1 - p) ** 2;

export interface InkFrame {
  /** travel seconds shown */
  T: number;
  walkLen: number;
  wcLen: number;
  done: boolean;
  /** set while a fix is playing */
  fixLen?: number;
}

interface Mark {
  barrier: number;
  x: number; // mercator
  y: number;
  dx: number; // unit direction of the street, screen-aligned in mercator space
  dy: number;
  at: number; // wheelchair arrival seconds at the mark
  rank: number; // 1..3 for the top fixes, 0 otherwise
}

export class Ink {
  private ctx: CanvasRenderingContext2D;
  private geo: Geo | null = null;
  private barriers: BarrierInfo[] = [];
  private pois: SnappedPoi[] = [];
  private mx = new Float64Array(0);
  private my = new Float64Array(0);
  private sx = new Float32Array(0);
  private sy = new Float32Array(0);
  private res: ReachResult | null = null;
  private walkEdges: Uint32Array = new Uint32Array(0);
  private wcEdges: Uint32Array = new Uint32Array(0);
  private fixEdges: Uint32Array = new Uint32Array(0);
  private marks: Mark[] = [];
  private pulses = new Map<number, number>(); // barrier -> real ms start
  private T = 0;
  private fixIdx = -1;
  private fixT = 0;
  private fixT0 = 0;
  private liftStart = 0;
  /** places that the chosen fix brings within reach: poi index -> real ms when the ink got there */
  private pops = new Map<number, number>();
  private pinX = NaN;
  private pinY = NaN;
  private raf = 0;
  /** one pending redraw while pulses, ripples and pops finish after the clock has stopped */
  private settle = 0;
  private reduced = matchMedia('(prefers-reduced-motion: reduce)');
  onFrame: (f: InkFrame) => void = () => {};

  constructor(private map: maplibregl.Map, private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    const resize = () => {
      const r = map.getContainer().getBoundingClientRect();
      const dpr = Math.min(2, devicePixelRatio || 1);
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.draw();
    };
    new ResizeObserver(resize).observe(map.getContainer());
    map.on('move', () => this.draw());
    resize();
  }

  /** where the mark of a barrier sits, as [lng, lat], or null when it is not drawn */
  markLngLat(barrier: number): [number, number] | null {
    const m = this.marks.find((k) => k.barrier === barrier);
    if (!m) return null;
    const ll = new maplibregl.MercatorCoordinate(m.x, m.y).toLngLat();
    return [ll.lng, ll.lat];
  }

  get playing() {
    return this.raf !== 0;
  }

  /** where the pin stands, so rank badges can keep clear of it */
  setPin(lng: number, lat: number) {
    const c = maplibregl.MercatorCoordinate.fromLngLat([lng, lat]);
    this.pinX = c.x;
    this.pinY = c.y;
  }

  private redrawSoon() {
    if (this.raf || this.settle) return;
    this.settle = requestAnimationFrame(() => {
      this.settle = 0;
      this.draw();
    });
  }

  setGeo(geo: Geo, barriers: BarrierInfo[], pois: SnappedPoi[]) {
    this.geo = geo;
    this.barriers = barriers;
    this.pois = pois;
    this.mx = new Float64Array(geo.n);
    this.my = new Float64Array(geo.n);
    this.sx = new Float32Array(geo.n);
    this.sy = new Float32Array(geo.n);
    for (let v = 0; v < geo.n; v++) {
      const c = maplibregl.MercatorCoordinate.fromLngLat([geo.lon[v], geo.lat[v]]);
      this.mx[v] = c.x;
      this.my[v] = c.y;
    }
    this.clear();
  }

  clear() {
    this.stop();
    this.res = null;
    this.marks = [];
    this.fixIdx = -1;
    this.draw();
  }

  private stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  setResult(res: ReachResult) {
    const g = this.geo!;
    this.stop();
    this.res = res;
    this.fixIdx = -1;
    const B = res.budget;
    const pick = (arr: Float32Array) => {
      const out: number[] = [];
      for (let e = 0; e < g.m; e++) if (arr[g.ea[e]] <= B || arr[g.eb[e]] <= B) out.push(e);
      return Uint32Array.from(out);
    };
    this.walkEdges = pick(res.walk);
    this.wcEdges = pick(res.wc);
    this.marks = this.computeMarks(res);
    this.pulses.clear();
    this.pops.clear();
  }

  private computeMarks(res: ReachResult): Mark[] {
    const g = this.geo!;
    const B = res.budget;
    const rankOf = new Map(res.fixes.map((f, i) => [f.barrier, i + 1]));
    const marks: Mark[] = [];
    for (const b of res.frontier) {
      const info = this.barriers[b];
      let best = -1, bestT = Infinity, other = -1;
      if (info.node >= 0) {
        // nearest reached neighbour of a node barrier
        for (let e = 0; e < g.m; e++) {
          // node barriers are rare; scan only their incident edges
          if (g.ea[e] !== info.node && g.eb[e] !== info.node) continue;
          const w = g.ea[e] === info.node ? g.eb[e] : g.ea[e];
          if (res.wc[w] < bestT) { bestT = res.wc[w]; best = info.node; other = w; }
        }
        if (best < 0) continue;
        const dx = this.mx[best] - this.mx[other], dy = this.my[best] - this.my[other];
        const l = Math.hypot(dx, dy) || 1;
        marks.push({ barrier: b, x: this.mx[best], y: this.my[best], dx: dx / l, dy: dy / l, at: bestT, rank: rankOf.get(b) ?? 0 });
      } else {
        for (const e of info.edges) {
          for (const [v, w] of [[g.ea[e], g.eb[e]], [g.eb[e], g.ea[e]]]) {
            if (res.wc[v] <= B && res.wc[v] < bestT) { bestT = res.wc[v]; best = v; other = w; }
          }
        }
        if (best < 0) continue;
        const dx = this.mx[other] - this.mx[best], dy = this.my[other] - this.my[best];
        const l = Math.hypot(dx, dy) || 1;
        // sit the mark a few metres into the barrier so it reads as "here it stops"
        const ux = dx / l, uy = dy / l;
        const step = Math.min(l * 0.35, 3 / 40075016);
        marks.push({ barrier: b, x: this.mx[best] + ux * step, y: this.my[best] + uy * step, dx: ux, dy: uy, at: bestT, rank: rankOf.get(b) ?? 0 });
      }
    }
    return marks;
  }

  /** Play the spread from nothing to the full budget. */
  play() {
    if (!this.res) return;
    this.stop();
    const B = this.res.budget;
    if (this.reduced.matches) {
      this.T = B;
      this.draw();
      this.canvas.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: 'ease-out' });
      return;
    }
    const dur = 1600 + 1000 * Math.sqrt(B / 600);
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      const prev = this.T;
      this.T = B * easeOutQuad(p);
      for (const m of this.marks) if (m.at > prev && m.at <= this.T) this.pulses.set(m.barrier, now);
      this.draw(now);
      if (p < 1) this.raf = requestAnimationFrame(tick);
      else { this.raf = 0; this.draw(now); }
    };
    this.T = 0;
    this.raf = requestAnimationFrame(tick);
  }

  /** Show the result of fixing top-fix i: the barrier lifts and the ink runs on. */
  playFix(i: number) {
    const res = this.res;
    if (!res) return;
    const fix = res.fixes[i];
    if (!fix) return;
    this.stop();
    const g = this.geo!;
    const B = res.budget;
    this.T = B;
    this.fixIdx = i;
    const out: number[] = [];
    for (let e = 0; e < g.m; e++) if (fix.arr[g.ea[e]] <= B || fix.arr[g.eb[e]] <= B) out.push(e);
    this.fixEdges = Uint32Array.from(out);
    const mark = this.marks.find((m) => m.barrier === fix.barrier);
    this.fixT0 = mark ? mark.at : 0;
    this.pops.clear();
    if (this.reduced.matches) {
      this.fixT = B;
      this.liftStart = -1e9;
      this.draw();
      return;
    }
    const dur = 1800;
    const t0 = performance.now();
    this.liftStart = t0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      const prevT = this.fixT;
      this.fixT = this.fixT0 + (B - this.fixT0) * easeOutCubic(p);
      // places the fix brings within reach pop as the ink arrives at them
      for (let k = 0; k < this.pois.length; k++) {
        const at = this.pois[k].at;
        if (at < 0 || !(res.walk[at] <= B) || res.wc[at] <= B) continue;
        const t = fix.arr[at];
        if (t > prevT && t <= this.fixT) this.pops.set(k, now);
      }
      this.draw(now);
      if (p < 1) this.raf = requestAnimationFrame(tick);
      else { this.raf = 0; this.draw(now); }
    };
    this.fixT = this.fixT0;
    this.raf = requestAnimationFrame(tick);
  }

  clearFix() {
    this.stop();
    this.fixIdx = -1;
    this.pops.clear();
    this.draw();
  }

  /** Jump to the end state (used when a new interaction interrupts). */
  finish() {
    if (!this.res) return;
    this.stop();
    this.T = this.res.budget;
    if (this.fixIdx >= 0) this.fixT = this.res.budget;
    this.draw();
  }

  private project() {
    const g = this.geo!;
    const z = this.map.getZoom();
    const scale = 512 * 2 ** z;
    const center = this.map.getCenter();
    const c = maplibregl.MercatorCoordinate.fromLngLat(center);
    // the map centre sits inside the padded viewport, not at the canvas centre
    const pc = this.map.project(center);
    const w = pc.x, h = pc.y;
    for (let v = 0; v < g.n; v++) {
      this.sx[v] = (this.mx[v] - c.x) * scale + w;
      this.sy[v] = (this.my[v] - c.y) * scale + h;
    }
    return { scale, cx: c.x, cy: c.y, w, h, z };
  }

  /**
   * Add covered parts of `edges` at time T to `path` (and `alt` for unverified edges when given).
   * Returns metres covered.
   */
  private trace(
    edges: Uint32Array, arr: Float32Array, T: number, ab: Float32Array, ba: Float32Array,
    path: Path2D, alt?: Path2D, open = -1,
  ): number {
    const g = this.geo!;
    const { sx, sy } = this;
    let total = 0;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const a = g.ea[e], b = g.eb[e];
      const ta = arr[a], tb = arr[b];
      let fa = 0, fb = 0;
      if (ta <= T) {
        const d = open >= 0 && g.edgeBarrier[e] === open ? g.fixAB[e] : ab[e];
        if (d < Infinity) fa = d > 0 ? Math.min(1, (T - ta) / d) : 1;
      }
      if (tb <= T) {
        const d = open >= 0 && g.edgeBarrier[e] === open ? g.fixBA[e] : ba[e];
        if (d < Infinity) fb = d > 0 ? Math.min(1, (T - tb) / d) : 1;
      }
      if (fa <= 0 && fb <= 0) continue;
      const p = alt && g.unverified[e] ? alt : path;
      if (fa + fb >= 1) {
        p.moveTo(sx[a], sy[a]);
        p.lineTo(sx[b], sy[b]);
        total += g.len[e];
      } else {
        if (fa > 0) {
          p.moveTo(sx[a], sy[a]);
          p.lineTo(sx[a] + (sx[b] - sx[a]) * fa, sy[a] + (sy[b] - sy[a]) * fa);
        }
        if (fb > 0) {
          p.moveTo(sx[b], sy[b]);
          p.lineTo(sx[b] + (sx[a] - sx[b]) * fb, sy[b] + (sy[a] - sy[b]) * fb);
        }
        total += (fa + fb) * g.len[e];
      }
    }
    return total;
  }

  draw(now = performance.now()) {
    const ctx = this.ctx;
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    ctx.clearRect(0, 0, W, H);
    const res = this.res;
    const g = this.geo;
    if (!res || !g) return;
    const view = this.project();
    const k = 2 ** (view.z - 16);
    const walkW = Math.max(4, Math.min(24, 10 * k));
    const wcW = Math.max(2.2, Math.min(8, 4 * k));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // walking band
    const walkPath = new Path2D();
    const walkLen = this.trace(this.walkEdges, res.walk, this.T, g.walkAB, g.walkBA, walkPath);
    ctx.strokeStyle = C.walk;
    ctx.lineWidth = walkW;
    ctx.stroke(walkPath);

    // wheelchair line: solid where the map confirms it, dashed where it does not say
    const solid = new Path2D(), dashed = new Path2D();
    const wcLen = this.trace(this.wcEdges, res.wc, this.T, g.wcAB, g.wcBA, solid, dashed);
    let fixLen: number | undefined;
    const fix = this.fixIdx >= 0 ? res.fixes[this.fixIdx] : null;
    if (fix) {
      fixLen = this.trace(this.fixEdges, fix.arr, this.fixT, g.wcAB, g.wcBA, solid, dashed, fix.barrier);
    }
    // paper casing keeps the orange line crisp over the blue band
    ctx.strokeStyle = 'rgba(251,248,242,0.85)';
    ctx.lineWidth = wcW + 2.5;
    ctx.setLineDash([]);
    ctx.stroke(solid);
    ctx.stroke(dashed);
    ctx.strokeStyle = C.wheel;
    ctx.lineWidth = wcW;
    ctx.stroke(solid);
    ctx.setLineDash([wcW * 2.2, wcW * 1.8]);
    ctx.lineCap = 'butt';
    ctx.stroke(dashed);
    ctx.setLineDash([]);
    ctx.lineCap = 'round';

    this.drawPois(res, fix ? fix.arr : null, view);
    this.drawMarks(res, now, walkW, view);

    this.onFrame({
      T: this.T, walkLen, wcLen, fixLen,
      done: !this.raf,
    });
  }

  private toScreen(x: number, y: number, v: { scale: number; cx: number; cy: number; w: number; h: number }) {
    return [(x - v.cx) * v.scale + v.w, (y - v.cy) * v.scale + v.h] as const;
  }

  private drawMarks(res: ReachResult, now: number, walkW: number, view: { scale: number; cx: number; cy: number; w: number; h: number; z: number }) {
    const ctx = this.ctx;
    const fix = this.fixIdx >= 0 ? res.fixes[this.fixIdx] : null;
    const baseHalf = Math.max(4, Math.min(12, walkW * 0.75));
    const baseW = view.z >= 15.5 ? 3 : 2;
    // the pin's body, so the rank badges never hide under it
    const [pinX, pinY] = Number.isNaN(this.pinX) ? [NaN, NaN] : this.toScreen(this.pinX, this.pinY, view);
    const pinBodyY = pinY - 17;
    // ranked marks last, so the actionable ones sit on top
    const order = [...this.marks].sort((a, b) => (a.rank ? 4 - a.rank : 0) - (b.rank ? 4 - b.rank : 0));
    for (const m of order) {
      if (m.at > this.T) continue;
      const [x, y] = this.toScreen(m.x, m.y, view);
      const px = -m.dy, py = m.dx; // perpendicular
      const ranked = m.rank > 0;
      const half = ranked ? baseHalf * 1.2 : baseHalf;
      const markW = ranked ? baseW + 1 : baseW;
      let alpha = 1, s = 1;
      if (fix && fix.barrier === m.barrier) {
        const p = Math.min(1, (now - this.liftStart) / 360);
        alpha = 1 - p;
        s = 1 + 0.6 * easeOutCubic(p);
        // the barrier gives way: one vermilion ring runs out from where it stood
        const q = (now - this.liftStart) / 900;
        if (q < 1 && !this.reduced.matches) {
          ctx.beginPath();
          ctx.arc(x, y, 8 + 46 * easeOutCubic(q), 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(228,87,46,${0.75 * (1 - q)})`;
          ctx.lineWidth = 3;
          ctx.stroke();
          this.redrawSoon();
        }
        if (alpha <= 0) continue;
      }
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(x, y);
      ctx.scale(s, s);
      const kind = this.barriers[m.barrier].kind;
      const bars = kind === 'steps' ? [-markW * 0.9, markW * 0.9] : [0];
      for (const pass of [0, 1]) {
        ctx.strokeStyle = pass === 0 ? C.paper : ranked ? C.ink : C.ink2;
        ctx.lineWidth = pass === 0 ? markW + 3.5 : markW;
        ctx.lineCap = 'butt';
        for (const o of bars) {
          ctx.beginPath();
          ctx.moveTo(px * -half + m.dx * o, py * -half + m.dy * o);
          ctx.lineTo(px * half + m.dx * o, py * half + m.dy * o);
          ctx.stroke();
        }
      }
      ctx.restore();

      // one pulse when the ink reaches it
      const ps = this.pulses.get(m.barrier);
      if (ps !== undefined && !this.reduced.matches) {
        const p = (now - ps) / 700;
        if (p < 1) {
          ctx.beginPath();
          ctx.arc(x, y, 6 + 20 * easeOutCubic(p), 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(27,26,23,${0.55 * (1 - p)})`;
          ctx.lineWidth = 2;
          ctx.stroke();
          this.redrawSoon();
        }
      }

      if (ranked && alpha > 0) {
        // badge on the side away from the pin, pushed further out if the pin is still in the way
        let side = 1;
        const clearOf = (sd: number, d: number) => Math.hypot(x + px * sd * d - pinX, y + py * sd * d - pinBodyY);
        let d = half + 14;
        if (!Number.isNaN(pinX)) {
          side = clearOf(1, d) >= clearOf(-1, d) ? 1 : -1;
          while (clearOf(side, d) < 30 && d < half + 64) d += 4;
        }
        const ux = px * side, uy = py * side;
        const bx = x + ux * d, by = y + uy * d;
        ctx.save();
        ctx.globalAlpha = alpha;
        // leader from the mark to its badge, so the number belongs to this barrier
        ctx.lineCap = 'round';
        for (const pass of [0, 1]) {
          ctx.beginPath();
          ctx.moveTo(x + ux * (half + 1), y + uy * (half + 1));
          ctx.lineTo(bx - ux * 10, by - uy * 10);
          ctx.strokeStyle = pass === 0 ? C.paper : C.ink;
          ctx.lineWidth = pass === 0 ? 4 : 1.5;
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.arc(bx, by, 11, 0, Math.PI * 2);
        ctx.fillStyle = C.ink;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = C.paper;
        ctx.stroke();
        ctx.fillStyle = C.paper;
        ctx.font = '700 13px "Atkinson Hyperlegible Next Variable", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(m.rank), bx, by + 0.5);
        ctx.restore();
      }
    }
  }

  private drawPois(res: ReachResult, fixArr: Float32Array | null, view: { scale: number; cx: number; cy: number; w: number; h: number; z: number }) {
    const ctx = this.ctx;
    const B = res.budget;
    const r = view.z >= 16 ? 7 : view.z >= 15 ? 5.5 : 4.5;
    const now = performance.now();
    for (let k = 0; k < this.pois.length; k++) {
      const p = this.pois[k];
      if (p.at < 0) continue;
      const tw = res.walk[p.at];
      if (!(tw <= B) || tw > this.T) continue;
      const wcReached = res.wc[p.at] <= this.T || (fixArr !== null && fixArr[p.at] <= this.fixT);
      const c = maplibregl.MercatorCoordinate.fromLngLat([p.lon, p.lat]);
      const [x, y] = this.toScreen(c.x, c.y, view);
      ctx.save();
      ctx.translate(x, y);
      // a place the fix brings within reach is stamped in: it lands large and settles
      const popAt = this.pops.get(k);
      if (popAt !== undefined && !this.reduced.matches) {
        const q = (now - popAt) / 420;
        if (q < 1) {
          const sc = 1 + 0.6 * (1 - easeOutCubic(q));
          ctx.scale(sc, sc);
          this.redrawSoon();
        }
      }
      ctx.beginPath();
      if (p.cat === 'school') ctx.rect(-r, -r, 2 * r, 2 * r);
      else if (p.cat === 'health') ctx.arc(0, 0, r + 0.5, 0, Math.PI * 2);
      else { ctx.moveTo(0, -r - 1.5); ctx.lineTo(r + 1.5, 0); ctx.lineTo(0, r + 1.5); ctx.lineTo(-r - 1.5, 0); ctx.closePath(); }
      ctx.fillStyle = wcReached ? C.wheel : C.paper;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = wcReached ? C.ink : C.walkSolid;
      ctx.stroke();
      if (p.cat === 'health') {
        ctx.beginPath();
        ctx.moveTo(-r * 0.5, 0); ctx.lineTo(r * 0.5, 0);
        ctx.moveTo(0, -r * 0.5); ctx.lineTo(0, r * 0.5);
        ctx.strokeStyle = wcReached ? C.paper : C.walkSolid;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.restore();
    }
  }
}
