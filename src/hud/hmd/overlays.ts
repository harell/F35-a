/**
 * Screen overlays: G-effect vignettes (tunnel vision / grey-out, red-out) and hit flash, the centre
 * message slot, radio subtitles (paged), kill feed, objective summary, mission hint and hit markers.
 */
import { MessageQueue, RADIO_PAGE_LINES, type MessageTone, type Subtitle } from './feeds';
import type { HudFrame } from './frame';
import { RADIO_FONT, RADIO_LINE } from './layout';
import { vignetteParams } from './gEffects';
import { withAlpha, type Palette } from './palette';
import { altColumnBottom, bandExt, dlzShown, hitsWarningBand } from './zones';

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

/**
 * Wrap to at most `maxLines` lines WITHOUT cutting a word: if the text still does not fit, the last
 * line ends at a word boundary with an ellipsis. Cached like wrap().
 */
const fitCache = new Map<number, Map<string, string[]>>();
export function wrapFit(text: string, maxChars: number, maxLines: number): string[] {
  const key = maxChars * 16 + maxLines;
  let byText = fitCache.get(key);
  if (!byText) fitCache.set(key, (byText = new Map()));
  let lines = byText.get(text);
  if (lines) return lines;
  const all = wrap(text, maxChars);
  if (all.length <= maxLines) lines = all;
  else {
    lines = all.slice(0, maxLines);
    let last = lines[maxLines - 1];
    while (last.length + 1 > maxChars && last.includes(' ')) last = last.slice(0, last.lastIndexOf(' '));
    lines[maxLines - 1] = last + '…';
  }
  if (byText.size > 100) byText.clear();
  byText.set(text, lines);
  return lines;
}

/* ───────────────────────── Centre message slot ───────────────────────── */

/** Placement of the centre message for this frame (reserveMessage → drawMessages). */
const msgPlan = { active: false, top: 0, lh: 0, size: 17, lines: [] as string[], alpha: 1, tone: 'info' as MessageTone };

/**
 * Reserve the centre message's spot: its fixed slot below the flight path marker (above the jet in
 * external views), moved only as far as needed to stay off the protected symbols (FPM, target box,
 * pipper, the jet). Call right after the protected symbols so secondary labels make way for it.
 */
export function reserveMessage(f: HudFrame, yPref: number, yMin = yPref - 8 * f.L.u, yMax = f.L.msgFloor): void {
  const { pen, L, st, occ } = f;
  msgPlan.active = false;
  const m = st.messages.current;
  if (!m) return;
  const a = MessageQueue.alpha(m) * f.declutter;
  if (a <= 0.02) return;
  const u = L.u;
  // (external views: centred between the top-left column and the radar inset / kill feed)
  const band =
    f.mode === 'hmd'
      ? Math.max(200 * u, L.altLeft - L.spdRight - 16 * u)
      : Math.max(220 * u, Math.min(L.W * 0.6, 460 * u, 2 * (L.cx - (L.colX + L.colW) - 10 * u), 2 * (L.insetCx - L.insetR - L.cx - 10 * u)));
  let size = m.tone === 'bad' || m.tone === 'warn' ? 18 : 17;
  let lines = wrap(m.text, Math.max(10, Math.floor(band / pen.charWidth(size))));
  if (lines.length > 2) {
    size = 14;
    lines = wrapFit(m.text, Math.max(10, Math.floor(band / pen.charWidth(size))), 2);
  }
  const lh = (size + 3) * u;
  const h = lines.length * lh;
  let widest = 0;
  for (const l of lines) widest = Math.max(widest, l.length);
  const hw = (widest * pen.charWidth(size)) / 2 + 4 * u;
  const top0 = yPref - lh / 2;
  let top = occ.freeY(L.cx - hw, L.cx + hw, h, top0, yMin - lh / 2, Math.max(yMax, top0 + h), 'down');
  const alpha = a;
  // slot band jammed (target box / pipper right under it): search the whole centre column between the
  // warning band and the floor; with no free spot at all the message waits (never printed over the
  // target box, never see-through)
  if (!Number.isFinite(top)) top = occ.freeY(L.cx - hw, L.cx + hw, h, top0, L.top + 24 * u, Math.max(L.msgFloor, L.top + 24 * u + h), 'up');
  if (!Number.isFinite(top)) return;
  occ.add(L.cx - hw, top, L.cx + hw, top + h);
  msgPlan.active = true;
  msgPlan.top = top;
  msgPlan.lh = lh;
  msgPlan.size = size;
  msgPlan.lines = lines;
  msgPlan.alpha = alpha;
  msgPlan.tone = m.tone;
}

/** No centre message this frame (held back / PCD zoom open). */
export function clearMessagePlan(): void {
  msgPlan.active = false;
}

/** Draw the reserved centre message (call reserveMessage first). */
export function drawMessages(f: HudFrame): void {
  if (!msgPlan.active) return;
  const { pen, pal, L } = f;
  const col = toneColor(pal, msgPlan.tone);
  pen.g.globalAlpha = msgPlan.alpha;
  let y = msgPlan.top + msgPlan.lh / 2;
  for (const line of msgPlan.lines) {
    pen.text(line, L.cx, y, col, msgPlan.size);
    y += msgPlan.lh;
  }
  pen.g.globalAlpha = 1;
}

/* ───────────────────────── Radio subtitles ───────────────────────── */

let subRef: Subtitle | null = null;
let subChars = 0;
let subLines: string[] = [];
let subHead = '';
let subWidest = 0;

/** Radio pill placement for this frame (reserveRadio → drawRadio). */
const radioPlan = { active: false, x: 0, top: 0, w: 0, h: 0, first: 0, n: 0, pages: 1, page: 0 };

/**
 * Lay out the radio subtitle pill (2 lines per page; long calls are paged via RadioQueue.setPages,
 * never truncated) and reserve its rectangle so conformal labels make way for it. Bottom centre in the
 * free band between the touch clusters; top centre (under the heading tape) in the cockpit view so the
 * panoramic cockpit display stays clear.
 */
export function reserveRadio(f: HudFrame): void {
  const { pen, L, st, occ } = f;
  radioPlan.active = false;
  const q = st.radio;
  const s = q.current;
  if (!s) return;
  const u = L.u;
  const cw = pen.charWidth(RADIO_FONT);
  const maxW = Math.max(160 * u, L.radioX1 - L.radioX0);
  // (room at the right end for the page counter)
  const maxChars = Math.max(18, Math.floor((maxW - 38 * u) / cw));
  if (s !== subRef || maxChars !== subChars) {
    subRef = s;
    subChars = maxChars;
    subHead = '[' + s.from.toUpperCase() + '] ';
    subLines = wrap(subHead + s.text, maxChars);
    subWidest = 0;
    for (const l of subLines) subWidest = Math.max(subWidest, l.length);
  }
  const perPage = L.radioLines || RADIO_PAGE_LINES;
  const pages = Math.max(1, Math.ceil(subLines.length / perPage));
  q.setPages(pages);
  if (q.alpha <= 0.02) return;
  const page = q.page;
  const first = page * perPage;
  const n = Math.min(perPage, subLines.length - first);
  if (n <= 0) return;
  const rows = Math.min(perPage, subLines.length);
  const w = Math.min(maxW, subWidest * cw + (pages > 1 ? 38 : 22) * u);
  const h = rows * RADIO_LINE * u + 8 * u;
  // centred on the screen when it fits the band, else as close to the centre as the band allows
  // (cockpit view: left-aligned at the top of the left column, clear of the warning band)
  const cx = L.radioTop ? L.radioX0 + w / 2 : Math.max(L.radioX0 + w / 2, Math.min(L.radioX1 - w / 2, L.cx));
  radioPlan.active = true;
  radioPlan.x = cx - w / 2;
  radioPlan.top = L.radioTop ? L.radioY : L.radioY - h;
  radioPlan.w = w;
  radioPlan.h = h;
  radioPlan.first = first;
  radioPlan.n = n;
  radioPlan.pages = pages;
  radioPlan.page = page;
  occ.add(radioPlan.x, radioPlan.top, radioPlan.x + w, radioPlan.top + h);
}

/**
 * Top of the free part of the top-left column: below the radio pill when it lives there (cockpit
 * view), else the layout's column top.
 */
export function radioColumnBottom(f: HudFrame): number {
  const L = f.L;
  return radioPlan.active && L.radioTop ? Math.max(L.colY, radioPlan.top + radioPlan.h + 12 * L.u) : L.colY;
}

/** Draw the reserved radio pill (see reserveRadio). */
export function drawRadio(f: HudFrame): void {
  const { pen, pal, L, st, occ } = f;
  const s = st.radio.current;
  if (!radioPlan.active || !s) return;
  const u = L.u;
  const { x: px, top, w, h, first, n, pages, page } = radioPlan;
  const cw = pen.charWidth(RADIO_FONT);
  const lh = RADIO_LINE * u;
  // translucent while it would cover the target box / pipper
  const k = occ.hits(px, top, px + w, top + h, 1) ? 0.45 : 1;
  const alpha = st.radio.alpha * k;
  pen.setFill(withAlpha('#000000', 0.55 * alpha));
  pen.roundRect(px, top, w, h, 7 * u);
  pen.g.fill();
  const enemy = s.team === 'red';
  const headCol = withAlpha(enemy ? pal.danger : '#8fd8ff', alpha);
  const bodyCol = withAlpha('#f0f6f2', alpha);
  pen.setFont(RADIO_FONT);
  pen.setAlign('left', 'middle');
  const x0 = px + 11 * u;
  const head = subHead.trimEnd();
  for (let i = 0; i < n; i++) {
    const line = subLines[first + i];
    const y = top + 4 * u + lh * (i + 0.5);
    if (first + i === 0 && line.startsWith(head)) {
      pen.setFill(headCol);
      pen.g.fillText(head, x0, y);
      pen.setFill(bodyCol);
      pen.g.fillText(line.slice(head.length), x0 + head.length * cw, y);
    } else {
      pen.setFill(bodyCol);
      pen.g.fillText(line, x0, y);
    }
  }
  if (pages > 1) {
    pen.setAlign('right', 'middle');
    pen.setFont(9);
    pen.setFill(withAlpha('#8fd8ff', alpha));
    pen.g.fillText(pageLabel(page, pages), px + w - 5 * u, top + h - 6 * u);
  }
}
/** "2/3" page labels (cached, no per-frame string building). */
const pageLabels: string[][] = [];
function pageLabel(page: number, pages: number): string {
  const n = Math.min(20, pages);
  let row = pageLabels[n];
  if (!row) row = pageLabels[n] = Array.from({ length: n }, (_, i) => i + 1 + '/' + n);
  return row[Math.max(0, Math.min(n - 1, page))];
}

/* ───────────────────────── Kill feed ───────────────────────── */

/** Where the kill feed was drawn this frame: its right edge (NaN = nothing drawn). */
export const killFeedAt = { x: NaN };

/**
 * Is [x0, x1] × [y0, y1] free for a kill-feed line that had to leave its slot: off the warning band, the
 * protected symbols (FPM, target box, pipper), the HMD altitude column and the DLZ scale?
 */
function killSpotFree(f: HudFrame, x0: number, y0: number, x1: number, y1: number): boolean {
  const { L, occ } = f;
  const u = L.u;
  if (hitsWarningBand(x0, y0, x1, y1) || occ.hits(x0, y0, x1, y1, 1)) return false;
  if (f.mode === 'hmd' && x0 < L.altLeft + 92 * u && x1 > L.altLeft - 3 * u && y1 > L.boxY - 13 * u && y0 < altColumnBottom(f)) return false;
  return !(dlzShown(f) && x0 < L.dlzX + 62 * u && x1 > L.dlzX - 10 * u && y0 < L.dlzBottom + 18 * u && y1 > L.dlzTop - 18 * u);
}

/**
 * Kill feed (max 3 lines, newest first), right aligned at (x, y). Returns the next free y.
 *
 * It never prints on the warning band drawn this frame (playtest 1.2-a: under the target camera window
 * it ran into the MISSILE line and the SPIKE / FLARES LOW chips during a missile defence). Blocked, it
 * moves right to `xAlt` (the right edge, under the window) when that is free (no DLZ scale there), else
 * down under the band with the newest lines that fit; with no room at all it holds back while the
 * warnings are up — they outrank it.
 */
export function drawKillFeed(f: HudFrame, x: number, y: number, xAlt = x): number {
  const { pen, pal, L, st } = f;
  const u = L.u;
  killFeedAt.x = NaN;
  let n = 0;
  let w = 0;
  for (const e of st.kills.items) {
    if (st.kills.alpha(e) * (0.4 + 0.6 * f.declutter) <= 0.02) continue;
    n++;
    w = Math.max(w, pen.textWidth(e.text, 13));
  }
  if (n === 0) return y;
  const hh = 9 * u;
  const dy = 17 * u;
  if (hitsWarningBand(x - w, y - hh, x, y + (n - 1) * dy + hh)) {
    if (xAlt > x && killSpotFree(f, xAlt - w, y - hh, xAlt, y + (n - 1) * dy + hh)) x = xAlt;
    else {
      // under the band rows this column crosses
      const b = bandExt;
      let yb = y;
      if (x - w < b.r1x1 && x > b.r1x0) yb = Math.max(yb, b.r1y1 + hh + 2 * u);
      if (x - w < b.chx1 && x > b.chx0) yb = Math.max(yb, b.chy1 + hh + 2 * u);
      let k = 0;
      while (k < n && killSpotFree(f, x - w, yb + k * dy - hh, x, yb + k * dy + hh)) k++;
      if (k === 0) return y;
      n = k;
      y = yb;
    }
  }
  killFeedAt.x = x;
  for (const e of st.kills.items) {
    if (n === 0) break;
    const a = st.kills.alpha(e) * (0.4 + 0.6 * f.declutter);
    if (a <= 0.02) continue;
    pen.g.globalAlpha = a;
    pen.text(e.text, x, y, toneColor(pal, e.tone), 13, 'right');
    pen.g.globalAlpha = 1;
    y += dy;
    n--;
  }
  return y;
}

/* ───────────────────────── Objectives / hint ───────────────────────── */

interface ObjLineEntry {
  label: string;
  state: string;
  done: number;
  total: number;
  /** The threat count shown (-1 = none). */
  left: number;
  maxChars: number;
  lines: string[];
}
/** Per-objective cached lines (objective status objects are long-lived). */
const objLineCache = new WeakMap<object, ObjLineEntry>();

/**
 * Objective summary lines: state mark + label wrapped at word boundaries onto at most 3 lines (never
 * cut mid-word), with the progress count on the last line. A protect objective that counts its threat
 * adds a line with the jets left while it is active ("STRIKERS 3", Defend: issue #62).
 */
export function objectiveLines(
  o: { label: string; state: string; progress?: { done: number; total: number }; threat?: { label: string; left: number } },
  maxChars: number,
): string[] {
  const done = o.progress?.done ?? 0;
  const total = o.progress?.total ?? 0;
  const left = o.threat && o.state === 'active' ? o.threat.left : -1;
  const e = objLineCache.get(o);
  if (e && e.label === o.label && e.state === o.state && e.done === done && e.total === total && e.left === left && e.maxChars === maxChars) return e.lines;
  const mark = o.state === 'complete' ? '+ ' : o.state === 'failed' ? 'x ' : o.state === 'active' ? '> ' : '- ';
  const prog = total > 1 ? ' ' + done + '/' + total : '';
  const body = o.label.toUpperCase() + prog;
  const wrapped = wrapFit(body, Math.max(8, maxChars - 2), 3);
  const lines = wrapped.map((l, i) => (i === 0 ? mark : '  ') + l);
  if (left >= 0 && o.threat) lines.push('  ' + o.threat.label.toUpperCase() + ' ' + left);
  if (!e) objLineCache.set(o, { label: o.label, state: o.state, done, total, left, maxChars, lines });
  else Object.assign(e, { label: o.label, state: o.state, done, total, left, maxChars, lines });
  return lines;
}

/**
 * Re-show the objective summary when a protect objective's threat count drops (a striker splashed or
 * driven off): the summary is up only a few seconds after a change, and "STRIKERS 2" is that change.
 */
export function noteThreatCounts(f: HudFrame): void {
  const objs = f.ctx.mission?.objectives;
  if (!objs) return;
  const st = f.st;
  for (const o of objs) {
    if (!o.threat || o.state !== 'active') continue;
    const prev = st.threatLeft.get(o.id);
    st.threatLeft.set(o.id, o.threat.left);
    if (prev !== undefined && o.threat.left < prev) {
      st.objShow = Math.max(st.objShow, 6);
      st.objChangedId = o.id;
    }
  }
}

/**
 * Compact objective summary (top-left column), shown only for a few seconds at mission start and after
 * an objective changes (the full list lives on the pause screen / tactical map). Returns the next free y.
 */
export function drawObjectives(f: HudFrame, x: number, y: number, force = false, maxW = f.L.colW, maxLines = 7, measure = false): number {
  const { pen, pal, L, st, ctx } = f;
  const objs = ctx.mission?.objectives;
  if (!objs || objs.length === 0) return y;
  const show = (force ? 1 : Math.min(1, st.objShow / 0.6)) * f.declutter;
  if (show <= 0.02) return y;
  const u = L.u;
  const size = 11;
  const lh = 13.5 * u;
  const maxChars = Math.max(14, Math.floor(maxW / pen.charWidth(size)));
  // measure: where the summary would end, without drawing it
  const draw = !measure;
  if (draw) {
    pen.g.globalAlpha = show;
    pen.text('OBJECTIVES', x, y, pal.dim, 10, 'left');
  }
  y += 14 * u;
  let used = 0;
  let bonusHead = false;
  // primaries first, then the bonus objectives under a BONUS heading; in each, the one that just
  // changed leads. Every primary is listed whatever its state (at mission end they are complete or
  // failed, and the BONUS block must never come first); bonuses only while active (or, in the forced
  // list, once settled). A failed bonus never tops the list.
  for (let pass = 0; pass < 4 && used < maxLines; pass++) {
    const primary = pass < 2;
    const changedPass = pass === 0 || pass === 2;
    for (const o of objs) {
      if (o.primary !== primary) continue;
      const changed = !!st.objChangedId && o.id === st.objChangedId;
      if (changed !== changedPass) continue;
      if (!changedPass && !primary && (force ? o.state === 'pending' : o.state !== 'active')) continue;
      const lines = objectiveLines(o, maxChars);
      const head = !primary && !bonusHead ? 1 : 0;
      if (used + head + lines.length > maxLines) continue;
      if (head) {
        bonusHead = true;
        if (draw && !f.occ.hits(x, y - lh / 2, x + maxW, y + lh / 2, 1)) pen.text('BONUS', x, y, pal.dim, 10, 'left');
        y += lh;
        used++;
      }
      // (a failed bonus greys out: it costs points, not the mission)
      const col = o.state === 'complete' ? pal.good : o.state === 'failed' ? (primary ? pal.danger : pal.dim) : o.state === 'active' ? pal.main : pal.dim;
      for (const l of lines) {
        // (a line that would print over the target box / pipper / jet is left out)
        if (draw && !f.occ.hits(x, y - lh / 2, x + maxW, y + lh / 2, 1)) pen.text(l, x, y, col, size, 'left');
        y += lh;
      }
      used += lines.length;
      if (used >= maxLines) break;
    }
  }
  if (draw) pen.g.globalAlpha = 1;
  return y + 4 * u;
}

let hintRef = '';
let hintStart = 0;
/** Seconds each page of a long hint stays up. */
const HINT_PAGE = 4;

/**
 * Mission / tutorial hint: a left-aligned block in the top-left column (outside the pitch-ladder window
 * and away from the fight), max 3 lines per page, long hints page every few seconds.
 */
const HINT_SIZE = 11.5;

/** Characters per hint line in a column `maxW` wide. */
function hintChars(f: HudFrame, maxW: number): number {
  const u = f.L.u;
  // (room at the right end for the "1/2" page counter: it never sits on the last word)
  return Math.max(16, Math.floor((maxW - 16 * u - 24 * u) / f.pen.charWidth(HINT_SIZE)));
}

/** The hint's lines in a column `maxW` wide (wrap() caches them). */
function hintLines(f: HudFrame, hint: string, maxW: number): string[] {
  return wrap(hint, hintChars(f, maxW));
}

/** A word that ends a clause: a page of a long hint may end after it. */
const CLAUSE_END = /[:;,.!?—–]$/;
const pageCache = new Map<string, string[][]>();
/**
 * A long hint in pages of `room` lines of `maxChars`. A page that would end mid-clause ends at the
 * last clause mark (: ; , — or a sentence end) instead, when the words after it fit on one line, so
 * a page never stops on '…past the detent for' with 'AFTERBURNER' alone on the next (playtest r2
 * 2.1-m). Cached like wrap().
 */
export function hintPages(text: string, maxChars: number, room: number): string[][] {
  const key = `${maxChars}|${room}|${text}`;
  let pages = pageCache.get(key);
  if (pages) return pages;
  pages = [];
  const words = text.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length) {
    // fill a page: words[i, j) fit in `room` lines
    let lines = 1;
    let len = 0;
    let j = i;
    for (; j < words.length; j++) {
      const w = words[j].length;
      if (len && len + 1 + w > maxChars) {
        if (++lines > room) break;
        len = w;
      } else len = len ? len + 1 + w : w;
    }
    let end = j;
    if (j < words.length && !CLAUSE_END.test(words[j - 1])) {
      let tail = words[j - 1].length;
      for (let k = j - 1; k > i && tail <= maxChars; k--) {
        if (CLAUSE_END.test(words[k - 1])) {
          end = k;
          break;
        }
        tail += 1 + words[k - 1].length;
      }
    }
    pages.push(wrap(words.slice(i, end).join(' '), maxChars));
    i = end;
  }
  if (pageCache.size > 100) pageCache.clear();
  pageCache.set(key, pages);
  return pages;
}

/** Height drawHint needs for the current hint (one page, at most 3 lines), plus its gaps; 0 = no hint. */
export function hintHeight(f: HudFrame, maxW = f.L.colW): number {
  const hint = f.ctx.mission?.hint;
  if (!hint || !f.ctx.settings.hints) return 0;
  const u = f.L.u;
  return Math.min(3, hintLines(f, hint, maxW).length) * 15 * u + 8 * u + 10 * u;
}

export function drawHint(f: HudFrame, x: number, y: number, maxW = f.L.colW, yMax = f.L.colBottom): number {
  const hint = f.ctx.mission?.hint;
  if (!hint || !f.ctx.settings.hints) return y;
  const { pen, pal, L, st } = f;
  const u = L.u;
  const size = HINT_SIZE;
  const cw = pen.charWidth(size);
  const maxChars = hintChars(f, maxW);
  if (hint !== hintRef) {
    hintRef = hint;
    hintStart = st.clock;
  }
  const lh = 15 * u;
  const room = Math.max(1, Math.min(3, Math.floor((yMax - y - 8 * u) / lh)));
  // squeezed to one line (cockpit view with the radio pill + objectives in the column): wait for room
  // instead of paging a long hint one line at a time
  if (room < 2 && wrap(hint, maxChars).length > 1) return y;
  const all = hintPages(hint, maxChars, room);
  const pages = all.length;
  const page = pages > 1 ? Math.floor((st.clock - hintStart) / HINT_PAGE) % pages : 0;
  const lines = all[page];
  const n = lines.length;
  // (as wide as the widest line of any page, so the box doesn't change width as it pages)
  let widest = 0;
  for (const pl of all) for (const l of pl) widest = Math.max(widest, l.length);
  const w = Math.min(maxW, widest * cw + (pages > 1 ? 40 : 16) * u);
  const h = n * lh + 8 * u;
  // never over the target box / pipper / jet (the hint is the least important text on screen)
  if (f.occ.hits(x - 4 * u, y, x - 4 * u + w, y + h, 1)) return y;
  const a = 0.35 + 0.65 * f.declutter;
  pen.g.globalAlpha = a;
  pen.setFill('rgba(0,12,6,0.55)');
  pen.roundRect(x - 4 * u, y, w, h, 6 * u);
  pen.g.fill();
  for (let i = 0; i < n; i++) pen.text(lines[i], x + 4 * u, y + 4 * u + lh * (i + 0.5), pal.main, size, 'left');
  if (pages > 1) pen.text(pageLabel(page, pages), x - 4 * u + w - 4 * u, y + h - 5 * u, pal.dim, 8.5, 'right');
  pen.g.globalAlpha = 1;
  return y + h + 6 * u;
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

