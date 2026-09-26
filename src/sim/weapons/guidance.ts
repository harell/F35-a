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
import type { AircraftEntity, AnyEntity, SamSiteEntity } from '../entities';
import type { CombatCtx } from './context';
import { acState, playerTeam, SENSOR_DIV } from './context';
import type { CombatMissile } from './missile';
import { aircraftRcs, irIntensity, rcsRangeFactor } from '../sensors/signatures';

const _r = new Vector3();
const _vrel = new Vector3();
const _los = new Vector3();
const _omega = new Vector3();
const _tmp = new Vector3();
const _aim = new Vector3();
const _vhat = new Vector3();

/** Countermeasure / notch probability multiplier for a missile vs its target (difficulty). */
export function cmScale(ctx: CombatCtx, m: CombatMissile, target: AnyEntity): number {
  let k = 1;
  if (target.kind === 'aircraft' && target.isPlayer) k *= ctx.world.difficulty.countermeasureEffectiveness;
  if (m.team !== playerTeam(ctx.world)) k /= Math.max(0.3, ctx.world.difficulty.enemyMissileSkill);
  return k;
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

/**
 * Doppler-notch depth 0..1 of a target as seen by a radar at `radarPos`:
 * radial velocity below 40 m/s AND ground clutter behind the target (look-down or low altitude).
 */
export function notchDepth(ctx: CombatCtx, radarPos: Vector3, target: AircraftEntity): number {
  _tmp.subVectors(target.position, radarPos);
  const dist = _tmp.length();
  if (dist < 1) return 0;
  const vr = Math.abs(target.velocity.dot(_tmp) / dist);
  if (vr >= 40) return 0;
  const agl = target.position.y - ctx.world.terrain.surfaceHeightAt(target.position.x, target.position.z);
  const lookDown = _tmp.y < -0.03 * dist;
  const clutter = agl < 1500 ? 1 : lookDown ? 0.8 : 0.2;
  return (1 - vr / 40) * clutter;
}

/** Break the illuminating/guiding radar's track after a successful notch / chaff seduction. */
export function breakGuiderTrack(ctx: CombatCtx, m: CombatMissile, targetId: number): void {
  const guider = ctx.world.getEntity(m.guiderId);
  if (!guider) return;
  if (guider.kind === 'aircraft' && guider.radar.lockedId === targetId) {
    guider.radar.lockedId = null;
    guider.radar.lockProgress = 0;
    acState(guider).lockLostTimer = 0;
    ctx.world.events.emit('lock', { ownerId: guider.id, targetId, locked: false });
  } else if (guider.kind === 'sam' && guider.trackedTargetId === targetId) {
    guider.trackedTargetId = null;
    guider.trackProgress = 0;
    if (guider.state !== 'emcon' && guider.state !== 'off') guider.state = 'search';
  }
}

/** Per-second notch probability → roll at the 10 Hz guidance-check rate. Returns true if the track broke. */
function notchRoll(ctx: CombatCtx, m: CombatMissile, radarPos: Vector3, target: AircraftEntity): boolean {
  const depth = notchDepth(ctx, radarPos, target);
  if (depth <= 0) return false;
  const perSec = 1.3 * (1 - m.cdef.notchResistance) * depth * cmScale(ctx, m, target);
  const p = 1 - Math.exp(-perSec * (SENSOR_DIV / 60));
  return ctx.rng() < p;
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
 * Refresh the missile's target estimate from its guidance source (seeker, datalink,
 * illuminator, command link). Sets seekerLocked / trackBroken / decoy following.
 */
export function updateGuidanceData(ctx: CombatCtx, m: CombatMissile, dt: number): void {
  const def = m.cdef;
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
        // emitter shut down: fly to the last known point with a degraded (INS) error
        m.armMemory = true;
        const ang = ctx.rng() * Math.PI * 2;
        const err = 20 + ctx.rng() * 45;
        m.armError.set(Math.cos(ang) * err, 0, Math.sin(ang) * err);
        m.estPos.add(m.armError);
        m.seekerLocked = false;
      }
      // AARGM millimetre-wave terminal seeker can still find the (silent) site
      if (!m.terminalRolled && target.alive && m.position.distanceTo(m.estPos) < 3_000) {
        m.terminalRolled = true;
        if (ctx.rng() < 0.55) {
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
    const seekRange = def.seekerRange * rcsRangeFactor(aircraftRcs(target, m.position));
    const dist = m.position.distanceTo(target.position);
    if (m.seekerLocked) {
      if (dist <= seekRange * 1.3 && inGimbal(m, target.position, def.gimbalLimit)) {
        setEstimate(ctx, m, target.position, target.velocity);
        if (checkTick && notchRoll(ctx, m, m.position, target)) {
          m.seekerLocked = false;
          m.notchBlank = 1.5;
          memoryError(ctx, m);
        }
      } else {
        m.seekerLocked = false;
      }
      return;
    }
    // Midcourse: datalink updates while the launcher holds a track on the target.
    if (def.datalink) {
      const launcher = world.getEntity(m.shooterId);
      if (launcher && launcher.kind === 'aircraft' && launcher.alive) {
        // F-35 sensor fusion feeds any fused track; others need their own radar track
        const c = acState(launcher).contacts.get(target.id);
        const fresh = c && (launcher.type === 'f35a' ? c.lastSeen >= ctx.time - 0.6 : c.radarTime >= ctx.time - 0.6);
        if (c && fresh) {
          m.estPos.copy(c.position);
          m.estVel.copy(c.velocity);
          m.estTime = c.lastSeen;
          m.lostTimer = 0;
        }
      }
    }
    // Pitbull: the seeker switches on when the estimated range-to-go drops below activeRange.
    _tmp.copy(m.estPos).addScaledVector(m.estVel, ctx.time - m.estTime);
    const toGo = m.position.distanceTo(_tmp);
    if (toGo < def.activeRange && m.notchBlank <= 0 && checkTick && dist <= seekRange) {
      // target must be inside the seeker's search cone around the predicted position
      _los.subVectors(_tmp, m.position).normalize();
      _r.subVectors(target.position, m.position).normalize();
      const inCone = _los.dot(_r) >= Math.cos(def.seekerFov);
      if (inCone && inGimbal(m, target.position, def.gimbalLimit)) {
        // a target sitting in the Doppler notch is very hard to (re)acquire
        const depth = notchDepth(ctx, m.position, target);
        const pAcq = depth > 0.5 ? 0.15 * def.notchResistance : 1 - depth * (1 - def.notchResistance);
        if (ctx.rng() < pAcq) {
          m.seekerLocked = true;
          setEstimate(ctx, m, target.position, target.velocity);
        }
      }
    }
    return;
  }

  if (def.guidance === 'semi_active' || def.guidance === 'command') {
    if (target.kind !== 'aircraft') return;
    const guider = world.getEntity(m.guiderId);
    let supported = false;
    if (guider && guider.alive) {
      if (guider.kind === 'aircraft') {
        // STT lock held AND the radar still paints the target (terrain LOS, not notched)
        const c = acState(guider).contacts.get(target.id);
        supported = guider.radar.emitting && guider.radar.lockedId === target.id && !!c && c.radarTime >= ctx.time - 0.5;
      } else if (guider.kind === 'sam') {
        supported = guider.radarOn && guider.trackedTargetId === target.id && siteLos(ctx, m, guider, target, dt);
      }
    }
    const seekerOk = def.guidance === 'command' || inGimbal(m, target.position, def.gimbalLimit);
    if (supported && seekerOk) {
      setEstimate(ctx, m, target.position, target.velocity);
      // TVM (SA-10) seeker / SARH seeker "locked" once the missile is near
      m.seekerLocked = def.guidance === 'semi_active' || m.position.distanceTo(target.position) < Math.max(3_000, def.seekerRange);
      if (checkTick && guider && notchRoll(ctx, m, guider.position, target)) {
        breakGuiderTrack(ctx, m, target.id);
      }
    } else {
      m.seekerLocked = false;
      m.lostTimer += dt;
      if (m.lostTimer > (def.guidance === 'command' ? 1.0 : 1.5)) m.trackBroken = true;
    }
  }
}

/* ───────────────────────── Steering laws ───────────────────────── */

/** Below this time-to-go (s) with the seeker on the target, steer with true PN on the target. */
const ENDGAME_TGO = 2.5;
/** Heading error to the intercept point beyond which the missile does a max-g turn instead of PN. */
const COS_PURSUIT = Math.cos((25 * Math.PI) / 180);

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
  const endgame = tgo < ENDGAME_TGO && m.seekerLocked;
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
    _vrel.copy(m.velocity).negate();
  }
  _r.subVectors(_aim, m.position);
  const R = Math.max(1, _r.length());
  _los.copy(_r).divideScalar(R);
  const vc = -_r.dot(_vrel) / R;
  const cosErr = _vhat.dot(_los);

  if (!endgame && cosErr < COS_PURSUIT && R > 400) {
    // Large heading error to the intercept point (vertical launch turn-over, high off-boresight shot): max-g turn
    out.copy(_los).addScaledVector(_vhat, -cosErr);
    const len = out.length();
    if (len > 1e-6) out.multiplyScalar(aMax / len);
  } else {
    // Proportional navigation: a = N · Vc · (ω × LOS)
    _omega.crossVectors(_r, _vrel).divideScalar(R * R);
    out.crossVectors(_omega, _los).multiplyScalar(def.navConstant * Math.max(vc, 0.3 * v));
    out.y += G; // gravity compensation
  }
  // lateral only
  out.addScaledVector(_vhat, -out.dot(_vhat));
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
