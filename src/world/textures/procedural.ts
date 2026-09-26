/**
 * Procedural textures built from typed arrays (no network, no canvas): tileable detail noise for
 * terrain close-ups, cloud puff atlas, cloud-layer density, soft glow sprite, concrete, urban
 * street grid. Every generator is deterministic.
 */
import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  type Texture,
} from 'three';
import { mulberry32 } from '../../core/math';

/** Periodic value noise (period `p` lattice cells across the texture), smooth-interpolated, [0,1]. */
function periodicValueNoise(size: number, p: number, rnd: () => number, out: Float32Array, amp: number, stretchX = 1): void {
  const lat = new Float32Array(p * p);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  for (let y = 0; y < size; y++) {
    const gy = (y / size) * p;
    const iy = Math.floor(gy);
    const fy = gy - iy;
    const sy = fy * fy * (3 - 2 * fy);
    const y0 = iy % p;
    const y1 = (iy + 1) % p;
    for (let x = 0; x < size; x++) {
      const gx = ((x / size) * p) / stretchX;
      const ix = Math.floor(gx);
      const fx = gx - ix;
      const sx = fx * fx * (3 - 2 * fx);
      const px = Math.max(1, Math.round(p / stretchX));
      const x0 = ix % px;
      const x1 = (ix + 1) % px;
      const a = lat[y0 * p + x0] + (lat[y0 * p + x1] - lat[y0 * p + x0]) * sx;
      const b = lat[y1 * p + x0] + (lat[y1 * p + x1] - lat[y1 * p + x0]) * sx;
      out[y * size + x] += (a + (b - a) * sy) * amp;
    }
  }
}

/** Tileable fBm in [0,1]. */
export function tileableFbm(size: number, basePeriod: number, octaves: number, seed: number, gain = 0.5, stretchX = 1): Float32Array {
  const rnd = mulberry32(seed);
  const out = new Float32Array(size * size);
  let amp = 1;
  let norm = 0;
  let p = basePeriod;
  for (let o = 0; o < octaves && p <= size; o++) {
    periodicValueNoise(size, p, rnd, out, amp, stretchX);
    norm += amp;
    amp *= gain;
    p *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

function normalize01(a: Float32Array): Float32Array {
  let mn = Infinity;
  let mx = -Infinity;
  for (const v of a) {
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const k = 1 / Math.max(1e-6, mx - mn);
  for (let i = 0; i < a.length; i++) a[i] = (a[i] - mn) * k;
  return a;
}

function dataTexture(data: Uint8Array, size: number, opts: { repeat?: boolean; srgb?: boolean; mips?: boolean; w?: number; h?: number } = {}): DataTexture {
  const w = opts.w ?? size;
  const h = opts.h ?? size;
  const t = new DataTexture(data, w, h, RGBAFormat, UnsignedByteType);
  t.wrapS = t.wrapT = opts.repeat === false ? ClampToEdgeWrapping : RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = opts.mips === false ? LinearFilter : LinearMipmapLinearFilter;
  t.generateMipmaps = opts.mips !== false;
  if (opts.srgb) t.colorSpace = SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Terrain detail textures (256², tiling):
 *   detail  R = fine grain, G = medium blotches, B = rock strata, A = clumps (canopy / grass tufts)
 *   normal  tangent-space bump normal derived from R+G (xy in RG, packed 0..255), B = 255
 */
export function createDetailTextures(): { detail: DataTexture; normal: DataTexture } {
  const S = 256;
  const fine = normalize01(tileableFbm(S, 32, 4, 11, 0.55));
  const med = normalize01(tileableFbm(S, 8, 4, 12, 0.55));
  const strata = normalize01(tileableFbm(S, 16, 4, 13, 0.5, 4));
  const clump = normalize01(tileableFbm(S, 16, 3, 14, 0.6));
  const d = new Uint8Array(S * S * 4);
  const bump = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) {
    d[i * 4] = (fine[i] * 255) | 0;
    d[i * 4 + 1] = (med[i] * 255) | 0;
    d[i * 4 + 2] = (strata[i] * 255) | 0;
    const c = clump[i];
    d[i * 4 + 3] = (Math.min(1, Math.max(0, (c - 0.35) * 2.2)) * 255) | 0;
    bump[i] = fine[i] * 0.6 + med[i] * 0.4;
  }
  const nrm = new Uint8Array(S * S * 4);
  const k = 5.5;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const l = bump[y * S + ((x + S - 1) % S)];
      const r = bump[y * S + ((x + 1) % S)];
      const u = bump[((y + S - 1) % S) * S + x];
      const dn = bump[((y + 1) % S) * S + x];
      let nx = (l - r) * k;
      let ny = (u - dn) * k;
      const len = Math.sqrt(nx * nx + ny * ny + 1);
      nx /= len;
      ny /= len;
      const o = (y * S + x) * 4;
      nrm[o] = ((nx * 0.5 + 0.5) * 255) | 0;
      nrm[o + 1] = ((ny * 0.5 + 0.5) * 255) | 0;
      nrm[o + 2] = 255;
      nrm[o + 3] = 255;
    }
  }
  return { detail: dataTexture(d, S), normal: dataTexture(nrm, S) };
}

/**
 * Procedural water normal map (fallback when public/textures/waternormals.jpg is unavailable):
 * sum of directional wave trains, tileable, packed like a standard tangent-space normal map.
 */
export function createWaterNormalFallback(): DataTexture {
  const S = 256;
  const h = new Float32Array(S * S);
  const rnd = mulberry32(99);
  for (let w = 0; w < 14; w++) {
    const kx = Math.round((rnd() - 0.5) * 24);
    const ky = Math.round((rnd() - 0.5) * 24);
    const ph = rnd() * Math.PI * 2;
    const a = 1 / (1 + Math.hypot(kx, ky) * 0.25);
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) h[y * S + x] += a * Math.sin(((kx * x + ky * y) / S) * Math.PI * 2 + ph);
  }
  const fine = tileableFbm(S, 32, 3, 5);
  for (let i = 0; i < h.length; i++) h[i] += (fine[i] - 0.5) * 1.5;
  const out = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const dx = h[y * S + ((x + 1) % S)] - h[y * S + ((x + S - 1) % S)];
      const dy = h[((y + 1) % S) * S + x] - h[((y + S - 1) % S) * S + x];
      const nx = -dx * 0.35;
      const ny = -dy * 0.35;
      const l = Math.sqrt(nx * nx + ny * ny + 1);
      const o = (y * S + x) * 4;
      out[o] = ((nx / l) * 127.5 + 127.5) | 0;
      out[o + 1] = ((ny / l) * 127.5 + 127.5) | 0;
      out[o + 2] = ((1 / l) * 127.5 + 127.5) | 0;
      out[o + 3] = 255;
    }
  return dataTexture(out, S);
}

/**
 * Cloud puff atlas: 2×2 variants (128² each, 256² total). R = density (alpha), G = baked top-lit
 * shading (bright crowns, darker undersides), B = soft edge mask.
 */
export function createCloudAtlas(): DataTexture {
  const T = 128;
  const S = T * 2;
  const out = new Uint8Array(S * S * 4);
  for (let v = 0; v < 4; v++) {
    const n = normalize01(tileableFbm(T, 4, 5, 200 + v, 0.55));
    const rnd = mulberry32(300 + v);
    // a few sub-blobs make the silhouette lumpy
    const blobs: [number, number, number][] = [];
    const nb = 4 + ((rnd() * 3) | 0);
    for (let b = 0; b < nb; b++) {
      const a = rnd() * Math.PI * 2;
      const d = 0.12 + rnd() * 0.2;
      blobs.push([0.5 + Math.cos(a) * d, 0.52 + Math.sin(a) * d * 0.7 - 0.05, 0.2 + rnd() * 0.14]);
    }
    blobs.push([0.5, 0.5, 0.3]);
    const ox = (v % 2) * T;
    const oy = ((v / 2) | 0) * T;
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const u = x / (T - 1);
        const w = y / (T - 1);
        let dens = 0;
        for (const [bx, by, br] of blobs) {
          const d = Math.hypot(u - bx, w - by) / br;
          dens = Math.max(dens, 1 - d * d);
        }
        const noise = n[y * T + x];
        dens = dens * (0.55 + 0.75 * noise) - 0.18;
        // flatter bottoms: fade the lower edge (texture v grows downward in rows → y = up in UV)
        const edge = Math.min(u, 1 - u, w, 1 - w) * 5;
        dens *= Math.min(1, edge);
        dens = Math.max(0, Math.min(1, dens * 1.6));
        // Shading: lit from above (w high = top in UV space as rows go up in flipY=false data)
        const light = Math.max(0, Math.min(1, 0.35 + 0.75 * w + 0.25 * (noise - 0.5)));
        const o = ((oy + y) * S + ox + x) * 4;
        out[o] = (dens * 255) | 0;
        out[o + 1] = (light * 255) | 0;
        out[o + 2] = (Math.min(1, edge) * 255) | 0;
        out[o + 3] = 255;
      }
    }
  }
  return dataTexture(out, S, { repeat: false });
}

/** Tileable cloud-layer density (overcast deck, sky-dome cirrus/cumulus band). R = billow, G = wisps. */
export function createCloudLayerTexture(): DataTexture {
  const S = 256;
  const a = normalize01(tileableFbm(S, 4, 6, 400, 0.55));
  const b = normalize01(tileableFbm(S, 8, 5, 401, 0.6, 3));
  const out = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    out[i * 4] = (a[i] * 255) | 0;
    out[i * 4 + 1] = (b[i] * 255) | 0;
    out[i * 4 + 2] = 0;
    out[i * 4 + 3] = 255;
  }
  return dataTexture(out, S);
}

/** Soft radial glow (point lights, stars): white with gaussian falloff in alpha. */
export function createGlowTexture(size = 64): DataTexture {
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const r = Math.sqrt(dx * dx + dy * dy) * 2;
      const core = Math.exp(-r * r * 18);
      const halo = Math.exp(-r * r * 4) * 0.35;
      const a = Math.max(0, Math.min(1, core + halo)) * (1 - Math.min(1, r));
      const o = (y * size + x) * 4;
      out[o] = out[o + 1] = out[o + 2] = 255;
      out[o + 3] = (a * 255) | 0;
    }
  return dataTexture(out, size, { repeat: false });
}

/** Tileable concrete (aprons/taxiways): slabs with joints, stains, tyre marks. sRGB. */
export function createConcreteTexture(): DataTexture {
  const S = 256;
  const n = normalize01(tileableFbm(S, 8, 5, 600, 0.55));
  const g = normalize01(tileableFbm(S, 64, 2, 601, 0.5));
  const out = new Uint8Array(S * S * 4);
  const slab = 32; // 8 slabs per tile
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      let v = 150 + (n[i] - 0.5) * 40 + (g[i] - 0.5) * 18;
      if (x % slab === 0 || y % slab === 0) v -= 38;
      const o = i * 4;
      out[o] = v;
      out[o + 1] = v * 0.99;
      out[o + 2] = v * 0.96;
      out[o + 3] = 255;
    }
  return dataTexture(out, S, { srgb: true });
}

/**
 * Tileable town ground (streets + blocks + yards), one tile = 4×4 blocks. Alpha fades nothing —
 * the decal shader fades by distance from the town centre. sRGB.
 */
export function createUrbanTexture(): DataTexture {
  const S = 256;
  const n = normalize01(tileableFbm(S, 16, 4, 700, 0.55));
  const rnd = mulberry32(701);
  const out = new Uint8Array(S * S * 4);
  const block = 64;
  const street = 7;
  const lot: number[] = [];
  for (let i = 0; i < 64; i++) lot.push(rnd());
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const bx = x % block;
      const by = y % block;
      let r: number, g: number, b: number;
      if (bx < street || by < street) {
        // asphalt with a faint centre line
        const v = 62 + n[i] * 18;
        r = g = v;
        b = v + 2;
        if ((bx === 3 || by === 3) && ((x + y) >> 3) % 2 === 0) {
          r = g = b = 150;
        }
      } else {
        // lots: pavement / yards / small gardens
        const lx = Math.floor(bx / 16);
        const ly = Math.floor(by / 16);
        const k = lot[((Math.floor(x / block) * 4 + Math.floor(y / block)) * 4 + lx + ly * 2) % 64];
        const v = n[i];
        if (k < 0.3) {
          r = 96 + v * 30;
          g = 112 + v * 30;
          b = 70 + v * 20;
        } else {
          r = 150 + v * 40 + k * 20;
          g = 140 + v * 36 + k * 16;
          b = 124 + v * 30;
        }
      }
      const o = i * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
  return dataTexture(out, S, { srgb: true });
}

export function disposeTextures(list: (Texture | null | undefined)[]): void {
  for (const t of list) t?.dispose();
}
