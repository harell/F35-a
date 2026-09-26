/**
 * TerrainQuery over a Heightfield (see src/sim/api.ts). Used by the sim for crashes, radar
 * line-of-sight (thousands of calls per second), missiles and spawning — so everything here is
 * allocation-free.
 *
 * lineOfSight / raycast use a max-height pyramid of the SURFACE (max(h, 0): the sea counts as a
 * surface) and a hierarchical 2D DDA: blocks whose max height lies below the segment inside the
 * block are skipped wholesale; only candidate blocks are refined (factor 4 per level) down to
 * single grid cells, where the bilinear surface is tested exactly.
 */
import type { Vector3 } from 'three';
import type { TerrainQuery } from '../../sim/api';
import type { Heightfield } from './Heightfield';
import { WORLD_SIZE } from './types';

/** Terrain must rise this far above a sight line to block it (m). */
const LOS_TOLERANCE = 0.5;

export class TerrainQueryImpl implements TerrainQuery {
  readonly size = WORLD_SIZE;
  readonly hf: Heightfield;
  /** Max-surface pyramid: levels[L] has dims[L]² blocks of 2^L × 2^L cells. */
  private readonly levels: Float32Array[] = [];
  private readonly dims: number[] = [];
  private readonly blockSize: number[] = [];
  /** Level used at the top of the traversal. */
  private readonly top: number;
  /** Highest surface anywhere (m). */
  readonly maxSurface: number;
  /** Highest surface along the grid border (the clamped outside world). */
  private readonly outsideMax: number;
  private readonly gridMin: number;
  private readonly gridMax: number;

  // Current ray (set per query; avoids closures/allocations).
  private ox = 0;
  private oy = 0;
  private oz = 0;
  private dx = 0;
  private dy = 0;
  private dz = 0;
  /** true: stop at the first blocked point (LOS); false: find the exact first hit (raycast). */
  private anyHit = true;

  constructor(hf: Heightfield) {
    this.hf = hf;
    const n = hf.n;
    const c = n - 1;
    const d = hf.data;
    // Level 0: per-cell max of the 4 corner surfaces.
    let l0 = new Float32Array(c * c);
    let gmax = 0;
    for (let j = 0; j < c; j++) {
      for (let i = 0; i < c; i++) {
        const k = j * n + i;
        let m = d[k];
        if (d[k + 1] > m) m = d[k + 1];
        if (d[k + n] > m) m = d[k + n];
        if (d[k + n + 1] > m) m = d[k + n + 1];
        if (m < 0) m = 0;
        l0[j * c + i] = m;
        if (m > gmax) gmax = m;
      }
    }
    this.levels.push(l0);
    this.dims.push(c);
    this.blockSize.push(hf.cell);
    let dim = c;
    while (dim > 1) {
      const nd = Math.ceil(dim / 2);
      const prev = this.levels[this.levels.length - 1];
      const next = new Float32Array(nd * nd);
      for (let j = 0; j < nd; j++) {
        for (let i = 0; i < nd; i++) {
          const i0 = i * 2;
          const j0 = j * 2;
          let m = prev[j0 * dim + i0];
          if (i0 + 1 < dim && prev[j0 * dim + i0 + 1] > m) m = prev[j0 * dim + i0 + 1];
          if (j0 + 1 < dim) {
            if (prev[(j0 + 1) * dim + i0] > m) m = prev[(j0 + 1) * dim + i0];
            if (i0 + 1 < dim && prev[(j0 + 1) * dim + i0 + 1] > m) m = prev[(j0 + 1) * dim + i0 + 1];
          }
          next[j * nd + i] = m;
        }
      }
      this.levels.push(next);
      this.dims.push(nd);
      this.blockSize.push(this.blockSize[this.blockSize.length - 1] * 2);
      dim = nd;
      l0 = next;
    }
    // Start the traversal at an even level with a handful of blocks per side.
    let top = 0;
    while (top + 2 < this.levels.length && this.dims[top + 2] >= 4) top += 2;
    this.top = top;
    this.maxSurface = gmax;
    let om = 0;
    for (let i = 0; i < n; i++) {
      om = Math.max(om, d[i], d[(n - 1) * n + i], d[i * n], d[i * n + n - 1]);
    }
    this.outsideMax = om;
    this.gridMin = hf.origin;
    this.gridMax = hf.origin + (n - 1) * hf.cell;
  }

  heightAt(x: number, z: number): number {
    return this.hf.heightAt(x, z);
  }

  surfaceHeightAt(x: number, z: number): number {
    const h = this.hf.heightAt(x, z);
    return h > 0 ? h : 0;
  }

  isWater(x: number, z: number): boolean {
    return this.hf.heightAt(x, z) < 0;
  }

  lineOfSight(a: Vector3, b: Vector3): boolean {
    const top = Math.min(a.y, b.y);
    if (top > this.maxSurface + LOS_TOLERANCE) return true;
    this.ox = a.x;
    this.oy = a.y;
    this.oz = a.z;
    this.dx = b.x - a.x;
    this.dy = b.y - a.y;
    this.dz = b.z - a.z;
    const len = Math.sqrt(this.dx * this.dx + this.dy * this.dy + this.dz * this.dz);
    if (len < 1e-3) return true;
    // Ignore the first/last metre so entities sitting on the ground can see out.
    const eps = Math.min(0.05, 1 / len);
    this.anyHit = true;
    return this.march(eps, 1 - eps) < 0;
  }

  raycast(origin: Vector3, dir: Vector3, maxDist: number): number {
    if (maxDist <= 0) return -1;
    this.ox = origin.x;
    this.oy = origin.y;
    this.oz = origin.z;
    this.dx = dir.x;
    this.dy = dir.y;
    this.dz = dir.z;
    const s0 = this.surfaceHeightAt(origin.x, origin.z);
    if (origin.y <= s0) return 0;
    // Quick reject: ray never goes below the highest surface within range.
    if (Math.min(origin.y, origin.y + dir.y * maxDist) > this.maxSurface) return -1;
    this.anyHit = false;
    return this.march(0, maxDist);
  }

  /* ───────────────────────── internals ───────────────────────── */

  private yAt(t: number): number {
    return this.oy + this.dy * t;
  }

  /** Surface (max(bilinear h, 0)) inside grid cell (ix, iz) at world (x, z). */
  private cellSurface(ix: number, iz: number, x: number, z: number): number {
    const hf = this.hf;
    const n = hf.n;
    const fx = (x - hf.origin) / hf.cell - ix;
    const fz = (z - hf.origin) / hf.cell - iz;
    const d = hf.data;
    const k = iz * n + ix;
    const a = d[k] + (d[k + 1] - d[k]) * fx;
    const b = d[k + n] + (d[k + n + 1] - d[k + n]) * fx;
    const h = a + (b - a) * fz;
    return h > 0 ? h : 0;
  }

  /**
   * March the current ray over [t0, t1]: the part outside the grid is tested against the
   * (flat) outside surface, the inside part hierarchically. Returns the hit t or -1.
   */
  private march(t0: number, t1: number): number {
    // Clip to the grid square (slab test on X and Z).
    let tin = t0;
    let tout = t1;
    const lo = this.gridMin;
    const hi = this.gridMax - 1e-3;
    if (Math.abs(this.dx) < 1e-12) {
      if (this.ox < lo || this.ox > hi) tout = -Infinity;
    } else {
      const ta = (lo - this.ox) / this.dx;
      const tb = (hi - this.ox) / this.dx;
      const tlo = ta < tb ? ta : tb;
      const thi = ta < tb ? tb : ta;
      if (tlo > tin) tin = tlo;
      if (thi < tout) tout = thi;
    }
    if (Math.abs(this.dz) < 1e-12) {
      if (this.oz < lo || this.oz > hi) tout = -Infinity;
    } else {
      const ta = (lo - this.oz) / this.dz;
      const tb = (hi - this.oz) / this.dz;
      const tlo = ta < tb ? ta : tb;
      const thi = ta < tb ? tb : ta;
      if (tlo > tin) tin = tlo;
      if (thi < tout) tout = thi;
    }
    const inside = tin < tout;
    // Before entering the grid
    const preEnd = inside ? tin : t1;
    if (preEnd > t0) {
      const r = this.outsideTest(t0, preEnd);
      if (r >= 0) return r;
    }
    if (inside) {
      const r = this.traverse(this.top, tin, tout);
      if (r >= 0) return r;
      if (tout < t1) return this.outsideTest(tout, t1);
    }
    return -1;
  }

  /**
   * Outside the grid the world is the clamped edge profile (smooth, low): quick reject against its
   * maximum, otherwise march with the clamped heightAt at ~100 m steps (rare: only near the edge).
   */
  private outsideTest(t0: number, t1: number): number {
    const y0 = this.yAt(t0);
    const y1 = this.yAt(t1);
    if (Math.min(y0, y1) > this.outsideMax) return -1;
    const len = Math.sqrt(this.dx * this.dx + this.dy * this.dy + this.dz * this.dz);
    const span = t1 - t0;
    const steps = Math.max(2, Math.min(600, Math.ceil((span * len) / 100)));
    let prevT = t0;
    for (let i = 0; i <= steps; i++) {
      const t = t0 + (span * i) / steps;
      const f = this.yAt(t) - this.surfaceHeightAt(this.ox + this.dx * t, this.oz + this.dz * t);
      if (this.anyHit) {
        if (f < -LOS_TOLERANCE) return t;
      } else if (f <= 0) return i === 0 ? t : this.bisect(prevT, t);
      prevT = t;
    }
    return -1;
  }

  private bisect(ta: number, tb: number): number {
    for (let k = 0; k < 18; k++) {
      const tm = (ta + tb) * 0.5;
      const f = this.yAt(tm) - this.surfaceHeightAt(this.ox + this.dx * tm, this.oz + this.dz * tm);
      if (f > 0) ta = tm;
      else tb = tm;
    }
    return (ta + tb) * 0.5;
  }

  /** Hierarchical DDA over pyramid level L within [t0, t1]. */
  private traverse(L: number, t0: number, t1: number): number {
    const B = this.blockSize[L];
    const C = this.dims[L];
    const M = this.levels[L];
    const org = this.hf.origin;
    const dx = this.dx;
    const dz = this.dz;
    const xs = this.ox + dx * t0;
    const zs = this.oz + dz * t0;
    let ix = Math.floor((xs - org) / B);
    let iz = Math.floor((zs - org) / B);
    if (ix < 0) ix = 0;
    else if (ix >= C) ix = C - 1;
    if (iz < 0) iz = 0;
    else if (iz >= C) iz = C - 1;
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    let tMaxX = stepX !== 0 ? (org + (ix + (stepX > 0 ? 1 : 0)) * B - this.ox) / dx : Infinity;
    let tMaxZ = stepZ !== 0 ? (org + (iz + (stepZ > 0 ? 1 : 0)) * B - this.oz) / dz : Infinity;
    const tDX = stepX !== 0 ? B / Math.abs(dx) : Infinity;
    const tDZ = stepZ !== 0 ? B / Math.abs(dz) : Infinity;
    let tc = t0;
    const tol = this.anyHit ? LOS_TOLERANCE : 0;
    for (let guard = 0; guard < 100_000; guard++) {
      let tn = tMaxX < tMaxZ ? tMaxX : tMaxZ;
      if (tn > t1) tn = t1;
      if (tn < tc) tn = tc;
      const ya = this.oy + this.dy * tc;
      const yb = this.oy + this.dy * tn;
      const ymin = ya < yb ? ya : yb;
      if (ymin < M[iz * C + ix] - tol) {
        const r = L === 0 ? this.cellTest(ix, iz, tc, tn) : this.traverse(L >= 2 ? L - 2 : 0, tc, tn);
        if (r >= 0) return r;
      }
      if (tn >= t1) return -1;
      if (tMaxX < tMaxZ) {
        ix += stepX;
        tc = tMaxX;
        tMaxX += tDX;
      } else {
        iz += stepZ;
        tc = tMaxZ;
        tMaxZ += tDZ;
      }
      if (ix < 0 || ix >= C || iz < 0 || iz >= C) return -1;
    }
    return -1;
  }

  /**
   * Exact test of the surface inside one grid cell for t in [t0, t1]. Along a straight line the
   * bilinear patch is a quadratic in t, so f(t) = y(t) − h(t) is solved analytically; the sea
   * surface (y = 0) is handled separately.
   */
  private cellTest(ix: number, iz: number, t0: number, t1: number): number {
    const hf = this.hf;
    const n = hf.n;
    if (ix >= n - 1) ix = n - 2;
    if (iz >= n - 1) iz = n - 2;
    const inv = 1 / hf.cell;
    const fx0 = (this.ox + this.dx * t0 - hf.origin) * inv - ix;
    const fz0 = (this.oz + this.dz * t0 - hf.origin) * inv - iz;
    const kx = this.dx * inv;
    const kz = this.dz * inv;
    const d = hf.data;
    const k = iz * n + ix;
    const h00 = d[k];
    const h10 = d[k + 1];
    const h01 = d[k + n];
    const h11 = d[k + n + 1];
    const bx = h10 - h00;
    const bz = h01 - h00;
    const dd = h00 - h10 - h01 + h11;
    const c0 = h00 + bx * fx0 + bz * fz0 + dd * fx0 * fz0;
    const c1 = bx * kx + bz * kz + dd * (fx0 * kz + fz0 * kx);
    const c2 = dd * kx * kz;
    const y0 = this.oy + this.dy * t0;
    // f(s) = q0 + q1·s + q2·s², s = t − t0 ∈ [0, T]
    const q0 = y0 - c0;
    const q1 = this.dy - c1;
    const q2 = -c2;
    const T = t1 - t0;
    const y1 = y0 + this.dy * T;
    if (this.anyHit) {
      const tol = LOS_TOLERANCE;
      let fmin = q0;
      const fT = q0 + q1 * T + q2 * T * T;
      if (fT < fmin) fmin = fT;
      if (q2 > 0) {
        const sv = -q1 / (2 * q2);
        if (sv > 0 && sv < T) {
          const fv = q0 + q1 * sv + q2 * sv * sv;
          if (fv < fmin) fmin = fv;
        }
      }
      if (fmin < -tol) return t0;
      if ((y0 < y1 ? y0 : y1) < -tol) return t0;
      return -1;
    }
    let best = Infinity;
    if (q0 <= 0) best = 0;
    else if (Math.abs(q2) < 1e-12) {
      if (q1 < 0) {
        const sr = -q0 / q1;
        if (sr <= T) best = sr;
      }
    } else {
      const disc = q1 * q1 - 4 * q2 * q0;
      if (disc >= 0) {
        const r = Math.sqrt(disc);
        const sA = (-q1 - r) / (2 * q2);
        const sB = (-q1 + r) / (2 * q2);
        const lo = sA < sB ? sA : sB;
        const hi = sA < sB ? sB : sA;
        if (lo >= 0 && lo <= T) best = lo;
        else if (hi >= 0 && hi <= T) best = hi;
      }
    }
    // Sea surface
    if (y0 <= 0) best = 0;
    else if (this.dy < 0) {
      const sw = -y0 / this.dy;
      if (sw <= T && sw < best) best = sw;
    }
    return best <= T ? t0 + best : -1;
  }
}
