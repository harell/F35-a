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
 * The 3D-modelled landmarks join the index as `hero` buildings, with or without the LINZ building data:
 * Spark Arena (core/sparkArena.ts, id −1) and the Auckland War Memorial Museum on the Domain
 * (core/museum.ts, id −10). The policy for a hero (the Sky Tower too, sim/landmarks.ts): the player's
 * jet flying into it crashes and brings it down at once (it explodes and collapses, named on the HUD);
 * anybody else's aircraft or drone crashes on it and it stands. The Domain is terrain, not a building:
 * a crash into the hill leaves the museum standing, and a crash into the museum leaves the hill.
 * The Ports of Auckland's eight ship-to-shore cranes (core/portOfAuckland.ts, ids −2…−9) are `fixed`:
 * their portals up to the A-frame crash an aircraft and never collapse. So is Westfield Newmarket
 * (core/westfieldNewmarket.ts, id −101): its measured blocks crash an aircraft and stand.
 * The Auckland Harbour Bridge is a hero too, one per span (ids −20…−26, core/harbourBridge.ts hbSpanSolids): its deck
 * and through truss with their own bases, so the water and the clearance under the deck stay open; the span the
 * player's jet hits falls into the harbour (world/scenery/bridgeCollapse.ts).
 * Every building here has a name for the HUD and the debrief: a hero's, a tower kit tower's, a Scene apartment's, or
 * the OpenStreetMap name or address of the rest (core/cbdBuildingNames.ts); the port's cranes have none.
 */
import type { Vector3 } from 'three';
import { SPARK_ARENA, sparkArenaSolids } from '../core/sparkArena';
import { PORT_CRANES } from '../core/portOfAuckland';
import { MUSEUM, museumSolids } from '../core/museum';
import { WESTFIELD_CENTRE, WESTFIELD_PRISMS } from '../core/westfieldNewmarket';
import { CBD_BUILDING_NAMES } from '../core/cbdBuildingNames';
import { HB_SUPPORTS, hbAt, hbSpanSolids } from '../core/harbourBridge';
import { aucklandBuildings, aucklandBuildingsVersion, type Building } from '../world/scenery/aucklandBuildings';

/** Roof height above the ground (m) from which a building is a skyscraper the sim knows about (≈ 12 storeys). */
export const SKYSCRAPER_MIN_HEIGHT = 40;
/** A 3D-modelled landmark in the index: what the HUD and the debrief call it. */
export interface HeroBuilding {
  readonly id: 'spark_arena' | 'museum' | 'harbour_bridge';
  /** Its name in a sentence ("Crashed into the Auckland Museum"). */
  readonly name: string;
  /** Its name on the HUD ("AUCKLAND MUSEUM DESTROYED"). */
  readonly label: string;
}

export const HERO_BUILDINGS = {
  spark_arena: { id: 'spark_arena', name: 'Spark Arena', label: 'SPARK ARENA' },
  museum: { id: 'museum', name: 'the Auckland Museum', label: 'AUCKLAND MUSEUM' },
  harbour_bridge: { id: 'harbour_bridge', name: 'the Auckland Harbour Bridge', label: 'HARBOUR BRIDGE' },
} as const satisfies Record<HeroBuilding['id'], HeroBuilding>;

/** Building ids of the hero buildings in the index (the LINZ ones count up from 0). */
export const SPARK_ARENA_ID = -1;
export const MUSEUM_ID = -10;
/** Westfield Newmarket: `fixed`, it stands whatever hits it. */
export const WESTFIELD_ID = -101;
/**
 * The Auckland Harbour Bridge's seven spans (core/harbourBridge.ts HB_SUPPORTS), south to north: ids
 * HARBOUR_BRIDGE_ID − i. Each is a hero of its own, so the span the player's jet flies into falls and the rest stand.
 */
export const HARBOUR_BRIDGE_ID = -20;
export const HARBOUR_BRIDGE_SPANS = HB_SUPPORTS.length - 1;
/** The navigation span (between the main piers): `crashInto('harbour_bridge')` aims at it. */
export const HARBOUR_BRIDGE_MAIN_SPAN = 5;

/**
 * How long a collapsing building takes to come down (s): it stands for COLLAPSE_DELAY while the
 * charges go off, then drops at about free fall to its rubble heap.
 */
export const COLLAPSE_DELAY = 0.7;
export const COLLAPSE_ACCEL = 9.8;
export function buildingCollapseTime(height: number): number {
  return COLLAPSE_DELAY + Math.sqrt((2 * Math.max(1, height)) / COLLAPSE_ACCEL);
}

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
  /** A structure that stands whatever hits it (the port's cranes): never collapsed, no 'building:collapsed'. */
  readonly fixed?: boolean;
  /** A 3D-modelled landmark: only the player's jet brings it down. */
  readonly hero?: HeroBuilding;
  /** What a crash into it is called: in a sentence ("Crashed into the Vero Centre") and on the HUD ("VERO CENTRE"). */
  readonly name?: string;
  readonly label?: string;
  /** Horizontal half-extent of the footprint bounds (m): the collapse's dust and the death cam's framing. */
  readonly radius: number;
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

/**
 * The name of a LINZ building the sim knows: a tower of the tower kit or a Scene apartment carries its own, the rest
 * come from core/cbdBuildingNames.ts (OpenStreetMap names and addresses, a point inside each footprint); a hero
 * neighbourhood's building outside that list is named after its area.
 */
export function buildingName(b: Building): { name: string; label?: string } | undefined {
  if (b.tower) return { name: b.tower.name };
  if (b.name) return { name: b.name };
  const p = b.prisms[0];
  for (const n of CBD_BUILDING_NAMES) {
    if (Math.hypot(n.x - p.cx, n.z - p.cz) < 1.5 || pointInRing(p.ring, n.x, n.z)) return n;
  }
  // a hero neighbourhood's building outside the CBD's name list (the airport's transport hub): its area
  if (b.area) return { name: `a building in ${b.area}`, label: `${b.area.toUpperCase()} BUILDING` };
  return undefined;
}

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
  /** A part's roof is `h` above the ground and its base under the ground, unless it gives its own y0 / y1 (world Y: a bridge deck). */
  const add = (
    id: number,
    x: number,
    z: number,
    parts: readonly { ring: Float32Array; h: number; y0?: number; y1?: number }[],
    fixed?: boolean,
    hero?: HeroBuilding,
    named?: { name: string; label?: string },
    groundY?: number,
  ) => {
    const ground = groundY ?? groundAt(x, z);
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
      const y1 = p.y1 ?? ground + p.h;
      prisms.push({ ring: p.ring, y0: p.y0 ?? ground - 5, y1, minX, maxX, minZ, maxZ });
      top = Math.max(top, y1);
      bx0 = Math.min(bx0, minX);
      bx1 = Math.max(bx1, maxX);
      bz0 = Math.min(bz0, minZ);
      bz1 = Math.max(bz1, maxZ);
    }
    const k = buildings.length;
    const radius = Math.max(bx1 - bx0, bz1 - bz0) / 2;
    const name = hero ? { name: hero.name, label: hero.label } : named ? { name: named.name, label: named.label ?? named.name.toUpperCase() } : {};
    const b: SolidBuilding = { id, prisms, x, z, ground, top, radius, ...(fixed ? { fixed } : {}), ...(hero ? { hero } : {}), ...name };
    buildings.push(b);
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
    add(id, b.prisms[0].cx, b.prisms[0].cz, b.prisms, false, undefined, buildingName(b));
  }
  // Ports of Auckland's ship-to-shore cranes: the portal between the legs, up to the A-frame (core/portOfAuckland.ts)
  PORT_CRANES.forEach((c, i) => {
    const u0 = -35, u1 = -1, v = c.girder > 50 ? 11.5 : 10.5;
    const corner = (u: number, w: number) => [c.x + c.ux * u - c.uz * w, c.z + c.uz * u + c.ux * w];
    const ring = Float32Array.from([...corner(u0, -v), ...corner(u1, -v), ...corner(u1, v), ...corner(u0, v)]);
    const [cx, cz] = corner((u0 + u1) / 2, 0);
    add(-2 - i, cx, cz, [{ ring, h: c.apex }], true);
  });
  // Spark Arena: its roof outline in 10 m cells, each as high as the roof over it (core/sparkArena.ts)
  add(SPARK_ARENA_ID, SPARK_ARENA.x, SPARK_ARENA.z, sparkArenaSolids(), false, HERO_BUILDINGS.spark_arena);
  // the Auckland Museum on the Domain: its measured block, domes and portico columns (core/museum.ts)
  add(MUSEUM_ID, MUSEUM.x, MUSEUM.z, museumSolids(), false, HERO_BUILDINGS.museum);
  // Westfield Newmarket: its measured blocks (core/westfieldNewmarket.ts), a landmark that stands
  add(WESTFIELD_ID, WESTFIELD_CENTRE.x, WESTFIELD_CENTRE.z, WESTFIELD_PRISMS.map((p) => ({ ring: Float32Array.from(p.ring), h: p.h })), true, undefined, { name: 'Westfield Newmarket' });
  // the Harbour Bridge: each span its deck and through truss over the open water (core/harbourBridge.ts hbSpanSolids)
  for (let i = 0; i < HARBOUR_BRIDGE_SPANS; i++) {
    const [x, z] = hbAt((HB_SUPPORTS[i] + HB_SUPPORTS[i + 1]) / 2, 0);
    const parts = hbSpanSolids(i).map((p) => ({ ring: Float32Array.from(p.ring), h: 0, y0: p.y0, y1: p.y1 }));
    add(HARBOUR_BRIDGE_ID - i, x, z, parts, false, HERO_BUILDINGS.harbour_bridge, undefined, 0);
  }
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
  /** Sim time each collapsed building started coming down (the scenery animates the fall from it). */
  readonly collapsedAt = new Map<number, number>();
  /** Bumped whenever `collapsed` changes (the scenery follows it). */
  version = 0;
  private readonly seen = new Set<number>();

  constructor(readonly geo: BuildingGeometry) {}

  /** Mark building `k` (index into geo.buildings) collapsed at sim time `time` (a `fixed` one never is). */
  collapse(k: number, time = 0): void {
    if (this.collapsed.has(k) || this.geo.buildings[k].fixed) return;
    this.collapsed.add(k);
    this.collapsedAt.set(k, time);
    this.version++;
  }

  /** Index (into geo.buildings) of a hero building, or -1. */
  heroIndex(id: HeroBuilding['id']): number {
    return this.geo.buildings.findIndex((b) => b.hero?.id === id);
  }

  reset(): void {
    if (!this.collapsed.size) return;
    this.collapsed.clear();
    this.collapsedAt.clear();
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
