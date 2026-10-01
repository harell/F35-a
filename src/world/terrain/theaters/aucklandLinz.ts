/**
 * LINZ elevation for the Auckland theatre (real coastline + real terrain heights).
 *
 * src/world/terrain/data/auckland-linz.bin is baked offline by tools/linz/bake.py from Toitū Te Whenua LINZ
 * open data (CC BY 4.0): the mean-high-water coastline of the NZ contour 8 m DEM traced as vector
 * rings, the NZ LiDAR 1 m DEM resampled to the 1024² heightfield grid, and (version 2) a 512² land cover
 * grid (Topo50 native / exotic / scrub polygons) and water depth grid (ENC depth areas of the LINZ charts,
 * moved from chart datum to mean high water). It is one gzip file
 * (≈ 590 kB, emitted by Vite as a content-hashed asset, so browsers may cache it for good) fetched
 * once per page load and decompressed in the browser; the main thread hands the
 * decompressed bytes to the terrain workers, so it is never downloaded twice.
 *
 * Everything that reads it is synchronous (generators, coast mask, tests), so it is loaded up front
 * (`loadAucklandLinz`) and installed with `setAucklandLinz`. When it is missing (offline without a
 * cache, no DecompressionStream) the theatre falls back to the hand-traced procedural Auckland.
 *
 * Format (little-endian): 'AKLZ' | u32 version | f32 coast quantum | f32 height quantum | u32 rings
 * | u32 vertices | u32 grid n | f32 grid extent | u32[rings] ring sizes | i16[2·vertices] x,z
 * | height residuals (planar predictor left + up − upleft, zig-zag; one byte each, 255 = u16 follows).
 * Version 2 appends: u32 aux grid n | u8[aux n²] land cover (class << 3 | cover 0..7) | f32 √depth quantum
 * | √depth residuals (same coder). The aux grid samples the 1024 grid's even positions.
 */
import type { SampleGrid } from '../coastline';
import linzUrl from '../data/auckland-linz.bin?url';

/** Resolved by Vite relative to the bundle (works from the game, the labs and the artifact build). */
export const LINZ_URL: string = linzUrl;

export interface LinzData {
  /** Coastline rings (m, game XZ), flat [x0, z0, x1, z1, ...] each; even–odd: land inside. */
  rings: Float32Array[];
  /** Ring bounding boxes [minX, minZ, maxX, maxZ] per ring. */
  bounds: Float32Array;
  /** Heights (m, ≥ 0; 0 offshore) at Heightfield sample positions of an n × n grid over `extent`. */
  heights: Float32Array;
  n: number;
  extent: number;
  /** Version 2 data (null in a version 1 file): land cover and water depth on an `auxN`² grid over `extent`. */
  cover: Uint8Array | null;
  /** Water depth (m, > 0) below the coastline's mean high water; 0 inland beyond a 2-sample shore margin. */
  depth: Float32Array | null;
  auxN: number;
}

/** Land cover classes (`LinzData.cover` byte >> 3; the low 3 bits are the tree cover share 0..7). */
export const COVER_NONE = 0;
export const COVER_NATIVE = 1; // native bush / forest (Topo50 "native")
export const COVER_EXOTIC = 2; // plantation forest, pines (Topo50 "exotic")
export const COVER_SCRUB = 3; // scrub (Topo50 "scrub")

let current: LinzData | null = null;
let currentBytes: Uint8Array | null = null;
let version = 0;

/** Decoded LINZ data, or null when it has not been (or could not be) loaded. */
export function aucklandLinz(): LinzData | null {
  return current;
}

/** Changes whenever the installed data changes (cache key for derived data). */
export function aucklandLinzVersion(): number {
  return version;
}

/** The decompressed bytes last installed (handed to the terrain workers). */
export function aucklandLinzBytes(): Uint8Array | null {
  return currentBytes;
}

/** Install decompressed bytes (null clears → procedural fallback). Throws on malformed data. */
export function setAucklandLinz(bytes: Uint8Array | null): void {
  current = bytes ? decodeLinz(bytes) : null;
  currentBytes = bytes;
  version++;
}

const GZIP = (b: Uint8Array) => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;

/** Fetch a (usually gzip) binary asset and return the decompressed bytes. Throws on failure. */
export async function fetchMaybeGzip(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let bytes = new Uint8Array(await res.arrayBuffer());
  // The file is gzip; a host that already decoded it (Content-Encoding) hands back the raw bytes.
  if (GZIP(bytes)) {
    if (typeof DecompressionStream === 'undefined') throw new Error('no DecompressionStream');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return bytes;
}

/**
 * Fetch, decompress and install the data. Resolves to false (and leaves the procedural fallback in
 * place) on any failure. Safe to call repeatedly: the first successful load is reused.
 */
export async function loadAucklandLinz(url = LINZ_URL): Promise<boolean> {
  if (current) return true;
  try {
    setAucklandLinz(await fetchMaybeGzip(url));
    return true;
  } catch (err) {
    console.warn('[world] LINZ Auckland data unavailable, using the procedural map', err);
    return false;
  }
}

export function decodeLinz(bytes: Uint8Array): LinzData {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const ver = dv.getUint32(4, true);
  if (magic !== 'AKLZ' || (ver !== 1 && ver !== 2)) throw new Error('bad LINZ data header');
  const cq = dv.getFloat32(8, true);
  const hq = dv.getFloat32(12, true);
  const nRings = dv.getUint32(16, true);
  const nVerts = dv.getUint32(20, true);
  const n = dv.getUint32(24, true);
  const extent = dv.getFloat32(28, true);
  let o = 32;
  const sizes: number[] = [];
  for (let r = 0; r < nRings; r++, o += 4) sizes.push(dv.getUint32(o, true));
  const rings: Float32Array[] = [];
  const bounds = new Float32Array(nRings * 4);
  for (let r = 0; r < nRings; r++) {
    const ring = new Float32Array(sizes[r] * 2);
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let k = 0; k < sizes[r]; k++, o += 4) {
      const x = dv.getInt16(o, true) * cq;
      const z = dv.getInt16(o + 2, true) * cq;
      ring[k * 2] = x;
      ring[k * 2 + 1] = z;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    rings.push(ring);
    bounds.set([minX, minZ, maxX, maxZ], r * 4);
  }
  if (o - 32 - nRings * 4 !== nVerts * 4) throw new Error('bad LINZ data size');
  const q = new Int32Array(n * n);
  o = decodeResiduals(bytes, o, q, n);
  const heights = new Float32Array(n * n);
  for (let k = 0; k < q.length; k++) heights[k] = q[k] * hq;
  let cover: Uint8Array | null = null;
  let depth: Float32Array | null = null;
  let auxN = 0;
  if (ver >= 2) {
    auxN = dv.getUint32(o, true);
    o += 4;
    cover = bytes.slice(o, o + auxN * auxN);
    o += auxN * auxN;
    const sq = dv.getFloat32(o, true);
    o += 4;
    const qd = new Int32Array(auxN * auxN);
    o = decodeResiduals(bytes, o, qd, auxN);
    depth = new Float32Array(auxN * auxN);
    for (let k = 0; k < qd.length; k++) {
      const s = qd[k] * sq;
      depth[k] = s * s;
    }
  }
  if (o !== bytes.length) throw new Error('bad LINZ data size');
  return { rings, bounds, heights, n, extent, cover, depth, auxN };
}

/** Undo the zig-zag residuals of the planar predictor (left + up − upleft) into `q` (n × n); returns the new offset. */
function decodeResiduals(bytes: Uint8Array, o: number, q: Int32Array, n: number): number {
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (o >= bytes.length) throw new Error('bad LINZ data size');
      let z = bytes[o++];
      if (z === 255) {
        z = bytes[o] | (bytes[o + 1] << 8);
        o += 2;
      }
      const r = z & 1 ? -((z + 1) >> 1) : z >> 1;
      let p: number;
      if (i > 0 && j > 0) p = q[k - 1] + q[k - n] - q[k - n - 1];
      else if (i > 0) p = q[k - 1];
      else if (j > 0) p = q[k - n];
      else p = 0;
      q[k] = p + r;
    }
  }
  return o;
}

/** Coast segments (every ring edge — rings never overlap, so every edge separates land and water). */
export function linzCoastSegments(d: LinzData, maxLen = 30): Float32Array {
  const out: number[] = [];
  for (const a of d.rings) {
    const n = a.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = a[i * 2];
      const z0 = a[i * 2 + 1];
      const x1 = a[j * 2];
      const z1 = a[j * 2 + 1];
      const pieces = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / maxLen));
      for (let k = 0; k < pieces; k++) {
        const t0 = k / pieces;
        const t1 = (k + 1) / pieces;
        out.push(x0 + (x1 - x0) * t0, z0 + (z1 - z0) * t0, x0 + (x1 - x0) * t1, z0 + (z1 - z0) * t1);
      }
    }
  }
  return Float32Array.from(out);
}

/**
 * Even–odd land fill of all rings into `labels` (rows [0, rows) of grid `g`): samples inside an odd
 * number of rings get `land`, others are left untouched. Edges are bucketed by row so the cost is
 * O(rows · crossings + edges), not O(rows · vertices).
 */
export function fillLinzLand(d: LinzData, labels: Uint8Array, g: SampleGrid, rows: number, land: number): void {
  const n = g.n;
  const inv = 1 / g.cell;
  const buckets: number[][] = Array.from({ length: rows }, () => []);
  const ex: number[] = [];
  for (const a of d.rings) {
    const m = a.length / 2;
    for (let k = 0; k < m; k++) {
      const b = (k + 1) % m;
      const ax = a[k * 2];
      const az = a[k * 2 + 1];
      const bx = a[b * 2];
      const bz = a[b * 2 + 1];
      if (az === bz) continue;
      const lo = Math.min(az, bz);
      const hi = Math.max(az, bz);
      // rows j with lo ≤ z_j < hi (half-open: a vertex on a row is counted once)
      const j0 = Math.max(0, Math.ceil((lo - g.z0) * inv));
      const j1 = Math.min(rows - 1, Math.ceil((hi - g.z0) * inv) - 1);
      if (j1 < j0) continue;
      const e = ex.length;
      ex.push(ax, az, bx, bz);
      for (let j = j0; j <= j1; j++) buckets[j].push(e);
    }
  }
  const xs: number[] = [];
  for (let j = 0; j < rows; j++) {
    const z = g.z0 + j * g.cell;
    xs.length = 0;
    for (const e of buckets[j]) {
      const ax = ex[e];
      const az = ex[e + 1];
      const bx = ex[e + 2];
      const bz = ex[e + 3];
      if (z < Math.min(az, bz) || z >= Math.max(az, bz)) continue;
      xs.push(ax + ((z - az) / (bz - az)) * (bx - ax));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - g.x0) * inv));
      const i1 = Math.min(n - 1, Math.floor((xs[k + 1] - g.x0) * inv));
      for (let i = i0; i <= i1; i++) labels[j * n + i] = land;
    }
  }
}

/** Even–odd point test against all rings (sparse queries / tests). */
export function linzIsLand(d: LinzData, x: number, z: number): boolean {
  let inside = false;
  for (let r = 0; r < d.rings.length; r++) {
    const b = r * 4;
    if (x < d.bounds[b] || z < d.bounds[b + 1] || x > d.bounds[b + 2] || z > d.bounds[b + 3]) continue;
    const a = d.rings[r];
    const m = a.length / 2;
    for (let i = 0, j = m - 1; i < m; j = i++) {
      const xi = a[i * 2];
      const zi = a[i * 2 + 1];
      const xj = a[j * 2];
      const zj = a[j * 2 + 1];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Bilinear LINZ height (m) at a world point (clamped to the grid). */
export function linzHeight(d: LinzData, x: number, z: number): number {
  const n = d.n;
  const cell = d.extent / n;
  let gx = (x + d.extent / 2) / cell;
  let gz = (z + d.extent / 2) / cell;
  if (gx < 0) gx = 0;
  else if (gx > n - 1.001) gx = n - 1.001;
  if (gz < 0) gz = 0;
  else if (gz > n - 1.001) gz = n - 1.001;
  const ix = gx | 0;
  const iz = gz | 0;
  const fx = gx - ix;
  const fz = gz - iz;
  const h = d.heights;
  const k = iz * n + ix;
  const a = h[k] + (h[k + 1] - h[k]) * fx;
  const b = h[k + n] + (h[k + n + 1] - h[k + n]) * fx;
  return a + (b - a) * fz;
}

/** Aux grid lookup scratch: base index and bilinear fractions (set by `auxCell`). */
let auxK = 0;
let auxFx = 0;
let auxFz = 0;

function auxCell(d: LinzData, x: number, z: number): void {
  const n = d.auxN;
  const cell = d.extent / n;
  let gx = (x + d.extent / 2) / cell;
  let gz = (z + d.extent / 2) / cell;
  gx = gx < 0 ? 0 : gx > n - 1.001 ? n - 1.001 : gx;
  gz = gz < 0 ? 0 : gz > n - 1.001 ? n - 1.001 : gz;
  const ix = gx | 0;
  const iz = gz | 0;
  auxK = iz * n + ix;
  auxFx = gx - ix;
  auxFz = gz - iz;
}

/** Bilinear water depth (m, ≥ 0) at a world point, or null without version 2 data. */
export function linzDepth(d: LinzData, x: number, z: number): number | null {
  const a = d.depth;
  if (!a) return null;
  auxCell(d, x, z);
  const k = auxK;
  const n = d.auxN;
  const t = a[k] + (a[k + 1] - a[k]) * auxFx;
  const b = a[k + n] + (a[k + n + 1] - a[k + n]) * auxFx;
  return t + (b - t) * auxFz;
}

export interface CoverSample {
  /** COVER_* class with the largest interpolated share. */
  cls: number;
  /** Interpolated tree cover share of that class (0..1). */
  cover: number;
}

const share = new Float32Array(4);

/**
 * Land cover at a world point: the four surrounding aux samples' cover shares interpolated per class,
 * so an edge between two samples falls where the polygons' share crosses ½. False without version 2 data.
 */
export function linzCover(d: LinzData, x: number, z: number, out: CoverSample): boolean {
  const c = d.cover;
  if (!c) return false;
  auxCell(d, x, z);
  const k = auxK;
  const n = d.auxN;
  const fx = auxFx;
  const fz = auxFz;
  share.fill(0);
  let v = c[k];
  share[v >> 3] += (1 - fx) * (1 - fz) * (v & 7);
  v = c[k + 1];
  share[v >> 3] += fx * (1 - fz) * (v & 7);
  v = c[k + n];
  share[v >> 3] += (1 - fx) * fz * (v & 7);
  v = c[k + n + 1];
  share[v >> 3] += fx * fz * (v & 7);
  out.cls = COVER_NONE;
  out.cover = 0;
  for (let cls = 1; cls < 4; cls++) {
    if (share[cls] > out.cover) {
      out.cls = cls;
      out.cover = share[cls];
    }
  }
  out.cover /= 7;
  return true;
}
