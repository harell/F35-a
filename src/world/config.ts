/**
 * Quality-dependent world parameters (derived from QualitySettings) and per-theatre terrain styles.
 */
import { Color } from 'three';
import type { QualitySettings, TheaterId } from '../core/types';
import type { TerrainStyle } from './terrain/TerrainRenderer';

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
      return { hfResolution: 1024, patchQuads: 6, lodRange: 2.4, anisotropy: 2, treeRadius: 1600, treeMax: Math.round(1500 * (d / 0.35)), houseRadius: 1100, houseMax: 900 };
    case 1:
      return { hfResolution: 1024, patchQuads: 12, lodRange: 2.6, anisotropy: 4, treeRadius: 2400, treeMax: Math.round(3000 * (d / 0.7)), houseRadius: 1700, houseMax: 2200 };
    default:
      return { hfResolution: 2048, patchQuads: 16, lodRange: 2.6, anisotropy: 8, treeRadius: 3500, treeMax: Math.round(6000 * d), houseRadius: 2800, houseMax: 5000 };
  }
}

const c = (hex: number) => new Color().setHex(hex);

/** Shader-side splatting parameters per theatre. */
export function terrainStyle(theater: TheaterId): TerrainStyle {
  const temperateRoofs: [Color, Color, Color] = [c(0x8a3a2c), c(0x5a5f66), c(0x9a9a92)];
  switch (theater) {
    case 'desert':
      return {
        rockColor: c(0x8a6c52), snowColor: c(0xf4f6fa), snowLine: 1e6, rockSlope: 0.3, outsideColor: c(0xcdb58c), fields: 0,
        roofs: [c(0xe0d6c2), c(0xc8b89a), c(0xf0ece4)], garden: c(0xb8a47e),
      };
    case 'islands':
      return {
        rockColor: c(0x5c554e), snowColor: c(0xf4f6fa), snowLine: 1e6, rockSlope: 0.36, outsideColor: c(0x7c9a44), fields: 0.5,
        roofs: [c(0xb04a32), c(0x6a8aa0), c(0xd8d0c0)], garden: c(0x5c8a3a),
      };
    case 'mountains':
      return {
        rockColor: c(0x7c7671), snowColor: c(0xf2f5fa), snowLine: 2900, rockSlope: 0.3, outsideColor: c(0x7a9450), fields: 0.9,
        roofs: temperateRoofs, garden: c(0x6c8a48),
      };
    case 'arctic':
      return {
        rockColor: c(0x55565c), snowColor: c(0xf0f4f8), snowLine: 1100, rockSlope: 0.33, outsideColor: c(0xe6ecf2), fields: 0,
        roofs: [c(0xa03028), c(0x2f4f6f), c(0xc8b040)], garden: c(0xd8dee6),
      };
    case 'auckland':
    default:
      return {
        rockColor: c(0x5f5a52), snowColor: c(0xf4f6fa), snowLine: 1e6, rockSlope: 0.42, outsideColor: c(0x6f9a46), fields: 1,
        roofs: [c(0x8e4234), c(0x505a62), c(0xaaa69c)], garden: c(0x5a8a3e),
      };
  }
}
