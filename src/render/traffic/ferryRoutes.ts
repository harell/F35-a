/**
 * Harbour ferries (render-only, issue #30): Auckland Transport's harbour ferry routes out of the Downtown
 * Ferry Terminal and the pure kinematics that place a ferry on them. Nothing here is a sim entity, in any
 * mission or mode: ferries are not on radar, not targetable, and cost the sim nothing.
 *
 * The routes are AT's (at.govt.nz timetables, the GTFS feed of 2026-09-17), with their stops in their
 * order: DEV Devonport, BAYS Bayswater, BIRK Te Onewa Northcote Point and Birkenhead, HOBS Hobsonville
 * Point and Beach Haven, WSTH West Harbour. Stanley Bay has no AT service, and the Gulf routes (Waiheke,
 * Rangitoto, Rakino, Half Moon Bay, Pine Harbour, Gulf Harbour) run past or to the enemy-held islands, so
 * they are not here. Each route's headway is its weekday timetable's (peak for DEV and BAYS, about the
 * day's average for BIRK, HOBS and WSTH), and the sailing times are the timetable's: the ferries sail as
 * fast as the period needs, with a long stop at one end.
 *
 * The tracks follow the ferry routes mapped in OpenStreetMap (route=ferry), which keep to the channel:
 * out of the basin north to the middle of the harbour, west under the Harbour Bridge's navigation span,
 * and up the upper harbour along the Birkenhead shore past Kauri Point. AT's GTFS shapes are schematic
 * there (they cross the bridge's low southern spans and Westhaven marina), so they are not used for the
 * tracks. The docks are the ferry berths at the real terminals (OpenStreetMap piers and pontoons), except
 * West Harbour, whose pontoon lies among the marina's finger piers: that ferry stops at the marina's
 * outer breakwater.
 *
 * Every route is a loop of docks. At each dock a ferry comes in bow first along the dock's axis, dwells,
 * backs out `back` metres, turns on the spot (catamarans do) and sets off for the next dock along a
 * smoothed path through the route's via points. Moves accelerate and brake (a trapezoid profile). A
 * route runs to a fixed `period`; the slack left after the moves and the minimum dwells is spent under
 * way. Each route's period divides FERRY_CYCLE, so the whole fleet repeats exactly every FERRY_CYCLE
 * seconds (tests/render-ferries.test.ts checks every hull on water and no two ferries overlapping over
 * that cycle).
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
 * Cook Wharf (E0, E1). Each route has its own slot, so a ferry's long stop Downtown never meets another route's.
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

/**
 * From the Downtown basins to the Harbour Bridge's navigation span (the OSM ferry route): north up the
 * harbour, then west-north-west along the middle of it. Westbound lanes lie `o` m to the south-west of
 * this line and eastbound lanes `o` m to the north-east (left of the direction of travel), as at the bridge.
 */
const BRIDGE_APPROACH: [number, number][] = [
  [520, -1290],
  [430, -1520],
  [300, -1745],
  [-90, -1955],
];
const toBridge = (o: number) => shift(BRIDGE_APPROACH, o);
const fromBridge = (o: number) => shift([...BRIDGE_APPROACH].reverse(), o);

export const FERRY_ROUTES: readonly FerryRouteDef[] = [
  {
    // DEV: every 20 min at peak, 12 min a crossing (Downtown Pier 2 and 4 – Devonport, north berth)
    id: 'devonport',
    name: 'Devonport',
    docks: [downtown(E1, 300), { name: 'Devonport Ferry Terminal', x: 2972, z: -1707, heading: 95, dwell: 660, back: 100 }],
    via: [
      [...basinOut(E1), [800, -1400], [900, -1480], [1720, -1615], [1960, -1622], [2360, -1517], [2560, -1540], [2700, -1610]],
      [[2650, -1665], [2360, -1555], [1960, -1660], [1720, -1655], [900, -1520], [790, -1470], ...basinIn(E1)],
    ],
    period: 2400,
    speed: 12,
    scale: 1,
    offset: 450,
    ferries: 2,
  },
  {
    // BAYS: every 30 min at peak, 10 min a crossing
    id: 'bayswater',
    name: 'Bayswater',
    docks: [downtown(E0, 510), { name: 'Bayswater Ferry Terminal', x: 395, z: -2880, heading: 350, dwell: 90, back: 90 }],
    via: [
      [...basinOut(E0), [640, -1500], [560, -1800], [470, -2150], [470, -2500]],
      [[520, -2550], [540, -2150], [640, -1800], [690, -1500], ...basinIn(E0)],
    ],
    period: 1800,
    speed: 12,
    scale: 0.85,
    offset: 300,
    ferries: 1,
  },
  {
    // BIRK: about every 40 min; Downtown – Te Onewa Northcote Point 10 min – Birkenhead 3 min, back direct 15 min
    id: 'birkenhead',
    name: 'Northcote Point and Birkenhead',
    docks: [
      downtown(W0, 600),
      { name: 'Te Onewa Northcote Point Wharf', x: -1424, z: -2386, heading: 46, dwell: 60, back: 80 },
      { name: 'Birkenhead Ferry Terminal', x: -2505, z: -2803, heading: 330, dwell: 60, back: 80 },
    ],
    via: [
      [...basinOut(W0), ...toBridge(20), ...BRIDGE_W],
      [
        [-1700, -2480],
        [-2100, -2640],
        [-2330, -2650],
      ],
      [[-2400, -2600], [-1900, -2380], ...BRIDGE_E, ...fromBridge(20), ...basinIn(W0)],
    ],
    period: 2400,
    speed: 12,
    scale: 0.85,
    offset: 50,
    ferries: 1,
  },
  {
    // HOBS: hourly; Downtown – Hobsonville Point 30 min – Beach Haven 5 min – Hobsonville Point – Downtown
    id: 'hobsonville',
    name: 'Hobsonville Point and Beach Haven',
    docks: [
      downtown(W1, 2820),
      { name: 'Hobsonville Point Ferry Terminal', x: -7980, z: -6756, heading: 270, dwell: 60, back: 90 },
      { name: 'Beach Haven Ferry Terminal', x: -7497, z: -6509, heading: 90, dwell: 60, back: 90 },
      { name: 'Hobsonville Point Ferry Terminal', x: -7980, z: -6756, heading: 270, dwell: 60, back: 90 },
    ],
    via: [
      [...basinOut(W1), ...toBridge(60), ...BRIDGE_W2, ...UPPER_OUT, [-6550, -3600], [-7030, -4550], [-7280, -5400], [-7480, -6100], [-7640, -6500]],
      [[-7760, -6650]],
      [[-7700, -6600]],
      [[-7700, -6560], [-7520, -6250], [-7300, -5400], [-6980, -4550], [-6500, -3950], ...UPPER_IN, ...BRIDGE_E2, ...fromBridge(60), ...basinIn(W1)],
    ],
    period: 7200,
    speed: 14,
    scale: 1,
    offset: 30,
    ferries: 2,
  },
  {
    // WSTH: hourly over the day (every 20–25 min at peak), 35 min a crossing
    id: 'west_harbour',
    name: 'West Harbour',
    docks: [downtown(W2, 2940), { name: 'West Harbour (Hobsonville Marina)', x: -10275, z: -4434, heading: 180, dwell: 60, back: 90 }],
    via: [
      [
        ...basinOut(W2),
        ...toBridge(60),
        ...BRIDGE_W2,
        ...shift(UPPER_OUT, 45),
        [-6500, -3420],
        [-6740, -3530],
        [-7260, -3605],
        [-7890, -3575],
        [-8300, -3680],
        [-9020, -4290],
        [-9420, -4520],
        [-9900, -4600],
      ],
      [
        [-9800, -4520],
        [-9380, -4570],
        [-9000, -4350],
        [-8250, -3750],
        [-7890, -3660],
        [-7260, -3695],
        [-6720, -3620],
        [-6480, -3480],
        ...shift(UPPER_IN, -45),
        ...BRIDGE_E2,
        ...fromBridge(60),
        ...basinIn(W2),
      ],
    ],
    period: 7200,
    speed: 14,
    scale: 1,
    offset: 1830,
    ferries: 2,
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
