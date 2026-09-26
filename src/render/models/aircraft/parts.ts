/**
 * Reusable airframe part builders for the non-hero aircraft (MiG-29, Flankers, Su-57, Tu-22M3, A-50):
 * rounded fuselage lofts, bubble canopies, engine nacelles with intakes, nozzles, and lifting
 * surfaces with hinged control surfaces (added to a ModelBuilder together with their drives).
 */
import { Vector3, type BufferGeometry } from 'three';
import type { ModelBuilder } from '../ModelBuilder';
import { mirrorX, place } from '../geom/core';
import { liftingSurface, loftRings, type LoftStation, type SurfaceSection } from '../geom/loft';
import { samples, tableCurves, lerp } from '../geom/curves';
import type { DriveDef, DriveKind } from './types';

export const DEG = Math.PI / 180;

/** Ring with separate half-width, top and bottom extents; n = superellipse exponent (2 = ellipse). */
export function capsuleRing(halfW: number, top: number, bottom: number, n: number, points: number, yc = 0): number[] {
  const ring: number[] = [];
  for (let j = 0; j < points; j++) {
    const a = -Math.PI / 2 + (j / points) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const x = Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * halfW;
    const y = Math.sign(s) * Math.pow(Math.abs(s), 2 / n) * (s > 0 ? top : bottom);
    ring.push(x, yc + y);
  }
  return ring;
}

/**
 * Round-ish fuselage loft from a table of [s, halfWidth, top, bottom, yCentre, n, xCentre?] rows.
 * z = z0 + s. Returns geometry; caps optional.
 */
export function fuselageLoft(
  rows: number[][],
  z0: number,
  opts: { count?: number; points?: number; capEnd?: boolean; capStart?: boolean; creases?: number[] } = {},
): BufferGeometry {
  const curves = tableCurves(rows);
  const s0 = rows[0][0];
  const s1 = rows[rows.length - 1][0];
  const pts = opts.points ?? 14;
  const st: LoftStation[] = samples(s0, s1, opts.count ?? 24, rows.map((r) => r[0])).map((s) => {
    const [hw, top, bot, yc, n, xc] = curves.map((c) => c(s));
    const ring = capsuleRing(Math.max(0.005, hw), Math.max(0.005, top), Math.max(0.005, bot), n || 2, pts, yc);
    if (xc) for (let i = 0; i < ring.length; i += 2) ring[i] += xc;
    return { z: z0 + s, ring };
  });
  return loftRings(st, { capEnd: opts.capEnd, capStart: opts.capStart, creases: opts.creases });
}

/** Bubble canopy from rows [s, halfWidth, topY] sitting on baseY(s) (fuselage top). */
export function bubbleCanopy(rows: number[][], z0: number, baseY: (s: number, x: number) => number, count = 12): BufferGeometry {
  const curves = tableCurves(rows);
  const stations: LoftStation[] = samples(rows[0][0], rows[rows.length - 1][0], count).map((s) => {
    const [w, top] = curves.map((c) => c(s));
    const ring: number[] = [];
    const N = 10;
    for (let i = 0; i <= N; i++) {
      const th = (i / N) * Math.PI;
      const x = Math.cos(th) * w;
      const base = baseY(s, x) - 0.02;
      const k = Math.pow(Math.sin(th), 0.7);
      ring.push(x, base + Math.max(0.01, top - base) * k);
    }
    const y0 = baseY(s, 0);
    ring.push(-w * 0.5, y0 - 0.15, w * 0.5, y0 - 0.15);
    return { z: z0 + s, ring };
  });
  return loftRings(stations, { capStart: true, capEnd: true });
}

/** Round nozzle (outer shell + dark inner) along +Z, returns [outer, inner]. */
export function nozzle(x: number, y: number, zA: number, zB: number, rA: number, rB: number, seg = 16): [BufferGeometry, BufferGeometry] {
  const ring = (r: number) => capsuleRing(r, r, r, 2, seg, y).map((v, i) => (i % 2 === 0 ? v + x : v));
  const outer = loftRings([
    { z: zA, ring: ring(rA) },
    { z: lerp(zA, zB, 0.6), ring: ring(lerp(rA, rB, 0.5)) },
    { z: zB, ring: ring(rB) },
  ]);
  const inner = loftRings(
    [
      { z: zB - 0.6, ring: ring(rB * 0.85) },
      { z: zB - 0.01, ring: ring(rB * 0.95) },
    ],
    { inward: true, capStart: true, color: 0x1e1c1b },
  );
  return [outer, inner];
}

/* ───────────────────────── lifting surfaces with controls ───────────────────────── */

export interface ControlSpan {
  name: string;
  kind: DriveKind;
  x0: number;
  x1: number;
  /** Hinge chord fraction (TE surfaces: surface spans [c, 1]; LE flaps: [0, c]). */
  c: number;
  max: number;
  extra?: number;
  le?: boolean;
}

export interface WingSetOptions {
  sectionAt: (x: number) => SurfaceSection;
  x0: number;
  x1: number;
  controls?: ControlSpan[];
  profile?: 'diamond' | 'biconvex' | 'flat';
  mat?: string;
  /** Mirror to the left side (default true). */
  mirror?: boolean;
  /** Transform applied to every piece (e.g. fin placement); geometry in, geometry out. */
  xf?: (g: BufferGeometry) => BufferGeometry;
  /** Transform for hinge points (must match xf). */
  xp?: (p: Vector3) => Vector3;
  capRoot?: boolean;
}

/** Build a wing / fin / stab with hinged control surfaces; pushes drives. */
export function wingSet(b: ModelBuilder, drives: DriveDef[], o: WingSetOptions): void {
  const mat = o.mat ?? 'skin';
  const mirror = o.mirror !== false;
  const xf = o.xf ?? ((g: BufferGeometry) => g);
  const xp = o.xp ?? ((p: Vector3) => p);
  const ctrls = o.controls ?? [];
  const te = ctrls.filter((c) => !c.le);
  const le = ctrls.filter((c) => c.le);
  const leC = le.length ? Math.max(...le.map((c) => c.c)) : 0;
  // spanwise breakpoints
  const bps = new Set<number>([o.x0, o.x1]);
  te.forEach((c) => {
    bps.add(c.x0);
    bps.add(c.x1);
  });
  le.forEach((c) => {
    bps.add(c.x0);
    bps.add(c.x1);
  });
  const xs = [...bps].sort((a, b) => a - b);
  for (let i = 0; i < xs.length - 1; i++) {
    const a = xs[i];
    const bb = xs[i + 1];
    const mid = (a + bb) / 2;
    const tc = te.find((c) => mid > c.x0 && mid < c.x1);
    const lc = le.find((c) => mid > c.x0 && mid < c.x1);
    const g = xf(
      liftingSurface([o.sectionAt(a), o.sectionAt(bb)], {
        c0: lc ? lc.c : 0,
        c1: tc ? tc.c : 1,
        profile: o.profile ?? 'biconvex',
        capRoot: i === 0 ? o.capRoot ?? false : true,
      }),
    );
    b.add(g, mat);
    if (mirror) b.add(mirrorX(g), mat);
  }
  const hinge = (x: number, f: number) => {
    const s = o.sectionAt(x);
    return xp(new Vector3(x, s.y, lerp(s.zLE, s.zTE, f)));
  };
  for (const c of ctrls) {
    const g = xf(
      liftingSurface([o.sectionAt(c.x0), o.sectionAt(c.x1)], {
        c0: c.le ? 0 : c.c,
        c1: c.le ? c.c : 1,
        profile: o.profile ?? 'biconvex',
      }),
    );
    const A = hinge(c.x0, c.c);
    const B = hinge(c.x1, c.c);
    const vertical = Math.abs(B.clone().sub(A).normalize().y) > 0.7;
    b.addHinged(`${c.name}R`, g, mat, A, B);
    drives.push({ part: `${c.name}R`, kind: c.kind, side: 1, max: c.max, extra: c.extra });
    if (mirror) {
      const Am = A.clone().setX(-A.x);
      const Bm = B.clone().setX(-B.x);
      // keep the axis pointing +X (horizontal surfaces) or +Y (fins) on the left too
      if (vertical) b.addHinged(`${c.name}L`, mirrorX(g), mat, Am, Bm);
      else b.addHinged(`${c.name}L`, mirrorX(g), mat, Bm, Am);
      drives.push({ part: `${c.name}L`, kind: c.kind, side: -1, max: c.max, extra: c.extra });
    }
  }
  void leC;
}

/** All-moving surface (stabilator / all-moving fin / canard) with a pivot. */
export function allMoving(
  b: ModelBuilder,
  drives: DriveDef[],
  name: string,
  kind: DriveKind,
  geo: BufferGeometry,
  pivot: Vector3,
  axis: Vector3,
  max: number,
  extra = 0,
  mirror = true,
  mat = 'skin',
): void {
  b.addPart(`${name}R`, geo, mat, pivot, axis);
  drives.push({ part: `${name}R`, kind, side: 1, max, extra });
  if (mirror) {
    const ax = axis.clone();
    // horizontal surfaces keep +X; vertical (fins) mirror their lateral lean
    if (Math.abs(ax.y) > 0.7) ax.x = -ax.x;
    b.addPart(`${name}L`, mirrorX(geo), mat, pivot.clone().setX(-pivot.x), ax);
    drives.push({ part: `${name}L`, kind, side: -1, max, extra });
  }
}

/** Place a fin built with span along +X: rotate to vertical with an outward cant, move to root. */
export function finTransform(root: Vector3, cant: number): { xf: (g: BufferGeometry) => BufferGeometry; xp: (p: Vector3) => Vector3 } {
  const ang = Math.PI / 2 - cant;
  const axis = new Vector3(0, 0, 1);
  return {
    xf: (g) => place(g, [root.x, root.y, root.z], [0, 0, ang]),
    xp: (p) => p.clone().applyAxisAngle(axis, ang).add(root),
  };
}

/** Linear section interpolator between a root and tip section. */
export function linearSections(root: SurfaceSection, tip: SurfaceSection): (x: number) => SurfaceSection {
  return (x: number) => {
    const t = (x - root.x) / (tip.x - root.x);
    return {
      x,
      y: lerp(root.y, tip.y, t),
      zLE: lerp(root.zLE, tip.zLE, t),
      zTE: lerp(root.zTE, tip.zTE, t),
      t: lerp(root.t, tip.t, t),
    };
  };
}

/**
 * Flat blended centre body / LERX loft: rows [s, halfWidth, yTop, yBottom, yEdge]. The outer edge is
 * a sharp crease (LERX / chine) — the shape Russian fighters use between the engine nacelles.
 */
export function flatBody(rows: number[][], z0: number, count = 16, capEnd = true): BufferGeometry {
  const curves = tableCurves(rows);
  const st: LoftStation[] = samples(rows[0][0], rows[rows.length - 1][0], count, rows.map((r) => r[0])).map((s) => {
    const [w, yt, yb, ye] = curves.map((c) => c(s));
    const hw = Math.max(0.01, w);
    const right: [number, number][] = [
      [0, yb],
      [hw * 0.5, yb + (ye - yb) * 0.15],
      [hw, ye],
      [hw * 0.55, yt - (yt - ye) * 0.2],
      [0, yt],
    ];
    const left = right.slice(1, 4).reverse().map(([x, y]) => [-x, y] as [number, number]);
    return { z: z0 + s, ring: [...right, ...left].flat() };
  });
  return loftRings(st, { creases: [2, 6], capEnd, capStart: true });
}
