/**
 * Hero neighbourhoods: Herne Bay, Westhaven and Mission Bay measured house by house from the LINZ 2024 LiDAR and aerial
 * (CC BY 4.0) on OpenStreetMap outlines (© OpenStreetMap contributors, ODbL 1.0), baked by
 * tools/hero/sites/neighbourhoods_bake.py into src/world/scenery/data/auckland-neighbourhoods.bin (≈ 120 kB gzip; the
 * format is in the bake's header).
 *
 * Per area: its footprint, every building as its outline plus a measured roof (flat, gable or hip: pitchedRoof.ts),
 * a 20 m canopy grid (share under trees and their height: TreeSource grows its own trees to match, the real trees'
 * density and height, not their exact positions) and, at Westhaven, every boat and pontoon of the marina.
 * Herne Bay and Westhaven lie inside the real-streets region (aucklandRoads.ts), so the LINZ streets are drawn around
 * them. Mission Bay lies outside it: the procedural grid and houses stop on its footprint (aucklandSites.ts siteRings →
 * Scenery.siteMask) and its LINZ streets are road ribbons (tools/linz/neighbourhoodStreets.ts). Every area's buildings
 * join the LINZ list (aucklandBuildings.ts applyNeighbourhoods) for the scenery, collision and collapse.
 * Without the file the region shows what it shows without buildings: the LINZ streets and the paved block pattern.
 */
import neighbourhoodsUrl from './data/auckland-neighbourhoods.bin?url';
import { fetchMaybeGzip } from '../terrain/theaters/aucklandLinz';
import type { PitchedRoof } from './pitchedRoof';

export const NEIGHBOURHOODS_URL: string = neighbourhoodsUrl;

export interface NbPart {
  /** Footprint, flat [x0, z0, ...] (m, game XZ), counter-clockwise on the map. */
  ring: Float32Array;
  /** Flat roof (or eave) height above the ground at the footprint's centroid (m). */
  eave: number;
  /** Gable or hip roof over the footprint; null = flat. */
  roof: Omit<PitchedRoof, 'eave'> | null;
  /** sRGB 0xRRGGBB. */
  roofColor: number;
  wallColor: number;
}

export interface NbBoat {
  x: number;
  z: number;
  /** Bow direction from +X towards +Z (rad). */
  heading: number;
  length: number;
  beam: number;
  /** Heights above the water (m); mast 0 = none seen. */
  deck: number;
  cabin: number;
  mast: number;
  color: number;
}

export interface CanopyGrid {
  x0: number;
  z0: number;
  cell: number;
  nx: number;
  nz: number;
  /** Share of the cell under canopy, 0 … 15 (sixteenths, 15 = all). */
  cover: Uint8Array;
  /** Canopy p75 height (0.5 m steps). */
  height: Uint8Array;
}

export interface Neighbourhood {
  name: string;
  footprint: Float32Array;
  /** Buildings, each its parts (a terraced roof has several), the largest first. */
  buildings: NbPart[][];
  canopy: CanopyGrid;
  boats: NbBoat[];
  pontoons: Float32Array[];
}

const MAGIC = 'AKLN';
const VERSION = 1;

let current: Neighbourhood[] | null = null;
let version = 0;

/** Decoded neighbourhoods, or null when they have not been (or could not be) loaded. */
export function aucklandNeighbourhoods(): Neighbourhood[] | null {
  return current;
}

export function aucklandNeighbourhoodsVersion(): number {
  return version;
}

/** Install decompressed bytes (null clears). Throws on malformed data. */
export function setAucklandNeighbourhoods(bytes: Uint8Array | null): void {
  current = bytes ? decodeNeighbourhoods(bytes) : null;
  version++;
}

export async function loadAucklandNeighbourhoods(url = NEIGHBOURHOODS_URL): Promise<boolean> {
  if (current) return true;
  try {
    setAucklandNeighbourhoods(await fetchMaybeGzip(url));
    return true;
  } catch (err) {
    console.warn('[world] hero neighbourhoods unavailable', err);
    return false;
  }
}

export function decodeNeighbourhoods(bytes: Uint8Array): Neighbourhood[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== MAGIC || dv.getUint32(4, true) !== VERSION) throw new Error('bad neighbourhoods header');
  const q = dv.getFloat32(8, true);
  const nAreas = dv.getUint32(12, true);
  let o = 16;
  const need = (k: number) => {
    if (o + k > bytes.length) throw new Error('bad neighbourhoods size');
  };
  const u8 = () => (need(1), bytes[o++]);
  const u16 = () => (need(2), (o += 2), dv.getUint16(o - 2, true));
  const f32 = () => (need(4), (o += 4), dv.getFloat32(o - 4, true));
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
  let px = 0;
  let pz = 0;
  const vertex = (): [number, number] => {
    px += zig();
    pz += zig();
    return [px * q, pz * q];
  };
  const ring = () => {
    const n = varint();
    const r = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) r.set(vertex(), i * 2);
    return r;
  };
  const rgb = () => (u8() << 16) | (u8() << 8) | u8();
  const out: Neighbourhood[] = [];
  for (let a = 0; a < nAreas; a++) {
    const len = u8();
    need(len);
    const name = new TextDecoder().decode(bytes.subarray(o, o + len));
    o += len;
    const footprint = ring();
    const buildings: NbPart[][] = [];
    for (let i = 0, n = varint(); i < n; i++) {
      const parts: NbPart[] = [];
      for (let k = 0, np = varint(); k < np; k++) {
        const kind = u8();
        const eave = varint() / 10;
        let roof: NbPart['roof'] = null;
        let rel: [number, number] | null = null;
        if (kind === 1 || kind === 2) {
          const pitch = u8() / 100;
          const ang = (u16() / 65536) * Math.PI;
          const ha = varint() / 10;
          const hb = varint() / 10;
          rel = [zig() / 10, zig() / 10];
          roof = { kind, pitch, cx: 0, cz: 0, ax: Math.cos(ang), az: Math.sin(ang), a: ha, b: hb };
        } else if (kind !== 0) throw new Error('bad neighbourhoods roof');
        const roofColor = rgb();
        const wallColor = rgb();
        const r = ring();
        if (roof && rel) {
          roof.cx = r[0] + rel[0];
          roof.cz = r[1] + rel[1];
        }
        parts.push({ ring: r, eave, roof, roofColor, wallColor });
      }
      buildings.push(parts);
    }
    const x0 = f32();
    const z0 = f32();
    const cell = u8();
    const nx = u16();
    const nz = u16();
    need(nx * nz * 2);
    const cover = bytes.slice(o, o + nx * nz);
    o += nx * nz;
    const height = bytes.slice(o, o + nx * nz);
    o += nx * nz;
    const boats: NbBoat[] = [];
    for (let i = 0, n = varint(); i < n; i++) {
      const [x, z] = vertex();
      boats.push({
        x,
        z,
        heading: (u8() / 256) * Math.PI * 2,
        length: u8() * 0.2,
        beam: u8() / 10,
        deck: u8() / 10,
        cabin: u8() / 10,
        mast: u8() * 0.2,
        color: rgb(),
      });
    }
    const pontoons: Float32Array[] = [];
    for (let i = 0, n = varint(); i < n; i++) pontoons.push(ring());
    out.push({ name, footprint, buildings, canopy: { x0, z0, cell, nx, nz, cover, height }, boats, pontoons });
  }
  if (o !== bytes.length) throw new Error('bad neighbourhoods size');
  return out;
}

function inRing(r: ArrayLike<number>, x: number, z: number): boolean {
  let c = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

/** The neighbourhood whose footprint holds (x, z), or null. */
export function neighbourhoodAt(x: number, z: number, list = current): Neighbourhood | null {
  if (!list) return null;
  for (const n of list) if (inRing(n.footprint, x, z)) return n;
  return null;
}

/** Canopy share (0 … 1) and height (m) of the grid cell holding (x, z); null outside the grid. */
export function canopyAt(g: CanopyGrid, x: number, z: number): { cover: number; height: number } | null {
  const i = Math.floor((x - g.x0) / g.cell);
  const j = Math.floor((z - g.z0) / g.cell);
  if (i < 0 || j < 0 || i >= g.nx || j >= g.nz) return null;
  const k = j * g.nx + i;
  return { cover: g.cover[k] / 15, height: g.height[k] / 2 };
}
