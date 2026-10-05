/**
 * Low-poly unit archetypes for instancing (vertex coloured; instance colour tints them):
 * conifer, broadleaf, palm (16–18 triangles each), merged house (walls + gable roof, 14) and
 * apartment block (walls + flat roof + plant room). Unit size: trees 1 m tall (scaled per
 * instance), buildings 1 × 1 × 1.
 */
import { BufferGeometry, Color } from 'three';
import { GeometryBuilder, WIN_HOME, WIN_INDUSTRIAL, WIN_OFFICE, type Frame } from './GeometryBuilder';

const F0: Frame = { ox: 0, oy: 0, oz: 0, c: 1, s: 0 };

/** Cone of `segs` triangles (apex up) — cheaper than a capped frustum. */
function cone(b: GeometryBuilder, y0: number, r: number, h: number, segs: number, color: Color | number, phase = 0): void {
  for (let i = 0; i < segs; i++) {
    const a0 = ((i + phase) / segs) * Math.PI * 2;
    const a1 = ((i + 1 + phase) / segs) * Math.PI * 2;
    b.tri(F0, [Math.cos(a1) * r, y0, Math.sin(a1) * r, Math.cos(a0) * r, y0, Math.sin(a0) * r, 0, y0 + h, 0], color);
  }
}

/** Conifer: 3-sided trunk + two stacked 6/5-sided cones (17 triangles). */
export function coniferGeometry(): BufferGeometry {
  const b = new GeometryBuilder();
  const trunk = 0x5a4430;
  const leafA = new Color(0x2f4a30);
  const leafB = new Color(0x3a5a38);
  b.cylinder(F0, 0, 0, 0, 0.05, 0.04, 0.2, 3, trunk, 0, false);
  cone(b, 0.15, 0.3, 0.6, 6, leafA);
  cone(b, 0.45, 0.22, 0.55, 5, leafB, 0.5);
  return b.build()!;
}

/** Broadleaf: 3-sided trunk + a 10-triangle bipyramid crown with shaded facets (16 triangles). */
export function broadleafGeometry(): BufferGeometry {
  const b = new GeometryBuilder();
  b.cylinder(F0, 0, 0, 0, 0.06, 0.045, 0.4, 3, 0x5c4630, 0, false);
  const c = new Color();
  const segs = 5;
  const yMid = 0.6;
  const top = 1.0;
  const bot = 0.3;
  const r = 0.46;
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const x0 = Math.cos(a0) * r;
    const z0 = Math.sin(a0) * r;
    const x1 = Math.cos(a1) * r;
    const z1 = Math.sin(a1) * r;
    c.setHex(0x3f6a34).multiplyScalar(0.85 + 0.3 * ((i * 0.37) % 1));
    b.tri(F0, [x1, yMid, z1, x0, yMid, z0, 0, top, 0], c);
    c.multiplyScalar(0.8);
    b.tri(F0, [x0, yMid, z0, x1, yMid, z1, 0, bot, 0], c);
  }
  return b.build()!;
}

/** Palm: 3-sided leaning trunk + six drooping fronds (18 triangles). */
export function palmGeometry(): BufferGeometry {
  const b = new GeometryBuilder();
  const trunk = 0x8a7456;
  const leaf = new Color(0x4a7a34);
  b.cylinder({ ...F0, c: Math.cos(0.08), s: Math.sin(0.08) }, 0.03, 0, 0, 0.05, 0.035, 0.95, 3, trunk, 0, false);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const cx = Math.cos(a);
    const cz = Math.sin(a);
    const tipX = 0.1 + cx * 0.5;
    const tipZ = cz * 0.5;
    const px = -cz * 0.08;
    const pz = cx * 0.08;
    b.tri(F0, [0.1, 0.95, 0, 0.1 + cx * 0.25 + px, 1.02, cz * 0.25 + pz, tipX, 0.75, tipZ], leaf);
    b.tri(F0, [0.1, 0.95, 0, tipX, 0.75, tipZ, 0.1 + cx * 0.25 - px, 1.02, cz * 0.25 - pz], leaf);
  }
  return b.build()!;
}

/**
 * House (merged, one instanced draw): four walls (unit box, windows) + gable roof (ridge along local
 * Z, rise 0.45 of the wall height). With the building material's HOUSES variant the roof takes the
 * instance colour and the walls a weatherboard tint derived from the instance position.
 */
export function houseGeometry(): BufferGeometry {
  const b = new GeometryBuilder();
  const w = 0xffffff;
  b.quad(F0, [-0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 1, 0.5, -0.5, 1, 0.5], w, WIN_HOME);
  b.quad(F0, [0.5, 0, -0.5, -0.5, 0, -0.5, -0.5, 1, -0.5, 0.5, 1, -0.5], w, WIN_HOME);
  b.quad(F0, [0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 1, -0.5, 0.5, 1, 0.5], w, WIN_HOME);
  b.quad(F0, [-0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 1, 0.5, -0.5, 1, -0.5], w, WIN_HOME);
  b.gable(F0, 0, 1, 0, 1.1, 1.08, 0.45, w);
  return b.build()!;
}

/**
 * Shed (real land use, #122: warehouses, big-box retail, hospital blocks, classrooms): walls with sparse industrial
 * windows over a darker band of loading doors / shopfronts at the foot, a flat roof (instance colour: metal greys, landUseLots.ts) and two
 * rooftop units. 16 triangles.
 */
export function shedGeometry(): BufferGeometry {
  const b = new GeometryBuilder();
  const w = 0xffffff;
  const band = 0x8c8c88;
  for (const [ax, az, bx, bz] of [
    [-0.5, 0.5, 0.5, 0.5],
    [0.5, -0.5, -0.5, -0.5],
    [0.5, 0.5, 0.5, -0.5],
    [-0.5, -0.5, -0.5, 0.5],
  ]) {
    b.quad(F0, [ax, 0, az, bx, 0, bz, bx, 0.35, bz, ax, 0.35, az], band);
    b.quad(F0, [ax, 0.35, az, bx, 0.35, bz, bx, 1, bz, ax, 1, az], w, WIN_INDUSTRIAL);
  }
  b.quad(F0, [-0.5, 1, 0.5, 0.5, 1, 0.5, 0.5, 1, -0.5, -0.5, 1, -0.5], w);
  b.box(F0, -0.2, 1, 0.1, 0.08, 0.04, 0.12, 0x9a9a98, 0x9a9a98);
  b.box(F0, 0.25, 1, -0.15, 0.06, 0.03, 0.1, 0x9a9a98, 0x9a9a98);
  return b.build()!;
}

/** Apartment / commercial block (merged): office-window walls + flat roof with a plant room. */
export function apartmentGeometry(): BufferGeometry {
  const b = new GeometryBuilder();
  const w = 0xffffff;
  b.quad(F0, [-0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 1, 0.5, -0.5, 1, 0.5], w, WIN_OFFICE);
  b.quad(F0, [0.5, 0, -0.5, -0.5, 0, -0.5, -0.5, 1, -0.5, 0.5, 1, -0.5], w, WIN_OFFICE);
  b.quad(F0, [0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 1, -0.5, 0.5, 1, 0.5], w, WIN_OFFICE);
  b.quad(F0, [-0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 1, 0.5, -0.5, 1, -0.5], w, WIN_OFFICE);
  b.quad(F0, [-0.5, 1, 0.5, 0.5, 1, 0.5, 0.5, 1, -0.5, -0.5, 1, -0.5], w);
  b.box(F0, 0.15, 1, -0.1, 0.3, 0.05, 0.25, 0xbdbdbd, 0xbdbdbd);
  return b.build()!;
}
