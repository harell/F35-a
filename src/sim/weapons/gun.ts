/**
 * F35-A — guns: GAU-22/A (F-35A), GSh-30-1 (enemy fighters), ZSU-23-4 (AAA, via sam/aaa.ts).
 *
 * Rounds are pooled Projectiles (world.allocProjectile) with gravity, quadratic drag and
 * dispersion; every Nth round is a tracer. Hits use swept segment-vs-sphere tests in the target's
 * frame (bullets travel ~17 m per 60 Hz step). The LCOS pipper uses the same ballistics.
 */
import { Vector3 } from 'three';
import { G, clamp, forwardOf } from '../../core/math';
import { atmosphere } from '../../core/atmosphere';
import { isHostile, type Team } from '../../core/types';
import type { AircraftEntity, AnyEntity, GroundTargetEntity, Projectile, SamSiteEntity } from '../entities';
import type { LaunchZone } from '../api';
import { firstLandmarkHit } from '../landmarks';
import { vesselSegmentHit } from '../civil/vessels';
import type { AcCombatState, CombatCtx } from './context';
import { gaussian, radio } from './context';
import { GUNS, type GunDef } from './defs';
import { gunFor } from './loadouts';

/** Generic bullet drag (sea level) used for flight + prediction: decel = k · σ · v². */
export const BULLET_DRAG = 1.9e-4;
/** Default LCOS range with no target: 1,000 ft. */
export const DEFAULT_PIPPER_RANGE = 304.8;
/** Max range for a target-computed pipper (2 nm). */
export const LCOS_MAX_RANGE = 3_700;
/** Gun cue ranges (m): minimum, lethal (4–8 hits kill), effective (SHOOT), funnel / max cue. */
export const GUN_MIN_RANGE = 150;
export const GUN_LETHAL_RANGE = 800;
export const GUN_EFFECTIVE_RANGE = 1_200;
export const GUN_CUE_RANGE = 1_500;

/**
 * Energy factor of a round at impact: 0.55 (fuze/HE part) + 0.45 × (v / v_nominal)² (kinetic part),
 * v_nominal = muzzle velocity + a typical 250 m/s launch speed.
 */
export function roundEnergyFactor(p: Projectile): number {
  const nominal = p.calibre >= 0.0295 ? GUNS.gsh301.muzzle + 250 : p.calibre >= 0.0245 ? GUNS.gau22.muzzle + 250 : GUNS.zsu23.muzzle;
  const r = Math.min(1, p.velocity.length() / nominal);
  return 0.55 + 0.45 * r * r;
}

const _atm = { temperature: 0, pressure: 0, density: 0, speedOfSound: 0, sigma: 0 };
const _dir = new Vector3();
const _muzzle = new Vector3();
const _off = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _a = new Vector3();
const _b = new Vector3();
const _seg = new Vector3();

/**
 * Spawn one round at the muzzle. `advance` (s) spaces rounds fired within one step along the
 * stream. Call after updateProjectiles so fresh rounds are not moved twice. False if the pool is full.
 */
export function spawnRound(
  ctx: CombatCtx,
  shooterId: number,
  team: Team,
  gun: GunDef,
  origin: Vector3,
  dir: Vector3,
  baseVel: Vector3,
  counter: number,
  advance: number,
): boolean {
  const p = ctx.world.allocProjectile();
  if (!p) return false;
  p.active = true;
  p.team = team;
  p.shooterId = shooterId;
  p.damage = gun.damage;
  p.age = 0;
  p.life = gun.life;
  p.calibre = gun.calibre;
  p.tracer = counter % gun.tracerEvery === 0;
  p.flak = gun.flak && counter % 3 === 0;
  p.velocity.copy(baseVel).addScaledVector(dir, gun.muzzle);
  // rounds fired earlier within the step are already further down the stream (relative to the gun)
  p.position.copy(origin).addScaledVector(dir, gun.muzzle * advance);
  p.prevPosition.copy(origin);
  return true;
}

/** Aircraft gun trigger handling for this step (sets ac.gunFiring, emits 'gun:state'). */
export function updateAircraftGun(ctx: CombatCtx, ac: AircraftEntity, st: AcCombatState, dt: number): void {
  const gun = gunFor(ac);
  const firing = !!gun && ac.alive && ac.input.fireGun && ac.gunAmmo > 0;
  const world = ctx.world;
  if (firing !== ac.gunFiring) {
    ac.gunFiring = firing;
    world.events.emit('gun:state', {
      shooterId: ac.id,
      firing,
      position: ac.position,
      team: ac.team,
      weapon: ac.type === 'f35a' ? 'gau22' : 'gsh301',
    });
    if (firing) {
      st.gunAccum = 0.999; // first round immediately
      st.burstHit = false;
      ac.shotsFired++;
      gunsCall(ctx, ac, st);
    }
  }
  if (!firing || !gun) return;
  st.gunAccum += dt * gun.rate;
  const n = Math.floor(st.gunAccum);
  if (n <= 0) return;
  st.gunAccum -= n;
  forwardOf(ac.quaternion, _dir);
  _right.set(1, 0, 0).applyQuaternion(ac.quaternion);
  _up.set(0, 1, 0).applyQuaternion(ac.quaternion);
  // F-35A gun: left shoulder; Flankers/Fulcrum: left wing root — close enough for visuals
  _off.set(-0.9, 0.3, -5).applyQuaternion(ac.quaternion);
  _muzzle.copy(ac.position).add(_off);
  for (let i = 0; i < n && ac.gunAmmo > 0; i++) {
    const disp = gun.dispersion;
    _a.copy(_dir)
      .addScaledVector(_right, gaussian(ctx.rng) * disp)
      .addScaledVector(_up, gaussian(ctx.rng) * disp)
      .normalize();
    const advance = ((n - i - 0.5) / n) * dt;
    if (!spawnRound(ctx, ac.id, ac.team, gun, _muzzle, _a, ac.velocity, st.roundCounter++, advance)) break;
    ac.gunAmmo--;
  }
}

/** "Guns, guns" brevity call at burst start with a target inside 1.5 km (rate-limited). */
function gunsCall(ctx: CombatCtx, ac: AircraftEntity, st: AcCombatState): void {
  if (ac.team !== 'blue' || ctx.time - st.lastGunsCall < 6) return;
  const tgt = ctx.world.getEntity(ac.radar.lockedId ?? ac.radar.designatedId);
  let close = !!tgt && tgt.alive && tgt.team !== ac.team && tgt.position.distanceTo(ac.position) < 1_500;
  if (!close) {
    forwardOf(ac.quaternion, _dir);
    for (const o of ctx.world.aircraft) {
      if (!o.alive || o.team === ac.team) continue;
      _b.subVectors(o.position, ac.position);
      const d = _b.length();
      if (d < 1_500 && _b.dot(_dir) > d * 0.9) {
        close = true;
        break;
      }
    }
  }
  if (!close) return;
  if (!ac.isPlayer && ctx.time - ctx.chatter.friendly < 3) return;
  st.lastGunsCall = ctx.time;
  if (!ac.isPlayer) ctx.chatter.friendly = ctx.time;
  radio(ctx, ac.callsign, 'Guns, guns', 'p_guns', ac.team);
}

/** Move all live rounds, test hits against aircraft / ground targets / terrain. */
export function updateProjectiles(ctx: CombatCtx, dt: number): void {
  const world = ctx.world;
  const list = world.projectiles;
  ctx.impactBudget = Math.min(12, ctx.impactBudget + dt * 30);
  ctx.flakBudget = Math.min(6, ctx.flakBudget + dt * 8);
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p.active) continue;
    p.prevPosition.copy(p.position);
    const sigma = atmosphere(p.position.y, _atm).sigma;
    const v = p.velocity.length();
    p.velocity.multiplyScalar(Math.max(0, 1 - BULLET_DRAG * sigma * v * dt));
    p.velocity.y -= G * dt;
    p.position.addScaledVector(p.velocity, dt);
    p.age += dt;
    if (hitTest(ctx, p, dt)) continue;
    if (p.age >= p.life) {
      p.active = false;
      if (p.flak && ctx.flakBudget >= 1) {
        ctx.flakBudget -= 1;
        world.events.emit('explosion', { position: p.position, size: 'tiny', surface: 'air' });
      }
    }
  }
}

function impact(ctx: CombatCtx, p: Projectile, surface: 'air' | 'ground' | 'water' | 'target', targetId: number | null): void {
  p.active = false;
  if (ctx.impactBudget >= 1 || surface === 'target') {
    ctx.impactBudget -= 1;
    ctx.world.events.emit('gun:impact', { position: p.position, surface, targetId });
  }
}

const _rel0 = new Vector3();
const _rel1 = new Vector3();
const _rv = new Vector3();
const _fw = new Vector3();

/**
 * Presented-area scale of the hit sphere for a round arriving from the target's FRONT hemisphere:
 * a fighter seen nose-on is a thin cross (fuselage + wing edges), far less area than its
 * planform/side — 1 for beam/top/rear-quarter shots, down to 0.5 (¼ the area) dead head-on.
 * This (with the AI's gun-defence jinks) makes the head-on snapshot the low-Pk shot it is in
 * reality. Damage per hit does not depend on closure (roundEnergyFactor uses the round's own speed).
 */
export function presentedScale(p: Projectile, ac: AircraftEntity): number {
  _rv.subVectors(p.velocity, ac.velocity);
  const v = _rv.length();
  if (v < 1) return 1;
  forwardOf(ac.quaternion, _fw);
  const c = _rv.dot(_fw) / v; // < 0: round flying against the target's nose (from ahead)
  if (c >= 0) return 1;
  const sin = Math.sqrt(Math.max(0, 1 - c * c));
  return 0.5 + 0.5 * Math.min(1, sin / 0.7);
}

/** Distance from the origin to the segment a→b. */
function segDistToOrigin(a: Vector3, b: Vector3): { d: number; s: number } {
  _seg.subVectors(b, a);
  const l2 = _seg.lengthSq();
  const s = l2 > 1e-9 ? clamp(-a.dot(_seg) / l2, 0, 1) : 0;
  const x = a.x + _seg.x * s;
  const y = a.y + _seg.y * s;
  const z = a.z + _seg.z * s;
  _segRes.d = Math.sqrt(x * x + y * y + z * z);
  _segRes.s = s;
  return _segRes;
}
const _segRes = { d: 0, s: 0 };

function hitTest(ctx: CombatCtx, p: Projectile, dt: number): boolean {
  const world = ctx.world;
  const stepLen = p.velocity.length() * dt + 40;
  // aircraft (in the target's frame so both motions are accounted for)
  for (const ac of world.aircraft) {
    if (!ac.alive || ac.team === p.team || ac.id === p.shooterId) continue;
    const dx = ac.position.x - p.position.x;
    const dy = ac.position.y - p.position.y;
    const dz = ac.position.z - p.position.z;
    if (dx * dx + dy * dy + dz * dz > stepLen * stepLen) continue;
    _rel0.copy(p.prevPosition).sub(ac.position).addScaledVector(ac.velocity, dt);
    _rel1.copy(p.position).sub(ac.position);
    const r = segDistToOrigin(_rel0, _rel1);
    if (r.d <= ac.radius * 0.55 * presentedScale(p, ac)) {
      p.position.lerpVectors(p.prevPosition, p.position, r.s);
      const weapon = p.flak ? 'flak' : 'gun';
      world.applyDamage(ac, p.damage * roundEnergyFactor(p), p.shooterId, weapon, p.position);
      const shooter = world.getEntity(p.shooterId);
      if (shooter && shooter.kind === 'aircraft' && isHostile(shooter.team, ac.team)) markBurstHit(shooter);
      impact(ctx, p, 'target', ac.id);
      return true;
    }
  }
  // ground targets / SAM sites (strafing) — only rounds fired by aircraft
  const shooter = world.getEntity(p.shooterId);
  if (shooter && shooter.kind === 'aircraft') {
    if (strafeHit(ctx, p, shooter, world.ground, stepLen) || strafeHit(ctx, p, shooter, world.sams, stepLen)) return true;
  }
  // structures (the Sky Tower stops rounds; the gun cannot bring it down)
  if (world.landmarks.length) {
    const hit = firstLandmarkHit(world.landmarks, p.prevPosition, p.position);
    if (hit) {
      p.position.lerpVectors(p.prevPosition, p.position, hit.s);
      impact(ctx, p, 'ground', null);
      return true;
    }
  }
  // terrain / sea
  const h = world.terrain.surfaceHeightAt(p.position.x, p.position.z);
  if (p.position.y <= h) {
    p.position.y = h;
    impact(ctx, p, world.terrain.isWater(p.position.x, p.position.z) && h <= 0.5 ? 'water' : 'ground', null);
    return true;
  }
  return false;
}

function strafeHit(ctx: CombatCtx, p: Projectile, shooter: AircraftEntity, list: readonly (GroundTargetEntity | SamSiteEntity)[], stepLen: number): boolean {
  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    if (!g.alive || g.team === p.team) continue;
    const dx = g.position.x - p.position.x;
    const dz = g.position.z - p.position.z;
    if (dx * dx + dz * dz > (stepLen + g.radius) ** 2) continue;
    let s = -1;
    if (g.kind === 'ground' && g.vessel) s = vesselSegmentHit(g, p.prevPosition, p.position); // long hull, not a sphere
    else {
      _rel0.subVectors(p.prevPosition, g.position);
      _rel1.subVectors(p.position, g.position);
      const r = segDistToOrigin(_rel0, _rel1);
      if (r.d <= g.radius * 0.6) s = r.s;
    }
    if (s >= 0) {
      p.position.lerpVectors(p.prevPosition, p.position, s);
      ctx.world.applyDamage(g, p.damage * roundEnergyFactor(p), p.shooterId, 'gun', p.position);
      if (isHostile(shooter.team, g.team)) markBurstHit(shooter); // civil traffic is no "hit" for accuracy
      impact(ctx, p, 'target', g.id);
      return true;
    }
  }
  return false;
}

/** Count at most one hit per burst toward accuracy stats. */
const burstHits = new WeakMap<AircraftEntity, number>();
function markBurstHit(shooter: AircraftEntity): void {
  const shots = burstHits.get(shooter);
  if (shots === shooter.shotsFired) return;
  burstHits.set(shooter, shooter.shotsFired);
  shooter.hits++;
}

/* ───────────────────────── Gun cue ───────────────────────── */

const _gz = new Vector3();
const _gt = new Vector3();

/**
 * Gun "launch zone": rMin 150 m, rNe 800 m (lethal: 4–8 hits kill), rMax 1,500 m (funnel / cue),
 * SHOOT inside the 1,200 m effective range only while the LCOS pipper is on the target (within
 * ~1.6 target radii) — i.e. "a burst now will hit". Without a designation the nose (±20°) is used.
 */
export function gunZone(ctx: CombatCtx, ac: AircraftEntity, target: AnyEntity, range: number, out: LaunchZone): LaunchZone {
  _gt.subVectors(target.position, ac.position);
  out.range = range;
  out.rMin = GUN_MIN_RANGE;
  out.rNe = GUN_LETHAL_RANGE;
  out.rMax = GUN_CUE_RANGE;
  (out as LaunchZone & { rShoot: number }).rShoot = GUN_EFFECTIVE_RANGE;
  out.closure = range > 1 ? (ac.velocity.dot(_gt) - target.velocity.dot(_gt)) / range : 0;
  out.timeOfFlight = range / 950;
  out.shoot = false;
  if (ac.gunAmmo <= 0 || target.kind !== 'aircraft' || range < GUN_MIN_RANGE || range > GUN_EFFECTIVE_RANGE) return out;
  forwardOf(ac.quaternion, _gz);
  if (_gz.dot(_gt) < range * Math.cos(0.35)) return out;
  const designated = (ac.radar.lockedId ?? ac.radar.designatedId) === target.id;
  if (!designated) {
    out.shoot = true; // no pipper solution on it: nose-on and in range
    return out;
  }
  const lp = gunLeadPoint(ctx, ac);
  if (!lp) return out;
  _gz.subVectors(lp, ac.position).normalize();
  const err = Math.acos(clamp(_gz.dot(_gt) / range, -1, 1));
  out.shoot = err <= Math.max(0.015, (1.6 * target.radius) / range);
  return out;
}

/* ───────────────────────── LCOS pipper ───────────────────────── */

/**
 * Bullet displacement after t seconds from a muzzle velocity vector V0 (same model as the
 * projectile integrator: quadratic drag along the path + gravity drop).
 */
export function bulletDisplacement(V0: Vector3, t: number, sigma: number, out: Vector3): Vector3 {
  const v0 = V0.length();
  const k = BULLET_DRAG * sigma;
  const s = k > 0 ? Math.log(1 + k * v0 * t) / k : v0 * t;
  out.copy(V0).multiplyScalar(v0 > 0 ? s / v0 : 0);
  out.y -= 0.5 * G * t * t;
  return out;
}

/** Bullet speed after t seconds. */
function bulletSpeed(v0: number, t: number, sigma: number): number {
  return v0 / (1 + BULLET_DRAG * sigma * v0 * t);
}

const _V0 = new Vector3();
const _B = new Vector3();
const _T = new Vector3();
const _lead = new Vector3();

/**
 * LCOS pipper (world point): where the target must be NOW for rounds fired now to hit it —
 * bullet time of flight + gravity drop + target motion. With no target within 2 nm, the pipper
 * sits on the 1,000 ft range line. Returns a shared vector (copy it if you keep it).
 */
export function gunLeadPoint(ctx: CombatCtx, ac: AircraftEntity): Vector3 | null {
  const gun = gunFor(ac) ?? (ac.type === 'f35a' ? GUNS.gau22 : null);
  if (!gun || !ac.alive) return null;
  const world = ctx.world;
  forwardOf(ac.quaternion, _dir);
  _off.set(-0.9, 0.3, -5).applyQuaternion(ac.quaternion);
  _muzzle.copy(ac.position).add(_off);
  _V0.copy(ac.velocity).addScaledVector(_dir, gun.muzzle);
  const v0 = _V0.length();
  const sigma = atmosphere(ac.position.y, _atm).sigma;
  const tgt = world.getEntity(ac.radar.lockedId ?? ac.radar.designatedId);
  let useTarget = !!tgt && tgt.alive && tgt.kind === 'aircraft' && tgt.team !== ac.team;
  if (useTarget && tgt!.position.distanceTo(ac.position) > LCOS_MAX_RANGE) useTarget = false;

  if (!useTarget || !tgt) {
    // time for the bullet to travel 1,000 ft downrange
    const k = BULLET_DRAG * sigma;
    const t = k > 0 ? (Math.exp(k * DEFAULT_PIPPER_RANGE) - 1) / (k * v0) : DEFAULT_PIPPER_RANGE / v0;
    bulletDisplacement(_V0, t, sigma, _B);
    return _lead.copy(_muzzle).add(_B);
  }
  // Solve for t: bullet downrange distance equals the range of the target's future position.
  let t = tgt.position.distanceTo(_muzzle) / v0;
  for (let i = 0; i < 6; i++) {
    _T.copy(tgt.position).addScaledVector(tgt.velocity, t).sub(_muzzle);
    bulletDisplacement(_V0, t, sigma, _B);
    const err = _T.length() - _B.length();
    t = Math.max(0.01, t + err / Math.max(100, bulletSpeed(v0, t, sigma)));
  }
  bulletDisplacement(_V0, t, sigma, _B);
  // P = B(t) − vT·t  (target now at P ⇒ at B(t) after t seconds)
  return _lead.copy(_muzzle).add(_B).addScaledVector(tgt.velocity, -t);
}
