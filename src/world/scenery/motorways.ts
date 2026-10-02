/**
 * Auckland's motorway network as road ribbons: SH1 over the Harbour Bridge, along the western edge
 * of the CBD into the Central Motorway Junction ("Spaghetti Junction") and south through Newmarket
 * to Manukau; SH16 west along the harbour (Waterview, the Te Atatū causeway, Westgate) and east down
 * Grafton Gully to the port; SH20 from Waterview over the Māngere Bridge; SH18 over the upper
 * harbour; SH1 up the North Shore to Albany; plus the main arterials.
 *
 * The geometry comes from the LINZ road centrelines (aucklandRoads.ts: one line per carriageway and
 * ramp, the Waterview tunnel bores flagged) when they are installed. The hand-traced polylines below
 * (from memory, ~100 m – 2 km off) are the fallback when that data is unavailable.
 *
 * The railway lines (NIMT, Western, Eastern, Onehunga, …) come from the same LINZ file (kind
 * ROAD_RAIL); they have no hand-traced fallback.
 *
 * `RoadNetwork` holds the polylines, answers "is this point on a road or a railway?" (so houses,
 * trees and towers keep off the carriageway and the tracks) and builds textured ribbon meshes
 * (terrain-following, raised onto causeways / bridge decks over water) plus lamp posts for the night
 * lights.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import { geoToWorld } from '../../core/auckland';
import { aucklandRoads, ROAD_ARTERIAL, ROAD_MOTORWAY, ROAD_RAIL, ROAD_STREET, type RoadData, type RoadLine } from './aucklandRoads';
import { frameFromHeading, type GeometryBuilder } from './GeometryBuilder';
import type { HeightFn, LightList } from './builders';

export interface MotorwayDef {
  name: string;
  /** Carriageway width (m, both directions). */
  width: number;
  /** [lat, lon] points; a negative lat marks a tunnel portal-to-portal stretch start with `tunnel`. */
  ll: [number, number][];
  /** Indices of points after which the road runs in a tunnel until the next point. */
  tunnels?: number[];
}

export const HAND_MOTORWAYS: MotorwayDef[] = [
  {
    name: 'SH1 North Shore',
    width: 30,
    ll: [
      [-36.82724, 174.74786], [-36.8215, 174.7476], [-36.8160, 174.7462], [-36.8105, 174.7452], [-36.8045, 174.7468], [-36.7985, 174.7515],
      [-36.7935, 174.7545], [-36.7875, 174.7525], [-36.7800, 174.7478], [-36.7715, 174.7425], [-36.7630, 174.7380], [-36.7530, 174.7320],
      [-36.7430, 174.7255], [-36.7330, 174.7185], [-36.7220, 174.7110], [-36.7090, 174.7060], [-36.6950, 174.7040],
    ],
  },
  {
    name: 'SH1 CBD',
    width: 34,
    ll: [
      [-36.83536, 174.74254], [-36.8405, 174.7459], [-36.8430, 174.7489], [-36.8452, 174.7508], [-36.8482, 174.7524], [-36.8515, 174.7538],
      [-36.8545, 174.7555], [-36.8570, 174.7580], [-36.8590, 174.7608],
    ],
  },
  {
    name: 'SH1 Southern',
    width: 32,
    ll: [
      [-36.8590, 174.7608], [-36.8612, 174.7650], [-36.8640, 174.7700], [-36.8672, 174.7752], [-36.8712, 174.7790], [-36.8765, 174.7815],
      [-36.8830, 174.7862], [-36.8895, 174.7935], [-36.8955, 174.8015], [-36.9025, 174.8090], [-36.9110, 174.8170], [-36.9215, 174.8255],
      [-36.9320, 174.8310], [-36.9430, 174.8360], [-36.9555, 174.8420], [-36.9690, 174.8500], [-36.9830, 174.8605], [-36.9960, 174.8720],
      [-37.0100, 174.8860], [-37.0260, 174.8980],
    ],
  },
  {
    name: 'SH16 Northwestern',
    width: 30,
    ll: [
      [-36.8590, 174.7608], [-36.8605, 174.7560], [-36.8622, 174.7505], [-36.8638, 174.7440], [-36.8650, 174.7370], [-36.8662, 174.7290],
      [-36.8672, 174.7215], [-36.8685, 174.7140], [-36.8700, 174.7060], [-36.8715, 174.6989], [-36.8672, 174.6920], [-36.8620, 174.6860],
      [-36.8575, 174.6790], [-36.8538, 174.6715], [-36.8502, 174.6640], [-36.8468, 174.6560], [-36.8438, 174.6470], [-36.8412, 174.6380],
      [-36.8390, 174.6290], [-36.8360, 174.6200], [-36.8300, 174.6120], [-36.8220, 174.6065], [-36.8120, 174.6030], [-36.8010, 174.6000],
      [-36.7886, 174.5964], [-36.7750, 174.5920],
    ],
  },
  {
    name: 'SH16 Grafton Gully',
    width: 24,
    ll: [[-36.8590, 174.7608], [-36.8578, 174.7650], [-36.8560, 174.7690], [-36.8535, 174.7722], [-36.8505, 174.7748], [-36.8478, 174.7772], [-36.8462, 174.7805]],
  },
  {
    name: 'SH20 Southwestern',
    width: 28,
    ll: [
      [-36.8715, 174.6989], [-36.8760, 174.7000], [-36.8830, 174.7030], [-36.8900, 174.7070], [-36.8975, 174.7120], [-36.9045, 174.7180],
      [-36.9110, 174.7260], [-36.9160, 174.7360], [-36.9195, 174.7470], [-36.9220, 174.7580], [-36.9245, 174.7680], [-36.9290, 174.7780],
      [-36.9350, 174.7840], [-36.9420, 174.7880], [-36.9500, 174.7920], [-36.9590, 174.7980], [-36.9680, 174.8060], [-36.9770, 174.8160],
      [-36.9850, 174.8290], [-36.9920, 174.8440], [-36.9980, 174.8600], [-37.0060, 174.8750],
    ],
    tunnels: [0, 1, 2],
  },
  {
    name: 'SH18 Upper Harbour',
    width: 24,
    ll: [
      [-36.7430, 174.7255], [-36.7470, 174.7140], [-36.7530, 174.7020], [-36.7610, 174.6900], [-36.7690, 174.6780], [-36.7760, 174.6660],
      [-36.7830, 174.6550], [-36.7900, 174.6440], [-36.7960, 174.6320], [-36.8010, 174.6200], [-36.8050, 174.6080], [-36.8080, 174.6020],
    ],
  },
];

/**
 * Main arterial roads (4-lane urban roads with street lights). They give the suburbs a real road
 * network from altitude instead of lines painted along every procedural district border.
 * Hand-traced from memory (~100-200 m accuracy), all on land.
 */
export const HAND_ARTERIALS: MotorwayDef[] = [
  { name: 'Dominion Rd', width: 15, ll: [[-36.8655, 174.7572], [-36.8760, 174.7532], [-36.8860, 174.7488], [-36.8960, 174.7448], [-36.9060, 174.7415], [-36.9150, 174.7390]] },
  { name: 'Mt Eden Rd', width: 14, ll: [[-36.8660, 174.7625], [-36.8760, 174.7612], [-36.8860, 174.7600], [-36.8960, 174.7605], [-36.9040, 174.7615]] },
  { name: 'Manukau Rd', width: 15, ll: [[-36.8705, 174.7775], [-36.8800, 174.7768], [-36.8900, 174.7760], [-36.9000, 174.7752], [-36.9095, 174.7742]] },
  { name: 'Remuera Rd', width: 14, ll: [[-36.8705, 174.7795], [-36.8740, 174.7880], [-36.8770, 174.7970], [-36.8790, 174.8060], [-36.8800, 174.8150]] },
  { name: 'Sandringham Rd', width: 13, ll: [[-36.8690, 174.7440], [-36.8780, 174.7405], [-36.8870, 174.7370], [-36.8960, 174.7330]] },
  { name: 'New North Rd', width: 14, ll: [[-36.8650, 174.7520], [-36.8710, 174.7430], [-36.8770, 174.7320], [-36.8830, 174.7210], [-36.8880, 174.7100], [-36.8920, 174.7000]] },
  { name: 'Great North Rd', width: 15, ll: [[-36.8590, 174.7505], [-36.8625, 174.7420], [-36.8650, 174.7330], [-36.8670, 174.7240], [-36.8690, 174.7150], [-36.8745, 174.7060], [-36.8810, 174.6980], [-36.8870, 174.6910]] },
  { name: 'Lake Rd', width: 14, ll: [[-36.8285, 174.7962], [-36.8200, 174.7962], [-36.8110, 174.7905], [-36.8020, 174.7845], [-36.7940, 174.7788], [-36.7880, 174.7740]] },
  { name: 'Onewa Rd', width: 14, ll: [[-36.8091, 174.7468], [-36.8104, 174.7390], [-36.8110, 174.7315], [-36.8106, 174.7240]] },
  { name: 'East Coast Rd', width: 13, ll: [[-36.7860, 174.7738], [-36.7770, 174.7728], [-36.7680, 174.7650], [-36.7580, 174.7530], [-36.7480, 174.7450]] },
];

export interface RoadPath {
  name: string;
  kind: 'motorway' | 'arterial' | 'rail';
  /** Ribbon width (m): both carriageways (hand-traced) or one carriageway (LINZ); a railway's formation. */
  width: number;
  /**
   * Texture span across the ribbon: 1 = both directions, 0.5 = one carriageway (edge line to median).
   * Railways: 1 = double track, 0.5 = single track.
   */
  span: number;
  /** Resampled points (world m), with per-point tunnel flag. */
  x: Float32Array;
  z: Float32Array;
  tunnel: Uint8Array;
}

const SAMPLE = 30;

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Smooth (Catmull-Rom) and resample a polyline every ~SAMPLE m. */
export function resamplePath(pts: { x: number; z: number }[], tunnels: number[] = []): { x: number[]; z: number[]; tunnel: number[] } {
  const xs: number[] = [];
  const zs: number[] = [];
  const tn: number[] = [];
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(n - 1, i + 2)];
    const len = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const steps = Math.max(1, Math.round(len / SAMPLE));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      xs.push(catmull(p0.x, p1.x, p2.x, p3.x, t));
      zs.push(catmull(p0.z, p1.z, p2.z, p3.z, t));
      tn.push(tunnels.includes(i) ? 1 : 0);
    }
  }
  xs.push(pts[n - 1].x);
  zs.push(pts[n - 1].z);
  tn.push(0);
  return { x: xs, z: zs, tunnel: tn };
}

/** Motorways plus (by default) the main arterial roads: LINZ centrelines when installed, else hand-traced. */
export function aucklandRoadPaths(arterials = true): RoadPath[] {
  const linz = aucklandRoads();
  return linz ? linzRoadPaths(linz, arterials) : handRoadPaths(arterials);
}

/** The hand-traced fallback (no LINZ road data). */
export function handRoadPaths(arterials = true): RoadPath[] {
  const defs: [MotorwayDef, RoadPath['kind']][] = HAND_MOTORWAYS.map((m) => [m, 'motorway']);
  if (arterials) for (const m of HAND_ARTERIALS) defs.push([m, 'arterial']);
  return defs.map(([m, kind]) => {
    const r = resamplePath(
      m.ll.map(([lat, lon]) => geoToWorld(lat, lon)),
      m.tunnels,
    );
    return { name: m.name, kind, width: m.width, span: 1, x: Float32Array.from(r.x), z: Float32Array.from(r.z), tunnel: Uint8Array.from(r.tunnel) };
  });
}

/**
 * LINZ motorway carriageways (one ribbon each, half the motorway texture) and arterials. Real
 * vertices are kept (no smoothing: the data already follows the curves), long segments split to
 * ≤ SAMPLE m so the ribbons follow the terrain.
 */
export function linzRoadPaths(d: RoadData, arterials = true): RoadPath[] {
  const out: RoadPath[] = [];
  for (const l of d.lines) {
    if (l.kind === ROAD_STREET || l.kind === ROAD_RAIL || (l.kind === ROAD_ARTERIAL && !arterials)) continue;
    const motorway = l.kind === ROAD_MOTORWAY;
    out.push(linzPath(l, motorway ? 'motorway' : 'arterial', motorway ? 0.5 : 1));
  }
  return out;
}

/** Width (m) above which a LINZ railway line is a double track (the bake writes 6 m single, 11 m multiple). */
const DOUBLE_TRACK = 8;

/** The LINZ railway lines (none without the LINZ road data: there is no hand-traced fallback). */
export function aucklandRailPaths(d: RoadData | null = aucklandRoads()): RoadPath[] {
  if (!d) return [];
  return d.lines.filter((l) => l.kind === ROAD_RAIL).map((l) => linzPath(l, 'rail', l.width > DOUBLE_TRACK ? 1 : 0.5));
}

/** Ground height (m) below which a railway is over water (the ribbons' "wet" test). */
const WET = 0.6;
/**
 * Top of a railway formation over water (m above sea level): Auckland's railways cross water only on
 * low causeways and short bridges (the Eastern Line over Hobson Bay and the Ōrākei Basin), never on
 * motorway-height viaducts.
 */
export const RAIL_CAUSEWAY_Y = 1.8;
/** A railway stretch over water deeper than this (m)… */
const RAIL_SEA_DEPTH = -4;
/** …or longer than this (m) runs where the land model has sea: it is not drawn. */
const RAIL_SEA_LENGTH = 800;

/**
 * Clip the railways to the land model: drop every stretch over open sea (deeper than RAIL_SEA_DEPTH
 * or longer than RAIL_SEA_LENGTH), splitting the line there. The LINZ lines run to the world's edge,
 * past where the terrain fades out to sea in the far north, and drew kilometres of viaduct over the
 * ocean. Shallow, short crossings (Hobson Bay) stay, as causeways.
 */
export function clipRailToLand(paths: RoadPath[], height: HeightFn): RoadPath[] {
  const out: RoadPath[] = [];
  for (const p of paths) {
    const n = p.x.length;
    const drop = new Uint8Array(n);
    for (let i = 0; i < n; ) {
      if (p.tunnel[i] || height(p.x[i], p.z[i]) >= WET) {
        i++;
        continue;
      }
      // a run of wet points i..j-1, measured from the dry point before it to the dry point after it
      let j = i;
      let deepest = Infinity;
      while (j < n && !p.tunnel[j]) {
        const h = height(p.x[j], p.z[j]);
        if (h >= WET) break;
        deepest = Math.min(deepest, h);
        j++;
      }
      let len = 0;
      for (let k = Math.max(1, i); k <= Math.min(n - 1, j); k++) len += Math.hypot(p.x[k] - p.x[k - 1], p.z[k] - p.z[k - 1]);
      if (deepest < RAIL_SEA_DEPTH || len > RAIL_SEA_LENGTH) drop.fill(1, i, j);
      i = j;
    }
    if (!drop.includes(1)) {
      out.push(p);
      continue;
    }
    for (let i = 0; i < n; ) {
      if (drop[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < n && !drop[j]) j++;
      if (j - i >= 2) out.push({ ...p, x: p.x.slice(i, j), z: p.z.slice(i, j), tunnel: p.tunnel.slice(i, j) });
      i = j;
    }
  }
  return out;
}

function linzPath(l: RoadLine, kind: RoadPath['kind'], span: number): RoadPath {
  const xs: number[] = [];
  const zs: number[] = [];
  const p = l.pts;
  for (let i = 0; i < p.length; i += 2) {
    if (i > 0) {
      const n = Math.ceil(Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]) / SAMPLE);
      for (let k = 1; k < n; k++) {
        xs.push(p[i - 2] + ((p[i] - p[i - 2]) * k) / n);
        zs.push(p[i - 1] + ((p[i + 1] - p[i - 1]) * k) / n);
      }
    }
    xs.push(p[i]);
    zs.push(p[i + 1]);
  }
  return {
    name: l.name,
    kind,
    width: l.width,
    span,
    x: Float32Array.from(xs),
    z: Float32Array.from(zs),
    // a tunnel line is a tunnel from end to end (the bake splits the runs at the portals)
    tunnel: new Uint8Array(xs.length).fill(l.tunnel ? 1 : 0),
  };
}

/** Spatially hashed road segments for "is this point on / next to a motorway?" queries. */
export class RoadNetwork {
  private readonly cell = 200;
  private readonly buckets = new Map<number, number[]>();
  /** Flat [ax, az, bx, bz, halfWidth] records. */
  private readonly segs: number[] = [];

  constructor(readonly paths: RoadPath[]) {
    for (const p of paths) {
      for (let i = 0; i + 1 < p.x.length; i++) {
        if (p.tunnel[i]) continue;
        const k = this.segs.length / 5;
        this.segs.push(p.x[i], p.z[i], p.x[i + 1], p.z[i + 1], p.width / 2);
        const r = p.width / 2 + 60;
        const i0 = Math.floor((Math.min(p.x[i], p.x[i + 1]) - r) / this.cell);
        const i1 = Math.floor((Math.max(p.x[i], p.x[i + 1]) + r) / this.cell);
        const j0 = Math.floor((Math.min(p.z[i], p.z[i + 1]) - r) / this.cell);
        const j1 = Math.floor((Math.max(p.z[i], p.z[i + 1]) + r) / this.cell);
        for (let j = j0; j <= j1; j++)
          for (let ii = i0; ii <= i1; ii++) {
            const key = (ii + 2048) * 4096 + (j + 2048);
            let b = this.buckets.get(key);
            if (!b) this.buckets.set(key, (b = []));
            b.push(k);
          }
      }
    }
  }

  /** The ribbon segments outside tunnels, flat [ax, az, bx, bz, halfWidth] records (lotMask.ts). */
  get segments(): readonly number[] {
    return this.segs;
  }

  /** Distance (m) from (x, z) to the nearest carriageway edge (negative on the road); ≤ 60 m range. */
  edgeDistance(x: number, z: number): number {
    const key = (Math.floor(x / this.cell) + 2048) * 4096 + (Math.floor(z / this.cell) + 2048);
    const b = this.buckets.get(key);
    if (!b) return Infinity;
    let best = Infinity;
    const s = this.segs;
    for (const k of b) {
      const o = k * 5;
      const ax = s[o];
      const az = s[o + 1];
      const dx = s[o + 2] - ax;
      const dz = s[o + 3] - az;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(ax + dx * t - x, az + dz * t - z) - s[o + 4];
      if (d < best) best = d;
    }
    return best;
  }

  near(x: number, z: number, margin: number): boolean {
    return this.edgeDistance(x, z) < margin;
  }

  /**
   * Ribbon geometry (position + uv: u across 0..1, v along in 40 m units) following the terrain,
   * raised onto causeways / bridges over water; bridge decks, piers and barriers go into `B`,
   * lamp posts into `lights`. `only` picks the paths (one mesh per texture: roads, railways).
   */
  buildRibbons(height: HeightFn, B: GeometryBuilder, lights: LightList, lamps: boolean, only: (p: RoadPath) => boolean = () => true): BufferGeometry {
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const deckCol = 0x8c8b86;
    const fillCol = 0x77736b;
    for (const p of this.paths) {
      if (!only(p)) continue;
      const n = p.x.length;
      const rail = p.kind === 'rail';
      // Water under the centre line → deck height profile (smoothed ramps). Railways stay low: on the
      // ground, or on a causeway just above the water (RAIL_CAUSEWAY_Y), so no deck.
      const wet = new Float32Array(n);
      for (let i = 0; i < n; i++) wet[i] = height(p.x[i], p.z[i]) < WET ? 1 : 0;
      const deck = new Float32Array(n);
      for (let i = 0; i < n && !rail; i++) {
        let w = 0;
        for (let k = -4; k <= 4; k++) {
          const j = i + k;
          if (j < 0 || j >= n || !wet[j]) continue;
          w = Math.max(w, 1 - Math.abs(k) / 5);
        }
        deck[i] = w;
      }
      let s = 0;
      let run = -1;
      // lamp posts every 60 m alternating sides (one carriageway: every 80 m; arterials: every 120 m),
      // bridge piers every ~60 m (by distance: LINZ vertices are not evenly spaced)
      const lampStep = p.kind === 'arterial' ? 120 : p.span < 1 ? 80 : 60;
      let nextLamp = 0;
      let lampN = 0;
      let nextPier = 0;
      for (let i = 0; i < n; i++) {
        const i0 = Math.max(0, i - 1);
        const i1 = Math.min(n - 1, i + 1);
        let tx = p.x[i1] - p.x[i0];
        let tz = p.z[i1] - p.z[i0];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl;
        tz /= tl;
        const nx = -tz;
        const nz = tx;
        if (i > 0) s += Math.hypot(p.x[i] - p.x[i - 1], p.z[i] - p.z[i - 1]);
        if (p.tunnel[i] && (i === 0 || p.tunnel[i - 1])) {
          run = -1;
          continue;
        }
        const hw = p.width / 2;
        const deckY = 7 + 5 * Math.min(1, deck[i] * 1.2);
        const base = pos.length / 3;
        for (let k = 0; k < 3; k++) {
          const off = (k - 1) * hw;
          const x = p.x[i] + nx * off;
          const z = p.z[i] + nz * off;
          const g = height(x, z) + 0.45;
          const y = rail ? Math.max(g, RAIL_CAUSEWAY_Y) : deck[i] > 0 ? Math.max(g, g * (1 - deck[i]) + deckY * deck[i]) : g;
          pos.push(x, y, z);
          uv.push((k / 2) * p.span, s / 40);
        }
        if (run >= 0) {
          // counter-clockwise seen from above (the road material is front-side only: the old
          // b-before-a+1 order faced down and every ribbon was culled)
          for (let k = 0; k < 2; k++) {
            const a = run + k;
            const b = base + k;
            idx.push(a, a + 1, b, a + 1, b + 1, b);
          }
        }
        run = base;
        // Railway causeway: an embankment of fill from the sea bed to just under the track
        if (rail && i + 1 < n && (wet[i] || wet[i + 1]) && !p.tunnel[i + 1]) {
          const x2 = p.x[i + 1];
          const z2 = p.z[i + 1];
          const len = Math.hypot(x2 - p.x[i], z2 - p.z[i]);
          const bed = Math.min(0, height(p.x[i], p.z[i]), height(x2, z2)) - 1;
          const f = frameFromHeading((p.x[i] + x2) / 2, bed, (p.z[i] + z2) / 2, Math.atan2(x2 - p.x[i], p.z[i] - z2));
          B.box(f, 0, 0, 0, p.width + 4, RAIL_CAUSEWAY_Y - 0.3 - bed, len + 2, fillCol, fillCol);
        }
        // Bridge / causeway: side barriers and piers every ~60 m over the water
        if (deck[i] > 0.5 && i + 1 < n) {
          const x2 = p.x[i + 1];
          const z2 = p.z[i + 1];
          const y = deckY;
          for (const side of [-1, 1]) {
            const ox = nx * hw * side;
            const oz = nz * hw * side;
            B.beam(frameFromHeading(0, 0, 0, 0), p.x[i] + ox, y - 1.8, p.z[i] + oz, x2 + ox, y - 1.8, z2 + oz, 1.6, deckCol);
          }
          if (s >= nextPier && wet[i]) {
            nextPier = s + 60;
            const f = frameFromHeading(p.x[i], Math.min(0, height(p.x[i], p.z[i])) - 2, p.z[i], Math.atan2(tx, -tz));
            B.box(f, 0, 0, 0, p.width * 0.8, y - 2 - (Math.min(0, height(p.x[i], p.z[i])) - 2), 3, 0xa8a59c, 0xa8a59c);
          }
        }
        if (lamps && p.kind !== 'rail' && s >= nextLamp) {
          nextLamp = s + lampStep;
          const side = lampN++ % 2 === 0 ? 1 : -1;
          const x = p.x[i] + nx * (hw + 1) * side;
          const z = p.z[i] + nz * (hw + 1) * side;
          lights.add(x, height(x, z) * (1 - deck[i]) + deckY * deck[i] + 11, z, 0xffd9a8, 4.5);
        }
      }
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
    g.setIndex(pos.length / 3 > 65535 ? new BufferAttribute(new Uint32Array(idx), 1) : new BufferAttribute(new Uint16Array(idx), 1));
    g.computeBoundingSphere();
    return g;
  }
}
