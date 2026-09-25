/**
 * Deterministic, allocation-free 2D noise for terrain generation (pure TS, no DOM — runs in
 * node tests too).
 *
 *  - `Noise2D.noise(x, y)`   gradient (Perlin-style) noise, quintic fade, range ≈ [-1, 1]
 *  - `Noise2D.noised(x, y)`  same value plus analytic derivatives (written to `dx`, `dy`)
 *  - fBm / ridged multifractal / "eroded" (derivative-damped) fBm helpers
 *
 * Every function is a pure function of (seed, x, y) so heightfields are reproducible.
 */
import { mulberry32 } from '../../core/math';

/** Rotation applied between octaves (≈ 36.87°) to hide lattice alignment. */
const RC = 0.8;
const RS = 0.6;

export class Noise2D {
  /** Permutation table (doubled + padding so perm[i + 1 + j] never overflows). */
  private readonly perm = new Uint16Array(514);
  private readonly gx = new Float64Array(256);
  private readonly gy = new Float64Array(256);
  /** Derivatives written by `noised`. */
  dx = 0;
  dy = 0;

  constructor(seed: number) {
    const rnd = mulberry32(seed ^ 0x9e3779b9);
    const p = new Uint16Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 514; i++) this.perm[i] = p[i & 255];
    for (let i = 0; i < 256; i++) {
      const a = rnd() * Math.PI * 2;
      this.gx[i] = Math.cos(a);
      this.gy[i] = Math.sin(a);
    }
  }

  /** Gradient noise, ≈ [-1, 1]. */
  noise(x: number, y: number): number {
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const xi = xf & 255;
    const yi = yf & 255;
    const x0 = x - xf;
    const y0 = y - yf;
    const x1 = x0 - 1;
    const y1 = y0 - 1;
    const u = x0 * x0 * x0 * (x0 * (x0 * 6 - 15) + 10);
    const v = y0 * y0 * y0 * (y0 * (y0 * 6 - 15) + 10);
    const perm = this.perm;
    const gx = this.gx;
    const gy = this.gy;
    const a = perm[xi] + yi;
    const b = perm[xi + 1] + yi;
    const aa = perm[a];
    const ab = perm[a + 1];
    const ba = perm[b];
    const bb = perm[b + 1];
    const n00 = gx[aa] * x0 + gy[aa] * y0;
    const n10 = gx[ba] * x1 + gy[ba] * y0;
    const n01 = gx[ab] * x0 + gy[ab] * y1;
    const n11 = gx[bb] * x1 + gy[bb] * y1;
    const nx0 = n00 + u * (n10 - n00);
    const nx1 = n01 + u * (n11 - n01);
    return (nx0 + v * (nx1 - nx0)) * 1.4142;
  }

  /** Gradient noise with analytic derivatives (stored in this.dx / this.dy). */
  noised(x: number, y: number): number {
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const xi = xf & 255;
    const yi = yf & 255;
    const x0 = x - xf;
    const y0 = y - yf;
    const x1 = x0 - 1;
    const y1 = y0 - 1;
    const u = x0 * x0 * x0 * (x0 * (x0 * 6 - 15) + 10);
    const v = y0 * y0 * y0 * (y0 * (y0 * 6 - 15) + 10);
    const du = 30 * x0 * x0 * (x0 * (x0 - 2) + 1);
    const dv = 30 * y0 * y0 * (y0 * (y0 - 2) + 1);
    const perm = this.perm;
    const gx = this.gx;
    const gy = this.gy;
    const a = perm[xi] + yi;
    const b = perm[xi + 1] + yi;
    const aa = perm[a];
    const ab = perm[a + 1];
    const ba = perm[b];
    const bb = perm[b + 1];
    const g00x = gx[aa], g00y = gy[aa];
    const g10x = gx[ba], g10y = gy[ba];
    const g01x = gx[ab], g01y = gy[ab];
    const g11x = gx[bb], g11y = gy[bb];
    const n00 = g00x * x0 + g00y * y0;
    const n10 = g10x * x1 + g10y * y0;
    const n01 = g01x * x0 + g01y * y1;
    const n11 = g11x * x1 + g11y * y1;
    const k = n00 - n10 - n01 + n11;
    const s = 1.4142;
    this.dx = s * (g00x + u * (g10x - g00x) + v * (g01x - g00x) + u * v * (g00x - g10x - g01x + g11x) + du * (n10 - n00 + v * k));
    this.dy = s * (g00y + u * (g10y - g00y) + v * (g01y - g00y) + u * v * (g00y - g10y - g01y + g11y) + dv * (n01 - n00 + u * k));
    return s * (n00 + u * (n10 - n00) + v * (n01 - n00) + u * v * k);
  }

  /** Classic fBm, ≈ [-1, 1]. */
  fbm(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise(x, y);
      norm += amp;
      amp *= gain;
      const nx = (RC * x - RS * y) * lacunarity;
      y = (RS * x + RC * y) * lacunarity;
      x = nx + 17.13;
    }
    return sum / norm;
  }

  /**
   * Ridged multifractal (Musgrave), ≈ [0, 1]. Sharp crests, each octave weighted by the
   * previous one so detail concentrates on ridges.
   */
  ridged(x: number, y: number, octaves: number, lacunarity = 2.1, gain = 0.5, offset = 1): number {
    let sum = 0;
    let amp = 0.5;
    let weight = 1;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      let n = offset - Math.abs(this.noise(x, y));
      n *= n;
      n *= weight;
      weight = n * 2;
      if (weight > 1) weight = 1;
      else if (weight < 0) weight = 0;
      sum += n * amp;
      norm += amp;
      amp *= gain;
      const nx = (RC * x - RS * y) * lacunarity;
      y = (RS * x + RC * y) * lacunarity;
      x = nx + 31.7;
    }
    return sum / norm;
  }

  /**
   * "Eroded" fBm (Iñigo Quilez): octaves are damped where the accumulated slope is steep,
   * giving smooth valleys and detailed crests. ≈ [-1, 1].
   */
  eroded(x: number, y: number, octaves: number, gain = 0.5, slopeK = 1): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let ddx = 0;
    let ddy = 0;
    for (let i = 0; i < octaves; i++) {
      const n = this.noised(x, y);
      ddx += this.dx * amp;
      ddy += this.dy * amp;
      sum += (amp * n) / (1 + slopeK * (ddx * ddx + ddy * ddy));
      norm += amp;
      amp *= gain;
      const nx = (RC * x - RS * y) * 2;
      y = (RS * x + RC * y) * 2;
      x = nx + 7.31;
    }
    return sum / norm;
  }
}

/** Integer hash → [0, 1). Stateless; handy for per-cell random decisions. */
export function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export const smooth01 = (t: number): number => {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
};

/** GLSL-style smoothstep. */
export function sstep(a: number, b: number, x: number): number {
  return smooth01((x - a) / (b - a));
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function mixf(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
