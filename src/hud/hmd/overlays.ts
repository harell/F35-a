/**
 * Screen overlays: G-effect vignettes (tunnel vision / grey-out, red-out) and hit flash, centre
 * messages, radio subtitles, kill feed, objective summary, mission hint and hit markers.
 */
import { MessageQueue, type MessageTone, type Subtitle } from './feeds';
import type { HudFrame } from './frame';
import { vignetteParams } from './gEffects';
import { withAlpha, type Palette } from './palette';

/* ───────────────────────── Vignettes ───────────────────────── */

/** Pre-rendered radial gradients (small canvases scaled up: gradients are smooth anyway). */
export class Vignettes {
  readonly dark: HTMLCanvasElement | null;
  readonly red: HTMLCanvasElement | null;
  private readonly vp = { scale: 1, alpha: 0, greyAlpha: 0 };

  constructor() {
    this.dark = makeRadial([0, 0, 0], 0.34);
    this.red = makeRadial([200, 0, 0], 0.45);
  }

  draw(f: HudFrame): void {
    const g = f.pen.g;
    const { W, H, cx, cy } = f.L;
    const s = f.st.g;
    const diag = Math.hypot(W, H);
    if (s.grey > 0.01 && this.dark) {
      const v = vignetteParams(s, this.vp);
      // the image's opaque surround (beyond the gradient) always covers the whole screen: no seams
      const D = diag * v.scale * RADIAL_K;
      g.globalAlpha = v.alpha;
      g.drawImage(this.dark, cx - D / 2, cy - D / 2, D, D);
      g.globalAlpha = 1;
      if (v.greyAlpha > 0.01) {
        f.pen.setFill(withAlpha('#5a5a5a', v.greyAlpha));
        g.fillRect(0, 0, W, H);
      }
    }
    if (s.red > 0.01) {
      f.pen.setFill(withAlpha('#a00000', s.red * 0.55));
      g.fillRect(0, 0, W, H);
      if (this.red) {
        g.globalAlpha = Math.min(1, s.red * 1.2);
        const D = diag * (1.3 - 0.5 * s.red) * RADIAL_K;
        g.drawImage(this.red, cx - D / 2, cy - D / 2, D, D);
        g.globalAlpha = 1;
      }
    }
    if (s.flash > 0.01 && this.red) {
      g.globalAlpha = Math.min(1, s.flash);
      const D = diag * 1.2 * RADIAL_K;
      g.drawImage(this.red, cx - D / 2, cy - D / 2, D, D);
      g.globalAlpha = 1;
    }
  }
}

/** Radial image: SIZE px square, gradient out to RADIUS px, fully opaque beyond (covers the screen). */
const RADIAL_SIZE = 512;
const RADIAL_RADIUS = 96;
/** Image size / gradient diameter. */
const RADIAL_K = RADIAL_SIZE / (2 * RADIAL_RADIUS);

function makeRadial(rgb: [number, number, number], inner: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = RADIAL_SIZE;
  const g = c.getContext('2d');
  if (!g) return null;
  const m = RADIAL_SIZE / 2;
  const grad = g.createRadialGradient(m, m, RADIAL_RADIUS * inner, m, m, RADIAL_RADIUS);
  const [r, gg, b] = rgb;
  grad.addColorStop(0, `rgba(${r},${gg},${b},0)`);
  grad.addColorStop(0.55, `rgba(${r},${gg},${b},0.55)`);
  grad.addColorStop(0.85, `rgba(${r},${gg},${b},0.92)`);
  grad.addColorStop(1, `rgba(${r},${gg},${b},1)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, RADIAL_SIZE, RADIAL_SIZE);
  return c;
}

/* ───────────────────────── Text helpers ───────────────────────── */

export function toneColor(pal: Palette, tone: MessageTone): string {
  return tone === 'good' ? pal.good : tone === 'bad' ? pal.danger : tone === 'warn' ? pal.warn : pal.main;
}

/** Word-wrap cache: the same (text, width) always returns the same array (no per-frame allocation). */
const wrapCache = new Map<number, Map<string, string[]>>();
export function wrap(text: string, maxChars: number): string[] {
  let byText = wrapCache.get(maxChars);
  if (!byText) wrapCache.set(maxChars, (byText = new Map()));
  let lines = byText.get(text);
  if (lines) return lines;
  lines = [];
  let cur = '';
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= maxChars) cur += ' ' + word;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  if (byText.size > 100) byText.clear();
  byText.set(text, lines);
  return lines;
}

/* ───────────────────────── Centre messages ───────────────────────── */

export function drawMessages(f: HudFrame, y: number): void {
  const { pen, pal, L, st } = f;
  const u = L.u;
  const maxChars = Math.max(12, Math.floor((L.right - L.left - 40) / pen.charWidth(19)));
  for (const m of st.messages.items) {
    const a = MessageQueue.alpha(m);
    if (a <= 0.02) continue;
    const size = m.tone === 'bad' || m.tone === 'warn' ? 20 : 19;
    const col = toneColor(pal, m.tone);
    pen.g.globalAlpha = a;
    for (const line of wrap(m.text, maxChars)) {
      pen.text(line, L.cx, y, col, size);
      y += 22 * u;
    }
    pen.g.globalAlpha = 1;
  }
}

/* ───────────────────────── Radio subtitles ───────────────────────── */

let subRef: Subtitle | null = null;
let subLines: string[] = [];
let subHead = '';

export function drawRadio(f: HudFrame): void {
  const { pen, pal, L, st } = f;
  const q = st.radio;
  const s = q.current;
  if (!s) return;
  const a = q.alpha;
  if (a <= 0.02) return;
  const u = L.u;
  const size = 13;
  const cw = pen.charWidth(size);
  const maxW = Math.min(L.W * 0.66, L.thumbRX - L.thumbLX - 16 * u);
  const maxChars = Math.max(16, Math.floor(maxW / cw) - 2);
  if (s !== subRef) {
    subRef = s;
    subHead = '[' + s.from.toUpperCase() + '] ';
    subLines = wrap(subHead + s.text, maxChars);
  }
  const lh = 17 * u;
  const n = Math.min(3, subLines.length);
  let widest = 0;
  for (let i = 0; i < n; i++) widest = Math.max(widest, subLines[i].length);
  const w = widest * cw + 20 * u;
  const h = n * lh + 8 * u;
  const cx = L.cx;
  const bottom = L.radioY + lh / 2 + 4 * u;
  const top = bottom - h;
  pen.setFill(withAlpha('#000000', 0.55 * a));
  pen.roundRect(cx - w / 2, top, w, h, 7 * u);
  pen.g.fill();
  const enemy = s.team === 'red';
  const headCol = withAlpha(enemy ? pal.danger : '#8fd8ff', a);
  const bodyCol = withAlpha('#f0f6f2', a);
  pen.setFont(size);
  pen.setAlign('left', 'middle');
  const x0 = cx - w / 2 + 10 * u;
  for (let i = 0; i < n; i++) {
    const line = subLines[i];
    const y = top + 4 * u + lh * (i + 0.5);
    if (i === 0 && line.startsWith(subHead.trimEnd())) {
      const head = subHead.trimEnd();
      pen.setFill(headCol);
      pen.g.fillText(head, x0, y);
      pen.setFill(bodyCol);
      pen.g.fillText(line.slice(head.length), x0 + head.length * cw, y);
    } else {
      pen.setFill(bodyCol);
      pen.g.fillText(line, x0, y);
    }
  }
}

/* ───────────────────────── Kill feed ───────────────────────── */

export function drawKillFeed(f: HudFrame, x: number, y: number): void {
  const { pen, pal, L, st } = f;
  const u = L.u;
  for (const e of st.kills.items) {
    const a = st.kills.alpha(e);
    if (a <= 0.02) continue;
    pen.g.globalAlpha = a;
    pen.text(e.text, x, y, toneColor(pal, e.tone), 13, 'right');
    pen.g.globalAlpha = 1;
    y += 17 * u;
  }
}

/* ───────────────────────── Objectives / hint ───────────────────────── */

interface ObjLineEntry {
  label: string;
  state: string;
  done: number;
  total: number;
  maxChars: number;
  text: string;
}
/** Per-objective cached line (objective status objects are long-lived). */
const objLineCache = new WeakMap<object, ObjLineEntry>();

function objLine(o: { label: string; state: string; progress?: { done: number; total: number } }, maxChars: number): string {
  const done = o.progress?.done ?? 0;
  const total = o.progress?.total ?? 0;
  let e = objLineCache.get(o);
  if (e && e.label === o.label && e.state === o.state && e.done === done && e.total === total && e.maxChars === maxChars) return e.text;
  const mark = o.state === 'complete' ? '+ ' : o.state === 'failed' ? 'x ' : o.state === 'active' ? '> ' : '- ';
  const prog = total > 1 ? ' ' + done + '/' + total : '';
  let body = o.label.toUpperCase();
  const room = maxChars - mark.length - prog.length;
  if (body.length > room) body = body.slice(0, Math.max(4, room - 1)) + '.';
  const text = mark + body + prog;
  if (!e) objLineCache.set(o, (e = { label: o.label, state: o.state, done, total, maxChars, text }));
  else Object.assign(e, { label: o.label, state: o.state, done, total, maxChars, text });
  return text;
}

/** Compact objective summary (top-left). Returns the next free y. */
export function drawObjectives(f: HudFrame, x: number, y: number, force = false): number {
  const { pen, pal, L, st, ctx } = f;
  const objs = ctx.mission?.objectives;
  if (!objs || objs.length === 0) return y;
  const show = force ? 1 : Math.min(1, st.objShow / 0.6);
  if (show <= 0.02) return y;
  const u = L.u;
  const size = 11;
  const maxChars = Math.max(14, Math.floor(Math.min(L.W * 0.28, 250 * u) / pen.charWidth(size)));
  pen.g.globalAlpha = show;
  pen.text('OBJECTIVES', x, y, pal.dim, 10, 'left');
  y += 14 * u;
  let n = 0;
  for (const o of objs) {
    if (n >= 5) break;
    if (o.state === 'pending' && !o.primary) continue;
    const col = o.state === 'complete' ? pal.good : o.state === 'failed' ? pal.danger : o.state === 'active' ? pal.main : pal.dim;
    pen.text(objLine(o, maxChars), x, y, col, size, 'left');
    y += 14 * u;
    n++;
  }
  pen.g.globalAlpha = 1;
  return y + 4 * u;
}

export function drawHint(f: HudFrame, y: number): void {
  const hint = f.ctx.mission?.hint;
  if (!hint || !f.ctx.settings.hints) return;
  const { pen, pal, L, st } = f;
  const u = L.u;
  const size = 12.5;
  // centred; narrower while the objective summary (top-left) is showing
  const side = st.objShow > 0 ? Math.min(L.W * 0.28, 250 * u) : Math.max(0, L.cx - L.tapeHalfW - L.left) * 0.4;
  const maxW = Math.min(L.W * 0.6, 520 * u, L.right - L.left - 2 * side - 20 * u);
  const maxChars = Math.max(20, Math.floor(maxW / pen.charWidth(size)) - 2);
  const lines = wrap(hint, maxChars);
  for (let i = 0; i < Math.min(3, lines.length); i++) {
    pen.pillText(lines[i], L.cx, y + i * 20 * u, pal.main, size, 'rgba(0,12,6,0.55)', 'center', 9 * u, 4 * u);
  }
}

/* ───────────────────────── Hit markers ───────────────────────── */

export function drawHitMarkers(f: HudFrame): void {
  const { pen, pal, L, st, world, proj } = f;
  const u = L.u;
  for (const h of st.hits) {
    if (!h.active) continue;
    const e = world.getEntity(h.id);
    if (e && proj.point(e.position, f.sp) && f.sp.onScreen) {
      h.x = f.sp.x;
      h.y = f.sp.y;
    }
    if (!Number.isFinite(h.x)) {
      h.x = L.cx;
      h.y = L.cy;
    }
    const life = h.kill ? 0.9 : 0.45;
    const a = Math.max(0, 1 - h.age / life);
    const gap = (h.kill ? 9 : 6) * u + h.age * 20 * u;
    const len = (h.kill ? 11 : 8) * u;
    const col = h.kill ? pal.danger : pal.white;
    pen.setDash('solid');
    pen.begin();
    for (let sx = -1; sx <= 1; sx += 2) {
      for (let sy = -1; sy <= 1; sy += 2) {
        pen.line(h.x + sx * gap, h.y + sy * gap, h.x + sx * (gap + len), h.y + sy * (gap + len));
      }
    }
    pen.g.globalAlpha = a;
    pen.strokeGlow(col, h.kill ? 2.6 : 2);
    pen.g.globalAlpha = 1;
  }
}

