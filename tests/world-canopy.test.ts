/**
 * Real suburbs 4/9 (#123): the real tree canopy from the 2024 LiDAR (src/world/terrain/data/auckland-canopy.bin,
 * tools/linz/canopy.py + canopy.ts), grown by the tree scatter and read by the terrain shader.
 */
import { describe, expect, it } from 'vitest';
import { CANOPY_GZ, canopyBytes } from './linz-setup';
import AREAS from './fixtures/linz-canopy-areas.json';
import {
  CANOPY_GPU_LEVELS,
  CANOPY_GPU_NONE,
  CANOPY_LEVELS,
  canopyAt,
  canopyHeightAt,
  canopyPyramid,
  decodeCanopy,
  decodeHeights,
  decodeShares,
  encodeCanopy,
  encodeHeights,
  encodeShares,
  setAucklandCanopy,
  aucklandCanopy,
} from '../src/world/terrain/theaters/aucklandCanopy';
import { ColorMapSampler, TreeSource, type CanopyTrees } from '../src/world/scenery/sources';
import { REC, type TileInstances } from '../src/world/scenery/scatter';
import { createFoliageMaterial } from '../src/world/scenery/materials';
import type { AtmosphereUniforms } from '../src/world/sky/atmosphere';
import { pointInRing } from '../src/world/scenery/cbdStreets';
import { aucklandHouses, housesIn } from '../src/world/scenery/aucklandHouses';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { allFeatures } from '../src/world/scenery/Scenery';
import { bakeColorRows } from '../src/world/terrain/bake';
import { reduceView } from '../src/world/terrain/parallel';
import { createVegetation } from '../src/world/terrain/vegetation';
import { AKL_CBD_GRID } from '../src/world/config';
import { aucklandLandUse } from '../src/world/scenery/aucklandLandUse';

interface Area {
  key: string;
  kind: 'suburb' | 'island';
  land: number;
  share: number;
  rings: number[][];
}
const areas = AREAS as Area[];
const area = (k: string) => areas.find((a) => a.key === k)!;
const inArea = (a: Area, x: number, z: number) => a.rings.some((r) => pointInRing(r, x, z));
/** The x intervals of the area's rings on the row z (even-odd), for sampling a big island quickly. */
const rowSpans = (a: Area, z: number): number[] => {
  const xs: number[] = [];
  for (const r of a.rings)
    for (let i = 0, n = r.length; i < n; i += 2) {
      const j = (i + 2) % n;
      const z0 = r[i + 1], z1 = r[j + 1];
      if (z0 <= z !== z1 <= z) xs.push(r[i] + ((z - z0) / (z1 - z0)) * (r[j] - r[i]));
    }
  return xs.sort((p, q) => p - q);
};
const bbox = (a: Area) => {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const r of a.rings)
    for (let i = 0; i < r.length; i += 2) {
      x0 = Math.min(x0, r[i]);
      x1 = Math.max(x1, r[i]);
      z0 = Math.min(z0, r[i + 1]);
      z1 = Math.max(z1, r[i + 1]);
    }
  return [x0, z0, x1, z1] as const;
};

setAucklandCanopy(canopyBytes());
const c = aucklandCanopy()!;

/** Margins (absolute share): the shipped grid against the LiDAR, and the scatter's crowns against the LiDAR. */
const GRID_MARGIN = 0.02;
const CROWN_MARGIN = 0.05;
/** gzip budget of the file (#123 estimated 100–250 kB). */
const BUDGET = 260_000;

describe('real tree canopy data (auckland-canopy.bin)', () => {
  it('holds the suburbs and the islands in a 32 m grid on the land-use lattice, within its size budget', () => {
    expect(CANOPY_GZ.length).toBeLessThan(BUDGET);
    expect(c.cell).toBe(32);
    expect(((c.x0 + 40000) / 16) % 1).toBe(0);
    expect(((c.z0 + 40000) / 16) % 1).toBe(0);
    expect(c.levels).toBe(CANOPY_LEVELS);
    expect(c.hcell).toBe(4);
    // every test area covered
    for (const a of areas) {
      const [x0, z0, x1, z1] = bbox(a);
      let n = 0, cov = 0;
      for (let z = z0 + 8; z < z1; z += 64)
        for (let x = x0 + 8; x < x1; x += 64) {
          if (!inArea(a, x, z)) continue;
          n++;
          if (canopyAt(c, x, z) >= 0) cov++;
        }
      expect(cov / n, a.key).toBeGreaterThan(0.97);
    }
    // the open sea and the Waitākere Ranges are not (the Topo50 cover stays there)
    expect(canopyAt(c, 0, -30000)).toBe(-1);
    expect(canopyAt(c, -25000, 6000)).toBe(-1);
  });

  it('round-trips through its range coder', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const cols = 97, rows = 61;
    const v = new Uint8Array(cols * rows);
    for (let k = 0; k < v.length; k++) v[k] = rnd() < 0.2 ? CANOPY_LEVELS : Math.floor(rnd() ** 2 * CANOPY_LEVELS);
    expect(Array.from(decodeShares(encodeShares(v, cols, rows, CANOPY_LEVELS), 0, cols, rows, CANOPY_LEVELS))).toEqual(Array.from(v));
    const h = new Uint8Array(500).map(() => Math.floor(rnd() * 40));
    expect(Array.from(decodeHeights(encodeHeights(h, 25), 0, h.length, 25))).toEqual(Array.from(h));
    const back = decodeCanopy(encodeCanopy(c));
    expect(back.share.length).toBe(c.share.length);
    for (let k = 0; k < c.share.length; k += 997) expect(back.share[k]).toBe(c.share[k]);
  });

  it('per suburb and per island, the grid holds the LiDAR canopy share', () => {
    const table: string[] = [];
    for (const a of areas) {
      const [x0, z0, x1, z1] = bbox(a);
      let sum = 0, n = 0;
      for (let z = Math.floor((z0 - c.z0) / c.cell) * c.cell + c.z0 + c.cell / 2; z < z1; z += c.cell)
        for (let x = Math.floor((x0 - c.x0) / c.cell) * c.cell + c.x0 + c.cell / 2; x < x1; x += c.cell) {
          if (!inArea(a, x, z)) continue;
          const s = canopyAt(c, x, z);
          if (s < 0) continue;
          sum += s;
          n++;
        }
      const grid = sum / n;
      table.push(`${a.key}: LiDAR ${(a.share * 100).toFixed(1)} %, grid ${(grid * 100).toFixed(1)} %`);
      expect(Math.abs(grid - a.share), a.key).toBeLessThan(GRID_MARGIN);
    }
    console.log(table.join('\n'));
    // the suburbs differ as the real ones do: old leafy Devonport and Mt Albert over new Hobsonville and bare Māngere
    expect(area('devonport').share).toBeGreaterThan(area('mangere').share + 0.05);
    expect(area('mt_albert').share).toBeGreaterThan(area('mangere').share + 0.05);
    // Rangitoto's pōhutukawa forest over Motutapu's farmland
    expect(area('rangitoto').share).toBeGreaterThan(area('motutapu').share + 0.2);
  });

  it("Rangitoto is forest on bare lava, not a uniform cover: patches of both at 32 m, its trees lower than the suburbs'", () => {
    const a = area('rangitoto');
    const [x0, z0, x1, z1] = bbox(a);
    let n = 0, bare = 0, dense = 0, hs = 0, hn = 0;
    for (let z = z0 + 16; z < z1; z += 32)
      for (let x = x0 + 16; x < x1; x += 32) {
        if (!inArea(a, x, z)) continue;
        const s = canopyAt(c, x, z);
        if (s < 0) continue;
        n++;
        if (s < 0.15) bare++;
        if (s > 0.75) dense++;
        const h = canopyHeightAt(c, x, z);
        if (h > 0) {
          hs += h;
          hn++;
        }
      }
    expect(bare / n).toBeGreaterThan(0.1);
    expect(dense / n).toBeGreaterThan(0.25);
    expect(hs / hn).toBeLessThan(12);
  });

  it('the shader pyramid: 32 m to 256 m box averages, packed below the land use within a phone texture', () => {
    const { bytes, levels } = canopyPyramid(c);
    expect(levels.length).toBe(CANOPY_GPU_LEVELS);
    expect(levels.map((l) => l.cell)).toEqual([32, 64, 128, 256]);
    // level 0 is the file's own cells; level 1 the mean of their 2 × 2 covered cells
    const L = levels[1];
    let checked = 0;
    for (let t = 0; t < L.cols * L.rows && checked < 200; t += 1999) {
      const i = t % L.cols, j = Math.floor(t / L.cols);
      let s = 0, k = 0;
      for (let dj = 0; dj < 2; dj++)
        for (let di = 0; di < 2; di++) {
          const v = canopyAt(c, c.x0 + (2 * i + di + 0.5) * c.cell, c.z0 + (2 * j + dj + 0.5) * c.cell);
          if (v >= 0) {
            s += v;
            k++;
          }
        }
      const b = bytes[L.offset + t];
      if (k >= 2) expect(Math.abs(b / 250 - s / k)).toBeLessThan(0.005);
      else expect(b).toBe(CANOPY_GPU_NONE);
      checked++;
    }
    const lu = aucklandLandUse();
    const texW = lu ? lu.texW : 1024;
    const rows = (lu ? lu.texH : 0) + Math.ceil(bytes.length / (texW * 4));
    expect(rows).toBeLessThanOrEqual(4096);
  });
});

describe('the tree scatter grows the real canopy', () => {
  const SEED = 1840;
  const features = allFeatures('auckland', []);
  const hf = runSync(generateTerrain({ theater: 'auckland', seed: SEED, resolution: 1024, features, pads: [] }));
  const m = 512;
  const color = new Uint8Array(m * m * 4);
  bakeColorRows(reduceView(hf, m), { theater: 'auckland', seed: SEED, features }, m, 0, m, color);
  const cmap = new ColorMapSampler(color, m, hf.origin, hf.extent);
  const veg = createVegetation('auckland', SEED, features);
  const houses = aucklandHouses();
  const canopy: CanopyTrees = { grid: c, blocked: null, houses, lotMask: null };
  // as Scenery builds it on the medium and high tiers: the photo keeps the procedural trees off, not the canopy's
  const photo = () => true;
  const src = new TreeSource(hf, cmap, veg, 'auckland', SEED, 14, photo, AKL_CBD_GRID, null, null, null, null, canopy);
  const grow = (x0: number, z0: number, x1: number, z1: number) => {
    const trees: number[] = [];
    for (let tz = Math.floor(z0 / 400) * 400; tz < z1; tz += 400)
      for (let tx = Math.floor(x0 / 400) * 400; tx < x1; tx += 400) {
        const out: TileInstances = { data: [[], [], []] };
        src.generate(tx, tz, 400, out);
        for (const arr of out.data) for (let i = 0; i < arr.length; i += REC) trees.push(arr[i], arr[i + 2], arr[i + 4] / 2);
      }
    return trees;
  };
  /** Share of the area's land (game terrain) under the crowns, sampled every `step` m. */
  const crownCover = (a: Area, trees: number[], step: number) => {
    const B = 32;
    const cells = new Map<number, number[]>();
    for (let t = 0; t < trees.length; t += 3) {
      const r = trees[t + 2];
      for (let j = Math.floor((trees[t + 1] - r) / B); j <= Math.floor((trees[t + 1] + r) / B); j++)
        for (let i = Math.floor((trees[t] - r) / B); i <= Math.floor((trees[t] + r) / B); i++) {
          const k = (i + 4096) * 8192 + (j + 4096);
          const l = cells.get(k);
          if (l) l.push(t);
          else cells.set(k, [t]);
        }
    }
    const [x0, z0, , z1] = bbox(a);
    let land = 0, under = 0;
    for (let z = z0 + step / 2; z < z1; z += step) {
      const sp = rowSpans(a, z);
      for (let k = 0; k + 1 < sp.length; k += 2)
        for (let x = Math.ceil((sp[k] - x0 - step / 2) / step) * step + x0 + step / 2; x < sp[k + 1]; x += step) {
          if (hf.heightAt(x, z) < 0.6 || canopyAt(c, x, z) < 0) continue;
        land++;
        const l = cells.get((Math.floor(x / B) + 4096) * 8192 + (Math.floor(z / B) + 4096));
          if (l && l.some((t) => (trees[t] - x) ** 2 + (trees[t + 1] - z) ** 2 < trees[t + 2] ** 2)) under++;
        }
    }
    return under / land;
  };

  it('per suburb and per island, its crowns cover the land as the LiDAR canopy does', () => {
    const table: string[] = [];
    for (const a of areas) {
      const [x0, z0, x1, z1] = bbox(a);
      const trees = grow(x0, z0, x1, z1);
      const cover = crownCover(a, trees, a.kind === 'island' ? 6 : 3);
      table.push(`${a.key}: LiDAR ${(a.share * 100).toFixed(1)} %, crowns ${(cover * 100).toFixed(1)} % (${trees.length / 3} trees)`);
      expect(Math.abs(cover - a.share), a.key).toBeLessThan(CROWN_MARGIN);
    }
    console.log(table.join('\n'));
  }, 120_000);

  it('on the photo too (Rangitoto has trees again), with no trunk inside a real house', () => {
    const a = area('rangitoto');
    const [x0, z0] = bbox(a);
    const trees = grow(x0 + 2000, z0 + 2000, x0 + 2800, z0 + 2800);
    expect(trees.length / 3).toBeGreaterThan(500);
    // they are flagged for the photo's colour (record aux ≥ 1: the foliage shader tints them where the photo covers)
    const out: TileInstances = { data: [[], [], []] };
    src.generate(x0 + 2000, z0 + 2000, 400, out);
    for (const arr of out.data) for (let i = 0; i < arr.length; i += REC) expect(arr[i + 11]).toBeGreaterThanOrEqual(1);
    expect(createFoliageMaterial({} as AtmosphereUniforms, { uAerial: { value: null } }).defines.AERIAL).toBe('');
    expect(createFoliageMaterial({} as AtmosphereUniforms).defines.AERIAL).toBeUndefined();
    // Devonport village: the trees stand round the real houses, not in them
    const dv = grow(2400, -2400, 3600, -1200);
    expect(dv.length / 3).toBeGreaterThan(300);
    const idx: number[] = [];
    let inside = 0;
    for (let t = 0; t < dv.length; t += 3) {
      const x = dv[t], z = dv[t + 1];
      idx.length = 0;
      for (const k of housesIn(houses!, x - 16, z - 16, x + 16, z + 16, idx)) {
        const dx = x - houses!.x[k], dz = z - houses!.z[k];
        const co = Math.cos(houses!.dir[k]), si = Math.sin(houses!.dir[k]);
        if (Math.abs(dx * co + dz * si) < houses!.d[k] / 2 && Math.abs(-dx * si + dz * co) < houses!.w[k] / 2) inside++;
      }
    }
    expect(inside).toBe(0);
  });

  it('without the file (low tier, offline) the trees are as before', () => {
    const plain = new TreeSource(hf, cmap, veg, 'auckland', SEED, 14, null, AKL_CBD_GRID);
    const withNone = new TreeSource(hf, cmap, veg, 'auckland', SEED, 14, null, AKL_CBD_GRID, null, null, null, null, null);
    const a: TileInstances = { data: [[], [], []] };
    const b: TileInstances = { data: [[], [], []] };
    plain.generate(-4000, 4400, 400, a);
    withNone.generate(-4000, 4400, 400, b);
    expect(b.data).toEqual(a.data);
    expect(a.data.reduce((s, d) => s + d.length, 0)).toBeGreaterThan(0);
  });
});
