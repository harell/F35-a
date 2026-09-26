/**
 * Flight symbology: flight path marker (velocity vector) + ghost, conformal pitch ladder and horizon
 * line, bank scale, aircraft waterline, heading tape with waypoint caret, airspeed / altitude columns.
 */
import { DEG, RAD, dirFromHeadingPitch, elevationOf, forwardOf, headingOf, toFeet, toFpm, toKnots, wrapPi } from '../../core/math';
import { AB_DETENT } from '../../core/types';
import { HDG_STR, HDG3_STR, INT_STR, NumText } from './format';
import { blink, type HudFrame } from './frame';

const txt = {
  kcas: new NumText(0),
  mach: new NumText(2, 'M '),
  g: new NumText(1, 'G '),
  gmax: new NumText(1),
  aoa: new NumText(1, 'α '),
  alt: new NumText(0, '', '', true),
  ralt: new NumText(0, 'R '),
  vvi: new NumText(0),
  thr: new NumText(0, 'THR ', '%'),
  vc: new NumText(0, 'Vc '),
};

/** Session max G (reset when the player changes). */
let maxG = 1;
let maxGOwner = -1;

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
  const window = 16;
  const margin = -40;

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
        pen.line(gx - dx * ext, gy - dy * ext, gx - dx * hg, gy - dy * hg);
        pen.line(gx + dx * hg, gy + dy * hg, gx + dx * ext, gy + dy * ext);
      } else {
        // flight path off-screen: horizon through the point nearest the screen centre
        const t = (L.cx - b.x) * dx + (L.cy - b.y) * dy;
        const mx = b.x + dx * t;
        const my = b.y + dy * t;
        pen.line(mx - dx * ext, my - dy * ext, mx + dx * ext, my + dy * ext);
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
      pen.textRotated(label, a.x + b.x * d * side, a.y + b.y * d * side, ang, pal.main, 11);
    }
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
  return a.y < f.L.cockpitTop - 6 && a.y > f.L.tapeY + 40 * f.L.u;
}

/* ───────────────────────── Bank scale + waterline ───────────────────────── */

const BANK_TICKS = [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60];

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
  pen.arc(cx, cy, R, Math.PI / 2 - 60 * DEG, Math.PI / 2 + 60 * DEG);
  for (const t of BANK_TICKS) {
    const ang = Math.PI / 2 + t * DEG;
    const major = t % 30 === 0;
    const r2 = R + (major ? 8 : 4.5) * u;
    pen.line(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R, cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2);
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

export function drawHeadingTape(f: HudFrame, wpBearing: number | null): void {
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
  let y = by + bh / 2 + L.line * 0.75;
  pen.text(txt.mach.get(fl.mach), right, y, pal.main, 12.5, 'right');
  y += L.line;
  // G and max G
  if (p.id !== maxGOwner) {
    maxGOwner = p.id;
    maxG = 1;
  }
  if (!f.ctx.paused) maxG = Math.max(maxG, fl.gLoad);
  const gCol = fl.gLoad > 8.5 || fl.gLoad < -2.5 ? pal.warn : pal.main;
  pen.text(txt.g.get(fl.gLoad), right, y, gCol, 12.5, 'right');
  y += L.line;
  pen.text(txt.gmax.get(maxG), right, y, pal.dim, 11.5, 'right');
  y += L.line;
  const aoaDeg = fl.alpha * RAD;
  const stall = fl.stalled || f.p.warnings.has('stall');
  const aoaCol = stall ? pal.danger : aoaDeg > 20 ? pal.warn : pal.main;
  if (!(stall && !blink(f, 3))) pen.text(txt.aoa.get(aoaDeg), right, y, aoaCol, 12.5, 'right');
  y += L.line;
  // throttle / afterburner
  const thr = p.input.throttle;
  if (fl.afterburner > 0.02 || thr > AB_DETENT + 0.01) {
    const stage = Math.max(1, Math.min(5, Math.ceil(((thr - AB_DETENT) / (1 - AB_DETENT)) * 5)));
    pen.text(AB_STR[stage], right, y, pal.warn, 13, 'right');
  } else {
    pen.text(txt.thr.get((thr / AB_DETENT) * 100), right, y, pal.main, 12, 'right');
  }
  if (p.input.airbrake || fl.surfaces.airbrake > 0.2) {
    y += L.line;
    pen.text('SPD BRK', right, y, pal.main, 11.5, 'right');
  }
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
  if (aglFt < 5000) {
    const low = aglFt < 500 && fl.verticalSpeed < -2;
    if (!(low && !blink(f, 2.5))) pen.text(txt.ralt.get(Math.max(0, Math.round(aglFt / 10) * 10)), left, y, low ? pal.warn : pal.main, 12.5, 'left');
    y += L.line;
  }
  const vvi = toFpm(fl.verticalSpeed);
  const vq = Math.round(vvi / 50) * 50;
  const vs = txt.vvi.get(vq);
  pen.text(vq > 0 ? '+' + vs : vs, left, y, pal.main, 12, 'left');
  y += L.line;
  // target data (closure, angels, aspect)
  const t = f.target;
  if (t && t.kind === 'aircraft') {
    const vc = f.zone ? f.zone.closure : closureOf(f);
    pen.text(txt.vc.get(toKnots(vc)), left, y, pal.main, 12, 'left');
    y += L.line;
    const angels = Math.max(0, Math.round(toFeet(t.position.y) / 1000));
    pen.text(aspectText(f, angels), left, y, pal.main, 12, 'left');
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
