/**
 * Westfield Newmarket (277 + 309 Broadway) from its measured parts (core/westfieldNewmarket.ts): the two blocks at their
 * LiDAR roof heights with their plinths, the white diamond screen over 277's car park, 309's white precast and dark
 * upper levels, the open car-park decks on the motorway side, the Broadway shopfronts and glass bays, the teal glass air
 * bridge over Mortimer Pass and the glass dome on the 277 corner rotunda. Walls from Mapillary street imagery. Glass is
 * curtain wall, lit from inside at night like the CBD towers'. One merged mesh with the caller's builder; procedural Newmarket keeps out of its footprint
 * (westfieldCovers).
 */
import { WESTFIELD_BRIDGE, WESTFIELD_CENTRE, WESTFIELD_DOME, WESTFIELD_FACADES, WESTFIELD_PRISMS, type WestfieldMat } from '../../core/westfieldNewmarket';
import { frameFromHeading, GeometryBuilder, IDENT_FRAME, WIN_CURTAIN, WIN_FLOOD, WIN_NONE, WIN_RIBS } from './GeometryBuilder';
import type { LightList } from './builders';

type HeightFn = (x: number, z: number) => number;

/** Wall colour and style per material (Mapillary street imagery, 2021–25). */
const MAT: Record<WestfieldMat, [number, number]> = {
  lattice: [0xe8eae6, WIN_FLOOD], // the white diamond screen over 277's car park
  precast_light: [0xdcdad3, WIN_FLOOD],
  precast_dark: [0x4b4f53, WIN_NONE],
  glass: [0x6d8a97, WIN_CURTAIN],
  carpark: [0xbdbdb6, WIN_RIBS], // open decks behind white fins
  slate: [0x55595c, WIN_NONE],
  shopfront: [0x8a9ba4, WIN_CURTAIN],
  metal: [0xb9bcbe, WIN_RIBS],
  glass_teal: [0x3f9a9a, WIN_CURTAIN],
};
const ROOF = 0x8e8f8b;

const inRing = (r: ArrayLike<number>, x: number, z: number) => {
  let c = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
};

/** Inside the mall's footprint, or within `margin` m of its centre box: nothing procedural stands there. */
export function westfieldCovers(x: number, z: number, margin = 0): boolean {
  if (Math.abs(x - WESTFIELD_CENTRE.x) > 220 + margin || Math.abs(z - WESTFIELD_CENTRE.z) > 220 + margin) return false;
  if (WESTFIELD_PRISMS.some((p) => inRing(p.ring, x, z))) return true;
  if (!margin) return false;
  for (const p of WESTFIELD_PRISMS)
    for (let i = 0; i < p.ring.length; i += 2) if (Math.hypot(p.ring[i] - x, p.ring[i + 1] - z) < margin) return true;
  return false;
}

/** Build the mall; returns its ground (m), the terrain at its centroid. */
export function buildWestfieldNewmarket(B: GeometryBuilder, lights: LightList, height: HeightFn): number {
  const g = height(WESTFIELD_CENTRE.x, WESTFIELD_CENTRE.z);
  for (const p of WESTFIELD_PRISMS) {
    let gMin = g;
    for (let i = 0; i < p.ring.length; i += 2) gMin = Math.min(gMin, height(p.ring[i], p.ring[i + 1]));
    const y0 = gMin - 1.5;
    const [c, w] = MAT[p.wall];
    let from = y0;
    if (p.base) {
      // the plinth up to its height, the wall above it (no coplanar faces)
      const [bc, bw] = MAT[p.base.mat];
      const top = Math.max(y0 + 1, g + p.base.h);
      B.prism(p.ring, y0, () => top, bc, bc, bw);
      from = top;
    }
    B.prism(p.ring, from, () => g + p.h, c, ROOF, w);
  }
  // facade panels 0.2 m proud of their edge, facing away from the mall's centre
  for (const f of WESTFIELD_FACADES) {
    const [ax, az] = f.a;
    const [bx, bz] = f.b;
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.5) continue;
    let nx = (bz - az) / len;
    let nz = -(bx - ax) / len;
    if (nx * ((ax + bx) / 2 - WESTFIELD_CENTRE.x) + nz * ((az + bz) / 2 - WESTFIELD_CENTRE.z) < 0) {
      nx = -nx;
      nz = -nz;
    }
    const o = 0.2;
    const [c, w] = MAT[f.mat];
    const y0 = g + f.y0;
    const y1 = g + f.y1;
    // quad's normal = (p1 − p0) × up = (−tz, tx): the bottom edge runs along (nz, −nx) for an outward (nx, nz)
    const along = (bx - ax) * nz - (bz - az) * nx > 0;
    const [p0x, p0z, p1x, p1z] = along ? [ax, az, bx, bz] : [bx, bz, ax, az];
    B.quad(IDENT_FRAME, [p0x + nx * o, y0, p0z + nz * o, p1x + nx * o, y0, p1z + nz * o, p1x + nx * o, y1, p1z + nz * o, p0x + nx * o, y1, p0z + nz * o], c, w);
  }
  // the air bridge over Mortimer Pass
  const b = WESTFIELD_BRIDGE;
  const [fx, fz] = b.from;
  const [tx, tz] = b.to;
  const mx = (fx + tx) / 2;
  const mz = (fz + tz) / 2;
  const fr = frameFromHeading(mx, g + b.y0, mz, Math.atan2(tx - fx, -(tz - fz)));
  B.box(fr, 0, 0, 0, b.width, b.y1 - b.y0, Math.hypot(tx - fx, tz - fz), MAT.glass_teal[0], 0x6f7a7c, MAT.glass_teal[1]);
  // the rotunda's glass dome: a few rings, narrower as they rise
  const d = WESTFIELD_DOME;
  const n = 4;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * (Math.PI / 2);
    const a1 = ((i + 1) / n) * (Math.PI / 2);
    const y0 = g + d.y + Math.sin(a0) * d.r * d.squash;
    const y1 = g + d.y + Math.sin(a1) * d.r * d.squash;
    B.cylinder(IDENT_FRAME, d.x, y0, d.z, d.r * Math.cos(a0), d.r * Math.cos(a1), y1 - y0, 16, MAT.glass[0], WIN_CURTAIN, i === n - 1);
  }
  lights.add(d.x, g + d.y + d.r * d.squash + 1, d.z, 0xfff0d0, 6);
  return g;
}
