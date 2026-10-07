/**
 * Real suburbs 4/9 (#123): the real tree canopy of the suburbs and the gulf islands, from the Auckland LiDAR 2024 (LINZ,
 * CC BY 4.0), baked offline by tools/linz/canopy.py + canopy.ts into src/world/terrain/data/auckland-canopy.bin.
 *
 * Canopy height model = DSM − DEM (1 m) with the buildings taken out (the LINZ NZ Building Outlines buffered 1 m, and
 * the buildings since 2017 by the CBD bake's smooth-and-straight-edged test); 3 m and higher is a tree. Summed per
 * 32 m cell on the land-use lattice (aucklandLandUse.ts) into the share of the cell's land under trees (16 levels; 16 m
 * cells were ≈ 640 kB coded, over #123's 100–250 kB budget), and per 128 m cell the trees' 75th-percentile height. Covered: the 20 LiDAR Part 1 sheets of Devonport, the North Shore to
 * Takapuna, the CBD, the isthmus and the flight corridor (Whenuapai, Hobsonville, Te Atatū, Henderson, Avondale,
 * Mt Albert, Mt Roskill, Onehunga, Māngere, the airport), and the island boxes of #120's photo from Part 2 (Rangitoto,
 * Motutapu, Browns Island, Motuihe, Rakino, Waiheke). Elsewhere the Topo50 cover (the colour map's forest) stays.
 *
 * Who reads it: TreeSource (sources.ts) grows its trees by the share and height where the grid covers, on the aerial
 * photo too (the photo's trees get real 3D trees standing on them, as #121's houses did); the terrain shader's
 * far-field suburb colour and its forest tone follow the share (canopyTexture: extra rows of the land-use texture).
 * Medium and high tiers only, as the land use; without the file (low tier, offline) everything is as before. Gameplay
 * never reads it.
 *
 * Format (little-endian, gzip on disk): 'AKLC' | u32 version | f32 x0 | f32 z0 | f32 cell | u32 cols | u32 rows |
 * u8 height cell (in cells) | u8 share levels Q | u8 length + UTF-8 attribution | u32 bytes + the share stream |
 * u32 bytes + the height stream. Both streams are an adaptive binary range coder (LZMA's): per cell, row by row,
 * the share level 0 … Q − 1 (share = level / (Q − 1)) or Q = not covered, coded as "same as the left neighbour?" and
 * else a 5-bit tree, both in the context of the left and upper neighbours; then per height cell (height cell × cell m)
 * the 75th-percentile tree height in whole metres (0 = no trees) as a 6-bit tree in the context of its left and upper
 * neighbours.
 */
import canopyUrl from '../data/auckland-canopy.bin?url';
import { fetchMaybeGzip } from './aucklandLinz';

export const CANOPY_URL: string = canopyUrl;

const MAGIC = 'AKLC';
const VERSION = 1;
/** Share levels in the file (level / (Q − 1)); level Q marks a cell the grid does not cover. */
export const CANOPY_LEVELS = 16;

export interface Canopy {
  attribution: string;
  /** Corner of cell (0, 0) (m, game XZ) and the cell size (m). */
  x0: number;
  z0: number;
  cell: number;
  cols: number;
  rows: number;
  /** Share levels (0 … levels − 1); `levels` = not covered. */
  levels: number;
  /** cols × rows, row-major. */
  share: Uint8Array;
  /** Height cells: `hcell` cells each way; hcols × hrows, the trees' 75th-percentile height (m, 0 = none). */
  hcell: number;
  hcols: number;
  hrows: number;
  height: Uint8Array;
}

let current: Canopy | null = null;
let version = 0;

/** The installed canopy, or null (low tier, offline, not loaded yet). */
export function aucklandCanopy(): Canopy | null {
  return current;
}

export function aucklandCanopyVersion(): number {
  return version;
}

/** Install decompressed bytes (null clears). Throws on malformed data. */
export function setAucklandCanopy(bytes: Uint8Array | null): void {
  current = bytes ? decodeCanopy(bytes) : null;
  version++;
}

export async function loadAucklandCanopy(url = CANOPY_URL): Promise<boolean> {
  if (current) return true;
  try {
    setAucklandCanopy(await fetchMaybeGzip(url));
    return true;
  } catch (err) {
    console.warn('[world] real tree canopy unavailable, keeping the Topo50 cover', err);
    return false;
  }
}

/** Share of the land under trees (0 … 1) in the cell holding (x, z), or −1 where the grid does not cover. */
export function canopyAt(c: Canopy, x: number, z: number): number {
  const i = Math.floor((x - c.x0) / c.cell);
  const j = Math.floor((z - c.z0) / c.cell);
  if (i < 0 || j < 0 || i >= c.cols || j >= c.rows) return -1;
  const v = c.share[j * c.cols + i];
  return v >= c.levels ? -1 : v / (c.levels - 1);
}

/** The trees' 75th-percentile height (m) round (x, z); 0 where the LiDAR saw none. */
export function canopyHeightAt(c: Canopy, x: number, z: number): number {
  const s = c.cell * c.hcell;
  const i = Math.floor((x - c.x0) / s);
  const j = Math.floor((z - c.z0) / s);
  if (i < 0 || j < 0 || i >= c.hcols || j >= c.hrows) return 0;
  return c.height[j * c.hcols + i];
}

// ── Range coder (LZMA's binary coder: 11-bit probabilities, shift 5) ──
const TOP = 1 << 24;
const BITS = 11;
const ONE = 1 << BITS;
const MOVE = 5;

export class RangeEncoder {
  private low = 0;
  private range = 0xffffffff;
  private cache = 0;
  private cacheSize = 1;
  readonly out: number[] = [];

  private shiftLow(): void {
    if (this.low < 0xff000000 || this.low >= 0x100000000) {
      const carry = this.low >= 0x100000000 ? 1 : 0;
      let temp = this.cache;
      do {
        this.out.push((temp + carry) & 0xff);
        temp = 0xff;
      } while (--this.cacheSize !== 0);
      this.cache = Math.floor(this.low / 0x1000000) & 0xff;
    }
    this.cacheSize++;
    this.low = (this.low % 0x1000000) * 256;
  }

  bit(probs: Uint16Array, i: number, b: number): void {
    const p = probs[i];
    const bound = (this.range >>> BITS) * p;
    if (b === 0) {
      this.range = bound;
      probs[i] = p + ((ONE - p) >> MOVE);
    } else {
      this.low += bound;
      this.range = (this.range - bound) >>> 0;
      probs[i] = p - (p >> MOVE);
    }
    while (this.range < TOP) {
      this.range = (this.range * 256) >>> 0;
      this.shiftLow();
    }
  }

  /** `nbits`-bit value through a bit tree of probabilities at probs[base + 1 …]. */
  tree(probs: Uint16Array, base: number, nbits: number, v: number): void {
    let m = 1;
    for (let k = nbits - 1; k >= 0; k--) {
      const b = (v >> k) & 1;
      this.bit(probs, base + m, b);
      m = (m << 1) | b;
    }
  }

  finish(): Uint8Array {
    for (let k = 0; k < 5; k++) this.shiftLow();
    return Uint8Array.from(this.out);
  }
}

export class RangeDecoder {
  private range = 0xffffffff;
  private code = 0;
  private pos: number;
  constructor(
    private readonly buf: Uint8Array,
    start: number,
  ) {
    this.pos = start + 1;
    for (let k = 0; k < 4; k++) this.code = ((this.code << 8) | buf[this.pos++]) >>> 0;
  }

  bit(probs: Uint16Array, i: number): number {
    const p = probs[i];
    const bound = (this.range >>> BITS) * p;
    let b: number;
    if (this.code < bound) {
      this.range = bound;
      probs[i] = p + ((ONE - p) >> MOVE);
      b = 0;
    } else {
      this.code = (this.code - bound) >>> 0;
      this.range = (this.range - bound) >>> 0;
      probs[i] = p - (p >> MOVE);
      b = 1;
    }
    if (this.range < TOP) {
      this.range = (this.range * 256) >>> 0;
      this.code = ((this.code * 256) >>> 0) + (this.buf[this.pos++] ?? 0);
      this.code >>>= 0;
    }
    return b;
  }

  tree(probs: Uint16Array, base: number, nbits: number): number {
    let m = 1;
    for (let k = 0; k < nbits; k++) m = (m << 1) | this.bit(probs, base + m);
    return m - (1 << nbits);
  }
}

const SHARE_BITS = 5;
const HEIGHT_BITS = 6;
const probsFor = (contexts: number, bits: number) => new Uint16Array(contexts << bits).fill(ONE >> 1);

/** The share stream: per cell, "same as left?" then a 5-bit tree, in the context of (left, up). */
export function encodeShares(v: Uint8Array, cols: number, rows: number, levels: number): Uint8Array {
  const n = levels + 1;
  const same = probsFor(n * n, 0);
  const tree = probsFor(n * n, SHARE_BITS);
  const rc = new RangeEncoder();
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const l = i > 0 ? v[k - 1] : levels;
      const u = j > 0 ? v[k - cols] : levels;
      const ctx = l * n + u;
      const s = v[k] === l ? 1 : 0;
      rc.bit(same, ctx, s);
      if (!s) rc.tree(tree, ctx << SHARE_BITS, SHARE_BITS, v[k]);
    }
  return rc.finish();
}

export function decodeShares(buf: Uint8Array, start: number, cols: number, rows: number, levels: number): Uint8Array {
  const n = levels + 1;
  const same = probsFor(n * n, 0);
  const tree = probsFor(n * n, SHARE_BITS);
  const rc = new RangeDecoder(buf, start);
  const v = new Uint8Array(cols * rows);
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const l = i > 0 ? v[k - 1] : levels;
      const u = j > 0 ? v[k - cols] : levels;
      const ctx = l * n + u;
      v[k] = rc.bit(same, ctx) ? l : rc.tree(tree, ctx << SHARE_BITS, SHARE_BITS);
    }
  return v;
}

/** Context of a height cell: its left and upper neighbours in 4 m steps (up to 28 m). */
const hctx = (v: Uint8Array, k: number, cols: number) => Math.min(7, (k % cols > 0 ? v[k - 1] : 0) >> 2) * 8 + Math.min(7, (k >= cols ? v[k - cols] : 0) >> 2);

/** The height stream: a 6-bit tree per cell in the context of its left and upper neighbours. */
export function encodeHeights(v: Uint8Array, cols: number): Uint8Array {
  const tree = probsFor(64, HEIGHT_BITS);
  const rc = new RangeEncoder();
  for (let k = 0; k < v.length; k++) rc.tree(tree, hctx(v, k, cols) << HEIGHT_BITS, HEIGHT_BITS, Math.min(63, v[k]));
  return rc.finish();
}

export function decodeHeights(buf: Uint8Array, start: number, count: number, cols: number): Uint8Array {
  const tree = probsFor(64, HEIGHT_BITS);
  const rc = new RangeDecoder(buf, start);
  const v = new Uint8Array(count);
  for (let k = 0; k < count; k++) v[k] = rc.tree(tree, hctx(v, k, cols) << HEIGHT_BITS, HEIGHT_BITS);
  return v;
}

/** Encode a canopy (its share levels and heights) into the file's bytes (before gzip). */
export function encodeCanopy(c: Canopy): Uint8Array {
  const attr = new TextEncoder().encode(c.attribution);
  if (attr.length > 255) throw new Error('attribution too long');
  const shares = encodeShares(c.share, c.cols, c.rows, c.levels);
  const heights = encodeHeights(c.height, c.hcols);
  const head = 4 + 4 + 4 * 3 + 4 * 2 + 2 + 1 + attr.length;
  const out = new Uint8Array(head + 4 + shares.length + 4 + heights.length);
  const dv = new DataView(out.buffer);
  for (let k = 0; k < 4; k++) out[k] = MAGIC.charCodeAt(k);
  dv.setUint32(4, VERSION, true);
  dv.setFloat32(8, c.x0, true);
  dv.setFloat32(12, c.z0, true);
  dv.setFloat32(16, c.cell, true);
  dv.setUint32(20, c.cols, true);
  dv.setUint32(24, c.rows, true);
  out[28] = c.hcell;
  out[29] = c.levels;
  out[30] = attr.length;
  out.set(attr, 31);
  let o = head;
  dv.setUint32(o, shares.length, true);
  out.set(shares, o + 4);
  o += 4 + shares.length;
  dv.setUint32(o, heights.length, true);
  out.set(heights, o + 4);
  return out;
}

export function decodeCanopy(bytes: Uint8Array): Canopy {
  if (bytes.length < 31 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== MAGIC) throw new Error('not a canopy file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(4, true) !== VERSION) throw new Error('canopy version');
  const x0 = dv.getFloat32(8, true);
  const z0 = dv.getFloat32(12, true);
  const cell = dv.getFloat32(16, true);
  const cols = dv.getUint32(20, true);
  const rows = dv.getUint32(24, true);
  const hcell = bytes[28];
  const levels = bytes[29];
  const al = bytes[30];
  const attribution = new TextDecoder().decode(bytes.subarray(31, 31 + al));
  let o = 31 + al;
  const sl = dv.getUint32(o, true);
  const share = decodeShares(bytes, o + 4, cols, rows, levels);
  o += 4 + sl;
  const hl = dv.getUint32(o, true);
  if (o + 4 + hl !== bytes.length) throw new Error('bad canopy size');
  const hcols = Math.ceil(cols / hcell);
  const hrows = Math.ceil(rows / hcell);
  const height = decodeHeights(bytes, o + 4, hcols * hrows, hcols);
  return { attribution, x0, z0, cell, cols, rows, levels, share, hcell, hcols, hrows, height };
}

/** One level of the shader's canopy pyramid: `cell` m cells from the grid's corner, a byte each from `offset`. */
export interface CanopyLevel {
  cell: number;
  cols: number;
  rows: number;
  offset: number;
}

/** Levels of the shader's pyramid: 32, 64, 128 and 256 m. */
export const CANOPY_GPU_LEVELS = 4;
export const CANOPY_GPU_CELL = 32;
/** A shader cell's byte: the mean share of its covered cells × 250, or this where under half of it is covered. */
export const CANOPY_GPU_NONE = 255;

/**
 * The share as the terrain shader reads it (terrainShader.ts canopyShare): a pyramid of box averages, 32 m (the file's
 * cells) up to 256 m, the levels one after the other in one byte array (row-major each), packed four to an
 * RGBA8 texel after the land-use grid's rows (TerrainRenderer.setLandUse). A cell under half covered is
 * CANOPY_GPU_NONE, so the shader blends to the Topo50 cover and the procedural suburbs across the grid's edge.
 */
export function canopyPyramid(c: Canopy): { bytes: Uint8Array; levels: CanopyLevel[] } {
  const levels: CanopyLevel[] = [];
  let off = 0;
  for (let l = 0; l < CANOPY_GPU_LEVELS; l++) {
    const k = Math.max(1, Math.round((CANOPY_GPU_CELL << l) / c.cell));
    const cols = Math.ceil(c.cols / k);
    const rows = Math.ceil(c.rows / k);
    levels.push({ cell: c.cell * k, cols, rows, offset: off });
    off += cols * rows;
  }
  const bytes = new Uint8Array(off).fill(CANOPY_GPU_NONE);
  // each level straight from the file's cells: the mean share of its covered cells
  const Q = c.levels - 1;
  for (const lv of levels) {
    const k = Math.round(lv.cell / c.cell);
    const sum = new Float32Array(lv.cols * lv.rows);
    const cnt = new Uint32Array(lv.cols * lv.rows);
    for (let j = 0; j < c.rows; j++) {
      const row = Math.floor(j / k) * lv.cols;
      for (let i = 0; i < c.cols; i++) {
        const v = c.share[j * c.cols + i];
        if (v >= c.levels) continue;
        const t = row + Math.floor(i / k);
        sum[t] += v / Q;
        cnt[t]++;
      }
    }
    const half = (k * k) / 2;
    for (let t = 0; t < sum.length; t++) if (cnt[t] >= half) bytes[lv.offset + t] = Math.round((sum[t] / cnt[t]) * 250);
  }
  return { bytes, levels };
}
