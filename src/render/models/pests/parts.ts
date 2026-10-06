/**
 * Shared small parts for the Codex pests: glossy eyes, whiskers, claws.
 */
import { Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, SphereGeometry } from 'three';
import { tube, type V3 } from './sdf';

/** A glossy mammal eye: a dark sphere with a clear-coat highlight, set into the head. */
export function eye(c: V3, r: number, scale: V3 = [1, 1, 1], tint = 0x0b0806): Mesh {
  const m = new Mesh(
    new SphereGeometry(r, 24, 16),
    new MeshPhysicalMaterial({ color: tint, roughness: 0.08, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02, sheen: 0.4, sheenColor: 0x3a2a20 }),
  );
  m.position.set(...c);
  m.scale.set(...scale);
  m.name = 'eye';
  return m;
}

/**
 * Whiskers fanning out from a muzzle pad on each side: `root` is the right pad (mirrored for the left),
 * each whisker curves back and droops slightly.
 */
export function whiskers(root: V3, len: number, count: number, color: number, r = 0.00035): Group {
  const g = new Group();
  g.name = 'whiskers';
  const mat = new MeshStandardMaterial({ color, roughness: 0.5 });
  for (const side of [1, -1])
    for (let i = 0; i < count; i++) {
      const u = count > 1 ? i / (count - 1) : 0.5;
      const L = len * (0.65 + 0.35 * Math.sin(u * Math.PI));
      const up = (u - 0.45) * 0.9;
      const [x, y, z] = root;
      const o: V3 = [x * side, y + (u - 0.5) * 0.004, z + (u - 0.5) * 0.004];
      const pts: V3[] = [
        o,
        [o[0] + side * L * 0.45, o[1] + up * L * 0.25, o[2] + L * 0.12],
        [o[0] + side * L * 0.8, o[1] + up * L * 0.3 - L * 0.06, o[2] + L * 0.38],
        [o[0] + side * L * 0.95, o[1] + up * L * 0.25 - L * 0.16, o[2] + L * 0.62],
      ];
      g.add(new Mesh(tube(pts, r, r * 0.15, { seg: 12, radial: 4 }), mat));
    }
  return g;
}

/** Claws: small curved dark tubes from each toe tip, pointing forward (-Z) and down. */
export function claws(tips: V3[], len: number, r: number, color = 0x2a211a): Group {
  const g = new Group();
  g.name = 'claws';
  const mat = new MeshStandardMaterial({ color, roughness: 0.35 });
  for (const [x, y, z] of tips)
    g.add(new Mesh(tube([[x, y + r, z], [x, y + r * 0.4, z - len * 0.6], [x, y - r * 0.6, z - len]], r, r * 0.15, { seg: 6, radial: 5 }), mat));
  return g;
}
