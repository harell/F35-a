/**
 * F35-A — missile guidance: target-state acquisition per guidance type and the steering laws.
 *
 *  active_radar  inertial midcourse + datalink from the launcher's track, "pitbull" at activeRange
 *  semi_active   needs the launcher's (aircraft STT lock / SAM radar track) illumination + LOS
 *  command       guided by the SAM site radar; site dead / radar off / terrain LOS lost ⇒ ballistic
 *  ir            seeker FOV/gimbal/range vs IR signature (flares handled in countermeasures.ts)
 *  anti_radiation homes on emitting radars, keeps a degraded last-known point when they shut down
 *  gps           glides/falls to the designated point with limited control authority
 *
 * Steering: proportional navigation (N≈3–4, gravity compensated), pursuit turn-over for large
 * heading errors (vertical launch / high off-boresight), loft for long shots, best-glide for bombs.
 */
import { Vector3 } from 'three';
import { G, clamp } from '../../core/math';
import { airDensity } from '../../core/atmosphere';
import type { AircraftEntity as AircraftEnt, AnyEntity, SamSiteEntity } from '../entities';
import type { CombatCtx } from './context';
import { acState, gaussian, SENSOR_DIV } from './context';
import type { CombatMissile } from './missile';
import { aircraftRcs, irIntensity, rcsRangeFactor } from '../sensors/signatures';
import { AAM_IMMUNE_CAP, cmFactor, notchDepth, rollNotchNeed, stepNotch } from './ew';
import { breakSiteTrack, siteTracks } from '../sam/SamSystem';

export { notchDepth } from './ew';

const _r = new Vector3();
const _vrel = new Vector3();
const _los = new Vector3();
const _omega = new Vector3();
const _tmp = new Vector3();
const _aim = new Vector3();
const _vhat = new Vector3();

/** Semi-active: seconds without illumination before the missile goes ballistic. */
export const SARH_MEMORY = 0.3;
/** Command guidance: seconds of coasting on the last uplink before going ballistic. */
export const COMMAND_MEMORY = 1.0;
/** Guider destroyed: the uplink / illumination stops at once. */
export const GUIDER_DEAD_MEMORY = 0.2;
/** Active radar: seconds after losing the seeker lock (post-pitbull) before the missile is lost. */
export const ACTIVE_MEMORY = 2.5;
/** TWS (no STT) midcourse: track revisit period (s) and error model. */
export const TWS_REVISIT = 2;

/** @deprecated use cmFactor (ew.ts). Countermeasure / notch multiplier for a missile vs its target. */
export function cmScale(ctx: CombatCtx, m: CombatMissile, target: AnyEntity): number {
  return cmFactor(ctx, m.team, target);
}

/** Angle between the missile's velocity and the direction to a point is within `limit`. */
export function inGimbal(m: CombatMissile, point: Vector3, limit: number): boolean {
  if (limit >= Math.PI - 1e-3) return true;
  _tmp.subVectors(point, m.position);
  const d = _tmp.length();
  const v = m.velocity.length();
  if (d < 1 || v < 1) return true;
  return _tmp.dot(m.velocity) / (d * v) >= Math.cos(limit);
}

/** Break the illuminating/guiding radar's track after a successful chaff seduction. */
export function breakGuiderTrack(ctx: CombatCtx, m: CombatMissile, targetId: number): void {
  const guider = ctx.world.getEntity(m.guiderId);
  if (!guider) return;
  if (guider.kind === 'aircraft' && guider.radar.lockedId === targetId) {
    guider.radar.lockedId = null;
    guider.radar.lockProgress = 0;
    acState(guider).lockLostTimer = 0;
    ctx.world.events.emit('lock', { ownerId: guider.id, targetId, locked: false });
  } else if (guider.kind === 'sam') {
    breakSiteTrack(ctx, guider, targetId);
  }
}

function setEstimate(ctx: CombatCtx, m: CombatMissile, pos: Vector3, vel: Vector3): void {
  m.estPos.copy(pos);
  m.estVel.copy(vel);
  m.estTime = ctx.time;
  m.hasEstimate = true;
  m.lostTimer = 0;
}

/** Track lost: the memory-mode extrapolation picks up a velocity error (grows into a position error). */
export function memoryError(ctx: CombatCtx, m: CombatMissile): void {
  const ang = ctx.rng() * Math.PI * 2;
  const mag = 25 + 40 * ctx.rng();
  _tmp.set(Math.cos(ang) * mag, (ctx.rng() - 0.5) * mag * 0.6, Math.sin(ang) * mag);
  m.estVel.add(_tmp);
}

function siteLos(ctx: CombatCtx, m: CombatMissile, site: SamSiteEntity, target: AnyEntity, dt: number): boolean {
  m.losTimer -= dt;
  if (m.losTimer <= 0) {
    m.losTimer = 0.25;
    _tmp.copy(site.position);
    _tmp.y += 12;
    m.losOk = ctx.world.terrain.lineOfSight(_tmp, target.position);
  }
  return m.losOk;
}

/**
 * Terminal (millimetre-wave) seeker success chance of an anti-radiation missile against an
 * emitter that went silent: crews are better at hiding / the seeker is less lucky on harder
 * difficulties, and a large memory error puts the site outside the seeker footprint.
 */
export function armTerminalChance(ctx: CombatCtx, errorM: number): number {
  const base = 0.82 - 0.5 * ctx.world.difficulty.aiSkill; // recruit ≈ 0.7 … ace ≈ 0.35
  return base * clamp(1.25 - errorM / 320, 0.15, 1);
}

/**
 * Midcourse datalink error (m) from the launcher's track quality. While the launcher's radar sees
 * the target in its Doppler notch the error grows (~(0.5 + 0.5·k)·150 m per s·depth, squared ramp);
 * it recovers slowly (0.7/s) once the target leaves the notch. An F-35 launcher's fused track (DAS /
 * EOTS / MADL) does not notch. A seeker immune to the notch (notchNeed ∞) is fed a clean track.
 */
export function midcourseError(ctx: CombatCtx, m: CombatMissile, launcher: AircraftEnt, target: AircraftEnt, dt: number): number {
  if (launcher.type === 'f35a' || m.notchNeed === Infinity) return 0;
  const depth = notchDepth(ctx, launcher.position, target);
  m.dlNotch = stepNotch(m.dlNotch, depth, dt);
  if (m.dlNotch <= 0) return 0;
  if (m.dlErrDir.lengthSq() < 0.5) {
    m.dlErrDir.set(gaussian(ctx.rng), gaussian(ctx.rng) * 0.4, gaussian(ctx.rng));
    if (m.dlErrDir.lengthSq() < 1e-6) m.dlErrDir.set(1, 0, 0);
    m.dlErrDir.normalize();
  }
  const k = cmFactor(ctx, m.team, target);
  return 150 * (0.5 + 0.5 * k) * m.dlNotch * (1 + 0.5 * m.dlNotch);
}

/**
 * TWS midcourse: re-roll the launcher's track error at each TWS revisit. The error grows with the
 * range to the target (≈ 0.6 km at 10 km, 1.35 km at 20 km, 2.3 km at 30 km, 1σ per horizontal axis).
 */
function rollTwsError(ctx: CombatCtx, m: CombatMissile, range: number): void {
  const rk = range / 1000;
  const sp = 150 + 30 * rk + 1.5 * rk * rk;
  const sv = 30;
  m.twsPosErr.set(gaussian(ctx.rng) * sp, gaussian(ctx.rng) * sp * 0.5, gaussian(ctx.rng) * sp);
  m.twsVelErr.set(gaussian(ctx.rng) * sv, gaussian(ctx.rng) * sv * 0.4, gaussian(ctx.rng) * sv);
}

/**
 * Refresh the missile's target estimate from its guidance source (seeker, datalink,
 * illuminator, command link). Sets seekerLocked / trackBroken / decoy following.
 */
export function updateGuidanceData(ctx: CombatCtx, m: CombatMissile, dt: number): void {
  const def = m.cdef;
  if (m.dudAt >= 0 && ctx.time - m.launchTime >= m.dudAt && !m.trackBroken) {
    m.trackBroken = true; // rookie shot went stupid (Recruit forgiveness, see launchMissile)
    memoryError(ctx, m);
  }
  if (!m.guided || m.trackBroken) {
    m.seekerLocked = false;
    return;
  }
  if (def.guidance === 'gps') return;
  const world = ctx.world;
  const target = world.getEntity(m.targetId);
  const checkTick = (ctx.tick + m.id) % SENSOR_DIV === 0;

  if (def.guidance === 'anti_radiation') {
    if (!target || (target.kind !== 'sam' && target.kind !== 'ground')) return; // keep flying to the last point
    const emitting = target.alive && (target.kind === 'sam' ? target.radarOn : target.emitter);
    const dist = m.position.distanceTo(target.position);
    if (emitting && dist <= def.seekerRange && inGimbal(m, target.position, def.gimbalLimit)) {
      setEstimate(ctx, m, target.position, target.velocity);
      m.armMemory = false;
      m.seekerLocked = true;
    } else if (!emitting) {
      if (!m.armMemory) {
        // emitter shut down: fly to the last fix with an angle-only / INS error that grows with the
        // range at shutdown (a site that goes quiet early is hard to find)
        m.armMemory = true;
        const ang = ctx.rng() * Math.PI * 2;
        const err = (25 + 0.012 * dist) * (0.5 + ctx.rng());
        m.armError.set(Math.cos(ang) * err, 0, Math.sin(ang) * err);
        m.estPos.add(m.armError);
        m.seekerLocked = false;
      }
      // AARGM millimetre-wave terminal seeker may still find the (silent) site
      if (!m.terminalRolled && target.alive && m.position.distanceTo(m.estPos) < 3_000) {
        m.terminalRolled = true;
        if (ctx.rng() < armTerminalChance(ctx, m.armError.length())) {
          m.estPos.copy(target.position);
          m.armMemory = false;
          m.seekerLocked = true;
        }
      }
    }
    m.targetPoint.copy(m.estPos);
    return;
  }

  if (!target || !target.alive) {
    m.trackBroken = true;
    m.seekerLocked = false;
    return;
  }

  // A decoyed missile follows its decoy until it burns out.
  if (target.kind === 'decoy') {
    setEstimate(ctx, m, target.position, target.velocity);
    m.seekerLocked = true;
    return;
  }

  if (def.guidance === 'ir') {
    if (target.kind !== 'aircraft') return;
    const range = def.seekerRange * Math.sqrt(irIntensity(target, m.position)) * 1.15;
    if (m.position.distanceTo(target.position) <= range && inGimbal(m, target.position, def.gimbalLimit)) {
      setEstimate(ctx, m, target.position, target.velocity);
      m.seekerLocked = true;
    } else {
      m.seekerLocked = false;
      m.lostTimer += dt;
      if (m.lostTimer > 1.2) m.trackBroken = true;
    }
    return;
  }

  if (def.guidance === 'active_radar') {
    if (target.kind !== 'aircraft') return;
    if (m.notchBlank > 0) m.notchBlank -= dt;
    // this seeker's susceptibility to the Doppler notch (∞ = its processing is not fooled)
    if (m.notchNeed < 0) m.notchNeed = rollNotchNeed(ctx, def.notchResistance, cmFactor(ctx, m.team, target), AAM_IMMUNE_CAP);
    const seekRange = def.seekerRange * rcsRangeFactor(aircraftRcs(target, m.position));
    const dist = m.position.distanceTo(target.position);
    // the seeker's Doppler filter starts working on the target from its search basket (before it
    // can lock): a beam held while the missile closes counts toward the notch break
    if (!m.seekerLocked && !m.everLocked && dist < seekRange * 1.5) m.notchAccum = stepNotch(m.notchAccum, notchDepth(ctx, m.position, target), dt);
    if (m.seekerLocked) {
      if (dist <= seekRange * 1.3 && inGimbal(m, target.position, def.gimbalLimit)) {
        setEstimate(ctx, m, target.position, target.velocity);
        // a sustained Doppler notch (beam + clutter behind the target) breaks the seeker's track
        m.notchAccum = stepNotch(m.notchAccum, notchDepth(ctx, m.position, target), dt);
        if (m.notchAccum >= m.notchNeed) {
          m.seekerLocked = false;
          m.notchBlank = 1.0;
          m.notchAccum = 0;
          memoryError(ctx, m);
        }
      } else {
        m.seekerLocked = false;
      }
      return;
    }
    if (m.everLocked) {
      // memory mode after a break-lock: lost for good if the seeker can't find the target again
      m.lostTimer += dt;
      if (m.lostTimer > ACTIVE_MEMORY) {
        m.trackBroken = true;
        return;
      }
    }
    // Midcourse: datalink updates while the launcher holds a track on the target.
    if (def.datalink && !m.everLocked) {
      const launcher = world.getEntity(m.shooterId);
      if (launcher && launcher.kind === 'aircraft' && launcher.alive) {
        // F-35 sensor fusion feeds any fused track; others need their own radar track
        const c = acState(launcher).contacts.get(target.id);
        const fresh = c && (launcher.type === 'f35a' ? c.lastSeen >= ctx.time - 0.6 : c.radarTime >= ctx.time - 0.6);
        if (c && fresh) {
          const stt = launcher.radar.lockedId === target.id && launcher.radar.emitting;
          // the uplink is only as good as the launcher's track: a target beaming the LAUNCHER's
          // radar (its Doppler notch, clutter behind) or chaff walking its gates off drags the
          // uplinked position / velocity away — the seeker then searches the wrong basket
          const dlErr = midcourseError(ctx, m, launcher, target, dt);
          if (stt || !m.tws) {
            m.estPos.copy(c.position).addScaledVector(m.dlErrDir, dlErr);
            m.estVel.copy(c.velocity).addScaledVector(m.dlErrDir, dlErr * 0.12);
            m.estTime = c.lastSeen;
            m.lostTimer = 0;
          } else if (ctx.time >= m.twsNext) {
            // TWS: coarse, noisy updates at the scan revisit rate (error grows with range)
            m.twsNext = ctx.time + TWS_REVISIT;
            rollTwsError(ctx, m, launcher.position.distanceTo(c.position));
            m.estPos.copy(c.position).add(m.twsPosErr).addScaledVector(m.dlErrDir, dlErr);
            m.estVel.copy(c.velocity).add(m.twsVelErr).addScaledVector(m.dlErrDir, dlErr * 0.12);
            m.estTime = c.lastSeen;
            m.lostTimer = 0;
          }
        }
      }
    }
    // Pitbull: the seeker switches on when the estimated range-to-go drops below activeRange.
    _tmp.copy(m.estPos).addScaledVector(m.estVel, ctx.time - m.estTime);
    const toGo = m.position.distanceTo(_tmp);
    if ((toGo < def.activeRange || m.everLocked) && m.notchBlank <= 0 && checkTick && dist <= seekRange) {
      // target must be inside the seeker's search basket around the predicted position (a TWS-cued
      // seeker searches a narrower basket: its range/Doppler gates come from a coarser track)
      _los.subVectors(_tmp, m.position).normalize();
      _r.subVectors(target.position, m.position).normalize();
      const inCone = _los.dot(_r) >= Math.cos(m.tws && !m.everLocked ? def.seekerFov * 0.5 : def.seekerFov);
      if (inCone && inGimbal(m, target.position, def.gimbalLimit)) {
        // a target sitting in the Doppler notch is very hard to (re)acquire — unless this seeker's
        // processing isn't fooled by it (immune roll)
        const depth = m.notchNeed === Infinity ? 0 : notchDepth(ctx, m.position, target);
        // a beam already held long enough from the basket: the Doppler filter never finds it
        const beaten = m.notchNeed !== Infinity && m.notchAccum >= m.notchNeed;
        const pAcq = beaten || depth > 0.5 ? 0.02 : 1 - depth * (1 - def.notchResistance);
        if (ctx.rng() < pAcq) {
          m.seekerLocked = true;
          m.everLocked = true;
          setEstimate(ctx, m, target.position, target.velocity);
        }
      }
    }
    return;
  }

  if (def.guidance === 'semi_active' || def.guidance === 'command') {
    const guider = world.getEntity(m.guiderId);
    const guiderLost = !guider || !guider.alive;
    let supported = false;
    if (target.kind === 'missile') {
      // SAM point defence against an incoming munition (command uplink from the site's radar)
      if (!guiderLost && guider.kind === 'sam') supported = guider.radarOn && siteTracks(guider, target.id) && siteLos(ctx, m, guider, target, dt);
      if (supported) {
        setEstimate(ctx, m, target.position, target.velocity);
        m.seekerLocked = true;
      } else {
        m.seekerLocked = false;
        m.lostTimer += dt;
        if (m.lostTimer > (guiderLost ? GUIDER_DEAD_MEMORY : COMMAND_MEMORY)) m.trackBroken = true;
      }
      return;
    }
    if (target.kind !== 'aircraft') return;
    if (!guiderLost) {
      if (guider.kind === 'aircraft') {
        // STT lock held, target inside the radar gimbal AND painted this sweep (not notched / masked)
        const c = acState(guider).contacts.get(target.id);
        supported = guider.radar.emitting && guider.radar.lockedId === target.id && !!c && c.inGimbal && c.radarTime >= ctx.time - 0.35;
      } else if (guider.kind === 'sam') {
        // the site must hold a fire-control-quality track (see SamSystem: notch, chaff, EMCON break it)
        supported = guider.radarOn && siteTracks(guider, target.id) && siteLos(ctx, m, guider, target, dt);
      }
    }
    const seekerOk = def.guidance === 'command' || inGimbal(m, target.position, def.gimbalLimit);
    if (supported && seekerOk) {
      setEstimate(ctx, m, target.position, target.velocity);
      // TVM (SA-10) seeker / SARH seeker "locked" once the missile is near
      m.seekerLocked = def.guidance === 'semi_active' || m.position.distanceTo(target.position) < Math.max(3_000, def.seekerRange);
    } else {
      m.seekerLocked = false;
      m.lostTimer += dt;
      const limit = guiderLost ? GUIDER_DEAD_MEMORY : def.guidance === 'semi_active' ? SARH_MEMORY : COMMAND_MEMORY;
      if (m.lostTimer > limit) m.trackBroken = true;
    }
  }
}

/* ───────────────────────── Steering laws ───────────────────────── */

/** Below this time-to-go (s) with the seeker on the target, steer with true PN on the target. */
const ENDGAME_TGO = 2.5;
/** Heading error to the intercept point beyond which the missile does a max-g turn instead of PN. */
const COS_PURSUIT = Math.cos((25 * Math.PI) / 180);
/** End-game PN only while the target is within this angle of the velocity vector (cos). */
const COS_ENDGAME_PN = Math.cos((35 * Math.PI) / 180);
/** Heading error beyond which midcourse PN gets an extra pursuit term (rad → cos). */
const COS_HEADING_TERM = Math.cos((3 * Math.PI) / 180);
/** Time constant of the midcourse heading-error term (s). */
const HEADING_TAU = 1.3;
/** Aim point stays this far above the terrain until the endgame (m). */
const AIM_CLEARANCE = 40;
/** Terrain avoidance: look-ahead time (s) and minimum clearance (m). */
const TERRAIN_LOOKAHEAD = 1.2;
const TERRAIN_GAP = 30;

/** Loft: aim point raised by k·(range − end), capped at max (m). */
const LOFT = {
  aam: { end: 7_000, k: 0.25, max: 5_000 },
  agm: { end: 10_000, k: 0.35, max: 9_000 },
};

/**
 * Missile reach model from its current state: remaining motor burn (average acceleration minus
 * drag), then coast with v(t) = v₀ / (1 + k v₀ t), s(t) = ln(1 + k v₀ t) / k, k = drag·ρ.
 */
const reach = { tb: 0, vb: 0, sb: 0, k: 0, v0: 0, a: 0 };
function setupReach(m: CombatMissile, v: number): void {
  const def = m.cdef;
  const k = Math.max(1e-7, def.drag * airDensity(m.position.y));
  const tb = m.age - def.igniteDelay;
  let burn = 0;
  let dv = 0;
  if (tb < def.boostTime) {
    const bt = def.boostTime - Math.max(0, tb);
    burn = bt + def.sustainTime;
    dv = def.boostAccel * bt + def.sustainAccel * def.sustainTime;
  } else if (tb < def.boostTime + def.sustainTime) {
    burn = def.boostTime + def.sustainTime - tb;
    dv = def.sustainAccel * burn;
  }
  let vb = v;
  if (burn > 0) {
    // drag during the burn evaluated at the mean speed
    const vMid = v + 0.5 * dv;
    vb = Math.max(v * 0.8, v + dv - k * vMid * vMid * burn);
  }
  reach.tb = burn;
  reach.vb = vb;
  reach.sb = 0.5 * (v + vb) * burn;
  reach.k = k;
  reach.v0 = v;
  reach.a = burn > 0 ? (vb - v) / burn : 0;
}
function reachDist(t: number): number {
  if (t <= reach.tb) return reach.v0 * t + 0.5 * reach.a * t * t;
  const tc = t - reach.tb;
  return reach.sb + Math.log(1 + reach.k * reach.vb * tc) / reach.k;
}
function reachSpeed(t: number): number {
  if (t <= reach.tb) return reach.v0 + reach.a * t;
  return reach.vb / (1 + reach.k * reach.vb * (t - reach.tb));
}

const _p = new Vector3();

/**
 * Time to go (s) until the missile, flying straight with its decaying speed, meets a target at
 * relative position r moving at vT: first root of reach(t) = |r + vT·t| (coarse scan +
 * bisection). With no solution (target outrunning us) → time of the best approach.
 */
const _tr = new Vector3();
const _tv = new Vector3();
/** reach(t) − distance to the target's future position (uses _tr/_tv). */
function gap(t: number): number {
  return reachDist(t) - _p.copy(_tr).addScaledVector(_tv, t).length();
}

function timeToGo(m: CombatMissile, r: Vector3, vT: Vector3, v: number): number {
  setupReach(m, v);
  _tr.copy(r);
  _tv.copy(vT);
  const f = gap;
  const tMax = Math.max(5, m.cdef.maxFlightTime - m.age + 5);
  const step = 0.5;
  let prevT = 0;
  let bestT = 0;
  let bestF = -Infinity;
  for (let t = step; t <= tMax; t += step) {
    const ft = f(t);
    if (ft >= 0) {
      // bisection between prevT and t
      let lo = prevT;
      let hi = t;
      for (let i = 0; i < 8; i++) {
        const mid = 0.5 * (lo + hi);
        if (f(mid) >= 0) hi = mid;
        else lo = mid;
      }
      return hi;
    }
    if (ft > bestF) {
      bestF = ft;
      bestT = t;
    }
    prevT = t;
  }
  return bestT;
}

/**
 * Lateral acceleration command (world, perpendicular to velocity) toward the target estimate.
 * `aMax` is the currently available lateral acceleration.
 */
export function steeringCommand(ctx: CombatCtx, m: CombatMissile, aMax: number, out: Vector3): Vector3 {
  out.set(0, 0, 0);
  const def = m.cdef;
  const v = m.velocity.length();
  if (v < 1 || !m.hasEstimate) return out;
  _vhat.copy(m.velocity).divideScalar(v);
  _aim.copy(m.estPos).addScaledVector(m.estVel, Math.max(0, ctx.time - m.estTime));

  if (def.category === 'bomb') return bombCommand(m, v, aMax, out);

  _r.subVectors(_aim, m.position);
  const R0 = _r.length();
  if (R0 < 1) return out;

  // Time to go with a deceleration-aware reach model (refreshed at 10 Hz), then the intercept point.
  if (m.tgoAge < 0 || m.tgoAge >= 0.1 || m.seekerLocked !== m.tgoLocked) {
    m.tgo = timeToGo(m, _r, m.estVel, v);
    m.tgoAge = 0;
    m.tgoLocked = m.seekerLocked;
  }
  const tgo = Math.max(0, m.tgo - m.tgoAge);
  // end-game true PN only with the target reasonably close to the velocity vector: a high
  // off-boresight / fast crossing shot keeps flying the max-g lead turn to the intercept point
  const endgame = tgo < ENDGAME_TGO && m.seekerLocked && _vhat.dot(_r) >= COS_ENDGAME_PN * R0;
  if (endgame) {
    // final seconds: true proportional navigation on the target itself
    _vrel.subVectors(m.estVel, m.velocity);
  } else {
    // fly toward the (quasi-stationary) predicted intercept point — a near-straight collision course
    _aim.addScaledVector(m.estVel, tgo);
    if (m.loft && !m.seekerLocked) {
      const L = def.category === 'agm' ? LOFT.agm : LOFT.aam;
      _aim.y += clamp((_aim.distanceTo(m.position) - L.end) * L.k, 0, L.max);
    }
    // terrain clearance: never aim into the ground before the endgame
    if (tgo > 2) {
      const floor = ctx.world.terrain.surfaceHeightAt(_aim.x, _aim.z) + AIM_CLEARANCE;
      if (_aim.y < floor) _aim.y = floor;
    }
    _vrel.copy(m.velocity).negate();
  }
  _r.subVectors(_aim, m.position);
  const R = Math.max(1, _r.length());
  _los.copy(_r).divideScalar(R);
  const vc = -_r.dot(_vrel) / R;
  const cosErr = _vhat.dot(_los);

  if (!endgame && cosErr < COS_PURSUIT && R > 400) {
    // Large heading error to the intercept point (high off-boresight shot, crossing target): max-g
    // turn — after burnout only as hard as the energy allows (stay above the kill speed)
    out.copy(_los).addScaledVector(_vhat, -cosErr);
    const len = out.length();
    let a = aMax;
    if (m.age > m.burnEnd && def.minKillSpeed > 0) a *= clamp((v - def.minKillSpeed) / (0.6 * def.minKillSpeed), 0.25, 1);
    if (len > 1e-6) out.multiplyScalar(a / len);
  } else {
    // Proportional navigation: a = N · Vc · (ω × LOS)
    _omega.crossVectors(_r, _vrel).divideScalar(R * R);
    out.crossVectors(_omega, _los).multiplyScalar(def.navConstant * Math.max(vc, 0.3 * v));
    out.y += G; // gravity compensation
    // heading-error term in midcourse: PN alone corrects a heading error to a far aim point only
    // slowly (a ∝ v²·ε/R) — add a pursuit term a = v·ε/τ so the missile settles on the collision course
    if (!endgame && cosErr < COS_HEADING_TERM) {
      _tmp.copy(_los).addScaledVector(_vhat, -cosErr);
      out.addScaledVector(_tmp, v / HEADING_TAU);
    }
  }
  // lateral only
  out.addScaledVector(_vhat, -out.dot(_vhat));
  // terrain avoidance before the endgame: pull up if the flight path would clip the ground
  if (!endgame) {
    _tmp.copy(m.position).addScaledVector(m.velocity, TERRAIN_LOOKAHEAD);
    const gap = _tmp.y - ctx.world.terrain.surfaceHeightAt(_tmp.x, _tmp.z);
    const aimLow = _aim.y - ctx.world.terrain.surfaceHeightAt(_aim.x, _aim.z) < TERRAIN_GAP && tgo < 3;
    if (gap < TERRAIN_GAP && !aimLow) {
      _tmp.set(0, 1, 0).addScaledVector(_vhat, -_vhat.y);
      const l = _tmp.length();
      if (l > 1e-3) out.addScaledVector(_tmp, (Math.min(TERRAIN_GAP * 2, TERRAIN_GAP - gap) * 6) / l);
    }
  }
  return out;
}

/** GPS bomb law: best-glide toward the point while it is "above" the glide slope, then PN onto it. */
function bombCommand(m: CombatMissile, v: number, aMax: number, out: Vector3): Vector3 {
  const def = m.cdef;
  _r.subVectors(_aim, m.position);
  const horiz = Math.hypot(_r.x, _r.z);
  const h = -_r.y;
  const depression = Math.atan2(h, horiz);
  const glide = Math.atan(1 / Math.max(0.5, def.glideRatio * 0.75));
  if (depression > glide + 0.05 || horiz < 1_500) {
    const R = _r.length();
    if (R < 1) return out;
    _los.copy(_r).divideScalar(R);
    _vrel.copy(m.velocity).negate();
    const vc = -_r.dot(_vrel) / R;
    _omega.crossVectors(_r, _vrel).divideScalar(R * R);
    out.crossVectors(_omega, _los).multiplyScalar(def.navConstant * Math.max(vc, 0.3 * v));
    out.y += G;
  } else {
    // best glide along the horizontal bearing to the target
    const inv = horiz > 1e-3 ? 1 / horiz : 0;
    _los.set(_r.x * inv * Math.cos(glide), -Math.sin(glide), _r.z * inv * Math.cos(glide));
    out.copy(_los).addScaledVector(_vhat, -_los.dot(_vhat)).multiplyScalar(v * 1.2);
    out.y += G * Math.cos(glide);
  }
  out.addScaledVector(_vhat, -out.dot(_vhat));
  if (out.length() > aMax) out.setLength(aMax);
  return out;
}
