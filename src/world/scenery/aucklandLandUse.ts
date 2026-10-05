/**
 * Real land use for the Auckland theatre (issue #122): a class grid (16 m cells over the ±40 km world) baked offline
 * by tools/osm/landuse.py from OpenStreetMap (`landuse`, `leisure`, `amenity` areas) and the LINZ Topo50 golf course
 * and cemetery polygons, into src/world/scenery/data/auckland-landuse.bin. Data © OpenStreetMap contributors, ODbL 1.0
 * (the grid is a derivative database under the same licence), and LINZ, CC BY 4.0 (docs/CREDITS.md).
 *
 * Who reads it: the terrain generator's built-up density (applyLandUse in terrain/generate.ts, so the colour map,
 * the garden trees and the house scatter follow real suburbs and parks), the terrain shader (landUseAt(): parks,
 * pitches, golf courses, cemeteries, vineyards, car parks and big flat roofs) and HouseSource (houses only on
 * residential land, warehouses on industrial / commercial / hospital land, nothing on parks and fields). Where a cell
 * has no class (LU_NONE) the hand-traced map (aucklandMap.ts AKL_URBAN / AKL_PARKS) still decides, and without the
 * file (the low tier never loads it, or offline) everything is as before. Gameplay never reads it.
 *
 * Format (little-endian, gzip): 'AKLU' | u32 version | f32 x0 | f32 z0 | f32 cell | u32 cols | u32 rows | u8 length +
 * UTF-8 attribution | per row, runs: varint (length << 4 | class) summing to cols.
 *
 * In memory (and on the GPU, as is) the classes are 4-bit nibbles, 4 (x) × 2 (z) cells per RGBA8 texel: byte
 * `(j & 1) · 2 + ((i & 3) >> 1)` of texel (i >> 2, j >> 1), the low nibble for even i. 5000² cells → 1250 × 2500
 * texels, 12.5 MB.
 */
import landUseUrl from './data/auckland-landuse.bin?url';
import { fetchMaybeGzip } from '../terrain/theaters/aucklandLinz';

export const LANDUSE_URL: string = landUseUrl;

// Classes: keep in sync with NAMES in tools/osm/landuse.py
export const LU_NONE = 0;
export const LU_RESIDENTIAL = 1;
export const LU_COMMERCIAL = 2;
export const LU_INDUSTRIAL = 3;
export const LU_PARK = 4;
export const LU_PITCH = 5;
export const LU_GOLF = 6;
export const LU_SCHOOL = 7;
export const LU_HOSPITAL = 8;
export const LU_CEMETERY = 9;
export const LU_VINEYARD = 10;
export const LU_FARMLAND = 11;
export const LU_CLASSES = 12;
export const LU_NAMES = ['none', 'residential', 'commercial', 'industrial', 'park', 'pitch', 'golf', 'school', 'hospital', 'cemetery', 'vineyard', 'farmland'] as const;

/** Open ground: no houses, no streets (parks, pitches, golf courses, cemeteries, vineyards, farmland). */
export function luOpen(c: number): boolean {
  return c === LU_PARK || c === LU_PITCH || c === LU_GOLF || c === LU_CEMETERY || c === LU_VINEYARD || c === LU_FARMLAND;
}

/** Land with big flat-roofed buildings and car parks (HouseSource's warehouses). */
export function luSheds(c: number): boolean {
  return c === LU_COMMERCIAL || c === LU_INDUSTRIAL || c === LU_HOSPITAL;
}

export interface LandUse {
  attribution: string;
  /** Corner of cell (0, 0) (m, game XZ) and the cell size (m). */
  x0: number;
  z0: number;
  cell: number;
  cols: number;
  rows: number;
  /** Packed nibbles (see the header): texW × texH RGBA8 texels. */
  texW: number;
  texH: number;
  data: Uint8Array;
}

const MAGIC = 'AKLU';
const VERSION = 1;

let current: LandUse | null = null;
let version = 0;

/** The installed grid, or null (low tier, offline, not loaded yet). */
export function aucklandLandUse(): LandUse | null {
  return current;
}

/** Changes whenever the installed grid changes. */
export function aucklandLandUseVersion(): number {
  return version;
}

/** Install decompressed bytes (null clears → the hand-traced map alone). Throws on malformed data. */
export function setAucklandLandUse(bytes: Uint8Array | null): void {
  current = bytes ? decodeLandUse(bytes) : null;
  version++;
}

/** Fetch, decompress and install the grid; false (fallback kept) on any failure. */
export async function loadAucklandLandUse(url = LANDUSE_URL): Promise<boolean> {
  if (current) return true;
  try {
    setAucklandLandUse(await fetchMaybeGzip(url));
    return true;
  } catch (err) {
    console.warn('[world] OSM land use unavailable, using the hand-traced suburbs', err);
    return false;
  }
}

export function decodeLandUse(bytes: Uint8Array): LandUse {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== MAGIC || dv.getUint32(4, true) !== VERSION) throw new Error('bad land-use header');
  const x0 = dv.getFloat32(8, true);
  const z0 = dv.getFloat32(12, true);
  const cell = dv.getFloat32(16, true);
  const cols = dv.getUint32(20, true);
  const rows = dv.getUint32(24, true);
  let o = 28;
  const an = bytes[o++];
  const attribution = new TextDecoder().decode(bytes.subarray(o, o + an));
  o += an;
  const texW = Math.ceil(cols / 4);
  const texH = Math.ceil(rows / 2);
  const data = new Uint8Array(texW * texH * 4);
  for (let j = 0; j < rows; j++) {
    const rowBase = (j >> 1) * texW * 4 + (j & 1) * 2;
    let i = 0;
    while (i < cols) {
      let v = 0;
      let mul = 1;
      for (;;) {
        if (o >= bytes.length) throw new Error('bad land-use size');
        const b = bytes[o++];
        v += (b & 127) * mul;
        if (b < 128) break;
        mul *= 128;
      }
      const c = v % 16;
      const end = i + Math.floor(v / 16);
      if (end > cols) throw new Error('bad land-use run');
      if (c) for (; i < end; i++) data[rowBase + (i >> 2) * 4 + ((i & 3) >> 1)] |= c << ((i & 1) * 4);
      else i = end;
    }
  }
  if (o !== bytes.length) throw new Error('bad land-use size');
  return { attribution, x0, z0, cell, cols, rows, texW, texH, data };
}

/** Class of cell (i, j); LU_NONE outside the grid. */
export function landUseCell(lu: LandUse, i: number, j: number): number {
  if (i < 0 || j < 0 || i >= lu.cols || j >= lu.rows) return LU_NONE;
  return (lu.data[(j >> 1) * lu.texW * 4 + (i >> 2) * 4 + (j & 1) * 2 + ((i & 3) >> 1)] >> ((i & 1) * 4)) & 15;
}

/** Class at a world position (same arithmetic as the terrain shader's landUseAt()). */
export function landUseAt(lu: LandUse, x: number, z: number): number {
  return landUseCell(lu, Math.floor((x - lu.x0) / lu.cell), Math.floor((z - lu.z0) / lu.cell));
}

/** Share of each class (out[c], summing to 1) of the cells whose centres lie in the rectangle. */
export function landUseShares(lu: LandUse, x0: number, z0: number, x1: number, z1: number, out = new Float64Array(LU_CLASSES)): Float64Array {
  out.fill(0);
  const i0 = Math.ceil((x0 - lu.x0) / lu.cell - 0.5);
  const i1 = Math.floor((x1 - lu.x0) / lu.cell - 0.5);
  const j0 = Math.ceil((z0 - lu.z0) / lu.cell - 0.5);
  const j1 = Math.floor((z1 - lu.z0) / lu.cell - 0.5);
  let n = 0;
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      out[landUseCell(lu, i, j)]++;
      n++;
    }
  if (n) for (let c = 0; c < LU_CLASSES; c++) out[c] /= n;
  return out;
}
