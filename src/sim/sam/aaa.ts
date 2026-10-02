/**
 * F35-A — radar-directed AAA (ZSU-23-4 Shilka).
 *
 * Fires 1–2 s bursts (57 rds/s combined) with ~1.5 s pauses at targets inside 2.5 km and below
 * 3 km above the site. Lead is computed from the target's velocity, bullet time of flight (with
 * drag) and gravity drop; a slowly wandering aim error (smaller for skilled crews) plus round
 * dispersion makes it a cone of fire rather than a laser. Against a low, close jet (inside 1.5 km,
 * below 300 m above the site) the aim error shrinks: AAA threatens low flight (design pillar 3).
 */
import { Vector3 } from 'three';
import { G, clamp, smoothstep, wrapPi } from '../../core/math';
import { atmosphere } from '../../core/atmosphere';
import type { AircraftEntity, SamSiteEntity } from '../entities';
import type { CombatCtx } from '../weapons/context';
import { gaussian } from '../weapons/context';
import { GUNS } from '../weapons/defs';
import { BULLET_DRAG, spawnRound } from '../weapons/gun';
import type { SamTypeData } from './samData';

export interface AaaState {
  burstOn: boolean;
  burstTimer: number;
  gunAccum: number;
  rounds: number;
  ammo: number;
  firing: boolean;
  aimErr: Vector3;
  aimErrTimer: number;
}

const _muzzle = new Vector3();
const _aim = new Vector3();
const _dir = new Vector3();
const _r = new Vector3();
const _u = new Vector3();
const _zero = new Vector3();
const _atm = { temperature: 0, pressure: 0, density: 0, speedOfSound: 0, sigma: 0 };

/**
 * Close-in, low target: inside CLOSE_RANGE m and below CLOSE_HEIGHT m above the site (fading out
 * over the last 500 m / 100 m) the Gun Dish's solution is at its best (a short time of flight, a
 * fast range rate update and a target that can't dive away), so the crew / fire-control aim error
 * is multiplied by CLOSE_AIM_ERROR. Design pillar 3: AAA threatens low flight.
 */
export const CLOSE_RANGE = 1_500;
export const CLOSE_HEIGHT = 300;
export const CLOSE_AIM_ERROR = 0.65;

/** Aim-error multiplier (1 → CLOSE_AIM_ERROR) for a target at `dist` m, `height` m above the site. */
export function closeInAimFactor(dist: number, height: number): number {
  const close = (1 - smoothstep(dist, CLOSE_RANGE - 500, CLOSE_RANGE)) * (1 - smoothstep(height, CLOSE_HEIGHT - 100, CLOSE_HEIGHT));
  return 1 - (1 - CLOSE_AIM_ERROR) * close;
}

/** Aim direction (unit) leading a target, accounting for drag + gravity. */
function leadDirection(muzzle: Vector3, t: AircraftEntity, v0: number, sigma: number, out: Vector3): Vector3 {
  const k = BULLET_DRAG * sigma;
  let tof = t.position.distanceTo(muzzle) / v0;
  for (let i = 0; i < 4; i++) {
    _aim.copy(t.position).addScaledVector(t.velocity, tof).sub(muzzle);
    const range = _aim.length();
    // time for a round to cover `range` with quadratic drag: s = ln(1 + k v0 t) / k
    tof = k > 0 ? (Math.exp(Math.min(20, k * range)) - 1) / (k * v0) : range / v0;
  }
  _aim.copy(t.position).addScaledVector(t.velocity, tof).sub(muzzle);
  _aim.y += 0.5 * G * tof * tof;
  return out.copy(_aim).normalize();
}

/**
 * AAA gun control for one step. `target` null ⇒ cease fire. Emits 'gun:state' on start/stop.
 * Sets site.state 'launch' while engaging (handled by the SAM state machine).
 */
export function updateAaa(ctx: CombatCtx, s: SamSiteEntity, data: SamTypeData, st: AaaState, target: AircraftEntity | null, dt: number): void {
  const gun = GUNS.zsu23;
  const world = ctx.world;
  _muzzle.copy(s.position);
  _muzzle.y += 3;

  let engage = false;
  if (target && s.alive && s.state === 'launch' && st.ammo > 0) {
    const d = target.position.distanceTo(s.position);
    const scale = world.difficulty.samRangeScale;
    engage = d <= data.engageMax * scale && target.position.y - s.position.y <= data.altMax;
  }

  // burst cadence
  st.burstTimer -= dt;
  if (st.burstTimer <= 0) {
    st.burstOn = !st.burstOn;
    st.burstTimer = (st.burstOn ? data.burst : data.burstPause) * (0.7 + 0.6 * ctx.rng());
  }

  let aimed = false;
  if (target && !engage && s.alive) {
    // tracking but not yet in range: keep the guns pointed at the target
    _dir.subVectors(target.position, _muzzle).normalize();
    const rate = data.slewRate * dt;
    s.launcherAzimuth = wrapPi(s.launcherAzimuth + clamp(wrapPi(Math.atan2(_dir.x, -_dir.z) - s.launcherAzimuth), -rate, rate));
    s.launcherElevation += clamp(Math.asin(clamp(_dir.y, -1, 1)) - s.launcherElevation, -rate, rate);
  }
  if (engage && target) {
    const sigma = atmosphere(_muzzle.y, _atm).sigma;
    leadDirection(_muzzle, target, gun.muzzle, sigma, _dir);
    // crew / fire-control error: slow random walk, smaller for skilled crews
    st.aimErrTimer -= dt;
    if (st.aimErrTimer <= 0) {
      st.aimErrTimer = 0.6 + ctx.rng() * 0.6;
      // crew/fire-control error grows with skill deficit and the target's angular rate
      _r.subVectors(target.position, _muzzle);
      const dist = Math.max(50, _r.length());
      const radial = target.velocity.dot(_r) / dist;
      const angRate = Math.sqrt(Math.max(0, target.velocity.lengthSq() - radial * radial)) / dist;
      const mag = (0.006 + 0.022 * (1 - world.difficulty.aiSkill) + 0.05 * angRate) * closeInAimFactor(dist, target.position.y - s.position.y);
      st.aimErr.set(gaussian(ctx.rng) * mag, gaussian(ctx.rng) * mag, gaussian(ctx.rng) * mag);
    }
    _dir.add(st.aimErr).normalize();
    // turret slew
    const az = Math.atan2(_dir.x, -_dir.z);
    const el = Math.asin(clamp(_dir.y, -1, 1));
    const rate = data.slewRate * dt;
    s.launcherAzimuth = wrapPi(s.launcherAzimuth + clamp(wrapPi(az - s.launcherAzimuth), -rate, rate));
    s.launcherElevation += clamp(el - s.launcherElevation, -rate, rate);
    aimed = Math.abs(wrapPi(az - s.launcherAzimuth)) < 0.08 && Math.abs(el - s.launcherElevation) < 0.08;
  }

  const firing = engage && st.burstOn && aimed;
  if (firing !== st.firing) {
    st.firing = firing;
    world.events.emit('gun:state', { shooterId: s.id, firing, position: s.position, team: s.team, weapon: 'zsu23' });
  }
  if (!firing) return;

  st.gunAccum += dt * gun.rate;
  const n = Math.floor(st.gunAccum);
  st.gunAccum -= n;
  // barrel direction = current turret orientation (lags the lead slightly)
  const ce = Math.cos(s.launcherElevation);
  _dir.set(Math.sin(s.launcherAzimuth) * ce, Math.sin(s.launcherElevation), -Math.cos(s.launcherAzimuth) * ce);
  _r.set(_dir.z, 0, -_dir.x).normalize(); // horizontal right
  _u.crossVectors(_r, _dir).normalize();
  for (let i = 0; i < n && st.ammo > 0; i++) {
    _aim.copy(_dir)
      .addScaledVector(_r, gaussian(ctx.rng) * gun.dispersion)
      .addScaledVector(_u, gaussian(ctx.rng) * gun.dispersion)
      .normalize();
    if (!spawnRound(ctx, s.id, s.team, gun, _muzzle, _aim, _zero, st.rounds++, ((n - i - 0.5) / n) * dt)) break;
    st.ammo--;
  }
}
