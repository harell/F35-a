/**
 * Real suburbs 2/9 (#121): the real houses of the Devonport peninsula, Waiheke and the gulf islands (Rangitoto,
 * Motutapu, Motuihe, Rakino), from the LINZ NZ Building Outlines (2017) and the Auckland 2024 LiDAR (Part 1 and
 * Part 2), roof colours from the LINZ 2024 aerial photo (all CC BY 4.0), baked by tools/linz/houses.py + houses.ts
 * into src/world/terrain/data/auckland-houses.bin.
 *
 * Each house is an oriented rectangle (the outline's centre, main direction, second moments and area) with a measured
 * roof: the eave and the ridge's rise above the LiDAR ground (a gable along the ridge direction; rise 0 = flat) and the
 * roof's colour from the photo. They are drawn through the scatter's own instanced house archetypes (sources.ts
 * HouseSource, scatter.ts TileScatter): no new mesh, the same draw calls. Where they stand (houseCoverage) the
 * procedural lots, the scatter's procedural houses, the arterials' frontage lots and the suburb centres' blocks step
 * aside (Scenery.siteMask).
 *
 * Format (little-endian, gzip on disk):
 *   'AKLH', u32 version, u32 count, u16 palette size P, P × (r, g, b) sRGB bytes, u16 cell size (m), u32 cells,
 *   per cell: zig-zag varint Δi, Δj (its column / row on the cell grid from the world origin, from the previous cell's),
 *   varint houses; then one column per field for all houses in cell order, one byte each:
 *   x, z (0.5 m steps from the cell's corner, + 0.25), w (across the ridge), d (along it) (0.25 m), the ridge's
 *   direction from +X towards +Z (π / 256 steps), eave (0.1 m), rise (0.1 m), palette index. 8 bytes a house.
 *   Then the coverage, where the file is the truth (every outline there was taken: the land under #120's photo of the
 *   peninsula and the islands): i32 x0, z0 (m), u16 cell (m), u16 cols, rows, and per row varint run lengths,
 *   alternately unset and set, starting unset, summing to cols.
 */
import housesUrl from '../terrain/data/auckland-houses.bin?url';
import { fetchMaybeGzip } from '../terrain/theaters/aucklandLinz';
import { LOT_MASK_CELL, LotMask } from './lotMask';

export const HOUSES_URL: string = housesUrl;

const MAGIC = 'AKLH';
const VERSION = 1;
/** Bytes a house takes in the file's columns (the cell table and palette come on top). */
export const HOUSE_BYTES = 8;

export interface RealHouses {
  count: number;
  /** Centre (m, game XZ). */
  x: Float32Array;
  z: Float32Array;
  /** Extent across the ridge and along it (m): the roof's, as the LINZ outlines are traced at the roof's edge. */
  w: Float32Array;
  d: Float32Array;
  /** The ridge's direction from +X towards +Z (rad, 0 … π). */
  dir: Float32Array;
  /** Eave above the ground (m) and the ridge's rise above the eave (m; 0 = a flat roof). */
  eave: Float32Array;
  rise: Float32Array;
  /** Roof colour, sRGB 0xRRGGBB. */
  color: Uint32Array;
  /** Cell size (m) of the index; the houses of each cell are contiguous. */
  cell: number;
  /** Cell key (cellKey) → [first, end) house index. */
  cells: Map<number, [number, number]>;
  /** Where the file is the truth (houseCoverage), cols × rows cells of `cell` m from (x0, z0), row-major, 1 = covered. */
  cover: CoverGrid;
}

export interface CoverGrid {
  x0: number;
  z0: number;
  cell: number;
  cols: number;
  rows: number;
  bits: Uint8Array;
}

export interface HouseRecord {
  x: number;
  z: number;
  w: number;
  d: number;
  dir: number;
  eave: number;
  rise: number;
  /** Palette index. */
  c: number;
}

export const cellKey = (i: number, j: number): number => (i + 32768) * 65536 + (j + 32768);

let current: RealHouses | null = null;
let version = 0;

/** Decoded real houses, or null when they have not been (or could not be) loaded. */
export function aucklandHouses(): RealHouses | null {
  return current;
}

export function aucklandHousesVersion(): number {
  return version;
}

/** Install decompressed bytes (null clears). Throws on malformed data. */
export function setAucklandHouses(bytes: Uint8Array | null): void {
  current = bytes ? decodeHouses(bytes) : null;
  version++;
}

export async function loadAucklandHouses(url = HOUSES_URL): Promise<boolean> {
  if (current) return true;
  try {
    setAucklandHouses(await fetchMaybeGzip(url));
    return true;
  } catch (err) {
    console.warn('[world] real houses (Devonport, gulf islands) unavailable, using the procedural suburbs', err);
    return false;
  }
}

const q8 = (v: number, step: number) => Math.max(0, Math.min(255, Math.round(v / step)));

/** Encode houses (any order) with a palette of sRGB colours and their coverage grid; `cell` m index cells. */
export function encodeHouses(houses: HouseRecord[], palette: number[], cover: CoverGrid, cell = 128): Uint8Array {
  const keyed = houses.map((h) => ({ h, i: Math.floor(h.x / cell), j: Math.floor(h.z / cell) }));
  keyed.sort((a, b) => a.j - b.j || a.i - b.i || a.h.x - b.h.x || a.h.z - b.h.z);
  const cells: { i: number; j: number; n: number }[] = [];
  for (const k of keyed) {
    const last = cells[cells.length - 1];
    if (last && last.i === k.i && last.j === k.j) last.n++;
    else cells.push({ i: k.i, j: k.j, n: 1 });
  }
  const head: number[] = [];
  const u8 = (v: number) => head.push(v & 255);
  const u16 = (v: number) => {
    u8(v);
    u8(v >> 8);
  };
  const u32 = (v: number) => {
    u16(v & 0xffff);
    u16(v >>> 16);
  };
  const varint = (v: number) => {
    while (v >= 128) {
      u8((v & 127) | 128);
      v = Math.floor(v / 128);
    }
    u8(v);
  };
  const zig = (v: number) => varint(v >= 0 ? v * 2 : -v * 2 - 1);
  for (const ch of MAGIC) u8(ch.charCodeAt(0));
  u32(VERSION);
  u32(houses.length);
  u16(palette.length);
  for (const c of palette) {
    u8(c >> 16);
    u8(c >> 8);
    u8(c);
  }
  u16(cell);
  u32(cells.length);
  let pi = 0;
  let pj = 0;
  for (const c of cells) {
    zig(c.i - pi);
    zig(c.j - pj);
    varint(c.n);
    pi = c.i;
    pj = c.j;
  }
  const top = head.slice();
  const n = houses.length;
  const cols = new Uint8Array(n * HOUSE_BYTES);
  keyed.forEach(({ h, i, j }, k) => {
    const dir = ((h.dir % Math.PI) + Math.PI) % Math.PI;
    cols[k] = Math.min(255, Math.floor((h.x - i * cell) * 2));
    cols[n + k] = Math.min(255, Math.floor((h.z - j * cell) * 2));
    cols[2 * n + k] = q8(h.w, 0.25);
    cols[3 * n + k] = q8(h.d, 0.25);
    cols[4 * n + k] = Math.round((dir / Math.PI) * 256) % 256;
    cols[5 * n + k] = q8(h.eave, 0.1);
    cols[6 * n + k] = q8(h.rise, 0.1);
    cols[7 * n + k] = h.c;
  });
  const tail: number[] = [];
  head.length = 0;
  const i32 = (v: number) => u32(v >>> 0);
  i32(cover.x0);
  i32(cover.z0);
  u16(cover.cell);
  u16(cover.cols);
  u16(cover.rows);
  for (let j = 0; j < cover.rows; j++) {
    let cur = 0;
    let n = 0;
    for (let i = 0; i < cover.cols; i++) {
      const v = cover.bits[j * cover.cols + i] ? 1 : 0;
      if (v !== cur) {
        varint(n);
        cur = v;
        n = 0;
      }
      n++;
    }
    varint(n);
  }
  tail.push(...head);
  const out = new Uint8Array(top.length + cols.length + tail.length);
  out.set(top);
  out.set(cols, top.length);
  out.set(tail, top.length + cols.length);
  return out;
}

/**
 * Decode a houses file. `palette`: the colours when the file carries none (the corridor's streamed tiles, #126, share
 * one palette from their manifest: corridorHouses.ts).
 */
export function decodeHouses(bytes: Uint8Array, shared: readonly number[] | null = null): RealHouses {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 16 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== MAGIC || dv.getUint32(4, true) !== VERSION) throw new Error('bad houses header');
  const count = dv.getUint32(8, true);
  let o = 12;
  const need = (k: number) => {
    if (o + k > bytes.length) throw new Error('bad houses size');
  };
  const u8 = () => (need(1), bytes[o++]);
  const varint = () => {
    let v = 0;
    let mul = 1;
    for (;;) {
      const b = u8();
      v += (b & 127) * mul;
      if (b < 128) return v;
      mul *= 128;
    }
  };
  const zig = () => {
    const z = varint();
    return z % 2 ? -(z + 1) / 2 : z / 2;
  };
  need(2);
  const np = dv.getUint16(o, true);
  o += 2;
  const palette: number[] = [];
  for (let k = 0; k < np; k++) palette.push((u8() << 16) | (u8() << 8) | u8());
  if (!np && shared) palette.push(...shared);
  need(6);
  const cell = dv.getUint16(o, true);
  const nCells = dv.getUint32(o + 2, true);
  o += 6;
  const cellList: { i: number; j: number; n: number }[] = [];
  let ci = 0;
  let cj = 0;
  let total = 0;
  for (let k = 0; k < nCells; k++) {
    ci += zig();
    cj += zig();
    const n = varint();
    cellList.push({ i: ci, j: cj, n });
    total += n;
  }
  if (total !== count) throw new Error('bad houses cells');
  need(count * HOUSE_BYTES);
  const col = (f: number) => bytes.subarray(o + f * count, o + (f + 1) * count);
  const [cx, cz, cw, cd, ca, ce, cr, cc] = [0, 1, 2, 3, 4, 5, 6, 7].map(col);
  const h: RealHouses = {
    count,
    x: new Float32Array(count),
    z: new Float32Array(count),
    w: new Float32Array(count),
    d: new Float32Array(count),
    dir: new Float32Array(count),
    eave: new Float32Array(count),
    rise: new Float32Array(count),
    color: new Uint32Array(count),
    cell,
    cells: new Map(),
    cover: { x0: 0, z0: 0, cell: 1, cols: 0, rows: 0, bits: new Uint8Array(0) },
  };
  let k = 0;
  for (const c of cellList) {
    h.cells.set(cellKey(c.i, c.j), [k, k + c.n]);
    for (let e = k + c.n; k < e; k++) {
      h.x[k] = c.i * cell + (cx[k] + 0.5) / 2;
      h.z[k] = c.j * cell + (cz[k] + 0.5) / 2;
      h.w[k] = cw[k] * 0.25;
      h.d[k] = cd[k] * 0.25;
      h.dir[k] = (ca[k] / 256) * Math.PI;
      h.eave[k] = ce[k] / 10;
      h.rise[k] = cr[k] / 10;
      if (cc[k] >= palette.length) throw new Error('bad houses colour');
      h.color[k] = palette[cc[k]];
    }
  }
  o += count * HOUSE_BYTES;
  need(14);
  const cv = h.cover;
  cv.x0 = dv.getInt32(o, true);
  cv.z0 = dv.getInt32(o + 4, true);
  cv.cell = dv.getUint16(o + 8, true);
  cv.cols = dv.getUint16(o + 10, true);
  cv.rows = dv.getUint16(o + 12, true);
  o += 14;
  if (!cv.cell) throw new Error('bad houses coverage');
  cv.bits = new Uint8Array(cv.cols * cv.rows);
  for (let j = 0; j < cv.rows; j++) {
    let i = 0;
    let cur = 0;
    while (i < cv.cols) {
      const n = varint();
      if (i + n > cv.cols) throw new Error('bad houses coverage');
      if (cur) cv.bits.fill(1, j * cv.cols + i, j * cv.cols + i + n);
      i += n;
      cur ^= 1;
    }
  }
  if (o !== bytes.length) throw new Error('bad houses size');
  return h;
}

/** Indices of the houses whose centre lies in [x0, x1) × [z0, z1), appended to `out`. */
export function housesIn(h: RealHouses, x0: number, z0: number, x1: number, z1: number, out: number[] = []): number[] {
  const c = h.cell;
  for (let j = Math.floor(z0 / c); j <= Math.floor((z1 - 1e-6) / c); j++)
    for (let i = Math.floor(x0 / c); i <= Math.floor((x1 - 1e-6) / c); i++) {
      const r = h.cells.get(cellKey(i, j));
      if (!r) continue;
      for (let k = r[0]; k < r[1]; k++) if (h.x[k] >= x0 && h.x[k] < x1 && h.z[k] >= z0 && h.z[k] < z1) out.push(k);
    }
  return out;
}

/** Index of the house nearest (x, z) within `radius` m, or -1. */
export function nearestHouse(h: RealHouses, x: number, z: number, radius = 10): number {
  let best = -1;
  let bd = radius * radius;
  for (const k of housesIn(h, x - radius, z - radius, x + radius, z + radius)) {
    const d = (h.x[k] - x) ** 2 + (h.z[k] - z) ** 2;
    if (d < bd) {
      bd = d;
      best = k;
    }
  }
  return best;
}

/** True where the houses file is the truth (its coverage grid). */
export function housesCover(h: RealHouses, x: number, z: number): boolean {
  const c = h.cover;
  const i = Math.floor((x - c.x0) / c.cell);
  const j = Math.floor((z - c.z0) / c.cell);
  return i >= 0 && j >= 0 && i < c.cols && j < c.rows && c.bits[j * c.cols + i] === 1;
}

/**
 * Where the real houses are the truth, as a lot mask (lotMask.ts, LOT_MASK_CELL cells): the cells whose centre lies in
 * the file's coverage (the land under #120's photo of the peninsula and the islands, where the bake took every outline
 * it found). The procedural grid's lots and streets, the scatter's procedural houses, the frontage lots and the
 * centres' blocks keep off it (Scenery.siteMask), so the real houses never stand among invented ones, nor do invented
 * ones fill the real place's reserves and bush; the photo (medium and high tiers) or the garden ground (low) shows
 * round them.
 */
export function houseCoverage(h: RealHouses, cell = LOT_MASK_CELL): LotMask | null {
  const c = h.cover;
  if (!c.cols || !c.rows) return null;
  const x0 = Math.floor(c.x0 / cell) * cell;
  const z0 = Math.floor(c.z0 / cell) * cell;
  const cols = Math.ceil((c.x0 + c.cols * c.cell - x0) / cell);
  const rows = Math.ceil((c.z0 + c.rows * c.cell - z0) / cell);
  const m = new LotMask(x0, z0, cols, rows, cell);
  // per covered grid cell, the lot cells whose centre falls in it (the grid is sparse over the gulf)
  for (let cj = 0; cj < c.rows; cj++)
    for (let ci = 0; ci < c.cols; ci++) {
      if (!c.bits[cj * c.cols + ci]) continue;
      const gx = c.x0 + ci * c.cell;
      const gz = c.z0 + cj * c.cell;
      for (let j = Math.ceil((gz - z0) / cell - 0.5); z0 + (j + 0.5) * cell < gz + c.cell; j++)
        for (let i = Math.ceil((gx - x0) / cell - 0.5); x0 + (i + 0.5) * cell < gx + c.cell; i++) m.mark(i, j);
    }
  return m;
}

/** The union of two lot masks on the same cell size and lattice (a cell is set in the result if it is in either). */
export function unionMasks(a: LotMask | null, b: LotMask | null): LotMask | null {
  if (!a || !b) return a ?? b;
  if (a.cell !== b.cell) throw new Error('lot masks of different cells');
  const cell = a.cell;
  const ax1 = a.x0 + a.texW * 8 * cell, az1 = a.z0 + a.texH * 4 * cell;
  const bx1 = b.x0 + b.texW * 8 * cell, bz1 = b.z0 + b.texH * 4 * cell;
  const x0 = Math.min(a.x0, b.x0);
  const z0 = Math.min(a.z0, b.z0);
  const m = new LotMask(x0, z0, Math.round((Math.max(ax1, bx1) - x0) / cell), Math.round((Math.max(az1, bz1) - z0) / cell), cell);
  for (const src of [a, b]) {
    const oi = Math.round((src.x0 - x0) / cell);
    const oj = Math.round((src.z0 - z0) / cell);
    // the set bits only (byte j & 3 of texel (i >> 3, j >> 2), bit i & 7: lotMask.ts)
    const d = src.data;
    for (let t = 0; t < d.length; t++) {
      const v = d[t];
      if (!v) continue;
      const texel = t >> 2;
      const i0 = (texel % src.texW) * 8;
      const j = Math.floor(texel / src.texW) * 4 + (t & 3);
      for (let bit = 0; bit < 8; bit++) if ((v >> bit) & 1) m.mark(i0 + bit + oi, j + oj);
    }
  }
  return m;
}
