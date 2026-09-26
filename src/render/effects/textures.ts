/**
 * Procedural particle textures (generated once on a canvas; null in node tests):
 *  - glow: soft radial falloff with a hot core (lights, flares, flashes, tracers)
 *  - smoke atlas 2×2: noisy puffs; R = self-shading (lit top, darker bottom), A = density
 *  - fire atlas 2×2: flame licks / fireball noise (A = intensity)
 */
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, type Texture } from 'three';
import { createCanvas, rng } from '../models/geom/atlas';

let glow: Texture | null | undefined;
let smoke: Texture | null | undefined;
let fire: Texture | null | undefined;

function tex(c: HTMLCanvasElement | OffscreenCanvas): Texture {
  const t = new CanvasTexture(c as HTMLCanvasElement);
  t.colorSpace = NoColorSpace;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export function glowTexture(): Texture | null {
  if (glow !== undefined) return glow;
  const s = 64;
  const c = createCanvas(s, s);
  if (!c) return (glow = null);
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const img = ctx.createImageData(s, s);
  for (let y = 0; y < s; y++)
    for (let x = 0; x < s; x++) {
      const dx = (x + 0.5) / s - 0.5;
      const dy = (y + 0.5) / s - 0.5;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 2);
      const core = Math.exp(-r * r * 18);
      const halo = Math.pow(1 - r, 2.2);
      const a = Math.min(1, core * 0.75 + halo * 0.55);
      const o = (y * s + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
      img.data[o + 3] = Math.round(a * 255);
    }
  ctx.putImageData(img, 0, 0);
  return (glow = tex(c));
}

/** Value noise with a few octaves on a periodic grid. */
function noise2(seed: number): (x: number, y: number) => number {
  const N = 16;
  const r = rng(seed);
  const g = new Float32Array(N * N).map(() => r());
  const at = (i: number, j: number) => g[((j % N) + N) % N * N + (((i % N) + N) % N)];
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const v = (x: number, y: number) => {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = smooth(x - i);
    const fy = smooth(y - j);
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * fx;
    const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * fx;
    return a + (b - a) * fy;
  };
  return (x, y) => v(x, y) * 0.5 + v(x * 2.1 + 5, y * 2.1 + 3) * 0.3 + v(x * 4.3 + 9, y * 4.3 + 1) * 0.2;
}

/** 2×2 atlas of 128px noisy smoke puffs. */
export function smokeTexture(): Texture | null {
  if (smoke !== undefined) return smoke;
  const cell = 128;
  const s = cell * 2;
  const c = createCanvas(s, s);
  if (!c) return (smoke = null);
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const img = ctx.createImageData(s, s);
  for (let k = 0; k < 4; k++) {
    const n = noise2(100 + k * 17);
    const ox = (k % 2) * cell;
    const oy = Math.floor(k / 2) * cell;
    for (let y = 0; y < cell; y++)
      for (let x = 0; x < cell; x++) {
        const u = (x + 0.5) / cell - 0.5;
        const v = (y + 0.5) / cell - 0.5;
        const r = Math.sqrt(u * u + v * v) * 2;
        const nn = n(u * 5 + 8, v * 5 + 8);
        const edge = 1 - smoothstep(0.35 + nn * 0.35, 1.0, r);
        const dens = Math.max(0, Math.min(1, edge * (0.55 + nn * 0.75)));
        // self shading: lit from above (canvas y down → v<0 is top)
        const shade = Math.max(0, Math.min(1, 0.62 - v * 0.7 + (nn - 0.5) * 0.5));
        const o = ((oy + y) * s + ox + x) * 4;
        img.data[o] = Math.round(shade * 255);
        img.data[o + 1] = Math.round(nn * 255);
        img.data[o + 2] = 0;
        img.data[o + 3] = Math.round(dens * 255);
      }
  }
  ctx.putImageData(img, 0, 0);
  return (smoke = tex(c));
}

/** 2×2 atlas: 0 = soft glow blob, 1 = spark dot, 2/3 = turbulent fire. A = intensity. */
export function fireTexture(): Texture | null {
  if (fire !== undefined) return fire;
  const cell = 128;
  const s = cell * 2;
  const c = createCanvas(s, s);
  if (!c) return (fire = null);
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  const img = ctx.createImageData(s, s);
  for (let k = 0; k < 4; k++) {
    const n = noise2(300 + k * 31);
    const ox = (k % 2) * cell;
    const oy = Math.floor(k / 2) * cell;
    for (let y = 0; y < cell; y++)
      for (let x = 0; x < cell; x++) {
        const u = (x + 0.5) / cell - 0.5;
        const v = (y + 0.5) / cell - 0.5;
        const r = Math.sqrt(u * u + v * v) * 2;
        let a: number;
        if (k === 0) a = Math.pow(Math.max(0, 1 - r), 1.6);
        else if (k === 1) a = Math.exp(-r * r * 30) + Math.pow(Math.max(0, 1 - r), 4) * 0.3;
        else {
          const nn = n(u * 6 + 3, v * 6 + 3);
          a = Math.max(0, (1 - smoothstep(0.2 + nn * 0.5, 1.0, r)) * (0.4 + nn * 0.9));
        }
        const o = ((oy + y) * s + ox + x) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
        img.data[o + 3] = Math.round(Math.min(1, a) * 255);
      }
  }
  ctx.putImageData(img, 0, 0);
  return (fire = tex(c));
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function disposeEffectTextures(): void {
  glow?.dispose();
  smoke?.dispose();
  fire?.dispose();
  glow = smoke = fire = undefined;
}
