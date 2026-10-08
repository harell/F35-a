/**
 * Far-field suburb albedo (what a suburb averages to once its houses, trees and streets are below a
 * pixel, i.e. from combat altitude). Computed once on the CPU from the theatre's roof / garden /
 * canopy palette and handed to the terrain shader as two uniforms: a leafy and a bare
 * neighbourhood mix, blended there by a ~500 m noise.
 *
 * Auckland from the air is a grey-green city: 35-45 % tree canopy (the leafy isthmus suburbs are
 * nearer 45 %), grey / red / off-white corrugated-iron and tile roofs, lawns, and a street grid.
 * The old mix used ~50 % roof and ~35 % canopy of a brownish roof average, which came out khaki.
 */
import { Color } from 'three';

/** Linear-RGB street / driveway paving average used by the shader (mix(asphalt, paving, 0.5)). */
export const PAVING_AVG: readonly [number, number, number] = [0.1825, 0.1805, 0.175];

/** Area shares of a suburb seen from above: canopy, roofs, lawn, paving (sum 1). */
export interface SuburbMix {
  canopy: number;
  roofs: number;
  lawn: number;
  paving: number;
}

/** Leafy (Remuera / Epsom / Birkenhead) and bare (newer / denser) neighbourhood mixes. */
export const LEAFY_MIX: SuburbMix = { canopy: 0.44, roofs: 0.25, lawn: 0.19, paving: 0.12 };
export const BARE_MIX: SuburbMix = { canopy: 0.3, roofs: 0.34, lawn: 0.2, paving: 0.16 };
/**
 * A suburb's ground without its trees (the bare mix's roofs, lawns and paving): where the real canopy covers (#123,
 * aucklandCanopy.ts), the terrain shader's far field is this mixed with the canopy colour by the measured share, so
 * a suburb's far albedo is suburbFarAlbedo with that share as its canopy.
 */
export const OPEN_MIX: SuburbMix = {
  canopy: 0,
  roofs: BARE_MIX.roofs / (1 - BARE_MIX.canopy),
  lawn: BARE_MIX.lawn / (1 - BARE_MIX.canopy),
  paving: BARE_MIX.paving / (1 - BARE_MIX.canopy),
};

export function roofAverage(roofs: Color[], out = new Color()): Color {
  out.setRGB(0, 0, 0);
  for (const r of roofs) {
    out.r += r.r / roofs.length;
    out.g += r.g / roofs.length;
    out.b += r.b / roofs.length;
  }
  return out;
}

/** Area-weighted far-field albedo (linear RGB) of a suburb with the given mix. */
export function suburbFarAlbedo(style: { roofs: Color[]; garden: Color; canopy: Color }, mix: SuburbMix, out = new Color()): Color {
  const roof = roofAverage(style.roofs);
  const ch = (k: 'r' | 'g' | 'b', i: number) => style.canopy[k] * mix.canopy + roof[k] * mix.roofs + style.garden[k] * mix.lawn + PAVING_AVG[i] * mix.paving;
  return out.setRGB(ch('r', 0), ch('g', 1), ch('b', 2));
}
