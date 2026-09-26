/**
 * Exact vector coastline for map-driven terrain (Auckland). Pure data / node-safe.
 *
 * The first version rasterised the hand-traced polygons into an 86 m label grid and ran a distance
 * transform on it: the zero contour of that field follows the raster staircase, so every coast was
 * saw-toothed at 86 m. Here the land/water boundary is kept as vector segments:
 *
 *  - `CoastPolygon[]` in painting order (water carved out of a land base, islands painted back,
 *    lakes carved last) with a point classifier that applies the same order;
 *  - `extractCoastSegments` keeps only the edge pieces that really separate land from water
 *    (overlapping water bodies share internal edges that must not become coast);
 *  - `splatDistance` writes the exact Euclidean distance to those segments into any grid, so a
 *    signed distance sampled at 86 m (heightfield) or 15 m (shader coast mask) and bilinearly
 *    interpolated has a smooth zero contour.
 */

export interface CoastPolygon {
  /** Flat [x0, z0, x1, z1, ...] in metres. */
  pts: Float64Array;
  /** Label painted inside (land = LAND_LABEL, anything else is water). */
  label: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export const LAND_LABEL = 1;

export function makePolygon(pts: ArrayLike<number>, label: number): CoastPolygon {
  const a = Float64Array.from(pts as ArrayLike<number>);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < a.length; i += 2) {
    minX = Math.min(minX, a[i]);
    maxX = Math.max(maxX, a[i]);
    minZ = Math.min(minZ, a[i + 1]);
    maxZ = Math.max(maxZ, a[i + 1]);
  }
  return { pts: a, label, minX, maxX, minZ, maxZ };
}

/** Ellipse (centre, radii, rotation rad) as a polygon with `segs` vertices. */
export function ellipsePolygon(cx: number, cz: number, rx: number, rz: number, rot: number, label: number, segs = 96): CoastPolygon {
  const pts: number[] = [];
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (let k = 0; k < segs; k++) {
    const a = (k / segs) * Math.PI * 2;
    const ex = Math.cos(a) * rx;
    const ez = Math.sin(a) * rz;
    pts.push(cx + ex * c - ez * s, cz + ex * s + ez * c);
  }
  return makePolygon(pts, label);
}

/** Even–odd point-in-polygon. */
export function insidePolygon(p: CoastPolygon, x: number, z: number): boolean {
  if (x < p.minX || x > p.maxX || z < p.minZ || z > p.maxZ) return false;
  const a = p.pts;
  const n = a.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = a[i * 2];
    const zi = a[i * 2 + 1];
    const xj = a[j * 2];
    const zj = a[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Label at a point: `base` unless a later polygon covers it (painting order). */
export function classify(polys: CoastPolygon[], x: number, z: number, base = LAND_LABEL): number {
  let label = base;
  for (let k = 0; k < polys.length; k++) if (insidePolygon(polys[k], x, z)) label = polys[k].label;
  return label;
}

/**
 * Edge pieces (≤ maxLen m) of all polygons that separate land from water, as a flat
 * [x0, z0, x1, z1, ...] list.
 */
export function extractCoastSegments(polys: CoastPolygon[], maxLen = 30, base = LAND_LABEL): Float32Array {
  const out: number[] = [];
  const eps = 0.75;
  for (const poly of polys) {
    const a = poly.pts;
    const n = a.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = a[i * 2];
      const z0 = a[i * 2 + 1];
      const x1 = a[j * 2];
      const z1 = a[j * 2 + 1];
      const len = Math.hypot(x1 - x0, z1 - z0);
      if (len < 1e-6) continue;
      const nx = -(z1 - z0) / len;
      const nz = (x1 - x0) / len;
      const pieces = Math.max(1, Math.ceil(len / maxLen));
      for (let k = 0; k < pieces; k++) {
        const t0 = k / pieces;
        const t1 = (k + 1) / pieces;
        const tm = (t0 + t1) / 2;
        const mx = x0 + (x1 - x0) * tm;
        const mz = z0 + (z1 - z0) * tm;
        const l1 = classify(polys, mx + nx * eps, mz + nz * eps, base) === LAND_LABEL;
        const l2 = classify(polys, mx - nx * eps, mz - nz * eps, base) === LAND_LABEL;
        if (l1 === l2) continue;
        out.push(x0 + (x1 - x0) * t0, z0 + (z1 - z0) * t0, x0 + (x1 - x0) * t1, z0 + (z1 - z0) * t1);
      }
    }
  }
  return Float32Array.from(out);
}

/** Regular grid: sample (i, j) at (x0 + i·cell, z0 + j·cell), row-major, n × n. */
export interface SampleGrid {
  n: number;
  x0: number;
  z0: number;
  cell: number;
}

/**
 * Min-splat the exact distance (m) from every grid sample within `radius` of a segment into `dist`
 * (pre-filled with `radius` or larger). Rows [j0, j1) only (default: all) so work can be split.
 */
export function splatDistance(segs: Float32Array, g: SampleGrid, radius: number, dist: Float32Array, j0 = 0, j1 = g.n, rowOffset = 0): void {
  const inv = 1 / g.cell;
  const n = g.n;
  for (let s = 0; s < segs.length; s += 4) {
    const ax = segs[s];
    const az = segs[s + 1];
    const bx = segs[s + 2];
    const bz = segs[s + 3];
    let i0 = Math.ceil((Math.min(ax, bx) - radius - g.x0) * inv);
    let i1 = Math.floor((Math.max(ax, bx) + radius - g.x0) * inv);
    let jj0 = Math.ceil((Math.min(az, bz) - radius - g.z0) * inv);
    let jj1 = Math.floor((Math.max(az, bz) + radius - g.z0) * inv);
    if (i1 < 0 || i0 > n - 1 || jj1 < j0 || jj0 > j1 - 1) continue;
    if (i0 < 0) i0 = 0;
    if (i1 > n - 1) i1 = n - 1;
    if (jj0 < j0) jj0 = j0;
    if (jj1 > j1 - 1) jj1 = j1 - 1;
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const il2 = l2 > 1e-9 ? 1 / l2 : 0;
    for (let j = jj0; j <= jj1; j++) {
      const z = g.z0 + j * g.cell;
      const row = (j - rowOffset) * n;
      for (let i = i0; i <= i1; i++) {
        const x = g.x0 + i * g.cell;
        let t = ((x - ax) * dx + (z - az) * dz) * il2;
        if (t < 0) t = 0;
        else if (t > 1) t = 1;
        const ex = ax + dx * t - x;
        const ez = az + dz * t - z;
        const d = Math.sqrt(ex * ex + ez * ez);
        const k = row + i;
        if (d < dist[k]) dist[k] = d;
      }
    }
  }
}

/** Scanline even–odd fill of a polygon into a label grid (samples at the SampleGrid positions). */
export function fillPolygonGrid(labels: Uint8Array, g: SampleGrid, poly: CoastPolygon, value: number): void {
  const n = g.n;
  const pts = poly.pts;
  const count = pts.length / 2;
  const j0 = Math.max(0, Math.ceil((poly.minZ - g.z0) / g.cell));
  const j1 = Math.min(n - 1, Math.floor((poly.maxZ - g.z0) / g.cell));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const z = g.z0 + j * g.cell;
    xs.length = 0;
    for (let k = 0; k < count; k++) {
      const ax = pts[k * 2];
      const az = pts[k * 2 + 1];
      const b = (k + 1) % count;
      const bx = pts[b * 2];
      const bz = pts[b * 2 + 1];
      if ((az <= z && bz > z) || (bz <= z && az > z)) xs.push(ax + ((z - az) / (bz - az)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - g.x0) / g.cell));
      const i1 = Math.min(n - 1, Math.floor((xs[k + 1] - g.x0) / g.cell));
      for (let i = i0; i <= i1; i++) labels[j * n + i] = value;
    }
  }
}

/** Exact distance (m) from (x, z) to the nearest segment (brute force; tests / sparse queries). */
export function segmentDistance(segs: Float32Array, x: number, z: number): number {
  let best = Infinity;
  for (let s = 0; s < segs.length; s += 4) {
    const ax = segs[s];
    const az = segs[s + 1];
    const dx = segs[s + 2] - ax;
    const dz = segs[s + 3] - az;
    const l2 = dx * dx + dz * dz;
    let t = l2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const ex = ax + dx * t - x;
    const ez = az + dz * t - z;
    const d = ex * ex + ez * ez;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** Coast mask encoding: signed distance (m, + land) clamped to ±COAST_MASK_RANGE in a byte. */
export const COAST_MASK_RANGE = 64;

export function encodeCoast(d: number): number {
  const v = Math.round((d / COAST_MASK_RANGE) * 127.5 + 127.5);
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

export function decodeCoast(b: number): number {
  return ((b - 127.5) / 127.5) * COAST_MASK_RANGE;
}
