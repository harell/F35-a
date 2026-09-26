/**
 * Threat symbology and the WARNING BAND.
 *
 *  - DAS missile approach warning: dashed threat ring around the flight path marker (HMD) with direction
 *    arrows, range chevrons and time-to-impact; defeated missiles stay on the ring crossed out for ~1 s.
 *    External views put the arrows on the radar inset rim instead of a ring in the middle of the screen.
 *  - Warning band (top centre, above the FPM, fixed position):
 *      row 1 — ONE critical line, highest priority wins: PULL UP › MISSILE › MISSILE DEFEATED › STALL ›
 *              AUTO GCAS › red ICAWS warning › SPEED › AOA › mission title banner
 *      row 2 — chips: SPIKE / MUD SPIKE (filled, with the emitter symbol and a bearing arrow), DEFEATED,
 *              then the remaining ICAWS cautions (overflow collapses into "+N")
 *  - RWR spike arrows at the screen-edge ellipse, PULL UP break-X, Auto-GCAS chevrons, airframe damage.
 */
import { WARNING_INFO, NumText } from './format';
import { blink, type HudFrame } from './frame';
import { withAlpha } from './palette';
import { edgeOfEllipse } from './projector';
import { DEFEAT_MARK, DEFEAT_SHOW } from './threatTracker';
import { pcdZoom } from '../cockpit/zoom';
import type { WarningId } from '../../core/types';

const edge = { x: 0, y: 0 };
const ttiTxt: NumText[] = Array.from({ length: 8 }, () => new NumText(0));
const WARN_ORDER = (Object.keys(WARNING_INFO) as WarningId[]).sort((a, b) => WARNING_INFO[a].order - WARNING_INFO[b].order);
/** Warnings with their own dedicated cue (never repeated as a chip). */
const SPECIAL: Partial<Record<WarningId, true>> = { pull_up: true, missile: true, stall: true, spike: true };
/** Red ICAWS warnings that may take row 1 (in priority order). */
const ROW1_RED: WarningId[] = ['engine_fire', 'over_g', 'altitude', 'engine_fail'];

/* ───────────────────────── Missile approach warning ───────────────────────── */

/** Draws the DAS threat cue. Returns true when a missile is inbound. */
export function drawIncoming(f: HudFrame): boolean {
  const { p, pen, pal, L, proj, world, st } = f;
  const inc = p.incoming;
  const marks = st.threats.marks;
  let anyMark = false;
  for (const m of marks) anyMark = anyMark || m.active;
  if ((!inc || inc.length === 0) && !anyMark) return false;
  const u = L.u;
  // ring centre: the FPM in the HMD, the radar inset in external views (never over the jet / target)
  let cx = L.cx;
  let cy = L.cy;
  let R = 62 * u;
  const hmd = f.mode === 'hmd';
  if (hmd) {
    if (f.cockpit) R = 54 * u;
    if (f.fpm.front && f.fpm.onScreen && f.fpm.y > L.row2Y) {
      cx = f.fpm.x;
      cy = f.fpm.y;
    }
    // keep the ring (and its arrows) above the cockpit panel
    if (f.cockpit) cy = Math.min(cy, L.cockpitTop - R - 10 * u);
  } else {
    cx = L.insetCx;
    cy = L.insetCy;
    R = L.insetR + 3 * u;
  }
  let nearest = Infinity;
  for (let i = 0; i < inc.length; i++) nearest = Math.min(nearest, inc[i].timeToImpact);
  const urgentAll = nearest < 5;
  if (hmd && inc.length > 0) {
    pen.setDash('dash');
    pen.begin();
    pen.circle(cx, cy, R);
    pen.strokeGlow(withAlpha(pal.danger, urgentAll && !blink(f, 5) ? 0.35 : 0.8), 1.4);
    pen.setDash('solid');
  }
  const aLen = (hmd ? 20 : 12) * u;
  const n = Math.min(inc.length, ttiTxt.length);
  for (let i = 0; i < n; i++) {
    const m = inc[i];
    const sx = Math.sin(m.bearing);
    const sy = -Math.cos(m.bearing);
    const col = m.guidance === 'ir' ? pal.ir : pal.danger;
    const urgent = m.timeToImpact < 5;
    // arrow on the ring pointing out toward the missile
    const tipX = cx + sx * (R + aLen);
    const tipY = cy + sy * (R + aLen);
    pen.begin();
    pen.arrow(tipX, tipY, sx, sy, aLen, aLen * 0.5);
    if (!(urgent && !blink(f, 5))) {
      pen.strokeGlow(col, 2);
      pen.fillPlain(col);
    }
    // distance ticks outside the arrow: more chevrons = closer
    const chev = m.timeToImpact < 4 ? 3 : m.timeToImpact < 9 ? 2 : 1;
    const ck = hmd ? 1 : 0.6;
    pen.begin();
    for (let k = 0; k < chev; k++) {
      const d = R + aLen + 6 * u + k * 7 * u * ck;
      const px = cx + sx * d;
      const py = cy + sy * d;
      pen.g.moveTo(px - sy * 8 * u * ck - sx * 5 * u * ck, py + sx * 8 * u * ck - sy * 5 * u * ck);
      pen.g.lineTo(px, py);
      pen.g.lineTo(px + sy * 8 * u * ck - sx * 5 * u * ck, py - sx * 8 * u * ck - sy * 5 * u * ck);
    }
    pen.strokeGlow(col, 2.2);
    // time to impact inside the ring (HMD) / next to the arrow (inset)
    const tr = hmd ? R - 14 * u : R - 12 * u;
    pen.text(ttiTxt[i].get(Math.max(0, Math.ceil(m.timeToImpact))), cx + sx * tr, cy + sy * tr, col, hmd ? 13 : 11);
    // labels near the ring make way for the arrow / chevrons / time to impact
    f.occ.addBox(cx + sx * tr, cy + sy * tr, 9 * u, 8 * u);
    f.occ.addBox(cx + sx * (R + aLen + 8 * u), cy + sy * (R + aLen + 8 * u), 16 * u, 16 * u);
    // conformal marker when the missile is in view (DAS)
    const e = world.getEntity(m.missileId);
    if (e && e.alive && proj.point(e.position, f.sp) && f.sp.onScreen) {
      const x = f.sp.x;
      const y = f.sp.y;
      const r = 12 * u;
      pen.begin();
      pen.g.moveTo(x, y - r);
      pen.g.lineTo(x + r, y + r * 0.7);
      pen.g.lineTo(x - r, y + r * 0.7);
      pen.g.closePath();
      if (blink(f, 4)) pen.strokeGlow(col, 2.2);
    }
  }
  // defeated missiles: their arrow stays a moment, dimmed and crossed out
  for (const m of marks) {
    if (!m.active) continue;
    const a = Math.max(0, 1 - m.age / DEFEAT_MARK);
    const sx = Math.sin(m.bearing);
    const sy = -Math.cos(m.bearing);
    const tx = cx + sx * (R + aLen);
    const ty = cy + sy * (R + aLen);
    pen.g.globalAlpha = a;
    pen.begin();
    pen.arrow(tx, ty, sx, sy, aLen, aLen * 0.5);
    pen.strokeGlow(pal.good, 1.6);
    const mx = cx + sx * (R + aLen * 0.55);
    const my = cy + sy * (R + aLen * 0.55);
    const k = 9 * u;
    pen.begin();
    pen.line(mx - k, my - k, mx + k, my + k);
    pen.line(mx - k, my + k, mx + k, my - k);
    pen.strokeGlow(pal.good, 2.2);
    pen.g.globalAlpha = 1;
  }
  return inc.length > 0;
}

/* ───────────────────────── RWR spikes ───────────────────────── */

export function drawRwrEdge(f: HudFrame): void {
  const { p, pen, pal, L } = f;
  const u = L.u;
  pen.setDash('solid');
  for (const c of p.rwr) {
    if (c.state === 'search' && c.age > 3) continue;
    const sx = Math.sin(c.bearing);
    const sy = -Math.cos(c.bearing);
    edgeOfEllipse(L.edgeCx, L.edgeCy, L.edgeRx, sy > 0 ? L.edgeRy * 0.85 : L.edgeRy, sx, sy, edge);
    let x = edge.x;
    let y = edge.y;
    // stay out of the thumb zones / cockpit panel / warning band
    if (y > L.ctlTop - 12 * u && (x < L.ctlLeft + 16 * u || x > L.ctlRight - 16 * u)) y = L.ctlTop - 12 * u;
    if (f.mode === 'hmd' && f.cockpit) y = Math.min(y, L.cockpitTop - 16 * u);
    y = Math.max(y, L.row2Y + 18 * u);
    // declutter: slide along the edge ellipse off text / other RWR symbols (co-bearing emitters
    // never merge into "2910"), then register the symbol
    const rr = 15 * f.L.u;
    if (f.occ.hits(x - rr, y - rr, x + rr, y + rr)) {
      let moved = false;
      for (let k = 1; k <= 16; k++) {
        const da = (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * 0.09;
        const b2 = c.bearing + da;
        edgeOfEllipse(L.edgeCx, L.edgeCy, L.edgeRx, Math.cos(b2) < 0 ? L.edgeRy * 0.85 : L.edgeRy, Math.sin(b2), -Math.cos(b2), edge);
        let y2 = Math.max(edge.y, L.row2Y + 18 * u);
        if (f.mode === 'hmd' && f.cockpit) y2 = Math.min(y2, L.cockpitTop - 16 * u);
        if (!f.occ.hits(edge.x - rr, y2 - rr, edge.x + rr, y2 + rr)) {
          x = edge.x;
          y = y2;
          moved = true;
          break;
        }
      }
      // crowded edge: step inward toward the centre instead (bearing kept)
      for (let k = 1; k <= 3 && !moved; k++) {
        const xi = x - sx * rr * 2 * k;
        const yi = y - sy * rr * 2 * k;
        if (!f.occ.hits(xi - rr, yi - rr, xi + rr, yi + rr)) {
          x = xi;
          y = yi;
          moved = true;
        }
      }
    }
    f.occ.add(x - rr, y - rr, x + rr, y + rr);
    const launch = c.state === 'launch';
    const track = c.state === 'track';
    const col = launch ? pal.danger : track ? pal.warn : pal.dim;
    if (launch && !blink(f, 4, 0.6)) continue;
    const sym = c.symbol || 'U';
    const r = 11 * u;
    pen.begin();
    if (launch) pen.circle(x, y, r);
    else if (track) pen.diamond(x, y, r * 1.15);
    if (launch || track) pen.strokeGlow(col, 1.8);
    pen.text(sym, x, y + 0.5, col, 12);
    // arrow pointing outward, toward the emitter
    pen.begin();
    pen.arrow(x + sx * (r + 12 * u), y + sy * (r + 12 * u), sx, sy, 8 * u, 4.5 * u);
    pen.strokeGlow(col, 1.4);
    pen.fillPlain(col);
  }
}

/* ───────────────────────── Warning band ───────────────────────── */

const missileTxt: string[] = ['MISSILE', 'MISSILE', 'MISSILE ×2', 'MISSILE ×3', 'MISSILE ×4', 'MISSILE ×5', 'MISSILE ×6'];
const ttiBand = new NumText(0, '', 's');

/** Chip scratch (no per-frame allocation). */
interface Chip {
  text: string;
  col: string;
  fill: boolean;
  arrow: number;
  w: number;
}
const chips: Chip[] = Array.from({ length: 12 }, () => ({ text: '', col: '', fill: false, arrow: NaN, w: 0 }));
const PLUS: string[] = ['+0', '+1', '+2', '+3', '+4', '+5', '+6', '+7', '+8', '+9', '+10', '+11', '+12'];

/** RWR spike chip text ("SPIKE 29" / "MUD SPIKE 6") keyed by the emitter (cached strings). */
const spikeCache = new Map<string, string>();
function spikeText(sam: boolean, sym: string): string {
  const k = (sam ? 'M' : 'F') + sym;
  let s = spikeCache.get(k);
  if (!s) spikeCache.set(k, (s = (sam ? 'MUD SPIKE ' : 'SPIKE ') + sym));
  return s;
}

const chipPos = { x: 0, y: 0 };
/** Row-2 chip placement: centre, left, right, then a row lower / higher (first slot clear of protected symbols). */
export function chipPlace(f: HudFrame, total: number, h: number): { x: number; y: number } {
  const { L, occ } = f;
  const u = L.u;
  const xc = L.cx - total / 2;
  const xl = Math.min(xc, L.spdRight + 4 * u);
  const xr = Math.max(xc, L.altLeft - 4 * u - total);
  // (further out: beside a target box sitting right under the band)
  const xfl = Math.max(L.left, xc - total / 2 - 40 * u);
  const xfr = Math.min(L.right - total, xc + total / 2 + 40 * u);
  const dy = h + 5 * u;
  for (let r = 0; r < 3; r++) {
    const y = L.row2Y + r * dy;
    for (let k = 0; k < 5; k++) {
      const x = k === 0 ? xc : k === 1 ? xl : k === 2 ? xr : k === 3 ? xfl : xfr;
      if (!occ.hits(x, y - h / 2, x + total, y + h / 2, 1)) {
        chipPos.x = x;
        chipPos.y = y;
        return chipPos;
      }
    }
  }
  chipPos.x = xc;
  chipPos.y = L.row2Y;
  return chipPos;
}

/**
 * Reserve the warning band rows that will be drawn this frame (so conformal labels make way for them).
 * Row 1 = one critical line; row 2 = the chips band between the speed / altitude columns.
 */
export function reserveWarningBand(f: HudFrame): void {
  const { p, st, L, occ } = f;
  const u = L.u;
  const w = p.warnings;
  let row1 = w.has('pull_up') || p.incoming.length > 0 || st.threats.showing || w.has('stall') || p.flight.stalled || !!p.gcasActive;
  if (!row1) row1 = w.has('speed_low') || p.flight.alpha > 0.42 || (!!st.title && st.titleAge < st.titleDur);
  for (let i = 0; i < ROW1_RED.length && !row1; i++) row1 = w.has(ROW1_RED[i]);
  if (row1) occ.add(L.cx - 125 * u, L.warnY - 14 * u, L.cx + 125 * u, L.warnY + 14 * u);
  let chips = w.has('spike') || st.threats.showing;
  for (let i = 0; i < WARN_ORDER.length && !chips; i++) chips = w.has(WARN_ORDER[i]) && !SPECIAL[WARN_ORDER[i]];
  if (chips) occ.add(L.spdRight, L.row2Y - 10 * u, L.altLeft, L.row2Y + 10 * u);
}

/**
 * The warning band. Returns true when row 1 shows a CRITICAL warning (PULL UP / MISSILE / STALL):
 * the centre message slot then holds back.
 */
export function drawWarningBand(f: HudFrame): boolean {
  const { p, pen, pal, L, st, occ } = f;
  const u = L.u;
  const w = p.warnings;
  const inc = p.incoming;
  const cx = L.cx;
  const y1 = L.warnY;

  /* row 1 */
  let row1: WarningId | 'title' | 'defeated' | 'gcas' | 'aoa' | '' = '';
  let critical = false;
  if (w.has('pull_up')) row1 = 'pull_up';
  else if (inc.length > 0) row1 = 'missile';
  else if (st.threats.showing) row1 = 'defeated';
  else if (w.has('stall') || p.flight.stalled) row1 = 'stall';
  else if (p.gcasActive) row1 = 'gcas';
  else {
    for (const id of ROW1_RED) {
      if (w.has(id)) {
        row1 = id;
        break;
      }
    }
    if (!row1 && w.has('speed_low')) row1 = 'speed_low';
    else if (!row1 && p.flight.alpha > 0.42) row1 = 'aoa';
    else if (!row1 && st.title && st.titleAge < st.titleDur) row1 = 'title';
  }
  // looking down into the cockpit (PCD): only the life-critical cues stay at full strength; the rest
  // fades out (the PCD's ICAWS page carries them — it jumps there on engine fire / hydraulics)
  const crit1 = row1 === 'pull_up' || row1 === 'missile' || row1 === 'stall';
  pen.g.globalAlpha = crit1 ? 1 : f.declutter;
  switch (row1) {
    case 'pull_up': {
      critical = true;
      if (blink(f, 3.5, 0.8)) {
        // break-X over the centre + the words in the band
        const k = 58 * u;
        pen.setDash('solid');
        pen.begin();
        pen.line(L.cx - k, L.cy - k * 0.8, L.cx + k, L.cy + k * 0.8);
        pen.line(L.cx - k, L.cy + k * 0.8, L.cx + k, L.cy - k * 0.8);
        pen.strokeGlow(pal.danger, 3);
        pen.text('PULL UP', cx, y1, pal.danger, 28);
      }
      break;
    }
    case 'missile': {
      critical = true;
      let nearest = Infinity;
      for (let i = 0; i < inc.length; i++) nearest = Math.min(nearest, inc[i].timeToImpact);
      const txt = missileTxt[Math.min(missileTxt.length - 1, inc.length)];
      // steady while there is time, flashing when impact is close
      const size = nearest < 5 ? 25 : 22;
      if (nearest >= 5 || blink(f, 5, 0.7)) pen.text(txt, cx, y1, pal.danger, size);
      // time to impact of the nearest one, right of the word
      const tw = pen.textWidth(txt, size);
      pen.text(ttiBand.get(Math.max(0, Math.ceil(nearest))), cx + tw / 2 + 8 * u, y1 + 1, pal.danger, 14, 'left');
      break;
    }
    case 'defeated': {
      const a = Math.min(1, (DEFEAT_SHOW - st.threats.defeatAge) / 0.4);
      pen.g.globalAlpha = Math.max(0, a) * Math.max(0.5, f.declutter);
      pen.box(cx - 104 * u, y1 - 13 * u, 208 * u, 26 * u, pal.good, 1.6, 'rgba(0,20,8,0.5)');
      pen.text('MISSILE DEFEATED', cx, y1 + 0.5, pal.good, 19);
      pen.g.globalAlpha = 1;
      break;
    }
    case 'stall':
      critical = true;
      if (blink(f, 3)) pen.text('STALL', cx, y1, pal.danger, 24);
      break;
    case 'gcas':
      pen.text('AUTO GCAS', cx, y1, pal.warn, 20);
      break;
    case 'speed_low':
      if (blink(f, 2)) pen.text('SPEED', cx, y1, pal.warn, 19);
      break;
    case 'aoa':
      if (blink(f, 3)) pen.text('AOA', cx, y1, pal.warn, 17);
      break;
    case 'title': {
      const a = Math.max(0, Math.min(1, st.titleAge / 0.25, (st.titleDur - st.titleAge) / 0.5)) * f.declutter;
      const tw = pen.textWidth(st.title, 17);
      // (never dimmed: a dark plate keeps it readable over whatever is behind it)
      pen.g.globalAlpha = a;
      if (occ.hits(cx - tw / 2 - 30 * u, y1 - 11 * u, cx + tw / 2 + 30 * u, y1 + 11 * u, 1)) {
        pen.setFill('rgba(0,10,4,0.6)');
        pen.g.fillRect(cx - tw / 2 - 6 * u, y1 - 10 * u, tw + 12 * u, 20 * u);
      }
      pen.text(st.title, cx, y1, pal.bright, 17);
      pen.begin();
      pen.line(cx - tw / 2 - 30 * u, y1, cx - tw / 2 - 8 * u, y1);
      pen.line(cx + tw / 2 + 8 * u, y1, cx + tw / 2 + 30 * u, y1);
      pen.strokeGlow(pal.main, 1.4);
      pen.g.globalAlpha = 1;
      break;
    }
    case '':
      break;
    default: {
      // a red ICAWS warning
      const info = WARNING_INFO[row1];
      const flash = st.warnAge < 2.5 && !blink(f, 4, 0.6);
      if (!flash) pen.text(info.label, cx, y1, info.level === 2 ? pal.danger : pal.warn, 21);
    }
  }

  pen.g.globalAlpha = 1;

  /* row 2: chips (not over the PCD zoom overlay: its ICAWS / RWR pages carry them) */
  if (f.cockpit && pcdZoom.open) return critical;
  const size = 12;
  let n = 0;
  if (w.has('spike')) {
    // strongest emitter tracking us
    let best = -1;
    for (let i = 0; i < p.rwr.length; i++) {
      const c = p.rwr[i];
      if (c.state !== 'track' && c.state !== 'launch') continue;
      if (best < 0 || (c.state === 'launch' && p.rwr[best].state !== 'launch') || c.strength > p.rwr[best].strength) best = i;
    }
    const c = best >= 0 ? p.rwr[best] : null;
    const ch = chips[n++];
    ch.text = c ? spikeText(c.kind === 'sam' || c.kind === 'aaa', c.symbol || 'U') : 'SPIKE';
    ch.col = c && c.state === 'launch' ? pal.danger : pal.warn;
    ch.fill = true;
    ch.arrow = c ? c.bearing : NaN;
  }
  if (st.threats.showing && row1 !== 'defeated') {
    const ch = chips[n++];
    ch.text = 'DEFEATED';
    ch.col = pal.good;
    ch.fill = false;
    ch.arrow = NaN;
  }
  for (const id of WARN_ORDER) {
    if (n >= chips.length - 1) break;
    if (!w.has(id) || SPECIAL[id] || id === row1) continue;
    const info = WARNING_INFO[id];
    const ch = chips[n++];
    ch.text = info.label;
    ch.col = info.level === 2 ? pal.danger : info.level === 1 ? pal.warn : pal.dim;
    ch.fill = false;
    ch.arrow = NaN;
  }
  if (n === 0) return critical;
  // fit into the band between the speed / altitude columns
  const maxW = Math.max(180 * u, L.altLeft - L.spdRight - 20 * u);
  const gap = 6 * u;
  let total = 0;
  let shown = 0;
  for (let i = 0; i < n; i++) {
    const ch = chips[i];
    ch.w = pen.textWidth(ch.text, size) + (Number.isNaN(ch.arrow) ? 10 : 24) * u;
    const plusW = i < n - 1 ? pen.textWidth('+9', size) + 10 * u + gap : 0;
    if (shown > 0 && total + gap + ch.w + plusW > maxW) break;
    total += (shown > 0 ? gap : 0) + ch.w;
    shown++;
  }
  const more = n - shown;
  const plus = more > 0 ? PLUS[Math.min(PLUS.length - 1, more)] : '';
  const plusW = more > 0 ? pen.textWidth(plus, size) + 10 * u : 0;
  if (more > 0) total += gap + plusW;
  const h = 18 * u;
  const flash = st.warnAge < 2.5 && !blink(f, 4, 0.6);
  // centred; slid sideways, then one row up / down, off the target box / FPM / pipper. The chips are
  // NEVER dimmed (a SPIKE is most important exactly when a bandit is ahead): if every slot is taken
  // they stay centred at full strength on their own dark plates.
  const pos = chipPlace(f, total, h);
  let x = pos.x;
  const y2 = pos.y;
  pen.g.globalAlpha = f.declutter;
  if (f.declutter <= 0.02) {
    pen.g.globalAlpha = 1;
    return critical;
  }
  for (let i = 0; i < shown; i++) {
    const ch = chips[i];
    const launchBlink = ch.fill && ch.col === pal.danger && !blink(f, 4, 0.6);
    if (ch.fill) {
      pen.setFill(launchBlink ? withAlpha(ch.col, 0.35) : ch.col);
      pen.g.fillRect(x, y2 - h / 2, ch.w, h);
      pen.begin();
      pen.rect(x, y2 - h / 2, ch.w, h);
      pen.strokeGlow(ch.col, 1.2);
      let tx = x + 5 * u;
      if (!Number.isNaN(ch.arrow)) {
        // bearing arrow toward the emitter (nose up)
        const ax = x + 11 * u;
        const sx = Math.sin(ch.arrow);
        const sy = -Math.cos(ch.arrow);
        pen.begin();
        pen.arrow(ax + sx * 6 * u, y2 + sy * 6 * u, sx, sy, 12 * u, 4 * u);
        pen.fillPlain('#140c00');
        tx = x + 21 * u;
      }
      pen.setFont(size);
      pen.setAlign('left', 'middle');
      pen.setFill('#140c00');
      pen.g.fillText(ch.text, tx, y2 + 0.5);
    } else if (!flash || ch.col === pal.good) {
      pen.box(x, y2 - h / 2, ch.w, h, ch.col, 1.5, 'rgba(0,0,0,0.45)');
      pen.text(ch.text, x + ch.w / 2, y2 + 0.5, ch.col, size);
    }
    x += ch.w + gap;
  }
  if (more > 0) pen.text(plus, x + plusW / 2, y2 + 0.5, pal.warn, size);
  pen.g.globalAlpha = 1;
  return critical;
}

/* ───────────────────────── Damage ───────────────────────── */

const hpTxt = new NumText(0, 'AIRFRAME ', '%');
const engTxt = new NumText(0, 'ENG ', '%');

export function drawDamage(f: HudFrame, x: number, y: number): number {
  const { p, pen, pal, L } = f;
  const u = L.u;
  const hp = p.maxHealth > 0 ? p.health / p.maxHealth : 1;
  const d = p.damage;
  if (hp > 0.985 && d.engine < 0.05 && d.hydraulics < 0.05 && !d.fire && d.fuelLeak < 0.05) return y;
  const col = hp < 0.35 ? pal.danger : hp < 0.7 ? pal.warn : pal.main;
  pen.g.globalAlpha = 0.3 + 0.7 * f.declutter;
  pen.text(hpTxt.get(hp * 100), x, y, col, 12, 'left');
  y += 11 * u;
  const bw = 96 * u;
  pen.setFill(pal.back);
  pen.g.fillRect(x, y - 3 * u, bw, 6 * u);
  pen.setFill(col);
  pen.g.fillRect(x, y - 3 * u, bw * Math.max(0, hp), 6 * u);
  pen.begin();
  pen.rect(x, y - 3 * u, bw, 6 * u);
  pen.strokeGlow(col, 1);
  y += 13 * u;
  let sx = x;
  if (d.engine > 0.05) {
    const s = engTxt.get((1 - d.engine) * 100);
    pen.text(s, sx, y, d.engine > 0.5 ? pal.danger : pal.warn, 11, 'left');
    sx += pen.textWidth(s, 11) + 8 * u;
  }
  if (d.hydraulics > 0.05) {
    pen.text('HYD', sx, y, d.hydraulics > 0.5 ? pal.danger : pal.warn, 11, 'left');
    sx += pen.textWidth('HYD', 11) + 8 * u;
  }
  if (d.fuelLeak > 0.05) {
    pen.text('LEAK', sx, y, pal.warn, 11, 'left');
    sx += pen.textWidth('LEAK', 11) + 8 * u;
  }
  if (d.fire && blink(f, 3)) pen.text('FIRE', sx, y, pal.danger, 11, 'left');
  if (sx !== x || d.fire) y += 14 * u;
  pen.g.globalAlpha = 1;
  return y + 4 * u;
}

/* ───────────────────────── Auto-GCAS ───────────────────────── */

/** Auto-GCAS fly-up: two chevrons converging on the flight path marker ("AUTO GCAS" is in the band). */
export function drawGcas(f: HudFrame): void {
  if (!f.p.gcasActive || f.mode !== 'hmd') return;
  const { pen, pal, L } = f;
  const u = L.u;
  const x = f.fpm.front && f.fpm.onScreen ? f.fpm.x : L.cx;
  const y = f.fpm.front && f.fpm.onScreen ? Math.min(f.fpm.y, L.cockpitTop - 20 * u) : L.cy;
  const gap = (18 + 10 * (Math.sin(f.st.clock * 6) * 0.5 + 0.5)) * u;
  pen.setDash('solid');
  pen.begin();
  for (let s = -1; s <= 1; s += 2) {
    const cx = x + s * gap;
    pen.g.moveTo(cx + s * 14 * u, y - 10 * u);
    pen.g.lineTo(cx, y);
    pen.g.lineTo(cx + s * 14 * u, y + 10 * u);
  }
  pen.strokeGlow(pal.warn, 2.4);
}
