/**
 * German wasp worker (Vespula germanica), 14 mm: glossy black-and-yellow chitin, the gaster banded with
 * the black anterior edge, central point and paired dots of the species, a yellow face with three black
 * dots on the clypeus, kidney-shaped faceted eyes, elbowed antennae, three pairs of legs (black femora,
 * yellow tibiae and feet) and four clear veined wings held back over the body (they beat in the viewer:
 * each wing's userData.flap = { base, amp, side }, a roll about the body axis).
 * Built in millimetres and scaled to metres; front = -Z, up = +Y, origin on the ground between its feet.
 */
import { DoubleSide, Group, Mesh, MeshPhysicalMaterial, Shape, ShapeGeometry, SphereGeometry, type Vector3, Vector2 } from 'three';
import { furred } from './fur';
import { cone, ell, fbm, hex, mix, sculpt, smooth, tube, type Paint, type Prim, type V3 } from './sdf';
import { facets, waspWing } from './textures';

const BLACK = hex(0x16120d);
const YELLOW = hex(0xf0bf16);
const AMBER = hex(0xc98a1a);

/** Gaster segments (tergites): centre z, length (mm), radii. */
const SEGS: { z: number; y: number; rx: number; ry: number; rz: number }[] = [
  { z: 1.2, y: 3.05, rx: 1.6, ry: 1.5, rz: 1.1 },
  { z: 2.4, y: 2.85, rx: 2.1, ry: 1.92, rz: 1.3 },
  { z: 3.6, y: 2.62, rx: 2.12, ry: 1.88, rz: 1.25 },
  { z: 4.7, y: 2.38, rx: 1.85, ry: 1.64, rz: 1.1 },
  { z: 5.6, y: 2.15, rx: 1.42, ry: 1.25, rz: 0.9 },
  { z: 6.35, y: 1.95, rx: 0.92, ry: 0.82, rz: 0.65 },
];

function prims(): Prim[] {
  const p: Prim[] = [
    // head: wider than long, face tilted down
    ell('head', [0, 3.7, -5.55], [1.85, 1.75, 1.05], 0, [0.3, 0, 0]),
    ell('clypeus', [0, 2.75, -6.35], [0.75, 0.6, 0.35], 0.25, [0.5, 0, 0]),
    ell('mandible', [0.42, 2.15, -6.4], [0.38, 0.22, 0.4], 0.1, [0, 0.5, 0]),
    ell('mandible', [-0.42, 2.15, -6.4], [0.38, 0.22, 0.4], 0.1, [0, -0.5, 0]),
    // mesosoma: pronotum collar, the domed scutum, scutellum, propodeum
    cone('thorax', [0, 3.5, -4.35], [0, 3.75, -3.7], 0.75, 1.25, 0.3),
    ell('thorax', [0, 3.75, -2.55], [1.5, 1.6, 1.85], 0.45),
    ell('scutellum', [0, 4.85, -1.35], [0.85, 0.42, 0.55], 0.3),
    ell('thorax', [0, 3.55, -0.85], [1.15, 1.2, 0.75], 0.4),
    // the petiole and the gaster's segments (small blend: the plates' edges stay visible)
    cone('petiole', [0, 3.3, -0.35], [0, 3.15, 0.35], 0.35, 0.5, 0.15),
  ];
  SEGS.forEach((s, i) => p.push(ell(`g${i}`, [0, s.y, s.z], [s.rx, s.ry, s.rz], i ? 0.12 : 0.25)));
  p.push(cone('sting', [0, 1.85, 6.7], [0, 1.72, 7.2], 0.32, 0.06, 0.1));
  return p;
}

/** The black pattern on a gaster tergite: front band, a central point down into the yellow, two dots. */
function tergite(i: number, p: Vector3, up: number): number {
  const s = SEGS[i];
  const t = (p.z - (s.z - s.rz * 0.6)) / (s.rz * 1.6); // 0 front .. 1 rear of the exposed plate
  const x = p.x / s.rx;
  if (i === 0) return t < 0.62 ? 1 : 0; // the first segment is mostly black, a yellow hind band
  const below = up < -0.35 ? 1 : 0;
  const band = t < 0.34 ? 1 : 0;
  const point = Math.abs(x) < 0.22 * (1 - (t - 0.3) / 0.32) && t < 0.62 && !below ? 1 : 0;
  const dot = Math.hypot((Math.abs(x) - 0.55) / 0.16, (t - 0.55) / 0.13) < 1 && !below ? 1 : 0;
  return Math.max(band, point, dot);
}

function paint(p: Vector3, n: Vector3, part: string): Paint {
  const grain = fbm(p, 6) - 0.5;
  const up = n.y;
  if (part.startsWith('g')) {
    const i = +part.slice(1);
    const black = tergite(i, p, up);
    return { c: mix(mix(YELLOW, AMBER, 0.15 + grain * 0.3), BLACK, black), fur: 0.15 };
  }
  switch (part) {
    case 'sting':
      return { c: hex(0x3a2a16), fur: 0 };
    case 'mandible':
      return { c: mix(YELLOW, hex(0x2a1a0c), smooth(-6.3, -6.7, p.z)), fur: 0 };
    case 'clypeus': {
      // three black dots (Vespula germanica; the common wasp has an anchor mark instead)
      const d = Math.min(Math.hypot(p.x / 0.16, (p.y - 2.85) / 0.18), Math.hypot((Math.abs(p.x) - 0.38) / 0.12, (p.y - 2.6) / 0.14));
      return { c: d < 1 ? BLACK : YELLOW, fur: 0.15 };
    }
    case 'head': {
      // yellow face, the frons and the band behind the eyes; black crown
      const face = n.z < -0.25 && p.y < 4.2 ? 1 : 0;
      const gena = n.z > -0.1 && Math.abs(p.x) > 1.25 && p.y < 4.3 && p.y > 2.9 ? 1 : 0;
      const yellowNotch = Math.hypot(Math.abs(p.x) - 0.95, p.y - 4.1) < 0.28 && n.z < 0 ? 1 : 0;
      return { c: Math.max(face, gena, yellowNotch) ? YELLOW : BLACK, fur: 0.7 };
    }
    case 'scutellum':
      return { c: Math.hypot(Math.abs(p.x) - 0.38, p.z + 1.4) < 0.3 && up > 0.3 ? YELLOW : BLACK, fur: 0.6 };
    case 'petiole':
      return { c: BLACK, fur: 0.3 };
    default: {
      // the pronotum's yellow edge, yellow spots on the sides under the wings and on the propodeum
      const pronotum = p.z < -3.75 && p.z > -4.5 && up > -0.2 && Math.abs(p.x) > 0.6 ? 1 : 0;
      const pleuron = Math.hypot((Math.abs(p.x) - 1.3) / 0.3, (p.y - 3.5) / 0.28, (p.z + 3.0) / 0.4) < 1 ? 1 : 0;
      const prop = p.z > -1.0 && Math.hypot(Math.abs(p.x) - 0.45, p.y - 3.9) < 0.22 ? 1 : 0;
      return { c: Math.max(pronotum, pleuron, prop) ? YELLOW : BLACK, fur: 0.9 };
    }
  }
}

const chitin = (color: number) => new MeshPhysicalMaterial({ color, roughness: 0.4, clearcoat: 0.3, clearcoatRoughness: 0.3 });

/** A leg from the thorax: coxa, femur (black), tibia and five-jointed tarsus (yellow). */
function leg(pts: V3[], r: number): Mesh {
  const joints = [0.12, 0.42, 0.72];
  const geo = tube(pts, r, (u) => r * (u < 0.42 ? 1 : u < 0.72 ? 0.8 : 0.55 - 0.25 * (u - 0.72)), {
    seg: 60,
    radial: 8,
    color: (u) => {
      if (u < 0.36) return 0x17120d;
      if (u > 0.72) {
        const k = ((u - 0.72) / 0.28) * 5; // tarsal joints
        return k % 1 > 0.85 ? 0x6b4a14 : 0xd9a514;
      }
      return joints.some((j) => Math.abs(u - j) < 0.012) ? 0x5a3d10 : 0xe6b419;
    },
  });
  return new Mesh(geo, new MeshPhysicalMaterial({ vertexColors: true, roughness: 0.55, clearcoat: 0.15, clearcoatRoughness: 0.4 }));
}

/** An antenna: yellow-tipped scape, then the black flagellum curving forward and out. */
function antenna(side: number): Mesh {
  const s = side;
  const pts: V3[] = [
    [0.36 * s, 3.9, -6.4],
    [0.5 * s, 4.6, -6.85],
    [0.72 * s, 5.1, -7.05],
    [1.15 * s, 5.45, -7.75],
    [1.55 * s, 5.25, -8.55],
    [1.8 * s, 4.75, -9.05],
  ];
  const geo = tube(pts, 0.12, (u) => (u < 0.25 ? 0.12 : 0.11 + 0.025 * Math.sin(u * Math.PI) - 0.04 * u), {
    seg: 48,
    radial: 8,
    color: (u) => (u < 0.2 ? 0xd9a514 : u < 0.25 ? 0x3a2810 : 0x1c1610),
  });
  return new Mesh(geo, new MeshPhysicalMaterial({ vertexColors: true, roughness: 0.6 }));
}

/** A wing outline in its own (u, v): u root → tip, v leading → trailing edge. */
const FORE: [number, number][] = [
  [0, 0.16], [0.08, 0.04], [0.3, 0.0], [0.62, 0.0], [0.82, 0.05], [0.95, 0.16], [1.0, 0.3], [0.97, 0.46], [0.86, 0.62], [0.66, 0.76],
  [0.44, 0.84], [0.24, 0.84], [0.1, 0.72], [0.03, 0.5], [0, 0.3],
];
const HIND: [number, number][] = [
  [0, 0.2], [0.1, 0.05], [0.4, 0.0], [0.7, 0.04], [0.92, 0.18], [1.0, 0.36], [0.94, 0.56], [0.74, 0.74], [0.46, 0.84], [0.22, 0.86],
  [0.07, 0.7], [0, 0.42],
];

function wing(outline: [number, number][], L: number, W: number, hind: boolean): Mesh {
  const shape = new Shape();
  shape.splineThru([...outline, outline[0]].map(([u, v]) => new Vector2(u * L, -v * W)));
  const geo = new ShapeGeometry(shape, 24);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / L, -pos.getY(i) / W);
  // shape x → +Z (back along the body), shape y → +X (out to the side); a faint camber
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    pos.setXYZ(i, -y, 0.12 * Math.sin((x / L) * Math.PI) * (1 + y / W), x);
  }
  geo.computeVertexNormals();
  const m = new Mesh(
    geo,
    new MeshPhysicalMaterial({
      map: waspWing(hind),
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
      roughness: 0.12,
      metalness: 0,
      iridescence: 1,
      iridescenceIOR: 1.35,
      iridescenceThicknessRange: [220, 520],
      specularIntensity: 0.8,
    }),
  );
  m.renderOrder = 50;
  return m;
}

/** Fore and hind wing on one side, hinged at the tegula; folded back over the gaster at rest. */
function wingPair(side: number): Group {
  const hinge = new Group();
  hinge.name = side > 0 ? 'wing:R' : 'wing:L';
  hinge.position.set(1.15 * side, 4.55, -2.9);
  const set = new Group();
  // fore wing on top, the hind wing tucked beneath it
  const fore = wing(FORE, 9.4, 2.9, false);
  const hindW = wing(HIND, 6.6, 2.0, true);
  hindW.position.set(0, -0.12, 1.6);
  if (side < 0) {
    fore.scale.x = -1;
    hindW.scale.x = -1;
  }
  set.add(hindW, fore);
  // swept back and spread about 11° from the body axis, raised a little
  set.rotation.y = side * 0.2;
  set.rotation.x = -0.1;
  hinge.add(set);
  hinge.userData.flap = { base: side * 0.12, amp: 0.9, side };
  hinge.rotation.z = side * 0.12;
  return hinge;
}

/** Kidney-shaped compound eyes with a facet bump, and the three ocelli. */
function eyes(): Group {
  const g = new Group();
  const tex = facets().clone();
  tex.needsUpdate = true;
  tex.repeat.set(7, 4);
  tex.userData.own = true;
  const mat = new MeshPhysicalMaterial({ color: 0x1e150c, roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.12, bumpMap: tex, bumpScale: 1.0, sheen: 0.5, sheenColor: 0x5a3e1c });
  for (const s of [1, -1]) {
    const e = new Mesh(new SphereGeometry(1, 40, 28), mat);
    e.scale.set(0.46, 1.12, 0.66);
    e.position.set(1.42 * s, 3.68, -5.6);
    e.rotation.set(0.3, 0.15 * s, 0.12 * s);
    g.add(e);
    // the notch (emargination) on the inner edge is the yellow frons mark drawn on the head
  }
  const oc = new MeshPhysicalMaterial({ color: 0x2b2116, roughness: 0.1, clearcoat: 1 });
  for (const [x, y, z] of [
    [0, 5.25, -5.55],
    [0.36, 5.2, -5.25],
    [-0.36, 5.2, -5.25],
  ] as V3[]) {
    const o = new Mesh(new SphereGeometry(0.13, 12, 8), oc);
    o.position.set(x, y, z);
    g.add(o);
  }
  return g;
}

export function waspModel(detail = 1): Group {
  const inner = new Group();
  const body = prims();
  const h = 0.06 / detail;
  inner.add(
    furred(
      sculpt(body, paint, h),
      { shells: Math.round(6 * detail), length: 0.2, spacing: 0.06, comb: 0.3, thickness: 0.12, tip: 0x3a2a14, tipMix: 0.5, occlusion: 0.05, roughness: 1 },
      { roughness: 0.36, metalness: 0 },
      sculpt(body, paint, h * 1.6),
    ),
  );
  inner.add(eyes());
  inner.add(antenna(1), antenna(-1));
  // legs: front ones reach forward, the hind ones back; tarsi flat on the ground
  for (const s of [1, -1]) {
    inner.add(leg([[0.5 * s, 2.5, -3.9], [0.95 * s, 2.0, -4.0], [2.0 * s, 2.3, -4.6], [2.5 * s, 0.6, -5.0], [2.7 * s, 0.12, -5.6], [2.85 * s, 0.08, -6.4]], 0.22));
    inner.add(leg([[0.75 * s, 2.4, -2.6], [1.2 * s, 1.9, -2.5], [2.6 * s, 2.4, -2.2], [3.4 * s, 0.6, -1.9], [3.7 * s, 0.12, -1.5], [4.2 * s, 0.08, -0.8]], 0.24));
    inner.add(leg([[0.8 * s, 2.45, -1.4], [1.3 * s, 1.9, -1.0], [2.6 * s, 2.5, 0.4], [3.5 * s, 0.6, 1.8], [3.8 * s, 0.12, 2.6], [4.2 * s, 0.08, 3.8]], 0.26));
    inner.add(wingPair(s));
  }
  for (const s of [1, -1]) {
    // tegulae: the small yellow-brown scales over the wing roots
    const t = new Mesh(new SphereGeometry(0.34, 16, 12), chitin(0xb9851c));
    t.scale.set(0.8, 0.45, 1);
    t.position.set(1.12 * s, 4.5, -2.95);
    inner.add(t);
  }
  inner.scale.setScalar(0.001);
  const root = new Group();
  root.name = 'pest:wasp';
  root.add(inner);
  return root;
}

