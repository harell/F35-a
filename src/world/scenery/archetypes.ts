/**
 * Low-poly unit archetypes for instancing (vertex coloured; instance colour tints them):
 * conifer, broadleaf, palm (≈12–24 triangles each), house walls / gable roof, apartment walls /
 * flat roof. Unit size: trees 1 m tall (scaled per instance), buildings 1 × 1 × 1.
 */
import { BufferAttribute, BufferGeometry, Color, IcosahedronGeometry } from 'three';
import { GeometryBuilder, WIN_HOME, WIN_OFFICE, type Frame } from './GeometryBuilder';
import type { TheaterId } from '../../core/types';

const F0: Frame = { ox: 0, oy: 0, oz: 0, c: 1, s: 0 };

export function coniferGeometry(snowy: boolean): BufferGeometry {
  const b = new GeometryBuilder();
  const trunk = 0x5a4430;
  const leafA = new Color(0x2f4a30);
  const leafB = new Color(0x3a5a38);
  const snow = new Color(0xe8eef4);
  b.cylinder(F0, 0, 0, 0, 0.05, 0.04, 0.2, 4, trunk, 0, false);
  b.cylinder(F0, 0, 0.15, 0, 0.3, 0.02, 0.55, 6, leafA, 0, true);
  b.cylinder(F0, 0, 0.45, 0, 0.22, 0.0, 0.55, 6, snowy ? snow : leafB, 0, false);
  return b.build()!;
}

export function broadleafGeometry(): BufferGeometry {
  const b = new GeometryBuilder();
  b.cylinder(F0, 0, 0, 0, 0.06, 0.045, 0.4, 4, 0x5c4630, 0, false);
  const trunk = b.build()!;
  const crown = new IcosahedronGeometry(0.42, 0); // already non-indexed
  const p = crown.getAttribute('position') as BufferAttribute;
  const cols = new Float32Array(p.count * 3);
  const c = new Color();
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i, p.getX(i) * 1.05, p.getY(i) * 0.82 + 0.62, p.getZ(i) * 1.05);
    const shade = 0.8 + 0.35 * ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) * 0.5;
    c.setHex(0x3f6a34).multiplyScalar(shade);
    cols[i * 3] = c.r;
    cols[i * 3 + 1] = c.g;
    cols[i * 3 + 2] = c.b;
  }
  crown.setAttribute('color', new BufferAttribute(cols, 3));
  crown.computeVertexNormals();
  return mergeSimple([trunk, crown]);
}

export function palmGeometry(): BufferGeometry {
  const b = new GeometryBuilder();
  const trunk = 0x8a7456;
  const leaf = new Color(0x4a7a34);
  // slightly leaning two-segment trunk
  b.beam(F0, 0, 0, 0, 0.04, 0.5, 0, 0.07, trunk);
  b.beam(F0, 0.04, 0.5, 0, 0.1, 0.95, 0, 0.06, trunk);
  // six drooping fronds
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

/** House walls (unit box) — instance scale sets footprint and wall height. */
export function houseWallsGeometry(): BufferGeometry {
  const b = new GeometryBuilder();
  b.box(F0, 0, 0, 0, 1, 1, 1, 0xffffff, 0xffffff, WIN_HOME);
  return b.build()!;
}

/** Gable roof sitting on the unit box (rise 0.45 of the wall height). */
export function houseRoofGeometry(): BufferGeometry {
  const b = new GeometryBuilder();
  b.gable(F0, 0, 1, 0, 1.08, 1.06, 0.45, 0xffffff);
  return b.build()!;
}

export function apartmentWallsGeometry(): BufferGeometry {
  const b = new GeometryBuilder();
  b.box(F0, 0, 0, 0, 1, 1, 1, 0xffffff, 0xffffff, WIN_OFFICE);
  return b.build()!;
}

export function apartmentRoofGeometry(): BufferGeometry {
  const b = new GeometryBuilder();
  b.box(F0, 0, 1, 0, 0.35, 0.04, 0.3, 0xffffff, 0xffffff);
  b.quad(F0, [-0.5, 1.001, 0.5, 0.5, 1.001, 0.5, 0.5, 1.001, -0.5, -0.5, 1.001, -0.5], 0xffffff);
  return b.build()!;
}

/** Tree tint per theatre (multiplied with the archetype's vertex colour). */
export function treeTint(theater: TheaterId): Color {
  switch (theater) {
    case 'desert':
      return new Color(1.05, 1.0, 0.8);
    case 'arctic':
      return new Color(0.85, 0.92, 0.9);
    case 'islands':
      return new Color(0.95, 1.1, 0.9);
    default:
      return new Color(1, 1, 1);
  }
}

/** Merge non-indexed/indexed geometries that share position/normal/color attributes. */
function mergeSimple(list: BufferGeometry[]): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const win: number[] = [];
  for (const g0 of list) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    const p = g.getAttribute('position');
    const n = g.getAttribute('normal');
    const c = g.getAttribute('color');
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      col.push(c ? c.getX(i) : 1, c ? c.getY(i) : 1, c ? c.getZ(i) : 1);
      win.push(0);
    }
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  out.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  out.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  out.setAttribute('aWin', new BufferAttribute(new Float32Array(win), 1));
  return out;
}
