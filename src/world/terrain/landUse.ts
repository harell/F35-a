/**
 * The real land use (scenery/aucklandLandUse.ts, #122) in the heightfield's materials: per base sample (86 m), the
 * built-up density (MAT_URBAN, aux) follows the shares of the land-use classes in its cell instead of the hand-traced
 * suburbs (aucklandMap.ts AKL_URBAN) and park circles (AKL_PARKS). The colour map, the garden trees and the house
 * scatter all read that density, so parks, fields and golf courses read green from altitude and Waiheke's settlements
 * take their real shape. Where the cell's share without a class is large the hand map still decides (OSM holes stay
 * residential), and forest, cones, beaches, Rangitoto and levelled pads keep their own material.
 *
 * Runs on the main thread on the base heightfield before the upsample (generate.ts finishTerrain), so the generation
 * workers never need the 12.5 MB grid.
 */
import type { Heightfield } from './Heightfield';
import { Noise2D } from './noise';
import { MAT_NONE, MAT_URBAN } from './types';
import {
  LU_CLASSES,
  LU_COMMERCIAL,
  LU_HOSPITAL,
  LU_INDUSTRIAL,
  LU_NONE,
  LU_RESIDENTIAL,
  LU_SCHOOL,
  type LandUse,
} from '../scenery/aucklandLandUse';

/** Built-up density of land with sheds and car parks (below the 0.9 the shader and HouseSource take for apartments). */
export const SHED_DENSITY = 0.82;
/** School grounds: classrooms on part of them, playing fields on the rest. */
export const SCHOOL_DENSITY = 0.45;
/** Below this share of classified cells a sample keeps the hand-traced map's density. */
const MIN_KNOWN = 0.1;

/**
 * Rewrite hf.mat / hf.aux from the land-use grid. `seed` drives the residential density's ≈ 1.4 km variation (the
 * same noise as the hand map's, auckland.ts). Returns the number of samples changed.
 */
export function applyLandUse(hf: Heightfield, lu: LandUse, seed: number): number {
  const g = applyLandUseSteps(hf, lu, seed);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/** applyLandUse as a generator yielding its progress (0..1) every 32 rows (generate.ts runs it time-sliced). */
export function* applyLandUseSteps(hf: Heightfield, lu: LandUse, seed: number): Generator<number, number, void> {
  const n = hf.n;
  const noise = new Noise2D(seed * 29 + 2);
  const counts = new Uint16Array(n * LU_CLASSES);
  // the heightfield column each fine column's centre is nearest to (its first counter; −1 outside)
  const colToI = new Int32Array(lu.cols);
  let fi0 = lu.cols;
  let fi1 = -1;
  for (let fi = 0; fi < lu.cols; fi++) {
    const i = Math.round((lu.x0 + (fi + 0.5) * lu.cell - hf.origin) / hf.cell);
    colToI[fi] = i >= 0 && i < n ? i * LU_CLASSES : -1;
    if (colToI[fi] >= 0) {
      fi0 = Math.min(fi0, fi);
      fi1 = fi;
    }
  }
  const data = lu.data;
  const rowBytes = lu.texW * 4;
  let changed = 0;
  // fine cells per base row: those whose centre is nearest to the row's sample
  for (let j = 0; j < n; j++) {
    if ((j & 31) === 31) yield j / n;
    const z = hf.pos(j);
    const zA = z - hf.cell / 2;
    const zB = z + hf.cell / 2;
    if (zB < lu.z0 || zA > lu.z0 + lu.rows * lu.cell) continue;
    const fj0 = Math.max(0, Math.ceil((zA - lu.z0) / lu.cell - 0.5));
    const fj1 = Math.min(lu.rows - 1, Math.ceil((zB - lu.z0) / lu.cell - 0.5) - 1);
    if (fj1 < fj0) continue;
    counts.fill(0);
    for (let fj = fj0; fj <= fj1; fj++) {
      const base = (fj >> 1) * rowBytes + (fj & 1) * 2;
      // (landUseCell() inlined)
      for (let fi = fi0; fi <= fi1; fi++) counts[colToI[fi] + ((data[base + (fi >> 2) * 4 + ((fi & 3) >> 1)] >> ((fi & 1) * 4)) & 15)]++;
    }
    for (let i = 0; i < n; i++) {
      const c = i * LU_CLASSES;
      let tot = 0;
      for (let k = 0; k < LU_CLASSES; k++) tot += counts[c + k];
      if (!tot) continue;
      const known = 1 - counts[c + LU_NONE] / tot;
      if (known < MIN_KNOWN) continue;
      const kk = j * n + i;
      if (hf.data[kk] <= 0) continue;
      const mat = hf.mat[kk];
      if (mat !== MAT_NONE && mat !== MAT_URBAN) continue;
      const hand = mat === MAT_URBAN ? hf.aux[kk] / 255 : 0;
      const x = hf.pos(i);
      // a home's density: the hand map's where it had suburbs (its park circles are replaced), else its formula
      const res = hand > 0.3 ? hand : 0.62 + 0.23 * noise.noise(x / 1400, z / 1400);
      const share = (k: number) => counts[c + k] / tot;
      let dens =
        (1 - known) * hand +
        share(LU_RESIDENTIAL) * res +
        (share(LU_COMMERCIAL) + share(LU_INDUSTRIAL) + share(LU_HOSPITAL)) * SHED_DENSITY +
        share(LU_SCHOOL) * SCHOOL_DENSITY;
      // the CBD fringe's apartments (the hand map's density there is the CBD circle's)
      if (hand > 0.9) dens = Math.max(dens, hand);
      const nm = dens > 0.05 ? MAT_URBAN : MAT_NONE;
      const na = nm === MAT_URBAN ? Math.min(255, (dens * 255) | 0) : 0;
      if (nm !== mat || na !== hf.aux[kk]) {
        hf.mat[kk] = nm;
        hf.aux[kk] = na;
        changed++;
      }
    }
  }
  return changed;
}
