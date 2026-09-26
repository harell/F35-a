/**
 * CoarseField — evaluates a smooth (low-frequency) function once on a coarse grid covering the
 * heightfield and returns bilinear interpolations. Generators use it for domain warps, masks and
 * large-scale shapes whose shortest wavelength is ≥ ~4 coarse cells, cutting full-resolution
 * noise evaluations by 2–3×. Non-linear shaping (abs, smoothstep, terraces) is applied AFTER the
 * interpolation so sharp features stay sharp.
 */
import { HF_EXTENT } from './types';

export class CoarseField {
  readonly n: number;
  readonly origin: number;
  readonly step: number;
  readonly data: Float32Array;
  private readonly inv: number;

  constructor(fn: (x: number, z: number) => number, cells = 256, extent = HF_EXTENT) {
    this.step = extent / cells;
    this.n = cells + 3;
    this.origin = -extent / 2 - this.step;
    this.inv = 1 / this.step;
    this.data = new Float32Array(this.n * this.n);
    for (let j = 0; j < this.n; j++) {
      const z = this.origin + j * this.step;
      for (let i = 0; i < this.n; i++) this.data[j * this.n + i] = fn(this.origin + i * this.step, z);
    }
  }

  at(x: number, z: number): number {
    let gx = (x - this.origin) * this.inv;
    let gz = (z - this.origin) * this.inv;
    const m = this.n - 1.001;
    if (gx < 0) gx = 0;
    else if (gx > m) gx = m;
    if (gz < 0) gz = 0;
    else if (gz > m) gz = m;
    const ix = gx | 0;
    const iz = gz | 0;
    const fx = gx - ix;
    const fz = gz - iz;
    const d = this.data;
    const i0 = iz * this.n + ix;
    const a = d[i0] + (d[i0 + 1] - d[i0]) * fx;
    const b = d[i0 + this.n] + (d[i0 + this.n + 1] - d[i0 + this.n]) * fx;
    return a + (b - a) * fz;
  }
}
