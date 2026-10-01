/**
 * LINZ building footprints with LiDAR heights for the Auckland CBD (phase 2b: the real skyline).
 *
 * src/world/terrain/data/auckland-buildings.bin is baked offline by tools/linz/buildings.py +
 * buildings.ts from Toitū Te Whenua LINZ open data (CC BY 4.0): NZ Building Outlines (layer 101290)
 * and the Auckland 2024 LiDAR 1 m DSM / DEM (height = DSM − DEM inside each footprint), reprojected to
 * game XZ with geoToWorld (src/core/auckland.ts). It holds every building of the CBD region
 * (aucklandRoads.ts) as one or more prisms: a footprint ring and a roof height above the ground. A
 * tower on a podium is two prisms (the podium's footprint and the tower's), both from the ground.
 * Buildings completed after the 2017 outline capture are traced from the LiDAR (flag bit 0).
 * One small gzip file, fetched once per page load next to the road data; when it is missing the CBD
 * falls back to the procedural towers on the real streets (auckland.ts buildRealCBD).
 *
 * Format (little-endian): 'AKLB' | u32 version | f32 quantum (m) | u32 buildings | u32 prisms |
 * buildings: u8 flags (bit 0 = traced from the LiDAR), varint prisms; prisms: varint (height in dm
 * << 1 | sloped), if sloped two zig-zag varint roof slopes (east, south; 0.01 m/m), varint vertex
 * count, vertices. Vertices are zig-zag varint deltas (in quanta) from the previous vertex written
 * (the first from the origin), rings counter-clockwise on the map (+X east, +Z south). A sloped
 * roof's height is given at the ring's area centroid.
 */
import buildingsUrl from '../terrain/data/auckland-buildings.bin?url';
import { fetchMaybeGzip } from '../terrain/theaters/aucklandLinz';

/** Resolved by Vite relative to the bundle (works from the game, the labs and the artifact build). */
export const BUILDINGS_URL: string = buildingsUrl;

export interface BuildingPrism {
  /** Roof height above the ground (m); at the centroid (cx, cz) for a sloped roof. */
  h: number;
  /** Footprint ring, flat [x0, z0, x1, z1, ...] (m, game XZ), closed implicitly. */
  ring: Float32Array;
  /** Roof slope (m/m) towards +X (east) and +Z (south): a tilted plane (wedge crowns); 0 = flat. */
  sx: number;
  sz: number;
  /** Area centroid of the ring (m), set by the decoder. */
  cx: number;
  cz: number;
}

/** Roof height of a prism above the ground at (x, z) (m). */
export function roofHeight(p: BuildingPrism, x: number, z: number): number {
  return p.h + p.sx * (x - p.cx) + p.sz * (z - p.cz);
}

/** Area centroid of a flat ring. */
export function ringCentroid(r: ArrayLike<number>): [number, number] {
  let a = 0;
  let cx = 0;
  let cz = 0;
  const n = r.length / 2;
  // relative to the first vertex (precision)
  const x0 = r[0];
  const z0 = r[1];
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xj = r[j * 2] - x0;
    const zj = r[j * 2 + 1] - z0;
    const xi = r[i * 2] - x0;
    const zi = r[i * 2 + 1] - z0;
    const c = xj * zi - xi * zj;
    a += c;
    cx += (xj + xi) * c;
    cz += (zj + zi) * c;
  }
  if (Math.abs(a) < 1e-9) return [x0, z0];
  return [x0 + cx / (3 * a), z0 + cz / (3 * a)];
}

export interface Building {
  /** Traced from the 2024 LiDAR (no 2017 outline: completed since). */
  lidar: boolean;
  /** The first prism is the whole footprint (or the tallest part); towers on a podium follow. */
  prisms: BuildingPrism[];
}

const MAGIC = 'AKLB';
const VERSION = 1;

let current: Building[] | null = null;
let version = 0;

/** Decoded buildings, or null when they have not been (or could not be) loaded. */
export function aucklandBuildings(): Building[] | null {
  return current;
}

/** Changes whenever the installed data changes (cache key for derived data). */
export function aucklandBuildingsVersion(): number {
  return version;
}

/** Install decompressed bytes (null clears → procedural fallback). Throws on malformed data. */
export function setAucklandBuildings(bytes: Uint8Array | null): void {
  current = bytes ? decodeBuildings(bytes) : null;
  version++;
}

/** Fetch, decompress and install the data; false (fallback kept) on any failure. */
export async function loadAucklandBuildings(url = BUILDINGS_URL): Promise<boolean> {
  if (current) return true;
  try {
    setAucklandBuildings(await fetchMaybeGzip(url));
    return true;
  } catch (err) {
    console.warn('[world] LINZ Auckland buildings unavailable, using the procedural CBD', err);
    return false;
  }
}

/** Signed area of a flat ring (m², + counter-clockwise on the map: +X east, +Z south). */
export function ringArea(r: ArrayLike<number>): number {
  let a = 0;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += r[j * 2] * r[i * 2 + 1] - r[i * 2] * r[j * 2 + 1];
  return a / 2;
}

const zig = (v: number) => (v < 0 ? -2 * v - 1 : 2 * v);
const unzig = (z: number) => (z % 2 ? -(z + 1) / 2 : z / 2);

/** Encode buildings (vertices quantised to `quantum` m, heights to 0.1 m). Used by the bake and the tests. */
export function encodeBuildings(bs: Building[], quantum = 0.25): Uint8Array {
  const out: number[] = [];
  const u32 = (v: number) => out.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
  const varint = (v: number) => {
    do {
      let b = v % 128;
      v = Math.floor(v / 128);
      if (v > 0) b |= 128;
      out.push(b);
    } while (v > 0);
  };
  for (const c of MAGIC) out.push(c.charCodeAt(0));
  u32(VERSION);
  const f = new Uint8Array(new Float32Array([quantum]).buffer);
  out.push(...f);
  u32(bs.length);
  u32(bs.reduce((s, b) => s + b.prisms.length, 0));
  let px = 0;
  let pz = 0;
  for (const b of bs) {
    out.push(b.lidar ? 1 : 0);
    varint(b.prisms.length);
    for (const p of b.prisms) {
      const qsx = Math.round(p.sx * 100);
      const qsz = Math.round(p.sz * 100);
      const sloped = qsx !== 0 || qsz !== 0;
      varint(Math.max(0, Math.round(p.h * 10)) * 2 + (sloped ? 1 : 0));
      if (sloped) {
        varint(zig(qsx));
        varint(zig(qsz));
      }
      varint(p.ring.length / 2);
      for (let i = 0; i < p.ring.length; i += 2) {
        const qx = Math.round(p.ring[i] / quantum);
        const qz = Math.round(p.ring[i + 1] / quantum);
        varint(zig(qx - px));
        varint(zig(qz - pz));
        px = qx;
        pz = qz;
      }
    }
  }
  return Uint8Array.from(out);
}

export function decodeBuildings(bytes: Uint8Array): Building[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== MAGIC || dv.getUint32(4, true) !== VERSION) throw new Error('bad LINZ buildings header');
  const q = dv.getFloat32(8, true);
  const n = dv.getUint32(12, true);
  const nPrisms = dv.getUint32(16, true);
  let o = 20;
  const varint = () => {
    let v = 0;
    let mul = 1;
    for (;;) {
      if (o >= bytes.length) throw new Error('bad LINZ buildings size');
      const b = bytes[o++];
      v += (b & 127) * mul;
      if (b < 128) return v;
      mul *= 128;
    }
  };
  let px = 0;
  let pz = 0;
  let total = 0;
  const out: Building[] = [];
  for (let i = 0; i < n; i++) {
    if (o >= bytes.length) throw new Error('bad LINZ buildings size');
    const flags = bytes[o++];
    const np = varint();
    const prisms: BuildingPrism[] = [];
    for (let k = 0; k < np; k++) {
      const hs = varint();
      const sloped = hs % 2 === 1;
      const sx = sloped ? unzig(varint()) / 100 : 0;
      const sz = sloped ? unzig(varint()) / 100 : 0;
      const nv = varint();
      const ring = new Float32Array(nv * 2);
      for (let v = 0; v < nv; v++) {
        px += unzig(varint());
        pz += unzig(varint());
        ring[v * 2] = px * q;
        ring[v * 2 + 1] = pz * q;
      }
      const [cx, cz] = ringCentroid(ring);
      prisms.push({ h: Math.floor(hs / 2) / 10, ring, sx, sz, cx, cz });
    }
    total += np;
    out.push({ lidar: (flags & 1) === 1, prisms });
  }
  if (o !== bytes.length || total !== nPrisms) throw new Error('bad LINZ buildings size');
  return out;
}
