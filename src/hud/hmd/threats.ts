/**
 * Threat symbology: DAS missile approach warning ("MISSILE" + direction arrows around the flight path
 * marker, colour coded radar/IR, time-to-impact ticks, conformal missile markers), RWR spike arrows at
 * the screen edge, ICAWS warning stack, PULL UP break-X, STALL, airframe damage.
 */
import { WARNING_INFO, NumText } from './format';
import { blink, type HudFrame } from './frame';
import { withAlpha } from './palette';
import { edgeOfEllipse } from './projector';
import type { WarningId } from '../../core/types';

const edge = { x: 0, y: 0 };
const ttiTxt: NumText[] = Array.from({ length: 8 }, () => new NumText(0));
const WARN_ORDER = (Object.keys(WARNING_INFO) as WarningId[]).sort((a, b) => WARNING_INFO[a].order - WARNING_INFO[b].order);
/** Warnings with their own dedicated big cue (not repeated in the stack). */
const SPECIAL: Partial<Record<WarningId, true>> = { pull_up: true, missile: true, stall: true };

/* ───────────────────────── Missile approach warning ───────────────────────── */

/** Returns true when the MISSILE banner is shown (so the message stack can move down). */
export function drawIncoming(f: HudFrame): boolean {
  const { p, pen, pal, L, proj, world } = f;
  const inc = p.incoming;
  if (!inc || inc.length === 0) return false;
  const u = L.u;
  // ring centre: the FPM when visible in the HMD, else the screen centre
  let cx = L.cx;
  let cy = L.cy;
  if (f.mode === 'hmd' && f.fpm.front && f.fpm.onScreen && f.fpm.y < L.cockpitTop - 60 * u) {
    cx = f.fpm.x;
    cy = f.fpm.y;
  }
  const R = 54 * u;
  let nearest = Infinity;
  pen.setDash('solid');
  const n = Math.min(inc.length, ttiTxt.length);
  for (let i = 0; i < n; i++) {
    const m = inc[i];
    nearest = Math.min(nearest, m.timeToImpact);
    const sx = Math.sin(m.bearing);
    const sy = -Math.cos(m.bearing);
    const col = m.guidance === 'ir' ? pal.ir : pal.danger;
    const urgent = m.timeToImpact < 5;
    const bx = cx + sx * R;
    const by = cy + sy * R;
    // chevrons: more = closer
    const chev = m.timeToImpact < 4 ? 3 : m.timeToImpact < 9 ? 2 : 1;
    pen.begin();
    for (let k = 0; k < chev; k++) {
      const d = R + 6 * u + k * 6 * u;
      const px = cx + sx * d;
      const py = cy + sy * d;
      pen.g.moveTo(px - sy * 7 * u - sx * 4 * u, py + sx * 7 * u - sy * 4 * u);
      pen.g.lineTo(px, py);
      pen.g.lineTo(px + sy * 7 * u - sx * 4 * u, py - sx * 7 * u - sy * 4 * u);
    }
    pen.strokeGlow(col, 2);
    pen.begin();
    pen.arrow(bx + sx * (R * 0 + 4 * u), by + sy * 4 * u, sx, sy, 12 * u, 6.5 * u);
    if (!(urgent && !blink(f, 5))) {
      pen.strokeGlow(col, 1.6);
      pen.fillPlain(col);
    }
    pen.text(ttiTxt[i].get(Math.max(0, Math.ceil(m.timeToImpact))), bx - sx * 13 * u, by - sy * 13 * u, col, 11);
    // conformal marker when the missile is in view (DAS)
    const e = world.getEntity(m.missileId);
    if (e && e.alive && proj.point(e.position, f.sp) && f.sp.onScreen) {
      const x = f.sp.x;
      const y = f.sp.y;
      const r = 11 * u;
      pen.begin();
      pen.g.moveTo(x, y - r);
      pen.g.lineTo(x + r, y + r * 0.7);
      pen.g.lineTo(x - r, y + r * 0.7);
      pen.g.closePath();
      if (blink(f, 4)) pen.strokeGlow(col, 2);
    }
  }
  // banner
  const size = nearest < 5 ? 26 : 22;
  if (blink(f, nearest < 5 ? 5 : 3, 0.65)) {
    pen.text('MISSILE', L.cx, L.msgY, pal.danger, size);
  }
  return true;
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
    // stay out of the thumb zones / cockpit panel
    if (y > L.thumbY - 12 * u && (x < L.thumbLX + 16 * u || x > L.thumbRX - 16 * u)) y = L.thumbY - 12 * u;
    if (f.mode === 'hmd' && f.cockpit) y = Math.min(y, L.cockpitTop - 16 * u);
    y = Math.max(y, L.tapeY + 56 * u);
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

/* ───────────────────────── ICAWS ───────────────────────── */

/** Big PULL UP / STALL cues + the warning stack. Returns the next free y of the stack. */
export function drawWarnings(f: HudFrame, y: number): number {
  const { p, pen, pal, L } = f;
  const u = L.u;
  const w = p.warnings;
  if (w.size === 0) return y;
  if (w.has('pull_up')) {
    const on = blink(f, 3.5, 0.7);
    if (on) {
      const cx = L.cx;
      const cy = L.cy;
      const k = 58 * u;
      pen.setDash('solid');
      pen.begin();
      pen.line(cx - k, cy - k * 0.8, cx + k, cy + k * 0.8);
      pen.line(cx - k, cy + k * 0.8, cx + k, cy - k * 0.8);
      pen.strokeGlow(pal.danger, 3);
      pen.text('PULL UP', cx, cy - k * 0.8 - 18 * u, pal.danger, 30);
    }
  }
  if (w.has('stall') && !w.has('pull_up')) {
    if (blink(f, 3)) pen.text('STALL', L.cx, L.cy - 44 * u, pal.danger, 24);
  }
  // stack row: boxed labels, red warnings / amber cautions
  let total = 0;
  let count = 0;
  const size = 12.5;
  for (const id of WARN_ORDER) {
    if (!w.has(id) || SPECIAL[id]) continue;
    if (count >= 4) break;
    total += pen.textWidth(WARNING_INFO[id].label, size) + 14 * u;
    count++;
  }
  if (count === 0) return y;
  const flash = f.st.warnAge < 2.5 && !blink(f, 4, 0.6);
  let x = L.cx - total / 2 + 3 * u;
  let k = 0;
  for (const id of WARN_ORDER) {
    if (!w.has(id) || SPECIAL[id]) continue;
    if (k++ >= 4) break;
    const info = WARNING_INFO[id];
    const tw = pen.textWidth(info.label, size) + 8 * u;
    const col = info.level === 2 ? pal.danger : info.level === 1 ? pal.warn : pal.dim;
    if (!flash) {
      pen.box(x, y - 9 * u, tw, 18 * u, col, 1.5, withAlpha('#000000', 0.45));
      pen.text(info.label, x + tw / 2, y + 0.5, col, size);
    }
    x += tw + 6 * u;
  }
  return y + 24 * u;
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
  return y;
}
