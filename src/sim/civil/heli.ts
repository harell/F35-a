/**
 * F35-A — scripted civil helicopter flights (#144): the real rescue and police helicopters over Auckland, neutral
 * traffic like the airliners (route.ts). While alive a helicopter flies a kinematic profile, never the flight model
 * (the world skips stepFlight for it); shot down, `alive` goes false and the flight model takes over as a falling
 * wreck from the velocity the profile last set. Nothing respawns it: a new session spawns the fleet again.
 *
 * Each helicopter flies one fixed cycle of stops, round and round:
 *  pad     on the pad (rotors turning, a dwell: the stop's own, a hospital hand-over is shorter than a base stand-by),
 *          lift-off to 30 m, transit climbing to the cruise height at the cruise speed, a decelerating approach that
 *          descends towards the next pad (≈ 6° from 1.2 km out), a hover over it while turning onto the pad's heading,
 *          touch-down, the next dwell. A pad may lie off the map (Whangārei, Great Barrier): the helicopter flies the
 *          real distance there and back.
 *  patrol  the police: a left-hand circle round a point of interest that drifts along a list of waypoints (motorways,
 *          the CBD, suburbs) at walking-car speed, at 1,000–1,500 ft, for the patrol's length; then on to the next
 *          stop (back to base to refuel).
 * A new flight can start anywhere in its cycle (placeHeli fast-forwards it), so the traffic is mid-mission when the
 * sortie begins.
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

/** Height of each type's model origin above its wheels / skids (m): the models (render/models/aircraft/helicopters.ts) are built to it. */
export const HELI_GEAR_HEIGHT = { aw169: 1.45, bell429: 1.3 } as const;

/** The individual helicopters (their name and registration decals: render/models/aircraft/helicopters.ts HELI_LIVERIES). */
export type HeliLiveryId = 'westpac1' | 'westpac2' | 'northland' | 'eagle';

/** A pad as the flight needs it: centre, surface height (m) and heading (rad). */
export interface HeliPad {
  id: string;
  x: number;
  z: number;
  /** Pad surface (m MSL): a rooftop pad's roof, a ground pad's terrain. */
  y: number;
  heading: number;
}

/**
 * A police patrol: the orbit's radius (m), its height (m MSL) and airspeed (m/s), the drifting point of interest's
 * route and speed (m/s), how long it lasts (s).
 */
export interface HeliPatrol {
  route: [number, number][];
  radius: number;
  alt: number;
  airspeed: number;
  speed: number;
  duration: number;
}

/** One stop of a cycle: land on a pad and wait `dwell` s there, or fly a patrol. */
export type HeliStop = { pad: HeliPad; dwell: number } | { patrol: HeliPatrol };

export type HeliPhase = 'parked' | 'liftoff' | 'transit' | 'approach' | 'hover' | 'landing' | 'orbit';

export interface HeliFlight {
  role: 'rescue' | 'police';
  livery: HeliLiveryId;
  phase: HeliPhase;
  /** The cycle, flown in order and round again; `leg` is the stop flown to next (or the patrol being flown). */
  stops: HeliStop[];
  leg: number;
  /** Seconds on the current pad before lifting off. */
  dwell: number;
  /** Transit cruise height (m MSL; at least `minAgl` above the ground) and speed (m/s). */
  cruiseAlt: number;
  cruiseSpeed: number;
  minAgl: number;
  /** The patrol's orbit: where its point of interest is along the route (m, kept from one patrol to the next). */
  orbit?: { radius: number; route: [number, number][]; speed: number; s: number };
  speed: number;
  heading: number;
  pitch: number;
  bank: number;
  /** Seconds in the current phase, since spawn (or since the fast-forward to the start point). */
  timer: number;
  age: number;
  /** Height of the model origin above the wheels / skids (m). */
  gearHeight: number;
  /** Rotor speed 0..1 (spun up on the pad before lift-off): published as the engine rpm for sound. */
  rotor: number;
  /** Every pad touched so far, with the time and the touch-down point: the tests' log. */
  touchdowns: { pad: string; t: number; x: number; z: number }[];
  /** A flight never despawns (the helicopters loop); kept for symmetry with CivilFlight. */
  despawn: boolean;
  /** Peacetime (A Stroll in the Park): its ADS-B reaches the player's jet, as the airliners' does (route.ts CivilFlight.adsb). */
  adsb?: boolean;
}

/* Profile constants */
const LIFTOFF_HEIGHT = 30;
const CLIMB_RATE = 5;
const DESCENT_RATE = 5;
const VERTICAL_RATE = 2.2;
const ACCEL = 1.6;
const DECEL = 1.1;
const TURN_RATE = 6 * DEG;
const APPROACH_ANGLE = 6 * DEG;
/** The approach ends in a hover this high over the pad (m) … */
const HOVER_HEIGHT = 12;
/** … reached this far out (m), at walking speed. */
const HOVER_DIST = 6;
/** Rotor spin-up time (s) before lift-off. */
const SPIN_UP = 20;
/** Ground clearance in transit and on patrol (m). */
const TRANSIT_AGL = 150;
const PATROL_AGL = 250;
/** Fast-forward step (s) when a flight starts part-way round its cycle. */
const WARM_DT = 0.25;

export interface RouteOptions {
  role: 'rescue' | 'police';
  livery: HeliLiveryId;
  /** The cycle; it starts parked on the first stop, which must be a pad (the base). */
  stops: HeliStop[];
  cruiseAlt: number;
  cruiseSpeed: number;
  gearHeight: number;
  /** Where a patrol's point of interest starts along its route (m). */
  patrolStart?: number;
}

export function createRoute(o: RouteOptions): HeliFlight {
  const base = o.stops[0];
  if (!('pad' in base)) throw new Error('a helicopter cycle starts on a pad');
  o.stops.forEach((st, i) => {
    if ('patrol' in st && !('pad' in o.stops[(i + 1) % o.stops.length])) throw new Error('a patrol must be followed by a pad');
  });
  const patrol = o.stops.find((st): st is { patrol: HeliPatrol } => 'patrol' in st)?.patrol;
  return {
    role: o.role,
    livery: o.livery,
    phase: 'parked',
    stops: o.stops,
    leg: 1 % o.stops.length,
    dwell: base.dwell,
    cruiseAlt: o.cruiseAlt,
    cruiseSpeed: o.cruiseSpeed,
    minAgl: TRANSIT_AGL,
    orbit: patrol ? { radius: patrol.radius, route: patrol.route, speed: patrol.speed, s: o.patrolStart ?? 0 } : undefined,
    speed: 0,
    heading: 0,
    pitch: 0,
    bank: 0,
    timer: 0,
    age: 0,
    gearHeight: o.gearHeight,
    rotor: 0.4,
    touchdowns: [],
    despawn: false,
  };
}

/** The pads of a flight's cycle, in order (patrols left out). */
export function cyclePads(f: HeliFlight): HeliPad[] {
  return f.stops.flatMap((st) => ('pad' in st ? [st.pad] : []));
}

/**
 * About how long one round of the cycle takes (s): every leg at the cruise speed plus the climb, approach and
 * landing, every dwell and patrol. Picks where in the cycle a new flight starts.
 */
export function cycleSeconds(f: HeliFlight): number {
  let t = 0;
  const n = f.stops.length;
  for (let i = 0; i < n; i++) {
    const st = f.stops[i];
    const next = f.stops[(i + 1) % n];
    if ('pad' in st) {
      t += st.dwell;
      if ('pad' in next) t += Math.hypot(next.pad.x - st.pad.x, next.pad.z - st.pad.z) / f.cruiseSpeed + 150;
      else t += Math.hypot(next.patrol.route[0][0] - st.pad.x, next.patrol.route[0][1] - st.pad.z) / f.cruiseSpeed + 60;
    } else {
      const to = (next as { pad: HeliPad }).pad;
      const r = st.patrol.route[0];
      t += st.patrol.duration + Math.hypot(to.x - r[0], to.z - r[1]) / f.cruiseSpeed + 150;
    }
  }
  return t;
}

/** The stop the flight is parked on or lifting off from (the one before `leg`). */
function fromPad(f: HeliFlight): HeliPad {
  const st = f.stops[(f.leg - 1 + f.stops.length) % f.stops.length];
  return 'pad' in st ? st.pad : (f.stops[0] as { pad: HeliPad }).pad;
}

const _p = new Vector3();

/** The point of interest of a police orbit at its along-route distance `s` (the route loops). */
export function orbitCentre(f: HeliFlight, out = _p): Vector3 {
  const o = f.orbit!;
  const r = o.route;
  let total = 0;
  for (let i = 0; i < r.length; i++) total += Math.hypot(r[(i + 1) % r.length][0] - r[i][0], r[(i + 1) % r.length][1] - r[i][1]);
  let s = ((o.s % total) + total) % total;
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const b = r[(i + 1) % r.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (s <= l || i === r.length - 1) {
      const t = l > 0 ? Math.min(1, s / l) : 0;
      return out.set(a[0] + (b[0] - a[0]) * t, 0, a[1] + (b[1] - a[1]) * t);
    }
    s -= l;
  }
  return out.set(r[0][0], 0, r[0][1]);
}

/**
 * Put a freshly spawned helicopter on its base pad (the first stop), rotors idling, then fly it `warmup` seconds on
 * round its cycle, so it starts wherever that puts it: parked, on a leg, or on patrol. The log starts after that.
 */
export function placeHeli(ac: AircraftEntity, f: HeliFlight, terrain: TerrainQuery, warmup = 0): void {
  ac.heli = f;
  ac.gear = 1;
  const from = fromPad(f);
  ac.position.set(from.x, from.y + f.gearHeight, from.z);
  f.heading = from.heading;
  f.timer = 0;
  setQuatFromHPR(ac.quaternion, f.heading, f.pitch, f.bank);
  ac.velocity.set(0, 0, 0);
  ac.rates.set(0, 0, 0);
  writeFlight(ac, f, terrain);
  for (let t = 0; t < warmup; t += WARM_DT) stepHeli(ac, WARM_DT, terrain);
  f.age = 0;
  f.touchdowns.length = 0;
}

/** Advance a live civil helicopter by dt. */
export function stepHeli(ac: AircraftEntity, dt: number, terrain: TerrainQuery): void {
  const f = ac.heli;
  if (!f || !ac.alive || dt <= 0) return;
  f.age += dt;
  f.timer += dt;
  const pos = ac.position;
  const x0 = pos.x;
  const y0 = pos.y;
  const z0 = pos.z;
  const prevHeading = f.heading;
  let pitchT = 0;

  if (f.phase === 'orbit') {
    const o = f.orbit!;
    const patrol = (f.stops[f.leg] as { patrol: HeliPatrol }).patrol;
    o.s += o.speed * dt;
    const c = orbitCentre(f);
    // steer onto the circle: aim at the point a little ahead on it (anticlockwise on the map)
    const a = Math.atan2(pos.z - c.z, pos.x - c.x);
    const ahead = a - 0.35;
    const tx = c.x + Math.cos(ahead) * o.radius;
    const tz = c.z + Math.sin(ahead) * o.radius;
    turnTowards(f, headingOf(tx - pos.x, tz - pos.z), dt);
    f.speed += clampAbs(patrol.airspeed - f.speed, ACCEL * dt);
    moveFlat(pos, f, dt);
    holdHeight(pos, f, terrain, Math.max(patrol.alt, terrain.surfaceHeightAt(pos.x, pos.z) + PATROL_AGL), dt);
    pitchT = 3 * DEG;
    // the patrol is over: back to the next pad (base, to refuel)
    if (f.timer >= patrol.duration) {
      f.leg = (f.leg + 1) % f.stops.length;
      enter(f, 'transit');
    }
  } else {
    // parked and lifting off, the next stop may be a patrol; every later phase flies to a pad
    const next = f.stops[f.leg];
    const to = 'pad' in next ? next.pad : fromPad(f);
    const dx = to.x - pos.x;
    const dz = to.z - pos.z;
    const d = Math.hypot(dx, dz);
    switch (f.phase) {
      case 'parked':
        f.speed = 0;
        f.rotor = Math.min(1, 0.4 + 0.6 * Math.max(0, (f.timer - (f.dwell - SPIN_UP)) / SPIN_UP));
        if (f.timer >= f.dwell) enter(f, 'liftoff');
        break;
      case 'liftoff': {
        const from = fromPad(f);
        pos.y = Math.min(pos.y + VERTICAL_RATE * dt, from.y + f.gearHeight + LIFTOFF_HEIGHT);
        if (pos.y >= from.y + f.gearHeight + LIFTOFF_HEIGHT - 0.01) enter(f, 'pad' in next ? 'transit' : 'orbit');
        break;
      }
      case 'transit': {
        turnTowards(f, headingOf(dx, dz), dt);
        f.speed += clampAbs(f.cruiseSpeed - f.speed, ACCEL * dt);
        moveFlat(pos, f, dt);
        holdHeight(pos, f, terrain, glideHeight(f, to, d, pos, terrain), dt);
        pitchT = 4 * DEG * (f.speed / f.cruiseSpeed);
        // start slowing down where a constant deceleration ends at the hover point
        if (d - HOVER_DIST < (f.speed * f.speed) / (2 * DECEL) + 60) enter(f, 'approach');
        break;
      }
      case 'approach': {
        turnTowards(f, headingOf(dx, dz), dt);
        const vT = Math.max(1.5, Math.sqrt(2 * DECEL * Math.max(0, d - HOVER_DIST)));
        f.speed = Math.min(f.speed, vT);
        f.speed = Math.min(f.speed, d / Math.max(dt, 1e-3));
        moveFlat(pos, f, dt);
        holdHeight(pos, f, terrain, glideHeight(f, to, d, pos, terrain), dt);
        pitchT = -6 * DEG * (1 - f.speed / f.cruiseSpeed);
        if (d < HOVER_DIST + 1 && f.speed < 3) enter(f, 'hover');
        break;
      }
      case 'hover': {
        // drift onto the pad centre, turn onto its heading (either end), then sink
        const k = Math.min(1, dt * 0.8);
        pos.x += dx * k;
        pos.z += dz * k;
        f.speed = 0;
        const padH = nearestEnd(f.heading, to.heading);
        turnTowards(f, padH, dt * 0.5);
        if (Math.abs(wrapPi(f.heading - padH)) < 2 * DEG && d < 1.5) enter(f, 'landing');
        break;
      }
      case 'landing': {
        pos.x += dx * Math.min(1, dt);
        pos.z += dz * Math.min(1, dt);
        const yPad = to.y + f.gearHeight;
        const rate = pos.y - yPad > 4 ? DESCENT_RATE * 0.5 : 0.6;
        pos.y = Math.max(yPad, pos.y - rate * dt);
        if (pos.y <= yPad + 1e-3) {
          f.touchdowns.push({ pad: to.id, t: f.age, x: pos.x, z: pos.z });
          f.dwell = (next as { dwell: number }).dwell;
          f.leg = (f.leg + 1) % f.stops.length;
          f.rotor = 0.4;
          enter(f, 'parked');
        }
        break;
      }
    }
  }

  ac.velocity.set((pos.x - x0) / dt, (pos.y - y0) / dt, (pos.z - z0) / dt);
  const turnRate = wrapPi(f.heading - prevHeading) / dt;
  const bankT = Math.max(-30 * DEG, Math.min(30 * DEG, Math.atan((f.speed * turnRate) / G)));
  f.bank += clampAbs(bankT - f.bank, 12 * DEG * dt);
  f.pitch += clampAbs(pitchT - f.pitch, 4 * DEG * dt);
  setQuatFromHPR(ac.quaternion, f.heading, f.pitch, f.bank);
  writeFlight(ac, f, terrain);
}

/**
 * The height flown towards a pad: the cruise height (and its ground clearance) until the approach path (APPROACH_ANGLE
 * down to the hover point) passes below it, then that path, kept 60 m over the ground until the last 400 m.
 */
function glideHeight(f: HeliFlight, to: HeliPad, d: number, pos: Vector3, terrain: TerrainQuery): number {
  const ground = terrain.surfaceHeightAt(pos.x, pos.z);
  const cruise = Math.max(f.cruiseAlt, ground + f.minAgl);
  const path = to.y + f.gearHeight + HOVER_HEIGHT + Math.tan(APPROACH_ANGLE) * Math.max(0, d - HOVER_DIST);
  return Math.max(d > 400 ? ground + 60 : -Infinity, Math.min(cruise, path));
}

function enter(f: HeliFlight, phase: HeliPhase): void {
  f.phase = phase;
  f.timer = 0;
}

function moveFlat(pos: Vector3, f: HeliFlight, dt: number): void {
  pos.x += Math.sin(f.heading) * f.speed * dt;
  pos.z -= Math.cos(f.heading) * f.speed * dt;
}

function holdHeight(pos: Vector3, f: HeliFlight, terrain: TerrainQuery, yT: number, dt: number): void {
  const e = yT - pos.y;
  pos.y += e > 0 ? Math.min(e, CLIMB_RATE * dt) : Math.max(e, -DESCENT_RATE * dt);
  // never into the ground
  pos.y = Math.max(pos.y, terrain.surfaceHeightAt(pos.x, pos.z) + f.gearHeight + 5);
}

function turnTowards(f: HeliFlight, h: number, dt: number): void {
  f.heading = wrap2Pi(f.heading + clampAbs(wrapPi(h - f.heading), TURN_RATE * dt));
}

/** Heading (0 = north = −Z, clockwise) of a direction (dx east, dz south). */
export function headingOf(dx: number, dz: number): number {
  return wrap2Pi(Math.atan2(dx, -dz));
}

/** The pad heading (or its reverse: a pad has two ends) closest to `h`. */
function nearestEnd(h: number, pad: number): number {
  return Math.abs(wrapPi(pad - h)) <= Math.PI / 2 ? pad : wrap2Pi(pad + Math.PI);
}

const clampAbs = (v: number, m: number) => (v > m ? m : v < -m ? -m : v);

function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function wrap2Pi(a: number): number {
  const t = a % (Math.PI * 2);
  return t < 0 ? t + Math.PI * 2 : t;
}

const ATM = atmosphere(0);

/** Publish the scripted state in AircraftEntity.flight (HUD, sound, visuals, sensors read it). */
function writeFlight(ac: AircraftEntity, f: HeliFlight, terrain: TerrainQuery): void {
  const fl = ac.flight;
  const V = ac.velocity.length();
  atmosphere(ac.position.y, ATM);
  fl.tas = V;
  fl.ias = tasToIas(V, ac.position.y);
  fl.mach = V / ATM.speedOfSound;
  fl.altitude = ac.position.y;
  fl.agl = ac.position.y - terrain.surfaceHeightAt(ac.position.x, ac.position.z);
  fl.verticalSpeed = ac.velocity.y;
  fl.heading = f.heading;
  fl.pitch = f.pitch;
  fl.roll = f.bank;
  fl.alpha = 0;
  fl.beta = 0;
  fl.gLoad = 1 / Math.max(0.5, Math.cos(f.bank));
  fl.gPeak = fl.gLoad;
  // the turboshafts' sound follows the rotor: idle on the pad, spun up for flight
  fl.engineRpm = 0.55 + 0.4 * f.rotor;
  fl.afterburner = 0;
  fl.stalled = false;
  fl.supersonic = false;
  fl.surfaces.flaps = 0;
  fl.surfaces.elevator = 0;
  fl.surfaces.aileron = 0;
  fl.surfaces.rudder = 0;
  fl.surfaces.airbrake = 0;
}
