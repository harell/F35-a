/**
 * Flight symbology: flight path marker (velocity vector) + ghost, conformal pitch ladder and horizon
 * line, bank scale, aircraft waterline, heading tape with waypoint caret, airspeed / altitude columns.
 */
import { DEG, RAD, dirFromHeadingPitch, elevationOf, forwardOf, headingOf, toFeet, toFpm, toKnots, wrapPi } from '../../core/math';
import { BINGO_FRACTION, JOKER_FRACTION } from '../../core/data';
import { AB_DETENT } from '../../core/types';
import { AIRCRAFT_PERF } from '../../sim/flight/aircraftData';
import { HDG_STR, HDG3_STR, INT_STR, NumText } from './format';
import { blink, type HudFrame } from './frame';
import { makeScreenPoint } from './projector';
import { tapeBottom } from './zones';

const txt = {
  kcas: new NumText(0),
  g: new NumText(1, 'G '),
  // peak g, labelled (a lone number under 'G' read as nothing: playtest 1.2-n)
  aoa: new NumText(1, 'α '),
  alt: new NumText(0, '', '', true),
  ralt: new NumText(0, 'R '),
  vvi: new NumText(0),
  thr: new NumText(0, 'THR ', '%'),
  fuel: new NumText(1, 'FUEL '),
  vc: new NumText(0, 'Vc '),
};

/** Session max G (reset when the player changes). */
/**
 * Limit-only rows of the speed column (owner, 2026-10-06: show the numbers near their limit, not all the
 * time): G above G_SHOW (or negative), AoA above AOA_SHOW or stalling, held HOLD_S after so a pull that
 * hovers at the threshold doesn't flicker the row.
 */
export const G_SHOW = 6;
export const AOA_SHOW = 20;
const HOLD_S = 2;
/** HUD clock when G / AoA were last over their thresholds, for this player. */
const held = { owner: -1, g: -Infinity, aoa: -Infinity };

/** The rows the HMD speed column draws under its box this frame. */
export interface SpeedRows {
  g: boolean;
  aoa: boolean;
  /** Throttle % (or the AB stage): with no touch throttle lever showing it, or in afterburner. */
  thr: boolean;
  /** Fuel: at joker and below. */
  fuel: boolean;
  brake: boolean;
}
const rows: SpeedRows = { g: false, aoa: false, thr: false, fuel: false, brake: false };

function gOver(fl: HudFrame['p']['flight']): boolean {
  return fl.gLoad > G_SHOW || fl.gLoad < -1;
}

function aoaOver(p: HudFrame['p']): boolean {
  return p.flight.alpha * RAD > AOA_SHOW || p.flight.stalled || !!p.warnings?.has('stall');
}

function inAfterburner(p: HudFrame['p']): boolean {
  return p.flight.afterburner > 0.02 || p.input.throttle > AB_DETENT + 0.01;
}

/** Which speed-column rows show this frame (the reservation in zones.ts reads the same). */
export function speedRows(f: HudFrame): SpeedRows {
  const p = f.p;
  const fl = p?.flight;
  const now = f.st?.clock ?? 0;
  const mine = held.owner === p?.id;
  rows.g = !!fl && (gOver(fl) || (mine && now - held.g < HOLD_S));
  rows.aoa = !!fl && (aoaOver(p) || (mine && now - held.aoa < HOLD_S));
  rows.thr = !!fl && (!f.ctx?.touchControls || inAfterburner(p));
  rows.fuel = !!fl && fuelFraction(p) < JOKER_FRACTION;
  rows.brake = !!p && (p.input.airbrake || p.flight.surfaces.airbrake > 0.2);
  return rows;
}

/** Number of rows the speed column draws under its box. */
export function speedRowCount(f: HudFrame): number {
  const r = speedRows(f);
  return (r.g ? 1 : 0) + (r.aoa ? 1 : 0) + (r.thr ? 1 : 0) + (r.fuel ? 1 : 0) + (r.brake ? 1 : 0);
}

/** Radar altitude below this (ft AGL) always shows; up to RALT_MAX_FT only while descending. */
export const RALT_SHOW_FT = 1500;
const RALT_MAX_FT = 5000;
/** "Descending": faster than this (ft/min) toward the ground. */
const RALT_DESCENT_FPM = -1000;

/** The altitude column's radar-altitude row shows this frame. */
export function raltShown(p: HudFrame['p'] | undefined): boolean {
  if (!p?.flight) return false;
  const aglFt = toFeet(p.flight.agl);
  return aglFt < RALT_SHOW_FT || (aglFt < RALT_MAX_FT && toFpm(p.flight.verticalSpeed) < RALT_DESCENT_FPM);
}

/** Text a fixed column (speed, altitude, weapon block) draws under a symbol or its labels is dimmed. */
export const COLUMN_DIM = 0.3;

/**
 * A fixed column's text line: dimmed where a world symbol (contact, SAM, ground target, waypoint) or a
 * protected one (the designated box and its labels, the FPM, the pipper) is under it, so the symbol
 * reads through (owner, 2026-10-06: SA-15 and AD BOAT printed under "G 1.0" and "FL 24 CH 24").
 */
export function colText(f: HudFrame, s: string, x: number, y: number, color: string, size: number, align: 'left' | 'right'): void {
  const { pen, L } = f;
  const w = pen.textWidth(s, size);
  const x0 = align === 'right' ? x - w : x;
  const hh = size * 0.55 * L.u;
  const under = f.occ.hits(x0, y - hh, x0 + w, y + hh, 1) || f.sym.hits(x0, y - hh, x0 + w, y + hh);
  if (!under) {
    pen.text(s, x, y, color, size, align);
    return;
  }
  const g = pen.g;
  const a = g.globalAlpha;
  g.globalAlpha = a * COLUMN_DIM;
  pen.text(s, x, y, color, size, align);
  g.globalAlpha = a;
}

/* ───────────────────────── Flight path marker ───────────────────────── */

/** Computes the velocity vector (always) and draws the FPM in HMD mode. */
export function drawFpm(f: HudFrame): void {
  const p = f.p;
  const v = f.v1;
  const spd = p.velocity.length();
  if (spd > 15) v.copy(p.velocity).multiplyScalar(1 / spd);
  else forwardOf(p.quaternion, v);
  f.vHeading = headingOf(v);
  f.vPitch = elevationOf(v);
  f.proj.dir(v, f.fpm);
  if (f.mode !== 'hmd') return;
  const fp = f.fpm;
  if (!fp.front || fp.offAxis > 55 * DEG) return; // looking well away from the flight path
  const { pen, L, pal } = f;
  const u = L.u;
  // limit box for the FPM (keeps it off the cockpit panel and the edges)
  const x0 = L.cx - L.W * 0.3;
  const x1 = L.cx + L.W * 0.3;
  const y0 = L.tapeY + 44 * u;
  const y1 = Math.min(L.cockpitTop, L.H) - 14 * u;
  const limited = fp.x < x0 || fp.x > x1 || fp.y < y0 || fp.y > y1;
  const x = Math.max(x0, Math.min(x1, fp.x));
  const y = Math.max(y0, Math.min(y1, fp.y));
  const r = 6.5 * u;
  pen.setDash('solid');
  pen.begin();
  pen.circle(x, y, r);
  pen.line(x - r, y, x - r - 10 * u, y);
  pen.line(x + r, y, x + r + 10 * u, y);
  pen.line(x, y - r, x, y - r - 7 * u);
  if (limited) {
    const k = r * 0.8;
    pen.line(x - k, y - k, x + k, y + k);
    pen.line(x - k, y + k, x + k, y - k);
  }
  pen.strokeGlow(pal.main, 1.8);
  // protected: no text ever covers the flight path marker
  f.occ.addBox(x, y, r + 14 * u, r + 9 * u, 2);
  // ghost at the true position when it is still on screen (e.g. under the glare shield)
  if (limited && fp.onScreen) {
    pen.setDash('dot');
    pen.begin();
    pen.circle(fp.x, fp.y, r);
    pen.strokePlain(pal.dim, 1.4);
    pen.setDash('solid');
  }
}

/* ───────────────────────── Pitch ladder + horizon ───────────────────────── */

export function drawLadder(f: HudFrame): void {
  if (f.mode !== 'hmd') return;
  const { pen, proj, L, pal } = f;
  const u = L.u;
  const a = f.sp;
  const b = f.sp2;
  const vp = f.vPitch * RAD;
  const gap = 20 * u;
  const len = 46 * u;
  const tick = 7 * u;
  // declutter (real F-35 HMD style) while pulling hard or defending a missile: horizon + the two
  // nearest rungs only
  const busy = f.p.flight.gLoad > 4 || f.p.incoming.length > 0;
  const window = busy ? 5 : 16;
  const margin = -40;
  const occ = f.occ;
  // never up into the heading tape band
  const g = pen.g;
  g.save();
  g.beginPath();
  g.rect(0, tapeBottom(f), L.W, L.H);
  g.clip();

  // horizon line across the view (conformal, around the camera heading)
  const ch = headingOf(proj.forward);
  dirFromHeadingPitch(ch - 0.3, 0, f.v2);
  dirFromHeadingPitch(ch + 0.3, 0, f.v3);
  if (proj.dir(f.v2, a) && proj.dir(f.v3, b)) {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const l = Math.hypot(dx, dy);
    if (l > 1) {
      dx /= l;
      dy /= l;
      // gap centred on the flight-path heading when visible
      dirFromHeadingPitch(f.vHeading, 0, f.v2);
      let gx = NaN;
      let gy = NaN;
      if (proj.dir(f.v2, a) && a.onScreen) {
        gx = a.x;
        gy = a.y;
      }
      // long horizon line, but kept inside the band between the speed / altitude columns
      const ext = Math.max(120 * u, Math.min(L.W * 0.3, (L.altLeft - L.spdRight) * 0.62));
      pen.setDash('solid');
      pen.begin();
      if (Number.isFinite(gx)) {
        const hg = 34 * u;
        knockLine(f, gx - dx * ext, gy - dy * ext, gx - dx * hg, gy - dy * hg);
        knockLine(f, gx + dx * hg, gy + dy * hg, gx + dx * ext, gy + dy * ext);
      } else {
        // flight path off-screen: horizon through the point nearest the screen centre
        const t = (L.cx - b.x) * dx + (L.cy - b.y) * dy;
        const mx = b.x + dx * t;
        const my = b.y + dy * t;
        knockLine(f, mx - dx * ext, my - dy * ext, mx + dx * ext, my + dy * ext);
      }
      pen.strokeGlow(pal.main, 1.5);
    }
  }

  // rungs every 5°, only in a window around the flight path pitch
  const lo = Math.max(-85, Math.ceil((vp - window) / 5) * 5);
  const hi = Math.min(85, Math.floor((vp + window) / 5) * 5);
  for (let pass = 0; pass < 2; pass++) {
    const positive = pass === 0;
    pen.setDash(positive ? 'solid' : 'dash');
    pen.begin();
    let any = false;
    for (let th = lo; th <= hi; th += 5) {
      if (th === 0 || th > 0 !== positive) continue;
      if (!rung(f, th, a, b, margin)) continue;
      any = true;
      const tx = b.x;
      const ty = b.y;
      const nx = ty;
      const ny = -tx;
      const s = th > 0 ? -1 : 1; // end ticks point toward the horizon
      for (let side = -1; side <= 1; side += 2) {
        const ix = a.x + tx * gap * side;
        const iy = a.y + ty * gap * side;
        const ox = a.x + tx * (gap + len) * side;
        const oy = a.y + ty * (gap + len) * side;
        // knocked out under any text / target symbology (not the FPM, which sits on the ladder)
        if (occ.hits(ix, iy - 1, ox, oy + 1, 0, 1)) continue;
        pen.line(ix, iy, ox, oy);
        pen.line(ix, iy, ix + nx * tick * s, iy + ny * tick * s);
      }
    }
    if (any) pen.strokeGlow(pal.main, 1.5);
  }
  pen.setDash('solid');
  // numbers
  for (let th = lo; th <= hi; th += 5) {
    if (th === 0 || th % 10 !== 0) continue;
    if (!rung(f, th, a, b, margin)) continue;
    const ang = Math.atan2(b.y, b.x);
    const label = INT_STR[Math.abs(th)];
    for (let side = -1; side <= 1; side += 2) {
      const d = gap + len + 13 * u;
      const nxp = a.x + b.x * d * side;
      const nyp = a.y + b.y * d * side;
      if (occ.hits(nxp - 9 * u, nyp - 7 * u, nxp + 9 * u, nyp + 7 * u, 0, 1)) continue;
      pen.textRotated(label, nxp, nyp, ang, pal.main, 11);
    }
  }
  g.restore();
  pen.reset();
  pen.baseTransform();
}

/** Add a line to the current path in 8 pieces, leaving out the pieces under text / the target box. */
function knockLine(f: HudFrame, x0: number, y0: number, x1: number, y1: number): void {
  const n = 8;
  for (let i = 0; i < n; i++) {
    const ax = x0 + ((x1 - x0) * i) / n;
    const ay = y0 + ((y1 - y0) * i) / n;
    const bx = x0 + ((x1 - x0) * (i + 1)) / n;
    const by = y0 + ((y1 - y0) * (i + 1)) / n;
    if (f.occ.hits(ax, ay - 1, bx, by + 1, 0, 1)) continue;
    f.pen.line(ax, ay, bx, by);
  }
}

/**
 * Projects the rung at pitch `th` (deg) centred on the flight-path heading into `a` and writes the
 * rung's unit screen tangent into b.x / b.y. Returns false if not drawable.
 */
function rung(f: HudFrame, th: number, a: HudFrame['sp'], b: HudFrame['sp'], margin: number): boolean {
  const { proj } = f;
  dirFromHeadingPitch(f.vHeading, th * DEG, f.v2);
  if (!proj.dir(f.v2, a, margin) || !a.onScreen) return false;
  dirFromHeadingPitch(f.vHeading + 0.02, th * DEG, f.v3);
  if (!proj.dir(f.v3, b)) return false;
  let tx = b.x - a.x;
  let ty = b.y - a.y;
  const l = Math.hypot(tx, ty);
  if (l < 1e-3) return false;
  tx /= l;
  ty /= l;
  b.x = tx;
  b.y = ty;
  // keep rungs out of the cockpit panel area
  return a.y < f.L.cockpitTop - 6 && a.y > tapeBottom(f) + 4 * f.L.u;
}

/* ───────────────────────── Bank scale + waterline ───────────────────────── */

const BANK_TICKS = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60];
/** Pieces the bank arc is tested in against the protected symbols (3° each). */
const BANK_STEPS = 40;

/** Bank scale radius, or 0 when it is not drawn this frame. */
function bankRadius(f: HudFrame): number {
  if (f.mode !== 'hmd') return 0;
  forwardOf(f.p.quaternion, f.v1);
  if (f.proj.forward.dot(f.v1) < Math.cos(28 * DEG)) return 0;
  const L = f.L;
  return Math.max(60 * L.u, Math.min(L.H * 0.25, L.cockpitTop - L.cy - 16 * L.u));
}

/**
 * Reserve the bank-scale arc (three boxes along it, not its empty inside) so the cue line and centre
 * message sit inside the arc instead of on it ("FIGHTS ON" over the arc).
 */
export function reserveBankScale(f: HudFrame): void {
  if (!bankScaleRects(f)) return;
  for (let i = 0; i < 12; i += 4) f.occ.add(bankRects[i], bankRects[i + 1], bankRects[i + 2], bankRects[i + 3]);
}

const bankRects = new Float32Array(12);

/** The three boxes along the bank-scale arc into `bankRects` (false when it is not drawn this frame). */
function bankScaleRects(f: HudFrame): boolean {
  const R = bankRadius(f);
  if (R <= 0) return false;
  const L = f.L;
  const u = L.u;
  const cx = L.cx;
  const cy = L.cy;
  const t = 9 * u;
  const b = bankRects;
  // bottom (±30° around the nadir), then the two flanks (30°..60° from it)
  b[0] = cx - R * 0.5 - t; b[1] = cy + R * 0.866 - 3 * u; b[2] = cx + R * 0.5 + t; b[3] = cy + R + t;
  b[4] = cx - R * 0.866 - t; b[5] = cy + R * 0.5 - t; b[6] = cx - R * 0.5; b[7] = cy + R * 0.866 + t;
  b[8] = cx + R * 0.5; b[9] = cy + R * 0.5 - t; b[10] = cx + R * 0.866 + t; b[11] = cy + R * 0.866 + t;
  return true;
}

const noseSp = makeScreenPoint();

/**
 * Does the rect [ax, bx] × [ay, by] touch the bank-scale arc or the aircraft waterline? Both are drawn
 * last (with the ladder) and reserved late or not at all, so a block placed before them (the off-screen
 * target cue) asks here (#62: the cue's type label on the bank arc, its angle-off on the waterline).
 */
export function hitsBankOrWaterline(f: HudFrame, ax: number, ay: number, bx: number, by: number): boolean {
  if (f.mode !== 'hmd') return false;
  if (bankScaleRects(f)) {
    for (let i = 0; i < 12; i += 4) {
      if (ax < bankRects[i + 2] && bx > bankRects[i] && ay < bankRects[i + 3] && by > bankRects[i + 1]) return true;
    }
  }
  forwardOf(f.p.quaternion, f.v1);
  if (!f.proj.dir(f.v1, noseSp) || !noseSp.onScreen) return false;
  const u = f.L.u;
  return ax < noseSp.x + 17 * u && bx > noseSp.x - 17 * u && ay < noseSp.y + 7 * u && by > noseSp.y - 2 * u;
}

export function drawBankScale(f: HudFrame): void {
  if (f.mode !== 'hmd') return;
  const { pen, L, pal, proj, p } = f;
  // only when looking roughly along the nose
  forwardOf(p.quaternion, f.v1);
  if (proj.forward.dot(f.v1) < Math.cos(28 * DEG)) return;
  const u = L.u;
  const cx = L.cx;
  const cy = L.cy;
  const R = Math.max(60 * u, Math.min(L.H * 0.25, L.cockpitTop - cy - 16 * u));
  pen.setDash('solid');
  pen.begin();
  // the arc and its ticks break under the protected symbols (the target box and its labels, the
  // pipper, the incoming-missile TTIs): the arc ran through the target box (playtest 1.2-o)
  const occ = f.occ;
  let run0 = NaN;
  for (let i = 0; i <= BANK_STEPS; i++) {
    const a = Math.PI / 2 - 60 * DEG + (i * 120 * DEG) / BANK_STEPS;
    let free = i < BANK_STEPS;
    if (free) {
      const b = a + (120 * DEG) / BANK_STEPS;
      const x0 = cx + Math.cos(a) * R;
      const y0 = cy + Math.sin(a) * R;
      const x1 = cx + Math.cos(b) * R;
      const y1 = cy + Math.sin(b) * R;
      free = !occ.hits(Math.min(x0, x1) - 1, Math.min(y0, y1) - 1, Math.max(x0, x1) + 1, Math.max(y0, y1) + 1, 1, 1);
    }
    if (free && !Number.isFinite(run0)) run0 = a;
    else if (!free && Number.isFinite(run0)) {
      pen.arc(cx, cy, R, run0, a);
      run0 = NaN;
    }
  }
  for (const t of BANK_TICKS) {
    const ang = Math.PI / 2 + t * DEG;
    const major = t % 30 === 0;
    const r2 = R + (major ? 8 : 4.5) * u;
    const ax = cx + Math.cos(ang) * R;
    const ay = cy + Math.sin(ang) * R;
    const bx = cx + Math.cos(ang) * r2;
    const by = cy + Math.sin(ang) * r2;
    if (occ.hits(Math.min(ax, bx) - 1, Math.min(ay, by) - 1, Math.max(ax, bx) + 1, Math.max(ay, by) + 1, 1, 1)) continue;
    pen.line(ax, ay, bx, by);
  }
  pen.strokeGlow(pal.dim, 1.3);
  // pointer (ground direction)
  const roll = Math.max(-Math.PI, Math.min(Math.PI, p.flight.roll));
  const pa = Math.PI / 2 - roll;
  if (Math.abs(roll) < 75 * DEG) {
    const px = cx + Math.cos(pa) * (R - 1.5 * u);
    const py = cy + Math.sin(pa) * (R - 1.5 * u);
    pen.begin();
    pen.arrow(px, py, Math.cos(pa), Math.sin(pa), 8 * u, 4.5 * u);
    pen.strokeGlow(pal.main, 1.5);
  }
}

/**
 * Reserve the aircraft waterline ("W") as a protected symbol (level 2, like the FPM: text dodges it, the
 * ladder runs through it). Drawn last, it went unregistered and REL n / SHOOT printed into its notch
 * (playtest 1.2-k).
 */
export function reserveWaterline(f: HudFrame): void {
  if (f.mode !== 'hmd') return;
  forwardOf(f.p.quaternion, f.v1);
  if (!f.proj.dir(f.v1, noseSp) || !noseSp.onScreen || noseSp.y > f.L.cockpitTop - 8) return;
  const u = f.L.u;
  f.occ.add(noseSp.x - 18 * u, noseSp.y - 3 * u, noseSp.x + 18 * u, noseSp.y + 8 * u, 2);
}

/** Aircraft waterline ("W") at the nose direction. */
export function drawWaterline(f: HudFrame): void {
  if (f.mode !== 'hmd') return;
  const { pen, proj, L, pal, p } = f;
  forwardOf(p.quaternion, f.v1);
  if (!proj.dir(f.v1, f.sp) || !f.sp.onScreen || f.sp.y > L.cockpitTop - 8) return;
  const u = L.u;
  const x = f.sp.x;
  const y = f.sp.y;
  pen.setDash('solid');
  pen.begin();
  const g = pen.g;
  g.moveTo(x - 15 * u, y);
  g.lineTo(x - 8 * u, y);
  g.lineTo(x - 4 * u, y + 5 * u);
  g.lineTo(x, y);
  g.lineTo(x + 4 * u, y + 5 * u);
  g.lineTo(x + 8 * u, y);
  g.lineTo(x + 15 * u, y);
  pen.strokeGlow(pal.dim, 1.4);
}

/* ───────────────────────── Heading tape ───────────────────────── */

/**
 * Heading tape, its waypoint bearing caret and, when `next` is given (the steering waypoint's diamond
 * had no room for its name: targets.ts nextWaypointText), the waypoint's name left of the heading box
 * and its distance right of it, inside the tape's reserved zone.
 */
export function drawHeadingTape(f: HudFrame, wpBearing: number | null, next: { name: string; dist: string } | null = null): void {
  const { pen, L, pal, p } = f;
  const u = L.u;
  const hdg = ((p.flight.heading * RAD) % 360 + 360) % 360;
  const cx = L.cx;
  const halfW = L.tapeHalfW;
  const span = 30;
  const ppd = halfW / span;
  const y1 = L.tapeY + 25 * u;
  // ticks
  pen.setDash('solid');
  pen.begin();
  const start = Math.ceil((hdg - span) / 5) * 5;
  for (let d = start; d <= hdg + span; d += 5) {
    const x = cx + (d - hdg) * ppd;
    const major = ((d % 10) + 10) % 10 === 0;
    pen.line(x, y1, x, y1 + (major ? 7 : 4) * u);
  }
  pen.strokeGlow(pal.main, 1.4);
  for (let d = Math.ceil((hdg - span + 4) / 10) * 10; d <= hdg + span - 4; d += 10) {
    const x = cx + (d - hdg) * ppd;
    if (Math.abs(x - cx) < 20 * u) continue; // hidden behind the heading box
    const idx = (((d / 10) % 36) + 36) % 36;
    pen.text(HDG_STR[idx], x, y1 + 16 * u, pal.main, 11);
  }
  // index caret + heading box
  const bw = 46 * u;
  const bh = 19 * u;
  pen.box(cx - bw / 2, L.tapeY, bw, bh, pal.main, 1.5, pal.back);
  pen.text(HDG3_STR[Math.round(hdg) % 360], cx, L.tapeY + bh / 2 + 0.5, pal.main, 14);
  if (next) {
    const room = halfW - bw / 2 - 8 * u;
    let name = next.name;
    if (pen.textWidth(name, 11) > room) {
      while (name.length > 3 && pen.textWidth(`${name}…`, 11) > room) name = name.slice(0, -1).trimEnd();
      name = `${name}…`;
    }
    pen.text(name, cx - bw / 2 - 8 * u, L.tapeY + bh / 2 + 0.5, pal.main, 11, 'right');
    pen.text(next.dist, cx + bw / 2 + 8 * u, L.tapeY + bh / 2 + 0.5, pal.dim, 11, 'left');
  }
  pen.begin();
  pen.line(cx, L.tapeY + bh, cx, y1 + 3 * u);
  pen.strokeGlow(pal.main, 1.4);
  // waypoint bearing caret
  if (wpBearing !== null) {
    const rel = wrapPi(wpBearing - p.flight.heading) * RAD;
    const clamped = Math.abs(rel) > span;
    const x = cx + Math.max(-span, Math.min(span, rel)) * ppd;
    const y = y1 + 26 * u;
    pen.begin();
    pen.arrow(x, y - 5 * u, 0, -1, 7 * u, 5 * u);
    if (clamped) pen.strokeGlow(pal.main, 1.4);
    else {
      pen.strokeGlow(pal.main, 1.4);
      pen.fillPlain(pal.main);
    }
  }
}

/* ───────────────────────── Airspeed / altitude columns ───────────────────────── */

export function drawSpeedColumn(f: HudFrame): void {
  const { pen, L, pal, p } = f;
  const u = L.u;
  const fl = p.flight;
  const right = L.spdRight;
  const cw = pen.charWidth(16);
  const bw = cw * 4 + 12 * u;
  const bh = 22 * u;
  const by = L.boxY;
  pen.box(right - bw, by - bh / 2, bw, bh, pal.main, 1.6, pal.back);
  pen.text(txt.kcas.get(Math.max(0, toKnots(fl.ias))), right - 6 * u, by + 0.5, pal.main, 16, 'right');
  // limit-only rows (Mach and max G are gone: owner, 2026-10-06)
  const now = f.st.clock;
  if (held.owner !== p.id) {
    held.owner = p.id;
    held.g = held.aoa = -Infinity;
  }
  if (gOver(fl)) held.g = now;
  if (aoaOver(p)) held.aoa = now;
  const r = speedRows(f);
  let y = by + bh / 2 + L.line * 0.75;
  if (r.g) {
    const gCol = fl.gLoad > 8.5 || fl.gLoad < -2.5 ? pal.warn : pal.main;
    colText(f, txt.g.get(fl.gLoad), right, y, gCol, 12.5, 'right');
    y += L.line;
  }
  if (r.aoa) {
    const aoaDeg = fl.alpha * RAD;
    const stall = fl.stalled || p.warnings.has('stall');
    const aoaCol = stall ? pal.danger : aoaDeg > AOA_SHOW ? pal.warn : pal.main;
    if (!(stall && !blink(f, 3))) colText(f, txt.aoa.get(aoaDeg), right, y, aoaCol, 12.5, 'right');
    y += L.line;
  }
  // throttle / afterburner
  if (r.thr) {
    const thr = p.input.throttle;
    if (inAfterburner(p)) {
      const stage = Math.max(1, Math.min(5, Math.ceil(((thr - AB_DETENT) / (1 - AB_DETENT)) * 5)));
      colText(f, AB_STR[stage], right, y, pal.warn, 13, 'right');
    } else {
      colText(f, txt.thr.get((thr / AB_DETENT) * 100), right, y, pal.main, 12, 'right');
    }
    y += L.line;
  }
  // fuel (klb), from joker: amber at joker, red at bingo (playtest 1.2-h: the only fuel cue was the BINGO chip)
  if (r.fuel) {
    const ff = fuelFraction(p);
    colText(f, txt.fuel.get((fl.fuel * KG_TO_LB) / 1000), right, y, ff < BINGO_FRACTION ? pal.danger : pal.warn, 12, 'right');
    y += L.line;
  }
  if (r.brake) colText(f, 'SPD BRK', right, y, pal.main, 11.5, 'right');
}

const KG_TO_LB = 2.20462;

/** Fuel left as a share of the jet's internal fuel. */
export function fuelFraction(p: HudFrame['p']): number {
  const cap = AIRCRAFT_PERF[p.type]?.internalFuel ?? 0;
  return cap > 0 ? p.flight.fuel / cap : 1;
}

const AB_STR = ['AB', 'AB 1', 'AB 2', 'AB 3', 'AB 4', 'AB 5'];

export function drawAltColumn(f: HudFrame): void {
  const { pen, L, pal, p } = f;
  const u = L.u;
  const fl = p.flight;
  const left = L.altLeft;
  const cw = pen.charWidth(16);
  const bw = cw * 6 + 12 * u;
  const bh = 22 * u;
  const by = L.boxY;
  const altFt = Math.max(0, toFeet(fl.altitude));
  pen.box(left, by - bh / 2, bw, bh, pal.main, 1.6, pal.back);
  pen.text(txt.alt.get(Math.round(altFt / 10) * 10), left + bw - 6 * u, by + 0.5, pal.main, 16, 'right');
  let y = by + bh / 2 + L.line * 0.75;
  const aglFt = toFeet(fl.agl);
  // radar altitude: low, or descending toward the ground (owner, 2026-10-06; it read as a range beside
  // the target data at 2,500 ft in level flight)
  if (raltShown(p)) {
    const low = aglFt < 500 && fl.verticalSpeed < -2;
    if (!(low && !blink(f, 2.5))) colText(f, txt.ralt.get(Math.max(0, Math.round(aglFt / 10) * 10)), left, y, low ? pal.warn : pal.main, 12.5, 'left');
    y += L.line;
  }
  const vvi = toFpm(fl.verticalSpeed);
  const vq = Math.round(vvi / 50) * 50;
  const vs = txt.vvi.get(vq);
  colText(f, vq > 0 ? '+' + vs : vs, left, y, pal.main, 12, 'left');
  y += L.line;
  // target data (closure, angels, aspect)
  const t = f.target;
  if (t && t.kind === 'aircraft') {
    const vc = f.zone ? f.zone.closure : closureOf(f);
    colText(f, txt.vc.get(toKnots(vc)), left, y, pal.main, 12, 'left');
    y += L.line;
    const angels = Math.max(0, Math.round(toFeet(t.position.y) / 1000));
    colText(f, aspectText(f, angels), left, y, pal.main, 12, 'left');
  }
}

function closureOf(f: HudFrame): number {
  const t = f.target!;
  const r = f.v1.subVectors(t.position, f.p.position);
  const d = r.length();
  if (d < 1) return 0;
  return -f.v2.subVectors(t.velocity, f.p.velocity).dot(r) / d;
}

let aspKey = '';
let aspStr = '';
function aspectText(f: HudFrame, angels: number): string {
  const t = f.target!;
  const r = f.v1.subVectors(f.p.position, t.position); // target → us
  const d = r.length();
  const vt = f.v2.copy(t.velocity);
  const sp = vt.length();
  let asp = 0;
  let side = '';
  if (d > 1 && sp > 1) {
    // aspect: 0 = we see its tail, 180 = nose-on
    const cos = vt.dot(r) / (sp * d);
    asp = 180 - Math.acos(Math.max(-1, Math.min(1, cos))) * RAD;
    const cy = vt.z * r.x - vt.x * r.z; // (vt × r).y
    side = cy > 0 ? 'L' : 'R';
  }
  const a10 = Math.round(asp / 10);
  const key = angels + '|' + a10 + side;
  if (key !== aspKey) {
    aspKey = key;
    aspStr = 'A' + angels + ' ' + (a10 === 0 || a10 === 18 ? String(a10) : a10 + side);
  }
  return aspStr;
}
