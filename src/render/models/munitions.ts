/**
 * Missile / bomb models (AIM-120, AIM-9X, R-73, R-27, R-77 lattice fins, SAM missiles, JDAM, SDB,
 * AARGM). One merged mesh per munition type (vertex-coloured 'munition' material → 1 draw call).
 * Origin at mid-length, nose = -Z. Built at the reference dimensions in specs.MUNITION_DIMS;
 * instances are rescaled to the combat definition's length/diameter.
 */
import { BufferGeometry, Mesh } from 'three';
import type { MunitionId } from '../../core/types';
import { box, merge, place } from './geom/core';
import { liftingSurface, loftRings, superRing } from './geom/loft';
import { getMaterial } from './materials';
import { MUNITION_DIMS } from './specs';

interface FinSet {
  /** z of the root leading edge as a fraction of length from the nose (0..1). */
  at: number;
  root: number;
  tip: number;
  span: number;
  /** LE sweep offset of the tip (m). */
  sweep: number;
  count?: number;
  /** Roll offset (rad): 0 = + configuration, π/4 = X configuration. */
  roll?: number;
  thick?: number;
  color?: number;
}

interface MissileSpec {
  body: number;
  nose: number;
  /** Nose length (m). */
  noseLen: number;
  /** Ogive bluntness 0..1 (0 = sharp cone). */
  blunt?: number;
  /** Tail boat-tail radius fraction. */
  tail?: number;
  /** Colour bands [fraction from nose, width m, colour]. */
  bands?: [number, number, number][];
  fins: FinSet[];
  /** Cross-section squareness (2 = round). */
  square?: number;
  extra?: (L: number, R: number) => BufferGeometry[];
}

/** Deployed "Diamond Back" wings on top of an SDB-family body. */
function sdbWings(L: number, R: number): BufferGeometry[] {
  const wing = liftingSurface(
    [
      { x: 0.02, y: 0, zLE: -L / 2 + 0.55, zTE: -L / 2 + 0.72, t: 0.012 },
      { x: 0.7, y: 0, zLE: -L / 2 + 0.95, zTE: -L / 2 + 1.05, t: 0.008 },
    ],
    { profile: 'flat', chordPoints: 3, color: 0x8a9094 },
  );
  place(wing, [0, R * 1.05, 0]);
  const left = place(wing.clone(), [0, 0, 0], [0, 0, 0], [-1, 1, 1]);
  return [wing, left];
}

const cache = new Map<MunitionId, BufferGeometry>();

function body(L: number, R: number, s: MissileSpec): BufferGeometry[] {
  const seg = 10;
  const z0 = -L / 2;
  const prof: [number, number, number][] = []; // z, r, colour
  const nl = s.noseLen;
  const nSteps = 6;
  for (let i = 0; i <= nSteps; i++) {
    const t = i / nSteps;
    const r = R * Math.max(s.blunt ? 0.12 * s.blunt : 0.02, Math.sqrt(1 - (1 - t) * (1 - t)) * (1 - 0.15 * (1 - t) * (s.blunt ?? 0)));
    prof.push([z0 + nl * t, i === 0 ? R * 0.04 : r, s.nose]);
  }
  prof.push([z0 + L * 0.93, R, s.body]);
  prof.push([z0 + L, R * (s.tail ?? 0.82), s.body]);
  const stations = prof.map(([z, r]) => ({ z, ring: superRing(0, 0, r, r, s.square ?? 2, seg, 0) }));
  const g = loftRings(stations, { capEnd: true, color: s.body });
  // colour: nose section vs body via position test
  const pos = g.attributes.position.array as Float32Array;
  const col = g.attributes.color.array as Float32Array;
  const cN = hexToLin(s.nose);
  const cB = hexToLin(s.body);
  for (let i = 0; i < pos.length / 3; i++) {
    const z = pos[i * 3 + 2];
    let c = z < z0 + nl * 0.98 ? cN : cB;
    for (const [f, w, bc] of s.bands ?? []) {
      const zc = z0 + f * L;
      if (Math.abs(z - zc) < w / 2) c = hexToLin(bc);
    }
    col[i * 3] = c[0];
    col[i * 3 + 1] = c[1];
    col[i * 3 + 2] = c[2];
  }
  // extra rings for sharp colour bands: add thin band cylinders slightly proud of the body
  const parts: BufferGeometry[] = [g];
  for (const [f, w, bc] of s.bands ?? []) {
    const zc = z0 + f * L;
    const band = loftRings(
      [
        { z: zc - w / 2, ring: superRing(0, 0, R * 1.012, R * 1.012, s.square ?? 2, seg, 0) },
        { z: zc + w / 2, ring: superRing(0, 0, R * 1.012, R * 1.012, s.square ?? 2, seg, 0) },
      ],
      { color: bc },
    );
    parts.push(band);
  }
  return parts;
}

function hexToLin(hex: number): [number, number, number] {
  const f = (c: number) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return [f((hex >> 16) & 255), f((hex >> 8) & 255), f(hex & 255)];
}

function fins(L: number, R: number, f: FinSet, color: number): BufferGeometry[] {
  const z0 = -L / 2 + f.at * L;
  const t = f.thick ?? Math.max(0.006, R * 0.08);
  const fin = liftingSurface(
    [
      { x: R * 0.85, y: 0, zLE: z0, zTE: z0 + f.root, t },
      { x: R + f.span, y: 0, zLE: z0 + f.sweep, zTE: z0 + f.sweep + f.tip, t: t * 0.7 },
    ],
    { profile: 'flat', chordPoints: 3, color: f.color ?? color },
  );
  const out: BufferGeometry[] = [];
  const n = f.count ?? 4;
  for (let i = 0; i < n; i++) out.push(place(fin.clone(), [0, 0, 0], [0, 0, (f.roll ?? 0) + (i * Math.PI * 2) / n]));
  return out;
}

/** Grid ("lattice") fin: rectangular frame with internal diagonal slats (R-77). */
function latticeFins(L: number, R: number, color: number): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  const chord = 0.09;
  const w = 0.2;
  const h = 0.16;
  const th = 0.008;
  const zc = L / 2 - chord / 2 - 0.02;
  const one: BufferGeometry[] = [];
  const x0 = R + 0.01;
  one.push(place(box(th, h, chord, color), [x0, 0, zc]));
  one.push(place(box(th, h, chord, color), [x0 + w, 0, zc]));
  one.push(place(box(w, th, chord, color), [x0 + w / 2, h / 2, zc]));
  one.push(place(box(w, th, chord, color), [x0 + w / 2, -h / 2, zc]));
  for (let k = -1; k <= 1; k += 2) {
    one.push(place(box(Math.hypot(w, h), th * 0.8, chord, color), [x0 + w / 2, 0, zc], [0, 0, k * Math.atan2(h, w)]));
  }
  const m = merge(one)!;
  for (let i = 0; i < 4; i++) out.push(place(m.clone(), [0, 0, 0], [0, 0, Math.PI / 4 + (i * Math.PI) / 2]));
  return out;
}

const W = 0xe6e6e2;
const GREY = 0xbdc1c4;

const SPECS: Record<MunitionId, MissileSpec> = {
  aim120: {
    body: W,
    nose: 0xd9d9d2,
    noseLen: 0.5,
    bands: [
      [0.24, 0.035, 0xd8b22a],
      [0.5, 0.035, 0x7a5a3a],
    ],
    fins: [
      { at: 0.4, root: 0.42, tip: 0.1, span: 0.16, sweep: 0.3, roll: Math.PI / 4 },
      { at: 0.88, root: 0.34, tip: 0.14, span: 0.2, sweep: 0.16, roll: Math.PI / 4 },
    ],
  },
  aim9x: {
    body: GREY,
    nose: 0x303436,
    noseLen: 0.22,
    blunt: 1,
    bands: [[0.2, 0.03, 0xd8b22a]],
    fins: [
      { at: 0.22, root: 0.36, tip: 0.3, span: 0.035, sweep: 0.03, roll: Math.PI / 4 },
      { at: 0.88, root: 0.26, tip: 0.2, span: 0.12, sweep: 0.05, roll: Math.PI / 4 },
    ],
  },
  r73: {
    body: 0xd6d9d4,
    nose: 0x2c2f31,
    noseLen: 0.2,
    blunt: 1,
    fins: [
      { at: 0.06, root: 0.08, tip: 0.05, span: 0.05, sweep: 0.03 },
      { at: 0.12, root: 0.22, tip: 0.1, span: 0.13, sweep: 0.1 },
      { at: 0.82, root: 0.45, tip: 0.18, span: 0.2, sweep: 0.22 },
    ],
  },
  r27: {
    body: 0xebebe6,
    nose: 0xdad7cc,
    noseLen: 0.6,
    fins: [
      { at: 0.36, root: 0.78, tip: 0.34, span: 0.34, sweep: 0.5 },
      { at: 0.88, root: 0.4, tip: 0.2, span: 0.22, sweep: 0.15 },
    ],
  },
  r77: {
    body: 0xdfe0dc,
    nose: 0xcfcfc6,
    noseLen: 0.55,
    fins: [{ at: 0.34, root: 1.0, tip: 0.8, span: 0.06, sweep: 0.2 }],
    extra: (L, R) => latticeFins(L, R, 0xbfc2c0),
  },
  m_3m9: {
    body: 0xe8e7e0,
    nose: 0x5d6a4c,
    noseLen: 0.9,
    bands: [[0.33, 0.05, 0xb3261e]],
    fins: [
      { at: 0.38, root: 1.1, tip: 0.35, span: 0.45, sweep: 0.75 },
      { at: 0.86, root: 0.62, tip: 0.3, span: 0.36, sweep: 0.3, roll: Math.PI / 4 },
    ],
    extra: (L, R) => {
      const out: BufferGeometry[] = [];
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + (i * Math.PI) / 2;
        const g = loftRings(
          [
            { z: -L / 2 + L * 0.45, ring: superRing(0, 0, 0.02, 0.02, 2, 6, 0) },
            { z: -L / 2 + L * 0.5, ring: superRing(0, 0, 0.075, 0.075, 2, 6, 0) },
            { z: -L / 2 + L * 0.66, ring: superRing(0, 0, 0.075, 0.075, 2, 6, 0) },
          ],
          { capEnd: true, color: 0xd8d6cf },
        );
        out.push(place(g, [Math.cos(a) * R * 1.05, Math.sin(a) * R * 1.05, 0]));
      }
      return out;
    },
  },
  m_9m330: {
    body: 0xbfc4b2,
    nose: 0x8b9178,
    noseLen: 0.4,
    fins: [
      { at: 0.1, root: 0.24, tip: 0.14, span: 0.17, sweep: 0.08 },
      { at: 0.86, root: 0.32, tip: 0.2, span: 0.2, sweep: 0.1, roll: Math.PI / 4 },
    ],
  },
  // Kowsar (C-704 family) anti-ship missile: cruciform mid-body wings and tail fins
  kowsar: {
    body: 0xd9dbd2,
    nose: 0x6f7468,
    noseLen: 0.45,
    bands: [[0.3, 0.04, 0xb3261e]],
    fins: [
      { at: 0.45, root: 0.6, tip: 0.3, span: 0.32, sweep: 0.2, roll: Math.PI / 4 },
      { at: 0.9, root: 0.32, tip: 0.18, span: 0.22, sweep: 0.1, roll: Math.PI / 4 },
    ],
  },
  m_igla: {
    body: 0x4f5a3c,
    nose: 0x2b2e2a,
    noseLen: 0.1,
    blunt: 1,
    fins: [
      { at: 0.08, root: 0.05, tip: 0.03, span: 0.035, sweep: 0.02 },
      { at: 0.9, root: 0.1, tip: 0.08, span: 0.055, sweep: 0.03, roll: Math.PI / 4 },
    ],
  },
  gbu31: {
    body: 0x59603f,
    nose: 0x59603f,
    noseLen: 1.15,
    blunt: 0.4,
    tail: 0.62,
    bands: [[0.1, 0.06, 0xd6b21e]],
    fins: [
      { at: 0.35, root: 1.1, tip: 1.0, span: 0.05, sweep: 0.08, roll: Math.PI / 4, color: 0x8a8f7a },
      { at: 0.84, root: 0.52, tip: 0.44, span: 0.3, sweep: 0.08, roll: Math.PI / 4, color: 0x8f9384 },
    ],
  },
  kab500: {
    body: 0x6d7466,
    nose: 0x3f4440,
    noseLen: 0.7,
    blunt: 0.5,
    tail: 0.6,
    bands: [[0.14, 0.05, 0xc23a2a]],
    fins: [
      { at: 0.3, root: 0.5, tip: 0.3, span: 0.12, sweep: 0.1, roll: Math.PI / 4, color: 0x7d8376 },
      { at: 0.86, root: 0.5, tip: 0.36, span: 0.26, sweep: 0.1, roll: Math.PI / 4, color: 0x7d8376 },
    ],
  },
  gbu39: {
    body: 0x9aa0a4,
    nose: 0x8d9296,
    noseLen: 0.3,
    square: 3.2,
    fins: [{ at: 0.9, root: 0.16, tip: 0.12, span: 0.09, sweep: 0.04, roll: Math.PI / 4 }],
    extra: sdbWings,
  },
  gbu53: {
    // SDB II: SDB-like square body, blunt faceted tri-mode seeker nose, four tail fins, pop-out wings
    body: 0x8e959a,
    nose: 0x3e4246,
    noseLen: 0.22,
    blunt: 0.7,
    square: 3.6,
    bands: [[0.16, 0.04, 0xd6b21e]],
    fins: [{ at: 0.9, root: 0.18, tip: 0.12, span: 0.1, sweep: 0.05, roll: 0 }],
    extra: sdbWings,
  },
  aargm: {
    body: 0xdcdcd7,
    nose: 0x5f5a50,
    noseLen: 0.55,
    bands: [[0.3, 0.035, 0xd8b22a]],
    fins: [
      { at: 0.3, root: 0.95, tip: 0.35, span: 0.14, sweep: 0.55, roll: Math.PI / 4 },
      { at: 0.88, root: 0.32, tip: 0.14, span: 0.24, sweep: 0.14, roll: Math.PI / 4 },
    ],
  },
};

/** Geometry for a munition at its reference size (cached). */
export function munitionGeometry(id: MunitionId): BufferGeometry {
  let g = cache.get(id);
  if (g) return g;
  const dims = MUNITION_DIMS[id] ?? MUNITION_DIMS.aim120;
  const spec = SPECS[id] ?? SPECS.aim120;
  const L = dims.length;
  const R = dims.diameter / 2;
  const parts: BufferGeometry[] = [...body(L, R, spec)];
  for (const f of spec.fins) parts.push(...fins(L, R, f, spec.body));
  if (spec.extra) parts.push(...spec.extra(L, R));
  g = merge(parts)!;
  g.computeBoundingSphere();
  g.computeBoundingBox();
  cache.set(id, g);
  return g;
}

/** New mesh for a munition (shared geometry + material). */
export function munitionMesh(id: MunitionId): Mesh {
  const m = new Mesh(munitionGeometry(id), getMaterial('munition'));
  m.name = `munition:${id}`;
  return m;
}

export function disposeMunitions(): void {
  cache.forEach((g) => g.dispose());
}

