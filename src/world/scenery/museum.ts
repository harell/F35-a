/**
 * Auckland War Memorial Museum (Tāmaki Paenga Hira) on Pukekawa, from its measured parts (core/museum.ts): the
 * neoclassical block's LiDAR terraces in Portland stone with punched windows below a plain cornice band, floodlit at
 * night, each roof in its colour from the 2023 mesh's top view; the 2007 Grand Atrium's glass ring and its dome as the
 * LiDAR surface (blue-grey glass low on the dome, the grey copper cap above); the north portico's entablature on its
 * eight columns. The whole building stands on the game's terrain by one offset (the ground at its centroid), so its
 * roofs stay level; walls reach down to the lowest ground in its plan. One merged mesh with the caller's builder.
 */
import { MUSEUM_CENTRE, MUSEUM_COLOURS, MUSEUM_DOME, MUSEUM_PARTS, MUSEUM_PORTICO, museumDomeAt, museumDomeXZ } from '../../core/museum';
import { GeometryBuilder, IDENT_FRAME, WIN_FLOOD, WIN_HERITAGE, WIN_LOBBY, WIN_NONE } from './GeometryBuilder';
import type { LightList } from './builders';

type HeightFn = (x: number, z: number) => number;

/** The cornice band at the top of each terrace's walls (m): plain stone, no windows. */
const CORNICE = 2.4;
/** Storey height the punched windows follow (m): the block has two tall storeys of windows. */
const STOREY = 6.2;
/** The dome's glass reaches this far over the copper ring's top (m); above it, the copper cap. */
const GLASS_BAND = 2.5;
/** The cornice reads a shade darker than the wall (its shadowed soffit). */
const shade = (c: number, k: number) => (Math.round(((c >> 16) & 255) * k) << 16) | (Math.round(((c >> 8) & 255) * k) << 8) | Math.round((c & 255) * k);

/** Walls of a ring from y0 to y1 (outward faces, as GeometryBuilder.prism draws them). */
function walls(B: GeometryBuilder, ring: ArrayLike<number>, y0: number, y1: number, colour: number, win: number): void {
  const n = ring.length / 2;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [a, b] = area > 0 ? [j, i] : [i, j];
    const ax = ring[a * 2], az = ring[a * 2 + 1], bx = ring[b * 2], bz = ring[b * 2 + 1];
    if (ax === bx && az === bz) continue;
    B.quad(IDENT_FRAME, [ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az], colour, win);
  }
}

/** Build the museum; returns its ground (m), the terrain at its centre. */
export function buildMuseum(B: GeometryBuilder, lights: LightList, height: HeightFn): number {
  const g = height(MUSEUM_CENTRE.x, MUSEUM_CENTRE.z);
  // walls reach down to the lowest corner of the plan (Pukekawa falls away to the south and east)
  let gMin = g;
  for (const p of MUSEUM_PARTS) for (let i = 0; i < p.ring.length; i += 2) gMin = Math.min(gMin, height(p.ring[i], p.ring[i + 1]));
  const y0 = gMin - 1.5;
  const { stone, glass, cap } = MUSEUM_COLOURS;
  const cornice = shade(stone, 0.86);
  // the punched windows' storeys start at the lowest ground, as the Chief Post Office's do (auckland.ts)
  if (B.facades) B.setFacade(y0, STOREY, 0.37);
  for (const p of MUSEUM_PARTS) {
    const top = g + p.h;
    const band = Math.min(CORNICE, p.h * 0.2);
    walls(B, p.ring, y0, top - band, stone, WIN_HERITAGE);
    walls(B, p.ring, top - band, top, cornice, WIN_FLOOD);
    B.prism(p.ring, top, () => top, stone, p.roof, WIN_NONE, false);
  }
  if (B.facades) B.clearFacade();

  // the Grand Atrium: its glass ring up to the copper rim, a flat ring roof at the rim (it fills the grid's ragged edge),
  // and the LiDAR surface over every grid cell whose four corners lie inside the dome
  const d = MUSEUM_DOME;
  walls(B, d.ring, y0, g + d.rim, glass, WIN_LOBBY);
  B.prism(d.ring, g + d.rim, () => g + d.rim, glass, glass, WIN_NONE, false);
  for (let j = 0; j + 1 < d.nz; j++)
    for (let i = 0; i + 1 < d.nx; i++) {
      const h = [museumDomeAt(i, j), museumDomeAt(i + 1, j), museumDomeAt(i + 1, j + 1), museumDomeAt(i, j + 1)];
      if (h.some((v) => v === null)) continue;
      const [h0, h1, h2, h3] = h as number[];
      const [x0, z0] = museumDomeXZ(i, j);
      const [x1, z1] = museumDomeXZ(i + 1, j);
      const [x2, z2] = museumDomeXZ(i + 1, j + 1);
      const [x3, z3] = museumDomeXZ(i, j + 1);
      const c = (h0 + h1 + h2 + h3) / 4 > d.rim + GLASS_BAND ? cap : glass;
      // +x east, +z south: (0, 3, 2, 1) runs counter-clockwise seen from above, so the quad faces up
      B.quad(IDENT_FRAME, [x0, g + h0, z0, x3, g + h3, z3, x2, g + h2, z2, x1, g + h1, z1], c, WIN_NONE);
    }

  // the north portico: the entablature on its eight columns
  const P = MUSEUM_PORTICO;
  B.prism(P.ring, g + P.under, () => g + P.top, stone, shade(stone, 0.8), WIN_FLOOD);
  for (const [x, z, r] of P.columns) B.cylinder(IDENT_FRAME, x, y0, z, r, r * 0.9, g + P.under - y0, 10, stone, WIN_FLOOD, false);

  // the floodlights' glow on the north portico and the atrium's lantern
  lights.add(MUSEUM_CENTRE.x, g + 27, MUSEUM_CENTRE.z, 0xfff0d0, 10);
  return g;
}
