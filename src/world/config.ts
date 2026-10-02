/**
 * Quality-dependent world parameters (derived from QualitySettings) and the Auckland terrain style.
 */
import { Color } from 'three';
import type { QualitySettings, TheaterId } from '../core/types';
import type { TerrainStyle } from './terrain/TerrainRenderer';
import type { CbdGrid } from './scenery/urbanGrid';
import { aucklandStreets } from './scenery/cbdStreets';
import { AKL_CONES, AKL_RANGITOTO } from './terrain/theaters/aucklandMap';
import type { AerialSize } from './terrain/theaters/aucklandAerial';

/**
 * Auckland CBD street grid (fallback without LINZ road data): one grid (blocks 105 m N–S × 76 m E–W,
 * Queen Street ≈ 8° west of south) over the city centre instead of Voronoi districts; shared by the
 * terrain shader and the CBD / house builders.
 */
export const AKL_CBD_GRID: CbdGrid = { x: 200, z: -100, radius: 1150, hash: 0.2722 };

/** Auckland's CBD: the real (LINZ) streets when the road data is installed, else AKL_CBD_GRID. */
export function aucklandCbd(): CbdGrid {
  const streets = aucklandStreets();
  return streets ? { ...AKL_CBD_GRID, streets } : AKL_CBD_GRID;
}

export interface WorldConfig {
  /** Heightfield samples per side. */
  hfResolution: number;
  /** Refine the 2048² heightfield with the real LiDAR detail (Auckland; downloads auckland-linz-hd.bin). */
  hdTerrain: boolean;
  /** Auckland aerial photo texture size (0 = none; downloads auckland-aerial-<size>.webp). */
  aerial: AerialSize;
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
      return { hfResolution: 1024, hdTerrain: false, aerial: 0, patchQuads: 6, lodRange: 2.4, anisotropy: 2, treeRadius: 1600, treeMax: Math.round(1500 * (d / 0.35)), houseRadius: 1500, houseMax: 1800 };
    case 1:
      return { hfResolution: 1024, hdTerrain: false, aerial: q.aerialPhoto ? 2048 : 0, patchQuads: 12, lodRange: 2.6, anisotropy: 4, treeRadius: 2200, treeMax: Math.round(2500 * (d / 0.7)), houseRadius: 2400, houseMax: 3600 };
    default:
      return { hfResolution: 2048, hdTerrain: q.hdTerrain, aerial: q.aerialPhoto ? 4096 : 0, patchQuads: 16, lodRange: 2.6, anisotropy: 8, treeRadius: 3000, treeMax: Math.round(4500 * d), houseRadius: 3400, houseMax: 7500 };
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

/** Shader-side splatting parameters (Auckland). */
export function terrainStyle(_theater: TheaterId): TerrainStyle {
  const six = (a: number[]): Color[] => a.map((h) => c(h));
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
    cbd: aucklandCbd(),
    cones: aucklandCones(),
  };
}
