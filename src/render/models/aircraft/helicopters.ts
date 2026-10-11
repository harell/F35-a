/**
 * Civil helicopters (#144, reworked): the real helicopters over Auckland, neutral traffic between the helipads
 * (sim/civil/heli.ts, missions/runtime/helicopters.ts). One shared airframe, a modern twin-engine medium
 * helicopter (AW169 proportions), code-built and painted by vertex colour, in two paint schemes matched to photos:
 *  - aw169 (rescue): Northern Rescue's red and yellow, as on Westpac Rescue 2 ZK-IZB (Leonardo, 2021) and
 *    Northland's 2025 AW169 (NZ Herald): red body and boom, yellow belly, sponsons, cowling, fin tip and
 *    stabiliser, a black anti-glare nose; five blades, wheels in sponsons, a rescue hoist. Flown as Westpac Rescue 1
 *    (ZK-HLH), Westpac Rescue 2 (ZK-IZB) and Northland Rescue (ZK-HTQ).
 *  - bell429 (police): the NZ Police Eagle as photographed in 2021 (Nathan Jones, CC BY-SA 4.0): navy all over, a
 *    faint dark chequer behind the cabin, POLICE 1 in white, one red-and-white blade tip; four blades, skids, a
 *    FLIR ball under the nose and the Nightsun searchlight under the rear fuselage (its beam at night).
 * The Bell 429 is smaller than an AW169: the shared airframe is a deliberate compromise that reads right at game
 * distance.
 *
 * The fuselage is lofted from superellipse rings (flat floor, near-flat cabin sides, a rounded nose with a raked
 * windscreen, the rear fuselage sweeping up into the tail boom). The rings carry an edge at every livery and window
 * height and the loft a station at every window edge, so the paint, applied per triangle, has crisp lines; the
 * windscreen and chin windows are glazing patches lifted off the skin. Ambient occlusion is baked into the vertex
 * colours. The names and registrations are decals (heliDecals): one atlas row per helicopter, drawn instanced by
 * HeliBatch beside the airframe. Model frame: −Z nose, +Y up, origin at the cabin centre, HELI_GEAR_HEIGHT above the
 * wheels / skids.
 */
import { AdditiveBlending, BufferGeometry, Color, ConeGeometry, DoubleSide, Float32BufferAttribute, Mesh, MeshBasicMaterial, PlaneGeometry, Vector3, type Group, type Texture } from 'three';
import { ModelBuilder } from '../ModelBuilder';
import { box, cylinder, cylinderX, cylinderZ, ellipsoid, ensureOutward, finalize, merge, mirrorX, place } from '../geom/core';
import { loftRings, prismX, superRing, type LoftStation } from '../geom/loft';
import { createCanvas } from '../geom/atlas';
import { canvasTexture } from '../materials';
import type { AircraftType } from '../../../core/types';
import type { AircraftPrototype, DriveDef } from './types';
import { HELI_GEAR_HEIGHT, type HeliLiveryId } from '../../../sim/civil/heli';

/** Main and tail rotor speeds (rad/s): slow enough to read as spinning blades at 60 fps. */
const MAIN_RATE = Math.PI * 2 * 4.3;
const TAIL_RATE = Math.PI * 2 * 11;

/** A paint scheme: the airframe's colours (vertex colours, shared by every helicopter of the type). */
interface HeliPaint {
  /** Upper fuselage. */
  top: number;
  /** Lower fuselage and belly, below the break line `stripeY[0]`. */
  belly: number;
  /** A cheat line between `stripeY[0]` and `stripeY[1]` (0 = none). */
  stripe: number;
  stripeY?: [number, number];
  boom: number;
  /** The tail boom's lower half (default `boom`). */
  boomLower?: number;
  fin: number;
  /** The fin's top and the tail rotor gearbox (default `fin`), the horizontal stabiliser (default `fin`). */
  finTip?: number;
  stab?: number;
  /** Engine cowling and mast fairing (default `top`). */
  cowl?: number;
  /** The anti-glare panel over the nose (default `top`). */
  noseTop?: number;
  /** A chequered band along the lower cabin: its two colours, where it runs (z) and its block length (m). */
  check: [number, number] | null;
  checkZ?: [number, number];
  checkBlock?: number;
  blade: number;
  tip: number;
}

interface HeliOptions {
  blades: 4 | 5;
  gear: 'wheels' | 'skids';
  hoist: boolean;
  flir: boolean;
  /** Searchlight under the nose (rescue) or under the rear fuselage (police Nightsun). */
  searchlightAt: 'nose' | 'rear';
}

type HeliType = 'aw169' | 'bell429';

const PAINT: Record<HeliType, HeliPaint> = {
  aw169: {
    top: 0xd5202a,
    belly: 0xf5c400,
    stripe: 0,
    stripeY: [-0.46, -0.38],
    boom: 0xd5202a,
    boomLower: 0xf5c400,
    fin: 0xd5202a,
    finTip: 0xf5c400,
    stab: 0xf5c400,
    cowl: 0xf5c400,
    noseTop: 0x16181b,
    check: null,
    blade: 0x2b2d30,
    tip: 0x2b2d30,
  },
  bell429: {
    top: 0x141b30,
    belly: 0x141b30,
    stripe: 0,
    stripeY: [-0.5, -0.15],
    boom: 0x141b30,
    fin: 0x141b30,
    check: [0x2c3450, 0x0e1324],
    checkZ: [0.5, 2.7],
    checkBlock: 0.22,
    blade: 0x2b2d30,
    tip: 0xd23a2a,
  },
};

const OPTIONS: Record<HeliType, HeliOptions> = {
  aw169: { blades: 5, gear: 'wheels', hoist: true, flir: false, searchlightAt: 'nose' },
  bell429: { blades: 4, gear: 'skids', hoist: false, flir: true, searchlightAt: 'rear' },
};

const GLASS = 0x1d2a35;
const GLASS_EDGE = 0x15181b;
const DARK = 0x1c1e21;
const METAL = 0x7a7e83;
const GREY = 0x3b3f44;
/** The searchlight's lens (model m): under the nose, or under the rear fuselage (police). */
const SEARCHLIGHT: Record<'nose' | 'rear', [number, number, number]> = { nose: [0.55, -0.98, -3.6], rear: [0, -0.15, 3.2] };

/** Fuselage stations: z, half width, bottom y, top y, superellipse exponent. */
const STATIONS: [number, number, number, number, number][] = [
  [-6.3, 0.1, -0.42, -0.22, 2],
  [-6.15, 0.36, -0.58, 0.0, 2.1],
  [-5.9, 0.62, -0.69, 0.2, 2.3],
  [-5.5, 0.84, -0.75, 0.42, 2.6],
  [-5.0, 0.99, -0.78, 0.64, 2.9],
  [-4.45, 1.07, -0.79, 0.83, 3.1],
  [-3.85, 1.11, -0.8, 0.95, 3.3],
  [-3.2, 1.13, -0.8, 1.0, 3.4],
  [-2.4, 1.14, -0.8, 1.02, 3.5],
  [-1.6, 1.14, -0.8, 1.02, 3.5],
  [-0.8, 1.14, -0.8, 1.02, 3.5],
  [0.0, 1.14, -0.8, 1.02, 3.5],
  [0.8, 1.14, -0.8, 1.02, 3.5],
  [1.5, 1.12, -0.78, 1.02, 3.4],
  [2.15, 1.04, -0.68, 1.0, 3.2],
  [2.8, 0.86, -0.42, 0.98, 2.9],
  [3.4, 0.62, -0.08, 0.95, 2.6],
  [4.0, 0.44, 0.2, 0.92, 2.3],
  [4.6, 0.36, 0.34, 0.9, 2.2],
  [6.0, 0.31, 0.42, 0.9, 2.1],
  [7.4, 0.26, 0.48, 0.92, 2.1],
  [8.3, 0.22, 0.52, 0.94, 2],
  [8.75, 0.16, 0.58, 0.9, 2],
];

/** The fuselage surface at z: half width, bottom and top, superellipse exponent (linear between stations). */
function sectionAt(z: number): { w: number; b: number; t: number; n: number } {
  const s = STATIONS;
  if (z <= s[0][0]) return { w: s[0][1], b: s[0][2], t: s[0][3], n: s[0][4] };
  for (let i = 1; i < s.length; i++) {
    if (z <= s[i][0]) {
      const f = (z - s[i - 1][0]) / (s[i][0] - s[i - 1][0]);
      const L = (k: number) => s[i - 1][k] + (s[i][k] - s[i - 1][k]) * f;
      return { w: L(1), b: L(2), t: L(3), n: L(4) };
    }
  }
  const e = s[s.length - 1];
  return { w: e[1], b: e[2], t: e[3], n: e[4] };
}

/** A point of the section at ring angle `a` (0 = right side, π/2 = top). */
function surfacePoint(z: number, a: number, lift = 0): [number, number, number] {
  const s = sectionAt(z);
  const cy = (s.b + s.t) / 2;
  const ry = (s.t - s.b) / 2;
  const c = Math.cos(a);
  const sn = Math.sin(a);
  const ux = Math.sign(c) * Math.pow(Math.abs(c), 2 / s.n);
  const uy = Math.sign(sn) * Math.pow(Math.abs(sn), 2 / s.n);
  // outward (approximate) normal of the superellipse, for decals and glazing lifted off the skin
  const nx = ux / s.w;
  const ny = uy / ry;
  const nl = Math.hypot(nx, ny) || 1;
  return [ux * s.w + (lift * nx) / nl, cy + uy * ry + (lift * ny) / nl, z];
}

/** The ring angle (right side, −π/2..π/2) at which the section at z reaches height y (clamped inside it). */
function angleAtY(z: number, y: number): number {
  const s = sectionAt(z);
  const cy = (s.b + s.t) / 2;
  const ry = (s.t - s.b) / 2;
  const v = Math.max(-0.995, Math.min(0.995, (y - cy) / ry));
  return Math.asin(Math.sign(v) * Math.pow(Math.abs(v), s.n / 2));
}

/** Livery and window heights (model y) the rings carry an edge at, rising with the rear fuselage. */
function breakLevels(L: HeliPaint, z: number): number[] {
  const [s0, s1] = L.stripeY ?? [-0.32, -0.12];
  const rise = z > 1.6 ? (z - 1.6) * 0.32 : 0;
  return [s0 + rise, s1 + rise, WIN_Y[0], WIN_Y[1]];
}
/** Points per ring segment, per side: belly → break 0 → break 1 → sill → window top → roof. */
const SEG = [4, 1, 3, 3, 4];
/** Cabin and cockpit window sill and top. */
const WIN_Y: [number, number] = [0.12, 0.72];
/** Window z edges: cockpit door, sliding door, two rear windows. */
const WINDOWS: [number, number][] = [
  [-3.7, -2.45],
  [-1.95, -0.75],
  [-0.45, 0.55],
  [0.85, 1.65],
];

/** A ring through the break levels (the same point count at every station, so the loft never twists). */
function ring(L: HeliPaint, z: number): number[] {
  const lv = breakLevels(L, z);
  const ang: number[] = [-Math.PI / 2];
  const marks = [-Math.PI / 2];
  let prev = -Math.PI / 2;
  for (const y of lv) {
    const a = Math.max(prev + 0.02, angleAtY(z, y));
    marks.push(a);
    prev = a;
  }
  marks.push(Math.max(prev + 0.02, Math.PI / 2));
  for (let k = 0; k < SEG.length; k++) for (let j = 1; j <= SEG[k]; j++) ang.push(marks[k] + ((marks[k + 1] - marks[k]) * j) / SEG[k]);
  // the right side runs −π/2 → π/2; mirror it for the left (π/2 → 3π/2), skipping both poles
  const right = ang.slice(0, -1);
  const all = [...right, Math.PI / 2, ...right.slice(1).reverse().map((a) => Math.PI - a)];
  const out: number[] = [];
  for (const a of all) {
    const [x, y] = surfacePoint(z, a);
    out.push(x, y);
  }
  return out;
}

/** Is a fuselage point a side window? (The windscreen and chin windows are separate glazing patches.) */
function isWindow(x: number, y: number, z: number): boolean {
  if (y < WIN_Y[0] || y > WIN_Y[1] || Math.abs(x) < 0.85) return false;
  return WINDOWS.some(([z0, z1]) => z > z0 && z < z1);
}

/** The livery colour of a fuselage point. */
function paintFuselage(L: HeliPaint, x: number, y: number, z: number): number {
  if (isWindow(x, y, z)) return GLASS;
  if (z > 3.9) return y < sectionAt(z).b + (sectionAt(z).t - sectionAt(z).b) * 0.45 ? (L.boomLower ?? L.boom) : L.boom;
  const [s0, s1] = L.stripeY ?? [-0.32, -0.12];
  const rise = z > 1.6 ? (z - 1.6) * 0.32 : 0;
  // a chequered band along the lower cabin (police): two rows of blocks below the break line
  const [c0, c1] = L.checkZ ?? [-3.9, 2.6];
  if (L.check && z > c0 && z < c1 && y < s1 + rise && y > -0.78 && Math.abs(x) > 0.7) {
    const i = Math.floor((z - c0) / (L.checkBlock ?? 0.5));
    const j = y < s0 + rise ? 0 : 1;
    return (i + j) % 2 === 0 ? L.check[0] : L.check[1];
  }
  if (L.stripe && y > s0 + rise && y < s1 + rise) return L.stripe;
  if (y < s0 + rise) return L.belly;
  if (L.noseTop !== undefined && z < -5.2) return L.noseTop;
  return L.top;
}

/** Recolour a canonical (non-indexed) geometry per triangle from its centroid. */
function paintTriangles(g: BufferGeometry, f: (x: number, y: number, z: number, ny: number) => number): BufferGeometry {
  const p = g.attributes.position.array as Float32Array;
  const n = g.attributes.normal.array as Float32Array;
  const c = g.attributes.color.array as Float32Array;
  const col = new Color();
  for (let t = 0; t < p.length / 9; t++) {
    const o = t * 9;
    const x = (p[o] + p[o + 3] + p[o + 6]) / 3;
    const y = (p[o + 1] + p[o + 4] + p[o + 7]) / 3;
    const z = (p[o + 2] + p[o + 5] + p[o + 8]) / 3;
    col.setHex(f(x, y, z, (n[o + 1] + n[o + 4] + n[o + 7]) / 3));
    for (let k = 0; k < 3; k++) {
      c[o + k * 3] = col.r;
      c[o + k * 3 + 1] = col.g;
      c[o + k * 3 + 2] = col.b;
    }
  }
  g.attributes.color.needsUpdate = true;
  return g;
}

function fuselage(L: HeliPaint): BufferGeometry {
  // stations: the shape's own, every window edge, and ≤ 0.4 m apart through the nose and cabin
  const zs = new Set<number>(STATIONS.map((s) => s[0]));
  for (const [z0, z1] of WINDOWS) zs.add(z0).add(z1);
  const sorted = [...zs].sort((a, b) => a - b);
  const all: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    all.push(sorted[i]);
    const z0 = sorted[i];
    const z1 = sorted[i + 1];
    if (z1 === undefined || z0 >= 3.0) continue;
    const steps = Math.ceil((z1 - z0) / 0.4);
    for (let k = 1; k < steps; k++) all.push(z0 + ((z1 - z0) * k) / steps);
  }
  const g = loftRings(
    all.map((z) => ({ z, ring: ring(L, z) })),
    { capStart: true, capEnd: true },
  );
  return paintTriangles(g, (x, y, z) => paintFuselage(L, x, y, z));
}

/**
 * A patch of the fuselage skin lifted off it by `lift` (glazing): z from z0 to z1, ring angle from a0(z) to a1(z),
 * an nz × na grid, smooth-shaded.
 */
function skinPatch(z0: number, z1: number, a0: (z: number) => number, a1: (z: number) => number, nz: number, na: number, color: number, lift = 0.012): BufferGeometry {
  const pos: number[] = [];
  const P = (i: number, j: number) => {
    const z = z0 + ((z1 - z0) * i) / nz;
    const a = a0(z) + ((a1(z) - a0(z)) * j) / na;
    return surfacePoint(z, a, lift);
  };
  for (let i = 0; i < nz; i++)
    for (let j = 0; j < na; j++) {
      const p00 = P(i, j);
      const p10 = P(i + 1, j);
      const p01 = P(i, j + 1);
      const p11 = P(i + 1, j + 1);
      pos.push(...p00, ...p01, ...p10, ...p10, ...p01, ...p11);
    }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return ensureOutward(finalize(g, color));
}

/** The windscreen (two panes either side of a centre post, the lower edge raking down to the nose) and chin windows. */
function glazing(): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  const lo = (z: number) => -0.08 + (z + 5.8) * 0.26;
  for (const s of [-1, 1]) {
    // right pane: from the raked lower edge up to just short of the centre line
    const a0 = (z: number) => angleAtY(z, lo(z));
    const a1 = () => Math.PI / 2 - 0.07;
    const g = skinPatch(-5.8, -3.8, a0, a1, 8, 6, GLASS);
    out.push(s > 0 ? g : mirrorX(g));
    // chin window
    const c = skinPatch(-5.95, -4.95, (z) => angleAtY(z, -0.62), (z) => angleAtY(z, -0.25), 4, 3, GLASS);
    out.push(s > 0 ? c : mirrorX(c));
  }
  return out;
}

/** The engine cowling ("doghouse") on the roof, with intakes and twin exhausts. */
function cowling(L: HeliPaint): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  const prof: [number, number, number][] = [
    // z, half width, height above the roof
    [-2.9, 0.3, 0.08],
    [-2.45, 0.62, 0.36],
    [-1.6, 0.74, 0.5],
    [0.6, 0.74, 0.54],
    [1.6, 0.66, 0.46],
    [2.5, 0.42, 0.24],
    [3.2, 0.2, 0.06],
  ];
  const st: LoftStation[] = prof.map(([z, w, h]) => {
    const roof = sectionAt(z).t - 0.06;
    return { z, ring: superRing(0, roof + h / 2, w, h / 2 + 0.06, 3.2, 20) };
  });
  out.push(paintTriangles(loftRings(st, { capStart: true, capEnd: true }), (x, y, z) => (z < -2.2 && y < 1.32 && Math.abs(x) > 0.45 ? DARK : (L.cowl ?? L.top))));
  // intake grilles and exhausts each side
  for (const s of [-1, 1]) {
    out.push(place(box(0.04, 0.24, 0.55, DARK), [s * 0.74, 1.27, -1.75]));
    out.push(place(cylinderZ(0.15, 0.17, 0.0, 0.55, 10, GREY), [s * 0.5, 1.33, 1.75], [0.12, s * 0.35, 0]));
    out.push(place(cylinderZ(0.12, 0.12, 0.5, 0.56, 10, 0x0c0c0d), [s * 0.5, 1.33, 1.75], [0.12, s * 0.35, 0]));
  }
  // mast fairing and the swashplate cover
  out.push(place(cylinder(0.32, 0.46, 0.32, 14, L.cowl ?? L.top), [0, 1.6, -0.35]));
  out.push(place(cylinder(0.14, 0.2, 0.3, 10, METAL), [0, 1.86, -0.35]));
  return out;
}

/** Fin, horizontal stabiliser with end plates, ventral fin and tail skid. */
function tail(L: HeliPaint): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  // vertical fin: swept leading edge, a thick root over the boom end; its top (above y 1.95) in the tip colour
  out.push(prismX([[7.55, 0.82], [8.75, 0.82], [9.1, 1.95], [8.6, 1.95]], 0.16, L.fin));
  out.push(prismX([[8.6, 1.95], [9.1, 1.95], [9.25, 2.35], [8.85, 2.42]], 0.16, L.finTip ?? L.fin));
  // the tail rotor gearbox fairing (left side)
  out.push(place(ellipsoid(0.12, 0.2, 0.32, 10, 6, L.finTip ?? L.fin), [-0.1, 1.58, 8.85]));
  // ventral fin and the tail skid
  out.push(prismX([[7.9, 0.62], [8.75, 0.62], [8.95, 0.05], [8.65, 0.02]], 0.1, L.fin));
  out.push(place(cylinderZ(0.03, 0.03, 8.6, 9.05, 6, METAL), [0, 0.05, 0]));
  // horizontal stabiliser at the boom, end plates
  const stab = place(box(1.15, 0.07, 0.62, L.stab ?? L.fin), [0.78, 0.7, 6.65]);
  out.push(stab, mirrorX(stab.clone()));
  for (const s of [-1, 1]) out.push(place(prismX([[6.35, 0.45], [6.95, 0.45], [7.1, 1.05], [6.65, 1.05]], 0.06, L.stab ?? L.fin), [s * 1.37, 0, 0]));
  return out;
}

/** Wheels: nose gear and two mains in sponsons. Skids: two tubes on curved cross tubes with steps. */
function gear(L: HeliPaint, kind: 'wheels' | 'skids', g: number): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  if (kind === 'wheels') {
    // sponsons on the lower rear cabin
    for (const s of [-1, 1]) {
      const sp: LoftStation[] = [
        [0.0, 0.05, 0.06],
        [0.35, 0.26, 0.2],
        [1.1, 0.3, 0.22],
        [2.0, 0.24, 0.17],
        [2.5, 0.06, 0.06],
      ].map(([z, w, h]) => ({ z, ring: superRing(s * (1.0 + w * 0.5), -0.58, w, h, 2.6, 16) }));
      out.push(paintTriangles(loftRings(sp, { capStart: true, capEnd: true }), () => L.belly));
      out.push(place(cylinder(0.05, 0.05, g - 0.95, 6, METAL), [s * 1.2, -0.8 - (g - 0.95) / 2, 1.1]));
      out.push(place(cylinderX(0.3, 0.2, 14, DARK), [s * 1.22, -g + 0.3, 1.1]));
      out.push(place(cylinderX(0.15, 0.22, 10, METAL), [s * 1.22, -g + 0.3, 1.1]));
    }
    out.push(place(cylinder(0.05, 0.05, g - 1.0, 6, METAL), [0, -0.8 - (g - 1.0) / 2, -4.25]));
    for (const s of [-1, 1]) out.push(place(cylinderX(0.2, 0.12, 12, DARK), [s * 0.09, -g + 0.2, -4.25]));
  } else {
    for (const s of [-1, 1]) {
      // the skid tube with an upturned toe
      out.push(place(cylinderZ(0.055, 0.055, -3.6, 1.9, 8, METAL), [s * 1.25, -g + 0.06, 0]));
      out.push(place(cylinderZ(0.04, 0.055, -0.55, 0, 8, METAL), [s * 1.25, -g + 0.06, -3.6], [0.32, 0, 0]));
      // cross tubes: down and out from the belly
      for (const z of [-2.5, 0.9]) {
        const h = g - 0.8;
        out.push(place(cylinder(0.05, 0.05, Math.hypot(h, 0.3), 6, METAL), [s * 1.1, -0.8 - h / 2, z], [0, 0, s * 0.28]));
      }
    }
  }
  return out;
}

/** Main rotor radius and hub, tail rotor radius and hub (left of the fin), model m. */
const ROTOR_R = 6.06;
const HUB = new Vector3(0, 2.02, -0.35);
const TAIL_R = 1.1;
const TAIL_HUB = new Vector3(-0.24, 1.6, 8.9);

/** Main rotor (spinning about +Y through the hub) and the tail rotor (about X). */
function rotors(b: ModelBuilder, L: HeliPaint, blades: number): void {
  const R = ROTOR_R;
  const hub = HUB.clone();
  const parts: BufferGeometry[] = [];
  for (let k = 0; k < blades; k++) {
    const a = (k / blades) * Math.PI * 2;
    const ring = (z: number, chord: number, th: number) => ({ z, ring: superRing(0, 0, chord / 2, th, 2.2, 6, 0) });
    // a blade along +Z from the grip to the tip: taper and a swept, anhedral tip (lofted in the blade's own frame)
    const blade = loftRings(
      [ring(0.55, 0.3, 0.05), ring(1.0, 0.38, 0.045), ring(R - 0.75, 0.38, 0.03), ring(R - 0.25, 0.34, 0.025), ring(R, 0.16, 0.015)],
      { capStart: true, capEnd: true },
    );
    paintTriangles(blade, (_x, _y, z) => (z > R - 0.5 ? L.tip : z > R - 0.75 ? 0xe9e9e6 : L.blade));
    // sweep the tip back (towards −X in the blade frame) and droop it slightly
    const p = blade.attributes.position.array as Float32Array;
    for (let i = 0; i < p.length; i += 3) {
      const t = Math.max(0, (p[i + 2] - (R - 0.6)) / 0.6);
      p[i] -= t * t * 0.18;
      p[i + 1] -= t * 0.03;
    }
    blade.computeVertexNormals();
    // a little pitch, then round the hub
    parts.push(place(blade, [hub.x, hub.y, hub.z], [0, a, 0]));
    // blade grip / cuff
    parts.push(place(box(0.16, 0.12, 0.5, METAL), [hub.x + Math.sin(a) * 0.45, hub.y, hub.z + Math.cos(a) * 0.45], [0, a, 0]));
  }
  parts.push(place(cylinder(0.3, 0.34, 0.2, 14, METAL), [hub.x, hub.y, hub.z]));
  parts.push(place(cylinder(0.12, 0.2, 0.22, 10, GREY), [hub.x, hub.y + 0.2, hub.z]));
  b.addPart('rotor', merge(parts)!, 'paint', hub, new Vector3(0, 1, 0));

  // tail rotor: four blades on the left of the fin
  const tc = TAIL_HUB.clone();
  const tr: BufferGeometry[] = [];
  const TR = TAIL_R;
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    const bl = place(box(0.035, TR, 0.18, L.blade), [tc.x, tc.y + (Math.sin(a) * TR) / 2, tc.z + (Math.cos(a) * TR) / 2], [a, 0, 0]);
    paintTriangles(bl, (_x, y, z) => (Math.hypot(y - tc.y, z - tc.z) > TR - 0.22 ? L.tip : L.blade));
    tr.push(bl);
  }
  tr.push(place(cylinderX(0.1, 0.12, 10, METAL), [tc.x, tc.y, tc.z]));
  b.addPart('tailrotor', merge(tr)!, 'paint', tc, new Vector3(1, 0, 0));
}

/** Small kit: the hoist, a FLIR ball, the searchlight, antennas, steps, pitot tubes, lights. */
function kit(o: HeliOptions): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  if (o.hoist) {
    // the rescue hoist over the right cabin door: a boom from the roof and its drum
    out.push(place(box(0.1, 0.1, 0.9, GREY), [0.98, 1.05, -1.25]));
    out.push(place(cylinderZ(0.16, 0.16, -1.15, -0.55, 12, 0xd8d8d4), [1.32, 1.02, 0]));
    out.push(place(box(0.42, 0.08, 0.12, GREY), [1.12, 1.05, -0.85]));
  }
  if (o.flir) {
    out.push(place(cylinder(0.07, 0.07, 0.12, 8, GREY), [0, -0.78, -5.05]));
    out.push(place(ellipsoid(0.17, 0.17, 0.17, 12, 8, 0x2b2e33), [0, -0.95, -5.05]));
    out.push(place(box(0.16, 0.11, 0.04, GLASS), [0, -0.95, -5.22]));
  }
  const at = SEARCHLIGHT[o.searchlightAt];
  if (o.searchlightAt === 'rear') out.push(place(cylinder(0.05, 0.05, 0.3, 6, GREY), [0, 0.05, at[2]]));
  out.push(place(cylinderZ(0.16, 0.2, -0.25, 0.1, 12, GREY), at, [0.5, 0, 0]));
  out.push(place(cylinderZ(0.15, 0.15, -0.27, -0.25, 12, 0xf3f0e0), at, [0.5, 0, 0]));
  // pitot tubes, a whip and two blade antennas, the belly beacon
  for (const s of [-1, 1]) out.push(place(cylinderZ(0.02, 0.02, -6.55, -6.0, 5, METAL), [s * 0.32, 0.05, 0]));
  out.push(place(box(0.03, 0.3, 0.18, DARK), [0, 1.16, 1.9], [-0.3, 0, 0]));
  out.push(place(box(0.03, 0.22, 0.16, DARK), [0, -0.92, 0.3], [0.3, 0, 0]));
  out.push(place(ellipsoid(0.07, 0.05, 0.1, 8, 4, 0xd0242b), [0, -0.84, 1.5]));
  out.push(place(ellipsoid(0.07, 0.06, 0.1, 8, 4, 0xd0242b), [0, 2.44, 9.0]));
  // nav lights on the stabiliser end plates: red left, green right
  out.push(place(ellipsoid(0.05, 0.05, 0.08, 6, 4, 0xe02020), [-1.4, 1.07, 6.85]));
  out.push(place(ellipsoid(0.05, 0.05, 0.08, 6, 4, 0x20d050), [1.4, 1.07, 6.85]));
  // door seams and handles (thin dark strips just proud of the skin) on both sides
  for (const s of [-1, 1]) {
    const x = s * 1.145;
    for (const z of [-3.78, -2.38, -2.05, 0.68]) out.push(place(box(0.012, 1.45, 0.025, GLASS_EDGE), [x, 0.05, z]));
    out.push(place(box(0.02, 0.04, 0.2, METAL), [x + s * 0.01, 0.0, -0.4]));
    // the boarding step under the cockpit door (wheeled: skids are the step)
    if (o.gear === 'wheels') out.push(place(box(0.25, 0.04, 0.35, GREY), [s * 1.12, -0.84, -3.1]));
  }
  return out;
}


/* ───────────────────────── decals (branding) ───────────────────────── */

/** What one helicopter carries: its type (paint scheme), the name on its cabin and its registration. */
export interface HeliMarkings {
  type: HeliType;
  name: string;
  reg: string;
}

/** The helicopters flown over Auckland (missions/runtime/helicopters.ts spawns at most one of each). */
export const HELI_LIVERIES: Record<HeliLiveryId, HeliMarkings> = {
  westpac1: { type: 'aw169', name: 'WESTPAC RESCUE', reg: 'ZK-HLH' },
  westpac2: { type: 'aw169', name: 'WESTPAC RESCUE', reg: 'ZK-IZB' },
  northland: { type: 'aw169', name: 'NORTHLAND RESCUE', reg: 'ZK-HTQ' },
  eagle: { type: 'bell429', name: 'POLICE 1', reg: 'ZK-IPB' },
};

/**
 * One text field of a scheme's decals, on both sides: centre (model z, y), size (m), colour, weight, which text.
 * `reg3` is the registration's last three letters (big on the AW169s' cowling).
 */
interface DecalField {
  text: 'name' | 'reg' | 'reg3';
  z: number;
  y: number;
  w: number;
  h: number;
  color: string;
  weight: number;
  italic?: boolean;
}

const DECALS: Record<HeliType, DecalField[]> = {
  aw169: [
    { text: 'name', z: -0.6, y: -0.03, w: 3.0, h: 0.26, color: '#f4f4f0', weight: 900, italic: true },
    { text: 'reg3', z: 0.2, y: 1.3, w: 1.0, h: 0.3, color: '#9a1218', weight: 900 },
  ],
  bell429: [
    { text: 'name', z: -1.0, y: 0.84, w: 2.3, h: 0.26, color: '#f4f4f0', weight: 900 },
    { text: 'reg', z: 8.35, y: 1.3, w: 0.95, h: 0.2, color: '#f4f4f0', weight: 700 },
  ],
};

/** The scheme's helicopters, in atlas-row order. */
function members(type: HeliType): HeliLiveryId[] {
  return (Object.keys(HELI_LIVERIES) as HeliLiveryId[]).filter((id) => HELI_LIVERIES[id].type === type);
}

export interface HeliDecals {
  /** Every field's quads on both sides, in the model frame; uv over one atlas row. */
  geometry: BufferGeometry;
  /** The atlas: one row per helicopter of the type (null without a canvas: node tests). */
  texture: Texture | null;
  rows: number;
  /** The atlas row of a helicopter (0 for an unknown one). */
  row(id: HeliLiveryId | undefined): number;
}

const decalCache = new Map<HeliType, HeliDecals>();

/** A type's name and registration decals (built once, cached). */
export function heliDecals(type: AircraftType): HeliDecals | null {
  if (type !== 'aw169' && type !== 'bell429') return null;
  const hit = decalCache.get(type);
  if (hit) return hit;
  const fields = DECALS[type];
  const ids = members(type);
  // each field gets a slice of the row as wide as its aspect ratio, so the text is drawn undistorted
  const aspect = fields.map((f) => f.w / f.h);
  const total = aspect.reduce((a, b) => a + b, 0);
  const W = 2048;
  const rowH = Math.round(W / total);
  const parts: BufferGeometry[] = [];
  let u0 = 0;
  for (let k = 0; k < fields.length; k++) {
    const f = fields[k];
    const du = aspect[k] / total;
    // on the skin at the field's height: the cabin side curves in towards the roof; the cowling's side is flat
    const x = f.text === 'reg3' ? 0.75 : f.z > 3.9 ? 0.085 : surfacePoint(f.z, angleAtY(f.z, f.y))[0];
    for (const s of [-1, 1]) {
      const q = new PlaneGeometry(f.w, f.h);
      const uv = q.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setX(i, u0 + uv.getX(i) * du);
      // a plane faces +Z: turned to face out of the side it is on, its text reads left to right from there
      q.rotateY((s * Math.PI) / 2);
      q.translate(s * (x + 0.008), f.y, f.z);
      parts.push(q.toNonIndexed());
    }
    u0 += du;
  }
  const geometry = merge(parts)!;
  geometry.computeBoundingSphere();
  const c = createCanvas(W, rowH * ids.length);
  let texture: Texture | null = null;
  if (c) {
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    ids.forEach((id, r) => {
      const L = HELI_LIVERIES[id];
      let x0 = 0;
      fields.forEach((f, k) => {
        const zw = (aspect[k] / total) * W;
        const text = f.text === 'name' ? L.name : f.text === 'reg' ? L.reg : L.reg.slice(3);
        let size = rowH * 0.86;
        const font = (px: number) => `${f.italic ? 'italic ' : ''}${f.weight} ${px}px "Helvetica Neue", Arial, sans-serif`;
        g.font = font(size);
        const tw = g.measureText(text).width;
        if (tw > zw * 0.96) size *= (zw * 0.96) / tw;
        g.font = font(size);
        g.fillStyle = f.color;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(text, x0 + zw / 2, r * rowH + rowH / 2);
        x0 += zw;
      });
    });
    texture = canvasTexture(c);
    if (texture) texture.anisotropy = 4;
  }
  const out: HeliDecals = { geometry, texture, rows: ids.length, row: (id) => Math.max(0, id ? ids.indexOf(id) : 0) };
  decalCache.set(type, out);
  return out;
}

/* ───────────────────────── build ───────────────────────── */

function buildHelicopter(type: HeliType): AircraftPrototype {
  const P = PAINT[type];
  const o = OPTIONS[type];
  const g = HELI_GEAR_HEIGHT[type];
  // one paint material for everything (the colours are vertex colours): one draw call per mesh
  const b = new ModelBuilder(() => 'munition');
  b.add(fuselage(P), 'paint');
  for (const geo of [...glazing(), ...cowling(P), ...tail(P), ...gear(P, o.gear, g), ...kit(o)]) b.add(geo, 'paint');
  rotors(b, P, o.blades);
  const drives: DriveDef[] = [
    { part: 'rotor', kind: 'radome', side: 0, max: MAIN_RATE },
    { part: 'tailrotor', kind: 'radome', side: 0, max: TAIL_RATE },
  ];
  b.ao = { rays: 24, maxDist: 1.2, strength: 0.75, floor: 0.35, skipParts: ['rotor', 'tailrotor'] };
  // LOD1 keeps the airframe; its rotors are the blurred discs below
  b.excludeFromLod1('rotor', 'tailrotor');
  const built = b.build();
  addRotorDiscs(built.lod1, o.blades);
  if (type === 'bell429') addSearchlight(built.lod0, built.lod1, SEARCHLIGHT.rear);
  return { type, lod0: built.lod0, lod1: built.lod1, drives, slots: [], fixedStores: [], triangles: built.triangles, instanced: true };
}

let discMat: MeshBasicMaterial | null = null;
let beamMat: MeshBasicMaterial | null = null;

/** LOD1: the spinning rotors as faint discs (a blur), the main one and the tail one. */
function addRotorDiscs(lod1: Group, blades: number): void {
  discMat ??= new MeshBasicMaterial({ color: 0x22252a, transparent: true, opacity: 0.2, depthWrite: false, side: DoubleSide });
  const top = merge([
    place(cylinder(ROTOR_R, ROTOR_R, 0.01, 16 + blades, 0xffffff), [HUB.x, HUB.y, HUB.z]),
    place(cylinder(TAIL_R, TAIL_R, 0.01, 10, 0xffffff), [TAIL_HUB.x, TAIL_HUB.y, TAIL_HUB.z], [0, 0, Math.PI / 2]),
  ])!;
  const m = new Mesh(top, discMat);
  m.name = 'rotor-disc';
  lod1.add(m);
}

/**
 * The Eagle's Nightsun searchlight: a faint additive cone from the lens under the rear fuselage, forward and down
 * (≈ 35°), 140 m long. Shown only at night (objects named `night:*`), in both LODs; HeliBatch instances it.
 */
function addSearchlight(lod0: Group, lod1: Group, at: [number, number, number]): void {
  beamMat ??= new MeshBasicMaterial({ color: 0xfff4d8, transparent: true, opacity: 0.14, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, toneMapped: false });
  const len = 140;
  const geo = new ConeGeometry(len * Math.tan(4 * (Math.PI / 180)), len, 12, 1, true);
  // apex at the lens: the cone's tip is +Y; move it so the tip sits at the origin, then aim it forward-down
  geo.translate(0, -len / 2, 0);
  for (const g of [lod0, lod1]) {
    const m = new Mesh(geo, beamMat);
    m.name = 'night:searchlight';
    m.position.set(at[0], at[1] - 0.25, at[2]);
    // −Y (the cone's axis after the shift) rotated towards −Z by 55° from straight down
    m.rotation.set(-(55 * Math.PI) / 180, 0, 0);
    m.visible = false;
    g.add(m);
  }
}

export const buildAW169 = (): AircraftPrototype => buildHelicopter('aw169');
export const buildBell429 = (): AircraftPrototype => buildHelicopter('bell429');

/** The civil helicopter types. */
export const HELICOPTER_TYPES: readonly AircraftType[] = ['aw169', 'bell429'];
