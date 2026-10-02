/**
 * Vegetation rules shared by the colour baker (forest tint in the terrain texture) and the tree
 * scatterer (instanced trees near the camera) so distant forests and close-up trees agree.
 */
import type { SceneryFeature } from '../../core/contracts';
import type { TheaterId } from '../../core/types';
import { Noise2D, sstep } from './noise';
import { MAT_BEACH, MAT_VOLCANIC, MAT_BUSH, MAT_URBAN, MAT_CONE, MAT_CLEARING, MAT_PINE } from './types';
import { footprintOf, footprintReach, footprintWeight } from './features';
import type { Footprint } from './types';

export const TREE_PALM = 0;
export const TREE_BROADLEAF = 1;
export const TREE_CONIFER = 2;

export interface VegetationField {
  /** Forest density 0..1 at a world point, given terrain height/slope/material hints. */
  density(x: number, z: number, h: number, slope: number, mat: number, aux: number): number;
  /** Tree species for a point (TREE_*), `r` a uniform random number. */
  species(h: number, mat: number, r: number, x?: number, z?: number): number;
}

interface FeatureMask {
  fp: Footprint;
  /** Footprint used to clear trees (core + part of the blend). */
  clear: Footprint;
  type: SceneryFeature['type'];
  reach: number;
}

export function createVegetation(_theater: TheaterId, seed: number, features: SceneryFeature[]): VegetationField {
  const nL = new Noise2D(seed * 19 + 5);
  const masks: FeatureMask[] = features.map((f) => {
    const fp = footprintOf(f);
    const reach = footprintReach(fp) + 400;
    return { fp, clear: { ...fp, strength: 1, blend: fp.blend * 0.6 }, type: f.type, reach };
  });

  const featureAdjust = (x: number, z: number, d: number): number => {
    for (let i = 0; i < masks.length; i++) {
      const m = masks[i];
      const dx = x - m.fp.x;
      const dz = z - m.fp.z;
      if (Math.abs(dx) > m.reach || Math.abs(dz) > m.reach) continue;
      if (m.type === 'forest') {
        const r = m.fp.radius * (0.85 + 0.3 * nL.noise(x / 700, z / 700));
        const w = 1 - sstep(r * 0.6, r, Math.hypot(dx, dz));
        d = Math.max(d, 0.9 * w);
      } else if (m.type === 'farmland') {
        const w = 1 - sstep(m.fp.radius * 0.7, m.fp.radius, Math.hypot(dx, dz));
        d *= 1 - 0.85 * w;
      } else {
        // Clear ground under airfields and built-up areas (grow back beyond the blend)
        d *= 1 - footprintWeight(m.clear, x, z);
      }
    }
    return d;
  };

  const base = (x: number, z: number, h: number, slope: number, mat: number, aux: number): number => {
    if (h < 0.8) return 0;
    const n1 = nL.noise(x / 2600, z / 2600);
    const n2 = nL.noise(x / 650 + 3.7, z / 650 - 1.9);
    const patch = n1 + 0.35 * n2;
    if (mat === MAT_BUSH) return (aux / 255) * (1 - sstep(0.7, 1.1, slope)) * (0.8 + 0.2 * sstep(-0.4, 0.2, patch));
    // Rangitoto: bush over lava everywhere (≥ 0.3 keeps paddock patterns off), densest in lobes
    if (mat === MAT_VOLCANIC) return 0.3 + 0.55 * sstep(0.35, 0.8, aux / 255);
    if (mat === MAT_URBAN || mat === MAT_BEACH || mat === MAT_CLEARING) return 0;
    // scoria cones: grass with clumps of trees on the lower slopes
    if (mat === MAT_CONE) return 0.14 * sstep(0.1, 0.45, patch) * (1 - sstep(0.5, 0.9, slope));
    // Pine plantations (Woodhill, Riverhead, …): dense, even stands
    if (mat === MAT_PINE) return (aux / 255) * (1 - sstep(0.8, 1.2, slope));
    return 0.32 * sstep(0.12, 0.45, patch) * (1 - sstep(0.6, 1.0, slope));
  };

  return {
    density(x, z, h, slope, mat, aux) {
      return featureAdjust(x, z, base(x, z, h, slope, mat, aux));
    },
    species(h, mat, r) {
      if (mat === MAT_PINE) return r < 0.92 ? TREE_CONIFER : TREE_BROADLEAF;
      if (mat === MAT_BEACH || h < 4) return r < 0.5 ? TREE_PALM : TREE_BROADLEAF;
      return r < 0.06 ? TREE_PALM : r < 0.14 ? TREE_CONIFER : TREE_BROADLEAF;
    },
  };
}
