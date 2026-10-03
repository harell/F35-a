/**
 * F35-A — scripted civil flights (neutral airliner traffic).
 *
 * Airliners do not use the fighter flight model / AI autopilot (neither can land): while alive they
 * fly a kinematic profile along the runway's extended centreline, and the world skips stepFlight for
 * them. When one is shot down `alive` goes false and the ordinary flight model takes over as a
 * tumbling wreck from the velocity the profile last set.
 *
 *  arrival:   3° glide slope to an aim point 300 m past the threshold → flare → touchdown →
 *             roll-out braking to taxi speed → vacate (despawn).
 *  departure: take-off roll → rotate → initial climb on the runway heading → turn onto the exit
 *             heading → climb to cruise → despawn far from the airport.
 *
 * Positions use world conventions (heading 0 = north = −Z, clockwise; y up).
 */
import { Vector3 } from 'three';
import { tasToIas, atmosphere } from '../../core/atmosphere';
import { G } from '../../core/math';
import type { AircraftEntity } from '../entities';
import type { TerrainQuery } from '../api';
import { setQuatFromHPR } from '../flight/attitude';

const DEG = Math.PI / 180;

/** A320neo: height of the model origin above the runway with the gear down (m) — lowest wheel point. */
export const A320_GEAR_HEIGHT = 4.15;

/** Runway centre, landing / take-off direction and length. */
export interface Runway {
  x: number;
  z: number;
  /** Direction of travel along the runway for this flow (rad, 0 = north, clockwise). */
  heading: number;
  length: number;
  /** Runway surface elevation (m). */
  elevation: number;
}

export type CivilPhase = 'approach' | 'flare' | 'rollout' | 'taxi' | 'takeoff' | 'climb' | 'enroute';

export interface CivilFlight {
  kind: 'arrival' | 'departure';
  phase: CivilPhase;
  runway: Runway;
  /** Along-track distance (m): arrivals from the aim point (negative on final), departures from brake release. */
  s: number;
  /** True airspeed / ground speed (m/s). */
  speed: number;
  heading: number;
  /** Flight-path angle (rad). */
  gamma: number;
  bank: number;
  pitch: number;
  /** Departures: heading flown after the initial climb. */
  exitHeading: number;
  /** Departures: cruise altitude (m). */
  cruiseAlt: number;
  /** Seconds in the current phase. */
  timer: number;
  /** Seconds since spawn. */
  age: number;
  /** Height of the aircraft origin above the wheels' contact point (m). */
  gearHeight: number;
  /** Set when the flight is over (landed and vacated / left the area): the world removes it. */
  despawn: boolean;
}

/* Profile constants */
export const GLIDE_SLOPE = 3 * DEG;
/** Aim point beyond the landing threshold (m). */
const AIM_POINT = 300;
/** Flare starts at this height above the runway (m). */
const FLARE_HEIGHT = 15;
const APPROACH_SPEED = 70; // ≈ 136 kt
const INITIAL_APPROACH_SPEED = 95;
const TOUCHDOWN_SINK = 0.6; // m/s
const ROLLOUT_DECEL = 2.0;
const TAXI_SPEED = 12;
const TAKEOFF_ACCEL = 2.1;
const ROTATE_SPEED = 76;
const CLIMB_GAMMA = 8 * DEG;
const CLIMB_SPEED = 130; // ≈ 250 kt below 10 000 ft
const CRUISE_SPEED = 200;
const TURN_RATE = 2 * DEG; // a gentle airliner turn (~25° bank at climb speed)
/** Departures turn onto their exit heading after this distance and height. */
const TURN_AFTER = 6_000;
const TURN_MIN_AGL = 500;
/** Seconds of taxi at the end of the landing roll before the jet vacates. */
const VACATE_TIME = 25;
const GEAR_RATE = 1 / 8; // gear transit time 8 s

/** Unit vector of a heading (x = east, z = south). */
export function headingDir(heading: number, out = new Vector3()): Vector3 {
  return out.set(Math.sin(heading), 0, -Math.cos(heading));
}

/** World XZ of the landing threshold (where the runway starts for this flow). */
export function thresholdOf(rw: Runway, out = new Vector3()): Vector3 {
  headingDir(rw.heading, out).multiplyScalar(-rw.length / 2);
  return out.set(rw.x + out.x, rw.elevation, rw.z + out.z);
}

/** Height above the runway on the approach at along-track distance `s` from the aim point (s ≤ 0). */
export function approachHeight(s: number): number {
  const d = -s;
  const flareLen = FLARE_HEIGHT / Math.tan(GLIDE_SLOPE);
  if (d >= flareLen) return d * Math.tan(GLIDE_SLOPE);
  if (d <= 0) return 0;
  // cubic Hermite from (u=1: h=FLARE_HEIGHT, slope on the glide path) to (u=0: h=0, gentle sink)
  const u = d / flareLen;
  const m1 = FLARE_HEIGHT; // dh/du at u=1 equals the glide slope (flareLen·tanγ)
  const m0 = (TOUCHDOWN_SINK / APPROACH_SPEED) * flareLen;
  const u2 = u * u;
  const u3 = u2 * u;
  return (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * FLARE_HEIGHT + (u3 - u2) * m1;
}

export function createArrival(rw: Runway, distanceOut: number, gearHeight: number): CivilFlight {
  return {
    kind: 'arrival',
    phase: 'approach',
    runway: rw,
    s: -Math.abs(distanceOut),
    speed: approachSpeedAt(-Math.abs(distanceOut)),
    heading: rw.heading,
    gamma: -GLIDE_SLOPE,
    bank: 0,
    pitch: 0,
    exitHeading: rw.heading,
    cruiseAlt: 0,
    timer: 0,
    age: 0,
    gearHeight,
    despawn: false,
  };
}

export function createDeparture(rw: Runway, exitHeading: number, cruiseAlt: number, gearHeight: number): CivilFlight {
  return {
    kind: 'departure',
    phase: 'takeoff',
    runway: rw,
    s: 0,
    speed: 0,
    heading: rw.heading,
    gamma: 0,
    bank: 0,
    pitch: 0,
    exitHeading,
    cruiseAlt,
    timer: 0,
    age: 0,
    gearHeight,
    despawn: false,
  };
}

function approachSpeedAt(s: number): number {
  // decelerate from the initial approach speed to the final approach speed by 5 km out
  const t = Math.min(1, Math.max(0, (-s - 5_000) / 15_000));
  return APPROACH_SPEED + (INITIAL_APPROACH_SPEED - APPROACH_SPEED) * t;
}

const _dir = new Vector3();
const _thr = new Vector3();
const ATM = atmosphere(0);

/** World position of an arrival at along-track distance `s` (from the aim point). */
export function arrivalPosition(f: CivilFlight, s: number, out = new Vector3()): Vector3 {
  const rw = f.runway;
  thresholdOf(rw, _thr);
  headingDir(rw.heading, _dir);
  const along = AIM_POINT + s; // from the threshold
  return out.set(_thr.x + _dir.x * along, rw.elevation + f.gearHeight + approachHeight(Math.min(0, s)), _thr.z + _dir.z * along);
}

/** World position of a departure at brake release (on the threshold, facing down the runway). */
export function departureStart(f: CivilFlight, out = new Vector3()): Vector3 {
  const rw = f.runway;
  thresholdOf(rw, _thr);
  headingDir(rw.heading, _dir);
  return out.set(_thr.x + _dir.x * 60, rw.elevation + f.gearHeight, _thr.z + _dir.z * 60);
}

/** Put a freshly spawned civil aircraft at the start of its profile (position, velocity, attitude, gear). */
export function placeCivil(ac: AircraftEntity, f: CivilFlight): void {
  ac.civil = f;
  if (f.kind === 'arrival') arrivalPosition(f, f.s, ac.position);
  else departureStart(f, ac.position);
  ac.gear = f.kind === 'arrival' ? (f.s > -9_000 ? 1 : 0) : 1;
  headingDir(f.heading, _dir);
  ac.velocity.set(_dir.x * f.speed * Math.cos(f.gamma), Math.sin(f.gamma) * f.speed, _dir.z * f.speed * Math.cos(f.gamma));
  f.pitch = f.kind === 'arrival' ? f.gamma + 3 * DEG : 0;
  setQuatFromHPR(ac.quaternion, f.heading, f.pitch, 0);
  ac.rates.set(0, 0, 0);
  writeFlight(ac, f, null, 0);
}

/**
 * Advance a live civil aircraft by dt. `player` (may be null) only gates despawning so jets never
 * vanish in front of the player.
 */
export function stepCivil(ac: AircraftEntity, dt: number, terrain: TerrainQuery, player: AircraftEntity | null): void {
  const f = ac.civil;
  if (!f || !ac.alive || f.despawn || dt <= 0) return;
  f.age += dt;
  f.timer += dt;
  const prevHeading = f.heading;
  const pos = ac.position;
  const x0 = pos.x;
  const y0 = pos.y;
  const z0 = pos.z;
  let gearTarget = ac.gear ?? 1;
  let flaps = 0;
  let rpm: number;

  if (f.kind === 'arrival') {
    if (f.phase === 'approach' || f.phase === 'flare') {
      f.speed = approachSpeedAt(f.s);
      f.s += f.speed * dt;
      if (f.phase === 'approach' && approachHeight(Math.min(0, f.s)) <= FLARE_HEIGHT) enter(f, 'flare');
      if (f.s >= 0) enter(f, 'rollout');
      arrivalPosition(f, Math.min(0, f.s), pos);
      if (f.s > -9_000) gearTarget = 1;
      flaps = f.s > -16_000 ? 1 : 0.4;
      rpm = f.phase === 'flare' ? 0.35 : 0.62;
      const climb = (pos.y - y0) / Math.max(1e-3, f.speed * dt);
      f.gamma = Math.atan(climb);
      f.pitch = f.gamma + (f.phase === 'flare' ? 3 + 3 * (1 - (pos.y - f.runway.elevation - f.gearHeight) / FLARE_HEIGHT) : 3) * DEG;
    } else {
      // roll-out and taxi on the runway
      if (f.phase === 'rollout') {
        f.speed = Math.max(TAXI_SPEED, f.speed - ROLLOUT_DECEL * dt);
        if (f.speed <= TAXI_SPEED) enter(f, 'taxi');
        rpm = f.timer < 12 ? 0.75 : 0.3; // reverse thrust, then idle
        flaps = 1;
      } else {
        rpm = 0.3;
        // stop before the far end of the runway
        const left = f.runway.length - AIM_POINT - f.s - 300;
        f.speed = left > 0 ? Math.min(TAXI_SPEED, Math.max(0, left * 0.1)) : 0;
        if (f.timer > VACATE_TIME && !nearPlayer(ac, player, 1_500)) f.despawn = true;
      }
      f.s += f.speed * dt;
      arrivalPosition(f, f.s, pos);
      pos.y = f.runway.elevation + f.gearHeight;
      f.gamma = 0;
      f.pitch = Math.max(0, f.pitch - 1.5 * DEG * dt);
      gearTarget = 1;
    }
    f.bank = 0;
  } else {
    // departure
    if (f.phase === 'takeoff') {
      f.speed += TAKEOFF_ACCEL * dt;
      rpm = 0.95;
      flaps = 0.5;
      gearTarget = 1;
      if (f.speed >= ROTATE_SPEED) enter(f, 'climb');
      f.gamma = 0;
      f.pitch = 0;
    } else {
      rpm = f.phase === 'climb' ? 0.92 : 0.8;
      const agl = pos.y - f.runway.elevation - f.gearHeight;
      if (f.timer > 4 && f.phase === 'climb') gearTarget = 0;
      if (f.phase === 'enroute') gearTarget = 0;
      flaps = agl < 600 ? 0.5 : 0;
      // speed: accelerate to climb speed, then to cruise speed above 3 000 m
      const vT = pos.y > 3_000 ? CRUISE_SPEED : CLIMB_SPEED;
      f.speed += Math.sign(vT - f.speed) * Math.min(Math.abs(vT - f.speed), 1.0 * dt);
      // flight path: rotate to the climb angle, level off at cruise altitude
      const altErr = f.cruiseAlt - pos.y;
      const gT = Math.max(-2 * DEG, Math.min(CLIMB_GAMMA, Math.atan(altErr / 2_500)));
      f.gamma += Math.sign(gT - f.gamma) * Math.min(Math.abs(gT - f.gamma), 1.8 * DEG * dt);
      // turn onto the exit heading once clear of the airport
      if (f.s > TURN_AFTER && agl > TURN_MIN_AGL) {
        if (f.phase === 'climb') enter(f, 'enroute');
        const err = wrapPi(f.exitHeading - f.heading);
        f.heading = wrap2Pi(f.heading + Math.sign(err) * Math.min(Math.abs(err), TURN_RATE * dt));
      }
      f.pitch = f.gamma + 2.5 * DEG;
    }
    headingDir(f.heading, _dir);
    const ch = Math.cos(f.gamma) * f.speed * dt;
    pos.x += _dir.x * ch;
    pos.z += _dir.z * ch;
    if (f.phase === 'takeoff') pos.y = f.runway.elevation + f.gearHeight;
    else pos.y += Math.sin(f.gamma) * f.speed * dt;
    f.s += ch;
    const turnRate = wrapPi(f.heading - prevHeading) / dt;
    const bankT = Math.atan((f.speed * turnRate) / G);
    f.bank += Math.sign(bankT - f.bank) * Math.min(Math.abs(bankT - f.bank), 5 * DEG * dt);
    // leave the area: far from the airport and the player
    const fromRw = Math.hypot(pos.x - f.runway.x, pos.z - f.runway.z);
    if ((fromRw > 30_000 && !nearPlayer(ac, player, 10_000)) || fromRw > 60_000) f.despawn = true;
  }

  // gear transit
  const g = ac.gear ?? gearTarget;
  ac.gear = g + Math.sign(gearTarget - g) * Math.min(Math.abs(gearTarget - g), GEAR_RATE * dt);

  ac.velocity.set((pos.x - x0) / dt, (pos.y - y0) / dt, (pos.z - z0) / dt);
  setQuatFromHPR(ac.quaternion, f.heading, f.pitch, f.bank);
  writeFlight(ac, f, terrain, rpm, flaps);
}

function enter(f: CivilFlight, phase: CivilPhase): void {
  f.phase = phase;
  f.timer = 0;
}

function nearPlayer(ac: AircraftEntity, player: AircraftEntity | null, range: number): boolean {
  return !!player && player.alive && player.position.distanceToSquared(ac.position) < range * range;
}

function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function wrap2Pi(a: number): number {
  const t = a % (Math.PI * 2);
  return t < 0 ? t + Math.PI * 2 : t;
}

/** Publish the scripted state in AircraftEntity.flight (HUD, sound, visuals, sensors read it). */
function writeFlight(ac: AircraftEntity, f: CivilFlight, terrain: TerrainQuery | null, rpm: number, flaps = 0): void {
  const fl = ac.flight;
  const V = ac.velocity.length();
  atmosphere(ac.position.y, ATM);
  fl.tas = V;
  fl.ias = tasToIas(V, ac.position.y);
  fl.mach = V / ATM.speedOfSound;
  fl.altitude = ac.position.y;
  fl.agl = terrain ? ac.position.y - terrain.surfaceHeightAt(ac.position.x, ac.position.z) : ac.position.y - f.runway.elevation;
  fl.verticalSpeed = ac.velocity.y;
  fl.heading = f.heading;
  fl.pitch = f.pitch;
  fl.roll = f.bank;
  fl.alpha = f.pitch - f.gamma;
  fl.beta = 0;
  fl.gLoad = 1 / Math.max(0.5, Math.cos(f.bank));
  fl.gPeak = fl.gLoad;
  fl.engineRpm = rpm;
  fl.afterburner = 0;
  fl.stalled = false;
  fl.supersonic = false;
  fl.surfaces.flaps = flaps;
  fl.surfaces.elevator = 0;
  fl.surfaces.aileron = 0;
  fl.surfaces.rudder = 0;
  fl.surfaces.airbrake = 0;
}
