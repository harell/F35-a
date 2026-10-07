/**
 * The landmark buildings of the theatre outside the CBD (#124): hospitals, railway stations with their platforms,
 * shopping malls and schools, from OpenStreetMap sites, LINZ building outlines and the 2024 LiDAR.
 *
 * src/world/terrain/data/auckland-landmarks.bin is baked offline by tools/linz/landmark-buildings.py + .ts:
 * the sites are OpenStreetMap areas (© OpenStreetMap contributors, ODbL: `amenity=hospital`, `shop=mall`,
 * `railway=station` with its `railway=platform`s, `amenity=school`), the buildings the Toitū Te Whenua LINZ NZ
 * Building Outlines (layer 101290, CC BY 4.0) inside them with their heights from the Auckland 2024 LiDAR 1 m DSM − DEM
 * (CC BY 4.0), split into levels as the CBD's are (aucklandBuildings.ts); and the outlines over 600 m² in #121's areas
 * (Devonport, the gulf islands: kind 'other'), which its house scatter leaves out. Platforms are slabs beside the
 * game's own railway ribbons (aucklandRailPaths), where the bake moved each OSM platform (and the canopies over it).
 * The buildings join the LINZ building list (aucklandBuildings: the scenery builds them; the sim leaves them out);
 * the sites keep the procedural street grid, lots and sheds off (siteRings), their footprints the trees and houses.
 * When the file is missing nothing changes (the procedural suburbs).
 *
 * Format (little-endian): 'AKLM' | u32 version (1) | f32 quantum (m) | u32 sites | u32 buildings | u32 prisms |
 * u32 platforms | sites: u8 kind (LANDMARK_KINDS), varint name bytes + UTF-8, varint vertices + vertices (the site's
 * outline), varint buildings (the site's buildings follow the previous site's in the building list) |
 * buildings: u8 flags (bit 0 traced from the LiDAR, bit 1 a platform canopy), varint prisms, prisms as in
 * auckland-buildings.bin (varint height dm << 1 | sloped, [two zig-zag varint slopes 0.01 m/m], varint vertices,
 * vertices) | platforms: varint site, varint vertices, vertices (the slab's outline). Vertices are zig-zag varint
 * deltas (in quanta) from the previous vertex written, rings counter-clockwise on the map (+X east, +Z south).
 */
import landmarksUrl from '../terrain/data/auckland-landmarks.bin?url';
import { fetchMaybeGzip } from '../terrain/theaters/aucklandLinz';
import { ringArea, ringCentroid, type Building, type BuildingPrism } from './aucklandBuildings';
import type { HeightFn, LightList } from './builders';
import { WIN_NONE, type GeometryBuilder } from './GeometryBuilder';

export const LANDMARKS_URL: string = landmarksUrl;

export const LANDMARK_KINDS = ['hospital', 'mall', 'station', 'school', 'other'] as const;
export type LandmarkKind = (typeof LANDMARK_KINDS)[number];

export interface LandmarkSite {
  kind: LandmarkKind;
  /** The OSM name ('' for the 'other' tiles). */
  name: string;
  /** The site's outline (flat [x, z, …], game XZ). */
  ring: Float32Array;
  /** Its buildings: [first, end) in `buildings`. */
  b0: number;
  b1: number;
}

export interface LandmarkBuilding {
  site: number;
  lidar: boolean;
  /** A canopy over a station platform: a roof on posts, not a block. */
  canopy: boolean;
  prisms: BuildingPrism[];
}

export interface LandmarkPlatform {
  site: number;
  /** The slab's outline (flat [x, z, …]). */
  ring: Float32Array;
}

export interface Landmarks {
  sites: LandmarkSite[];
  buildings: LandmarkBuilding[];
  platforms: LandmarkPlatform[];
}

/** A landmark building's part in the LINZ building list (Building.landmark). */
export interface LandmarkTag {
  kind: LandmarkKind;
  site: number;
  canopy: boolean;
}

/** Height of a platform's top above the ground (m): NZ platforms stand ≈ 1.1 m over the rail head. */
export const PLATFORM_HEIGHT = 1.1;

const MAGIC = 'AKLM';
const VERSION = 1;

let current: Landmarks | null = null;
let version = 0;

export function aucklandLandmarks(): Landmarks | null {
  return current;
}

export function aucklandLandmarksVersion(): number {
  return version;
}

/** Install decompressed bytes (null clears). Throws on malformed data. */
export function setAucklandLandmarks(bytes: Uint8Array | null): void {
  current = bytes ? decodeLandmarks(bytes) : null;
  covers = null;
  version++;
}

export async function loadAucklandLandmarks(url = LANDMARKS_URL): Promise<boolean> {
  if (current) return true;
  try {
    setAucklandLandmarks(await fetchMaybeGzip(url));
    return true;
  } catch (err) {
    console.warn('[world] landmark buildings (hospitals, stations, malls, schools) unavailable', err);
    return false;
  }
}

const zig = (v: number) => (v < 0 ? -2 * v - 1 : 2 * v);
const unzig = (z: number) => (z % 2 ? -(z + 1) / 2 : z / 2);

/** Encode (used by the bake and the tests). Sites' buildings must be contiguous and in site order. */
export function encodeLandmarks(d: Landmarks, quantum = 0.25): Uint8Array {
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
  let px = 0;
  let pz = 0;
  const ring = (r: ArrayLike<number>) => {
    varint(r.length / 2);
    for (let i = 0; i < r.length; i += 2) {
      const qx = Math.round(r[i] / quantum);
      const qz = Math.round(r[i + 1] / quantum);
      varint(zig(qx - px));
      varint(zig(qz - pz));
      px = qx;
      pz = qz;
    }
  };
  for (const c of MAGIC) out.push(c.charCodeAt(0));
  u32(VERSION);
  out.push(...new Uint8Array(new Float32Array([quantum]).buffer));
  u32(d.sites.length);
  u32(d.buildings.length);
  u32(d.buildings.reduce((s, b) => s + b.prisms.length, 0));
  u32(d.platforms.length);
  const enc = new TextEncoder();
  d.sites.forEach((s, i) => {
    if (s.b0 !== (i ? d.sites[i - 1].b1 : 0) || s.b1 < s.b0) throw new Error('landmark sites: buildings not contiguous');
    out.push(LANDMARK_KINDS.indexOf(s.kind));
    const name = enc.encode(s.name);
    varint(name.length);
    out.push(...name);
    ring(s.ring);
    varint(s.b1 - s.b0);
  });
  for (const b of d.buildings) {
    out.push((b.lidar ? 1 : 0) | (b.canopy ? 2 : 0));
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
      ring(p.ring);
    }
  }
  for (const p of d.platforms) {
    varint(p.site);
    ring(p.ring);
  }
  return Uint8Array.from(out);
}

export function decodeLandmarks(bytes: Uint8Array): Landmarks {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== MAGIC || dv.getUint32(4, true) !== VERSION) throw new Error('bad landmarks header');
  const q = dv.getFloat32(8, true);
  const nSites = dv.getUint32(12, true);
  const nB = dv.getUint32(16, true);
  const nPrisms = dv.getUint32(20, true);
  const nPl = dv.getUint32(24, true);
  let o = 28;
  const byte = () => {
    if (o >= bytes.length) throw new Error('bad landmarks size');
    return bytes[o++];
  };
  const varint = () => {
    let v = 0;
    let mul = 1;
    for (;;) {
      const b = byte();
      v += (b & 127) * mul;
      if (b < 128) return v;
      mul *= 128;
    }
  };
  let px = 0;
  let pz = 0;
  const ring = () => {
    const n = varint();
    const r = new Float32Array(n * 2);
    for (let v = 0; v < n; v++) {
      px += unzig(varint());
      pz += unzig(varint());
      r[v * 2] = px * q;
      r[v * 2 + 1] = pz * q;
    }
    return r;
  };
  const dec = new TextDecoder();
  const sites: LandmarkSite[] = [];
  let b0 = 0;
  for (let i = 0; i < nSites; i++) {
    const k = byte();
    if (k >= LANDMARK_KINDS.length) throw new Error('bad landmark kind');
    const len = varint();
    if (o + len > bytes.length) throw new Error('bad landmarks size');
    const name = dec.decode(bytes.subarray(o, o + len));
    o += len;
    const r = ring();
    const n = varint();
    sites.push({ kind: LANDMARK_KINDS[k], name, ring: r, b0, b1: b0 + n });
    b0 += n;
  }
  if (b0 !== nB) throw new Error('bad landmarks size');
  const buildings: LandmarkBuilding[] = [];
  let total = 0;
  let si = 0;
  for (let i = 0; i < nB; i++) {
    while (si < sites.length && i >= sites[si].b1) si++;
    const flags = byte();
    const np = varint();
    const prisms: BuildingPrism[] = [];
    for (let k = 0; k < np; k++) {
      const hs = varint();
      const sloped = hs % 2 === 1;
      const sx = sloped ? unzig(varint()) / 100 : 0;
      const sz = sloped ? unzig(varint()) / 100 : 0;
      const r = ring();
      const [cx, cz] = ringCentroid(r);
      prisms.push({ h: Math.floor(hs / 2) / 10, ring: r, sx, sz, cx, cz });
    }
    total += np;
    buildings.push({ site: si, lidar: (flags & 1) === 1, canopy: (flags & 2) === 2, prisms });
  }
  const platforms: LandmarkPlatform[] = [];
  for (let i = 0; i < nPl; i++) {
    const site = varint();
    platforms.push({ site, ring: ring() });
  }
  if (o !== bytes.length || total !== nPrisms) throw new Error('bad landmarks size');
  return { sites, buildings, platforms };
}

/**
 * The landmark buildings as LINZ buildings (aucklandBuildings.ts), named after their site, tagged with their kind: the
 * scenery gives them their kind's facade and a mesh per area (Scenery: frustum-culled); the sim's building index
 * leaves them out (sim/buildings.ts).
 */
export function landmarkBuildings(d: Landmarks | null): Building[] {
  if (!d) return [];
  return d.buildings.map((b) => {
    const s = d.sites[b.site];
    const out: Building = { lidar: b.lidar, prisms: b.prisms, landmark: { kind: s.kind, site: b.site, canopy: b.canopy } };
    if (s.name) out.name = s.name;
    return out;
  });
}

/** The site outlines the procedural street grid, lots and sheds keep off (aucklandSites.ts siteRings); not the 'other' tiles. */
export function landmarkSiteRings(d: Landmarks | null = current): Float32Array[] {
  return d ? d.sites.filter((s) => s.kind !== 'other').map((s) => s.ring) : [];
}

/** Bucket grid (CELL m) of the landmark footprints and platforms, for `landmarkCovers`. */
const CELL = 64;
let covers: { key: Map<number, Float32Array[]> } | null = null;
const cellKey = (i: number, j: number) => (i + 4096) * 8192 + (j + 4096);

function bounds(r: ArrayLike<number>): [number, number, number, number] {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    x0 = Math.min(x0, r[i]);
    x1 = Math.max(x1, r[i]);
    z0 = Math.min(z0, r[i + 1]);
    z1 = Math.max(z1, r[i + 1]);
  }
  return [x0, x1, z0, z1];
}

/**
 * True when (x, z) is within `margin` m of a landmark building's footprint or a platform: no tree, procedural or real
 * house (#121) or town-centre block stands there (Scenery's site blocker).
 */
export function landmarkCovers(x: number, z: number, margin = 0): boolean {
  const d = current;
  if (!d) return false;
  if (!covers) {
    const key = new Map<number, Float32Array[]>();
    const add = (r: Float32Array) => {
      const [x0, x1, z0, z1] = bounds(r);
      // (a margin of up to 24 m reaches into the next cell: index the ring there too)
      for (let j = Math.floor((z0 - 24) / CELL); j <= Math.floor((z1 + 24) / CELL); j++)
        for (let i = Math.floor((x0 - 24) / CELL); i <= Math.floor((x1 + 24) / CELL); i++) {
          const k = cellKey(i, j);
          const l = key.get(k);
          if (l) l.push(r);
          else key.set(k, [r]);
        }
    };
    for (const b of d.buildings) for (const p of b.prisms) add(p.ring);
    for (const p of d.platforms) add(p.ring);
    covers = { key };
  }
  const l = covers.key.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
  if (!l) return false;
  const m = Math.min(24, margin);
  for (const r of l) if (ringDistance(r, x, z) <= m) return true;
  return false;
}

/** Signed distance (m) from a point to a ring: negative inside. */
export function ringDistance(r: ArrayLike<number>, x: number, z: number): number {
  let inside = false;
  let d2 = Infinity;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[i * 2], zi = r[i * 2 + 1], xj = r[j * 2], zj = r[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    const dx = xj - xi;
    const dz = zj - zi;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - xi) * dx + (z - zi) * dz) / l2)) : 0;
    const ex = xi + dx * t - x;
    const ez = zi + dz * t - z;
    d2 = Math.min(d2, ex * ex + ez * ez);
  }
  const d = Math.sqrt(d2);
  return inside ? -d : d;
}

/** Keep a ring counter-clockwise on the map (positive ringArea), as the building list's rings are. */
export function ccw(r: Float32Array): Float32Array {
  if (ringArea(r) >= 0) return r;
  const out = new Float32Array(r.length);
  for (let i = 0; i < r.length; i += 2) {
    out[i] = r[r.length - 2 - i];
    out[i + 1] = r[r.length - 1 - i];
  }
  return out;
}

/**
 * The landmark meshes' squares (m): one mesh (draw call) per square with landmarks in it, frustum-culled and hidden
 * beyond LANDMARK_FAR of the camera (a 50 m hospital is ≈ 4 px tall at 8 km on a phone). 6 km squares drew +25 calls
 * over Grafton on medium; 8 km with the cut-off: see the PR's numbers.
 */
export const LANDMARK_TILE = 8000;
export const LANDMARK_FAR = 8000;

/**
 * The station platforms (#124): concrete slabs PLATFORM_HEIGHT over the ground beside the railway ribbons, walls down
 * into it, a yellow safety line along their edges' tops left out (sub-pixel from the air). Into `tileOf`'s builder.
 */
export function buildPlatforms(d: Landmarks, height: HeightFn, tileOf: (x: number, z: number) => GeometryBuilder): number {
  let n = 0;
  for (const p of d.platforms) {
    const [cx, cz] = ringCentroid(p.ring);
    let g0 = Infinity;
    for (let i = 0; i < p.ring.length; i += 2) g0 = Math.min(g0, height(p.ring[i], p.ring[i + 1]));
    n += tileOf(cx, cz).prism(p.ring, g0 - 0.5, (x, z) => height(x, z) + PLATFORM_HEIGHT, 0xa7a59f, 0xbdbbb4, WIN_NONE);
  }
  return n;
}

/**
 * Car-park lamps of the malls (#124): on a 36 m lattice inside each mall's site, off its buildings (8 m), the roads and
 * the water, 9 m up, LED white. At most MALL_LAMPS a mall.
 */
const MALL_LAMPS = 60;
export function buildMallLamps(d: Landmarks, lights: LightList, height: HeightFn, roads: { near(x: number, z: number, m: number): boolean } | null): number {
  let n = 0;
  for (const s of d.sites) {
    if (s.kind !== 'mall') continue;
    const [x0, x1, z0, z1] = bounds(s.ring);
    let k = 0;
    for (let z = z0 + 18; z < z1 && k < MALL_LAMPS; z += 36)
      for (let x = x0 + 18; x < x1 && k < MALL_LAMPS; x += 36) {
        if (ringDistance(s.ring, x, z) > -4 || landmarkCovers(x, z, 8) || roads?.near(x, z, 4)) continue;
        const g = height(x, z);
        if (g < 0.5) continue;
        lights.add(x, g + 9, z, 0xf4f1e6, 3.2);
        k++;
      }
    n += k;
  }
  return n;
}
