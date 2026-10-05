/**
 * JS replica of the terrain shader's procedural urban grid (terrainShader.ts: district(),
 * urbanPattern()): Voronoi districts with their own street orientation, 105 × 76 m blocks split into
 * 4 × 2 lots. Float32 arithmetic is emulated so 3D houses / towers land on the same lots (and get
 * the same roof colours) the shader paints from altitude. Node-safe.
 */
import type { CbdStreets } from './cbdStreets';
import { aucklandRoads, aucklandRoadsVersion, ROAD_ARTERIAL, type RoadData } from './aucklandRoads';

const f32 = Math.fround;
const K = f32(0.1031);
const C33 = f32(33.33);

function fract(x: number): number {
  return x - Math.floor(x);
}

/** GLSL hash12 (Dave Hoskins) with float32 rounding. */
export function hash12(x: number, y: number): number {
  const p0 = fract(f32(f32(x) * K));
  const p1 = fract(f32(f32(y) * K));
  const p2 = p0;
  const d = f32(f32(f32(p0 * f32(p1 + C33)) + f32(p1 * f32(p2 + C33))) + f32(p2 * f32(p0 + C33)));
  const q0 = f32(p0 + d);
  const q1 = f32(p1 + d);
  const q2 = f32(p2 + d);
  return fract(f32(f32(q0 + q1) * q2));
}

export const DISTRICT_SIZE = 1300;
export const BLOCK_W = 105;
export const BLOCK_D = 76;
export const LOTS_X = 6;
export const LOTS_Z = 2;
export const ROAD_HALF = 3.5;

export interface District {
  /** Inside the CBD region with real (LINZ) streets: no procedural blocks or lots (cbdStreets.ts). */
  real: boolean;
  cx: number;
  cz: number;
  hash: number;
  /** Rotation (rad): local = R·(world − centre). */
  angle: number;
  cos: number;
  sin: number;
  /** Distance to the district border (m). */
  border: number;
}

/**
 * The CBD's streets. With `streets` (the LINZ street map, cbdStreets.ts) the CBD region uses
 * Auckland's real streets and the region border acts as a district border for the procedural grid
 * outside it (terrain shader: uStreets / uStreetRect). Without it (no LINZ road data) a fixed street
 * grid overrides the Voronoi districts inside a circle (one grid roughly aligned with Queen Street):
 * `hash` sets the grid angle (hash · 6.2831 rad, like the shader) and seeds the block / lot hashes.
 * Must match the terrain shader's uCbd uniform.
 */
export interface CbdGrid {
  x: number;
  z: number;
  radius: number;
  hash: number;
  streets?: CbdStreets | null;
}

/** Voronoi district containing (x, z) (matches GLSL urbanDistrict() / district() and urbanPattern()). */
export function districtAt(x: number, z: number, size = DISTRICT_SIZE, out?: District, cbd?: CbdGrid | null): District {
  if (cbd?.streets && size === DISTRICT_SIZE) {
    const reg = cbd.streets.regionSD(x, z);
    if (reg > 0) {
      const o = out ?? ({} as District);
      o.real = true;
      o.cx = o.cz = o.hash = o.angle = o.sin = 0;
      o.cos = 1;
      o.border = reg;
      return o;
    }
    const o = districtAt(x, z, size, out, null);
    o.border = Math.min(o.border, -reg);
    return o;
  }
  if (cbd && size === DISTRICT_SIZE) {
    const r = Math.hypot(x - cbd.x, z - cbd.z);
    if (r < cbd.radius) {
      const o = out ?? ({} as District);
      o.real = false;
      o.cx = cbd.x;
      o.cz = cbd.z;
      o.hash = f32(cbd.hash);
      o.angle = f32(o.hash * 6.2831);
      o.cos = Math.cos(o.angle);
      o.sin = Math.sin(o.angle);
      o.border = cbd.radius - r;
      return o;
    }
    const o = districtAt(x, z, size, out, null);
    o.border = Math.min(o.border, r - cbd.radius);
    return o;
  }
  const gx = Math.floor(x / size);
  const gz = Math.floor(z / size);
  let b1 = 1e30;
  let b2 = 1e30;
  let cx = 0;
  let cz = 0;
  let h = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const ccx = gx + i;
      const ccz = gz + j;
      const px = (ccx + 0.2 + 0.6 * hash12(ccx, ccz)) * size;
      const pz = (ccz + 0.2 + 0.6 * hash12(ccx + 31.7, ccz + 31.7)) * size;
      const dx = x - px;
      const dz = z - pz;
      const d = dx * dx + dz * dz;
      if (d < b1) {
        b2 = b1;
        b1 = d;
        cx = px;
        cz = pz;
        h = hash12(ccx + 7.3, ccz + 7.3);
      } else if (d < b2) b2 = d;
    }
  }
  const ov = size === DISTRICT_SIZE ? overrideAngle(cx, cz, size) : -1;
  const angle = ov >= 0 ? ov : f32(h * 6.2831);
  const o = out ?? ({} as District);
  o.real = false;
  o.cx = cx;
  o.cz = cz;
  o.hash = h;
  o.angle = angle;
  o.cos = Math.cos(angle);
  o.sin = Math.sin(angle);
  o.border = 0.5 * (Math.sqrt(b2) - Math.sqrt(b1));
  return o;
}

/**
 * Districts that an arterial runs through turn their street grid to the road: the grid's side
 * streets then meet it square, and the blocks behind its frontage lots (frontage.ts) run along it instead of
 * being cut across by it. One override per 1300 m cell of the jittered Voronoi grid, from the arterials' length
 * and direction inside the district (the dominant direction modulo 90°, since a grid is the same turned by a
 * right angle). Shared with the terrain shader (uDistAngles: an RGBA8 texel per cell, angle in R + G · 256 as
 * 1/65536 of a turn, A = 255 when set).
 */
export interface DistrictAngles {
  /** Cell index of texel (0, 0) and the texels across / down. */
  i0: number;
  j0: number;
  cols: number;
  rows: number;
  data: Uint8Array;
}

/** Arterial length (m) a district needs inside it before its grid turns to the road. */
export const ALIGN_MIN_LENGTH = 350;
/** How much of that length must agree on one direction (modulo 90°): 1 = all of it. */
export const ALIGN_MIN_AGREEMENT = 0.45;

/** Winning cell of the jittered Voronoi grid at (x, z) (as district()), without any override. */
function voronoiCell(x: number, z: number, size: number): [number, number] {
  const gx = Math.floor(x / size);
  const gz = Math.floor(z / size);
  let b1 = 1e30;
  let ci = 0;
  let cj = 0;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const ccx = gx + i;
      const ccz = gz + j;
      const dx = x - (ccx + 0.2 + 0.6 * hash12(ccx, ccz)) * size;
      const dz = z - (ccz + 0.2 + 0.6 * hash12(ccx + 31.7, ccz + 31.7)) * size;
      const d = dx * dx + dz * dz;
      if (d < b1) {
        b1 = d;
        ci = ccx;
        cj = ccz;
      }
    }
  return [ci, cj];
}

/** The grid angle overrides of the arterials in `d` (null when no district has one). */
export function computeDistrictAngles(d: RoadData): DistrictAngles | null {
  const acc = new Map<number, [number, number, number]>();
  const key = (i: number, j: number) => (i + 4096) * 8192 + (j + 4096);
  for (const l of d.lines) {
    if (l.kind !== ROAD_ARTERIAL || l.tunnel) continue;
    const p = l.pts;
    for (let k = 0; k + 3 < p.length; k += 2) {
      const dx = p[k + 2] - p[k];
      const dz = p[k + 3] - p[k + 1];
      const len = Math.hypot(dx, dz);
      if (len < 1e-3) continue;
      const a4 = Math.atan2(dz, dx) * 4;
      const n = Math.ceil(len / 20);
      for (let m = 0; m < n; m++) {
        const t = (m + 0.5) / n;
        const [i, j] = voronoiCell(p[k] + dx * t, p[k + 1] + dz * t, DISTRICT_SIZE);
        const q = key(i, j);
        let a = acc.get(q);
        if (!a) acc.set(q, (a = [0, 0, 0]));
        a[0] += Math.cos(a4) * (len / n);
        a[1] += Math.sin(a4) * (len / n);
        a[2] += len / n;
      }
    }
  }
  const set: [number, number, number][] = [];
  for (const [q, [c, s, t]] of acc) {
    if (t < ALIGN_MIN_LENGTH || Math.hypot(c, s) < ALIGN_MIN_AGREEMENT * t) continue;
    const turn = (((Math.atan2(s, c) / 4) / (2 * Math.PI)) % 1 + 1) % 1;
    set.push([Math.floor(q / 8192) - 4096, (q % 8192) - 4096, Math.round(turn * 65536) % 65536]);
  }
  if (!set.length) return null;
  const i0 = Math.min(...set.map((v) => v[0]));
  const j0 = Math.min(...set.map((v) => v[1]));
  const cols = Math.max(...set.map((v) => v[0])) - i0 + 1;
  const rows = Math.max(...set.map((v) => v[1])) - j0 + 1;
  const data = new Uint8Array(cols * rows * 4);
  for (const [i, j, v] of set) {
    const o = ((j - j0) * cols + (i - i0)) * 4;
    data[o] = v & 255;
    data[o + 1] = v >> 8;
    data[o + 3] = 255;
  }
  return { i0, j0, cols, rows, data };
}

let angleCache: { version: number; angles: DistrictAngles | null } = { version: -1, angles: null };

/** The grid angle overrides of the installed LINZ road data (null without it: the hand-traced fallback keeps the hashed angles). */
export function districtAngles(): DistrictAngles | null {
  const v = aucklandRoadsVersion();
  if (angleCache.version !== v) {
    const d = aucklandRoads();
    angleCache = { version: v, angles: d ? computeDistrictAngles(d) : null };
  }
  return angleCache.angles;
}

/** Overridden grid angle (rad, float32 as the shader computes it) of the district centred at (cx, cz), or −1. */
function overrideAngle(cx: number, cz: number, size: number): number {
  const a = districtAngles();
  if (!a) return -1;
  // the centre lies inside its own cell (jitter 0.2–0.8)
  const i = Math.floor(cx / size) - a.i0;
  const j = Math.floor(cz / size) - a.j0;
  if (i < 0 || j < 0 || i >= a.cols || j >= a.rows) return -1;
  const o = (j * a.cols + i) * 4;
  if (a.data[o + 3] !== 255) return -1;
  return f32(f32((a.data[o] + a.data[o + 1] * 256) / 65536) * f32(6.2831853));
}

/** World → district-local (GLSL: p = rot2(a) · (wp − centre), rot2 = mat2(c, −s, s, c)). */
export function toLocal(d: District, x: number, z: number): [number, number] {
  const vx = x - d.cx;
  const vz = z - d.cz;
  return [d.cos * vx + d.sin * vz, -d.sin * vx + d.cos * vz];
}

/** District-local → world. */
export function toWorld(d: District, px: number, pz: number): [number, number] {
  return [d.cx + d.cos * px - d.sin * pz, d.cz + d.sin * px + d.cos * pz];
}

/** Block hash (parks when ≥ 0.94 − 0.06·dens). */
export function blockHash(d: District, bx: number, bz: number): number {
  return hash12(bx + d.hash * 91, bz + d.hash * 91);
}

/** Lot hash (built when < 0.8 + 0.2·dens; roof palette index / footprint via fract(lh·k)). */
export function lotHash(d: District, lx: number, lz: number): number {
  return hash12(lx + 17 + d.hash * 13, lz + 17 + d.hash * 13);
}

/** Lot inset fractions [across, along] for a density (matches the shader). */
export function lotInset(dens: number): [number, number] {
  return [0.17 + (0.06 - 0.17) * dens, 0.28 + (0.08 - 0.28) * dens];
}
