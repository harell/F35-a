/**
 * F35-A — CBD skyscrapers as obstacles (SIM-CORE, #128).
 *
 * The CBD skyline is drawn from the LINZ building outlines with LiDAR heights
 * (world/scenery/aucklandBuildings.ts). This module gives the sim the tall ones as solid prisms: a
 * footprint ring from the ground up to the roof. An aircraft that flies into one is destroyed and
 * the building collapses (Collisions.buildingImpacts). Like the Sky Tower, a collapsed building is
 * standing again at the next mission start (a fresh SimWorld starts with none collapsed).
 *
 * The prisms sit in a coarse XZ grid, and a segment is tested only below the tallest roof and inside
 * the index's bounds, so it costs nothing outside the CBD. The geometry is cached per installed data
 * (aucklandBuildingsVersion) and terrain; which buildings are down is per world (BuildingIndex.collapsed).
 *
 * Spark Arena (core/sparkArena.ts), the hand-built landmark east of the LINZ building box, joins the
 * index as a `fixed` building (id −1, after the LINZ ones): flying into it crashes the aircraft like a
 * tower does, but it never collapses. It is there with or without the LINZ building data.
 */
import type { Vector3 } from 'three';
import { SPARK_ARENA, sparkArenaSolids } from '../core/sparkArena';
import { aucklandBuildings, aucklandBuildingsVersion } from '../world/scenery/aucklandBuildings';

/** Roof height above the ground (m) from which a building is a skyscraper the sim knows about (≈ 12 storeys). */
export const SKYSCRAPER_MIN_HEIGHT = 40;
/** Grid cell size of the index (m). */
const CELL = 64;

export interface SolidPrism {
  /** Footprint ring, flat [x0, z0, x1, z1, ...] (m, game XZ). */
  readonly ring: Float32Array;
  /** Ground (base) and roof heights (m, world Y). */
  readonly y0: number;
  readonly y1: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface SolidBuilding {
  /** Index into aucklandBuildings() (the scenery's building list). */
  readonly id: number;
  readonly prisms: readonly SolidPrism[];
  /** Footprint centre (m) and the ground and tallest roof heights (world Y). */
  readonly x: number;
  readonly z: number;
  readonly ground: number;
  readonly top: number;
  /** A landmark that stands whatever hits it (Spark Arena): never collapsed, no 'building:collapsed'. */
  readonly fixed?: boolean;
}

export interface BuildingGeometry {
  readonly buildings: readonly SolidBuilding[];
  /** Tallest roof (world Y): nothing above it can hit a building. */
  readonly maxTop: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  /** cell key → building indices (into `buildings`) whose footprint bounds touch the cell. */
  readonly cells: ReadonlyMap<number, readonly number[]>;
}

const cellKey = (ix: number, iz: number) => (ix + 2048) * 4096 + (iz + 2048);

/** Build the solid prisms of every building whose roof is at least `minHeight` above the ground. */
export function buildBuildingGeometry(
  groundAt: (x: number, z: number) => number,
  minHeight = SKYSCRAPER_MIN_HEIGHT,
  list = aucklandBuildings(),
): BuildingGeometry | null {
  const buildings: SolidBuilding[] = [];
  const cells = new Map<number, number[]>();
  let maxTop = -Infinity;
  let gx0 = Infinity;
  let gx1 = -Infinity;
  let gz0 = Infinity;
  let gz1 = -Infinity;
  const add = (id: number, x: number, z: number, parts: readonly { ring: Float32Array; h: number }[], fixed?: boolean) => {
    const ground = groundAt(x, z);
    const prisms: SolidPrism[] = [];
    let top = ground;
    let bx0 = Infinity;
    let bx1 = -Infinity;
    let bz0 = Infinity;
    let bz1 = -Infinity;
    for (const p of parts) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < p.ring.length; i += 2) {
        minX = Math.min(minX, p.ring[i]);
        maxX = Math.max(maxX, p.ring[i]);
        minZ = Math.min(minZ, p.ring[i + 1]);
        maxZ = Math.max(maxZ, p.ring[i + 1]);
      }
      const y1 = ground + p.h;
      prisms.push({ ring: p.ring, y0: ground - 5, y1, minX, maxX, minZ, maxZ });
      top = Math.max(top, y1);
      bx0 = Math.min(bx0, minX);
      bx1 = Math.max(bx1, maxX);
      bz0 = Math.min(bz0, minZ);
      bz1 = Math.max(bz1, maxZ);
    }
    const k = buildings.length;
    buildings.push(fixed ? { id, prisms, x, z, ground, top, fixed } : { id, prisms, x, z, ground, top });
    maxTop = Math.max(maxTop, top);
    gx0 = Math.min(gx0, bx0);
    gx1 = Math.max(gx1, bx1);
    gz0 = Math.min(gz0, bz0);
    gz1 = Math.max(gz1, bz1);
    for (let ix = Math.floor(bx0 / CELL); ix <= Math.floor(bx1 / CELL); ix++) {
      for (let iz = Math.floor(bz0 / CELL); iz <= Math.floor(bz1 / CELL); iz++) {
        const key = cellKey(ix, iz);
        const c = cells.get(key);
        if (c) c.push(k);
        else cells.set(key, [k]);
      }
    }
  };
  for (let id = 0; list && id < list.length; id++) {
    const b = list[id];
    if (!b.prisms.length || !b.prisms.some((p) => p.h >= minHeight)) continue;
    add(id, b.prisms[0].cx, b.prisms[0].cz, b.prisms);
  }
  // Spark Arena: its roof outline in 10 m cells, each as high as the roof over it (core/sparkArena.ts)
  add(-1, SPARK_ARENA.x, SPARK_ARENA.z, sparkArenaSolids(), true);
  if (!buildings.length) return null;
  return { buildings, maxTop, minX: gx0, maxX: gx1, minZ: gz0, maxZ: gz1, cells };
}

/**
 * First contact of the segment a→b with a vertical prism (ring from y0 up to y1): the fraction along
 * the segment (0..1), or -1. Exact: the segment is clipped to the height band, then tested against
 * the footprint (start inside, or the first crossing of an edge), so a fast jet can't tunnel through
 * a thin tower in one step.
 */
export function prismSegmentHit(p: SolidPrism, a: Vector3, b: Vector3): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  // height band
  let lo = 0;
  let hi = 1;
  if (Math.abs(dy) < 1e-9) {
    if (a.y < p.y0 || a.y > p.y1) return -1;
  } else {
    const u = (p.y0 - a.y) / dy;
    const v = (p.y1 - a.y) / dy;
    lo = Math.max(lo, Math.min(u, v));
    hi = Math.min(hi, Math.max(u, v));
    if (lo > hi) return -1;
  }
  // footprint bounds
  const sx = a.x + dx * lo;
  const sz = a.z + dz * lo;
  const ex = a.x + dx * hi;
  const ez = a.z + dz * hi;
  if (Math.max(sx, ex) < p.minX || Math.min(sx, ex) > p.maxX || Math.max(sz, ez) < p.minZ || Math.min(sz, ez) > p.maxZ) return -1;
  if (pointInRing(p.ring, sx, sz)) return lo;
  // first edge crossing of the clipped segment
  const r = p.ring;
  const n = r.length / 2;
  const cx = ex - sx;
  const cz = ez - sz;
  let best = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const x1 = r[j * 2];
    const z1 = r[j * 2 + 1];
    const ux = r[i * 2] - x1;
    const uz = r[i * 2 + 1] - z1;
    const den = cx * uz - cz * ux;
    if (Math.abs(den) < 1e-12) continue;
    const wx = x1 - sx;
    const wz = z1 - sz;
    const t = (wx * uz - wz * ux) / den;
    const s = (wx * cz - wz * cx) / den;
    if (t >= 0 && t <= 1 && s >= 0 && s <= 1 && t < best) best = t;
  }
  return best === Infinity ? -1 : lo + (hi - lo) * best;
}

/** Even-odd point-in-polygon test on a flat ring. */
export function pointInRing(r: ArrayLike<number>, x: number, z: number): boolean {
  let inside = false;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[i * 2];
    const zi = r[i * 2 + 1];
    const xj = r[j * 2];
    const zj = r[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

let cached: { version: number; terrain: object; minHeight: number; geo: BuildingGeometry | null } | null = null;

/** The shared geometry for the installed building data and this terrain (cached). */
export function buildingGeometry(
  terrain: { surfaceHeightAt(x: number, z: number): number },
  minHeight = SKYSCRAPER_MIN_HEIGHT,
): BuildingGeometry | null {
  const version = aucklandBuildingsVersion();
  if (cached && cached.version === version && cached.terrain === terrain && cached.minHeight === minHeight) return cached.geo;
  cached = { version, terrain, minHeight, geo: buildBuildingGeometry((x, z) => terrain.surfaceHeightAt(x, z), minHeight) };
  return cached.geo;
}

/** The CBD's skyscrapers in one world: shared geometry plus which ones are down. */
export class BuildingIndex {
  /** `buildings` indices of the collapsed ones (reset by reset(), and new in every SimWorld). */
  readonly collapsed = new Set<number>();
  /** Bumped whenever `collapsed` changes (the scenery follows it). */
  version = 0;
  private readonly seen = new Set<number>();

  constructor(readonly geo: BuildingGeometry) {}

  /** Mark building `k` (index into geo.buildings) collapsed (a `fixed` one never is). */
  collapse(k: number): void {
    if (this.collapsed.has(k) || this.geo.buildings[k].fixed) return;
    this.collapsed.add(k);
    this.version++;
  }

  reset(): void {
    if (!this.collapsed.size) return;
    this.collapsed.clear();
    this.version++;
  }

  /**
   * Highest standing roof (world Y) whose footprint bounds come within `r` of (x, z), or -Infinity:
   * the AI's ground floor over the CBD (ai/pilot/safety.ts), so AI pilots keep their clearance over
   * the towers as over the terrain.
   */
  roofNear(x: number, z: number, r: number): number {
    const g = this.geo;
    if (x < g.minX - r || x > g.maxX + r || z < g.minZ - r || z > g.maxZ + r) return -Infinity;
    let best = -Infinity;
    for (let ix = Math.floor((x - r) / CELL); ix <= Math.floor((x + r) / CELL); ix++) {
      for (let iz = Math.floor((z - r) / CELL); iz <= Math.floor((z + r) / CELL); iz++) {
        const c = g.cells.get(cellKey(ix, iz));
        if (!c) continue;
        for (const k of c) {
          if (this.collapsed.has(k)) continue;
          const b = g.buildings[k];
          if (b.top <= best) continue;
          for (const p of b.prisms) {
            if (p.y1 > best && x > p.minX - r && x < p.maxX + r && z > p.minZ - r && z < p.maxZ + r) best = p.y1;
          }
        }
      }
    }
    return best;
  }

  /** Standing building whose prisms the segment a→b enters first (and the contact fraction), or null. */
  firstHit(a: Vector3, b: Vector3): { building: SolidBuilding; index: number; s: number } | null {
    const g = this.geo;
    if (Math.min(a.y, b.y) > g.maxTop) return null;
    if (Math.max(a.x, b.x) < g.minX || Math.min(a.x, b.x) > g.maxX || Math.max(a.z, b.z) < g.minZ || Math.min(a.z, b.z) > g.maxZ) return null;
    const seen = this.seen;
    seen.clear();
    let best: { building: SolidBuilding; index: number; s: number } | null = null;
    const ix0 = Math.floor(Math.min(a.x, b.x) / CELL);
    const ix1 = Math.floor(Math.max(a.x, b.x) / CELL);
    const iz0 = Math.floor(Math.min(a.z, b.z) / CELL);
    const iz1 = Math.floor(Math.max(a.z, b.z) / CELL);
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iz = iz0; iz <= iz1; iz++) {
        const c = g.cells.get(cellKey(ix, iz));
        if (!c) continue;
        for (const k of c) {
          if (seen.has(k) || this.collapsed.has(k)) continue;
          seen.add(k);
          const bld = g.buildings[k];
          for (const p of bld.prisms) {
            const s = prismSegmentHit(p, a, b);
            if (s >= 0 && (!best || s < best.s)) best = { building: bld, index: k, s };
          }
        }
      }
    }
    return best;
  }
}
