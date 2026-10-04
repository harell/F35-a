/**
 * Harbour ferries (render-only, issue #30): the timetable routes out of the Downtown Ferry Terminal and the
 * pure kinematics that place a ferry on them. In wartime nothing here is a sim entity: ferries are not on radar,
 * not targetable, and cost the sim nothing. In free flight the sim sails each one on this timetable as a neutral ship
 * the player can shoot (missions/runtime/shipping.ts).
 *
 * Every route is a loop of docks. At each dock a ferry comes in bow first along the dock's axis, dwells,
 * backs out `back` metres, turns on the spot (catamarans do) and sets off for the next dock along a
 * smoothed path through the route's via points. Moves accelerate and brake (a trapezoid profile). A
 * route runs to a fixed `period`; the slack left after the moves and the minimum dwells is spent at the
 * Downtown terminal. Each route's period divides FERRY_CYCLE, so the whole fleet repeats exactly every
 * FERRY_CYCLE seconds (tests/render-ferries.test.ts checks every hull on water and no two ferries
 * overlapping over that cycle).
 *
 * Downtown: four bow-in slots at the head of the basin between Princes and Queens Wharf (the moored
 * cruise liner lies along Princes Wharf east, so the lanes keep to the east half). Outer docks are the
 * real wharves from OpenStreetMap: Devonport, Stanley Bay, Bayswater, Te Onewa Northcote Point,
 * Birkenhead, Hobsonville Point (Harrier Point Wharf) and West Harbour (Hobsonville Marina). The
 * upper-harbour routes pass under the Harbour Bridge's navigation span. No route goes near Rangitoto,
 * Waiheke or the other enemy-held islands.
 *
 * Positions are world XZ (m); headings are degrees clockwise from north (the bow points along
 * (sin h, -cos h)). Motion is a function of mission time only: deterministic, allocation-free.
 */

import { AKL, BRIDGE_SPAN_T } from '../../core/auckland';

const DEG = Math.PI / 180;

/** Every route period divides this (s): the whole fleet's motion repeats with it. */
export const FERRY_CYCLE = 7200;

export interface FerryDock {
  name: string;
  /** Hull centre when berthed. */
  x: number;
  z: number;
  /** Bow heading when berthed (deg). The ferry comes in along it and backs out against it. */
  heading: number;
  /** Minimum dwell alongside (s). */
  dwell: number;
  /** How far the ferry backs out before it turns (m). */
  back: number;
}

export interface FerryRouteDef {
  id: string;
  name: string;
  /** Loop of docks; dock 0 is the Downtown terminal (where the timetable slack is spent). */
  docks: FerryDock[];
  /** via[i]: path points from docks[i] to docks[i+1] (the last entry leads back to docks[0]). */
  via: [number, number][][];
  /** Timetable period (s), a divisor of FERRY_CYCLE. */
  period: number;
  /** Cruising speed (m/s). */
  speed: number;
  /** Model scale (1 = a 34 m harbour catamaran). */
  scale: number;
  /** Timetable offset of this route's first ferry (s). */
  offset: number;
  /** Ferries on the route at full fleet (FERRY_FLEET), evenly spaced over the period. */
  ferries: number;
}

/** Ferry hull at scale 1 (m): length / beam, for the wake and the water tests. */
export const FERRY_LENGTH = 34;
export const FERRY_BEAM = 10;

const ACCEL = 0.35;
const ASTERN_SPEED = 1.6;
const ASTERN_ACCEL = 0.25;
/** Turning rate on the spot (deg/s) and the shortest turn (s). */
const PIVOT_RATE = 9;
const PIVOT_MIN = 6;
/** The last metres before a dock run straight along its axis. */
const APPROACH = 80;

/**
 * Downtown slots, bow in along the basins' axis (heading 195°): three at the head of the basin between
 * Princes and Queens Wharf (W0–W2, east of the moored liner), two in the basin between Queens and Captain
 * Cook Wharf (E0, E1). Only routes with the same headway share a slot (Hobsonville and West Harbour, half
 * a headway apart): any other pair would sooner or later arrive together.
 * Lanes are 35 m apart; neighbouring slots back out to different depths, so two ferries turning at the
 * same time never swing into each other.
 */
const SLOTS: readonly { x: number; z: number; back: number }[] = [
  { x: 430, z: -735, back: 110 }, // W0
  { x: 395, z: -735, back: 160 }, // W1
  { x: 360, z: -735, back: 110 }, // W2
  { x: 565, z: -650, back: 110 }, // E0
  { x: 600, z: -650, back: 160 }, // E1
];
const W0 = 0;
const W1 = 1;
const W2 = 2;
const E0 = 3;
const E1 = 4;
const downtown = (slot: number, dwell = 45): FerryDock => ({ name: 'Downtown Ferry Terminal', x: SLOTS[slot].x, z: SLOTS[slot].z, heading: 195, dwell, back: SLOTS[slot].back });
/** A point `d` m out of the basin on a slot's axis. */
const axis = (slot: number, d: number): [number, number] => [SLOTS[slot].x + 0.259 * d, SLOTS[slot].z - 0.966 * d];
/** Out of the basin along the slot's lane, and back in lined up on it. */
const basinOut = (slot: number): [number, number][] => [axis(slot, SLOTS[slot].back + 170), axis(slot, SLOTS[slot].back + 370)];
const basinIn = (slot: number): [number, number][] => [axis(slot, 640), axis(slot, 440)];

/**
 * A lane square to the Harbour Bridge through its navigation span (BRIDGE_SPAN_T, between the last two
 * piers), `off` m from the span's centre along the deck (< 0 towards bridge_s), from `from` (+1 the
 * city side, -1 the upper harbour) to the other side.
 */
function bridgeLane(off: number, from: 1 | -1): [number, number][] {
  const S = AKL.bridge_s;
  const N = AKL.bridge_n;
  const len = Math.hypot(N.x - S.x, N.z - S.z);
  const dx = (N.x - S.x) / len;
  const dz = (N.z - S.z) / len;
  const cx = S.x + (N.x - S.x) * BRIDGE_SPAN_T + dx * off;
  const cz = S.z + (N.z - S.z) * BRIDGE_SPAN_T + dz * off;
  // (-dz, dx) points to the city side
  return [
    [cx - dz * 250 * from, cz + dx * 250 * from],
    [cx + dz * 250 * from, cz - dx * 250 * from],
  ];
}
/** Westbound lanes keep to the bridge_s half of the span, eastbound to the bridge_n half; the inner pair is Birkenhead's. */
const BRIDGE_W = bridgeLane(-30, 1);
const BRIDGE_E = bridgeLane(30, -1);
const BRIDGE_W2 = bridgeLane(-70, 1);
const BRIDGE_E2 = bridgeLane(70, -1);

/** `pts` moved `o` m to the left of the direction of travel. */
function shift(pts: [number, number][], o: number): [number, number][] {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // left of (ux, uz) heading: (uz, -ux)
    return [p[0] + ((b[1] - a[1]) / l) * o, p[1] - ((b[0] - a[0]) / l) * o];
  });
}

/**
 * The upper harbour: west along the channel south of Birkenhead and Chelsea, then north past Herald
 * Island. Ferries keep left (westbound on the south side, northbound on the west side), so the lanes never cross.
 */
const UPPER_OUT: [number, number][] = [
  [-2700, -2330],
  [-4600, -2330],
  [-6150, -2380],
  [-6400, -3100],
];
const UPPER_IN: [number, number][] = [
  [-6250, -3100],
  [-5900, -2480],
  [-4600, -2420],
  [-2700, -2420],
];

export const FERRY_ROUTES: readonly FerryRouteDef[] = [
  {
    id: 'devonport',
    name: 'Devonport',
    docks: [downtown(W0), { name: 'Devonport Wharf', x: 2990, z: -1590, heading: 0, dwell: 60, back: 90 }],
    via: [
      [...basinOut(W0), [1450, -1190], [2500, -1330]],
      [[2650, -1400], [1500, -1290], ...basinIn(W0)],
    ],
    period: 900,
    speed: 12,
    scale: 1,
    offset: 450,
    ferries: 3,
  },
  {
    id: 'bayswater',
    name: 'Bayswater',
    docks: [downtown(E0), { name: 'Bayswater Wharf', x: 520, z: -3030, heading: 0, dwell: 50, back: 90 }],
    via: [
      [...basinOut(E0), [640, -1700], [540, -2600]],
      [[680, -2700], [900, -1700], ...basinIn(E0)],
    ],
    period: 900,
    speed: 12,
    scale: 1,
    offset: 300,
    ferries: 3,
  },
  {
    id: 'stanley_bay',
    name: 'Stanley Bay',
    docks: [downtown(E1), { name: 'Stanley Bay Wharf', x: 1669, z: -2213, heading: 32, dwell: 45, back: 80 }],
    via: [
      [...basinOut(E1), [1250, -1650]],
      [[1350, -1900], [1000, -1450], ...basinIn(E1)],
    ],
    period: 900,
    speed: 10,
    scale: 0.8,
    offset: 330,
    ferries: 1,
  },
  {
    id: 'birkenhead',
    name: 'Northcote Point and Birkenhead',
    docks: [
      downtown(W1),
      { name: 'Te Onewa Northcote Point Wharf', x: -1424, z: -2386, heading: 46, dwell: 40, back: 80 },
      { name: 'Birkenhead Wharf', x: -3331, z: -2894, heading: 315, dwell: 50, back: 80 },
    ],
    via: [
      [...basinOut(W1), [-250, -1440], ...BRIDGE_W],
      [[-1800, -2250], [-2900, -2600]],
      [[-2700, -2500], ...BRIDGE_E, [-250, -1560], ...basinIn(W1)],
    ],
    period: 1440,
    speed: 12,
    scale: 0.85,
    offset: 50,
    ferries: 3,
  },
  {
    id: 'hobsonville',
    name: 'Hobsonville Point',
    docks: [downtown(W2), { name: 'Hobsonville Point (Harrier Point Wharf)', x: -7845, z: -6478, heading: 0, dwell: 60, back: 90 }],
    via: [
      [...basinOut(W2), [-250, -1400], ...BRIDGE_W2, ...UPPER_OUT, [-6550, -3600], [-7100, -4600], [-7250, -5400], [-7650, -6000]],
      [[-7550, -6050], [-7100, -5400], [-6900, -4600], [-6500, -3950], ...UPPER_IN, ...BRIDGE_E2, [-250, -1600], ...basinIn(W2)],
    ],
    period: 2400,
    speed: 14,
    scale: 1,
    offset: 30,
    ferries: 3,
  },
  {
    id: 'west_harbour',
    name: 'West Harbour',
    docks: [downtown(W2), { name: 'West Harbour (Hobsonville Marina)', x: -10275, z: -4434, heading: 180, dwell: 60, back: 90 }],
    via: [
      [...basinOut(W2), [-250, -1400], ...BRIDGE_W2, ...shift(UPPER_OUT, 45), [-7000, -3500], [-8500, -4250], [-9800, -4750]],
      [[-9700, -4650], [-8450, -4400], [-6950, -3650], ...shift(UPPER_IN, -45), ...BRIDGE_E2, [-250, -1600], ...basinIn(W2)],
    ],
    period: 2400,
    speed: 14,
    scale: 1,
    offset: 350,
    ferries: 3,
  },
];

/** Fleet in priority order: QualitySettings.ferries takes the first N (one per route first). */
export const FERRY_FLEET: readonly { route: number; k: number }[] = (() => {
  const out: { route: number; k: number }[] = [];
  const max = Math.max(...FERRY_ROUTES.map((r) => r.ferries));
  for (let k = 0; k < max; k++) FERRY_ROUTES.forEach((r, route) => k < r.ferries && out.push({ route, k }));
  return out;
})();

/* ───────────────────────── compiled routes ───────────────────────── */

const enum Seg {
  Dwell,
  Move,
  Pivot,
}

interface Segment {
  kind: Seg;
  t0: number;
  dur: number;
  /** Move: dense path [x0, z0, x1, z1, …] with cumulative length; astern = backing out. */
  pts?: Float32Array;
  cum?: Float32Array;
  len?: number;
  vmax?: number;
  accel?: number;
  astern?: boolean;
  /** Dwell / pivot: position; pivot: from / to heading (rad, the turn already the short way). */
  x?: number;
  z?: number;
  h0?: number;
  h1?: number;
}

export interface FerryRoute {
  def: FerryRouteDef;
  segs: Segment[];
  /** Shortest possible cycle at def.speed (moves, turns and minimum dwells), ≤ def.period. */
  minPeriod: number;
  /** Timetable cruising speed (m/s), ≤ def.speed. */
  speed: number;
  /** Dense forward paths (for the water tests): flat XZ. */
  paths: Float32Array[];
}

export interface FerryState {
  x: number;
  z: number;
  /** Bow heading (rad, clockwise from north). */
  heading: number;
  /** Speed through the water (m/s); < 0 while backing out. */
  speed: number;
  /** Dock index while alongside, else -1. */
  dock: number;
}

const fwdX = (hDeg: number) => Math.sin(hDeg * DEG);
const fwdZ = (hDeg: number) => -Math.cos(hDeg * DEG);

/** Centripetal Catmull-Rom through `p` (open), sampled about every `step` m. */
export function smoothPath(p: [number, number][], step = 6): Float32Array {
  const out: number[] = [];
  const n = p.length;
  const at = (i: number): [number, number] => {
    if (i < 0) return [2 * p[0][0] - p[1][0], 2 * p[0][1] - p[1][1]];
    if (i >= n) return [2 * p[n - 1][0] - p[n - 2][0], 2 * p[n - 1][1] - p[n - 2][1]];
    return p[i];
  };
  for (let i = 0; i < n - 1; i++) {
    const P0 = at(i - 1);
    const P1 = at(i);
    const P2 = at(i + 1);
    const P3 = at(i + 2);
    const tj = (a: [number, number], b: [number, number]) => Math.max(1e-3, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
    const t0 = 0;
    const t1 = t0 + tj(P0, P1);
    const t2 = t1 + tj(P1, P2);
    const t3 = t2 + tj(P2, P3);
    const segs = Math.max(1, Math.ceil(Math.hypot(P2[0] - P1[0], P2[1] - P1[1]) / step));
    for (let k = i === 0 ? 0 : 1; k <= segs; k++) {
      const t = t1 + ((t2 - t1) * k) / segs;
      const c = [0, 1].map((d) => {
        const A1 = ((t1 - t) / (t1 - t0)) * P0[d] + ((t - t0) / (t1 - t0)) * P1[d];
        const A2 = ((t2 - t) / (t2 - t1)) * P1[d] + ((t - t1) / (t2 - t1)) * P2[d];
        const A3 = ((t3 - t) / (t3 - t2)) * P2[d] + ((t - t2) / (t3 - t2)) * P3[d];
        const B1 = ((t2 - t) / (t2 - t0)) * A1 + ((t - t0) / (t2 - t0)) * A2;
        const B2 = ((t3 - t) / (t3 - t1)) * A2 + ((t - t1) / (t3 - t1)) * A3;
        return ((t2 - t) / (t2 - t1)) * B1 + ((t - t1) / (t2 - t1)) * B2;
      });
      out.push(c[0], c[1]);
    }
  }
  return new Float32Array(out);
}

function cumulative(pts: Float32Array): Float32Array {
  const n = pts.length / 2;
  const cum = new Float32Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
  return cum;
}

/** Time (s) to cover `d` m from rest to rest. */
export function moveTime(d: number, vmax: number, a: number): number {
  return d >= (vmax * vmax) / a ? d / vmax + vmax / a : 2 * Math.sqrt(d / a);
}

/** Distance covered and speed `t` s into a rest-to-rest move of `d` m. */
function moveAt(t: number, d: number, vmax: number, a: number, out: { s: number; v: number }): void {
  const T = moveTime(d, vmax, a);
  const v = Math.min(vmax, Math.sqrt(a * d)); // peak speed
  const ta = v / a;
  if (t <= ta) {
    out.s = 0.5 * a * t * t;
    out.v = a * t;
  } else if (t >= T - ta) {
    const r = Math.max(0, T - t);
    out.s = d - 0.5 * a * r * r;
    out.v = a * r;
  } else {
    out.s = 0.5 * a * ta * ta + v * (t - ta);
    out.v = v;
  }
}

/** Heading (rad) of the path direction from (ax, az) to (bx, bz). */
const headingOf = (ax: number, az: number, bx: number, bz: number) => Math.atan2(bx - ax, -(bz - az));

/** Shortest-way target for a turn from h0 to h1 (rad). */
function shortWay(h0: number, h1: number): number {
  let d = (h1 - h0) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return h0 + d;
}

function compileAt(def: FerryRouteDef, speed: number): FerryRoute {
  const segs: Segment[] = [];
  const paths: Float32Array[] = [];
  let t = 0;
  const push = (s: Omit<Segment, 't0'>) => {
    segs.push({ ...s, t0: t });
    t += s.dur;
  };
  const n = def.docks.length;
  for (let i = 0; i < n; i++) {
    const d = def.docks[i];
    const e = def.docks[(i + 1) % n];
    const h = d.heading * DEG;
    // alongside
    push({ kind: Seg.Dwell, dur: d.dwell, x: d.x, z: d.z, h0: h });
    // back out along the axis
    const bx = d.x - fwdX(d.heading) * d.back;
    const bz = d.z - fwdZ(d.heading) * d.back;
    const astern = new Float32Array([d.x, d.z, bx, bz]);
    push({ kind: Seg.Move, dur: moveTime(d.back, ASTERN_SPEED, ASTERN_ACCEL), pts: astern, cum: cumulative(astern), len: d.back, vmax: ASTERN_SPEED, accel: ASTERN_ACCEL, astern: true, h0: h });
    // path to the next dock: off the back-out point, through the via points, straight in along its axis
    const ex = e.x - fwdX(e.heading) * (e.back + APPROACH);
    const ez = e.z - fwdZ(e.heading) * (e.back + APPROACH);
    const ctrl: [number, number][] = [[bx, bz], ...def.via[i], [ex, ez], [e.x - fwdX(e.heading) * e.back, e.z - fwdZ(e.heading) * e.back], [e.x, e.z]];
    const pts = smoothPath(ctrl);
    paths.push(pts);
    const cum = cumulative(pts);
    const len = cum[cum.length - 1];
    // turn on the spot to the path's first direction
    const k = Math.min(4, pts.length / 2 - 1);
    const h1 = shortWay(h, headingOf(pts[0], pts[1], pts[k * 2], pts[k * 2 + 1]));
    push({ kind: Seg.Pivot, dur: Math.max(PIVOT_MIN, Math.abs(h1 - h) / DEG / PIVOT_RATE), x: bx, z: bz, h0: h, h1 });
    push({ kind: Seg.Move, dur: moveTime(len, speed, ACCEL), pts, cum, len, vmax: speed, accel: ACCEL, astern: false });
  }
  // the timetable slack: a longer stop Downtown
  const minPeriod = t;
  segs[0].dur += Math.max(0, def.period - minPeriod);
  let t0 = 0;
  for (const s of segs) {
    s.t0 = t0;
    t0 += s.dur;
  }
  return { def, segs, minPeriod, speed, paths };
}

/**
 * Compiles a route to its timetable: the ferries sail as fast as the period needs (never above
 * def.speed), so the slack is spent under way rather than alongside.
 */
export function compileFerryRoute(def: FerryRouteDef): FerryRoute {
  const full = compileAt(def, def.speed);
  if (full.minPeriod >= def.period) return full;
  let lo = 1;
  let hi = def.speed;
  for (let i = 0; i < 40; i++) {
    const v = (lo + hi) / 2;
    if (compileAt(def, v).minPeriod > def.period) lo = v;
    else hi = v;
  }
  const r = compileAt(def, hi);
  r.minPeriod = full.minPeriod;
  return r;
}

const _mv = { s: 0, v: 0 };

/** Ferry `k` of a route (evenly spaced over the period) at mission time `time`. */
export function ferryAt(r: FerryRoute, k: number, time: number, out: FerryState): FerryState {
  const P = r.def.period;
  const shift = r.def.offset + (k * P) / r.def.ferries;
  let u = (time + shift) % P;
  if (u < 0) u += P;
  const segs = r.segs;
  let i = segs.length - 1;
  while (i > 0 && segs[i].t0 > u) i--;
  const s = segs[i];
  const tau = u - s.t0;
  out.dock = -1;
  switch (s.kind) {
    case Seg.Dwell:
      out.x = s.x!;
      out.z = s.z!;
      out.heading = s.h0!;
      out.speed = 0;
      out.dock = i / 4;
      break;
    case Seg.Pivot: {
      const f = Math.min(1, tau / s.dur);
      const e = f * f * (3 - 2 * f);
      out.x = s.x!;
      out.z = s.z!;
      out.heading = s.h0! + (s.h1! - s.h0!) * e;
      out.speed = 0;
      break;
    }
    case Seg.Move: {
      moveAt(tau, s.len!, s.vmax!, s.accel!, _mv);
      const pts = s.pts!;
      const cum = s.cum!;
      // binary search the dense path
      let lo = 0;
      let hi = cum.length - 1;
      const d = Math.min(_mv.s, s.len!);
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (cum[m] <= d) lo = m;
        else hi = m;
      }
      const seg = cum[hi] - cum[lo];
      const f = seg > 0 ? (d - cum[lo]) / seg : 0;
      const ax = pts[lo * 2];
      const az = pts[lo * 2 + 1];
      const bx = pts[hi * 2];
      const bz = pts[hi * 2 + 1];
      out.x = ax + (bx - ax) * f;
      out.z = az + (bz - az) * f;
      if (s.astern) {
        out.heading = s.h0!;
        out.speed = -_mv.v;
      } else {
        out.heading = headingOf(ax, az, bx, bz);
        out.speed = _mv.v;
      }
      break;
    }
  }
  return out;
}

let compiled: FerryRoute[] | null = null;
/** The compiled routes (built once). */
export function ferryRoutes(): FerryRoute[] {
  return (compiled ??= FERRY_ROUTES.map(compileFerryRoute));
}
