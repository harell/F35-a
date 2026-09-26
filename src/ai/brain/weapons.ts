/**
 * F35-A — AI weapons employment: BVR shot doctrine, IR (dogfight) missile shots, gun tracking
 * and missile support (who still needs our radar).
 *
 * Shot doctrine (rolled per engagement from skill):
 *   ace       fires between the no-escape range and ~40 % of the way to rMax: high Pk
 *   average   anywhere in the inner half of the zone
 *   rookie    either "trigger happy" (wasted missiles the player can drag out) or "hesitant",
 *             waiting until well inside rNe (lets the player shoot first)
 * On top of that, a skill-based ceiling on the launch range (fraction of rMax — rookies ≤ 45 %,
 * average ≤ 55 %, veterans ≤ 70 %, aces ≤ 85 %) and a trigger delay after the solution first
 * appears (rookies hesitate ~1.5 s, aces fire at once). Hostile (red) pilots never shoot a radar
 * missile without their OWN sensor track on the target (no datalink / GCI shots).
 * One radar missile in the air per target at a time (aces may fire a second one inside rNe).
 * Everything goes through world.combat.launchZoneFor / fire — the same release rules as the
 * player (lock for R-27, own-sensor track for R-77, IR seeker for R-73/AIM-9X).
 * IR dogfight missiles: rookies only take rear-hemisphere shots (or point-blank ones).
 *
 * Guns: the LCOS lead point from combat.gunLeadPoint (target designated) steers the nose so the
 * pipper sits on the bandit; a skill-scaled aim error wanders every 0.5 s; bursts of 0.4–1 s,
 * only with the pipper inside the pilot's firing cone and no friendly in the line of fire.
 */
import { Vector3 } from 'three';
import type { LaunchZone } from '../../sim/api';
import type { AircraftEntity } from '../../sim/entities';
import { G } from '../../core/math';
import type { Bandit } from './awareness';
import type { AnyMissile, TickCtx } from './context';
import { angleBetween } from '../geom';

const _fwd = new Vector3();
const _uT = new Vector3();
const _uP = new Vector3();
const _aim = new Vector3();
const _vh = new Vector3();
const _rel = new Vector3();
const _lead = new Vector3();

const MAX_TRACKED = 8;

export class WeaponsOfficer {
  /** Ids of missiles we launched (pruned as they end). */
  private readonly shots: number[] = [];
  private lastBvrShot = -99;
  private lastIrShot = -99;
  private bias = 0.35;
  /** Max launch range as a fraction of rMax (skill ceiling, rolled with the doctrine). */
  private maxFrac = 0.7;
  /** Seconds the pilot hesitates after a shot solution first appears. */
  private triggerDelay = 0;
  /** Sim time the current BVR solution first appeared (−1 = none). */
  private solutionSince = -1;
  private solutionTarget = -1;
  private zone: LaunchZone | null = null;
  private zoneTime = -99;
  private zoneTarget = -1;
  private zoneWeapon: 'aim120' | 'aim9x' = 'aim120';
  /* gun */
  private burstEnd = -99;
  private pauseEnd = -99;
  private readonly aimErr = new Vector3();
  private aimErrTime = -99;
  /** Angle between pipper and bandit at the last gunnery tick (rad). */
  gunError = Math.PI;

  /** Roll the shot doctrine for a new engagement. */
  newEngagement(level: number, rng: () => number): void {
    if (level >= 0.6) this.bias = 0.1 + 0.3 * rng();
    else if (level >= 0.3) this.bias = 0.3 + 0.5 * rng();
    else this.bias = rng() < 0.5 ? 0.85 + 0.15 * rng() : -(0.4 + 0.4 * rng());
    this.maxFrac = level < 0.3 ? 0.45 : level < 0.55 ? 0.55 : level < 0.75 ? 0.7 : 0.85;
    this.triggerDelay = Math.max(0, 1.6 * (1 - level / 0.8)) * (0.7 + 0.6 * rng());
    this.solutionSince = -1;
  }

  /** Doctrine launch-range ceiling for a zone (m) — exposed for tests. */
  shotRange(z: LaunchZone): number {
    const thr = this.bias >= 0 ? z.rNe + (z.rMax - z.rNe) * this.bias : z.rNe * -this.bias;
    return Math.min(thr, this.maxFrac * z.rMax);
  }

  bvrLeft(c: TickCtx): number {
    return c.world.combat.remaining(c.ac, 'aim120');
  }

  irLeft(c: TickCtx): number {
    return c.world.combat.remaining(c.ac, 'aim9x');
  }

  /** Our missiles still flying (optionally at one target). Prunes ended ones. */
  inFlight(c: TickCtx, targetId: number | null = null, guidance: string | null = null): number {
    let n = 0;
    const list = this.shots;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = c.world.getEntity(list[i]) as AnyMissile | null;
      if (!m || !m.alive || m.kind !== 'missile') {
        list.splice(i, 1);
        continue;
      }
      if (targetId !== null && m.targetId !== targetId) continue;
      if (guidance !== null && m.def.guidance !== guidance) continue;
      n++;
    }
    return n;
  }

  /**
   * A missile of ours that still needs the launcher's radar: semi-active until impact, active
   * radar until its own seeker goes active (pitbull).
   */
  needsSupport(c: TickCtx): AnyMissile | null {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const m = c.world.getEntity(this.shots[i]) as AnyMissile | null;
      if (!m || !m.alive || m.kind !== 'missile') continue;
      const g = m.def.guidance;
      if (m.trackBroken || m.decoyed) continue;
      if (g === 'semi_active' || g === 'command') return m;
      if (g === 'active_radar' && !m.seekerLocked) return m;
    }
    return null;
  }

  /** Last radar-missile zone evaluated against `targetId` if still fresh (≤ 1 s), else null. */
  recentZone(targetId: number, now: number): LaunchZone | null {
    const z = this.zone;
    if (!z || this.zoneTarget !== targetId || this.zoneWeapon !== 'aim120' || now - this.zoneTime > 1) return null;
    return z;
  }

  private evalZone(c: TickCtx, b: Bandit, weapon: 'aim120' | 'aim9x', period: number): LaunchZone {
    if (!this.zone || this.zoneTarget !== b.id || this.zoneWeapon !== weapon || c.now - this.zoneTime > period) {
      this.zone = c.world.combat.launchZoneFor(c.ac, weapon, b.ent, c.world);
      this.zoneTime = c.now;
      this.zoneTarget = b.id;
      this.zoneWeapon = weapon;
    }
    return this.zone;
  }

  /** Radar-missile shot if the doctrine says so. Returns true on launch. */
  tryBvr(c: TickCtx, b: Bandit): boolean {
    const { ac, world, now, skill } = c;
    if (this.bvrLeft(c) <= 0 || now - this.lastBvrShot < 4) return false;
    if (b.range > 60_000) return false;
    // hostile pilots shoot only what their own radar / IRST holds (no datalink or GCI shots)
    if (ac.team === 'red' && !b.sensor) {
      this.solutionSince = -1;
      return false;
    }
    const z = this.evalZone(c, b, 'aim120', 0.4);
    if (!z.shoot || z.rMax <= 0) return false;
    // don't waste energy on big off-boresight launches
    _fwd.set(0, 0, -1).applyQuaternion(ac.quaternion);
    _rel.subVectors(b.ent.position, ac.position);
    if (_fwd.dot(_rel) < Math.cos(0.6) * _rel.length()) return false;
    if (z.range > Math.max(this.shotRange(z), z.rMin * 1.5)) {
      this.solutionSince = -1;
      return false;
    }
    // trigger discipline: hesitate a moment after the solution appears (rookies longer)
    if (this.solutionTarget !== b.id || this.solutionSince < 0) {
      this.solutionTarget = b.id;
      this.solutionSince = now;
    }
    if (now - this.solutionSince < this.triggerDelay) return false;
    const flying = this.inFlight(c, b.id);
    if (flying > 0 && !(skill.level > 0.7 && z.range < z.rNe * 0.8 && now - this.lastBvrShot > 8)) return false;
    const m = world.combat.fire(ac, world, 'aim120', b.id);
    if (!m) return false;
    this.remember(m.id);
    this.lastBvrShot = now;
    this.zone = null;
    return true;
  }

  /** IR missile shot inside the WEZ. Returns true on launch. */
  tryIr(c: TickCtx, b: Bandit): boolean {
    const { ac, world, now, skill } = c;
    if (this.irLeft(c) <= 0 || now - this.lastIrShot < (skill.level > 0.6 ? 2.5 : 4.5)) return false;
    if (b.range > 12_000) return false;
    const z = this.evalZone(c, b, 'aim9x', 0.25);
    if (!z.shoot) return false;
    const frac = skill.level > 0.45 ? 0.55 + 0.25 * skill.level : 0.95;
    if (z.range > z.rMax * frac) return false;
    // rookies can't judge a front-hemisphere IR shot: they wait for the bandit's tail (or point-blank)
    if (skill.level < 0.45 && z.range > 2_000) {
      _fwd.set(0, 0, -1).applyQuaternion(b.ent.quaternion);
      _rel.subVectors(ac.position, b.ent.position);
      if (_fwd.dot(_rel) > -0.2 * _rel.length()) return false;
    }
    if (this.inFlight(c, b.id, 'ir') > 0) return false;
    const m = world.combat.fire(ac, world, 'aim9x', b.id);
    if (!m) return false;
    this.remember(m.id);
    this.lastIrShot = now;
    this.zone = null;
    return true;
  }

  /**
   * Gun tracking: steer the pipper onto the bandit and fire bursts. Fills the flight intent.
   * Returns true while in a gun-tracking solution (caller labels the state 'GUNS').
   */
  gunnery(c: TickCtx, b: Bandit): boolean {
    const { ac, world, it, now, skill, rng } = c;
    if (ac.gunAmmo <= 0 || b.range > 1_800 || !b.own) return false;
    _fwd.set(0, 0, -1).applyQuaternion(ac.quaternion);
    const R = b.range;
    _uT.subVectors(b.pos, ac.position).multiplyScalar(1 / Math.max(1, R));
    if (_fwd.dot(_uT) < Math.cos(0.6)) return false; // not yet in a tracking position

    // pipper: combat LCOS when the bandit is our designated/locked target, else our own estimate
    const des = ac.radar.lockedId ?? ac.radar.designatedId;
    const lp = des === b.id ? world.combat.gunLeadPoint(ac, world) : null;
    if (lp) _uP.subVectors(lp, ac.position).normalize();
    else {
      // own estimate: where the rounds (≈ 1,000 m/s) meet the bandit, gravity drop included
      const t = R / 1_000;
      _lead.copy(b.vel).sub(ac.velocity).multiplyScalar(t);
      _lead.y += 0.5 * G * t * t;
      // pipper = nose line minus target motion and bullet drop
      _uP.copy(_fwd).multiplyScalar(R).sub(_lead).normalize();
    }

    // desired nose: move the pipper onto the bandit, plus the pilot's aim error
    if (now - this.aimErrTime > 0.5) {
      this.aimErrTime = now;
      this.aimErr.set(rng() - 0.5, rng() - 0.5, rng() - 0.5).multiplyScalar(2 * skill.aimSigma);
    }
    _aim.copy(_fwd).add(_uT).sub(_uP).add(this.aimErr).normalize();
    // nose → velocity vector (keep the current AoA/sideslip offset)
    const V = ac.velocity.length();
    _vh.copy(ac.velocity).multiplyScalar(1 / Math.max(1, V));
    it.dir.copy(_aim).sub(_fwd).add(_vh).normalize();
    it.track = true;
    it.gain = 2.2;
    it.gMax = skill.maxG;
    it.allowInverted = false;

    const err = angleBetween(_uP, _uT);
    this.gunError = err;
    const inRange = R > 120 && R < skill.gunRange;
    // the bandit's own angular size counts: a pipper on the wing is still a hit
    const cone = Math.max(skill.gunCone, (0.6 * b.ent.radius) / Math.max(1, R));
    if (now < this.burstEnd) {
      // keep the trigger down unless the solution fell apart
      if (err > cone * 3 || !inRange) this.burstEnd = now;
    } else if (now > this.pauseEnd && inRange && err < cone && !this.friendlyInLine(c, R)) {
      this.burstEnd = now + 0.4 + 0.6 * rng();
      this.pauseEnd = this.burstEnd + 0.25 + 0.9 * rng() * (1.2 - skill.level);
    }
    ac.input.fireGun = now < this.burstEnd;
    return true;
  }

  /** A friendly aircraft near the gun line closer than the target (+300 m)? */
  private friendlyInLine(c: TickCtx, range: number): boolean {
    const { ac, world } = c;
    const list = world.aircraft;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o === ac || !o.alive || o.team !== ac.team) continue;
      _rel.subVectors(o.position, ac.position);
      const d = _rel.length();
      if (d > range + 300) continue;
      if (_fwd.dot(_rel) > Math.cos(0.09) * d) return true;
    }
    return false;
  }

  private remember(id: number): void {
    this.shots.push(id);
    if (this.shots.length > MAX_TRACKED) this.shots.shift();
  }

  /** Time since the last missile launch of any kind (s). */
  sinceLastShot(now: number): number {
    return now - Math.max(this.lastBvrShot, this.lastIrShot);
  }
}

/** Is `ac` inside the forward cone (half-angle `cone`) of `from`, closer than `range`? */
export function inFrontOf(from: AircraftEntity, ac: AircraftEntity, cone: number, range: number): boolean {
  _rel.subVectors(ac.position, from.position);
  const d = _rel.length();
  if (d > range || d < 1) return false;
  _fwd.set(0, 0, -1).applyQuaternion(from.quaternion);
  return _fwd.dot(_rel) > Math.cos(cone) * d;
}
