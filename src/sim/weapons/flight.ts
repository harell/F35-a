/**
 * F35-A — missile & bomb kinematics, fuzing, warhead effects and termination.
 *
 * Per step: motor (boost → sustain), guidance data, steering command → first-order autopilot,
 * lateral g limited by dynamic pressure (+ TVC while burning), parasite drag ∝ ρv², induced drag
 * from manoeuvring (missiles) or 1/(L/D) (glide bombs), gravity. Swept closest-approach fuzing
 * against the target (missiles move 10–30 m per step), ground/water impact, self-destruct at
 * maxFlightTime, kinematic defeat after burnout (too slow / no longer closing).
 */
import { Vector3 } from 'three';
import { G, clamp } from '../../core/math';
import { airDensity } from '../../core/atmosphere';
import type { AircraftEntity, AnyEntity } from '../entities';
import type { CombatCtx } from './context';
import { updateGuidanceData, steeringCommand } from './guidance';
import type { CombatMissile } from './missile';
import { isCombatMissile, orientAlong } from './missile';

type EndReason = 'hit' | 'proximity' | 'ground' | 'water' | 'selfdestruct' | 'decoyed';

const _cmd = new Vector3();
const _p0 = new Vector3();
const _vhat = new Vector3();
const _t0 = new Vector3();
const _d0 = new Vector3();
const _dd = new Vector3();
const _pt = new Vector3();

/** Minimum speed after burnout below which a missile is kinematically defeated (m/s). */
export const DEFEAT_SPEED = 200;

/** Update every live combat missile in the world. */
export function updateMissiles(ctx: CombatCtx, dt: number): void {
  const list = ctx.world.missiles;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m.alive || !isCombatMissile(m) || m.ended) continue;
    stepMissile(ctx, m, dt);
  }
}

/**
 * Swept closest approach of a point moving p0→p1 and a target moving t0→t1 during one step.
 * Returns the fraction s∈[0,1] of the minimum and writes the distance to `res.dist`.
 */
export function sweptClosest(p0: Vector3, p1: Vector3, t0: Vector3, t1: Vector3, res: { s: number; dist: number }): void {
  _d0.subVectors(p0, t0);
  _dd.subVectors(p1, p0).sub(_t0.subVectors(t1, t0));
  const dd2 = _dd.lengthSq();
  let s = dd2 > 1e-9 ? -_d0.dot(_dd) / dd2 : 0;
  s = clamp(s, 0, 1);
  res.s = s;
  res.dist = Math.sqrt(Math.max(0, _d0.lengthSq() + 2 * s * _d0.dot(_dd) + s * s * dd2));
}

const _sweep = { s: 0, dist: 0 };

function stepMissile(ctx: CombatCtx, m: CombatMissile, dt: number): void {
  const def = m.cdef;
  const world = ctx.world;
  m.age += dt;
  if (m.tgoAge >= 0) m.tgoAge += dt;

  // ── motor ──
  const tb = m.age - def.igniteDelay;
  let thrust = 0;
  if (tb >= 0) {
    if (tb < def.boostTime) thrust = def.boostAccel;
    else if (tb < def.boostTime + def.sustainTime) thrust = def.sustainAccel;
  }
  m.motorBurning = thrust > 0;

  // ── guidance data ──
  const launched = m.age >= Math.max(def.igniteDelay, 0.12);
  if (launched) updateGuidanceData(ctx, m, dt);

  // ── aerodynamics ──
  let v = m.velocity.length();
  if (v < 1e-3) {
    m.velocity.set(0, -0.1, 0);
    v = 0.1;
  }
  _vhat.copy(m.velocity).divideScalar(v);
  const rho = airDensity(m.position.y);
  const q = 0.5 * rho * v * v;
  let aMax = def.maxG * G * Math.min(1, q / def.fullGQ);
  if (m.motorBurning && def.tvcG > 0) aMax += def.tvcG * G;

  _cmd.set(0, 0, 0);
  if (launched && m.guided && !m.trackBroken) steeringCommand(ctx, m, aMax, _cmd);

  // autopilot lag → achieved lateral acceleration
  const k = 1 - Math.exp(-dt / Math.max(0.02, def.autopilotTau));
  m.aLat.lerp(_cmd, k);
  m.aLat.addScaledVector(_vhat, -m.aLat.dot(_vhat));
  const aLat = m.aLat.length();
  if (aLat > aMax) m.aLat.multiplyScalar(aMax / aLat);
  const aL = Math.min(aLat, aMax);

  const drag = def.drag * rho * v * v;
  const induced = def.glideRatio > 0 ? aL / def.glideRatio : (aL * aL) / (Math.max(q, 2_000) * def.liftArea);
  const axial = thrust - drag - induced;

  // ── integrate (semi-implicit Euler) ──
  _p0.copy(m.position);
  m.velocity.addScaledVector(_vhat, axial * dt).addScaledVector(m.aLat, dt);
  m.velocity.y -= G * dt;
  m.position.addScaledVector(m.velocity, dt);
  m.speed = m.velocity.length();
  orientAlong(m.quaternion, m.velocity);

  // ── phase (HUD/debug/visuals) ──
  if (!launched) m.phase = 'launch';
  else if (!m.guided || m.trackBroken) m.phase = 'ballistic';
  else if (m.seekerLocked && def.guidance !== 'semi_active') m.phase = 'terminal';
  else if (m.motorBurning) m.phase = 'boost';
  else m.phase = 'midcourse';

  // ── ground / water impact ──
  const ground = world.terrain.surfaceHeightAt(m.position.x, m.position.z);
  if (m.position.y <= ground) {
    // back up to the surface along the step
    const above = _p0.y - world.terrain.surfaceHeightAt(_p0.x, _p0.z);
    const below = ground - m.position.y;
    const f = above > 0 ? clamp(above / (above + below), 0, 1) : 1;
    m.position.lerpVectors(_p0, m.position, f);
    m.position.y = world.terrain.surfaceHeightAt(m.position.x, m.position.z);
    const water = world.terrain.isWater(m.position.x, m.position.z) && m.position.y <= 0.5;
    groundImpact(ctx, m, water);
    return;
  }

  const armed = m.age >= def.armTime;
  const target = world.getEntity(m.targetId);

  // ── air-to-ground proximity (AARGM onto a site) ──
  if (armed && def.category === 'agm' && target && target.alive && (target.kind === 'sam' || target.kind === 'ground')) {
    _t0.copy(target.position);
    sweptClosest(_p0, m.position, _t0, target.position, _sweep);
    if (_sweep.dist <= def.fuseRadius + target.radius * 0.6 && (_sweep.s < 0.999 || _sweep.dist < def.fuseRadius * 0.3)) {
      _pt.lerpVectors(_p0, m.position, _sweep.s);
      detonate(ctx, m, _pt, target, 'hit', 'ground');
      return;
    }
  }

  // ── air-to-air proximity fuze (target, and the original target when decoyed) ──
  if (armed && (def.category === 'aam' || def.category === 'sam')) {
    if (target && target.alive && target.kind === 'aircraft' && fuzeCheck(ctx, m, target, dt)) return;
    if (m.decoyed && m.originalTargetId !== m.targetId) {
      const orig = world.getEntity(m.originalTargetId);
      if (orig && orig.alive && orig.kind === 'aircraft' && fuzeCheck(ctx, m, orig, dt)) return;
    }
  }

  // ── termination ──
  if (m.trackBroken) m.ballisticTime += dt;
  if (m.age >= def.maxFlightTime) return selfDestruct(ctx, m);
  if (def.category === 'aam' || def.category === 'sam') {
    const burntOut = m.age > m.burnEnd;
    if (burntOut && m.speed < DEFEAT_SPEED) return selfDestruct(ctx, m);
    if (m.trackBroken && m.ballisticTime > 6) return selfDestruct(ctx, m);
    // no longer closing on its target after burnout → kinematically defeated / overshot
    if (target && target.alive && burntOut) {
      const range = m.position.distanceTo(target.position);
      if (range > m.prevRange + 0.01) m.openingTimer += dt;
      else m.openingTimer = Math.max(0, m.openingTimer - dt);
      m.prevRange = range;
      if (m.openingTimer > 2.5) return selfDestruct(ctx, m);
    } else if (target && target.alive) {
      m.prevRange = m.position.distanceTo(target.position);
    }
  }
}

/** Proximity fuze vs one aircraft. Returns true if the warhead fired. */
function fuzeCheck(ctx: CombatCtx, m: CombatMissile, ac: AircraftEntity, dt: number): boolean {
  const def = m.cdef;
  _t0.copy(ac.position).addScaledVector(ac.velocity, -dt);
  sweptClosest(_p0, m.position, _t0, ac.position, _sweep);
  if (ac.id === m.targetId || ac.id === m.originalTargetId) m.closestApproach = Math.min(m.closestApproach, _sweep.dist);
  let fuse = def.fuseRadius;
  if (m.team !== (ctx.world.player?.team ?? 'blue')) fuse *= clamp(0.75 + 0.25 * ctx.world.difficulty.enemyMissileSkill, 0.8, 1.1);
  const reach = fuse + ac.radius * 0.5;
  if (_sweep.dist > reach) return false;
  // fire at the closest point: when the minimum falls inside this step, or when already very close
  if (_sweep.s >= 0.999 && _sweep.dist > fuse * 0.3) return false;
  _pt.lerpVectors(_p0, m.position, _sweep.s);
  const direct = _sweep.dist <= ac.radius * 0.5;
  detonate(ctx, m, _pt, ac, direct ? 'hit' : 'proximity', 'air');
  return true;
}

/**
 * Warhead detonation: damage with linear falloff over blastRadius to the intended target and
 * anything else inside the blast. Emits 'explosion' and 'munition:end'.
 */
function detonate(ctx: CombatCtx, m: CombatMissile, point: Vector3, primary: AnyEntity | null, reason: EndReason, surface: 'air' | 'ground' | 'water'): void {
  const hitPrimary = applyBlast(ctx, m, point, primary);
  finish(ctx, m, point, reason === 'hit' || reason === 'proximity' ? reason : hitPrimary ? 'hit' : reason, surface);
}

/** Apply blast damage. Returns true if the intended target was damaged. */
function applyBlast(ctx: CombatCtx, m: CombatMissile, point: Vector3, primary: AnyEntity | null): boolean {
  const def = m.cdef;
  const world = ctx.world;
  const shooter = world.getEntity(m.shooterId);
  let hitPrimary = false;
  let hitHostile = false;
  const hurt = (e: AnyEntity, radiusFactor: number): void => {
    if (!e.alive || e.id === m.shooterId) return;
    const d = Math.max(0, point.distanceTo(e.position) - e.radius * radiusFactor);
    if (d >= def.blastRadius) return;
    const dmg = def.damage * (1 - d / def.blastRadius);
    if (dmg <= 0.5) return;
    world.applyDamage(e, dmg, m.shooterId, def.id, point);
    if (e === primary) hitPrimary = true;
    if (e.team !== m.team) hitHostile = true;
  };
  for (const ac of world.aircraft) hurt(ac, 0.5);
  if (def.category === 'bomb' || def.category === 'agm') {
    for (const s of world.sams) hurt(s, 0.6);
    for (const g of world.ground) hurt(g, 0.6);
  }
  if (hitHostile && shooter && shooter.kind === 'aircraft') shooter.hits++;
  return hitPrimary;
}

function groundImpact(ctx: CombatCtx, m: CombatMissile, water: boolean): void {
  const target = ctx.world.getEntity(m.targetId);
  const armed = m.age >= m.cdef.armTime;
  let hitPrimary = false;
  if (armed || m.cdef.category === 'bomb') hitPrimary = applyBlast(ctx, m, m.position, target);
  finish(ctx, m, m.position, hitPrimary ? 'hit' : water ? 'water' : 'ground', water ? 'water' : 'ground');
}

function selfDestruct(ctx: CombatCtx, m: CombatMissile): void {
  finish(ctx, m, m.position, m.decoyed ? 'decoyed' : 'selfdestruct', 'air', 'tiny');
}

function finish(
  ctx: CombatCtx,
  m: CombatMissile,
  point: Vector3,
  reason: EndReason,
  surface: 'air' | 'ground' | 'water',
  size = m.cdef.blast,
): void {
  if (point !== m.position) m.position.copy(point);
  m.alive = false;
  m.ended = true;
  m.motorBurning = false;
  m.seekerLocked = false;
  const events = ctx.world.events;
  events.emit('explosion', { position: m.position, size, surface });
  events.emit('munition:end', { missile: m, position: m.position, reason, targetId: m.targetId });
}
