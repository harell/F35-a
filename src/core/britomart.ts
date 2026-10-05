/**
 * F35-A — Britomart (Waitematā) station, the hero: what the station is above ground, measured.
 *
 *  - The Chief Post Office (1912, John Campbell / John Paton; the main entrance, on Te Komititanga): its LiDAR terraces
 *    are the CBD tower kit's row 202 (core/cbdTowersData.ts); its facade is a skin (core/cbdTowerSkins.ts). Here: the
 *    two lead-grey domes on its west corner pavilions and the flagpole on the front pediment.
 *  - The Glasshouse (2003, Jasmax with Mario Madayag): the glass pavilion behind the CPO, the station's east entrance on
 *    the Commerce St plaza, with the "Waitematā" sign over its canopy. A kit-style landmark (GLASSHOUSE) so the
 *    scenery, collision and collapse treat it like the CPO; its facade is a skin too.
 *  - The skylight cones over the tracks in Takutai Square: dark tiled cones, each with a glass oculus.
 *
 * Measured by tools/hero/sites/britomart.py from the LINZ 2024 Auckland LiDAR (1 m DSM/DEM and the classified point
 * cloud; CC BY 4.0) inside the OpenStreetMap outlines (© OpenStreetMap contributors, ODbL), converted NZTM → WGS84 →
 * game metres (origin the Sky Tower, +x east, +z south); heights in metres above the ground under each part. Domes:
 * centre and radius from their OSM outlines, drum and crown from the point cloud (27.7 m and 30.3 m). The Glasshouse's
 * roof: the median of its 1 m DSM (16.0–16.3 m at three spots; its glass lets returns through, so the p90, 16.9 m,
 * is the frame). The cones: radius from the outline, height the DSM's top over the ground (one, flush, is left out).
 * Guessed from photos: the canopy (its size and height) and the sign's size.
 */
import type { CbdTower } from './cbdTowers';

/** A dome on a drum: its centre (game m), radius, and the heights of its springing and crown above the ground. */
export interface StationDome {
  x: number;
  z: number;
  r: number;
  base: number;
  top: number;
}

/** The domes over the CPO's north-west and south-west corner pavilions. */
export const CPO_DOMES: readonly StationDome[] = [
  { x: 454.69, z: -515.81, r: 2.65, base: 27.7, top: 30.3 },
  { x: 440.75, z: -473.48, r: 2.65, base: 27.7, top: 30.3 },
];

/** The flagpole over the front pediment: foot on the roof behind the pediment, top above the ground (m). */
export const CPO_FLAGPOLE = { x: 444.76, z: -495.56, foot: 23.5, top: 30.6 } as const;

/** Skylight cones in Takutai Square over the tracks: [x, z, base radius, height] (game m). */
export const TAKUTAI_CONES: readonly (readonly [number, number, number, number])[] = [
  [562.39, -456.74, 1.88, 2.2],
  [572.85, -453.23, 1.88, 2.4],
  [583.22, -449.88, 1.88, 2.4],
  [593.55, -446.45, 1.88, 2.6],
  [603.94, -443.0, 1.88, 2.4],
  [614.57, -439.64, 2.07, 2.2],
  [624.8, -436.21, 2.08, 1.4],
  [635.27, -432.73, 2.08, 2.2],
  [645.73, -429.23, 2.08, 2.4],
  [656.34, -425.73, 2.08, 2.7],
];

/** The CBD tower kit's row of the Chief Post Office (core/cbdTowersData.ts). */
export const CPO_ROW = 202;
/** The Glasshouse's row, after the kit's landmarks (201–205). */
export const GLASSHOUSE_ROW = 206;

/**
 * The Glasshouse as a kit landmark: one glass terrace on the CPO's east wall (the kit's CPO outline shares that edge).
 * Its walls are its skin's (cbdTowerSkins.ts); `facade` only sets the roof's style, so the aerial photo drapes it.
 */
export const GLASSHOUSE: CbdTower = {
  n: GLASSHOUSE_ROW,
  tier: 'L',
  name: 'The Glasshouse (Britomart station)',
  address: '12 Queen St',
  facade: 'punched',
  wall: 0xbac6cc,
  podium: 0xbac6cc,
  spots: [
    [493.7, -479.2, 16.2],
    [487, -470, 16.1],
    [500, -488, 16.0],
  ],
  outline: [498.44, -460.9, 479.12, -467.13, 488.82, -497.4, 508.27, -491.11],
  replaces: [[493.68, -479.15]],
  parts: [{ kind: 'shaft', h: 16.2, ring: [498.44, -460.9, 479.12, -467.13, 488.82, -497.4, 508.27, -491.11] }],
};

/** The entrance canopy on the Glasshouse's east face (guessed from photos): across the face (m from its centre line,
 * as a skin's t), how far it reaches out, and the heights of its soffit and its top (m). */
export const GLASSHOUSE_CANOPY = { t: [-6.5, 6.5], depth: 4.5, soffit: 4.0, top: 4.6 } as const;
