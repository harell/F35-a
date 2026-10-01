/**
 * Real 2048² terrain detail for the Auckland theatre (high quality tier only).
 *
 * src/world/terrain/data/auckland-linz-hd.bin is baked by tools/linz/bake.py next to auckland-linz.bin:
 * the NZ LiDAR 1 m DEM sampled at the 2048² Heightfield positions (43 m), stored as the residual over
 * the Catmull-Rom upsample of the 1024² grid (what generate.ts's upsample2x reconstructs). With it the
 * high tier's 2048 heightfield is the real terrain instead of upsample + procedural noise.
 *
 * ≈ 1.2 MB gzip, so it is a separate Vite asset fetched only when the high tier asks for it
 * (Environment → `loadAucklandLinzHd`); low / medium never request it, and the service worker never
 * precaches it (public/sw.js ON_DEMAND). It is only read on the main thread (finishTerrain), so it
 * is not handed to the terrain workers.
 *
 * Format (little-endian): 'AKLH' | u32 version | f32 height quantum | u32 grid n | f32 grid extent
 * | u32 base n | u32 FNV-1a of the base grid's quantised heights (i32) | residuals (zig-zag, one byte
 * each, 255 = u16 follows). The hash ties the file to the 1024 grid it was baked against: a stale
 * pair is rejected rather than adding residuals to the wrong terrain.
 */
import type { LinzData } from './aucklandLinz';
import { fetchMaybeGzip } from './aucklandLinz';
import linzHdUrl from '../data/auckland-linz-hd.bin?url';

/** Resolved by Vite relative to the bundle. Importing the URL downloads nothing. */
export const LINZ_HD_URL: string = linzHdUrl;

export interface LinzHdData {
  /** Residual in height quanta (real − upsampled base) at the n × n Heightfield sample positions. */
  residual: Int16Array;
  /** Height quantum (m). */
  quantum: number;
  n: number;
  extent: number;
  /** Base grid size the residual applies to (n / 2). */
  baseN: number;
  /** FNV-1a of the base grid's quantised heights. */
  baseHash: number;
}

let current: LinzHdData | null = null;

/** Decoded HD detail, or null when it has not been (or could not be) loaded. */
export function aucklandLinzHd(): LinzHdData | null {
  return current;
}

/** Install decompressed bytes (null clears). Throws on malformed data. */
export function setAucklandLinzHd(bytes: Uint8Array | null): void {
  current = bytes ? decodeLinzHd(bytes) : null;
}

let pending: Promise<boolean> | null = null;

/**
 * Fetch, decompress and install the HD detail. Resolves to false on any failure (the high tier then
 * keeps the procedural detail). Concurrent and repeated calls share the first load.
 */
export function loadAucklandLinzHd(url = LINZ_HD_URL): Promise<boolean> {
  if (current) return Promise.resolve(true);
  if (!pending) {
    pending = fetchMaybeGzip(url)
      .then((bytes) => {
        setAucklandLinzHd(bytes);
        return true;
      })
      .catch((err) => {
        console.warn('[world] LINZ HD terrain unavailable, using procedural detail', err);
        return false;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

export function decodeLinzHd(bytes: Uint8Array): LinzHdData {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== 'AKLH' || dv.getUint32(4, true) !== 1) throw new Error('bad LINZ HD header');
  const quantum = dv.getFloat32(8, true);
  const n = dv.getUint32(12, true);
  const extent = dv.getFloat32(16, true);
  const baseN = dv.getUint32(20, true);
  const baseHash = dv.getUint32(24, true);
  const residual = new Int16Array(n * n);
  let o = 28;
  for (let k = 0; k < residual.length; k++) {
    let z = bytes[o++];
    if (z === 255) {
      z = bytes[o] | (bytes[o + 1] << 8);
      o += 2;
    }
    residual[k] = z & 1 ? -((z + 1) >> 1) : z >> 1;
  }
  if (o !== bytes.length) throw new Error('bad LINZ HD size');
  return { residual, quantum, n, extent, baseN, baseHash };
}

/** FNV-1a 32 of a grid's heights quantised to `quantum` (i32 little-endian), as bake.py hashes them. */
export function linzGridHash(heights: Float32Array, quantum: number): number {
  let h = 0x811c9dc5;
  for (let k = 0; k < heights.length; k++) {
    const q = Math.round(heights[k] / quantum) | 0;
    for (let s = 0; s < 32; s += 8) h = Math.imul(h ^ ((q >>> s) & 255), 0x01000193) >>> 0;
  }
  return h;
}

const realCache = new WeakMap<LinzHdData, Float32Array>();

/**
 * The real n × n heights: the 2× Catmull-Rom upsample of `base` (as upsample2x in generate.ts and
 * cr_upsample in bake.py; clamped edges) plus the residual. Computed once per decoded file.
 */
export function linzHdHeights(hd: LinzHdData, base: LinzData): Float32Array {
  let out = realCache.get(hd);
  if (out) return out;
  const n = hd.n;
  const sn = base.n;
  const s = base.heights;
  out = new Float32Array(n * n);
  const at = (x: number, z: number) => s[(z < 0 ? 0 : z >= sn ? sn - 1 : z) * sn + (x < 0 ? 0 : x >= sn ? sn - 1 : x)];
  const cr = (a: number, b: number, c: number, e: number) => (-a + 9 * b + 9 * c - e) * 0.0625;
  // rows of the base upsampled along x (2n wide), then along z
  const rows = new Float64Array(sn * n);
  for (let j = 0; j < sn; j++) {
    for (let i = 0; i < n; i++) {
      const si = i >> 1;
      rows[j * n + i] = i & 1 ? cr(at(si - 1, j), at(si, j), at(si + 1, j), at(si + 2, j)) : at(si, j);
    }
  }
  const row = (j: number, i: number) => rows[(j < 0 ? 0 : j >= sn ? sn - 1 : j) * n + i];
  for (let iz = 0; iz < n; iz++) {
    const sz = iz >> 1;
    for (let ix = 0; ix < n; ix++) {
      const h = iz & 1 ? cr(row(sz - 1, ix), row(sz, ix), row(sz + 1, ix), row(sz + 2, ix)) : row(sz, ix);
      const k = iz * n + ix;
      out[k] = h + hd.residual[k] * hd.quantum;
    }
  }
  realCache.set(hd, out);
  return out;
}

/** True when `hd` was baked against `base` (same grid, same heights) and can refine an n × n field. */
export function linzHdMatches(hd: LinzHdData, base: LinzData, n: number): boolean {
  return hd.n === n && hd.baseN === base.n && hd.n === base.n * 2 && hd.extent === base.extent && linzGridHash(base.heights, hd.quantum) === hd.baseHash;
}
