/**
 * Strategic sites of the Auckland theatre that gameplay may need without the scenery data:
 * the storage tanks of the Wiri oil terminal (AKL.wiri).
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
