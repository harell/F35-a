/**
 * Ground-vehicle / structure primitive kit (tracked & wheeled chassis, radar dishes, masts, soldiers,
 * buildings). Everything is vertex-coloured and rendered with the shared 'vehicle' / 'building'
 * Lambert materials (grime texture via box-projected UVs), so each merged object is one draw call.
 * Vehicle front = -Z, up = +Y, origin on the ground at the vehicle centre.
 */
import { BufferGeometry, Mesh, Object3D } from 'three';
import { box, boxUV, cylinder, cylinderZ, dome, ellipsoid, flipWinding, merge, place } from './geom/core';
import { latheZ, prismX } from './geom/loft';
import { getMaterial } from './materials';

/** Camouflage schemes for enemy vehicles and sites (one today: Auckland's green). */
export type PaletteId = 'green';

export interface Palette {
  body: number;
  dark: number;
  track: number;
  canvas: number;
  concrete: number;
  earth: number;
  metal: number;
  glass: number;
  white: number;
  roof: number;
}

export const PALETTES: Record<PaletteId, Palette> = {
  green: { body: 0x4e5c3a, dark: 0x303827, track: 0x2b2b29, canvas: 0x5d6545, concrete: 0x9a9890, earth: 0x6e6a4a, metal: 0x6f7472, glass: 0x1c2328, white: 0xe2e1da, roof: 0x5f625f },
};

/** Merge + UV + mesh with a shared material. */
export function meshFrom(geos: BufferGeometry[], mat = 'vehicle', uvScale = mat === 'building' ? 0.08 : 0.3): Mesh {
  const g = merge(geos)!;
  boxUV(g, uvScale);
  g.computeBoundingSphere();
  const m = new Mesh(g, getMaterial(mat));
  return m;
}

/** Node (pivot) holding a merged mesh, positioned at `pos`. */
export function nodeFrom(name: string, geos: BufferGeometry[], pos: [number, number, number], mat = 'vehicle'): Object3D {
  const o = new Object3D();
  o.name = name;
  o.position.set(...pos);
  if (geos.length) o.add(meshFrom(geos, mat));
  return o;
}

/** Tracked armoured chassis: two track runs + hull with sloped glacis (front at -Z). */
export function trackedChassis(L: number, W: number, H: number, pal: Palette, z0 = 0): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  const tw = 0.55;
  const th = 0.85;
  const r = th / 2;
  const prof: [number, number][] = [];
  for (let i = 0; i <= 6; i++) {
    const a = Math.PI / 2 + (i / 6) * Math.PI;
    prof.push([-L / 2 + r + Math.cos(a) * r, r + Math.sin(a) * r]);
  }
  for (let i = 0; i <= 6; i++) {
    const a = -Math.PI / 2 + (i / 6) * Math.PI;
    prof.push([L / 2 - r + Math.cos(a) * r, r + Math.sin(a) * r]);
  }
  const shifted = prof.map(([z, y]) => [z + z0, y] as [number, number]);
  // prismX expects CCW (z,y); the stadium above is CW → reverse
  const track = prismX(shifted.slice().reverse(), tw, pal.track, W / 2 - tw);
  out.push(track, prismX(shifted.slice().reverse(), tw, pal.track, -W / 2));
  // road wheel hubs (visual rhythm)
  for (let i = 0; i < 5; i++) {
    const z = z0 - L / 2 + r + ((L - 2 * r) * i) / 4;
    out.push(place(cylinder(0.3, 0.3, W + 0.04, 8, pal.dark), [0, 0.38, z], [0, 0, Math.PI / 2]));
  }
  const hull = prismX(
    [
      [z0 - L / 2 - 0.05, 0.62 + H * 0.45],
      [z0 - L / 2 + 0.9, 0.45],
      [z0 + L / 2, 0.45],
      [z0 + L / 2, 0.45 + H],
      [z0 - L / 2 + 1.2, 0.45 + H],
    ].reverse() as [number, number][],
    W - 0.1,
    pal.body,
  );
  out.push(hull);
  return out;
}

/** Wheeled truck chassis (front = -Z): frame, wheels at axle z positions, cab with windows. */
export function wheeledChassis(L: number, W: number, axles: number[], wheelR: number, pal: Palette, cabLen = 2.2, cabH = 2.4): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  out.push(place(box(W * 0.8, 0.35, L, pal.dark), [0, wheelR + 0.15, 0]));
  for (const z of axles) {
    for (const s of [-1, 1]) out.push(place(cylinder(wheelR, wheelR, 0.42, 10, pal.track), [s * (W / 2 - 0.2), wheelR, z], [0, 0, Math.PI / 2]));
  }
  const cz = -L / 2 + cabLen / 2;
  // load deck / body behind the cab, over the wheels
  const deckLen = L - cabLen - 0.2;
  if (deckLen > 0.5) out.push(place(box(W, 0.5, deckLen, pal.body), [0, wheelR * 2 + 0.05, -L / 2 + cabLen + 0.2 + deckLen / 2]));
  out.push(
    prismX(
      [
        [cz - cabLen / 2, wheelR + 0.3],
        [cz + cabLen / 2, wheelR + 0.3],
        [cz + cabLen / 2, wheelR + cabH],
        [cz - cabLen / 2 + 0.45, wheelR + cabH],
        [cz - cabLen / 2, wheelR + cabH * 0.62],
      ].reverse() as [number, number][],
      W,
      pal.body,
    ),
  );
  // windscreen band
  out.push(place(box(W * 0.9, cabH * 0.25, 0.08, pal.glass), [0, wheelR + cabH * 0.8, cz - cabLen / 2 + 0.24], [-0.35, 0, 0]));
  return out;
}

/** Parabolic dish of radius R opening towards -Z (forward): concave front + convex back shell, feed horn. */
export function dish(R: number, depth: number, color: number, feed = true): BufferGeometry[] {
  const prof: [number, number][] = [];
  for (let i = 0; i <= 5; i++) {
    const r = R * (1 - i / 5);
    prof.push([-depth * (r / R) * (r / R), Math.max(0.01, r)]);
  }
  const front = latheZ(prof, 12, { color });
  // concave side must face forward: flip orientation (the lathe helper builds outward faces)
  const back = latheZ(
    prof.map(([z, r]) => [z + 0.04, r] as [number, number]),
    12,
    { color: 0x4a4d4b },
  );
  const out = [flipWinding(front, true), back];
  if (feed) out.push(cylinderZ(0.03, 0.03, -depth - R * 0.7, -depth * 0.2, 5, 0x3a3a3a), place(box(0.12, 0.12, 0.12, 0x333333), [0, 0, -depth - R * 0.7]));
  return out;
}

/** Flat rectangular antenna panel (phased array / Yagi frame) facing -Z. */
export function panel(w: number, h: number, t: number, color: number, frame = 0x3b3e3c): BufferGeometry[] {
  return [box(w, h, t, color), place(box(w + 0.1, 0.08, t + 0.06, frame), [0, h / 2, 0]), place(box(w + 0.1, 0.08, t + 0.06, frame), [0, -h / 2, 0])];
}

/** Lattice-ish mast (4 legs + rungs), height h, base width w. */
export function mast(h: number, w: number, color: number): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) out.push(place(box(0.12, h, 0.12, color), [sx * w * 0.35, h / 2, sz * w * 0.35], [sz * 0.03, 0, -sx * 0.03]));
  for (let y = 1.5; y < h; y += 2.5) {
    out.push(place(box(w * 0.75, 0.08, 0.08, color), [0, y, w * 0.33]), place(box(w * 0.75, 0.08, 0.08, color), [0, y, -w * 0.33]));
    out.push(place(box(0.08, 0.08, w * 0.75, color), [w * 0.33, y, 0]), place(box(0.08, 0.08, w * 0.75, color), [-w * 0.33, y, 0]));
  }
  return out;
}

/** 1.8 m soldier (optionally kneeling), facing -Z. */
export function soldier(pal: Palette, kneel = false): BufferGeometry[] {
  const k = kneel ? 0.55 : 0;
  return [
    place(box(0.34, 0.8 - k * 0.5, 0.22, pal.dark), [0, (0.8 - k * 0.5) / 2, kneel ? 0.15 : 0]),
    place(box(0.42, 0.62, 0.26, pal.canvas), [0, 1.12 - k, 0]),
    place(ellipsoid(0.13, 0.14, 0.13, 8, 6, 0x3f4436), [0, 1.55 - k, 0]),
  ];
}

/** Box building with flat roof slab. */
export function building(w: number, h: number, d: number, wall: number, roof: number, pos: [number, number, number] = [0, 0, 0]): BufferGeometry[] {
  return [place(box(w, h, d, wall), [pos[0], pos[1] + h / 2, pos[2]]), place(box(w + 0.3, 0.3, d + 0.3, roof), [pos[0], pos[1] + h + 0.15, pos[2]])];
}

/** Sawtooth-roof factory hall along X. */
export function sawtoothHall(w: number, h: number, d: number, teeth: number, wall: number, roof: number, pos: [number, number, number]): BufferGeometry[] {
  const out = [place(box(w, h, d, wall), [pos[0], pos[1] + h / 2, pos[2]])];
  const tw = d / teeth;
  for (let i = 0; i < teeth; i++) {
    const z0 = pos[2] - d / 2 + i * tw;
    out.push(
      prismX(
        [
          [z0, pos[1] + h],
          [z0 + tw, pos[1] + h],
          [z0 + tw, pos[1] + h + tw * 0.55],
        ],
        w,
        roof,
        pos[0] - w / 2,
      ),
    );
  }
  return out;
}

/** Vertical cylinder tank with a shallow dome roof. */
export function tank(r: number, h: number, color: number, pos: [number, number, number]): BufferGeometry[] {
  return [place(cylinder(r, r, h, 16, color), [pos[0], pos[1] + h / 2, pos[2]]), place(dome(r, r * 0.25, r, 16, 3, color), [pos[0], pos[1] + h, pos[2]])];
}

export { box, cylinder, cylinderZ, dome, ellipsoid, place };
