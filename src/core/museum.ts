/**
 * F35-A — Auckland War Memorial Museum on the Domain (Pukekawa): the in-game model's shape, shared by
 * the scenery (world/scenery/auckland.ts buildMuseum draws it) and the sim (a solid obstacle that
 * collapses when the player's jet flies into it, sim/buildings.ts).
 *
 * The model is the hand-built one: a stone block with its portico on the north-west front, the upper
 * storey, the drum and the copper dome. (The LiDAR hero model of the museum and the Domain is still a
 * prototype in tools/hero/examples/ and not in the game.) The Domain itself is terrain: a jet that
 * flies into the hill crashes on the ground and the museum stands.
 *
 * Parts are boxes in the museum's frame (lx along the long axis, lz across it; −lz is the portico
 * side), from the ground up. World XZ follows GeometryBuilder.frameFromHeading.
 */
import { AKL } from './auckland';

/** Centre of the museum (game x, z) and the heading of its frame (rad). */
export const MUSEUM = { x: AKL.domain.x, z: AKL.domain.z, heading: 0.3 } as const;

export interface MuseumBox {
  /** Centre in the museum's frame (m). */
  lx: number;
  lz: number;
  /** Width along lx and depth along lz (m). */
  w: number;
  d: number;
  /** Base and height above the museum's ground (m). */
  y0: number;
  h: number;
}

/** The stone block, the portico and the upper storey. */
export const MUSEUM_BOXES: readonly MuseumBox[] = [
  { lx: 0, lz: 0, w: 104, d: 62, y0: 0, h: 22 },
  { lx: 0, lz: -35, w: 40, d: 10, y0: 0, h: 20 },
  { lx: 0, lz: 0, w: 40, d: 30, y0: 22, h: 6 },
];

/** The drum (radius 14 m, 28–32 m) and the copper dome on it (to 42 m). */
export const MUSEUM_DOME = { r: 14, drumY0: 28, drumH: 4, domeH: 10, domeTopR: 2 } as const;

/** Roof of the dome above the museum's ground (m). */
export const MUSEUM_TOP = MUSEUM_DOME.drumY0 + MUSEUM_DOME.drumH + MUSEUM_DOME.domeH;

/** World XZ of a point in the museum's frame. */
export function museumToWorld(lx: number, lz: number): [number, number] {
  const c = Math.cos(-MUSEUM.heading);
  const s = Math.sin(-MUSEUM.heading);
  return [MUSEUM.x + lx * c + lz * s, MUSEUM.z - lx * s + lz * c];
}

/**
 * The museum as the sim's prisms: a footprint ring (world XZ, flat) and the height of its top above
 * the ground. Every prism stands from the ground (the sim's buildings are prisms), so the upper
 * storey and the dome are columns inside the block's footprint.
 */
export function museumSolids(): { ring: Float32Array; h: number }[] {
  const out: { ring: Float32Array; h: number }[] = [];
  for (const b of MUSEUM_BOXES) {
    const x0 = b.lx - b.w / 2, x1 = b.lx + b.w / 2, z0 = b.lz - b.d / 2, z1 = b.lz + b.d / 2;
    out.push({ ring: Float32Array.from([...museumToWorld(x0, z0), ...museumToWorld(x1, z0), ...museumToWorld(x1, z1), ...museumToWorld(x0, z1)]), h: b.y0 + b.h });
  }
  // (a 12-gon round the drawn 16-sided drum, not inside it)
  const n = 12;
  const r = MUSEUM_DOME.r / Math.cos(Math.PI / n);
  const ring: number[] = [];
  for (let i = 0; i < n; i++) ring.push(...museumToWorld(Math.cos((i / n) * Math.PI * 2) * r, Math.sin((i / n) * Math.PI * 2) * r));
  out.push({ ring: Float32Array.from(ring), h: MUSEUM_TOP });
  return out;
}
