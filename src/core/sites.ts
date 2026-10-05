/**
 * Strategic sites of the Auckland theatre that gameplay may need without the scenery data:
 * the storage tanks of the Wiri oil terminal (AKL.wiri) and every helipad (HELIPADS, #125).
 *
 * Positions and radii are the OpenStreetMap `man_made=storage_tank` footprints inside the terminal's
 * `industrial=oil` outline, from the baked src/world/scenery/data/auckland-osm.bin (tools/osm, © OpenStreetMap
 * contributors, ODbL 1.0). Like src/core/airfields.ts this table is synchronous and always present;
 * tests/world-sites.test.ts keeps it in step with the bake.
 *
 * The scenery draws these tanks (scenery/aucklandSites.ts). A mission that wants them as strike
 * targets spawns `fuel` ground targets on them, e.g.
 * `WIRI_TANKS.filter((t) => t.fuel).map((t, i) => target(`wiri${i}`, 'wiri', 'fuel', t))`.
 */
import { HELIPADS_DATA } from './helipadsData';

export interface StorageTank {
  /** Centre (m, world XZ). */
  x: number;
  z: number;
  /** Radius (m). */
  r: number;
  /** Tagged as holding fuel or oil. */
  fuel: boolean;
}

/** The Wiri oil terminal's storage tanks (west → east). */
export const WIRI_TANKS: readonly StorageTank[] = [
  { x: 7606, z: 17686, r: 14.5, fuel: true },
  { x: 7675, z: 17630, r: 13.5, fuel: true },
  { x: 7683, z: 17675, r: 14.5, fuel: true },
  { x: 7742, z: 17619, r: 13.5, fuel: true },
  { x: 7749, z: 17663, r: 14, fuel: true },
  { x: 7755, z: 17494, r: 7, fuel: false },
  { x: 7777, z: 17491, r: 7.5, fuel: false },
  { x: 7825, z: 17608, r: 13, fuel: true },
  { x: 7832, z: 17651, r: 12, fuel: true },
  { x: 7909, z: 17622, r: 18.5, fuel: true },
  { x: 7919, z: 17690, r: 21, fuel: true },
];

/* ───────────────────────────── Helipads (#125) ───────────────────────────── */

/** What a helipad belongs to: the area containing it in OpenStreetMap (or a standalone heliport). */
export type HelipadKind = 'hospital' | 'airfield' | 'naval' | 'vineyard' | 'heliport' | 'other';

/** Where a pad is, for counting (the boxes of HELIPAD_AREAS; the rest is 'other'). */
export type HelipadArea = 'waiheke' | 'north_shore' | 'isthmus' | 'other';

/**
 * One helipad or heliport of the theatre: every OpenStreetMap `aeroway=helipad` / `aeroway=heliport` in the world
 * box (generated src/core/helipadsData.ts, baked by tools/osm/helipads.py; © OpenStreetMap contributors, ODbL 1.0).
 */
export interface Helipad {
  /** Stable id: the parent site's or the pad's name in snake case (numbered when repeated), else the area's. */
  id: string;
  /** The pad's OSM name, else its site's (may be empty). */
  name: string;
  /** Centre (m, world XZ). */
  x: number;
  z: number;
  /** Pad surface height (m): rooftop pads at the 2024 LiDAR DSM; ground pads the LiDAR DEM (the game's terrain carries them). */
  height: number;
  /** Heading of the pad's long side (rad, 0 = north, clockwise, folded to [0, π)); 0 for a pad mapped as a node. */
  heading: number;
  /** Long and short side (m): a polygon's minimum rectangle, or a node's tagged diameter / width (default 20 m). */
  size: number;
  width: number;
  kind: HelipadKind;
  /** The parent site's name (hospital, airfield, naval base, vineyard), '' when none. */
  site: string;
  /** On a roof (tagged `location=roof`, inside a building outline, or a hospital pad with the LiDAR surface ≥ 4 m up). */
  roof: boolean;
  /** `aeroway=heliport` (rather than a single pad). */
  heliport: boolean;
  area: HelipadArea;
  /** The OSM object: 'n' node / 'w' way / 'r' relation + id. */
  osm: string;
}

/** The counting areas (game XZ boxes, m: x0, z0, x1, z1); keep in sync with AREAS in tools/osm/helipads.py. */
export const HELIPAD_AREAS: Readonly<Record<Exclude<HelipadArea, 'other'>, readonly [number, number, number, number]>> = {
  waiheke: [18_500, -10_500, 36_500, 3_000],
  north_shore: [-8_000, -22_000, 6_000, -1_900],
  isthmus: [-9_000, -1_900, 14_000, 14_000],
};

/** The counting area of a point. */
export function helipadArea(x: number, z: number): HelipadArea {
  for (const [name, [x0, z0, x1, z1]] of Object.entries(HELIPAD_AREAS)) if (x >= x0 && x <= x1 && z >= z0 && z <= z1) return name as HelipadArea;
  return 'other';
}

/**
 * Every helipad and heliport in the world box. Synchronous and always present, like WIRI_TANKS: the scenery draws
 * them (scenery/helipads.ts) and the civil helicopters fly between them. tests/world-helipads.test.ts keeps the
 * table in step with the bake's manifest.
 */
export const HELIPADS: readonly Helipad[] = HELIPADS_DATA;

/** A pad by id. */
export function helipad(id: string): Helipad | undefined {
  return HELIPADS.find((p) => p.id === id);
}
