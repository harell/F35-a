/**
 * Rat navy fast boats (issue #79): low-poly hulls shared by the ground prototypes (suicide boat,
 * missile boat) and the SAM prototype of the air-defence boat. Waterline at y = 0, bow at -Z. Their
 * wakes are drawn by the EntityRenderer's WakeBatch like every moving ship's.
 */
import type { BufferGeometry } from 'three';
import { box, cylinder, place } from './geom/core';
import { loftRings } from './geom/loft';

/** Overall length and beam (m) of each boat, for the hull, the wake and the framing. */
export const BOAT_DIMS = {
  suicide_boat: { length: 16, beam: 3.2 },
  missile_boat: { length: 17.5, beam: 3.8 },
  ad_boat: { length: 21, beam: 4.4 },
} as const;
export type BoatKind = keyof typeof BOAT_DIMS;

const GREY = 0x6d7478;
const DARK = 0x3d4245;
const DECK = 0x585e61;

/** A planing hull: sharp raked bow at -Z, deep-vee sections, square transom at +Z. */
export function boatHull(length: number, beam: number, color = GREY): BufferGeometry {
  const L = length;
  const hb = beam / 2;
  return loftRings(
    (
      [
        [-L / 2, 0.08, 1.15],
        [-L / 2 + L * 0.12, 0.55, 1.05],
        [-L / 2 + L * 0.3, 0.92, 1],
        [0, 1, 0.95],
        [L / 2 - L * 0.1, 1, 0.9],
        [L / 2, 0.96, 0.9],
      ] as const
    ).map(([z, k, top]) => {
      const hw = hb * k;
      const dk = 1.1 * top;
      return { z, ring: [0, -0.7 * k, hw * 0.75, -0.35 * k, hw, 0.25, hw * 0.98, dk, -hw * 0.98, dk, -hw, 0.25, -hw * 0.75, -0.35 * k] };
    }),
    { capEnd: true, creases: [2, 3, 4, 5], color },
  );
}

/** Low cabin with a dark windscreen band, `at` m along the hull (−Z forward). */
function cabin(w: number, h: number, l: number, at: number, deck = 1): BufferGeometry[] {
  return [place(box(w, h, l, GREY), [0, deck + h / 2, at]), place(box(w * 1.01, h * 0.28, 0.12, DARK), [0, deck + h * 0.72, at - l / 2 - 0.02])];
}

/** Unmanned explosive boat: a bare low hull with a small console, a hump of charge forward. */
export function suicideBoat(): BufferGeometry[] {
  const { length, beam } = BOAT_DIMS.suicide_boat;
  return [
    boatHull(length, beam, 0x5f676b),
    place(box(beam * 0.7, 0.18, length * 0.75, DECK), [0, 1.08, 0.6]),
    place(box(beam * 0.55, 0.5, 3.2, 0x7a6a3a), [0, 1.35, -3.4]), // the charge
    ...cabin(1.4, 0.9, 1.6, 2.4),
    place(cylinder(0.05, 0.05, 1.4, 5, DARK), [0, 2.4, 3.2]), // antenna
    place(box(beam * 0.5, 0.5, 0.6, DARK), [0, 0.8, length / 2 + 0.2]), // outboards
  ];
}

/** Peykaap II: cabin amidships, two Kowsar canisters aft, angled outboard. */
export function missileBoat(): BufferGeometry[] {
  const { length, beam } = BOAT_DIMS.missile_boat;
  const out = [
    boatHull(length, beam),
    place(box(beam * 0.8, 0.16, length * 0.8, DECK), [0, 1.06, 0.4]),
    ...cabin(2.4, 1.3, 4.2, -1.2),
    place(cylinder(0.06, 0.06, 2.2, 5, DARK), [0, 3.4, 0]), // mast
    place(box(0.9, 0.12, 0.25, DARK), [0, 3.9, 0]), // radar bar
    place(cylinder(0.12, 0.12, 0.9, 6, DARK), [0, 1.5, -6.2], [Math.PI / 2, 0, 0]), // bow machine gun
  ];
  for (const s of [-1, 1]) out.push(place(box(0.7, 0.7, 4.0, 0x7d8589), [s * 0.95, 1.55, 4.6], [0.12, s * 0.15, 0]));
  return out;
}

/** Air-defence boat hull and cabin (its radar and launcher are SAM nodes, sams.ts). */
export function adBoat(): BufferGeometry[] {
  const { length, beam } = BOAT_DIMS.ad_boat;
  return [
    boatHull(length, beam),
    place(box(beam * 0.8, 0.16, length * 0.8, DECK), [0, 1.06, 0.4]),
    ...cabin(2.8, 1.5, 5.2, -2.6),
    place(box(beam * 0.6, 0.6, 0.6, DARK), [0, 0.8, length / 2 + 0.2]),
  ];
}
