/**
 * Raster helpers for map-driven terrain (Auckland): scanline polygon fill into a label grid and an
 * exact Euclidean distance transform (Felzenszwalb & Huttenlocher) to build a signed distance field
 * of the coastline. Pure data / node-safe.
 */

/** Grid sampled at the same corner-aligned positions as a Heightfield of size n over `extent`. */
export interface GridSpec {
  n: number;
  extent: number;
}

/**
 * Fill a polygon (flat [x0, z0, x1, z1, ...] in metres) into `labels` with `value` (even–odd rule).
 * Sample (i, j) is at (−extent/2 + i·cell, −extent/2 + j·cell).
 */
export function fillPolygon(labels: Uint8Array, g: GridSpec, pts: number[], value: number): void {
  const n = g.n;
  const cell = g.extent / n;
  const org = -g.extent / 2;
  const count = pts.length / 2;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let k = 0; k < count; k++) {
    zMin = Math.min(zMin, pts[k * 2 + 1]);
    zMax = Math.max(zMax, pts[k * 2 + 1]);
  }
  const j0 = Math.max(0, Math.ceil((zMin - org) / cell));
  const j1 = Math.min(n - 1, Math.floor((zMax - org) / cell));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const z = org + j * cell;
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
      const i0 = Math.max(0, Math.ceil((xs[k] - org) / cell));
      const i1 = Math.min(n - 1, Math.floor((xs[k + 1] - org) / cell));
      for (let i = i0; i <= i1; i++) labels[j * n + i] = value;
    }
  }
}

/** Fill an ellipse (centre, radii, rotation in rad) with `value`. */
export function fillEllipse(labels: Uint8Array, g: GridSpec, cx: number, cz: number, rx: number, rz: number, rot: number, value: number): void {
  const pts: number[] = [];
  const segs = 48;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (let k = 0; k < segs; k++) {
    const a = (k / segs) * Math.PI * 2;
    const ex = Math.cos(a) * rx;
    const ez = Math.sin(a) * rz;
    pts.push(cx + ex * c - ez * s, cz + ex * s + ez * c);
  }
  fillPolygon(labels, g, pts, value);
}

const INF = 1e20;

/** 1D squared-distance transform of f (length n) into d (Felzenszwalb). */
function dt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** Squared Euclidean distance (in cells²) from every sample to the nearest sample where mask=1. */
export function squaredDistance(mask: Uint8Array, n: number): Float64Array {
  const out = new Float64Array(n * n);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  // columns
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) f[j] = mask[j * n + i] ? 0 : INF;
    dt1d(f, n, d, v, z);
    for (let j = 0; j < n; j++) out[j * n + i] = d[j];
  }
  // rows
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) f[i] = out[j * n + i];
    dt1d(f, n, d, v, z);
    for (let i = 0; i < n; i++) out[j * n + i] = d[i];
  }
  return out;
}

/**
 * Signed distance (m) to the land/water boundary: positive on land, negative in water.
 * `isLand(label)` decides which labels are land.
 */
export function signedDistance(labels: Uint8Array, g: GridSpec, isLand: (label: number) => boolean): Float32Array {
  const n = g.n;
  const cell = g.extent / n;
  const land = new Uint8Array(n * n);
  const water = new Uint8Array(n * n);
  for (let k = 0; k < n * n; k++) {
    if (isLand(labels[k])) land[k] = 1;
    else water[k] = 1;
  }
  const dToWater = squaredDistance(water, n);
  const dToLand = squaredDistance(land, n);
  const out = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) {
    out[k] = land[k] ? (Math.sqrt(dToWater[k]) - 0.5) * cell : -(Math.sqrt(dToLand[k]) - 0.5) * cell;
  }
  return out;
}

/** Bilinear sampler over a corner-aligned grid (same layout as Heightfield). */
export class GridSampler {
  private readonly inv: number;
  private readonly org: number;
  constructor(
    readonly data: Float32Array,
    readonly n: number,
    extent: number,
  ) {
    this.inv = n / extent;
    this.org = -extent / 2;
  }
  at(x: number, z: number): number {
    const n = this.n;
    let gx = (x - this.org) * this.inv;
    let gz = (z - this.org) * this.inv;
    if (gx < 0) gx = 0;
    else if (gx > n - 1.001) gx = n - 1.001;
    if (gz < 0) gz = 0;
    else if (gz > n - 1.001) gz = n - 1.001;
    const ix = gx | 0;
    const iz = gz | 0;
    const fx = gx - ix;
    const fz = gz - iz;
    const d = this.data;
    const k = iz * n + ix;
    const a = d[k] + (d[k + 1] - d[k]) * fx;
    const b = d[k + n] + (d[k + n + 1] - d[k + n]) * fx;
    return a + (b - a) * fz;
  }
}

/** Nearest-label lookup over a corner-aligned grid. */
export function labelAt(labels: Uint8Array, n: number, extent: number, x: number, z: number): number {
  const cell = extent / n;
  let i = Math.round((x + extent / 2) / cell);
  let j = Math.round((z + extent / 2) / cell);
  if (i < 0) i = 0;
  else if (i > n - 1) i = n - 1;
  if (j < 0) j = 0;
  else if (j > n - 1) j = n - 1;
  return labels[j * n + i];
}
