/**
 * CPU texture bakers for terrain rendering (pure data, node/worker-safe):
 *
 *  - bakeSunVisibility: soft terrain shadows for a directional light, O(n²) horizon sweep
 *  - bakeSurface:       RGBA8 "surface" texture — R,G = normal x/z, B = √(water depth), A = sun visibility
 *  - bakeColorRows:     RGBA8 albedo map (sRGB) of Auckland + forest density in A
 */
import type { SceneryFeature } from '../../core/contracts';
import type { TheaterId } from '../../core/types';
import { Noise2D, sstep, hash2 } from './noise';
import { footprintOf, footprintReach, footprintWeight, AIRBASE } from './features';
import type { Footprint } from './types';
import { MAT_BEACH, MAT_VOLCANIC, MAT_URBAN, MAT_BUSH, MAT_CONE, MAT_CLEARING, MAT_PINE } from './types';
import { createVegetation } from './vegetation';

/** Minimal heightfield view (lets workers pass raw arrays). */
export interface HfView {
  n: number;
  cell: number;
  origin: number;
  data: Float32Array;
  mat: Uint8Array;
  aux: Uint8Array;
}

/** Depth (m) mapped to B = 255 in the surface texture (B stores √(depth / WATER_DEPTH_RANGE)). */
export const WATER_DEPTH_RANGE = 48;

/**
 * Soft sun visibility (0..1) per sample by sweeping "shadow height" away from the light:
 *   S(p) = max(h(p), S(p + u) − |u|·tanθ)   (u = one cell step towards the sun)
 * Processing order guarantees the upstream sample is already known.
 */
export function bakeSunVisibility(hf: HfView, sun: { x: number; y: number; z: number }, out: Uint8Array, softness = 30): void {
  const n = hf.n;
  const h = hf.data;
  const hd = Math.hypot(sun.x, sun.z);
  if (sun.y <= 0.005) {
    out.fill(0);
    return;
  }
  if (hd < 1e-3 || sun.y / hd > 8) {
    out.fill(255);
    return;
  }
  const tan = sun.y / hd;
  const dx = sun.x / hd;
  const dz = sun.z / hd;
  const k = 1 / Math.max(Math.abs(dx), Math.abs(dz));
  const ux = dx * k;
  const uz = dz * k;
  const drop = hf.cell * k * tan;
  const S = new Float32Array(n * n);
  const surf = (i: number) => (h[i] > 0 ? h[i] : 0);
  const inv = 1 / softness;
  const majorX = Math.abs(dx) >= Math.abs(dz);
  const stepMajor = majorX ? Math.sign(ux) : Math.sign(uz);
  const minorOff = majorX ? uz : ux; // fractional offset along the minor axis
  const start = stepMajor > 0 ? n - 1 : 0;
  const end = stepMajor > 0 ? -1 : n;
  for (let a = start; a !== end; a -= stepMajor) {
    const up = a + stepMajor; // upstream line index (towards the sun)
    const hasUp = up >= 0 && up < n;
    for (let b = 0; b < n; b++) {
      const idx = majorX ? b * n + a : a * n + b;
      const hp = surf(idx);
      if (!hasUp) {
        S[idx] = hp;
        out[idx] = 255;
        continue;
      }
      const q = b + minorOff;
      let q0 = Math.floor(q);
      let f = q - q0;
      if (q0 < 0) {
        q0 = 0;
        f = 0;
      } else if (q0 >= n - 1) {
        q0 = n - 2;
        f = q0 === n - 2 && q >= n - 1 ? 1 : f;
      }
      const i0 = majorX ? q0 * n + up : up * n + q0;
      const i1 = majorX ? i0 + n : i0 + 1;
      const sUp = S[i0] + (S[i1] - S[i0]) * f - drop;
      if (sUp > hp) {
        S[idx] = sUp;
        const v = 1 - (sUp - hp) * inv;
        out[idx] = v <= 0 ? 0 : (v * 255) | 0;
      } else {
        S[idx] = hp;
        out[idx] = 255;
      }
    }
  }
}

/**
 * Surface texture (RGBA8, same resolution as the heightfield):
 *   R,G = normal.x / normal.z mapped to 0..255, B = √(clamp(depth / WATER_DEPTH_RANGE)) for water,
 *   A = sun visibility (pass the output of bakeSunVisibility, or null for fully lit).
 */
export function bakeSurface(hf: HfView, sunVis: Uint8Array | null, out: Uint8Array): void {
  const n = hf.n;
  const d = hf.data;
  const inv2c = 1 / (2 * hf.cell);
  for (let j = 0; j < n; j++) {
    const jm = j > 0 ? j - 1 : 0;
    const jp = j < n - 1 ? j + 1 : n - 1;
    for (let i = 0; i < n; i++) {
      const im = i > 0 ? i - 1 : 0;
      const ip = i < n - 1 ? i + 1 : n - 1;
      const k = j * n + i;
      const gx = (d[j * n + ip] - d[j * n + im]) * inv2c;
      const gz = (d[jp * n + i] - d[jm * n + i]) * inv2c;
      const il = 1 / Math.sqrt(gx * gx + 1 + gz * gz);
      const o = k * 4;
      out[o] = ((-gx * il * 0.5 + 0.5) * 255 + 0.5) | 0;
      out[o + 1] = ((-gz * il * 0.5 + 0.5) * 255 + 0.5) | 0;
      const h = d[k];
      out[o + 2] = h < 0 ? (Math.sqrt(Math.min(1, -h / WATER_DEPTH_RANGE)) * 254 + 1) | 0 : 0;
      out[o + 3] = sunVis ? sunVis[k] : 255;
    }
  }
}

/* ─────────────────────────────── Colour map ─────────────────────────────── */

type RGB = [number, number, number];
const hex = (v: number): RGB => [(v >> 16) & 255, (v >> 8) & 255, v & 255];

/** Auckland palette (sRGB). */
const PAL = {
  pasture: hex(0x62903f),
  pastureDry: hex(0x869c52),
  paddockA: hex(0x5d8c3a),
  paddockB: hex(0x86a24e),
  paddockC: hex(0x9cae62),
  bush: hex(0x2d4a27),
  bushLight: hex(0x3c5c30),
  pine: hex(0x223a2c),
  pineLight: hex(0x2c4733),
  pineForest: hex(0x233b2e),
  urban: hex(0x86837a),
  urbanGreen: hex(0x66705a),
  beach: hex(0xd2bf92),
  blackSand: hex(0x3e3c3a),
  lava: hex(0x45413a),
  lavaBush: hex(0x33492b),
  cone: hex(0x4a643a),
  clearing: hex(0x5e5646),
  rock: hex(0x6a655e),
  seabed: hex(0x8a8468),
  airfield: hex(0x7fa052),
  forest: hex(0x2f4c2a),
};

/** Farmland features' field patchwork (farmColor). */
const FIELDS: RGB[] = [hex(0x9aa45a), hex(0x7a9a44), hex(0xb0a26e), hex(0x8c7a52)];

function mix(out: RGB, a: RGB, b: RGB, t: number): void {
  if (t <= 0) {
    out[0] = a[0];
    out[1] = a[1];
    out[2] = a[2];
    return;
  }
  if (t >= 1) {
    out[0] = b[0];
    out[1] = b[1];
    out[2] = b[2];
    return;
  }
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
}

function blendInto(out: RGB, b: RGB, t: number): void {
  if (t <= 0) return;
  if (t > 1) t = 1;
  out[0] += (b[0] - out[0]) * t;
  out[1] += (b[1] - out[1]) * t;
  out[2] += (b[2] - out[2]) * t;
}

interface FeatureTint {
  f: SceneryFeature;
  fp: Footprint;
  reach: number;
  angle: number;
  seed: number;
}

export interface ColorBakeOptions {
  theater: TheaterId;
  seed: number;
  features: SceneryFeature[];
}

/**
 * Bake colour rows [j0, j1) of an m×m colour map (texel i ↔ hf sample i·(n/m)) into `out`
 * (RGBA8 band, row 0 = j0). A = forest density.
 */
export function bakeColorRows(hf: HfView, opts: ColorBakeOptions, m: number, j0: number, j1: number, out: Uint8Array): void {
  const { theater, seed } = opts;
  const stride = hf.n / m;
  const cellC = hf.cell * stride;
  const noise = new Noise2D(seed * 23 + 7);
  const veg = createVegetation(theater, seed, opts.features);
  const col: RGB = [0, 0, 0];
  const tmp: RGB = [0, 0, 0];
  const tints: FeatureTint[] = opts.features.map((f, i) => {
    const fp = footprintOf(f);
    const farm = f.type === 'farmland' ? fp.radius : 0;
    const belt = f.type === 'town' || f.type === 'city' || f.type === 'village' ? fp.radius * 2.6 + 1200 : 0;
    const reach = Math.max(footprintReach(fp), farm, belt) + 300;
    return { f, fp, reach, angle: hash2(i, 7, seed) * Math.PI, seed: (seed * 131 + i * 977) | 0 };
  });
  const p = PAL;

  for (let j = j0; j < j1; j++) {
    const hj = Math.min(hf.n - 1, Math.round(j * stride));
    const z = hf.origin + j * cellC;
    for (let i = 0; i < m; i++) {
      const hi = Math.min(hf.n - 1, Math.round(i * stride));
      const k = hj * hf.n + hi;
      const x = hf.origin + i * cellC;
      const h = hf.data[k];
      const mat = hf.mat[k];
      const aux = hf.aux[k] / 255;
      // slope from neighbours
      const d = hf.data;
      const n = hf.n;
      const gx = (d[hj * n + Math.min(n - 1, hi + 1)] - d[hj * n + Math.max(0, hi - 1)]) / (2 * hf.cell);
      const gz = (d[Math.min(n - 1, hj + 1) * n + hi] - d[Math.max(0, hj - 1) * n + hi]) / (2 * hf.cell);
      const slope = Math.sqrt(gx * gx + gz * gz);
      const n1 = noise.noise(x / 3100, z / 3100);
      const n2 = noise.noise(x / 780 + 5.1, z / 780 - 2.3);
      const v = n1 * 0.65 + n2 * 0.35; // -1..1 variation

      /* ── base ground colour ── */
      let urban = 0;
      if (h < 0) {
        // Never seen through the (opaque) water, except in the thin sunk strip the shaders
        // draw as shore: keep it a sandy/grassy shore tone rather than dark seabed.
        mix(col, p.beach, p.pasture, 0.35);
      } else {
        mix(col, p.pasture, p.pastureDry, sstep(-0.35, 0.55, v));
        // paddock patchwork on rural land
        const pu = Math.floor(x / 260 + 0.35 * n1);
        const pv = Math.floor(z / 190 - 0.35 * n1);
        const pr = hash2(pu, pv, seed);
        if (mat !== MAT_URBAN && mat !== MAT_VOLCANIC) blendInto(col, pr < 0.33 ? p.paddockA : pr < 0.66 ? p.paddockB : p.paddockC, 0.28 * sstep(0.05, 0.3, 0.3 - slope));
        switch (mat) {
          case MAT_URBAN:
            urban = aux;
            mix(tmp, p.urban, p.urbanGreen, sstep(-0.3, 0.6, n2) * (1 - aux * 0.6));
            blendInto(col, tmp, 0.35 + 0.65 * aux);
            break;
          case MAT_BUSH:
            mix(tmp, p.bush, p.bushLight, sstep(-0.3, 0.5, n2));
            blendInto(col, tmp, 0.5 + 0.5 * aux);
            break;
          case MAT_PINE:
            // plantation: darker, bluer and more even than the native bush
            mix(tmp, p.pine, p.pineLight, sstep(-0.2, 0.6, n2));
            blendInto(col, tmp, 0.45 + 0.55 * aux);
            break;
          case MAT_VOLCANIC:
            // Rangitoto: black basalt lava fields under pōhutukawa bush — no pasture underneath
            mix(col, p.lava, p.lavaBush, sstep(0.35, 0.75, aux + 0.12 * n2));
            break;
          case MAT_CONE: {
            // Grazed grass on the steeper upper slopes, trees / scrub and the suburbs' grey-green
            // on the gentler foot, broken up by a ~170 m noise: blended by slope instead of one
            // categorical colour, so a cone no longer ends in a hard bright-green disc edge.
            const nf = noise.noise(x / 170 + 3.3, z / 170 - 1.7);
            const steep = sstep(0.05, 0.28, slope + 0.07 * nf);
            mix(tmp, p.urbanGreen, p.bushLight, sstep(-0.35, 0.45, nf));
            mix(tmp, tmp, p.cone, steep);
            blendInto(col, tmp, 0.85 + 0.1 * steep);
            break;
          }
          case MAT_CLEARING:
            // levelled military pad: dry grass and gravel
            mix(tmp, p.clearing, p.pastureDry, sstep(-0.4, 0.6, n2));
            blendInto(col, tmp, 0.85);
            break;
          case MAT_BEACH:
            // the crisp 15 m beach band is painted by the terrain shader from the coast mask
            blendInto(col, hf.aux[k] > 128 ? p.blackSand : p.beach, 0.3 * (1 - sstep(3, 6, h)));
            break;
        }
      }

      /* ── features: urban ground, airfields, farmland belts ── */
      let clear = 0;
      let airfield = 0;
      if (h > 0) {
        for (let t = 0; t < tints.length; t++) {
          const ft = tints[t];
          const dx = x - ft.fp.x;
          const dz = z - ft.fp.z;
          if (Math.abs(dx) > ft.reach || Math.abs(dz) > ft.reach) continue;
          const type = ft.f.type;
          if (type === 'airbase') {
            const w = footprintWeight(ft.fp, x, z);
            if (w > 0) {
              // mown airfield grass over the levelled strip; suburbs / trees resume just outside it
              const core = sstep(0.55, 0.95, w);
              blendInto(col, p.airfield, core * (0.75 + 0.25 * n2));
              clear = Math.max(clear, core);
              airfield = Math.max(airfield, sstep(0.7, 0.95, w));
            }
            continue;
          }
          const dist = Math.hypot(dx, dz);
          if (type === 'town' || type === 'city' || type === 'village' || type === 'industrial' || type === 'port') {
            const r = ft.fp.radius * (0.9 + 0.25 * n2);
            const w = 1 - sstep(r * 0.55, r * 1.05, dist);
            if (w > 0) {
              blendInto(col, p.urban, w * (type === 'village' ? 0.55 : 0.85));
              clear = Math.max(clear, w);
              if (type !== 'port' && type !== 'industrial') urban = Math.max(urban, w * (type === 'city' ? 1 : type === 'town' ? 0.75 : 0.45));
            }
          }
          // Farmland: explicit farmland features + belts around settlements
          let farmW = 0;
          if (type === 'farmland') farmW = 1 - sstep(ft.fp.radius * 0.75, ft.fp.radius * 1.05, dist + n1 * 500);
          else if (type === 'town' || type === 'city' || type === 'village') {
            const r0 = ft.fp.radius * 0.9;
            const r1 = ft.fp.radius * 2.6 + 1000;
            farmW = sstep(r0, r0 + 300, dist) * (1 - sstep(r1 * 0.7, r1, dist + n1 * 600)) * 0.9;
          }
          if (farmW > 0 && slopeOk(slope) && h > 1.5) {
            farmColor(tmp, x - ft.fp.x, z - ft.fp.z, ft.angle, ft.seed);
            blendInto(col, tmp, farmW * (1 - sstep(0.12, 0.25, slope)));
          }
        }
      }

      /* ── forest tint; A packs forest density (0..127) or urban density (128..255) ── */
      let forest = h > 0 ? veg.density(x, z, h, slope, mat, hf.aux[k]) : 0;
      if (clear > 0) forest *= 1 - clear;
      urban *= 1 - airfield; // no suburbs on the airfield
      if (urban > 0.05) forest = 0;
      if (forest > 0.02) blendInto(col, mat === MAT_PINE ? p.pineForest : p.forest, forest * 0.8);

      // Subtle large-scale brightness variation keeps the map from looking flat
      const bright = 1 + 0.06 * n1;
      const o = (j - j0) * m * 4 + i * 4;
      out[o] = clampByte(col[0] * bright);
      out[o + 1] = clampByte(col[1] * bright);
      out[o + 2] = clampByte(col[2] * bright);
      out[o + 3] = urban > 0.05 ? 128 + clampByte(urban * 127) : clampByte(forest * 127);
    }
  }
}

function slopeOk(slope: number): boolean {
  return slope < 0.3;
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/** Field patchwork of a farmland feature (local frame rotated by `angle`). */
function farmColor(out: RGB, lx: number, lz: number, angle: number, seed: number): void {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const u = lx * c + lz * s;
  const v = -lx * s + lz * c;
  const fu = Math.floor(u / 330);
  const fv = Math.floor(v / (190 + 120 * hash2(fu, 3, seed)));
  const r = hash2(fu, fv, seed);
  const a = FIELDS[(r * 4) | 0];
  out[0] = a[0];
  out[1] = a[1];
  out[2] = a[2];
}

/**
 * Water texels are never seen through the opaque water, except in the thin strip along the shore
 * where the shaders draw the exact (15 m) coastline over the 86 m colour map. Give them the colour
 * of the nearest land texel (two 3×3 dilation passes ≈ 170 m) so that strip continues the land
 * (dark lava on Rangitoto, suburbs, bush) instead of a uniform sandy fringe. `heights` is an m × m
 * view of the heightfield (same layout as the colour map). In place.
 */
export function dilateLandColour(rgba: Uint8Array, heights: Float32Array, m: number, passes = 2): void {
  const land = new Uint8Array(m * m);
  for (let k = 0; k < m * m; k++) land[k] = heights[k] > 0 ? 1 : 0;
  const next = new Uint8Array(m * m);
  for (let pass = 0; pass < passes; pass++) {
    next.set(land);
    for (let j = 0; j < m; j++) {
      for (let i = 0; i < m; i++) {
        const k = j * m + i;
        if (land[k]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= m) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= m || !land[jj * m + ii]) continue;
            const o = (jj * m + ii) * 4;
            r += rgba[o];
            g += rgba[o + 1];
            b += rgba[o + 2];
            n++;
          }
        }
        if (!n) continue;
        const o = k * 4;
        rgba[o] = r / n;
        rgba[o + 1] = g / n;
        rgba[o + 2] = b / n;
        next[k] = 1;
      }
    }
    land.set(next);
  }
}

/** Airbase grass/sand strip is also used by scenery; re-exported for convenience. */
export { AIRBASE };
