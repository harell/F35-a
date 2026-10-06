/**
 * The Tāmaki Drive waterfront (The Strand → St Heliers, 8.2 km) as measured by tools/hero/sites/tamaki_drive.py: the
 * shared path, cycleway and footpaths on both sides of the road, the seawall's crest and toe (basalt revetment,
 * stepped concrete or a low beach wall), the railings, 228 lamp poles and 740 trees. Measured from the LINZ 2024
 * Auckland LiDAR (1 m DEM, classified point cloud) and the 7.5 cm aerial (CC BY 4.0) along OpenStreetMap's paths and
 * fences (ODbL); reviewed prototype: tools/hero/examples/tamaki-drive.html. The meshes: tamakiDrive.ts.
 *
 * src/world/scenery/data/tamaki-drive.bin (≈ 12 kB gzip), fetched once next to the other Auckland data; without it the
 * drive is the plain road ribbon it was. Every position ships as WGS84 and becomes game XZ through geoToWorld.
 *
 * Frame: stations every `step` m along the axis (Tāmaki Drive's carriageway, west → east); an offset is across it,
 * negative on the harbour side (north), positive inland. Heights are metres above NZVD2016 (≈ the game's datum).
 *
 * Format (little-endian, gzip): 'AKTD' | u16 version (1) | u16 step (0.1 m) | u16 n | i32 lat0, lon0 (1e-6°) |
 * the axis: seq(Δlat), seq(Δlon) (each the steps between stations, 1e-6°) | per station: seq(level, 0.1 m), the
 * bridge bits (⌈n/8⌉ bytes, MSB first), seq(lo, 0.5 m), seq(hi, 0.5 m) |
 * u16 paths, each: u8 code (kind 0 SP / 1 CY / 2 FW | bit 2 land side | surface << 3: 0 asphalt, 1 concrete, 2 paving),
 *   u16 first station, u16 count, seq(offset), seq(width) (0.1 m) |
 * u16 walls, each: u16 first, u16 count, u8 kind × count (0 rock, 1 concrete, 2 low), seq(crest offset), seq(toe
 *   offset), seq(toe height) (0.1 m) |
 * u16 railings, each: u16 first, u16 count, seq(offset) (0.1 m) |
 * u16 lamps: i16 Δlat × n, i16 Δlon × n (1e-6°, from the axis's start, then from the previous lamp), u8 height
 *   (0.1 m over the ground), i8 arm x, i8 arm z (0.05 m, game metres), u8 ground (0.1 m from −4 m) |
 * u16 trees: i16 Δlat × n, i16 Δlon × n, u8 ground (0.2 m from −2 m), u8 height (0.2 m), u8 crown radius (0.1 m),
 *   u8 palm (bit 7) | crown brightness in the aerial (mean sRGB / 2).
 * seq(): an i16 first value, then an i8 step per value; the step −128 is followed by the value itself as an i16.
 */
import { geoToWorld } from '../../core/auckland';
import { fetchMaybeGzip } from '../terrain/theaters/aucklandLinz';
import tamakiUrl from './data/tamaki-drive.bin?url';

export const TAMAKI_DRIVE_URL: string = tamakiUrl;

export type TdPathKind = 'SP' | 'CY' | 'FW';
export type TdSurface = 'asphalt' | 'concrete' | 'paving';
export const TD_ROCK = 0;
export const TD_CONCRETE = 1;
export const TD_LOW = 2;

/**
 * A path (shared path, cycleway, footpath): its centre's offset and its width per station. Its level is the game's
 * ground, raised to the road's measured level where that is lower (tamakiDrive.ts tamakiGround).
 */
export interface TdPath {
  kind: TdPathKind;
  /** −1 harbour side, 1 land side (of the road). */
  side: -1 | 1;
  surface: TdSurface;
  k0: number;
  o: Float32Array;
  w: Float32Array;
}

/** A stretch of seawall: per station its kind, the crest's and the toe's offsets and the toe's height (the crest is the road's level). */
export interface TdWall {
  k0: number;
  kind: Uint8Array;
  crest: Float32Array;
  toe: Float32Array;
  zt: Float32Array;
}

/** A railing along the crest (OSM fence), its offset per station. */
export interface TdRail {
  k0: number;
  o: Float32Array;
}

export interface TdLamp {
  x: number;
  z: number;
  /** Pole height over the ground (m) and the head's offset from the shaft (game metres). */
  h: number;
  ax: number;
  az: number;
  /** The LiDAR ground (m). */
  g: number;
}

export interface TdTree {
  x: number;
  z: number;
  g: number;
  h: number;
  /** Crown radius (m). */
  r: number;
  palm: boolean;
  /** Crown brightness in the aerial (mean sRGB, 0..255). */
  shade: number;
}

export interface TamakiDrive {
  /** Station spacing (m) and count. */
  step: number;
  n: number;
  /** Station centres (game XZ) and unit normals towards the land (positive offsets). */
  x: Float32Array;
  z: Float32Array;
  nx: Float32Array;
  nz: Float32Array;
  /** The road's ground level (m); 1 where the drive is on a bridge (its level runs between the abutments). */
  level: Float32Array;
  bridge: Uint8Array;
  /** The strip across each station: from the seawall's toe (or 14 m seaward) to 4 m past the land-side path. */
  lo: Float32Array;
  hi: Float32Array;
  paths: TdPath[];
  walls: TdWall[];
  rails: TdRail[];
  lamps: TdLamp[];
  trees: TdTree[];
}

const MAGIC = 'AKTD';
const VERSION = 1;
const KINDS: TdPathKind[] = ['SP', 'CY', 'FW'];
const SURFACES: TdSurface[] = ['asphalt', 'concrete', 'paving'];

let current: TamakiDrive | null = null;
let version = 0;

/** The decoded waterfront, or null when it has not been (or could not be) loaded. */
export function tamakiDrive(): TamakiDrive | null {
  return current;
}

export function tamakiDriveVersion(): number {
  return version;
}

/** Install decompressed bytes (null clears it). Throws on malformed data. */
export function setTamakiDrive(bytes: Uint8Array | null): void {
  current = bytes ? decodeTamakiDrive(bytes) : null;
  index = null;
  version++;
}

export async function loadTamakiDrive(url = TAMAKI_DRIVE_URL): Promise<boolean> {
  if (current) return true;
  try {
    setTamakiDrive(await fetchMaybeGzip(url));
    return true;
  } catch (err) {
    console.warn('[world] Tāmaki Drive waterfront unavailable', err);
    return false;
  }
}

class Reader {
  o = 0;
  readonly dv: DataView;
  constructor(readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  private need(n: number): void {
    if (this.o + n > this.b.length) throw new Error('tamaki drive data truncated');
  }
  u8(): number {
    this.need(1);
    return this.b[this.o++];
  }
  i8(): number {
    this.need(1);
    return this.dv.getInt8(this.o++);
  }
  u16(): number {
    this.need(2);
    const v = this.dv.getUint16(this.o, true);
    this.o += 2;
    return v;
  }
  i16(): number {
    this.need(2);
    const v = this.dv.getInt16(this.o, true);
    this.o += 2;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.dv.getInt32(this.o, true);
    this.o += 4;
    return v;
  }
  /** n integers of a seq() (see the header). */
  seqInt(n: number): Int32Array {
    const out = new Int32Array(n);
    if (n === 0) return out;
    out[0] = this.i16();
    for (let i = 1; i < n; i++) {
      const d = this.i8();
      out[i] = d === -128 ? this.i16() : out[i - 1] + d;
    }
    return out;
  }
  seq(n: number, scale: number): Float32Array {
    const q = this.seqInt(n);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = q[i] / scale;
    return out;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const v = this.b.slice(this.o, this.o + n);
    this.o += n;
    return v;
  }
}

export function decodeTamakiDrive(bytes: Uint8Array): TamakiDrive {
  const r = new Reader(bytes);
  const magic = String.fromCharCode(r.u8(), r.u8(), r.u8(), r.u8());
  if (magic !== MAGIC || r.u16() !== VERSION) throw new Error('bad tamaki drive data header');
  const step = r.u16() / 10;
  const n = r.u16();
  const lat0 = r.i32();
  const lon0 = r.i32();
  const dla = r.seqInt(n - 1);
  const dlo = r.seqInt(n - 1);
  const x = new Float32Array(n);
  const z = new Float32Array(n);
  let la = lat0;
  let lo = lon0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      la += dla[i - 1];
      lo += dlo[i - 1];
    }
    const p = geoToWorld(la / 1e6, lo / 1e6);
    x[i] = p.x;
    z[i] = p.z;
  }
  // normals: the axis's tangent by central differences, turned towards the land (+offset = south of an eastward axis)
  const nx = new Float32Array(n);
  const nz = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    const tx = x[b] - x[a];
    const tz = z[b] - z[a];
    const l = Math.hypot(tx, tz) || 1;
    nx[i] = -tz / l;
    nz[i] = tx / l;
  }
  const level = r.seq(n, 10);
  const bits = r.bytes(Math.ceil(n / 8));
  const bridge = new Uint8Array(n);
  for (let i = 0; i < n; i++) bridge[i] = (bits[i >> 3] >> (7 - (i & 7))) & 1;
  const loA = r.seq(n, 2);
  const hiA = r.seq(n, 2);
  const paths: TdPath[] = [];
  for (let k = r.u16(); k > 0; k--) {
    const code = r.u8();
    const k0 = r.u16();
    const c = r.u16();
    paths.push({ kind: KINDS[code & 3] ?? 'FW', side: code & 4 ? 1 : -1, surface: SURFACES[(code >> 3) & 3] ?? 'asphalt', k0, o: r.seq(c, 10), w: r.seq(c, 10) });
  }
  const walls: TdWall[] = [];
  for (let k = r.u16(); k > 0; k--) {
    const k0 = r.u16();
    const c = r.u16();
    walls.push({ k0, kind: r.bytes(c), crest: r.seq(c, 10), toe: r.seq(c, 10), zt: r.seq(c, 10) });
  }
  const rails: TdRail[] = [];
  for (let k = r.u16(); k > 0; k--) {
    const k0 = r.u16();
    const c = r.u16();
    rails.push({ k0, o: r.seq(c, 10) });
  }
  // lamps and trees: WGS84 steps from the axis's start
  const points = (m: number) => {
    const a = new Int32Array(m);
    const b = new Int32Array(m);
    for (let i = 0; i < m; i++) a[i] = r.i16();
    for (let i = 0; i < m; i++) b[i] = r.i16();
    const out: { x: number; z: number }[] = [];
    let pa = lat0;
    let pb = lon0;
    for (let i = 0; i < m; i++) {
      pa += a[i];
      pb += b[i];
      out.push(geoToWorld(pa / 1e6, pb / 1e6));
    }
    return out;
  };
  const nl = r.u16();
  const lp = points(nl);
  const lh = r.bytes(nl);
  const lax = Array.from({ length: nl }, () => r.i8());
  const laz = Array.from({ length: nl }, () => r.i8());
  const lg = r.bytes(nl);
  const lamps: TdLamp[] = lp.map((p, i) => ({ x: p.x, z: p.z, h: lh[i] / 10, ax: lax[i] / 20, az: laz[i] / 20, g: lg[i] / 10 - 4 }));
  const nt = r.u16();
  const tp = points(nt);
  const tg = r.bytes(nt);
  const th = r.bytes(nt);
  const tr = r.bytes(nt);
  const tf = r.bytes(nt);
  const trees: TdTree[] = tp.map((p, i) => ({ x: p.x, z: p.z, g: tg[i] / 5 - 2, h: th[i] / 5, r: tr[i] / 10, palm: (tf[i] & 0x80) !== 0, shade: (tf[i] & 0x7f) * 2 }));
  if (r.o !== bytes.length) throw new Error('bad tamaki drive data size');
  return { step, n, x, z, nx, nz, level, bridge, lo: loA, hi: hiA, paths, walls, rails, lamps, trees };
}

/* ───────────────────────────── where a point is on the strip ───────────────────────────── */

/** Station buckets (game XZ, BUCKET m) for the nearest-station lookup. */
const BUCKET = 50;
let index: { td: TamakiDrive; cells: Map<number, number[]> } | null = null;

function stations(td: TamakiDrive): Map<number, number[]> {
  if (index?.td === td) return index.cells;
  const cells = new Map<number, number[]>();
  for (let i = 0; i < td.n; i++) {
    const k = (Math.floor(td.x[i] / BUCKET) + 4096) * 8192 + Math.floor(td.z[i] / BUCKET) + 4096;
    const l = cells.get(k);
    if (l) l.push(i);
    else cells.set(k, [i]);
  }
  index = { td, cells };
  return cells;
}

export interface TdPlace {
  /** Fractional station (0 … n − 1) and the offset across the axis (m, + inland). */
  k: number;
  o: number;
}

/** (station, offset) of a point within ~`reach` m of the axis, else null. */
export function tdPlace(td: TamakiDrive, x: number, z: number, reach = 80): TdPlace | null {
  const cells = stations(td);
  const ci = Math.floor(x / BUCKET);
  const cj = Math.floor(z / BUCKET);
  let best = -1;
  let bd = reach * reach;
  const r = Math.ceil(reach / BUCKET);
  for (let j = cj - r; j <= cj + r; j++)
    for (let i = ci - r; i <= ci + r; i++) {
      const l = cells.get((i + 4096) * 8192 + j + 4096);
      if (!l) continue;
      for (const s of l) {
        const d = (td.x[s] - x) ** 2 + (td.z[s] - z) ** 2;
        if (d < bd) {
          bd = d;
          best = s;
        }
      }
    }
  if (best < 0) return null;
  // along: the projection on the segment towards the nearer neighbour
  const nb = best + 1 < td.n && (best === 0 || (td.x[best + 1] - x) ** 2 + (td.z[best + 1] - z) ** 2 < (td.x[best - 1] - x) ** 2 + (td.z[best - 1] - z) ** 2) ? best + 1 : best - 1;
  const a = Math.min(best, nb);
  const b = Math.max(best, nb);
  const dx = td.x[b] - td.x[a];
  const dz = td.z[b] - td.z[a];
  const t = Math.max(0, Math.min(1, ((x - td.x[a]) * dx + (z - td.z[a]) * dz) / (dx * dx + dz * dz || 1)));
  const px = td.x[a] + dx * t;
  const pz = td.z[a] + dz * t;
  let nx = td.nx[a] + (td.nx[b] - td.nx[a]) * t;
  let nz = td.nz[a] + (td.nz[b] - td.nz[a]) * t;
  const nl = Math.hypot(nx, nz) || 1;
  nx /= nl;
  nz /= nl;
  return { k: a + t, o: (x - px) * nx + (z - pz) * nz };
}

/** A per-station value at a fractional station (linear). */
export function tdAt(v: ArrayLike<number>, k: number): number {
  const i = Math.max(0, Math.min(v.length - 1, Math.floor(k)));
  const j = Math.min(v.length - 1, i + 1);
  const t = Math.max(0, Math.min(1, k - i));
  return v[i] + (v[j] - v[i]) * t;
}

/** World point at (station k, offset o) (k an integer station). */
export function tdPoint(td: TamakiDrive, k: number, o: number): [number, number] {
  return [td.x[k] + td.nx[k] * o, td.z[k] + td.nz[k] * o];
}

/**
 * The strip as rings of ~10 stations each (game XZ, flat [x0, z0, x1, z1, …]): small rings rasterise fast where a
 * site mask asks them (aucklandSites.ts siteRings: no procedural grid lots or houses on the waterfront).
 */
export function tamakiDriveRings(td: TamakiDrive | null = current, every = 10): Float32Array[] {
  if (!td) return [];
  const out: Float32Array[] = [];
  for (let k0 = 0; k0 < td.n - 1; k0 += every) {
    const k1 = Math.min(td.n - 1, k0 + every);
    const ring: number[] = [];
    for (let k = k0; k <= k1; k++) ring.push(...tdPoint(td, k, td.lo[k]));
    for (let k = k1; k >= k0; k--) ring.push(...tdPoint(td, k, td.hi[k]));
    out.push(Float32Array.from(ring));
  }
  return out;
}
