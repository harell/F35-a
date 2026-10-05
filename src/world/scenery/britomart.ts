/**
 * Britomart (Waitematā) station's own geometry over the tower kit's terraces (core/britomart.ts): the Chief Post
 * Office's two domes and its flagpole, the Glasshouse's entrance canopy, and the skylight cones over the tracks in
 * Takutai Square. Built into the caller's merged mesh: the CPO's and the Glasshouse's parts inside their buildings'
 * vertex ranges (so they fall with them), the cones on their own.
 */
import { CPO_DOMES, CPO_FLAGPOLE, GLASSHOUSE, GLASSHOUSE_CANOPY, TAKUTAI_CONES } from '../../core/britomart';
import { towerSkin } from '../../core/cbdTowerSkins';
import { GeometryBuilder, IDENT_FRAME, WIN_FLOOD, WIN_GLOW, WIN_NONE } from './GeometryBuilder';

type HeightFn = (x: number, z: number) => number;

/** Lead-grey domes and their stone drums (the aerial reads them pale: #dbd5ce in the sun). */
const DOME = 0xc6c2b8;
const POLE = 0xe8e8e4;
const CANOPY = 0x4a4f55;
const CONE = 0x3f4a52;
const OCULUS = 0x8fb6c8;

/** Rings of each dome: a quarter circle in this many steps. */
const DOME_STEPS = 5;

/** The CPO's domes and flagpole; `g` is the CPO's ground (world y). */
export function buildCpoCrowns(B: GeometryBuilder, g: number, detail: number): void {
  const segs = detail >= 0.5 ? 14 : 8;
  for (const d of CPO_DOMES) {
    // a stone drum up to the springing, then the dome as stacked frustums and a small lantern on its crown
    const rise = d.top - d.base;
    B.cylinder(IDENT_FRAME, d.x, g + d.base - 1.2, d.z, d.r * 1.08, d.r * 1.08, 1.2, segs, DOME, WIN_FLOOD, false);
    for (let i = 0; i < DOME_STEPS; i++) {
      const a0 = (i / DOME_STEPS) * (Math.PI / 2);
      const a1 = ((i + 1) / DOME_STEPS) * (Math.PI / 2);
      const y0 = g + d.base + rise * Math.sin(a0);
      const y1 = g + d.base + rise * Math.sin(a1);
      B.cylinder(IDENT_FRAME, d.x, y0, d.z, d.r * Math.cos(a0), d.r * Math.cos(a1) + (i === DOME_STEPS - 1 ? 0.05 : 0), y1 - y0, segs, DOME, WIN_FLOOD, i === DOME_STEPS - 1);
    }
    B.cylinder(IDENT_FRAME, d.x, g + d.top, d.z, 0.35, 0.2, 0.9, 6, DOME, WIN_NONE, true);
  }
  const f = CPO_FLAGPOLE;
  B.cylinder(IDENT_FRAME, f.x, g + f.foot, f.z, 0.09, 0.06, f.top - f.foot, 5, POLE, WIN_NONE, true);
}

/** The Glasshouse's entrance canopy on its east face; `g` is its ground (world y). */
export function buildGlasshouseCanopy(B: GeometryBuilder, g: number): void {
  const skin = towerSkin(GLASSHOUSE.n);
  if (!skin) return;
  // the east face: heading box.face + 90°, its outward normal and the viewer's right
  const a = ((skin.box.face + 90) * Math.PI) / 180;
  const nx = Math.sin(a);
  const nz = -Math.cos(a);
  const rx = nz;
  const rz = -nx;
  // the face stands where the outline reaches furthest along the normal
  let out = -Infinity;
  const r = GLASSHOUSE.outline;
  for (let i = 0; i < r.length; i += 2) out = Math.max(out, (r[i] - skin.box.x) * nx + (r[i + 1] - skin.box.z) * nz);
  const c = GLASSHOUSE_CANOPY;
  const p = (t: number, s: number): [number, number] => [skin.box.x + rx * t + nx * s, skin.box.z + rz * t + nz * s];
  const [t0, t1] = c.t;
  const ring = [...p(t0, out), ...p(t1, out), ...p(t1, out + c.depth), ...p(t0, out + c.depth)];
  // the slab, its soffit lit at night, and two posts at its outer corners
  B.prism(ring, g + c.soffit, () => g + c.top, CANOPY, CANOPY, WIN_NONE);
  // the soffit faces down: wind its corners so (p1 − p0) × (p3 − p0) points to −y
  let s = [p(t0, out), p(t1, out), p(t1, out + c.depth), p(t0, out + c.depth)];
  const up = (s[3][0] - s[0][0]) * (s[1][1] - s[0][1]) - (s[1][0] - s[0][0]) * (s[3][1] - s[0][1]);
  if (up > 0) s = s.reverse();
  const y = g + c.soffit - 0.02;
  B.quad(IDENT_FRAME, s.flatMap(([x, z]) => [x, y, z]), 0xf0ead8, WIN_GLOW);
  for (const t of [t0 + 0.4, t1 - 0.4]) {
    const [x, z] = p(t, out + c.depth - 0.4);
    B.cylinder(IDENT_FRAME, x, g, z, 0.14, 0.14, c.soffit, 6, 0xb8bcc0, WIN_NONE, false);
  }
}

/** The skylight cones in Takutai Square: dark tiled cones cut off at a glass oculus. */
export function buildTakutaiCones(B: GeometryBuilder, height: HeightFn, detail: number): void {
  if (detail < 0.5) return;
  for (const [x, z, r, h] of TAKUTAI_CONES) {
    const g = height(x, z);
    B.cylinder(IDENT_FRAME, x, g - 0.3, z, r, r * 0.4, h + 0.3, 12, CONE, WIN_NONE, true, OCULUS);
  }
}
