/**
 * F35-A — IRGC Navy fast boats (SIM-CORE, issue #79): how they sail, chase and fire.
 *
 *  - Suicide boat (`'suicide_boat'` ground target): CHASES a ship (BoatState.chaseId), aiming at
 *    the intercept point and weaving a little, so a bomb needs the GBU-53/B's moving-target
 *    tracking. Contact with the ship's hull = one hit on her (applyDamage(…, 'collision') from a
 *    ground entity, which Damage counts as a ship hit), and the boat blows up.
 *  - Missile boat (`'missile_boat'` ground target, BoatState.strike): closes to `range` of its
 *    target ship, stops there and COUNTS DOWN (`countdown` s), then launches a Kowsar. The Kowsar is
 *    a visual missile flown here, never by the CombatSystem: a sea-skimming pursuit that always
 *    reaches its ship and scores one hit. Missiles are never sensor contacts, so the only defence
 *    is killing the boat before the countdown ends. Every countdown is announced (radio call with
 *    the bearing, HUD countdown) for the blue side.
 *  - Air-defence boat (`'ad_boat'` SAM site): a MOVING SAM. SamSystem runs its radar SAM and its
 *    SA-18s exactly as on a fixed site; this module only sails it (along a path, or keeping
 *    station on an escorted boat) and keeps its velocity, which the GBU-53/B and the AGM-88G use.
 *
 * Every boat stays in the water: a move is only taken onto water (TerrainQuery.isWater), with
 * open water ahead; otherwise the boat steers round, and stops if no heading is clear.
 */
import { Vector3 } from 'three';
import { wrapPi } from '../core/math';
import type { Team } from '../core/types';
import type { SimWorld } from './api';
import { GroundTargetEntity, MissileEntity, type AnyEntity, type SamSiteEntity } from './entities';
import { setQuatFromHPR } from './flight/attitude';
import { isCivilVessel, vesselHullDistance } from './civil/vessels';

const DEG = Math.PI / 180;

/** Cruise speed of every IRGC fast boat (m/s): ≈ 45 kt. */
export const BOAT_SPEED = 23;
/** Missile boat: default launch range from its target (m) and countdown at the launch point (s). */
export const BOAT_LAUNCH_RANGE = 6_000;
export const BOAT_COUNTDOWN = 20;
/** Kowsars a missile boat carries (Peykaap II: 2). Each one is its own full, announced countdown. */
export const BOAT_MISSILES = 2;
/** Suicide boat weave: heading swing amplitude (rad) and period (s). */
export const BOAT_WEAVE = 25 * DEG;
export const BOAT_WEAVE_PERIOD = 7;
/** Max turn rate (rad/s). */
const TURN_RATE = 40 * DEG;
/** Look-ahead time for the open-water test (s) and its floor (m). */
const LOOK_AHEAD_T = 2.5;
const LOOK_AHEAD_MIN = 40;
/** Headings tried round an obstacle, relative to the wanted one. */
const STEER_TRIES = [0, 20, -20, 40, -40, 60, -60, 90, -90, 120, -120, 150, -150, 180].map((d) => d * DEG);
/** Escort station keeping: within this distance of the station the boat matches its leader's pace (m). */
const STATION_TOLERANCE = 60;

/** Kowsar flight: speed (m/s, high subsonic), sea-skimming height (m), damage of the hit. */
export const KOWSAR_SPEED = 250;
const KOWSAR_ALT = 6;
const KOWSAR_CLIMB_T = 1.5;
/** Speed off the canted launcher (m/s). */
const KOWSAR_EJECT = 40;

export interface BoatStrike {
  /** Ship to fire at. */
  targetId: number;
  /** Launch range (m): the boat closes to it, then counts down. */
  range: number;
  /** Countdown at the launch point (s). */
  countdown: number;
  /** Seconds left of the current countdown (−1 = not counting). */
  timer: number;
  /** Kowsars left. */
  missiles: number;
  /** Kowsars fired (in flight or done). */
  fired: number;
}

/** Sailing state of a fast boat (GroundTargetEntity.boat / SamSiteEntity.boat). */
export interface BoatState {
  /** Cruise speed (m/s). */
  speed: number;
  /** Current heading (rad, 0 = north, clockwise). */
  heading: number;
  /** Route (world XZ), sailed when there is nothing to chase, strike or escort. */
  path: Vector3[] | null;
  pathIndex: number;
  loop: boolean;
  /** Suicide boat: entity to ram. */
  chaseId: number | null;
  /** Escort: entity to keep station on, `escortRight` m to its right and `escortAft` m behind. */
  escortId: number | null;
  escortRight: number;
  escortAft: number;
  /** Missile boat: target and countdown. */
  strike: BoatStrike | null;
  /** Weave amplitude (rad, 0 = straight) and phase. */
  weave: number;
  phase: number;
  /** No clear water ahead on the last step: stopped. */
  blocked: boolean;
  /** Side (+1 right / −1 left) it last steered round an obstacle: tried first next time. */
  side: number;
}

export type BoatEntity = GroundTargetEntity | SamSiteEntity;

export interface BoatOptions {
  speed?: number;
  heading?: number;
  path?: Vector3[] | null;
  loop?: boolean;
  chaseId?: number | null;
  escortId?: number | null;
  escortRight?: number;
  escortAft?: number;
  strike?: { targetId: number; range?: number; countdown?: number; missiles?: number } | null;
  weave?: number;
}

/** Make `e` a fast boat (World.spawnGround / spawnSam do it for the boat types). */
export function makeBoat(e: BoatEntity, o: BoatOptions = {}): BoatState {
  const b: BoatState = {
    speed: o.speed ?? BOAT_SPEED,
    heading: o.heading ?? 0,
    path: o.path && o.path.length ? o.path.map((p) => p.clone()) : null,
    pathIndex: 0,
    loop: !!o.loop,
    chaseId: o.chaseId ?? null,
    escortId: o.escortId ?? null,
    escortRight: o.escortRight ?? 150,
    escortAft: o.escortAft ?? 250,
    strike: o.strike
      ? {
          targetId: o.strike.targetId,
          range: o.strike.range ?? BOAT_LAUNCH_RANGE,
          countdown: o.strike.countdown ?? BOAT_COUNTDOWN,
          timer: -1,
          missiles: o.strike.missiles ?? BOAT_MISSILES,
          fired: 0,
        }
      : null,
    weave: o.weave ?? (o.chaseId != null ? BOAT_WEAVE : 0),
    phase: (e.id * 2.39996) % (Math.PI * 2),
    blocked: false,
    side: 1,
  };
  e.boat = b;
  return b;
}

/** Is this entity a fast boat this module sails? */
export function isBoat(e: AnyEntity): e is BoatEntity {
  return (e.kind === 'ground' || e.kind === 'sam') && !!e.boat;
}

/**
 * A live missile boat hostile to `team` that can still launch (a Kowsar left or a countdown
 * running): the TSD and the tac map draw its launch ring.
 */
export function isMissileBoatLive(g: GroundTargetEntity, team: Team): boolean {
  const st = g.boat?.strike;
  return !!st && g.alive && g.team !== team && g.team !== 'neutral' && (st.missiles > 0 || st.timer >= 0);
}

/** The Kowsar a missile boat fired: target and launching boat. */
const kowsars = new WeakMap<MissileEntity, { boatId: number }>();

/** Is this missile a Kowsar flown by this module (never by the CombatSystem)? */
export function isKowsar(m: MissileEntity): boolean {
  return kowsars.has(m);
}

const _lead = new Vector3();
const _fwd = new Vector3();

/** Step every boat (movement, rams, countdowns, launches) and every Kowsar in flight. */
export function stepBoats(world: SimWorld, dt: number): void {
  for (let i = 0; i < world.ground.length; i++) {
    const g = world.ground[i];
    if (g.boat) stepBoat(world, g, g.boat, dt);
  }
  for (let i = 0; i < world.sams.length; i++) {
    const s = world.sams[i];
    if (s.boat) stepBoat(world, s, s.boat, dt);
  }
  for (let i = 0; i < world.missiles.length; i++) {
    const m = world.missiles[i];
    if (m.alive && kowsars.has(m)) stepKowsar(world, m, dt);
  }
}

function headingTo(from: Vector3, x: number, z: number): number {
  return Math.atan2(x - from.x, -(z - from.z));
}

function stepBoat(world: SimWorld, e: BoatEntity, b: BoatState, dt: number): void {
  if (!e.alive) {
    e.velocity.set(0, 0, 0);
    return;
  }
  const pos = e.position;
  let want: number | null = null;
  let speed = b.speed;

  const chase = b.chaseId != null ? world.getEntity(b.chaseId) : null;
  const strikeTarget = b.strike ? world.getEntity(b.strike.targetId) : null;
  const leader = b.escortId != null ? world.getEntity(b.escortId) : null;

  if (chase && chase.alive) {
    // ram: contact with the hull (a ship's real footprint) is one hit, and the boat is gone
    if (contactDistance(chase, pos) <= e.radius) {
      ram(world, e as GroundTargetEntity, chase);
      return;
    }
    // aim at the intercept point (lead by the time to get there), weaving about it
    const d = Math.hypot(chase.position.x - pos.x, chase.position.z - pos.z);
    const t = Math.min(60, d / Math.max(1, b.speed));
    _lead.copy(chase.position).addScaledVector(chase.velocity, t);
    want = headingTo(pos, _lead.x, _lead.z);
    // no weave in the last 150 m: the run-in is straight
    if (b.weave > 0 && d > 150) want += b.weave * Math.sin((2 * Math.PI * world.time) / BOAT_WEAVE_PERIOD + b.phase);
  } else if (b.strike && strikeTarget && strikeTarget.alive && (b.strike.missiles > 0 || b.strike.timer >= 0)) {
    const st = b.strike;
    const d = Math.hypot(strikeTarget.position.x - pos.x, strikeTarget.position.z - pos.z);
    if (st.timer < 0 && d > st.range) {
      want = headingTo(pos, strikeTarget.position.x, strikeTarget.position.z);
    } else {
      // at the launch point: lie stopped, bow on to the target, and count down
      speed = 0;
      want = headingTo(pos, strikeTarget.position.x, strikeTarget.position.z);
      if (st.timer < 0) startCountdown(world, e as GroundTargetEntity, st);
      st.timer -= dt;
      announce(world, e as GroundTargetEntity, st, dt);
      if (st.timer <= 0) {
        launchKowsar(world, e as GroundTargetEntity, strikeTarget);
        st.missiles--;
        st.fired++;
        st.timer = -1;
      }
    }
  } else if (leader && leader.alive) {
    // keep station on the escorted boat
    _fwd.set(Math.sin(headingOf(leader)), 0, -Math.cos(headingOf(leader)));
    const sx = leader.position.x - _fwd.x * b.escortAft - _fwd.z * b.escortRight;
    const sz = leader.position.z - _fwd.z * b.escortAft + _fwd.x * b.escortRight;
    const d = Math.hypot(sx - pos.x, sz - pos.z);
    const lv = Math.hypot(leader.velocity.x, leader.velocity.z);
    if (d < STATION_TOLERANCE) {
      want = headingOf(leader);
      speed = Math.min(b.speed * 1.3, lv);
    } else {
      want = headingTo(pos, sx, sz);
      speed = Math.min(b.speed * 1.3, Math.max(lv, d / 4));
    }
  } else if (b.path && b.pathIndex < b.path.length) {
    const wp = b.path[b.pathIndex];
    const d = Math.hypot(wp.x - pos.x, wp.z - pos.z);
    if (d <= Math.max(25, b.speed * dt * 2)) {
      b.pathIndex++;
      if (b.pathIndex >= b.path.length && b.loop) b.pathIndex = 0;
    }
    if (b.pathIndex < b.path.length) {
      const n = b.path[b.pathIndex];
      want = headingTo(pos, n.x, n.z);
    }
  }

  if (want === null || speed <= 0) {
    if (want !== null) b.heading = turnToward(b.heading, want, TURN_RATE * dt);
    e.velocity.set(0, 0, 0);
    setQuatFromHPR(e.quaternion, b.heading, 0, 0);
    return;
  }
  sail(world, e, b, want, speed, dt);
}

/** Turn toward `want` at the turn rate, then move one step onto clear water (or stop). */
function sail(world: SimWorld, e: BoatEntity, b: BoatState, want: number, speed: number, dt: number): void {
  const terrain = world.terrain;
  const pos = e.position;
  const step = speed * dt;
  const ahead = Math.max(LOOK_AHEAD_MIN, speed * LOOK_AHEAD_T);
  const clear = (h: number, d: number): boolean => terrain.isWater(pos.x + Math.sin(h) * d, pos.z - Math.cos(h) * d);
  // the first direction (wanted first, then fanning out, the side it went round last time first)
  // with open water ahead; boxed in (a narrow channel), any one that keeps the next step on water
  let goal: number | null = null;
  for (let pass = 0; pass < 2 && goal === null; pass++) {
    for (let k = 0; k < STEER_TRIES.length; k++) {
      const off = STEER_TRIES[k] * b.side;
      const h = want + off;
      if (pass === 0 ? clear(h, ahead) && clear(h, ahead * 0.5) && clear(h, step) : clear(h, step)) {
        goal = h;
        if (off !== 0) b.side = off > 0 ? 1 : -1;
        break;
      }
    }
  }
  b.blocked = goal === null;
  if (goal === null) {
    e.velocity.set(0, 0, 0);
    setQuatFromHPR(e.quaternion, b.heading, 0, 0);
    return;
  }
  // turn toward it at the turn rate; sail on only while the step ahead stays on water (else pivot)
  const h = turnToward(b.heading, goal, TURN_RATE * dt);
  b.heading = h;
  setQuatFromHPR(e.quaternion, h, 0, 0);
  if (!clear(h, step)) {
    e.velocity.set(0, 0, 0);
    return;
  }
  const vx = Math.sin(h) * speed;
  const vz = -Math.cos(h) * speed;
  pos.x += vx * dt;
  pos.z += vz * dt;
  pos.y = 0;
  e.velocity.set(vx, 0, vz);
}

function turnToward(h: number, want: number, maxStep: number): number {
  const d = wrapPi(want - h);
  return wrapPi(h + Math.max(-maxStep, Math.min(maxStep, d)));
}

/** Heading of any entity (rad): from its velocity when moving, else from its attitude. */
function headingOf(e: AnyEntity): number {
  if (e.velocity.x * e.velocity.x + e.velocity.z * e.velocity.z > 0.25) return Math.atan2(e.velocity.x, -e.velocity.z);
  _fwd.set(0, 0, -1).applyQuaternion(e.quaternion);
  return Math.atan2(_fwd.x, -_fwd.z);
}

/** Distance (m) from a point to the target's hull: a civil ship's real footprint, else its bounding sphere. */
function contactDistance(t: AnyEntity, p: Vector3): number {
  if (isCivilVessel(t)) return vesselHullDistance(t, _lead.set(p.x, 1, p.z));
  return Math.max(0, Math.hypot(t.position.x - p.x, t.position.z - p.z) - t.radius);
}

/** A suicide boat reaches its target: one hit on her, and the boat blows up with its charge. */
function ram(world: SimWorld, boat: GroundTargetEntity, target: AnyEntity): void {
  world.applyDamage(target, RAM_DAMAGE, boat.id, 'collision');
  // the boat is spent: destroyed by its own charge (no kill credit, no one fired at it)
  world.applyDamage(boat, boat.health, boat.id, 'collision');
}
/** Damage of a suicide boat's charge on anything that isn't a two-hit civil ship (where it is one hit). */
const RAM_DAMAGE = 300;

/* ───────────────────────── Missile boat: countdown and Kowsar ───────────────────────── */

function startCountdown(world: SimWorld, boat: GroundTargetEntity, st: BoatStrike): void {
  st.timer = st.countdown;
  const p = world.player;
  if (!p || p.team === boat.team) return;
  const brg = Math.round(((headingTo(p.position, boat.position.x, boat.position.z) / DEG + 360) % 360)) || 360;
  const nm = Math.max(1, Math.round(p.position.distanceTo(boat.position) / 1852));
  world.events.emit('radio', {
    from: 'DARKSTAR',
    text: `Missile boat, launch imminent, bearing ${String(brg).padStart(3, '0')}, ${nm} miles. Kill it!`,
    priority: 3,
    team: p.team,
  });
  world.events.emit('hud:message', { text: `MISSILE BOAT LAUNCH ${Math.ceil(st.countdown)}`, duration: 1.1, tone: 'bad' });
}

/** HUD countdown for the blue side: at the start and on every 5 s mark (the last five every second). */
function announce(world: SimWorld, boat: GroundTargetEntity, st: BoatStrike, dt: number): void {
  const p = world.player;
  if (!p || p.team === boat.team) return;
  const before = Math.ceil(st.timer + dt);
  const now = Math.ceil(st.timer);
  if (now === before || now <= 0) return;
  if (now % 5 === 0 || now <= 5) {
    world.events.emit('hud:message', { text: `MISSILE BOAT LAUNCH ${now}`, duration: 1.1, tone: 'bad' });
  }
}

const _dir = new Vector3();

function launchKowsar(world: SimWorld, boat: GroundTargetEntity, target: AnyEntity): MissileEntity {
  const def = world.combat.munitions.kowsar;
  const m = new MissileEntity(world.nextId(), def, boat.team, boat.id, target.id);
  m.position.set(boat.position.x, 3, boat.position.z);
  _dir.set(target.position.x - m.position.x, 0, target.position.z - m.position.z).normalize();
  m.velocity.set(_dir.x * KOWSAR_EJECT, KOWSAR_EJECT * 0.6, _dir.z * KOWSAR_EJECT);
  m.quaternion.setFromUnitVectors(_fwd.set(0, 0, -1), _dir.copy(m.velocity).normalize());
  m.targetPoint.copy(target.position);
  m.motorBurning = true;
  m.phase = 'boost';
  m.seekerLocked = true;
  kowsars.set(m, { boatId: boat.id });
  world.addMissile(m);
  world.events.emit('munition:launch', { missile: m, shooter: boat, targetId: target.id });
  const p = world.player;
  if (p && p.team !== boat.team) {
    world.events.emit('radio', { from: 'DARKSTAR', text: 'Vampire, vampire! Missile boat has launched.', priority: 3, team: p.team });
  }
  return m;
}

/** Sea-skimming pursuit: climbs out, levels at a few metres and flies at the ship until it hits. */
function stepKowsar(world: SimWorld, m: MissileEntity, dt: number): void {
  m.age += dt;
  const target = world.getEntity(m.targetId);
  const def = m.def;
  if (!target || !target.alive || m.age > def.maxFlightTime) {
    endKowsar(world, m, target && target.alive ? 'selfdestruct' : 'water');
    return;
  }
  m.targetPoint.copy(target.position);
  const speed = Math.min(KOWSAR_SPEED, m.velocity.length() + def.boostAccel * dt);
  _dir.set(target.position.x - m.position.x, 0, target.position.z - m.position.z);
  const dist = _dir.length();
  if (dist > 1e-3) _dir.divideScalar(dist);
  const y = m.age < KOWSAR_CLIMB_T ? 3 + (KOWSAR_ALT * 3 - 3) * (m.age / KOWSAR_CLIMB_T) : Math.max(KOWSAR_ALT, m.position.y - 20 * dt);
  m.velocity.set(_dir.x * speed, (y - m.position.y) / dt, _dir.z * speed);
  m.position.x += m.velocity.x * dt;
  m.position.z += m.velocity.z * dt;
  m.position.y = y;
  m.phase = m.age < KOWSAR_CLIMB_T ? 'boost' : 'terminal';
  m.motorBurning = true;
  if (m.velocity.lengthSq() > 1) m.quaternion.setFromUnitVectors(_fwd.set(0, 0, -1), _lead.copy(m.velocity).normalize());
  m.closestApproach = Math.min(m.closestApproach, dist);
  if (contactDistance(target, m.position) <= def.fuseRadius) {
    const boatId = kowsars.get(m)?.boatId ?? m.shooterId;
    world.applyDamage(target, def.damage, boatId, def.id, m.position);
    endKowsar(world, m, 'hit');
  }
}

function endKowsar(world: SimWorld, m: MissileEntity, reason: 'hit' | 'water' | 'selfdestruct'): void {
  m.alive = false;
  m.motorBurning = false;
  world.events.emit('explosion', { position: m.position, size: reason === 'hit' ? 'large' : 'small', surface: reason === 'hit' ? 'ground' : 'water' });
  world.events.emit('munition:end', { missile: m, position: m.position, reason, targetId: m.targetId });
}
