import { describe, expect, it } from 'vitest';
import { Heightfield } from '../src/world/terrain/Heightfield';
import { bakeColorRows, bakeSunVisibility, bakeSurface, WATER_DEPTH_RANGE } from '../src/world/terrain/bake';
import { buildHeightMips } from '../src/world/terrain/TerrainRenderer';
import { reduceView } from '../src/world/terrain/parallel';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { districtAt, hash12, toLocal, toWorld, lotInset } from '../src/world/scenery/urbanGrid';
import { ColorMapSampler, HouseSource, TreeSource } from '../src/world/scenery/sources';
import { createVegetation } from '../src/world/terrain/vegetation';
import { allFeatures } from '../src/world/scenery/Scenery';
import { mulberry32 } from '../src/core/math';
import { mulberry32 as localRng } from '../src/world/terrain/noise';

function flat(n = 64, h = 10): Heightfield {
  const hf = new Heightfield(n, 88_000);
  hf.data.fill(h);
  return hf;
}

describe('terrain bakers', () => {
  it('sun visibility: flat ground fully lit, a wall shadows its lee side', () => {
    const hf = flat(64, 0);
    const vis = new Uint8Array(64 * 64);
    const sun = { x: 1, y: 0.2, z: 0 }; // low sun from +X
    bakeSunVisibility(hf, sun, vis);
    expect(Math.min(...vis)).toBe(255);
    // 1000 m wall at column 40 (cells are 1375 m) → a 5 km shadow west of it (towards −X)
    for (let j = 0; j < 64; j++) hf.data[j * 64 + 40] = 1000;
    bakeSunVisibility(hf, sun, vis);
    expect(vis[32 * 64 + 39]).toBe(0); // just behind the wall
    expect(vis[32 * 64 + 37]).toBe(0);
    expect(vis[32 * 64 + 45]).toBe(255); // sun side
    expect(vis[32 * 64 + 20]).toBe(255); // beyond the shadow
  });

  it('surface texture encodes normals and water depth', () => {
    const hf = flat(32, -24);
    const out = new Uint8Array(32 * 32 * 4);
    bakeSurface(hf, null, out);
    const k = (16 * 32 + 16) * 4;
    expect(Math.abs(out[k] - 128)).toBeLessThanOrEqual(1); // flat → normal.x ≈ 0
    const depth = ((out[k + 2] - 1) / 254) ** 2 * WATER_DEPTH_RANGE;
    expect(depth).toBeCloseTo(24, 0);
    expect(out[k + 3]).toBe(255);
  });

  it('height mips are corner aligned and filtered', () => {
    const hf = flat(16, 5);
    const mips = buildHeightMips(hf);
    expect(mips.map((m) => m.width)).toEqual([16, 8, 4, 2, 1]);
    for (const m of mips) for (const v of m.data) expect(v).toBeCloseTo(5, 5);
  });

  it('colour map: Auckland CBD is urban, Waitākere is forest, reduced views match', () => {
    const features = allFeatures('auckland', []);
    const hf = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 256, features, pads: [] }));
    const m = 128;
    const out = new Uint8Array(m * m * 4);
    const view = reduceView(hf, m);
    bakeColorRows(view, { theater: 'auckland', seed: 1840, features }, m, 0, m, out);
    const cmap = new ColorMapSampler(out, m, hf.origin, hf.extent);
    expect(cmap.urban(500, 1500)).toBeGreaterThan(0.3); // Newmarket / Grafton
    expect(cmap.forest(-20_000, 9000)).toBeGreaterThan(0.2); // Waitākere bush
    expect(cmap.urban(-20_000, 9000)).toBe(0);
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('urban grid replica', () => {
  it('hash12 is deterministic and uniform-ish in [0, 1)', () => {
    let sum = 0;
    for (let i = 0; i < 2000; i++) {
      const h = hash12(i * 1.7, i * 0.3 - 50);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
      expect(hash12(i * 1.7, i * 0.3 - 50)).toBe(h);
      sum += h;
    }
    expect(sum / 2000).toBeGreaterThan(0.4);
    expect(sum / 2000).toBeLessThan(0.6);
  });

  it('district frames are orthonormal and invertible', () => {
    const rnd = mulberry32(3);
    for (let i = 0; i < 200; i++) {
      const x = (rnd() - 0.5) * 60_000;
      const z = (rnd() - 0.5) * 60_000;
      const d = districtAt(x, z);
      const [px, pz] = toLocal(d, x, z);
      const [wx, wz] = toWorld(d, px, pz);
      expect(wx).toBeCloseTo(x, 6);
      expect(wz).toBeCloseTo(z, 6);
      expect(d.border).toBeGreaterThanOrEqual(0);
    }
    const [ix, iz] = lotInset(0.5);
    expect(ix).toBeGreaterThan(0.05);
    expect(iz).toBeGreaterThan(ix);
  });

  it('terrain PRNG matches core/math mulberry32', () => {
    const a = mulberry32(99);
    const b = localRng(99);
    for (let i = 0; i < 100; i++) expect(b()).toBe(a());
  });
});

describe('scatter sources', () => {
  const features = allFeatures('auckland', []);
  const hf = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 512, features, pads: [] }));
  const m = 256;
  const out = new Uint8Array(m * m * 4);
  bakeColorRows(reduceView(hf, m), { theater: 'auckland', seed: 1840, features }, m, 0, m, out);
  const cmap = new ColorMapSampler(out, m, hf.origin, hf.extent);

  it('houses sit on built-up land at ground level, deterministically', () => {
    const src = new HouseSource(hf, cmap);
    const a = { data: [[], []] as number[][] };
    const b = { data: [[], []] as number[][] };
    src.generate(1200, 2200, 300, a); // Newmarket
    src.generate(1200, 2200, 300, b);
    expect(a.data[0].length + a.data[1].length).toBeGreaterThan(11 * 20);
    expect(a.data).toEqual(b.data);
    for (const arr of a.data) {
      for (let i = 0; i < arr.length; i += 11) {
        const [x, y, z] = [arr[i], arr[i + 1], arr[i + 2]];
        expect(x).toBeGreaterThanOrEqual(1200);
        expect(x).toBeLessThan(1500);
        expect(Math.abs(y + 1.2 - hf.meshHeightAt(x, z))).toBeLessThan(0.01);
        expect(hf.heightAt(x, z)).toBeGreaterThan(0.5);
      }
    }
    // none in the sea
    const sea = { data: [[], []] as number[][] };
    src.generate(20_000, -20_000, 300, sea);
    expect(sea.data[0].length + sea.data[1].length).toBe(0);
  });

  it('trees grow in the Waitākere bush, not in the sea', () => {
    const veg = createVegetation('auckland', 1840, features);
    const src = new TreeSource(hf, cmap, veg, 'auckland', 1840);
    const bush = { data: [[], [], []] as number[][] };
    src.generate(-20_000, 9000, 400, bush);
    const n = bush.data.reduce((s, a) => s + a.length / 11, 0);
    expect(n).toBeGreaterThan(50);
    const sea = { data: [[], [], []] as number[][] };
    src.generate(20_000, -20_000, 400, sea);
    expect(sea.data.reduce((s, a) => s + a.length, 0)).toBe(0);
  });
});
