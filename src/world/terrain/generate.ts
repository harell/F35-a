/**
 * Deterministic heightfield generation (theatre style + seed + mission features/pads).
 *
 * Written as a generator that yields progress (0..1) so callers can either run it synchronously
 * (tests, `runSync`) or time-slice it on the main thread (`runSliced`) to keep the loading bar
 * animating on phones.
 *
 * Pipeline: theatre base terrain (≤1024², with a border fade to a smooth outside profile)
 *   → optional 2× Catmull-Rom upsample + fine detail (2048² on high quality): procedural octaves, or
 *     on Auckland with `spec.hdTerrain` a blend to the real 2048 LiDAR heights (aucklandLinzHd.ts)
 *   → keep feature/pad anchors dry → flatten features (airfields, towns…) and pads (SAM sites).
 */
import { Heightfield } from './Heightfield';
import { Noise2D, sstep, mixf } from './noise';
import { airfieldOf, anchorsFor, footprintCoreRadius, footprintOf, footprintReach, footprintWeight } from './features';
import { createDesert } from './theaters/desert';
import { createIslands } from './theaters/islands';
import { createMountains } from './theaters/mountains';
import { createArctic } from './theaters/arctic';
import { createAuckland } from './theaters/auckland';
import { runwaysOf } from '../../core/airfields';
import { aucklandLinz } from './theaters/aucklandLinz';
import { aucklandLinzHd, linzHdHeights, linzHdMatches } from './theaters/aucklandLinzHd';
import {
  EDGE_FADE_END,
  EDGE_FADE_START,
  HF_EXTENT,
  MAT_CLEARING,
  MAT_NONE,
  type Anchor,
  type Footprint,
  type SampleOut,
  type TerrainSpec,
  type TheaterGenerator,
} from './types';

export function createTheaterGenerator(spec: Pick<TerrainSpec, 'theater' | 'seed'>, anchors: Anchor[]): TheaterGenerator {
  switch (spec.theater) {
    case 'auckland':
      return createAuckland(spec.seed);
    case 'desert':
      return createDesert(spec.seed);
    case 'islands':
      return createIslands(spec.seed, anchors);
    case 'mountains':
      return createMountains(spec.seed);
    case 'arctic':
      return createArctic(spec.seed);
    default:
      return createAuckland(spec.seed);
  }
}

/** Rounded-square radius used for the border fade. */
export function edgeRadius(x: number, z: number): number {
  const ax = Math.abs(x);
  const az = Math.abs(z);
  const m = Math.max(ax, az);
  if (m < 1) return 0;
  const a = ax / m;
  const b = az / m;
  return m * Math.pow(a * a * a * a * a * a + b * b * b * b * b * b, 1 / 6);
}

export const BASE_MAX = 1024;

/** Inside max(|x|, |z|) < EDGE_SAFE the border fade is 0 (super-ellipse radius ≤ 2^(1/6)·max(|x|,|z|)). */
const EDGE_SAFE = EDGE_FADE_START / 1.1225;

/**
 * Fill rows [z0, z1) of an n×n base heightfield (HF_EXTENT wide) into band arrays. Shared by the
 * main-thread path and the generation workers.
 */
export function generateBaseRows(
  gen: TheaterGenerator,
  n: number,
  z0: number,
  z1: number,
  data: Float32Array,
  mat: Uint8Array,
  aux: Uint8Array,
): void {
  const cell = HF_EXTENT / n;
  const origin = -HF_EXTENT / 2;
  const out: SampleOut = { mat: 0, aux: 0 };
  for (let iz = z0; iz < z1; iz++) {
    const z = origin + iz * cell;
    const row = (iz - z0) * n;
    for (let ix = 0; ix < n; ix++) {
      const x = origin + ix * cell;
      const m = Math.max(Math.abs(x), Math.abs(z));
      const fade = m < EDGE_SAFE ? 0 : sstep(EDGE_FADE_START, EDGE_FADE_END, edgeRadius(x, z));
      let h: number;
      if (fade >= 1) {
        h = gen.edge(x, z);
        out.mat = MAT_NONE;
        out.aux = 0;
      } else {
        h = gen.height(x, z, out);
        if (fade > 0) {
          h = mixf(h, gen.edge(x, z), fade);
          if (fade > 0.5) out.mat = MAT_NONE;
        }
      }
      data[row + ix] = h;
      mat[row + ix] = out.mat;
      aux[row + ix] = out.aux;
    }
  }
}

export function* generateTerrain(spec: TerrainSpec): Generator<number, Heightfield, void> {
  const anchors = anchorsFor(spec.features, spec.pads);
  const gen = createTheaterGenerator(spec, anchors);
  const baseN = Math.min(BASE_MAX, spec.resolution);
  const base = new Heightfield(baseN, HF_EXTENT);
  const upsample = spec.resolution > baseN;
  const baseShare = upsample ? 0.72 : 0.88;

  // 1) Theatre base terrain with border fade.
  for (let iz = 0; iz < baseN; iz += 16) {
    const z1 = Math.min(baseN, iz + 16);
    generateBaseRows(gen, baseN, iz, z1, base.data.subarray(iz * baseN, z1 * baseN), base.mat.subarray(iz * baseN, z1 * baseN), base.aux.subarray(iz * baseN, z1 * baseN));
    yield (z1 / baseN) * baseShare;
  }

  return yield* finishTerrain(base, spec, anchors, baseShare);
}

/**
 * Steps after the theatre base: optional 2× upsample (+ detail), anchors kept dry, flattening.
 * Progress continues from `p0` to 1.
 */
export function* finishTerrain(base: Heightfield, spec: TerrainSpec, anchors: Anchor[], p0: number): Generator<number, Heightfield, void> {
  let hf = base;
  if (spec.resolution > base.n) {
    hf = new Heightfield(base.n * 2, HF_EXTENT);
    yield* upsample2x(base, hf, spec.seed, p0, 0.9, realDetail(spec, hf.n));
  }

  // 3) Keep anchors dry (features / pads never end up in the sea). Auckland's coast is mapped and its
  //    missions place everything on land: lifting there would grow aprons of land into the harbours.
  const mapped = spec.theater === 'auckland';
  if (!mapped) for (const a of anchors) liftAnchor(hf, a);
  yield 0.93;

  // 4) Flatten features, then pads (pads see the already flattened ground).
  for (const f of spec.features) {
    const fp = footprintOf(f);
    if (!fp.flatten) continue;
    const level = flatten(hf, fp, mapped);
    // A real airfield without its OSM outline (fallback): level its other runways (Whenuapai's cross
    // runway 08/26) to the same height as the main strip. The outline already covers them.
    const id = mapped && !fp.poly ? airfieldOf(f) : null;
    if (id) {
      for (const X of runwaysOf(id).slice(1)) {
        flatten(hf, { kind: 'rect', x: X.x, z: X.z, halfW: 70, halfL: X.length / 2 + 80, radius: 0, heading: X.heading, blend: 350, strength: 1, minLevel: 2, flatten: true }, mapped, MAT_NONE, level);
      }
    }
  }
  yield 0.97;
  for (const p of spec.pads) {
    flatten(hf, {
      kind: 'circle',
      x: p.x,
      z: p.z,
      halfW: 0,
      halfL: 0,
      radius: Math.max(20, p.radius),
      heading: 0,
      blend: Math.max(180, p.radius * 1.5),
      strength: 1,
      minLevel: 2,
      flatten: true,
    }, mapped, MAT_CLEARING);
  }
  yield 1;
  return hf;
}

/** The real Auckland n × n heights, when asked for, loaded and baked against the installed base grid. */
function realDetail(spec: TerrainSpec, n: number): Float32Array | null {
  if (spec.theater !== 'auckland' || !spec.hdTerrain) return null;
  const base = aucklandLinz();
  const hd = aucklandLinzHd();
  if (!base || !hd) return null;
  if (!linzHdMatches(hd, base, n)) {
    console.warn('[world] LINZ HD terrain does not match the installed 1024 grid, using procedural detail');
    return null;
  }
  return linzHdHeights(hd, base);
}

/** Land below this (m) keeps the base height's shore ramp: no real detail at the waterline. */
const REAL_SHORE_LO = 3;
/** Real detail at full strength above this height (m). */
const REAL_SHORE_HI = 12;

/**
 * 2× Catmull-Rom upsample of `src` into `dst` plus fine detail: two octaves of relief-scaled noise,
 * or with `real` (the real LiDAR heights at the dst samples) a blend to them. The blend weight rises
 * from REAL_SHORE_LO to REAL_SHORE_HI of upsampled height, so the shoreline and the base's
 * continuous shore ramp at the waterline stay put, while headlands inside the ramp (North Head)
 * still reach their real summits; it fades out with the border fade like the base terrain, and
 * never takes land below REAL_SHORE_LO.
 */
function* upsample2x(src: Heightfield, dst: Heightfield, seed: number, p0: number, p1: number, real: Float32Array | null = null): Generator<number, void, void> {
  const n = dst.n;
  const sn = src.n;
  const s = src.data;
  const d = dst.data;
  const noise = new Noise2D(seed * 31 + 9);
  const cr = (a: number, b: number, c: number, e: number) => (-a + 9 * b + 9 * c - e) * 0.0625;
  const at = (x: number, z: number) => s[(z < 0 ? 0 : z >= sn ? sn - 1 : z) * sn + (x < 0 ? 0 : x >= sn ? sn - 1 : x)];
  for (let iz = 0; iz < n; iz++) {
    const sz = iz >> 1;
    const oddZ = iz & 1;
    for (let ix = 0; ix < n; ix++) {
      const sx = ix >> 1;
      const oddX = ix & 1;
      let h: number;
      if (!oddX && !oddZ) h = at(sx, sz);
      else if (oddX && !oddZ) h = cr(at(sx - 1, sz), at(sx, sz), at(sx + 1, sz), at(sx + 2, sz));
      else if (!oddX && oddZ) h = cr(at(sx, sz - 1), at(sx, sz), at(sx, sz + 1), at(sx, sz + 2));
      else {
        const r0 = cr(at(sx - 1, sz - 1), at(sx, sz - 1), at(sx + 1, sz - 1), at(sx + 2, sz - 1));
        const r1 = cr(at(sx - 1, sz), at(sx, sz), at(sx + 1, sz), at(sx + 2, sz));
        const r2 = cr(at(sx - 1, sz + 1), at(sx, sz + 1), at(sx + 1, sz + 1), at(sx + 2, sz + 1));
        const r3 = cr(at(sx - 1, sz + 2), at(sx, sz + 2), at(sx + 1, sz + 2), at(sx + 2, sz + 2));
        h = cr(r0, r1, r2, r3);
      }
      const si = sz * sn + sx;
      if (real) {
        if (h > REAL_SHORE_LO) {
          const x = dst.pos(ix);
          const z = dst.pos(iz);
          const m = Math.max(Math.abs(x), Math.abs(z));
          const w = sstep(REAL_SHORE_LO, REAL_SHORE_HI, h) * (m < EDGE_SAFE ? 1 : 1 - sstep(EDGE_FADE_START, EDGE_FADE_END, edgeRadius(x, z)));
          h = Math.max(h + (real[iz * n + ix] - h) * w, REAL_SHORE_LO);
        }
      } else if (h > 2) {
        // Relief-scaled fine detail (none on flats / beaches so coastlines stay put)
        const gx = at(sx + 1, sz) - at(sx - 1, sz);
        const gz = at(sx, sz + 1) - at(sx, sz - 1);
        const slope = Math.sqrt(gx * gx + gz * gz) / (2 * src.cell);
        const amp = (1.5 + 16 * Math.min(1, slope * 1.6)) * sstep(2, 12, h);
        const x = dst.pos(ix);
        const z = dst.pos(iz);
        h += amp * (noise.noise(x / 190, z / 190) + 0.45 * noise.noise(x / 95 + 7.7, z / 95 - 3.1));
      }
      const di = iz * n + ix;
      d[di] = h;
      dst.mat[di] = src.mat[si];
      dst.aux[di] = src.aux[si];
    }
    if ((iz & 31) === 31) yield p0 + (iz / n) * (p1 - p0);
  }
}

/** Raise the ground around an anchor to at least a few metres above sea level. */
function liftAnchor(hf: Heightfield, a: Anchor): void {
  const reach = a.r + 2200;
  const i0 = Math.max(0, Math.floor((a.x - reach - hf.origin) / hf.cell));
  const i1 = Math.min(hf.n - 1, Math.ceil((a.x + reach - hf.origin) / hf.cell));
  const j0 = Math.max(0, Math.floor((a.z - reach - hf.origin) / hf.cell));
  const j1 = Math.min(hf.n - 1, Math.ceil((a.z + reach - hf.origin) / hf.cell));
  const target = a.port ? 3 : 6;
  for (let j = j0; j <= j1; j++) {
    const z = hf.pos(j);
    for (let i = i0; i <= i1; i++) {
      const x = hf.pos(i);
      const d = Math.hypot(x - a.x, z - a.z);
      const w = 1 - sstep(a.r, reach, d);
      if (w <= 0) continue;
      const k = j * hf.n + i;
      const h = hf.data[k];
      if (h < target) {
        hf.data[k] = mixf(h, target, w);
        if (w > 0.5) hf.mat[k] = MAT_NONE;
      }
    }
  }
}

/**
 * Blend terrain towards a flat level inside a footprint (target = mean core height). With
 * `keepCoast` (mapped coastline), the blend zone fades out over the first 4 m above sea level so the
 * shoreline is not pushed into the water, and samples below sea level are never raised (a footprint
 * reaching past the real shore must not grow land into the harbour). Samples levelled above 60 %
 * get material `mat`.
 */
export function flatten(hf: Heightfield, footprint: Footprint, keepCoast = false, mat = MAT_NONE, level?: number): number {
  // Grow the core by 1.5 cells so every grid cell touching the footprint is fully flat
  // (bilinear/triangle interpolation inside the footprint then returns exactly the target).
  const pad = hf.cell * 1.5;
  const fp: Footprint =
    footprint.kind === 'rect'
      ? { ...footprint, halfW: footprint.halfW + pad, halfL: footprint.halfL + pad }
      : { ...footprint, radius: footprint.radius + pad };
  // Target: mean height over the core (coarse sampling), clamped to the minimum level.
  let sum = 0;
  let cnt = 0;
  const coreR = footprintCoreRadius(fp);
  const step = Math.max(hf.cell, coreR / 12);
  for (let dz = -coreR; dz <= coreR; dz += step) {
    for (let dx = -coreR; dx <= coreR; dx += step) {
      const x = fp.x + dx;
      const z = fp.z + dz;
      if (footprintWeight(fp, x, z) >= fp.strength * 0.999) {
        sum += hf.heightAt(x, z);
        cnt++;
      }
    }
  }
  let target = level ?? (cnt > 0 ? sum / cnt : hf.heightAt(fp.x, fp.z));
  target = Math.max(target, fp.minLevel);

  const reach = footprintReach(fp);
  const i0 = Math.max(0, Math.floor((fp.x - reach - hf.origin) / hf.cell));
  const i1 = Math.min(hf.n - 1, Math.ceil((fp.x + reach - hf.origin) / hf.cell));
  const j0 = Math.max(0, Math.floor((fp.z - reach - hf.origin) / hf.cell));
  const j1 = Math.min(hf.n - 1, Math.ceil((fp.z + reach - hf.origin) / hf.cell));
  for (let j = j0; j <= j1; j++) {
    const z = hf.pos(j);
    for (let i = i0; i <= i1; i++) {
      let w = footprintWeight(fp, hf.pos(i), z);
      if (w <= 0) continue;
      const k = j * hf.n + i;
      if (keepCoast) {
        if (hf.data[k] < 0) continue;
        if (w < fp.strength) w *= sstep(0, 4, hf.data[k]);
      }
      hf.data[k] += (target - hf.data[k]) * w;
      // Material: special pads (clearings) only inside the original, unpadded core; mapped theatres
      // keep suburbs right up to the levelled core.
      if (mat !== MAT_NONE) {
        if (footprintWeight(footprint, hf.pos(i), z) >= footprint.strength * 0.999) hf.mat[k] = mat;
      } else if (w > (keepCoast ? 0.93 : 0.6)) hf.mat[k] = mat;
    }
  }
  return target;
}

/** Run a progress generator to completion synchronously. */
export function runSync<T>(g: Generator<number, T, void>): T {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}
