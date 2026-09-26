/**
 * Vegetation rules shared by the colour baker (forest tint in the terrain texture) and the tree
 * scatterer (instanced trees near the camera) so distant forests and close-up trees agree.
 */
import type { SceneryFeature } from '../../core/contracts';
import type { TheaterId } from '../../core/types';
import { Noise2D, sstep } from './noise';
import {
  MAT_BEACH,
  MAT_ICE,
  MAT_JUNGLE,
  MAT_RIVER,
  MAT_ROCKY,
  MAT_SALT,
  MAT_TUNDRA,
  MAT_VOLCANIC,
  MAT_WADI,
  MAT_DUNE,
  MAT_MESA,
  MAT_BUSH,
  MAT_URBAN,
  MAT_CONE,
  MAT_CLEARING,
} from './types';
import { footprintOf, footprintWeight } from './features';
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

export function createVegetation(theater: TheaterId, seed: number, features: SceneryFeature[]): VegetationField {
  const nL = new Noise2D(seed * 19 + 5);
  const masks: FeatureMask[] = features.map((f) => {
    const fp = footprintOf(f);
    const reach = (fp.kind === 'rect' ? Math.hypot(fp.halfW, fp.halfL) : fp.radius) + fp.blend + 400;
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
    switch (theater) {
      case 'auckland': {
        if (mat === MAT_BUSH) return (aux / 255) * (1 - sstep(0.7, 1.1, slope)) * (0.8 + 0.2 * sstep(-0.4, 0.2, patch));
        // Rangitoto: bush over lava everywhere (≥ 0.3 keeps paddock patterns off), densest in lobes
        if (mat === MAT_VOLCANIC) return 0.3 + 0.55 * sstep(0.35, 0.8, aux / 255);
        if (mat === MAT_URBAN || mat === MAT_BEACH || mat === MAT_CLEARING) return 0;
        // scoria cones: grass with clumps of trees on the lower slopes
        if (mat === MAT_CONE) return 0.14 * sstep(0.1, 0.45, patch) * (1 - sstep(0.5, 0.9, slope));
        // Riverhead pine plantation
        const pine = 1 - sstep(3500, 6000, Math.hypot(x + 16_000, z + 14_500));
        if (pine > 0) return Math.max(0.85 * pine * sstep(-0.6, -0.2, patch), 0.3 * sstep(0.15, 0.45, patch));
        return 0.32 * sstep(0.12, 0.45, patch) * (1 - sstep(0.6, 1.0, slope));
      }
      case 'desert': {
        if (mat === MAT_WADI) return aux > 120 ? 0.28 * sstep(0.0, 0.4, patch) : 0;
        if (mat === MAT_BEACH && h > 1.2 && h < 6) return 0.12 * sstep(0.2, 0.5, patch);
        return 0;
      }
      case 'islands': {
        if (mat === MAT_VOLCANIC) return 0;
        if (mat === MAT_JUNGLE) return (aux / 255) * (1 - sstep(0.55, 0.95, slope)) * (0.72 + 0.28 * sstep(-0.4, 0.3, patch));
        if (mat === MAT_BEACH) return h > 1.4 ? 0.35 * sstep(-0.2, 0.3, patch) : 0;
        return 0.25 * sstep(0, 0.4, patch) * (1 - sstep(0.5, 0.9, slope));
      }
      case 'mountains': {
        if (mat === MAT_ROCKY && aux > 90) return 0;
        const band = sstep(180, 420, h) * (1 - sstep(1850, 2350, h));
        const steep = 1 - sstep(0.62, 1.05, slope);
        let d = band * steep * sstep(-0.25, 0.2, patch + 0.1);
        if (mat === MAT_RIVER) d = Math.max(d, (aux / 255) * 0.7 * steep * (1 - sstep(1800, 2300, h)));
        if (h < 420) d = Math.max(d, 0.55 * sstep(0.25, 0.45, patch) * steep);
        return d;
      }
      case 'arctic': {
        if (mat === MAT_ICE || mat === MAT_BEACH || mat === MAT_ROCKY) return 0;
        const low = 1 - sstep(140, 330, h);
        const d = low * (1 - sstep(0.35, 0.6, slope)) * sstep(-0.1, 0.35, patch) * 0.75;
        return mat === MAT_TUNDRA ? d * 0.5 : d;
      }
    }
    return 0;
  };

  return {
    density(x, z, h, slope, mat, aux) {
      if (mat === MAT_SALT || mat === MAT_DUNE || mat === MAT_MESA) return featureAdjust(x, z, 0);
      return featureAdjust(x, z, base(x, z, h, slope, mat, aux));
    },
    species(h, mat, r, x = 0, z = 0) {
      switch (theater) {
        case 'auckland': {
          if (Math.hypot(x + 16_000, z + 14_500) < 6000) return r < 0.85 ? TREE_CONIFER : TREE_BROADLEAF;
          if (mat === MAT_BEACH || h < 4) return r < 0.5 ? TREE_PALM : TREE_BROADLEAF;
          return r < 0.06 ? TREE_PALM : r < 0.14 ? TREE_CONIFER : TREE_BROADLEAF;
        }
        case 'desert':
          return TREE_PALM;
        case 'islands':
          return mat === MAT_BEACH || h < 12 || r < 0.12 ? TREE_PALM : TREE_BROADLEAF;
        case 'mountains': {
          const pc = sstep(700, 1500, h);
          return r < pc ? TREE_CONIFER : TREE_BROADLEAF;
        }
        case 'arctic':
          return r < 0.9 ? TREE_CONIFER : TREE_BROADLEAF;
      }
      return TREE_BROADLEAF;
    },
  };
}
