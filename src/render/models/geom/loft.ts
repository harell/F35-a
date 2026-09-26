/**
 * Loft-based surface builders: fuselages (closed rings lofted along Z), lifting surfaces
 * (wings / fins / stabilators with airfoil thickness) and lathes (missile bodies, nozzles).
 *
 * Smoothing: each builder produces smooth vertex normals inside "strips" and hard edges at
 * crease columns (chines, leading/trailing edges), which is what gives stealth shapes their look.
 */
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { ensureOutward, finalize, flipWinding, merge } from './core';

/** Shoelace signed area of a flat [x0,y0,...] ring (positive = counter-clockwise). */
export function ringArea(ring: number[]): number {
  let a = 0;
  const n = ring.length / 2;
  for (let j = 0; j < n; j++) {
    const k = (j + 1) % n;
    a += ring[2 * j] * ring[2 * k + 1] - ring[2 * k] * ring[2 * j + 1];
  }
  return a / 2;
}

/** A closed ring [x0,y0,x1,y1,...] in the XY plane, counter-clockwise (x right, y up), at depth z. */
export interface LoftStation {
  z: number;
  ring: number[];
  /** Optional per-point z (slanted lips, serrated nozzle edges). */
  zs?: number[];
}

export interface LoftOptions {
  /** Ring indices with a hard edge (e.g. chines). */
  creases?: number[];
  capStart?: boolean;
  capEnd?: boolean;
  color?: number;
  /** Faces point towards the ring centre (duct interiors). */
  inward?: boolean;
}

/** Build an indexed grid from rows×cols points, smooth-shade it and return it non-indexed. */
function gridStrip(pos: Float32Array, rows: number, cols: number): BufferGeometry {
  const idx: number[] = [];
  for (let i = 0; i < rows - 1; i++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = i * cols + c;
      const b = i * cols + c + 1;
      const cc = (i + 1) * cols + c + 1;
      const d = (i + 1) * cols + c;
      idx.push(a, b, d, b, cc, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function capFan(ring: number[], z: number, atEnd: boolean, zOf?: (j: number) => number): BufferGeometry {
  const n = ring.length / 2;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let j = 0; j < n; j++) {
    cx += ring[2 * j];
    cy += ring[2 * j + 1];
    cz += zOf ? zOf(j) : z;
  }
  cx /= n;
  cy /= n;
  cz /= n;
  const pos: number[] = [];
  for (let j = 0; j < n; j++) {
    const k = (j + 1) % n;
    const zj = zOf ? zOf(j) : z;
    const zk = zOf ? zOf(k) : z;
    if (atEnd) pos.push(cx, cy, cz, ring[2 * j], ring[2 * j + 1], zj, ring[2 * k], ring[2 * k + 1], zk);
    else pos.push(cx, cy, cz, ring[2 * k], ring[2 * k + 1], zk, ring[2 * j], ring[2 * j + 1], zj);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** Loft rings along +Z. Stations must be sorted by z and share the point count. */
export function loftRings(stations: LoftStation[], o: LoftOptions = {}): BufferGeometry {
  const n = stations[0].ring.length / 2;
  const rows = stations.length;
  const creases = [...new Set(o.creases ?? [])].sort((a, b) => a - b);
  const strips: [number, number][] = [];
  if (creases.length === 0) strips.push([0, n + 1]);
  else {
    for (let k = 0; k < creases.length; k++) {
      const a = creases[k];
      const b = creases[(k + 1) % creases.length];
      const edges = (b - a + n) % n || n;
      strips.push([a, edges + 1]);
    }
  }
  const parts: BufferGeometry[] = [];
  for (const [a, cols] of strips) {
    const pos = new Float32Array(rows * cols * 3);
    for (let i = 0; i < rows; i++) {
      const st = stations[i];
      for (let c = 0; c < cols; c++) {
        const j = (a + c) % n;
        const o3 = (i * cols + c) * 3;
        pos[o3] = st.ring[2 * j];
        pos[o3 + 1] = st.ring[2 * j + 1];
        pos[o3 + 2] = st.zs ? st.zs[j] : st.z;
      }
    }
    parts.push(finalize(gridStrip(pos, rows, cols), o.color));
  }
  const s0 = stations[0];
  const s1 = stations[rows - 1];
  if (o.capStart) parts.push(finalize(capFan(s0.ring, s0.z, false, s0.zs ? (j) => s0.zs![j] : undefined), o.color));
  if (o.capEnd) parts.push(finalize(capFan(s1.ring, s1.z, true, s1.zs ? (j) => s1.zs![j] : undefined), o.color));
  const g = merge(parts)!;
  // Rings given clockwise produce inward faces: flip everything (winding + normals) to keep outward.
  let big = stations[0].ring;
  let bigA = 0;
  for (const st of stations) {
    const a = Math.abs(ringArea(st.ring));
    if (a > bigA) {
      bigA = a;
      big = st.ring;
    }
  }
  if ((ringArea(big) < 0) !== !!o.inward) flipWinding(g, true);
  return g;
}

/** Quad band between two rings with equal point counts (e.g. an intake lip between outer and inner). */
export function bandBetween(a: LoftStation, b: LoftStation, color = 0xffffff): BufferGeometry {
  const n = a.ring.length / 2;
  const pos: number[] = [];
  const za = (j: number) => (a.zs ? a.zs[j] : a.z);
  const zb = (j: number) => (b.zs ? b.zs[j] : b.z);
  for (let j = 0; j < n; j++) {
    const k = (j + 1) % n;
    const A = [a.ring[2 * j], a.ring[2 * j + 1], za(j)];
    const B = [a.ring[2 * k], a.ring[2 * k + 1], za(k)];
    const C = [b.ring[2 * k], b.ring[2 * k + 1], zb(k)];
    const D = [b.ring[2 * j], b.ring[2 * j + 1], zb(j)];
    pos.push(...A, ...B, ...D, ...B, ...C, ...D);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return finalize(g, color);
}

/* ───────────────────────── lifting surfaces ───────────────────────── */

/** One spanwise section of a lifting surface, in the surface's local frame (span along +X). */
export interface SurfaceSection {
  /** Span position (m). */
  x: number;
  /** Chord-plane height (m). */
  y: number;
  /** Leading / trailing edge z (LE < TE, nose is -Z). */
  zLE: number;
  zTE: number;
  /** Maximum thickness (m). */
  t: number;
}

export interface SurfaceOptions {
  /** Chord fraction range to build (0 = LE, 1 = TE). Used to cut control surfaces. */
  c0?: number;
  c1?: number;
  /** Airfoil family. 'diamond' suits stealth / supersonic surfaces. */
  profile?: 'diamond' | 'biconvex' | 'flat';
  capRoot?: boolean;
  capTip?: boolean;
  /** Chordwise resolution (points on each surface). */
  chordPoints?: number;
  color?: number;
}

function thicknessAt(f: number, profile: SurfaceOptions['profile']): number {
  f = Math.min(1, Math.max(0, f));
  if (profile === 'flat') return f <= 0.001 || f >= 0.999 ? 0.35 : 1;
  if (profile === 'diamond') return f < 0.4 ? f / 0.4 : (1 - f) / 0.6;
  // biconvex, slightly blunt nose
  return Math.min(1, 4 * f * (1 - f) * 1.05 + (f < 0.1 ? 0.15 * (1 - f / 0.1) * (f > 0 ? 1 : 0) : 0));
}

/**
 * Lifting surface (wing/fin/stab) through ≥2 sections, spanning local +X.
 * Returns canonical geometry with hard LE/TE edges.
 */
export function liftingSurface(sections: SurfaceSection[], o: SurfaceOptions = {}): BufferGeometry {
  const c0 = o.c0 ?? 0;
  const c1 = o.c1 ?? 1;
  const profile = o.profile ?? 'diamond';
  const np = o.chordPoints ?? 6;
  const fs: number[] = [];
  for (let i = 0; i < np; i++) {
    const u = i / (np - 1);
    // cluster points near the LE for a nicer nose
    const w = c0 === 0 ? u * u * 0.35 + u * 0.65 : u;
    fs.push(c0 + (c1 - c0) * w);
  }
  const eps = 1e-4;
  const frontThick = thicknessAt(c0, profile) > eps;
  const backThick = thicknessAt(c1, profile) > eps;

  // ring layout in (z, y): upper LE→TE then lower TE→LE
  const ringFor = (s: SurfaceSection): number[] => {
    const chord = s.zTE - s.zLE;
    const ring: number[] = [];
    for (let i = 0; i < fs.length; i++) {
      const f = fs[i];
      ring.push(s.zLE + f * chord, s.y + (thicknessAt(f, profile) * s.t) / 2);
    }
    for (let i = fs.length - 1; i >= 0; i--) {
      const f = fs[i];
      const th = thicknessAt(f, profile);
      if (th <= eps && (i === 0 || i === fs.length - 1)) continue; // shared LE/TE point
      ring.push(s.zLE + f * chord, s.y - (th * s.t) / 2);
    }
    return ring;
  };
  const rings = sections.map(ringFor);
  const n = rings[0].length / 2;
  const creases = [0, fs.length - 1];
  if (backThick) creases.push(fs.length); // lower TE corner
  if (frontThick) creases.push(n - 1); // lower front corner

  // Build as a loft along +X: map ring (z,y) → x = section.x
  const rows = sections.length;
  const strips: [number, number][] = [];
  const cs = [...new Set(creases)].sort((a, b) => a - b);
  for (let k = 0; k < cs.length; k++) {
    const a = cs[k];
    const b = cs[(k + 1) % cs.length];
    const edges = (b - a + n) % n || n;
    strips.push([a, edges + 1]);
  }
  const parts: BufferGeometry[] = [];
  for (const [a, cols] of strips) {
    const pos = new Float32Array(rows * cols * 3);
    for (let i = 0; i < rows; i++) {
      for (let c = 0; c < cols; c++) {
        const j = (a + c) % n;
        const o3 = (i * cols + c) * 3;
        pos[o3] = sections[i].x;
        pos[o3 + 1] = rings[i][2 * j + 1];
        pos[o3 + 2] = rings[i][2 * j];
      }
    }
    parts.push(finalize(gridStrip(pos, rows, cols), o.color));
  }
  // caps: build a fan in (z,y) at x = section.x; we reuse capFan by swapping axes afterwards
  const capAt = (s: SurfaceSection, ring: number[], atEnd: boolean) => {
    const g = capFan(ring, 0, atEnd);
    // capFan output is (x=z, y=y, z=0) → remap to (x=s.x, y, z)
    const p = g.attributes.position.array as Float32Array;
    for (let i = 0; i < p.length; i += 3) {
      const zz = p[i];
      p[i] = s.x;
      p[i + 2] = zz;
    }
    g.computeVertexNormals();
    return finalize(g, o.color);
  };
  if (o.capRoot !== false) parts.push(capAt(sections[0], rings[0], false));
  if (o.capTip !== false) parts.push(capAt(sections[rows - 1], rings[rows - 1], true));
  const g = merge(parts)!;
  return fixOrientation(g);
}

/**
 * Orientation fix for open / thin surfaces: flip when the signed volume is negative.
 * (Thin closed shells still give a reliable sign.)
 */
function fixOrientation(g: BufferGeometry): BufferGeometry {
  return ensureOutward(g);
}

/* ───────────────────────── lathe (bodies of revolution along Z) ───────────────────────── */

/**
 * Body of revolution around the Z axis. `profile` = [[z, r], ...] from front to back.
 * r = 0 points close the shape. `ySquash` flattens it vertically (e.g. 0.8).
 */
export function latheZ(
  profile: [number, number][],
  segments = 12,
  o: { color?: number; ySquash?: number; xScale?: number; phase?: number; capStart?: boolean; capEnd?: boolean } = {},
): BufferGeometry {
  const stations: LoftStation[] = profile.map(([z, r]) => {
    const ring: number[] = [];
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2 + (o.phase ?? 0);
      ring.push(Math.cos(a) * r * (o.xScale ?? 1), Math.sin(a) * r * (o.ySquash ?? 1));
    }
    return { z, ring };
  });
  return loftRings(stations, { capStart: o.capStart, capEnd: o.capEnd, color: o.color });
}

/** Parametric ring helper: superellipse (n=2 ellipse, larger → boxier) centred at (cx, cy). */
export function superRing(cx: number, cy: number, rx: number, ry: number, n: number, points: number, phase = -Math.PI / 2): number[] {
  const ring: number[] = [];
  for (let j = 0; j < points; j++) {
    const a = phase + (j / points) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    ring.push(cx + Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * rx, cy + Math.sign(s) * Math.pow(Math.abs(s), 2 / n) * ry);
  }
  return ring;
}

/** Prism: extrude a CCW polygon (in the XY plane) along Z from z0 to z1 with caps and hard edges. */
export function prismZ(poly: [number, number][], z0: number, z1: number, color = 0xffffff): BufferGeometry {
  const ring = poly.flat();
  const creases = poly.map((_, i) => i);
  return loftRings(
    [
      { z: z0, ring },
      { z: z1, ring },
    ],
    { creases, capStart: true, capEnd: true, color },
  );
}

/** Prism of a side profile (CCW polygon in the Z/Y plane given as [z, y]) extruded across X (width w). */
export function prismX(profileZY: [number, number][], w: number, color = 0xffffff, x0 = -w / 2): BufferGeometry {
  // Build along Z using (x=y?)… simpler: make the polygon in XY as (z→x), extrude along "z" as width, then rotate.
  const poly: [number, number][] = profileZY.map(([z, y]) => [z, y]);
  const g = prismZ(poly, 0, w, color);
  // currently: x = z_profile, y = y, z = width → rotate so width → +X and profile z → Z
  const p = g.attributes.position.array as Float32Array;
  const nrm = g.attributes.normal.array as Float32Array;
  for (let i = 0; i < p.length; i += 3) {
    const zp = p[i];
    const wd = p[i + 2];
    p[i] = x0 + wd;
    p[i + 2] = zp;
    const nz = nrm[i];
    const nw = nrm[i + 2];
    nrm[i] = nw;
    nrm[i + 2] = nz;
  }
  // swapping two axes is a reflection: normals were swapped too (still outward), only the winding flips
  return flipWinding(g, false);
}
