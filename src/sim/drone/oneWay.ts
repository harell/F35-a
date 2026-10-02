/**
 * F35-A — one-way attack drones (the Shahed-136).
 *
 * A Shahed is dumb: while alive it flies a kinematic profile, like the civil airliners (the world
 * skips the flight model and the AI for it). It follows a fixed route at a fixed height and speed,
 * then dives into its target point. It never manoeuvres, never reacts to missiles or gunfire, drops
 * no flares and fires nothing.
 *
 * Reaching the target point, or flying into a landmark (the Sky Tower) on the way, is an impact:
 * stepOneWay returns true, and the world reports it ('drone:impact') and detonates the warhead.
 * Shot down, the drone becomes an ordinary falling wreck (flight model) whose warhead blast the
 * world applies when it is destroyed (sim/damage/tables.ts AIRCRAFT_WARHEAD).
 *
 * World conventions: heading 0 = north = −Z, clockwise; y up.
 */
import { Vector3 } from 'three';
import { atmosphere, tasToIas } from '../../core/atmosphere';
import { G } from '../../core/math';
import type { TerrainQuery } from '../api';
import type { AircraftEntity } from '../entities';
import { setQuatFromHPR } from '../flight/attitude';
import { firstLandmarkHit, type LandmarkEntity } from '../landmarks';

const DEG = Math.PI / 180;

/** Shahed-136 cruise speed (m/s): about 185 km/h. */
export const SHAHED_SPEED = 51;
/** Terminal dive angle below the horizon (rad). */
export const SHAHED_DIVE_ANGLE = 35 * DEG;
/** Speed gained in the dive (×cruise speed). */
const DIVE_SPEEDUP = 1.3;
/** Gentle route turns: a drone flying its route is not manoeuvring (rad/s). */
const TURN_RATE = 6 * DEG;
/** Steepest turn, only for a waypoint inside the gentle turn circle (it would orbit it otherwise). */
const MAX_TURN_RATE = 20 * DEG;
/** The dive starts only with the target this close to the nose (rad); otherwise it goes round. */
const DIVE_ALIGN = 5 * DEG;
/** A waypoint counts as passed inside this horizontal distance (m). */
const WAYPOINT_RADIUS = 120;
/** Distance from the target point that counts as a hit (m). */
export const IMPACT_RADIUS = 4;
/** Height of the hit volume a landmark test pads the drone with (m). */
const LANDMARK_PAD = 1;

export type OneWayPhase = 'cruise' | 'dive';

export interface OneWayFlight {
  /** Route waypoints (x, z); flown at `altitude`. The target point follows the last one. */
  route: Vector3[];
  /** Index of the next waypoint (route.length: heading for the target). */
  leg: number;
  /** Impact point (world). */
  target: Vector3;
  /** Route height (m MSL). */
  altitude: number;
  /** Cruise speed (m/s). */
  speed: number;
  diveAngle: number;
  phase: OneWayPhase;
  /**
   * Inside the dive distance but not lined up on the target (its last waypoint was too close to
   * it): fly straight on, out past the dive distance plus a turn radius, then come back round.
   */
  goAround: boolean;
  heading: number;
  pitch: number;
  bank: number;
  /** Set when the drone reached its target (or hit a landmark): the world detonates it. */
  impacted: boolean;
  /** Where it hit (valid once `impacted`). */
  impactPoint: Vector3;
  /** The landmark it flew into, if any. */
  impactLandmark: LandmarkEntity | null;
}

export interface OneWaySpec {
  target: Vector3;
  /** Route height (m MSL). */
  altitude: number;
  /** Cruise speed (m/s); default SHAHED_SPEED. */
  speed?: number;
  /** Waypoints before the target (x, z; y ignored). */
  route?: Vector3[];
  diveAngle?: number;
}

export function createOneWay(spec: OneWaySpec): OneWayFlight {
  return {
    route: (spec.route ?? []).map((p) => new Vector3(p.x, spec.altitude, p.z)),
    leg: 0,
    target: spec.target.clone(),
    altitude: spec.altitude,
    speed: spec.speed ?? SHAHED_SPEED,
    diveAngle: spec.diveAngle ?? SHAHED_DIVE_ANGLE,
    phase: 'cruise',
    goAround: false,
    heading: 0,
    pitch: 0,
    bank: 0,
    impacted: false,
    impactPoint: new Vector3(),
    impactLandmark: null,
  };
}

/** Horizontal distance from the target at which the dive starts (m). */
export function diveStartDistance(f: OneWayFlight): number {
  return Math.max(0, f.altitude - f.target.y) / Math.tan(f.diveAngle);
}

/** The point the drone is flying towards in cruise (next waypoint, then the target). */
function aimPoint(f: OneWayFlight): Vector3 {
  return f.leg < f.route.length ? f.route[f.leg] : f.target;
}

/**
 * Put a freshly spawned aircraft on its one-way route: at `position` (x, z) and the route height,
 * nose towards the first waypoint (or the target).
 */
export function placeOneWay(ac: AircraftEntity, f: OneWayFlight, position: Vector3): void {
  ac.oneWay = f;
  ac.ai = null;
  ac.position.set(position.x, f.altitude, position.z);
  const aim = aimPoint(f);
  f.heading = headingTo(ac.position, aim);
  f.pitch = 0;
  f.bank = 0;
  headingDir(f.heading, _dir);
  ac.velocity.set(_dir.x * f.speed, 0, _dir.z * f.speed);
  ac.rates.set(0, 0, 0);
  setQuatFromHPR(ac.quaternion, f.heading, 0, 0);
  // no stores, no gun, no countermeasures
  for (const st of ac.stores) st.count = 0;
  ac.gunAmmo = 0;
  ac.gunMaxAmmo = 0;
  ac.flares = 0;
  ac.chaff = 0;
  ac.radar.emitting = false;
  writeFlight(ac, f, null);
}

/**
 * Advance a live one-way drone by dt. Returns true on the step it hits its target (or a
 * landmark): `f.impacted`, `f.impactPoint` and `f.impactLandmark` are then set and the drone sits
 * at the impact point. The caller (the world) reports the impact and detonates it.
 */
export function stepOneWay(ac: AircraftEntity, dt: number, terrain: TerrainQuery | null, landmarks: readonly LandmarkEntity[]): boolean {
  const f = ac.oneWay;
  if (!f || !ac.alive || f.impacted || !(dt > 0)) return false;
  const pos = ac.position;
  _prev.copy(pos);
  const prevHeading = f.heading;

  if (f.phase === 'cruise') {
    // next waypoint once this one is (nearly) overflown
    while (f.leg < f.route.length && hDist(pos, f.route[f.leg]) < WAYPOINT_RADIUS) f.leg++;
    if (f.leg >= f.route.length) {
      const d = hDist(pos, f.target);
      const dive = diveStartDistance(f);
      if (d <= dive + f.speed * dt) {
        // dive only when lined up: never a snap turn onto a target that is beside or behind it
        if (Math.abs(wrapPi(headingTo(pos, f.target) - f.heading)) <= DIVE_ALIGN) f.phase = 'dive';
        else f.goAround = true;
      } else if (f.goAround && d > dive + f.speed / TURN_RATE) f.goAround = false;
    }
  }

  if (f.phase === 'cruise') {
    if (!f.goAround) {
      const aim = aimPoint(f);
      const err = wrapPi(headingTo(pos, aim) - f.heading);
      // the circle through the aim point tangent to the track needs 2·V·sin(err)/d: turn at least
      // that hard (a little more), so a close waypoint is never orbited for ever
      const need = (2.1 * f.speed * Math.abs(Math.sin(err))) / Math.max(1, hDist(pos, aim));
      const rate = Math.min(MAX_TURN_RATE, Math.max(TURN_RATE, need));
      f.heading = wrap2Pi(f.heading + Math.sign(err) * Math.min(Math.abs(err), rate * dt));
    }
    headingDir(f.heading, _dir);
    pos.x += _dir.x * f.speed * dt;
    pos.z += _dir.z * f.speed * dt;
    pos.y = f.altitude;
    f.pitch = 0;
  } else {
    // straight down the line to the target point, gaining speed
    _to.subVectors(f.target, pos);
    const dist = _to.length();
    const v = f.speed * DIVE_SPEEDUP;
    const step = v * dt;
    if (dist <= step + IMPACT_RADIUS) {
      pos.copy(f.target);
      return impact(ac, f, null, dt);
    }
    _to.divideScalar(dist);
    pos.addScaledVector(_to, step);
    if (Math.hypot(_to.x, _to.z) > 1e-3) f.heading = wrap2Pi(Math.atan2(_to.x, -_to.z));
    f.pitch = Math.asin(Math.max(-1, Math.min(1, _to.y)));
  }

  // a structure in the way (the Sky Tower): the warhead goes off against it
  if (landmarks.length) {
    const hit = firstLandmarkHit(landmarks, _prev, pos, LANDMARK_PAD);
    if (hit) {
      pos.lerpVectors(_prev, pos, hit.s);
      return impact(ac, f, hit.landmark, dt);
    }
  }

  const turnRate = wrapPi(f.heading - prevHeading) / dt;
  const bankT = f.phase === 'cruise' ? Math.atan((f.speed * turnRate) / G) : 0;
  f.bank += Math.sign(bankT - f.bank) * Math.min(Math.abs(bankT - f.bank), 15 * DEG * dt);
  ac.velocity.set((pos.x - _prev.x) / dt, (pos.y - _prev.y) / dt, (pos.z - _prev.z) / dt);
  setQuatFromHPR(ac.quaternion, f.heading, f.pitch, f.bank);
  writeFlight(ac, f, terrain);
  return false;
}

function impact(ac: AircraftEntity, f: OneWayFlight, landmark: LandmarkEntity | null, dt: number): boolean {
  f.impacted = true;
  f.impactPoint.copy(ac.position);
  f.impactLandmark = landmark;
  ac.velocity.set((ac.position.x - _prev.x) / dt, (ac.position.y - _prev.y) / dt, (ac.position.z - _prev.z) / dt);
  return true;
}

const _dir = new Vector3();
const _to = new Vector3();
const _prev = new Vector3();
const ATM = atmosphere(0);

function headingDir(heading: number, out: Vector3): Vector3 {
  return out.set(Math.sin(heading), 0, -Math.cos(heading));
}

function headingTo(from: Vector3, to: Vector3): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  return Math.abs(dx) + Math.abs(dz) < 1e-6 ? 0 : wrap2Pi(Math.atan2(dx, -dz));
}

function hDist(a: Vector3, b: Vector3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function wrap2Pi(a: number): number {
  const t = a % (Math.PI * 2);
  return t < 0 ? t + Math.PI * 2 : t;
}

/** Publish the scripted state in AircraftEntity.flight (HUD, sound, visuals and sensors read it). */
function writeFlight(ac: AircraftEntity, f: OneWayFlight, terrain: TerrainQuery | null): void {
  const fl = ac.flight;
  const V = ac.velocity.length();
  atmosphere(ac.position.y, ATM);
  fl.tas = V;
  fl.ias = tasToIas(V, ac.position.y);
  fl.mach = V / ATM.speedOfSound;
  fl.altitude = ac.position.y;
  fl.agl = terrain ? ac.position.y - terrain.surfaceHeightAt(ac.position.x, ac.position.z) : ac.position.y;
  fl.verticalSpeed = ac.velocity.y;
  fl.heading = f.heading;
  fl.pitch = f.pitch;
  fl.roll = f.bank;
  fl.alpha = 0;
  fl.beta = 0;
  fl.gLoad = 1;
  fl.thrust = 0;
  // the piston engine runs flat out all the way (IR signature, engine sound)
  fl.engineRpm = 0.9;
  fl.afterburner = 0;
  fl.stalled = false;
  fl.supersonic = false;
}
