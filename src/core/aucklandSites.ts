/**
 * F35-A — strike-capable Auckland sites for mission content (Open data 2): the Wiri oil terminal's storage tanks.
 *
 * Positions and diameters are copied from the OpenStreetMap bake (tools/osm, man_made=storage_tank) so gameplay
 * never depends on the baked file being loaded; tests/world-waterfront.test.ts checks them against the bake within
 * 2 m. The scenery draws the tanks (world/scenery/waterfront.ts); a mission that wants one burnt places a `fuel`
 * ground target on it (wiriTarget), and the scenery leaves out the tanks under that target's flat pad, so the
 * entity's own model stands in for them.
 */

export interface StorageTank {
  /** Centre (world m). */
  x: number;
  z: number;
  /** Diameter (m). */
  d: number;
  /** Holds fuel / oil / gas (OSM content tag); the two water / fire-fighting tanks are false. */
  fuel: boolean;
}

/** Wiri Oil Services (Shell / Mobil / BP / Z) and the Liquigas LPG depot, from south-west to north-east. */
export const WIRI_TANKS: readonly StorageTank[] = [
  { x: 7712.3, z: 17232.6, d: 21.9, fuel: true },
  { x: 7723.1, z: 17257.5, d: 21.8, fuel: true },
  { x: 7701.9, z: 17460.8, d: 56.6, fuel: true },
  { x: 7754.9, z: 17494.5, d: 14.4, fuel: false },
  { x: 7776.5, z: 17491.3, d: 15.5, fuel: false },
  { x: 7741.5, z: 17619.4, d: 26.7, fuel: true },
  { x: 7675.5, z: 17629.6, d: 27.1, fuel: true },
  { x: 7749.1, z: 17663.3, d: 27.7, fuel: true },
  { x: 7682.8, z: 17674.6, d: 29.1, fuel: true },
  { x: 7606.4, z: 17686.1, d: 29.1, fuel: true },
  { x: 7824.6, z: 17607.7, d: 26.0, fuel: true },
  { x: 7832.0, z: 17651.2, d: 24.1, fuel: true },
  { x: 7909.0, z: 17622.0, d: 37.4, fuel: true },
  { x: 7918.8, z: 17690.0, d: 42.1, fuel: true },
];

/** Mission position of Wiri tank `i` (a `fuel` ground target placed here replaces the scenery tanks under its pad). */
export function wiriTarget(i: number): { x: number; z: number } {
  const t = WIRI_TANKS[i];
  return { x: Math.round(t.x), z: Math.round(t.z) };
}
