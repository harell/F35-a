/**
 * F35-A — Auckland's trains (#146): the rail network and its timetable as pure functions of mission time.
 *
 * The network (railData.ts, baked by tools/gtfs/trains.ts) is the three post-CRL Auckland Transport lines
 * from AT's GTFS feed (each direction its own track, with the stations and one representative weekday
 * trip's stop times) and the KiwiRail container path between the Ports of Auckland and the Wiri Inland
 * Port. Every train is a fixed unit circulating its line: out on one direction, a layover at the
 * terminus, back on the other, a layover, and again. A line's units are spaced one headway apart round
 * that cycle, so each direction departs every headway, and where any train is at time t is a pure
 * function (like the harbour ferries' ferryAt): nothing is stepped, the sim and the renderer read the
 * same poses at the same sim time.
 *
 * A trip follows the GTFS times: from each station to the next the train accelerates, cruises and
 * brakes (trapezoid profile, AM class 0.9 m/s², ≤ 110 km/h) so it arrives in the GTFS time less a 30 s
 * dwell, then stands 30 s with the middle of the consist on the GTFS stop. Where the minute-rounded
 * GTFS time is too short for the physics the train simply runs late. Freight runs without stops at
 * ≤ 80 km/h and 0.2 m/s².
 *
 * TrainService holds one sortie's units (headways by time of day, consists, a seeded clock) and the
 * wrecks of trains destroyed in it, which the timetable then skips. MissionRunner's TrainTraffic
 * (src/missions/runtime/trains.ts) makes the trains near the player sim entities; the entity renderer
 * (src/render/traffic/Trains.ts) draws the ones near the camera.
 */
import { mulberry32 } from '../../core/math';
import type { TimeOfDay } from '../../core/types';
import { RAIL_DATA_B64 } from './railData';

/* ───────────────────────────── network ───────────────────────────── */

export const LINE_EW = 0;
export const LINE_SC = 1;
export const LINE_OW = 2;
export const LINE_FREIGHT = 3;

export interface RailLineDef {
  id: number;
  /** AT's short code, as on the timetables and the trains' destination displays. */
  code: string;
  name: string;
  /** AT's line colour (GTFS route_color). */
  color: number;
  /** Departures per hour each way, by service period (AT GTFS, a Wednesday of the 2026-09-17 feed). */
  perHour: { peak: number; offpeak: number; evening: number };
  /** Share of 6-car trains, by service period (the rest run as 3 cars). */
  sixCar: { peak: number; offpeak: number; evening: number };
}

/**
 * The lines, named and coloured as AT names them (at.govt.nz timetables; GTFS routes.txt route_short_name
 * and route_color): E-W East West line green, S-C South City line red, O-W Onehunga West line light blue.
 * Departures per hour from the GTFS (first departures of each trip, by hour): East-West 7–8 at peak,
 * 4 off-peak, 2 in the evening; South-City 6 / 4 / 2; Onehunga-West 2 all day.
 */
export const RAIL_LINES: readonly RailLineDef[] = [
  { id: LINE_EW, code: 'E-W', name: 'East West line', color: 0x97c93d, perHour: { peak: 8, offpeak: 4, evening: 2 }, sixCar: { peak: 0.75, offpeak: 0.5, evening: 0.25 } },
  { id: LINE_SC, code: 'S-C', name: 'South City line', color: 0xd52923, perHour: { peak: 6, offpeak: 4, evening: 2 }, sixCar: { peak: 0.75, offpeak: 0.5, evening: 0.25 } },
  { id: LINE_OW, code: 'O-W', name: 'Onehunga West line', color: 0x00aeef, perHour: { peak: 2, offpeak: 2, evening: 2 }, sixCar: { peak: 0, offpeak: 0, evening: 0 } },
];

export type ServicePeriod = 'peak' | 'offpeak' | 'evening';
/** The timetable a sortie flies in: dawn and dusk in the peaks, day off-peak, night in the evening service. */
export function servicePeriod(tod: TimeOfDay): ServicePeriod {
  return tod === 'day' ? 'offpeak' : tod === 'night' ? 'evening' : 'peak';
}

export interface RailStop {
  name: string;
  /** Distance along the path (m) where the middle of a stopped consist stands. */
  s: number;
  /** GTFS departure (s after the trip's first departure). */
  t: number;
  /** The GTFS stop position (world XZ, m). */
  gx: number;
  gz: number;
}

export interface RailPath {
  line: number;
  /** 0 / 1: the GTFS direction (freight: 0 = to Wiri, 1 = to the port). */
  dir: number;
  x: Float64Array;
  z: Float64Array;
  /** Cumulative distance at each vertex (m). */
  cum: Float64Array;
  length: number;
  /** Tunnel runs along the path, flat [s0, s1, s0, s1, …] (m). */
  tunnels: Float64Array;
  stops: RailStop[];
}

export interface RailNetwork {
  paths: RailPath[];
  /** The path of a line and direction. */
  path(line: number, dir: number): RailPath;
  /** Raw data size (bytes, before base64). */
  bytes: number;
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  return new Uint8Array((globalThis as unknown as { Buffer: { from(s: string, e: string): Uint8Array } }).Buffer.from(b64, 'base64'));
}

/** Decode the baked network (format: tools/gtfs/trains.ts). */
export function decodeRail(bytes: Uint8Array): RailNetwork {
  let o = 0;
  const u8 = () => bytes[o++];
  const varint = () => {
    let v = 0;
    let m = 1;
    for (;;) {
      const b = u8();
      v += (b & 127) * m;
      if (b < 128) return v;
      m *= 128;
    }
  };
  const zz = () => {
    const v = varint();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  };
  const magic = String.fromCharCode(u8(), u8(), u8(), u8());
  if (magic !== 'AKLT' || u8() !== 1) throw new Error('bad rail data header');
  const q = new DataView(bytes.buffer, bytes.byteOffset + o, 4).getFloat32(0, true);
  o += 4;
  const names: string[] = [];
  const dec = new TextDecoder();
  for (let n = varint(), i = 0; i < n; i++) {
    const len = u8();
    names.push(dec.decode(bytes.subarray(o, o + len)));
    o += len;
  }
  const paths: RailPath[] = [];
  for (let n = varint(), i = 0; i < n; i++) {
    const line = u8();
    const dir = u8();
    const nv = varint();
    const x = new Float64Array(nv);
    const z = new Float64Array(nv);
    const cum = new Float64Array(nv);
    let qx = 0;
    let qz = 0;
    for (let k = 0; k < nv; k++) {
      qx += zz();
      qz += zz();
      x[k] = qx * q;
      z[k] = qz * q;
      if (k > 0) cum[k] = cum[k - 1] + Math.hypot(x[k] - x[k - 1], z[k] - z[k - 1]);
    }
    const nt = varint();
    const tunnels = new Float64Array(nt * 2);
    let end = 0;
    for (let k = 0; k < nt; k++) {
      const s0 = end + varint();
      end = s0 + varint();
      tunnels[2 * k] = s0;
      tunnels[2 * k + 1] = end;
    }
    const stops: RailStop[] = [];
    let ds = 0;
    for (let ns = varint(), k = 0; k < ns; k++) {
      ds += varint();
      const name = names[varint()];
      const t = varint();
      const gx = zz() * q;
      const gz = zz() * q;
      stops.push({ name, s: ds / 10, t, gx, gz });
    }
    paths.push({ line, dir, x, z, cum, length: cum[nv - 1], tunnels, stops });
  }
  return {
    paths,
    bytes: bytes.length,
    path(line: number, dir: number): RailPath {
      const p = paths.find((r) => r.line === line && r.dir === dir);
      if (!p) throw new Error(`no rail path ${line}/${dir}`);
      return p;
    },
  };
}

let network: RailNetwork | null = null;
/** The baked network (decoded once). */
export function railNetwork(): RailNetwork {
  return (network ??= decodeRail(base64ToBytes(RAIL_DATA_B64)));
}

/** Point at distance `s` along a path into out[0..1] (linear beyond the ends: a consist overhangs a terminus). */
export function pointAt(p: RailPath, s: number, out: { x: number; z: number }): { x: number; z: number } {
  const cum = p.cum;
  const n = cum.length;
  let i: number;
  if (s <= 0) i = 0;
  else if (s >= p.length) i = n - 2;
  else {
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (cum[m] <= s) lo = m;
      else hi = m;
    }
    i = lo;
  }
  const l = cum[i + 1] - cum[i] || 1;
  const u = (s - cum[i]) / l;
  out.x = p.x[i] + (p.x[i + 1] - p.x[i]) * u;
  out.z = p.z[i] + (p.z[i + 1] - p.z[i]) * u;
  return out;
}

/** Is distance `s` along the path underground? */
export function inTunnel(p: RailPath, s: number): boolean {
  const t = p.tunnels;
  for (let i = 0; i < t.length; i += 2) {
    if (s < t[i]) return false;
    if (s <= t[i + 1]) return true;
  }
  return false;
}

/* ───────────────────────────── motion ───────────────────────────── */

/** AM class EMU: acceleration = service braking (m/s²), top speed (110 km/h). */
export const AM_ACCEL = 0.9;
export const AM_VMAX = 110 / 3.6;
/** DL-hauled container train: acceleration and braking (m/s²), top speed with freight (80 km/h). */
export const FREIGHT_ACCEL = 0.2;
export const FREIGHT_VMAX = 80 / 3.6;
/** Dwell at each intermediate station (s). */
export const DWELL = 30;
/** Shortest layover at a terminus (s); the cycle rounds it up to a whole number of headways. */
export const LAYOVER_MIN = 300;

interface Run {
  /** Departure (s after the trip start) and run time (s). */
  t0: number;
  T: number;
  s0: number;
  s1: number;
  /** Cruise speed (m/s) and acceleration (m/s²). */
  v: number;
  a: number;
}

/** One direction's trip: its runs between stops, dwells in between. */
export interface TripPlan {
  path: RailPath;
  runs: Run[];
  /** Arrival at the last stop (s after the first departure). */
  duration: number;
}

/** A run of length L in (at least) time T: the cruise speed of a trapezoid with equal acceleration and braking. */
export function runProfile(L: number, T: number, a: number, vmax: number): { v: number; T: number } {
  if (L <= 0) return { v: 0, T: 0 };
  const disc = T * T - (4 * L) / a;
  let v: number;
  if (disc < 0) {
    // too short even with no top speed: a triangle
    T = 2 * Math.sqrt(L / a);
    v = (a * T) / 2;
  } else v = ((T - Math.sqrt(disc)) * a) / 2;
  if (v > vmax) {
    v = vmax;
    T = L / v + v / a;
  }
  return { v, T };
}

/** Distance covered after `tau` s of a run, and the speed. */
function runAt(r: Run, tau: number, out: { s: number; v: number }): void {
  const ta = r.v / r.a;
  const L = r.s1 - r.s0;
  if (tau <= 0) {
    out.s = r.s0;
    out.v = 0;
  } else if (tau >= r.T) {
    out.s = r.s1;
    out.v = 0;
  } else if (tau < ta) {
    out.s = r.s0 + 0.5 * r.a * tau * tau;
    out.v = r.a * tau;
  } else if (tau > r.T - ta) {
    const tr = r.T - tau;
    out.s = r.s1 - 0.5 * r.a * tr * tr;
    out.v = r.a * tr;
  } else {
    out.s = r.s0 + 0.5 * r.a * ta * ta + r.v * (tau - ta);
    out.v = r.v;
  }
  if (out.s > r.s0 + L) out.s = r.s1;
}

/** A passenger trip along `path`, following its GTFS stop times. */
export function passengerPlan(path: RailPath): TripPlan {
  const st = path.stops;
  const runs: Run[] = [];
  let t = 0;
  for (let i = 0; i + 1 < st.length; i++) {
    const L = st[i + 1].s - st[i].s;
    const gtfs = st[i + 1].t - st[i].t - DWELL;
    const p = runProfile(L, Math.max(1, gtfs), AM_ACCEL, AM_VMAX);
    runs.push({ t0: t, T: p.T, s0: st[i].s, s1: st[i + 1].s, v: p.v, a: AM_ACCEL });
    t += p.T + (i + 2 < st.length ? DWELL : 0);
  }
  return { path, runs, duration: t };
}

/** A freight run from one end of the path to the other: the consist's middle from `s0` to `s1`. */
export function freightPlan(path: RailPath, s0: number, s1: number): TripPlan {
  const p = runProfile(s1 - s0, 0, FREIGHT_ACCEL, FREIGHT_VMAX);
  return { path, runs: [{ t0: 0, T: p.T, s0, s1, v: p.v, a: FREIGHT_ACCEL }], duration: p.T };
}

/** Where the middle of the consist is `t` s into a trip (clamped to its ends). */
export function planAt(plan: TripPlan, t: number, out: { s: number; v: number }): { s: number; v: number } {
  const runs = plan.runs;
  if (!runs.length) {
    out.s = 0;
    out.v = 0;
    return out;
  }
  let lo = 0;
  let hi = runs.length - 1;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (runs[m].t0 <= t) lo = m;
    else hi = m - 1;
  }
  runAt(runs[lo], t - runs[lo].t0, out);
  return out;
}

/* ───────────────────────────── consists ───────────────────────────── */

/** The models a consist is built from (one instanced mesh each in the renderer). */
export type CarKind = 'am_end' | 'am_mid' | 'dl' | 'wagon';
/** AM class car lengths (m): AMA / AMP end cars 24.3, AMT 23.2; 2.76 m wide, 3.99 m high. DL 18.5 m. A 40 ft flat wagon. */
export const CAR_LENGTH: Record<CarKind, number> = { am_end: 24.3, am_mid: 23.2, dl: 18.5, wagon: 15.2 };
export const CAR_WIDTH: Record<CarKind, number> = { am_end: 2.76, am_mid: 2.76, dl: 2.75, wagon: 2.6 };
/** Roof (or container top) above the rail (m). */
export const CAR_HEIGHT: Record<CarKind, number> = { am_end: 3.99, am_mid: 3.99, dl: 3.9, wagon: 3.75 };
/** Gap between coupled cars (m): 72.03 m for a 3-car unit. */
const COUPLER = 0.12;
/** Rail top above the ground (m) and the causeway level over water (motorways.ts RAIL_CAUSEWAY_Y). */
const RAIL_TOP = 0.45;
const RAIL_CAUSEWAY_Y = 1.8;

export interface Car {
  kind: CarKind;
  /** Distance from the consist's front to the car's middle (m). */
  offset: number;
  /** Facing backwards (the rear cab of an AM unit). */
  flip: boolean;
  /** Container colour index (wagons), 0 otherwise. */
  tint: number;
}

export interface TrainUnit {
  id: number;
  line: number;
  name: string;
  cars: Car[];
  /** Front to back (m). */
  length: number;
  /** The cycle: plan A out, layover, plan B back, layover (s). */
  a: TripPlan;
  b: TripPlan;
  layA: number;
  layB: number;
  period: number;
  /** Phase at sim time 0 (s into the cycle). */
  phase0: number;
}

function amConsist(units: number): Car[] {
  const cars: Car[] = [];
  let at = 0;
  for (let u = 0; u < units; u++) {
    const kinds: [CarKind, boolean][] = [
      ['am_end', false],
      ['am_mid', false],
      ['am_end', true],
    ];
    for (const [kind, flip] of kinds) {
      const L = CAR_LENGTH[kind];
      cars.push({ kind, offset: at + L / 2, flip, tint: 0 });
      at += L + COUPLER;
    }
  }
  return cars;
}

/** Container colours of the freight wagons (index into the renderer's palette). */
export const CONTAINER_TINTS = 8;

function freightConsist(rng: () => number, locos: number, wagons: number): Car[] {
  const cars: Car[] = [];
  let at = 0;
  for (let i = 0; i < locos; i++) {
    cars.push({ kind: 'dl', offset: at + CAR_LENGTH.dl / 2, flip: false, tint: 0 });
    at += CAR_LENGTH.dl + COUPLER;
  }
  for (let i = 0; i < wagons; i++) {
    cars.push({ kind: 'wagon', offset: at + CAR_LENGTH.wagon / 2, flip: false, tint: 1 + Math.floor(rng() * (CONTAINER_TINTS - 1)) });
    at += CAR_LENGTH.wagon + COUPLER;
  }
  return cars;
}

const consistLength = (cars: Car[]) => {
  const last = cars[cars.length - 1];
  return last.offset + CAR_LENGTH[last.kind] / 2;
};

/** A freight cycle (s): each of the two consists runs to Wiri and back twice a day (4 trains a day each way). */
export const FREIGHT_PERIOD = 12 * 3600;
/** At the start of a sortie the freight trains are this many seconds (at most) from departing. */
export const FREIGHT_START_WINDOW = 15 * 60;

/* ───────────────────────────── the sortie's service ───────────────────────────── */

export interface CarPose {
  kind: CarKind;
  x: number;
  y: number;
  z: number;
  /** Heading (rad, clockwise from north, the way the car faces) and pitch (rad, nose up). */
  heading: number;
  pitch: number;
  /** In a tunnel: not drawn, not hit. */
  hidden: boolean;
  tint: number;
}

/** A unit's place on its line at an instant. */
export interface UnitState {
  path: RailPath;
  /** Middle of the consist along the path (m) and speed (m/s, ≥ 0). */
  s: number;
  v: number;
  /** Middle of the consist (world XZ). */
  x: number;
  z: number;
}

export interface TrainServiceOptions {
  timeOfDay: TimeOfDay;
  seed: number;
  /** Ground height (m) under a point: the terrain the rail ribbons are laid on. */
  height: (x: number, z: number) => number;
  network?: RailNetwork;
}

/** A train destroyed in the sortie: its cars where it stopped (the timetable skips its unit). */
export interface TrainWreck {
  unit: number;
  cars: CarPose[];
}

const _ps = { s: 0, v: 0 };
const _pa = { x: 0, z: 0 };
const _pb = { x: 0, z: 0 };

export class TrainService {
  readonly units: TrainUnit[] = [];
  readonly period: ServicePeriod;
  /** Trains destroyed this sortie, by unit id. */
  readonly wrecks = new Map<number, TrainWreck>();
  private readonly height: (x: number, z: number) => number;

  constructor(opts: TrainServiceOptions) {
    const net = opts.network ?? railNetwork();
    this.height = opts.height;
    this.period = servicePeriod(opts.timeOfDay);
    const rng = mulberry32(((opts.seed ?? 1) * 2654435761 + 146) >>> 0);
    let id = 0;
    let fleetNo = Math.floor(rng() * 95);
    for (const line of RAIL_LINES) {
      const a = passengerPlan(net.path(line.id, 0));
      const b = passengerPlan(net.path(line.id, 1));
      const h = 3600 / line.perHour[this.period];
      const n = Math.ceil((a.duration + b.duration + 2 * LAYOVER_MIN) / h);
      const period = n * h;
      const lay = (period - a.duration - b.duration) / 2;
      const clock = rng() * period;
      for (let k = 0; k < n; k++) {
        const six = rng() < line.sixCar[this.period];
        const cars = amConsist(six ? 2 : 1);
        const no = 101 + (fleetNo++ % 95);
        this.units.push({
          id: id++,
          line: line.id,
          name: `${line.code} ${line.name} AM ${no}${six ? `+${101 + (fleetNo++ % 95)}` : ''}`,
          cars,
          length: consistLength(cars),
          a,
          b,
          layA: lay,
          layB: lay,
          period,
          phase0: (clock + k * h) % period,
        });
      }
    }
    // freight: two consists, one at each end, both leaving within FREIGHT_START_WINDOW of the start
    const fa = net.path(LINE_FREIGHT, 0);
    const fb = net.path(LINE_FREIGHT, 1);
    const wait = rng() * FREIGHT_START_WINDOW;
    for (let k = 0; k < 2; k++) {
      const cars = freightConsist(rng, rng() < 0.5 ? 1 : 2, 24 + Math.floor(rng() * 5));
      const L = consistLength(cars);
      // the consist's middle: its rear 5 m from the start of the siding, its front 5 m short of the end
      const a = freightPlan(fa, L / 2 + 5, fa.length - L / 2 - 5);
      const b = freightPlan(fb, L / 2 + 5, fb.length - L / 2 - 5);
      const half = FREIGHT_PERIOD / 2;
      // cycle: run A [0, a), stand [a, half), run B [half, half + b), stand [half + b, period)
      const p0 = (FREIGHT_PERIOD - wait + (k ? half : 0)) % FREIGHT_PERIOD;
      this.units.push({
        id: id++,
        line: LINE_FREIGHT,
        name: `KiwiRail freight DL ${9000 + 2 * Math.floor(rng() * 36)}`,
        cars,
        length: L,
        a,
        b,
        layA: half - a.duration,
        layB: half - b.duration,
        period: FREIGHT_PERIOD,
        phase0: p0,
      });
    }
  }

  /** Where unit `u` is at sim time `t`. */
  state(u: TrainUnit, t: number, out: UnitState): UnitState {
    let ph = (u.phase0 + t) % u.period;
    if (ph < 0) ph += u.period;
    let plan: TripPlan;
    let tau: number;
    if (ph < u.a.duration + u.layA) {
      plan = u.a;
      tau = ph;
    } else {
      plan = u.b;
      tau = ph - u.a.duration - u.layA;
    }
    planAt(plan, tau, _ps);
    out.path = plan.path;
    out.s = _ps.s;
    out.v = _ps.v;
    pointAt(plan.path, _ps.s, _pa);
    out.x = _pa.x;
    out.z = _pa.z;
    return out;
  }

  /** Track level (m) under a point: the rail top, or the causeway over water. */
  railY(x: number, z: number): number {
    return Math.max(this.height(x, z) + RAIL_TOP, RAIL_CAUSEWAY_Y);
  }

  /**
   * The cars of a consist whose middle is at `st` (from state()): each car's middle, heading and pitch
   * on the chord between its bogies, and whether it is underground. Fills `out` (grown as needed).
   */
  cars(u: TrainUnit, st: UnitState, out: CarPose[]): CarPose[] {
    const front = st.s + u.length / 2;
    const p = st.path;
    for (let i = 0; i < u.cars.length; i++) {
      const c = u.cars[i];
      const sc = front - c.offset;
      const hb = CAR_LENGTH[c.kind] * 0.36; // bogie centres
      pointAt(p, sc + hb, _pa);
      pointAt(p, sc - hb, _pb);
      const ya = this.railY(_pa.x, _pa.z);
      const yb = this.railY(_pb.x, _pb.z);
      const dx = _pa.x - _pb.x;
      const dz = _pa.z - _pb.z;
      const pose = (out[i] ??= { kind: c.kind, x: 0, y: 0, z: 0, heading: 0, pitch: 0, hidden: false, tint: 0 });
      pose.kind = c.kind;
      pose.x = (_pa.x + _pb.x) / 2;
      pose.z = (_pa.z + _pb.z) / 2;
      pose.y = (ya + yb) / 2;
      const hd = Math.atan2(dx, -dz);
      pose.heading = c.flip ? hd + Math.PI : hd;
      const pitch = Math.atan2(ya - yb, Math.hypot(dx, dz) || 1);
      pose.pitch = c.flip ? -pitch : pitch;
      pose.hidden = inTunnel(p, sc);
      pose.tint = c.tint;
    }
    out.length = u.cars.length;
    return out;
  }

  /** Record a destroyed train: it stays where it stopped (`cars`, copied), the timetable skips it. */
  wreck(unit: number, cars: readonly CarPose[]): void {
    if (this.wrecks.has(unit)) return;
    this.wrecks.set(unit, { unit, cars: cars.map((c) => ({ ...c })) });
  }

  isWrecked(unit: number): boolean {
    return this.wrecks.has(unit);
  }
}
