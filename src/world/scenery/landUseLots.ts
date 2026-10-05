/**
 * What the suburbs' procedural lots carry on each real land-use class (#122), shared by the terrain shader
 * (urbanPattern) and HouseSource so the painted and the 3D buildings agree:
 *  - residential (and unclassified) land: the houses and apartments as before, one per 17.5 × 38 m lot;
 *  - open ground (parks, pitches, golf, cemeteries, vineyards, farmland): no building, no street;
 *  - commercial / retail, industrial and hospital land: one flat-roofed shed per unit of UNIT_LOTS lots
 *    (52.5 × 38 m) round a car park or yard; its class is the land use at the unit's centre;
 *  - school grounds: a classroom block on SCHOOL_BUILT of the units, playing fields on the rest.
 * Node-safe (no three.js).
 */
import { LU_COMMERCIAL, LU_HOSPITAL, LU_INDUSTRIAL, LU_SCHOOL } from './aucklandLandUse';

/** Lots (along the block's long side) per shed unit: two units per 105 m block row. */
export const UNIT_LOTS = 3;
/** Share of school units with a classroom block (the rest are fields). */
export const SCHOOL_BUILT = 0.45;

/** A shed's footprint inside its unit: centred, sx × sz of the unit (fractions). */
export function shedFootprint(cls: number): { sx: number; sz: number } {
  switch (cls) {
    case LU_INDUSTRIAL:
      return { sx: 0.86, sz: 0.72 };
    case LU_HOSPITAL:
      return { sx: 0.78, sz: 0.66 };
    case LU_SCHOOL:
      return { sx: 0.72, sz: 0.38 };
    case LU_COMMERCIAL:
    default:
      return { sx: 0.7, sz: 0.55 };
  }
}

const f32 = Math.fround;
const fract = (x: number) => x - Math.floor(x);
/** GLSL fract(lh * k) with float32 rounding (the terrain shader's per-lot hashes). */
export const lotFrac = (lh: number, k: number): number => fract(f32(f32(lh) * f32(k)));

/** A shed's wall height (m) from its unit hash. */
export function shedHeight(cls: number, lh: number): number {
  const r = lotFrac(lh, 5.7);
  switch (cls) {
    case LU_HOSPITAL:
      return 12 + 16 * r;
    case LU_SCHOOL:
      return 4 + 3 * r;
    case LU_INDUSTRIAL:
      return 7 + 5 * r;
    default:
      return 6 + 4 * r;
  }
}

/** Shed roofs: zinc and steel greys, off-white, a weathered grey-teal (sRGB; the 2024 photo's light industrial roofs).
 * The shader gets them as uShedRoofs. */
export const SHED_ROOFS = [0xb7b9b8, 0xc9cac6, 0xa4a8aa, 0xd8d6cf, 0x9fa8a7];

/** Index into SHED_ROOFS and brightness for a unit hash (the shader's shedRoof()). */
export function shedRoofOf(lh: number): { index: number; k: number } {
  return { index: Math.min(SHED_ROOFS.length - 1, Math.floor(lotFrac(lh, 5.1) * (SHED_ROOFS.length - 0.001))), k: 0.94 + 0.12 * lotFrac(lh, 7.3) };
}
