/**
 * F35-A — Spark Arena (Auckland's indoor arena on Mahuhu Crescent, just east of the CBD): shape data
 * shared by the scenery (mesh, sign, night lights), the scatter (keeps houses, trees and suburb
 * centres off it) and the sim (a solid obstacle, sim/buildings.ts).
 *
 * Source: the LINZ 2024 Auckland LiDAR 1 m DSM − DEM and the LINZ 2024 7.5 cm aerial photo
 * (CC BY 4.0), measured in an NZTM2000 crop whose NW corner is E 1758341.68, N 5920684.24, then
 * converted NZTM → WGS84 → game (geoToWorld in core/auckland.ts; the game's axes are 1.07° off the
 * NZTM grid, its scale 0.9989 of it). Every number below is in game metres from SPARK_ARENA
 * (+x east, +z south); heights are metres above the ground (the DEM is ≈ 4.8 m above datum here).
 *
 * The roof is two lens-shaped (vesica) planes, 122 m × 48 m, fitted to the LiDAR (rms 0.25 m and
 * 0.32 m; the highest point, 31.1 m, is the south lens's inner edge), with a flat white walkway roof
 * between and round them (a quadratic fit, rms 0.6 m, 17–29.5 m). The perimeter runs along the north
 * lens's outer arc, the east wall, the south lens's outer arc and the curved glazed foyer on the west.
 * The lens tips cantilever past the drum wall (most at the west, where struts carry them).
 */

/** Centre of the arena (game x, z). */
export const SPARK_ARENA = { x: 1318.5, z: -147.1 } as const;

export interface ArenaLensDef {
  name: 'north' | 'south';
  /** West and east tips (m from SPARK_ARENA). */
  a: readonly [number, number];
  b: readonly [number, number];
  halfWidth: number;
  /** Roof plane: h = p0·dx + p1·dz + p2 (dx, dz from SPARK_ARENA). */
  plane: readonly [number, number, number];
  /** Which side of the tip line (along the lens normal) is the building's outside. */
  outer: 1 | -1;
}

export const SPARK_ARENA_LENSES: readonly ArenaLensDef[] = [
  { name: 'north', a: [-49.26, -45.26], b: [65.39, -4.7], halfWidth: 24, plane: [-0.1539, 0.2299, 29.66], outer: -1 },
  { name: 'south', a: [-66.34, 3.06], b: [48.83, 45.11], halfWidth: 24, plane: [0.0159, -0.2744, 30.509], outer: 1 },
];

/** Walkway roof: h = c0·dx² + c1·dx·dz + c2·dz² + c3·dx + c4·dz + c5, clamped to [17, 29.5]. */
const WALKWAY = [-0.0019624, 0.002025, -0.0041538, -0.073494, -0.038406, 29.557] as const;
const WALKWAY_MIN = 17;
const WALKWAY_MAX = 29.5;

/** Control point of the foyer's curve (a quadratic from the south lens's west tip to the north lens's). */
const FOYER_CONTROL: readonly [number, number] = [-72.22, -17.63];

/** A low oriented block: centre, size along its own x (w) and z (d), height, yaw (rad, three.js rotation.y). */
export interface ArenaBlock {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  rot: number;
}

/** The low south-west wing (glazed ridge on top) and the plant deck on the east. */
export const SPARK_ARENA_WING: ArenaBlock = { x: -62.1, z: 43.18, w: 37, d: 14, h: 10, rot: 0.1886 };
export const SPARK_ARENA_PLANT: ArenaBlock = { x: 73.07, z: 5.66, w: 12, d: 26, h: 3.5, rot: -0.3314 };

/** Foyer layers (m above the ground): the recessed ground floor and its canopy, the curtain-wall band. */
export const SPARK_ARENA_FOYER = { canopy: 5, canopyThick: 0.6, recess: 3, overhang: 3, glassTop: 16, bulge: 1 } as const;

/* ───────────────────────────── Lenses ───────────────────────────── */

export interface ArenaLens {
  def: ArenaLensDef;
  /** Midpoint of the tips, unit vector along the lens (a → b) and its normal. */
  mx: number;
  mz: number;
  ux: number;
  uz: number;
  nx: number;
  nz: number;
  /** Half the tip-to-tip length and the radius of its arcs. */
  half: number;
  R: number;
}

function lensOf(def: ArenaLensDef): ArenaLens {
  const dx = def.b[0] - def.a[0];
  const dz = def.b[1] - def.a[1];
  const L = Math.hypot(dx, dz);
  const ux = dx / L;
  const uz = dz / L;
  const hw = def.halfWidth;
  return { def, mx: (def.a[0] + def.b[0]) / 2, mz: (def.a[1] + def.b[1]) / 2, ux, uz, nx: -uz, nz: ux, half: L / 2, R: ((L / 2) ** 2 + hw * hw) / (2 * hw) };
}

export const ARENA_LENSES: readonly ArenaLens[] = SPARK_ARENA_LENSES.map(lensOf);

/** Half-width of the lens `s` m from its middle along its axis (0 at the tips). */
export function lensHalfWidth(l: ArenaLens, s: number): number {
  const hw = l.def.halfWidth;
  return Math.max(0, Math.sqrt(Math.max(0, l.R * l.R - s * s)) - (l.R - hw));
}

/** Point `s` m along the lens's axis from its middle and `t` m along its normal (offsets). */
export function lensPoint(l: ArenaLens, s: number, t: number): [number, number] {
  return [l.mx + l.ux * s + l.nx * t, l.mz + l.uz * s + l.nz * t];
}

export function inLens(l: ArenaLens, dx: number, dz: number): boolean {
  const s = (dx - l.mx) * l.ux + (dz - l.mz) * l.uz;
  const t = (dx - l.mx) * l.nx + (dz - l.mz) * l.nz;
  return Math.abs(s) < l.half && Math.abs(t) <= lensHalfWidth(l, s);
}

/** Height of the lens's roof plane at an offset (m above the ground). */
export function lensHeight(l: ArenaLens, dx: number, dz: number): number {
  const p = l.def.plane;
  return p[0] * dx + p[1] * dz + p[2];
}

/** One arc of the lens, tip a → tip b (`segs` + 1 points, flat [dx, dz, …]); side ±1 along the normal. */
export function lensArc(l: ArenaLens, side: number, segs: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= segs; i++) {
    // closer spacing towards the tips, where the arc turns fastest
    const u = i / segs;
    const s = -l.half * Math.cos(Math.PI * u);
    out.push(...lensPoint(l, s, side * lensHalfWidth(l, s)));
  }
  return out;
}

/** The walkway roof's height at an offset (m above the ground). */
export function walkwayHeight(dx: number, dz: number): number {
  const c = WALKWAY;
  const h = c[0] * dx * dx + c[1] * dx * dz + c[2] * dz * dz + c[3] * dx + c[4] * dz + c[5];
  return Math.min(WALKWAY_MAX, Math.max(WALKWAY_MIN, h));
}

/* ───────────────────────────── Perimeter ───────────────────────────── */

export type ArenaRunKind = 'north' | 'east' | 'south' | 'foyer';

/** One run of the perimeter (flat offsets); each run ends where the next one starts. */
export interface ArenaRun {
  kind: ArenaRunKind;
  pts: number[];
}

function quadCurve(a: readonly number[], c: readonly number[], b: readonly number[], segs: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const k = 1 - t;
    out.push(k * k * a[0] + 2 * k * t * c[0] + t * t * b[0], k * k * a[1] + 2 * k * t * c[1] + t * t * b[1]);
  }
  return out;
}

/**
 * The perimeter, clockwise seen from above (north arc west → east, east wall, south arc east → west,
 * foyer south → north): the outer edge of the roof.
 */
export function sparkArenaRuns(arcSegs = 40, foyerSegs = 24): ArenaRun[] {
  const [N, S] = ARENA_LENSES;
  const north = lensArc(N, N.def.outer, arcSegs);
  const southFwd = lensArc(S, S.def.outer, arcSegs);
  const south: number[] = [];
  for (let i = southFwd.length - 2; i >= 0; i -= 2) south.push(southFwd[i], southFwd[i + 1]);
  const bn = N.def.b;
  const bs = S.def.b;
  const east = quadCurve(bn, [(bn[0] + bs[0]) / 2 + 1, (bn[1] + bs[1]) / 2], bs, Math.max(4, arcSegs >> 2));
  const foyer = quadCurve(S.def.a, FOYER_CONTROL, N.def.a, foyerSegs);
  return [
    { kind: 'north', pts: north },
    { kind: 'east', pts: east },
    { kind: 'south', pts: south },
    { kind: 'foyer', pts: foyer },
  ];
}

/** The perimeter as one closed ring of offsets (no repeated points). */
export function runsToRing(runs: readonly ArenaRun[]): number[] {
  const ring: number[] = [];
  for (const r of runs) ring.push(...r.pts.slice(0, -2));
  return ring;
}

/** Even-odd point-in-polygon on a flat ring. */
export function inRing(r: ArrayLike<number>, x: number, z: number): boolean {
  let inside = false;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[i * 2];
    const zi = r[i * 2 + 1];
    const xj = r[j * 2];
    const zj = r[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Shoelace area of a flat ring (m²; the sign gives the winding). */
export function ringArea(r: ArrayLike<number>): number {
  let a = 0;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += r[j * 2] * r[i * 2 + 1] - r[i * 2] * r[j * 2 + 1];
  return a / 2;
}

const OUTLINE = runsToRing(sparkArenaRuns());
let outlineBox: [number, number, number, number] | null = null;

/** Corners of a block (flat offsets). */
export function blockRing(b: ArenaBlock): number[] {
  const c = Math.cos(b.rot);
  const s = Math.sin(b.rot);
  const out: number[] = [];
  for (const [lx, lz] of [[-b.w / 2, -b.d / 2], [b.w / 2, -b.d / 2], [b.w / 2, b.d / 2], [-b.w / 2, b.d / 2]]) {
    // three.js yaw: local x → (cos, −sin), local z → (sin, cos)
    out.push(b.x + lx * c + lz * s, b.z - lx * s + lz * c);
  }
  return out;
}

const WING_RING = blockRing(SPARK_ARENA_WING);
const PLANT_RING = blockRing(SPARK_ARENA_PLANT);

/** Roof height (m above the ground) at an offset from SPARK_ARENA; 0 outside the building. */
export function sparkArenaRoof(dx: number, dz: number): number {
  for (const l of ARENA_LENSES) if (inLens(l, dx, dz)) return lensHeight(l, dx, dz);
  if (inRing(OUTLINE, dx, dz)) return walkwayHeight(dx, dz);
  if (inRing(WING_RING, dx, dz)) return SPARK_ARENA_WING.h;
  if (inRing(PLANT_RING, dx, dz)) return SPARK_ARENA_PLANT.h;
  return 0;
}

/** Roof height (m above the ground) at a world point; 0 off the building. */
export function sparkArenaRoofAt(x: number, z: number): number {
  return sparkArenaRoof(x - SPARK_ARENA.x, z - SPARK_ARENA.z);
}

function segDist2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax;
  const vz = bz - az;
  const l2 = vx * vx + vz * vz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / l2));
  const dx = ax + vx * t - px;
  const dz = az + vz * t - pz;
  return dx * dx + dz * dz;
}

function nearRing(r: readonly number[], x: number, z: number, margin: number): boolean {
  if (inRing(r, x, z)) return true;
  if (margin <= 0) return false;
  const m2 = margin * margin;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) if (segDist2(x, z, r[j * 2], r[j * 2 + 1], r[i * 2], r[i * 2 + 1]) < m2) return true;
  return false;
}

/**
 * Whether the world point is on the arena (its roof outline, wing or plant deck) or within `margin`
 * m of it: the scatter and the procedural centres keep off it.
 */
export function sparkArenaCovers(x: number, z: number, margin = 0): boolean {
  const dx = x - SPARK_ARENA.x;
  const dz = z - SPARK_ARENA.z;
  if (!outlineBox) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const r of [OUTLINE, WING_RING, PLANT_RING]) {
      for (let i = 0; i < r.length; i += 2) {
        x0 = Math.min(x0, r[i]);
        x1 = Math.max(x1, r[i]);
        z0 = Math.min(z0, r[i + 1]);
        z1 = Math.max(z1, r[i + 1]);
      }
    }
    outlineBox = [x0, x1, z0, z1];
  }
  const [x0, x1, z0, z1] = outlineBox;
  if (dx < x0 - margin || dx > x1 + margin || dz < z0 - margin || dz > z1 + margin) return false;
  return nearRing(OUTLINE, dx, dz, margin) || nearRing(WING_RING, dx, dz, margin) || nearRing(PLANT_RING, dx, dz, margin);
}

/* ───────────────────────────── Solid volume ───────────────────────────── */

/** Clip a flat ring to the axis-aligned box (Sutherland–Hodgman; the box is convex). */
function clipToBox(ring: readonly number[], x0: number, z0: number, x1: number, z1: number): number[] {
  let pts = ring.slice();
  const edges: [number, number, number][] = [
    [0, 1, x0], // keep x ≥ x0
    [0, -1, x1], // keep x ≤ x1
    [1, 1, z0],
    [1, -1, z1],
  ];
  for (const [axis, sign, v] of edges) {
    const out: number[] = [];
    const n = pts.length / 2;
    if (!n) break;
    const inside = (i: number) => sign * (pts[i * 2 + axis] - v) >= 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = inside(i);
      const b = inside(j);
      if (a) out.push(pts[i * 2], pts[i * 2 + 1]);
      if (a !== b) {
        const pa = pts[i * 2 + axis];
        const pb = pts[j * 2 + axis];
        const t = (v - pa) / (pb - pa);
        out.push(pts[i * 2] + (pts[j * 2] - pts[i * 2]) * t, pts[i * 2 + 1] + (pts[j * 2 + 1] - pts[i * 2 + 1]) * t);
      }
    }
    pts = out;
  }
  return pts.length >= 6 ? pts : [];
}

/** A vertical prism of the solid volume: footprint ring (world x, z) and its roof (m above the ground). */
export interface ArenaSolid {
  ring: Float32Array;
  h: number;
}

/**
 * The arena as solid prisms for the sim: the roof outline cut into `cell`-m squares, each as high as
 * the highest roof sampled in it (so it errs ≤ ≈2 m high on the sloped lenses), plus the wing and the
 * plant deck.
 */
export function sparkArenaSolids(cell = 10): ArenaSolid[] {
  const out: ArenaSolid[] = [];
  const toWorld = (r: readonly number[]) => Float32Array.from(r, (v, i) => v + (i % 2 ? SPARK_ARENA.z : SPARK_ARENA.x));
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < OUTLINE.length; i += 2) {
    x0 = Math.min(x0, OUTLINE[i]);
    x1 = Math.max(x1, OUTLINE[i]);
    z0 = Math.min(z0, OUTLINE[i + 1]);
    z1 = Math.max(z1, OUTLINE[i + 1]);
  }
  const k = 4;
  for (let cx = Math.floor(x0 / cell) * cell; cx < x1; cx += cell) {
    for (let cz = Math.floor(z0 / cell) * cell; cz < z1; cz += cell) {
      const ring = clipToBox(OUTLINE, cx, cz, cx + cell, cz + cell);
      if (!ring.length || Math.abs(ringArea(ring)) < 1) continue;
      let h = 0;
      for (let i = 0; i <= k; i++) for (let j = 0; j <= k; j++) h = Math.max(h, sparkArenaRoof(cx + (cell * i) / k, cz + (cell * j) / k));
      for (let i = 0; i < ring.length; i += 2) h = Math.max(h, sparkArenaRoof(ring[i] * 0.999 + 0.001 * (cx + cell / 2), ring[i + 1] * 0.999 + 0.001 * (cz + cell / 2)));
      if (h > 0) out.push({ ring: toWorld(ring), h });
    }
  }
  out.push({ ring: toWorld(WING_RING), h: SPARK_ARENA_WING.h }, { ring: toWorld(PLANT_RING), h: SPARK_ARENA_PLANT.h });
  return out;
}
