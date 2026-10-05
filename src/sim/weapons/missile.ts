/**
 * F35-A — CombatMissile (MissileEntity + guidance state) and munition launch.
 */
import { Quaternion, Vector3 } from 'three';
import { clamp } from '../../core/math';
import type { MunitionId, Team } from '../../core/types';
import type { AircraftEntity, AnyEntity, SamSiteEntity } from '../entities';
import { MissileEntity } from '../entities';
import type { CombatCtx } from './context';
import { isSmallGround } from './small';
import { acState } from './context';
import type { CombatMunitionDef } from './defs';

const NOSE = new Vector3(0, 0, -1);

/**
 * Missile/bomb with the combat module's private guidance state. Public MissileEntity fields
 * (phase, motorBurning, seekerLocked, decoyed, targetId, targetPoint…) are kept up to date
 * for HUD/visuals; everything else here is internal.
 */
export class CombatMissile extends MissileEntity {
  readonly cdef: CombatMunitionDef;
  /** Entity whose sensors guide/illuminate this missile (launcher aircraft or SAM site). */
  guiderId: number;
  /** Target at launch (a decoyed missile can still proximity-fuze on it). */
  originalTargetId: number | null;
  /** Estimated target state used by the guidance law. */
  readonly estPos = new Vector3();
  readonly estVel = new Vector3();
  /** Sim time of the last target update (datalink / seeker / illuminator). */
  estTime = 0;
  hasEstimate = false;
  /** Lateral acceleration applied last step (autopilot state, m/s²). */
  readonly aLat = new Vector3();
  /** Seconds without valid guidance data. */
  lostTimer = 0;
  /** Guidance permanently lost (ballistic). */
  trackBroken = false;
  /** Seconds since guidance was permanently lost. */
  ballisticTime = 0;
  /** Guidance-loss transient applied. */
  lossKicked = false;
  /** Seconds the seeker is blanked after a notch/chaff break (re-acquisition window after). */
  notchBlank = 0;
  /** Seconds after burnout without closing on the target (kinematic defeat). */
  openingTimer = 0;
  /** Lofted trajectory selected at launch. */
  loft = false;
  launchRange = 0;
  launchTime = 0;
  /** GPS/ARM weapons: guided (false = unguided ballistic drop). */
  guided = true;
  /** Anti-radiation: random memory error once the emitter shuts down. */
  readonly armError = new Vector3();
  armMemory = false;
  terminalRolled = false;
  /** Command/SARH: cached guider→target line of sight. */
  losOk = true;
  losTimer = 0;
  /** Sim time of the last countermeasure roll (a salvo counts once). */
  lastFlareRoll = -999;
  lastChaffRoll = -999;
  /** Accumulated chaff exposure (Σ of earlier salvo effectiveness) — diminishing returns. */
  chaffExposure = 0;
  /** Sustained-notch accumulator of the missile's own seeker (s·depth) and its break threshold (−1 = not rolled). */
  notchAccum = 0;
  notchNeed = -1;
  /**
   * Midcourse (datalink) degradation: seconds·depth the LAUNCHER's radar has seen the target in its
   * Doppler notch (or been walked off by chaff), and the error direction it drags the uplinked track.
   */
  dlNotch = 0;
  readonly dlErrDir = new Vector3();
  /** Flight time (s) at which this missile's guidance fails (Recruit "rookie shot"), −1 = never. */
  dudAt = -1;
  /** Active seeker has been locked at least once (post-pitbull). */
  everLocked = false;
  /** Still able to hit its (original) target — MAWS / RWR / AI defence only list threatening missiles. */
  threat = true;
  /** Seconds since the missile stopped being a threat (defeated missiles self-destruct shortly after). */
  defeatTimer = 0;
  /** Seconds the range to the target has been opening, and last range (threat assessment). */
  openTime = 0;
  prevThreatRange = Infinity;
  /** Active radar missile launched without an STT lock (TWS shot): degraded midcourse updates. */
  tws = false;
  /** TWS midcourse track error (position m, velocity m/s) and time of the next TWS revisit. */
  readonly twsPosErr = new Vector3();
  readonly twsVelErr = new Vector3();
  twsNext = 0;
  /** Previous-step range to the target (for closure). */
  prevRange = Infinity;
  /** Cached time-to-go estimate (s), its age (s) and the seeker state it was computed with. */
  tgo = 0;
  tgoAge = -1;
  tgoLocked = false;
  /** Speed (m/s) cached each step. */
  speed = 0;
  /** Vertical launch: pitch-over finished (normal guidance from then on). */
  turned = true;
  /** Launch altitude (m MSL) — vertical-launch turnover clearance. */
  launchAlt = 0;
  /** Burn time total (s). */
  readonly burnEnd: number;
  ended = false;

  constructor(id: number, def: CombatMunitionDef, team: Team, shooterId: number, targetId: number | null) {
    super(id, def, team, shooterId, targetId);
    this.cdef = def;
    this.guiderId = shooterId;
    this.originalTargetId = targetId;
    this.burnEnd = def.igniteDelay + def.boostTime + def.sustainTime;
  }
}

export function isCombatMissile(m: MissileEntity): m is CombatMissile {
  return m instanceof CombatMissile;
}

const _v = new Vector3();
const _off = new Vector3();

export interface LaunchOptions {
  /** Released from an internal bay (eject) vs a rail/pylon. */
  internal?: boolean;
  /** GPS aim point (bombs), or ARM pre-briefed point. */
  targetPoint?: Vector3 | null;
  /** Launch direction for canted SAM launchers (unit, world). */
  launchDir?: Vector3 | null;
  /** Guided (GPS/ARM) vs unguided drop. */
  guided?: boolean;
}

/** Orient an entity quaternion along a velocity vector (nose = -Z). */
export function orientAlong(q: Quaternion, vel: Vector3): void {
  const len = vel.length();
  if (len < 1e-3) return;
  _v.copy(vel).divideScalar(len);
  q.setFromUnitVectors(NOSE, _v);
}

/**
 * Create a munition, place it on the launcher and add it to the world.
 * Emits 'munition:launch'.
 */
export function launchMunition(
  ctx: CombatCtx,
  shooter: AircraftEntity | SamSiteEntity,
  munition: MunitionId,
  target: AnyEntity | null,
  opts: LaunchOptions = {},
): CombatMissile {
  const world = ctx.world;
  const def = ctx.defs[munition];
  const m = new CombatMissile(world.nextId(), def, shooter.team, shooter.id, target ? target.id : null);
  m.launchTime = ctx.time;
  m.guided = opts.guided ?? true;
  m.phase = 'launch';

  if (shooter.kind === 'aircraft') {
    const ac = shooter;
    const internal = opts.internal ?? false;
    // offset: bays under the fuselage, pylons under the wings
    const side = (ac.shotsFired % 2 === 0 ? 1 : -1) * (internal ? 0.9 : 3.2);
    _off.set(side, internal ? -1.1 : -0.8, -1).applyQuaternion(ac.quaternion);
    m.position.copy(ac.position).add(_off);
    m.velocity.copy(ac.velocity);
    const style = def.launch === 'eject' && !internal ? 'rail' : def.launch;
    if (style === 'eject' || style === 'drop') {
      // push down (body -Y) away from the jet
      _v.set(0, -1, 0).applyQuaternion(ac.quaternion);
      m.velocity.addScaledVector(_v, def.ejectSpeed);
    } else {
      _v.set(0, 0, -1).applyQuaternion(ac.quaternion);
      m.velocity.addScaledVector(_v, def.ejectSpeed);
    }
    m.quaternion.copy(ac.quaternion);
    // SARH / command are illuminated by the launcher; datalink comes from the launcher's tracks
    m.guiderId = ac.id;
    // "forgiving enemies" (Recruit): a rookie's hurried air-to-air shot at the human player can
    // go stupid in flight (poor launch solution / seeker never settles)
    if (target && target.kind === 'aircraft' && target.isPlayer && ac.team !== target.team) {
      const pDud = clamp((0.8 - ctx.world.difficulty.enemyMissileSkill) * 1.8, 0, 0.45); // Recruit 45 %, Pilot+ 0
      if (pDud > 0 && ctx.rng() < pDud) m.dudAt = 1.2 + 2.5 * ctx.rng();
    }
  } else {
    const site = shooter;
    m.position.copy(site.position);
    m.position.y += 4;
    if (def.launch === 'vertical') {
      m.velocity.set(0, def.ejectSpeed, 0);
    } else {
      const dir = opts.launchDir ?? _v.set(0, 0.7, -0.7).normalize();
      m.velocity.copy(dir).multiplyScalar(def.ejectSpeed);
      m.position.addScaledVector(dir, 3);
    }
    orientAlong(m.quaternion, m.velocity);
    m.guiderId = site.id;
  }
  m.launchAlt = m.position.y;
  m.turned = def.launch !== 'vertical';

  // initial target estimate = launcher's targeting data
  if (opts.targetPoint) {
    m.targetPoint.copy(opts.targetPoint);
    m.estPos.copy(opts.targetPoint);
    m.estVel.set(0, 0, 0);
    m.hasEstimate = true;
  } else if (target) {
    let known = false;
    if (shooter.kind === 'aircraft') {
      const c = acState(shooter).contacts.get(target.id);
      if (c) {
        m.estPos.copy(c.position);
        m.estVel.copy(c.velocity);
        known = true;
      }
    }
    if (!known) {
      m.estPos.copy(target.position);
      m.estVel.copy(target.velocity);
    }
    // a target too small to track on the move (the stoat): where it is now, never where it is heading
    if (isSmallGround(target)) m.estVel.set(0, 0, 0);
    m.targetPoint.copy(m.estPos);
    m.hasEstimate = true;
  }
  m.estTime = ctx.time;
  m.launchRange = m.hasEstimate ? m.position.distanceTo(m.estPos) : 0;
  // loft long shots (air targets beyond ~40 % of nominal range; ARMs beyond 15 km)
  if (def.loft && m.hasEstimate) {
    const dy = m.estPos.y - m.position.y;
    if (def.category === 'agm') m.loft = m.launchRange > 15_000;
    else m.loft = m.launchRange > 0.4 * def.maxRange && (def.category === 'sam' || dy < 3_000);
  }
  m.speed = m.velocity.length();
  world.addMissile(m);
  world.events.emit('munition:launch', { missile: m, shooter, targetId: m.targetId });
  return m;
}
