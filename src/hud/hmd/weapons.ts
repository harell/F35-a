/**
 * Weapon symbology: status block (master mode, selected weapon + count, countermeasures, EMCON,
 * release denials), DLZ scale with target caret / time of flight, SHOOT cue, AIM-9X seeker circle,
 * gun LCOS pipper + EEGS funnel, bomb CCIP pipper and JDAM/SDB release cue (azimuth steering line,
 * time to release, IN RNG).
 */
import { DEG, G, dirFromHeadingPitch, forwardOf, rightOf, toKnots, upOf } from '../../core/math';
import type { WeaponId } from '../../core/types';
import { dlzLayout, makeDlzGeometry } from './dlz';
import { INT_STR, NumText, WEAPON_BREVITY, WEAPON_HUD, WEAPON_IS_AG } from './format';
import { blink, type HudFrame } from './frame';
import { withAlpha } from './palette';

const dlzGeom = makeDlzGeometry();
const tofTxt = new NumText(0, 'TOF ');
const vcTxt = new NumText(0);
const relTxt = new NumText(0, 'REL ');
const flTxt = new NumText(0, 'FL ');
const chTxt = new NumText(0, 'CH ');

const weaponLine: Record<string, string> = {};
function weaponLabel(w: WeaponId, n: number): string {
  const key = w + n;
  let s = weaponLine[key];
  if (!s) weaponLine[key] = s = WEAPON_HUD[w] + ' ' + (n < 400 ? INT_STR[n] : String(n));
  return s;
}

export function remainingOf(f: HudFrame, w: WeaponId): number {
  if (w === 'gun') return f.p.gunAmmo;
  try {
    return f.world.combat.remaining(f.p, w);
  } catch {
    let n = 0;
    for (const s of f.p.stores) if (s.weapon === w) n += s.count;
    return n;
  }
}

/* ───────────────────────── Weapon status block ───────────────────────── */

/** Master mode: A-G with an air-to-ground store selected, A-A with a target or hostile air track, else NAV. */
export function masterMode(f: HudFrame): 'A-A' | 'A-G' | 'NAV' {
  const p = f.p;
  if (WEAPON_IS_AG[p.selectedWeapon]) return 'A-G';
  if (f.target) return 'A-A';
  for (const c of p.radar.contacts) {
    if (c.team === p.team) continue;
    const e = f.world.getEntity(c.id);
    if (e && e.alive && e.kind === 'aircraft') return 'A-A';
  }
  return 'NAV';
}

export function drawWeaponBlock(f: HudFrame, x: number, y: number, compact = false): number {
  const { pen, pal, L, p, st } = f;
  const u = L.u;
  const w = p.selectedWeapon;
  const ag = WEAPON_IS_AG[w];
  const n = remainingOf(f, w);
  if (!compact) {
    pen.text(masterMode(f), x, y, pal.main, 13, 'left');
    y += L.line;
  }
  // selected weapon (flashes briefly after a change; amber when empty)
  const label = weaponLabel(w, n);
  const fresh = st.weaponAge < 0.9;
  const col = n === 0 ? pal.warn : fresh ? pal.bright : pal.main;
  if (fresh) {
    const tw = pen.textWidth(label, 14) + 8 * u;
    pen.box(x - 4 * u, y - 9 * u, tw, 18 * u, pal.bright, 1.4, pal.back);
  }
  pen.text(label, x, y, col, 14, 'left');
  y += L.line + 1;
  if (!compact) {
    // gun rounds as a secondary line when a missile/bomb is selected
    if (w !== 'gun') {
      pen.text(weaponLabel('gun', p.gunAmmo), x, y, pal.dim, 11.5, 'left');
      y += L.line * 0.9;
    }
    const fl = flTxt.get(p.flares);
    const ch = chTxt.get(p.chaff);
    pen.text(fl, x, y, p.flares <= 4 ? pal.warn : pal.main, 11.5, 'left');
    pen.text(ch, x + pen.textWidth(fl, 11.5) + 8 * u, y, p.chaff <= 4 ? pal.warn : pal.main, 11.5, 'left');
    y += L.line * 0.9;
  }
  if (!p.radar.emitting) {
    pen.text('EMCON', x, y, pal.warn, 12, 'left');
    y += L.line * 0.9;
  }
  if (p.bayDoors > 0.05 && !compact) {
    pen.text('BAY OPEN', x, y, pal.dim, 11, 'left');
    y += L.line * 0.9;
  }
  if (st.deniedAge < 1.8 && st.deniedText) {
    if (blink(f, 4, 0.7)) pen.text(st.deniedText, x, y, pal.warn, 12.5, 'left');
    y += L.line;
  }
  return y;
}

/* ───────────────────────── DLZ ───────────────────────── */

export function drawDlz(f: HudFrame, x: number, top: number, bottom: number): void {
  const z = f.zone;
  if (!z || z.weapon === 'gun' || z.rMax <= 0) return;
  if (z.weapon === 'gbu31' || z.weapon === 'gbu39') return; // bombs use the release cue
  const { pen, pal, L, st } = f;
  const u = L.u;
  const g = dlzLayout(z, top, bottom, dlzGeom, st.dlzScale);
  st.dlzScale = g.scaleMax;
  const col = z.shoot ? pal.bright : pal.main;
  pen.setDash('solid');
  // scale top tick + label
  pen.begin();
  pen.line(x - 4 * u, top, x + 4 * u, top);
  // launch zone Rmin..Rmax
  pen.line(x, g.yMax, x, g.yMin);
  pen.line(x - 7 * u, g.yMax, x + 3 * u, g.yMax); // Rmax
  pen.line(x - 7 * u, g.yMin, x + 3 * u, g.yMin); // Rmin
  pen.strokeGlow(col, 1.6);
  // no-escape zone: thick bar Rmin..Rne
  pen.setFill(pal.outline);
  pen.g.fillRect(x - 5 * u, g.yNe - 1, 5 * u + 2, g.yMin - g.yNe + 2);
  pen.setFill(col);
  pen.g.fillRect(x - 4 * u, g.yNe, 3.5 * u, g.yMin - g.yNe);
  pen.text(INT_STR[g.scaleNm] ?? String(g.scaleNm), x, top - 9 * u, pal.dim, 10.5);
  // target caret with closure
  const cy = g.yRange;
  pen.begin();
  pen.arrow(x + 3 * u, cy, -1, 0, 9 * u, 5 * u);
  pen.strokeGlow(col, 1.5);
  if (!g.clamped) pen.fillPlain(col);
  pen.text(vcTxt.get(toKnots(z.closure)), x + 14 * u, cy, col, 11, 'left');
  // time of flight
  if (z.timeOfFlight > 0) pen.text(tofTxt.get(z.timeOfFlight), x, bottom + 11 * u, pal.main, 11);
}

/** SHOOT / IN RNG cue in the centre stack. Returns the next free y. */
export function drawShootCue(f: HudFrame, y: number): number {
  const { pen, pal, L } = f;
  const z = f.zone;
  if (z && z.shoot && z.weapon !== 'gbu31' && z.weapon !== 'gbu39') {
    if (blink(f, 4, 0.7)) {
      pen.text('SHOOT', L.cx, y, pal.bright, 20);
    }
    return y + 22 * L.u;
  }
  return y;
}

/* ───────────────────────── AIM-9X ───────────────────────── */

export function drawAim9x(f: HudFrame): void {
  if (f.p.selectedWeapon !== 'aim9x') return;
  const { pen, pal, L, proj, p } = f;
  const u = L.u;
  let ir: ReturnType<typeof f.world.combat.irSeekerState>;
  try {
    ir = f.world.combat.irSeekerState(p);
  } catch {
    return;
  }
  if (!ir || ir.state === 'off') return;
  const dir = ir.direction ?? forwardOf(p.quaternion, f.v1);
  if (!proj.dir(dir, f.sp) || !f.sp.onScreen) return;
  const x = f.sp.x;
  const y = f.sp.y;
  if (ir.state === 'locked') {
    const r = 17 * u + Math.sin(f.st.clock * 12) * 1.2 * u;
    pen.setDash('solid');
    pen.begin();
    pen.circle(x, y, r);
    pen.line(x - 5 * u, y, x + 5 * u, y);
    pen.line(x, y - 5 * u, x, y + 5 * u);
    pen.strokeGlow(pal.bright, 2);
    pen.text('TONE', x, y + r + 10 * u, pal.bright, 11);
  } else {
    // searching: dashed wobbling circle ("growl")
    const r = 24 * u + Math.sin(f.st.clock * 7) * 1.5 * u;
    pen.setDash('dash');
    pen.begin();
    pen.circle(x, y, r);
    pen.strokeGlow(pal.main, 1.6);
    pen.setDash('solid');
    pen.text('GROWL', x, y + r + 10 * u, pal.dim, 10.5);
  }
}

/* ───────────────────────── Gun ───────────────────────── */

const FUNNEL_RANGES = [150, 300, 450, 600, 800, 1000, 1250];
const funnelL = new Float32Array(FUNNEL_RANGES.length * 2);
const funnelR = new Float32Array(FUNNEL_RANGES.length * 2);
const GUN_EFFECTIVE = 1200;
const BULLET_SPEED = 1040;
const WINGSPAN = 11;

export function drawGun(f: HudFrame): void {
  if (f.p.selectedWeapon !== 'gun') return;
  const { pen, pal, L, proj, p } = f;
  const u = L.u;
  // EEGS funnel: bullet stream lags the nose rotation and drops with gravity
  const fwd = forwardOf(p.quaternion, f.v1);
  const fx = fwd.x, fy = fwd.y, fz = fwd.z;
  const up = upOf(p.quaternion, f.v2);
  const ux = up.x, uy = up.y, uz = up.z;
  const right = rightOf(p.quaternion, f.v3);
  const rx = right.x, ry = right.y, rz = right.z;
  const sp = f.sp;
  const own = p.velocity.length();
  const dir = f.v1;
  let n = 0;
  let prevX = NaN;
  let prevY = NaN;
  for (let i = 0; i < FUNNEL_RANGES.length; i++) {
    const r = FUNNEL_RANGES[i];
    const t = r / (BULLET_SPEED + own * 0.5);
    const aPitch = -p.rates.y * t;
    const aYaw = -p.rates.z * t;
    const drop = (0.5 * G * t * t) / r;
    dir.set(fx + ux * aPitch + rx * aYaw, fy + uy * aPitch + ry * aYaw - drop, fz + uz * aPitch + rz * aYaw).normalize();
    if (!proj.dir(dir, sp)) break;
    // perpendicular to the funnel centreline on screen; width = wingspan at that range
    const hw = (WINGSPAN / 2 / r) * proj.pxPerRad;
    let px = 1;
    let py = 0;
    if (Number.isFinite(prevX)) {
      const sx = sp.x - prevX;
      const sy = sp.y - prevY;
      const l = Math.hypot(sx, sy);
      if (l > 0.5) {
        px = -sy / l;
        py = sx / l;
        if (px < 0) {
          px = -px;
          py = -py;
        }
      }
    }
    funnelL[n * 2] = sp.x - px * hw;
    funnelL[n * 2 + 1] = sp.y - py * hw;
    funnelR[n * 2] = sp.x + px * hw;
    funnelR[n * 2 + 1] = sp.y + py * hw;
    prevX = sp.x;
    prevY = sp.y;
    n++;
  }
  if (n >= 2) {
    pen.setDash('solid');
    pen.begin();
    const g = pen.g;
    g.moveTo(funnelL[0], funnelL[1]);
    for (let i = 1; i < n; i++) g.lineTo(funnelL[i * 2], funnelL[i * 2 + 1]);
    g.moveTo(funnelR[0], funnelR[1]);
    for (let i = 1; i < n; i++) g.lineTo(funnelR[i * 2], funnelR[i * 2 + 1]);
    pen.strokeGlow(pal.dim, 1.4);
  }
  // gun cross at the gun line
  forwardOf(p.quaternion, f.v1);
  if (proj.dir(f.v1, sp) && sp.onScreen) {
    pen.begin();
    pen.line(sp.x - 6 * u, sp.y - 8 * u, sp.x + 6 * u, sp.y - 8 * u);
    pen.line(sp.x, sp.y - 14 * u, sp.x, sp.y - 2 * u);
    pen.strokeGlow(pal.main, 1.4);
  }
  // LCOS pipper at the lead point with a range bar
  let lead: ReturnType<typeof f.world.combat.gunLeadPoint> = null;
  try {
    lead = f.world.combat.gunLeadPoint(p, f.world);
  } catch {
    lead = null;
  }
  if (!lead || !proj.point(lead, sp) || !sp.onScreen) return;
  const x = sp.x;
  const y = sp.y;
  const R = 19 * u;
  const t = f.target;
  const range = t ? t.position.distanceTo(p.position) : GUN_EFFECTIVE * 2;
  const inRange = range < GUN_EFFECTIVE;
  const col = inRange ? pal.bright : pal.main;
  pen.begin();
  pen.circle(x, y, R);
  pen.strokeGlow(col, 1.8);
  pen.setFill(col);
  pen.g.fillRect(x - 1.6 * u, y - 1.6 * u, 3.2 * u, 3.2 * u);
  // range bar: arc from 12 o'clock, full circle = 2 km; tick at the effective range
  const frac = Math.max(0, Math.min(1, range / 2000));
  if (t) {
    pen.begin();
    pen.arc(x, y, R - 4 * u, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    pen.strokeGlow(col, 2.4);
  }
  const ta = -Math.PI / 2 + (GUN_EFFECTIVE / 2000) * Math.PI * 2;
  pen.begin();
  pen.line(x + Math.cos(ta) * (R + 1), y + Math.sin(ta) * (R + 1), x + Math.cos(ta) * (R + 6 * u), y + Math.sin(ta) * (R + 6 * u));
  pen.strokeGlow(pal.main, 1.4);
  if (inRange && t && blink(f, 4, 0.7)) pen.text('SHOOT', x, y + R + 12 * u, pal.bright, 13);
}

/* ───────────────────────── Air-to-ground ───────────────────────── */

export function drawAirToGround(f: HudFrame, stackY: number): number {
  const p = f.p;
  const w = p.selectedWeapon;
  if (w !== 'gbu31' && w !== 'gbu39') return stackY;
  const { pen, pal, L, proj } = f;
  const u = L.u;
  let bi: ReturnType<typeof f.world.combat.bombImpactPoint> = null;
  try {
    bi = f.world.combat.bombImpactPoint(p, f.world);
  } catch {
    bi = null;
  }
  if (!bi) return stackY;
  const gp = p.radar.groundPoint;
  if (gp) {
    // GPS weapon: azimuth steering line through the target bearing, release countdown
    const brg = Math.atan2(gp.x - p.position.x, -(gp.z - p.position.z));
    dirFromHeadingPitch(brg, f.vPitch + 7 * DEG, f.v1);
    dirFromHeadingPitch(brg, f.vPitch - 9 * DEG, f.v2);
    const a = f.sp;
    const b = f.sp2;
    if (proj.dir(f.v1, a) && proj.dir(f.v2, b) && (a.onScreen || b.onScreen)) {
      pen.setDash('solid');
      pen.begin();
      pen.line(a.x, a.y, b.x, b.y);
      pen.strokeGlow(bi.inRange ? pal.bright : pal.main, 1.8);
    }
    // target point marker (for designations without an entity box)
    if (proj.point(gp, a) && a.onScreen && !f.target) {
      pen.begin();
      pen.diamond(a.x, a.y, 9 * u);
      pen.strokeGlow(pal.main, 1.8);
    }
    if (bi.inRange) {
      if (blink(f, 3.5, 0.7)) pen.text('IN RNG', L.cx, stackY, pal.bright, 19);
    } else if (bi.timeToRelease >= 0) {
      pen.text(relTxt.get(Math.ceil(bi.timeToRelease)), L.cx, stackY, pal.main, 17);
    } else {
      pen.text('OUT RNG', L.cx, stackY, pal.warn, 15);
    }
    return stackY + 22 * u;
  }
  // CCIP: impact pipper + bomb fall line from the FPM
  if (!proj.point(bi.point, f.sp) || !f.sp.onScreen) {
    pen.text('CCIP', L.cx, stackY, pal.dim, 13);
    return stackY + 18 * u;
  }
  const x = f.sp.x;
  const y = f.sp.y;
  const col = bi.inRange ? pal.bright : pal.main;
  pen.setDash(bi.inRange ? 'solid' : 'dash');
  if (f.fpm.front && f.fpm.onScreen) {
    pen.begin();
    pen.line(f.fpm.x, f.fpm.y + 8 * u, x, y - 9 * u);
    pen.strokeGlow(pal.dim, 1.3);
  }
  pen.setDash('solid');
  pen.begin();
  pen.circle(x, y, 9 * u);
  pen.strokeGlow(col, 1.8);
  pen.setFill(col);
  pen.g.fillRect(x - 1.5 * u, y - 1.5 * u, 3 * u, 3 * u);
  if (bi.inRange && blink(f, 3.5, 0.7)) {
    pen.text('PICKLE', L.cx, stackY, pal.bright, 17);
    return stackY + 22 * u;
  }
  return stackY;
}

/** Brevity flash after a player release ("FOX 3"). */
export function drawBrevity(f: HudFrame, y: number): number {
  const { st, pen, pal, L } = f;
  if (st.brevityAge > 1.3 || !st.brevity) return y;
  const a = Math.max(0, Math.min(1, (1.3 - st.brevityAge) / 0.4));
  pen.g.globalAlpha = a;
  pen.text(st.brevity, L.cx, y, pal.white, 15);
  pen.g.globalAlpha = 1;
  return y + 18 * L.u;
}

export { WEAPON_BREVITY };
