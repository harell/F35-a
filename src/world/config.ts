/**
 * Quality-dependent world parameters (derived from QualitySettings) and per-theatre terrain styles.
 */
import { Color } from 'three';
import type { QualitySettings, TheaterId } from '../core/types';
import type { TerrainStyle } from './terrain/TerrainRenderer';
import type { CbdGrid } from './scenery/urbanGrid';
import { AKL_CONES, AKL_RANGITOTO } from './terrain/theaters/aucklandMap';

/**
 * Auckland CBD street grid: one grid (blocks 105 m N–S × 76 m E–W, Queen Street ≈ 8° west of
 * south) over the city centre instead of Voronoi districts; shared by the terrain shader and the
 * CBD / house builders.
 */
export const AKL_CBD_GRID: CbdGrid = { x: 200, z: -100, radius: 1150, hash: 0.2722 };

export interface WorldConfig {
  /** Heightfield samples per side. */
  hfResolution: number;
  /** Quads per CDLOD patch side (even). */
  patchQuads: number;
  /** CDLOD range multiplier. */
  lodRange: number;
  /** Anisotropic filtering for ground textures. */
  anisotropy: number;
  /** Tree scatter radius around the camera (m) and max instances per species. */
  treeRadius: number;
  treeMax: number;
  /** Suburban house scatter radius (m) and max instances. */
  houseRadius: number;
  houseMax: number;
}

export function worldConfig(q: QualitySettings): WorldConfig {
  const d = q.sceneryDensity;
  switch (q.terrainDetail) {
    case 0:
      return { hfResolution: 1024, patchQuads: 6, lodRange: 2.4, anisotropy: 2, treeRadius: 1600, treeMax: Math.round(1500 * (d / 0.35)), houseRadius: 1500, houseMax: 1800 };
    case 1:
      return { hfResolution: 1024, patchQuads: 12, lodRange: 2.6, anisotropy: 4, treeRadius: 2200, treeMax: Math.round(2500 * (d / 0.7)), houseRadius: 2400, houseMax: 3600 };
    default:
      return { hfResolution: 2048, patchQuads: 16, lodRange: 2.6, anisotropy: 8, treeRadius: 3000, treeMax: Math.round(4500 * d), houseRadius: 3400, houseMax: 7500 };
  }
}

const c = (hex: number) => new Color().setHex(hex);

/** Auckland's scoria cones (terraced pā sites) + Rangitoto's summit cone and NE rim crater (no terraces). */
function aucklandCones(): NonNullable<TerrainStyle['cones']> {
  const rg = AKL_RANGITOTO;
  return [
    ...AKL_CONES.map((k) => ({ x: k.x * 1000, z: k.z * 1000, craterR: k.cr, craterDepth: k.cd, coneR: k.r, coneH: k.h, terraces: true })),
    { x: rg.x * 1000, z: rg.z * 1000, craterR: rg.cr, craterDepth: rg.cd, coneR: 680, coneH: rg.h, terraces: false },
    { x: rg.x * 1000 + 150, z: rg.z * 1000 - 110, craterR: 70, craterDepth: 18, coneR: 90, coneH: rg.h - 20, terraces: false },
  ];
}

/** Shader-side splatting parameters per theatre. */
export function terrainStyle(theater: TheaterId): TerrainStyle {
  const six = (a: number[]): Color[] => a.map((h) => c(h));
  const shore = { sand: c(0xcdb88a), blackSand: c(0x34322f), shoreRock: c(0x4a4640), blackSandX: -1e9, vineyard: null, sink: false, cbd: null };
  switch (theater) {
    case 'desert':
      return {
        ...shore, rockColor: c(0x8a6c52), snowColor: c(0xf4f6fa), snowLine: 1e6, rockSlope: 0.3, outsideColor: c(0xcdb58c), fields: 0,
        roofs: six([0xe0d6c2, 0xc8b89a, 0xf0ece4, 0xd8ccb0, 0xb8a888, 0xe8e0d0]), garden: c(0xb8a47e), canopy: c(0x5a6a3a), sand: c(0xe0cca0),
      };
    case 'islands':
      return {
        ...shore, rockColor: c(0x5c554e), snowColor: c(0xf4f6fa), snowLine: 1e6, rockSlope: 0.36, outsideColor: c(0x7c9a44), fields: 0.5,
        roofs: six([0xb04a32, 0x6a8aa0, 0xd8d0c0, 0x8a4a3a, 0xc8c0b0, 0x5a7a8a]), garden: c(0x5c8a3a), canopy: c(0x24461e), sand: c(0xeee2c0),
      };
    case 'mountains':
      return {
        ...shore, rockColor: c(0x7c7671), snowColor: c(0xf2f5fa), snowLine: 2900, rockSlope: 0.3, outsideColor: c(0x7a9450), fields: 0.9,
        roofs: six([0x8a3a2c, 0x5a5f66, 0x9a9a92, 0x6a3024, 0x44484e, 0x7a6a5a]), garden: c(0x6c8a48), canopy: c(0x2c4426), shoreRock: c(0x6a6560),
      };
    case 'arctic':
      return {
        ...shore, rockColor: c(0x55565c), snowColor: c(0xf0f4f8), snowLine: 1100, rockSlope: 0.33, outsideColor: c(0xe6ecf2), fields: 0,
        roofs: six([0xa03028, 0x2f4f6f, 0xc8b040, 0x3a3c40, 0x5a2a28, 0xe8ecf0]), garden: c(0xd8dee6), canopy: c(0x2e3c36), sand: c(0x7c7a74),
      };
    case 'auckland':
    default:
      return {
        rockColor: c(0x5f5a52), snowColor: c(0xf4f6fa), snowLine: 1e6, rockSlope: 0.42, outsideColor: c(0x6f9a46), fields: 1,
        // Auckland roofs: charcoal & grey corrugated iron, terracotta tiles, red-painted iron,
        // off-white, a few muted greens. Lawns are a fresh NZ green, canopy a dark bush green.
        roofs: six([0x3a3d40, 0x6e7074, 0x8a4a38, 0x7a2e26, 0xbdb9ae, 0x3f4d3c]),
        garden: c(0x55803a), canopy: c(0x263f20),
        sand: c(0xd2bf92), blackSand: c(0x2f2d2b), shoreRock: c(0x3e3a35), blackSandX: -18_000,
        // Waiheke vineyards (Oneroa → Onetangi)
        vineyard: [27_500, -5_200, 8_500, 3_000],
        sink: true,
        cbd: AKL_CBD_GRID,
        cones: aucklandCones(),
      };
  }
}
