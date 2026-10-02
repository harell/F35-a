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
import { radio } from './context';
import { pointDefensePk } from '../sam/SamSystem';
import { SAM_INFO } from '../../core/data';
import { STRUCTURAL_BLAST_FRACTION, destroyLandmark, firstLandmarkHit, landmarkDistance } from '../landmarks';
import { vesselHullDistance, vesselSegmentHit } from '../civil/vessels';
import { isHostile } from '../../core/types';

type EndReason = 'hit' | 'proximity' | 'ground' | 'water' | 'selfdestruct' | 'decoyed';

const _cmd = new Vector3();
const _p0 = new Vector3();
const _vhat = new Vector3();
const _t0 = new Vector3();
const _d0 = new Vector3();
const _dd = new Vector3();
const _pt = new Vector3();
const _ax = new Vector3();

/** Minimum speed after burnout below which a missile is kinematically defeated (m/s). */
export const DEFEAT_SPEED = 200;
/** A defeated missile (lost track, decoyed, passed, out of energy) self-destructs this long after (s). */
export const DEFEAT_LINGER = 1.5;
/** Max fraction of the thrust that thrust-vector control can turn sideways (sin δ_max). */
export const TVC_SIN_MAX = 0.9;
/** Induced-drag deceleration cap (m/s², 25 g). */
export const INDUCED_CAP = 25 * G;
/** Max velocity rotation per step (rad) — keeps the integration stable when slow. */
const MAX_TURN_STEP = 0.12;
/** Turnover finished when the velocity is within this angle of the commanded direction (rad). */
const TURNOVER_DONE = 0.09;

/** Rotate `vel` (unit direction `vhat`, speed `v`) toward unit `dir` by `angle` (rad), preserving speed. */
function rotateToward(vel: Vector3, vhat: Vector3, dir: Vector3, angle: number, v: number): void {
  _ax.copy(dir).addScaledVector(vhat, -vhat.dot(dir));
  const l = _ax.length();
  if (l < 1e-6) {
    // opposite / identical: pick any perpendicular (up-ish)
    _ax.set(0, 1, 0).addScaledVector(vhat, -vhat.y);
    if (_ax.lengthSq() < 1e-6) _ax.set(1, 0, 0);
    _ax.normalize();
  } else _ax.divideScalar(l);
  vel.copy(vhat).multiplyScalar(Math.cos(angle)).addScaledVector(_ax, Math.sin(angle)).multiplyScalar(v);
}

/**
 * Vertical-launch pitch-over direction: toward the predicted target position, a few degrees
 * above the line of sight, never below a small climb angle while close to the ground.
 */
function turnoverDirection(ctx: CombatCtx, m: CombatMissile, v: number, out: Vector3): Vector3 {
  const t = Math.max(0, ctx.time - m.estTime);
  out.copy(m.estPos).addScaledVector(m.estVel, t);
  const d0 = out.distanceTo(m.position);
  out.addScaledVector(m.estVel, d0 / Math.max(400, v + 350));
  out.sub(m.position);
  const horiz = Math.max(1, Math.hypot(out.x, out.z));
  let elev = Math.atan2(out.y, horiz) + 0.07;
  const agl = m.position.y - ctx.world.terrain.surfaceHeightAt(m.position.x, m.position.z);
  if (agl < 400) elev = Math.max(elev, 0.06);
  if (m.loft) elev = Math.max(elev, 0.35);
  const ce = Math.cos(elev);
  return out.set((out.x / horiz) * ce, Math.sin(elev), (out.z / horiz) * ce);
}

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
  if (m.trackBroken && !m.lossKicked) guidanceLossTransient(ctx, m);

  // ── aerodynamics ──
  let v = m.velocity.length();
  if (v < 1e-3) {
    m.velocity.set(0, -0.1, 0);
    v = 0.1;
  }
  _vhat.copy(m.velocity).divideScalar(v);
  const rho = airDensity(m.position.y);
  const q = 0.5 * rho * v * v;
  // aerodynamic g (limited by dynamic pressure) + thrust-vector g while the motor burns: TVC
  // can only turn a fraction of the thrust sideways (sin δ ≤ TVC_SIN_MAX)
  const aeroMax = def.maxG * G * Math.min(1, q / def.fullGQ);
  const tvcMax = thrust > 0 && def.tvcG > 0 ? Math.min(def.tvcG * G, thrust * TVC_SIN_MAX) : 0;
  const aMax = aeroMax + tvcMax;

  _cmd.set(0, 0, 0);
  let turnover = false;
  if (!m.turned) {
    // vertical launch: rise, then a rate-limited pitch-over toward the target (gas jets / TVC)
    turnover = true;
    if (launched && m.guided && m.hasEstimate && tb >= 0 && (m.position.y - m.launchAlt > 12 || v > 70)) {
      turnoverDirection(ctx, m, v, _t0);
      const cosA = clamp(_vhat.dot(_t0), -1, 1);
      const ang = Math.acos(cosA);
      const step = def.turnRate * dt;
      if (ang > 1e-4) rotateToward(m.velocity, _vhat, _t0, Math.min(step, ang), v);
      if (ang < TURNOVER_DONE) {
        m.turned = true;
        m.aLat.set(0, 0, 0);
      }
      _vhat.copy(m.velocity).divideScalar(v);
    }
    m.aLat.set(0, 0, 0);
  } else if (launched && m.guided && !m.trackBroken) {
    steeringCommand(ctx, m, aMax, _cmd);
  }

  // autopilot lag → achieved lateral acceleration
  let aL = 0;
  if (!turnover) {
    const k = 1 - Math.exp(-dt / Math.max(0.02, def.autopilotTau));
    m.aLat.lerp(_cmd, k);
    m.aLat.addScaledVector(_vhat, -m.aLat.dot(_vhat));
    const aLat = m.aLat.length();
    if (aLat > aMax) m.aLat.multiplyScalar(aMax / aLat);
    aL = Math.min(aLat, aMax);
  }

  // aero part pays induced drag (airframe L/D); the TVC part costs thrust: axial = T·cos δ
  const aAero = Math.min(aL, aeroMax);
  const aTvc = Math.max(0, aL - aeroMax);
  const drag = def.drag * rho * v * v;
  let induced = def.glideRatio > 0 ? aAero / def.glideRatio : (aAero * aAero) / (Math.max(q, 2_000) * def.liftArea);
  if (induced > INDUCED_CAP) induced = INDUCED_CAP;
  const thrustAxial = aTvc > 0 && thrust > 0 ? thrust * Math.sqrt(Math.max(0, 1 - Math.min(1, aTvc / thrust) ** 2)) : thrust;
  const axial = thrustAxial - drag - induced;

  // ── integrate: lateral acceleration rotates the velocity (speed-preserving), then axial + gravity ──
  _p0.copy(m.position);
  if (aL > 1e-6) {
    const theta = Math.min((aL * dt) / Math.max(v, 1), MAX_TURN_STEP);
    _t0.copy(m.aLat).divideScalar(aL);
    // v' = v·(v̂ cos θ + â sin θ)
    m.velocity.copy(_vhat).multiplyScalar(Math.cos(theta)).addScaledVector(_t0, Math.sin(theta)).multiplyScalar(v);
  }
  const vAx = Math.max(0.5, v + axial * dt);
  m.velocity.multiplyScalar(vAx / Math.max(1e-6, m.velocity.length()));
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

  // ── structures: a munition that flies into a landmark (the Sky Tower) goes off against it ──
  if (world.landmarks.length) {
    const hit = firstLandmarkHit(world.landmarks, _p0, m.position);
    if (hit) {
      m.position.lerpVectors(_p0, m.position, hit.s);
      structureImpact(ctx, m);
      return;
    }
  }

  const armed = m.age >= def.armTime;
  const target = world.getEntity(m.targetId);

  // ── tri-mode bomb: impact fuze on the designated target only (the long hull of a civil ship) ──
  if (def.guidance === 'tri_mode' && target && target.alive && (target.kind === 'sam' || target.kind === 'ground')) {
    if (target.kind === 'ground' && target.vessel) {
      const s = vesselSegmentHit(target, _p0, m.position);
      if (s >= 0) {
        _pt.lerpVectors(_p0, m.position, s);
        detonate(ctx, m, _pt, target, 'hit', 'ground');
        return;
      }
    } else {
      sweptClosest(_p0, m.position, target.position, target.position, _sweep);
      if (_sweep.dist <= def.fuseRadius + target.radius * 0.6) {
        _pt.lerpVectors(_p0, m.position, _sweep.s);
        detonate(ctx, m, _pt, target, 'hit', 'ground');
        return;
      }
    }
  }

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
    if (target && target.alive && target.kind === 'missile' && isCombatMissile(target) && interceptCheck(ctx, m, target, dt)) return;
    if (m.decoyed && m.originalTargetId !== m.targetId) {
      const orig = world.getEntity(m.originalTargetId);
      if (orig && orig.alive && orig.kind === 'aircraft' && fuzeCheck(ctx, m, orig, dt)) return;
    }
  }

  // ── termination ──
  if (m.trackBroken) m.ballisticTime += dt;
  if (m.age >= def.maxFlightTime) return selfDestruct(ctx, m);
  if (def.category === 'aam' || def.category === 'sam') {
    // threat assessment (MAWS / RWR / AI defence list only missiles that can still hit) and
    // prompt self-destruct of defeated missiles
    const orig = world.getEntity(m.originalTargetId);
    if (orig && orig.kind === 'aircraft') m.threat = assessThreat(m, orig, dt);
    else m.threat = false;
    const defeated = orig && orig.kind === 'aircraft' ? !m.threat : m.trackBroken || !orig || !orig.alive;
    if (defeated) {
      m.defeatTimer += dt;
      if (m.defeatTimer > DEFEAT_LINGER) return selfDestruct(ctx, m);
    } else m.defeatTimer = 0;

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

/**
 * Guidance lost (illuminator / uplink / seeker gone): the control fins go to neutral and the
 * missile's flight path wanders off the collision course (a random ~2–4 % lateral velocity kick,
 * i.e. tens of metres after a second) — a missile whose launcher was shot down rarely still hits.
 */
function guidanceLossTransient(ctx: CombatCtx, m: CombatMissile): void {
  m.lossKicked = true;
  if (m.cdef.category !== 'aam' && m.cdef.category !== 'sam') return;
  const v = m.velocity.length();
  if (v < 1) return;
  _vhat.copy(m.velocity).divideScalar(v);
  _ax.set(ctx.rng() - 0.5, ctx.rng() - 0.5, ctx.rng() - 0.5);
  _ax.addScaledVector(_vhat, -_ax.dot(_vhat));
  const l = _ax.length();
  if (l < 1e-6) return;
  m.velocity.addScaledVector(_ax, ((0.02 + 0.02 * ctx.rng()) * v) / l);
  m.aLat.set(0, 0, 0);
}

/**
 * Can this missile still hit its (original) target aircraft? False once guidance is lost, it is
 * following a decoy that won't pass inside fuze reach, it has passed / is opening, or it is too
 * slow to catch up after burnout.
 */
function assessThreat(m: CombatMissile, ac: AircraftEntity, dt: number): boolean {
  if (!ac.alive || m.trackBroken) return false;
  const range = m.position.distanceTo(ac.position);
  if (range > m.prevThreatRange + 0.01) m.openTime += dt;
  else m.openTime = 0;
  m.prevThreatRange = range;
  // passed the target / opening after the motor burnt out
  if (m.openTime > 0.4 && (m.age > m.burnEnd || range < 2_000)) return false;
  // too slow to catch it any more
  if (m.age > m.burnEnd && m.speed < m.cdef.minKillSpeed * 0.8) return false;
  if (m.decoyed && m.targetId !== ac.id) {
    // chasing a decoy: dangerous only if it is about to pass inside fuze reach of the jet anyway
    _d0.subVectors(ac.position, m.position);
    _dd.subVectors(ac.velocity, m.velocity);
    const vv = _dd.lengthSq();
    if (vv < 1) return false;
    const tStar = -_d0.dot(_dd) / vv;
    if (tStar < 0 || tStar > 2) return false;
    const miss = _d0.addScaledVector(_dd, tStar).length();
    return miss < m.cdef.fuseRadius + ac.radius;
  }
  return true;
}

/**
 * SAM point-defence interceptor vs an incoming munition: fuzes at the closest approach and kills
 * it with the site's point-defence probability. Returns true if the interceptor detonated.
 */
function interceptCheck(ctx: CombatCtx, m: CombatMissile, mun: CombatMissile, dt: number): boolean {
  _t0.copy(mun.position).addScaledVector(mun.velocity, -dt);
  sweptClosest(_p0, m.position, _t0, mun.position, _sweep);
  m.closestApproach = Math.min(m.closestApproach, _sweep.dist);
  const reach = m.cdef.fuseRadius + 2;
  if (_sweep.dist > reach) return false;
  if (_sweep.s >= 0.999 && _sweep.dist > reach * 0.3) return false;
  _pt.lerpVectors(_p0, m.position, _sweep.s);
  finish(ctx, m, _pt, 'proximity', 'air');
  const site = ctx.world.getEntity(m.shooterId);
  const pk = site && site.kind === 'sam' ? pointDefensePk(site, mun.cdef.category) : 0.5;
  if (!mun.ended && ctx.rng() < pk) {
    finish(ctx, mun, mun.position, 'selfdestruct', 'air', 'small');
    const shooter = ctx.world.getEntity(mun.shooterId);
    if (shooter && shooter.kind === 'aircraft' && shooter.isPlayer && ctx.time - ctx.chatter.sam > 3) {
      ctx.chatter.sam = ctx.time;
      const who = site && site.kind === 'sam' ? SAM_INFO[site.type].nato.split(' ')[0] : 'SAM';
      radio(ctx, 'DARKSTAR', `${mun.cdef.short} shot down by ${who}`, undefined, shooter.team, 2);
    }
  }
  return true;
}

/** Proximity fuze vs one aircraft. Returns true if the warhead fired. */
function fuzeCheck(ctx: CombatCtx, m: CombatMissile, ac: AircraftEntity, dt: number): boolean {
  const def = m.cdef;
  _t0.copy(ac.position).addScaledVector(ac.velocity, -dt);
  sweptClosest(_p0, m.position, _t0, ac.position, _sweep);
  if (ac.id === m.targetId || ac.id === m.originalTargetId) m.closestApproach = Math.min(m.closestApproach, _sweep.dist);
  let fuse = def.fuseRadius;
  if (m.team !== (ctx.world.player?.team ?? 'blue')) fuse *= clamp(0.75 + 0.25 * ctx.world.difficulty.enemyMissileSkill, 0.8, 1.1);
  // a missile that lost guidance no longer has a target-detecting fuze window: direct hit only
  if (m.trackBroken) fuse = 0;
  const reach = fuse + ac.radius * 0.5;
  if (_sweep.dist > reach) return false;
  // fire at the closest point: when the minimum falls inside this step, or when already very close
  if (_sweep.s >= 0.999 && _sweep.dist > fuse * 0.3) return false;
  _pt.lerpVectors(_p0, m.position, _sweep.s);
  const direct = _sweep.dist <= ac.radius * (m.trackBroken ? 0.3 : 0.5);
  if (m.trackBroken && !direct) return false;
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
    // civil ships: distance to the long hull, not to a 140 m bounding sphere
    const d = e.kind === 'ground' && e.vessel ? vesselHullDistance(e, point) : Math.max(0, point.distanceTo(e.position) - e.radius * radiusFactor);
    if (d >= def.blastRadius) return;
    const dmg = def.damage * (1 - d / def.blastRadius);
    if (dmg <= 0.5) return;
    world.applyDamage(e, dmg, m.shooterId, def.id, point);
    if (e === primary) hitPrimary = true;
    if (isHostile(m.team, e.team)) hitHostile = true; // hitting civil traffic is no "hit" for accuracy
  };
  for (const ac of world.aircraft) hurt(ac, 0.5);
  if (def.category === 'bomb' || def.category === 'agm') {
    for (const s of world.sams) hurt(s, 0.6);
    for (const g of world.ground) hurt(g, 0.6);
  }
  if (hitHostile && shooter && shooter.kind === 'aircraft') shooter.hits++;
  // protected landmarks: one hit from the player's bomb / AGM / AAM whose blast reaches the
  // structure brings it down (the gun, SAMs and other aircraft's munitions do not)
  if (world.landmarks.length && def.category !== 'sam' && shooter && shooter.kind === 'aircraft' && shooter.isPlayer) {
    const reach = def.blastRadius * STRUCTURAL_BLAST_FRACTION;
    for (const lm of world.landmarks) {
      if (lm.alive && landmarkDistance(lm, point) < reach) destroyLandmark(lm, world.events, ctx.time, point, m.shooterId, def.id, shooter.position);
    }
  }
  return hitPrimary;
}

/** A munition flew into a structure: it goes off there if armed (bombs always do). */
function structureImpact(ctx: CombatCtx, m: CombatMissile): void {
  const armed = m.age >= m.cdef.armTime || m.cdef.category === 'bomb';
  const target = ctx.world.getEntity(m.targetId);
  const hitPrimary = armed ? applyBlast(ctx, m, m.position, target) : false;
  finish(ctx, m, m.position, hitPrimary ? 'hit' : 'ground', 'air', armed ? m.cdef.blast : 'tiny');
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
  // targetId = the entity the missile was fired at (not the decoy that seduced it), so HUD/audio
  // can report "MISSILE DEFEATED" for missiles aimed at the player
  const targetId = (m.cdef.category === 'aam' || m.cdef.category === 'sam') && m.originalTargetId !== null ? m.originalTargetId : m.targetId;
  events.emit('munition:end', { missile: m, position: m.position, reason, targetId });
}
