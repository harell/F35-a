/**
 * Auckland War Memorial Museum (Tāmaki Paenga Hira) on Pukekawa, from its measured parts (core/museum.ts): the
 * neoclassical block's LiDAR terraces in Portland-stone white, floodlit at night; the 2007 Grand Atrium's shallow
 * blue-grey glass dome on its copper ring over the southern apse; the old central dome in verdigris; the north
 * portico's eight columns. Colours from Auckland Council's 2023 3D mesh. One merged mesh with the caller's builder.
 */
import { MUSEUM_CENTRE, MUSEUM_COLUMNS, MUSEUM_PARTS, type MuseumPartKind } from '../../core/museum';
import { GeometryBuilder, IDENT_FRAME, WIN_FLOOD, WIN_NONE } from './GeometryBuilder';
import type { LightList } from './builders';

type HeightFn = (x: number, z: number) => number;

const STONE = 0xe8e2d4;
/** Wall colour, roof colour and wall style per part. */
const LOOK: Record<MuseumPartKind, [number, number, number]> = {
  block: [STONE, 0xb7b2a6, WIN_FLOOD],
  atrium: [0xa2683f, 0x5f7a88, WIN_NONE], // the copper ring's edge, the glass over it
  dome: [0x6f9e8c, 0x6f9e8c, WIN_NONE],
};

/** Build the museum; returns its ground (m), the terrain at its centre. */
export function buildMuseum(B: GeometryBuilder, lights: LightList, height: HeightFn): number {
  const g = height(MUSEUM_CENTRE.x, MUSEUM_CENTRE.z);
  // walls reach down to the lowest corner of the plan (Pukekawa falls away to the south and east)
  let gMin = g;
  for (const p of MUSEUM_PARTS) for (let i = 0; i < p.ring.length; i += 2) gMin = Math.min(gMin, height(p.ring[i], p.ring[i + 1]));
  const y0 = gMin - 1.5;
  for (const p of MUSEUM_PARTS) {
    const [c, rc, w] = LOOK[p.kind];
    B.prism(p.ring, y0, () => g + p.h, c, rc, w);
  }
  for (const [x, z, r, top] of MUSEUM_COLUMNS) B.cylinder(IDENT_FRAME, x, y0, z, r, r * 0.9, g + top - y0, 10, STONE, WIN_FLOOD, false);
  // the floodlights' glow on the north portico and the atrium's lantern
  lights.add(MUSEUM_CENTRE.x, g + 27, MUSEUM_CENTRE.z, 0xfff0d0, 10);
  return g;
}
