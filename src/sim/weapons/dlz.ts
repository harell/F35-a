/**
 * F35-A — dynamic launch zones (DLZ), GPS release envelopes and CCIP.
 *
 * The DLZ integrates the same boost/sustain + ρv² drag model the missiles fly (1-D along the
 * line of sight, effective altitude = mean of shooter/target + loft bonus, gravity along the
 * climb angle) once per query (~200 cheap steps, no allocation), then reads:
 *   rMax  = max_t [ s(t) + v_tgt,closing · t ]    with missile speed ≥ minKillSpeed
 *   rNe   = max_t [ s(t) − v_run · t ]            target turns cold at max(v_tgt, 250) m/s
 *   tof   = first t where s(t) + v_tgt,closing · t ≥ range
 * so rMax grows with shooter altitude/speed and closure, and head-on > beam > tail.
 */
import { Vector3 } from 'three';
import { G, clamp, forwardOf } from '../../core/math';
import { airDensity } from '../../core/atmosphere';
import type { MunitionId, WeaponId } from '../../core/types';
import type { LaunchZone, SimWorld } from '../api';
import type { AircraftEntity, AnyEntity } from '../entities';
import type { CombatCtx } from './context';
import { acState } from './context';
import type { CombatMunitionDef } from './defs';
import { defaultMunitionFor, pickStation, remaining, stationMunition } from './loadouts';

const MAXN = 600;
const PT = new Float32Array(MAXN);
const PS = new Float32Array(MAXN);
const PV = new Float32Array(MAXN);
const PROFILE_DT = 0.2;

/** Integrate the 1-D energy model into PT/PS/PV. Returns the number of samples. */
export function buildProfile(def: CombatMunitionDef, v0: number, hEff: number, climbSin: number, eff: number): number {
  const rho = airDensity(hEff);
  const burnEnd = def.igniteDelay + def.boostTime + def.sustainTime;
  let v = Math.max(20, v0);
  let s = 0;
  let t = 0;
  let n = 0;
  const dt = PROFILE_DT;
  // leave margin for launch transients / loft path length vs the 3-D flight
  const tEnd = def.maxFlightTime * 0.9;
  while (t < tEnd && n < MAXN) {
    const tb = t - def.igniteDelay;
    let a = 0;
    if (tb >= 0 && tb < def.boostTime) a = def.boostAccel;
    else if (tb >= def.boostTime && tb < def.boostTime + def.sustainTime) a = def.sustainAccel;
    a -= (def.drag * rho * v * v) / eff;
    a -= G * climbSin;
    v = Math.max(1, v + a * dt);
    s += v * dt;
    t += dt;
    PT[n] = t;
    PS[n] = s;
    PV[n] = v;
    n++;
    if (t > burnEnd && v < def.minKillSpeed) break;
  }
  return n;
}

export interface ZoneGeometry {
  shooterPos: Vector3;
  shooterVel: Vector3;
  /** Shooter nose (unit) for off-boresight energy penalty (optional). */
  shooterFwd: Vector3 | null;
  targetPos: Vector3;
  targetVel: Vector3;
}

const _rel = new Vector3();
const _los = new Vector3();
const _fwd = new Vector3();

/** Scan the current profile for rMax / rNe / time of flight. */
function evaluateProfile(n: number, range: number, vTgtClosing: number, vCross: number, vNeed: number, vRun: number, out: LaunchZone): void {
  let rMax = 0;
  let tofMax = 0;
  let rNe = 0;
  let tof = -1;
  for (let i = 0; i < n; i++) {
    const t = PT[i];
    const s = PS[i];
    // intercept after t seconds if the target's future position is within s: |(R − vc·t, vx·t)| ≤ s
    const cross = vCross * t;
    if (s > cross && PV[i] >= vNeed) {
      const reach = vTgtClosing * t + Math.sqrt(s * s - cross * cross);
      if (reach > rMax) {
        rMax = reach;
        tofMax = t;
      }
      if (tof < 0 && reach >= range) tof = t;
    }
    if (PV[i] > vRun + 80) {
      const ne = s - vRun * t;
      if (ne > rNe) rNe = ne;
    }
  }
  // crossing targets force a curved lead pursuit as the missile decelerates: small penalty
  const crossFrac = vCross / Math.max(1, Math.hypot(vCross, vTgtClosing));
  rMax *= 1 - 0.15 * crossFrac;
  out.rMax = rMax;
  out.rNe = Math.min(rNe, rMax);
  out.timeOfFlight = tof >= 0 ? tof : tofMax;
}

/** Raw kinematic zone for a munition against a moving point target. Writes into `out`. */
export function kinematicZone(def: CombatMunitionDef, g: ZoneGeometry, out: LaunchZone): LaunchZone {
  _rel.subVectors(g.targetPos, g.shooterPos);
  const range = Math.max(1, _rel.length());
  _los.copy(_rel).divideScalar(range);
  const vTgtClosing = -g.targetVel.dot(_los); // + = target coming toward us
  const closure = g.shooterVel.dot(_los) + vTgtClosing;
  const hS = g.shooterPos.y;
  const hT = g.targetPos.y;
  // descending shots gain less than a straight dive would suggest (the missile lofts/levels first)
  let climbSin = clamp((hT - hS) / Math.max(range, 2_000), -0.6, 0.6);
  if (climbSin < 0) climbSin *= 0.5;
  const hMean = Math.max(0, 0.5 * (hS + hT));
  let eff = def.dlzEfficiency;
  let v0 = g.shooterVel.length();
  if (g.shooterFwd) {
    // missiles launched off-boresight must turn first: energy penalty
    const c = clamp(g.shooterFwd.dot(_los), -1, 1);
    eff *= 1 - 0.3 * (1 - c) * 0.5;
    v0 *= 0.5 + 0.5 * Math.max(0, c);
  }
  // target velocity split into the LOS component (toward us) and the cross-range component
  const vCross = Math.sqrt(Math.max(0, g.targetVel.lengthSq() - vTgtClosing * vTgtClosing));
  // in a tail chase the missile must still be faster than the target at intercept
  const vNeed = Math.max(def.minKillSpeed, -vTgtClosing + 60);
  const vRun = Math.max(g.targetVel.length(), 250);

  let n = buildProfile(def, v0, hMean, climbSin, eff);
  evaluateProfile(n, range, vTgtClosing, vCross, vNeed, vRun, out);
  // long shots are lofted into thinner air (same criterion as launchMunition)
  if (def.loft && (def.category === 'sam' || hT - hS < 3_000) && Math.max(out.rMax, range) > 0.4 * def.maxRange) {
    n = buildProfile(def, v0, hMean + 2_000, climbSin, eff);
    evaluateProfile(n, range, vTgtClosing, vCross, vNeed, vRun, out);
  }
  out.range = range;
  out.closure = closure;
  out.rMin = def.minRange + Math.max(0, closure) * def.armTime * 0.5;
  return out;
}

/* ───────────────────────── GPS glide envelope ───────────────────────── */

const gpsCache = new Map<number, number>();
const MUN_INDEX: Record<string, number> = { gbu31: 1, gbu39: 2 };

/**
 * Max horizontal reach (m) of a GPS glide weapon released level at `speed` from `height` above
 * the target (target elevation `targetAlt`). Same best-glide law as the in-flight guidance.
 */
export function gpsMaxRange(def: CombatMunitionDef, height: number, speed: number, targetAlt: number): number {
  if (height <= 10) return 0;
  const hq = Math.round(height / 150);
  const vq = Math.round(speed / 10);
  const aq = Math.round(Math.max(0, targetAlt) / 500);
  const key = ((MUN_INDEX[def.id] ?? 9) * 1000 + hq) * 100_000 + vq * 100 + aq;
  const hit = gpsCache.get(key);
  if (hit !== undefined) return hit;
  const glide = Math.atan(1 / Math.max(0.5, def.glideRatio * 0.75));
  const dx = Math.cos(glide);
  const dy = -Math.sin(glide);
  let x = 0;
  let y = hq * 150;
  let vx = vq * 10;
  let vy = 0;
  const dt = 0.25;
  let aLx = 0;
  let aLy = 0;
  const k = 1 - Math.exp(-dt / def.autopilotTau);
  for (let t = 0; t < def.maxFlightTime && y > 0; t += dt) {
    const v = Math.hypot(vx, vy);
    const hx = vx / v;
    const hy = vy / v;
    const rho = airDensity(targetAlt + y);
    const q = 0.5 * rho * v * v;
    const aMax = def.maxG * G * Math.min(1, q / def.fullGQ);
    const dot = dx * hx + dy * hy;
    let cx = (dx - hx * dot) * v * 1.2;
    let cy = (dy - hy * dot) * v * 1.2 + G * Math.cos(glide);
    const cd = cx * hx + cy * hy;
    cx -= hx * cd;
    cy -= hy * cd;
    const cl = Math.hypot(cx, cy);
    if (cl > aMax) {
      cx *= aMax / cl;
      cy *= aMax / cl;
    }
    aLx += (cx - aLx) * k;
    aLy += (cy - aLy) * k;
    const aL = Math.hypot(aLx, aLy);
    const axial = -def.drag * rho * v * v - aL / Math.max(0.3, def.glideRatio);
    vx += (hx * axial + aLx) * dt;
    vy += (hy * axial + aLy - G) * dt;
    x += vx * dt;
    y += vy * dt;
  }
  const r = Math.max(0, x * 0.93);
  gpsCache.set(key, r);
  return r;
}

/* ───────────────────────── CCIP ───────────────────────── */

const _p = new Vector3();
const _v = new Vector3();
const _down = new Vector3();

/**
 * Predict the ballistic impact point of an unguided bomb released `delay` seconds from now
 * (internal-bay door sequence). Returns false if none.
 */
export function ccipPoint(world: SimWorld, ac: AircraftEntity, def: CombatMunitionDef, out: Vector3, delay = 0): boolean {
  _down.set(0, -1, 0).applyQuaternion(ac.quaternion);
  _p.copy(ac.position).addScaledVector(ac.velocity, delay).addScaledVector(_down, 2);
  _v.copy(ac.velocity).addScaledVector(_down, def.ejectSpeed);
  const dt = 0.2;
  let prevY = _p.y;
  let prevH = world.terrain.heightAt(_p.x, _p.z);
  for (let t = 0; t < 80; t += dt) {
    const rho = airDensity(_p.y);
    const v = _v.length();
    _v.multiplyScalar(Math.max(0, 1 - def.drag * rho * v * dt));
    _v.y -= G * dt;
    const px = _p.x;
    const pz = _p.z;
    _p.addScaledVector(_v, dt);
    const h = world.terrain.surfaceHeightAt(_p.x, _p.z);
    if (_p.y <= h) {
      // interpolate the crossing
      const a = prevY - prevH;
      const b = h - _p.y;
      const f = a + b > 1e-6 ? a / (a + b) : 1;
      out.set(px + (_p.x - px) * f, 0, pz + (_p.z - pz) * f);
      out.y = world.terrain.surfaceHeightAt(out.x, out.z);
      return true;
    }
    prevY = _p.y;
    prevH = h;
  }
  return false;
}

/* ───────────────────────── Public helpers ───────────────────────── */

/** The munition a weapon slot would release right now (best available station). */
export function munitionForRelease(ac: AircraftEntity, weapon: Exclude<WeaponId, 'gun'>, lockedOnTarget: boolean): MunitionId {
  const idx = pickStation(ac, weapon, (m) => (m === 'r27' ? (lockedOnTarget ? 0.5 : -1) : m === 'r77' ? 1 : 0));
  return idx >= 0 ? stationMunition(ac, idx) : defaultMunitionFor(ac, weapon);
}

const _geom: ZoneGeometry = { shooterPos: new Vector3(), shooterVel: new Vector3(), shooterFwd: null, targetPos: new Vector3(), targetVel: new Vector3() };

/** Hooks the combat system provides so the DLZ can evaluate seeker/lock conditions. */
export interface ZoneHooks {
  irLockedOn(ac: AircraftEntity, targetId: number): boolean;
}

/** Launch zone for a weapon vs a target (AI shot decisions + HUD). Writes into `out`. */
export function launchZoneFor(
  ctx: CombatCtx,
  ac: AircraftEntity,
  weapon: WeaponId,
  target: AnyEntity,
  hooks: ZoneHooks,
  out: LaunchZone,
): LaunchZone {
  out.weapon = weapon;
  out.targetId = target.id;
  out.shoot = false;
  const generous = ac.isPlayer && ctx.world.difficulty.generousShootCues;
  const lo = generous ? 0.9 : 1;
  const hi = generous ? 1.1 : 1;
  forwardOf(ac.quaternion, _fwd);
  _rel.subVectors(target.position, ac.position);
  const range = _rel.length();

  if (weapon === 'gun') {
    out.range = range;
    out.rMin = 150;
    out.rNe = 700;
    out.rMax = 1_200;
    out.closure = range > 1 ? (ac.velocity.dot(_rel) - target.velocity.dot(_rel)) / range : 0;
    out.timeOfFlight = range / 950;
    const inFront = range > 1 && _fwd.dot(_rel) / range > Math.cos(0.35);
    out.shoot = ac.gunAmmo > 0 && inFront && range >= out.rMin && range <= out.rMax * hi && target.kind === 'aircraft';
    return out;
  }

  const st = acState(ac);
  const locked = ac.radar.lockedId === target.id;
  const mun = munitionForRelease(ac, weapon, locked);
  const def = ctx.defs[mun];

  if (def.category === 'bomb') {
    const horiz = Math.hypot(_rel.x, _rel.z);
    const speed = ac.velocity.length();
    const rMax = gpsMaxRange(def, ac.position.y - target.position.y, speed, target.position.y);
    out.range = horiz;
    out.rMin = 0;
    out.rMax = rMax;
    out.rNe = rMax * 0.7;
    out.closure = horiz > 1 ? (ac.velocity.x * _rel.x + ac.velocity.z * _rel.z) / horiz : 0;
    out.timeOfFlight = horiz / Math.max(150, speed * 0.8) + Math.sqrt((2 * Math.max(0, ac.position.y - target.position.y)) / G) * 0.5;
    out.shoot = remaining(ac, weapon) > 0 && horiz <= rMax * hi && target.kind !== 'aircraft';
    return out;
  }

  _geom.shooterPos.copy(ac.position);
  _geom.shooterVel.copy(ac.velocity);
  _geom.shooterFwd = _fwd;
  _geom.targetPos.copy(target.position);
  _geom.targetVel.copy(target.velocity);
  kinematicZone(def, _geom, out);
  out.weapon = weapon;
  out.targetId = target.id;
  if (remaining(ac, weapon) <= 0) return out;
  const inZone = out.range >= out.rMin * lo && out.range <= out.rMax * hi;
  if (!inZone) return out;
  switch (def.guidance) {
    case 'ir':
      out.shoot = target.kind === 'aircraft' && hooks.irLockedOn(ac, target.id);
      break;
    case 'semi_active':
      out.shoot = locked;
      break;
    case 'active_radar': {
      const c = st.contacts.get(target.id);
      const fresh = !!c && c.lastSeen >= ctx.time - 1.5 && (ac.team === 'blue' || c.ownTime >= ctx.time - 1.5);
      out.shoot = target.kind === 'aircraft' && (locked || fresh);
      break;
    }
    case 'anti_radiation':
      out.shoot = (target.kind === 'sam' && (target.radarOn || target.known)) || (target.kind === 'ground' && target.emitter);
      break;
    default:
      out.shoot = true;
  }
  return out;
}
