/**
 * Real 2048² terrain detail for the high quality tier (src/world/terrain/theaters/aucklandLinzHd.ts,
 * src/world/terrain/data/auckland-linz-hd.bin baked by tools/linz/bake.py).
 *
 *  - the shipped file decodes and matches the shipped 1024 grid; stale / malformed data is rejected
 *  - high tier: cone summits within 5 % of the LiDAR maxima (AKL_CONES / AKL_RANGITOTO heights come
 *    from tools/linz/cones.py), where the procedural upsample left them up to 27 % low
 *  - no procedural noise on land: the 2048 field is seed-independent wherever the base is, and equals
 *    the Catmull-Rom upsample + the real residual
 *  - only the high tier (and only with the setting on) asks for the data; the service worker never
 *    precaches it
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finishTerrain, generateTerrain, runSync } from '../src/world/terrain/generate';
import { Heightfield } from '../src/world/terrain/Heightfield';
import { HF_EXTENT, type TerrainSpec } from '../src/world/terrain/types';
import { aucklandLinz } from '../src/world/terrain/theaters/aucklandLinz';
import { aucklandLinzHd, decodeLinzHd, linzHdMatches, loadAucklandLinzHd, setAucklandLinzHd, LINZ_HD_URL } from '../src/world/terrain/theaters/aucklandLinzHd';
import { AKL_CONES, AKL_RANGITOTO } from '../src/world/terrain/theaters/aucklandMap';
import { QUALITY_PRESETS, DEFAULT_SETTINGS } from '../src/core/data';
import { worldConfig } from '../src/world/config';
import sw from '../public/sw.js?raw';

interface Fs {
  readFileSync(p: URL): Uint8Array;
}
interface Zlib {
  gunzipSync(b: Uint8Array): Uint8Array;
}
const fs = (await import(/* @vite-ignore */ 'node:fs' as string)) as Fs;
const zlib = (await import(/* @vite-ignore */ 'node:zlib' as string)) as Zlib;
const HD_GZ = new Uint8Array(fs.readFileSync(new URL('../src/world/terrain/data/auckland-linz-hd.bin', import.meta.url)));
const HD_BYTES = new Uint8Array(zlib.gunzipSync(HD_GZ));

const spec = (seed: number, hdTerrain: boolean): TerrainSpec => ({ theater: 'auckland', seed, resolution: 2048, features: [], pads: [], hdTerrain });

/** Highest sample within `r` m of (x, z). */
function maxNear(hf: Heightfield, x: number, z: number, r: number): number {
  let m = -Infinity;
  const i0 = Math.floor((x - r - hf.origin) / hf.cell);
  const i1 = Math.ceil((x + r - hf.origin) / hf.cell);
  const j0 = Math.floor((z - r - hf.origin) / hf.cell);
  const j1 = Math.ceil((z + r - hf.origin) / hf.cell);
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (Math.hypot(hf.pos(i) - x, hf.pos(j) - z) <= r) m = Math.max(m, hf.data[j * hf.n + i]);
  return m;
}

/** 2× Catmull-Rom upsample of an sn × sn grid at fine sample (ix, iz), as generate.ts / bake.py do it. */
function upsampled(s: Float32Array, sn: number, ix: number, iz: number): number {
  const at = (x: number, z: number) => s[Math.min(sn - 1, Math.max(0, z)) * sn + Math.min(sn - 1, Math.max(0, x))];
  const cr = (a: number, b: number, c: number, e: number) => (-a + 9 * b + 9 * c - e) * 0.0625;
  const sx = ix >> 1;
  const row = (z: number) => (ix & 1 ? cr(at(sx - 1, z), at(sx, z), at(sx + 1, z), at(sx + 2, z)) : at(sx, z));
  const sz = iz >> 1;
  return iz & 1 ? cr(row(sz - 1), row(sz), row(sz + 1), row(sz + 2)) : row(sz);
}

const CONES = [
  ...AKL_CONES.map((c) => ({ x: c.x * 1000, z: c.z * 1000, h: c.h, r: Math.min(450, c.r) })),
  { x: AKL_RANGITOTO.x * 1000, z: AKL_RANGITOTO.z * 1000, h: AKL_RANGITOTO.h, r: 700 },
];

describe('LINZ HD terrain data', () => {
  it('decodes the shipped file and matches the shipped 1024 grid', () => {
    const t0 = performance.now();
    const hd = decodeLinzHd(HD_BYTES);
    const ms = performance.now() - t0;
    expect(hd.n).toBe(2048);
    expect(hd.baseN).toBe(1024);
    expect(hd.extent).toBe(HF_EXTENT);
    expect(hd.quantum).toBe(0.5);
    expect(linzHdMatches(hd, aucklandLinz()!, 2048)).toBe(true);
    // compact download, real detail (not a zero field)
    expect(HD_GZ.length).toBeLessThan(1_400_000);
    let nz = 0;
    for (let k = 0; k < hd.residual.length; k++) if (hd.residual[k] !== 0) nz++;
    expect(nz / hd.residual.length).toBeGreaterThan(0.2);
    expect(ms).toBeLessThan(1000);
  });

  it('rejects malformed data and data baked against another 1024 grid', () => {
    const bad = HD_BYTES.slice();
    bad[0] = 0x41 + 25;
    expect(() => decodeLinzHd(bad)).toThrow();
    expect(() => decodeLinzHd(HD_BYTES.subarray(0, HD_BYTES.length - 1))).toThrow();
    const hd = decodeLinzHd(HD_BYTES);
    expect(linzHdMatches({ ...hd, baseHash: hd.baseHash ^ 1 }, aucklandLinz()!, 2048)).toBe(false);
    expect(linzHdMatches(hd, aucklandLinz()!, 1024)).toBe(false);
  });
});

describe('high tier generation with the real 2048 detail', () => {
  let base1024: Heightfield;
  let real: Heightfield;
  let proc: Heightfield;
  let realMs = 0;
  let procMs = 0;
  beforeAll(() => {
    setAucklandLinzHd(HD_BYTES);
    // shared base (the workers' output), finished both ways
    base1024 = runSync(generateTerrain({ ...spec(1840, false), resolution: 1024 }));
    const copy = () => {
      const b = new Heightfield(1024, HF_EXTENT);
      b.data.set(base1024.data);
      b.mat.set(base1024.mat);
      b.aux.set(base1024.aux);
      return b;
    };
    let t = performance.now();
    real = runSync(finishTerrain(copy(), spec(1840, true), [], 0));
    realMs = performance.now() - t;
    t = performance.now();
    proc = runSync(finishTerrain(copy(), spec(1840, false), [], 0));
    procMs = performance.now() - t;
  }, 120_000);
  afterAll(() => setAucklandLinzHd(null));

  it('cone summits are within 5 % of the LiDAR maxima (the procedural upsample misses by up to 27 %)', () => {
    let worstProc = 0;
    for (const c of CONES) {
      const h = maxNear(real, c.x, c.z, c.r);
      expect(Math.abs(h - c.h) / c.h, `cone at ${c.x}, ${c.z}: ${h.toFixed(1)} m vs LiDAR ${c.h} m`).toBeLessThan(0.05);
      worstProc = Math.max(worstProc, Math.abs(maxNear(proc, c.x, c.z, c.r) - c.h) / c.h);
    }
    expect(worstProc).toBeGreaterThan(0.1);
  });

  it('inland heights are the real 2048 LiDAR grid (no procedural noise)', () => {
    const hd = aucklandLinzHd()!;
    const linz = aucklandLinz()!;
    const n = real.n;
    let checked = 0;
    let noisy = 0;
    for (let iz = 0; iz < n; iz += 5) {
      for (let ix = 0; ix < n; ix += 5) {
        if (Math.max(Math.abs(real.pos(ix)), Math.abs(real.pos(iz))) > 34_000) continue; // border fade
        const k = iz * n + ix;
        const h = upsampled(base1024.data, 1024, ix, iz);
        if (h < 12) continue; // full-strength real detail
        // the real 2048 grid, independently reconstructed from the 1024 LiDAR grid + the residual
        expect(real.data[k]).toBeCloseTo(Math.max(3, upsampled(linz.heights, 1024, ix, iz) + hd.residual[k] * hd.quantum), 3);
        if (Math.abs(proc.data[k] - h) > 0.25) noisy++;
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(5000);
    expect(noisy / checked).toBeGreaterThan(0.5); // what the procedural path added instead
  });

  it('is seed-independent wherever the base is (no seeded noise); the procedural detail is not', () => {
    // The base's shore ramp is seeded, so compare only samples whose 4 × 4 base stencil is identical.
    const base7 = runSync(generateTerrain({ ...spec(7, false), resolution: 1024 }));
    const fin = (hd: boolean) => {
      const b = new Heightfield(1024, HF_EXTENT);
      b.data.set(base7.data);
      return runSync(finishTerrain(b, spec(7, hd), [], 0));
    };
    const other = fin(true);
    const otherProc = fin(false);
    const n = real.n;
    const sn = 1024;
    const sameBase = (ix: number, iz: number) => {
      for (let dz = -1; dz <= 2; dz++) {
        for (let dx = -1; dx <= 2; dx++) {
          const k = Math.min(sn - 1, Math.max(0, (iz >> 1) + dz)) * sn + Math.min(sn - 1, Math.max(0, (ix >> 1) + dx));
          if (base1024.data[k] !== base7.data[k]) return false;
        }
      }
      return true;
    };
    let same = 0;
    let sameProc = 0;
    let land = 0;
    for (let iz = 0; iz < n; iz += 3) {
      for (let ix = 0; ix < n; ix += 3) {
        const k = iz * n + ix;
        if (!(real.data[k] > 3) || !sameBase(ix, iz)) continue;
        land++;
        if (real.data[k] === other.data[k]) same++;
        if (proc.data[k] === otherProc.data[k]) sameProc++;
      }
    }
    expect(land).toBeGreaterThan(50_000);
    expect(same).toBe(land);
    expect(sameProc / land).toBeLessThan(0.5);
  });

  it('keeps the shoreline: no sample changes side of sea level vs the plain upsample', () => {
    const n = real.n;
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const h = upsampled(base1024.data, 1024, ix, iz);
        const r = real.data[iz * n + ix];
        if (h > 0 !== r > 0) throw new Error(`sample ${ix}, ${iz} crossed sea level: ${h} → ${r}`);
        if (h <= 3 && r !== Math.fround(h)) throw new Error(`waterline sample ${ix}, ${iz} changed: ${h} → ${r}`);
      }
    }
  });

  it('stays within the generation budget of the procedural detail', () => {
    console.log(`finishTerrain 2048: real detail ${realMs.toFixed(0)} ms, procedural ${procMs.toFixed(0)} ms`);
    expect(realMs).toBeLessThan(procMs * 1.5 + 200);
  });

  it('falls back to the procedural detail when the data does not match the installed grid', () => {
    const stale = HD_BYTES.slice();
    const dv = new DataView(stale.buffer);
    dv.setUint32(24, dv.getUint32(24, true) ^ 1, true);
    setAucklandLinzHd(stale);
    const b = new Heightfield(1024, HF_EXTENT);
    b.data.set(base1024.data);
    const warn = console.warn;
    console.warn = () => undefined;
    const fallback = runSync(finishTerrain(b, spec(1840, true), [], 0));
    console.warn = warn;
    let diff = 0;
    for (let k = 0; k < fallback.data.length; k += 97) diff = Math.max(diff, Math.abs(fallback.data[k] - proc.data[k]));
    expect(diff).toBe(0);
    setAucklandLinzHd(HD_BYTES);
  });
});

describe('HD terrain download scope', () => {
  it('only the high tier asks for it, and the setting turns it off', () => {
    expect(worldConfig(QUALITY_PRESETS.low).hdTerrain).toBe(false);
    expect(worldConfig(QUALITY_PRESETS.medium).hdTerrain).toBe(false);
    expect(worldConfig(QUALITY_PRESETS.high).hdTerrain).toBe(true);
    expect(DEFAULT_SETTINGS.hdTerrain).toBe(true);
    // a medium preset with the flag forced on still has no 2048 field to refine
    expect(worldConfig({ ...QUALITY_PRESETS.medium, hdTerrain: true }).hdTerrain).toBe(false);
    expect(worldConfig({ ...QUALITY_PRESETS.high, hdTerrain: false }).hdTerrain).toBe(false);
  });

  it('the loader fetches once and shares concurrent calls; failures leave the procedural detail', async () => {
    setAucklandLinzHd(null);
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (u: string) => {
      calls.push(String(u));
      return new Response(HD_GZ.slice());
    }) as typeof fetch;
    try {
      const [a, b] = await Promise.all([loadAucklandLinzHd(), loadAucklandLinzHd()]);
      expect(a && b).toBe(true);
      expect(await loadAucklandLinzHd()).toBe(true);
      expect(calls).toEqual([LINZ_HD_URL]);
      expect(aucklandLinzHd()?.n).toBe(2048);
      setAucklandLinzHd(null);
      globalThis.fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch;
      const warn = console.warn;
      console.warn = () => undefined;
      expect(await loadAucklandLinzHd()).toBe(false);
      console.warn = warn;
      expect(aucklandLinzHd()).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
      setAucklandLinzHd(null);
    }
  });

  it('the service worker never precaches it (other lazily referenced assets still are)', () => {
    const helpers = new Function('self', `${sw.slice(0, sw.indexOf("self.addEventListener('install'"))}; return { referencedAssets };`)({
      registration: { scope: 'https://example.com/game/' },
      location: { origin: 'https://example.com' },
    }) as { referencedAssets: (c: string, u: string) => string[] };
    // as Vite emits the two terrain files (hashes may contain '-' and '_')
    const code = 'Um=new URL(`auckland-linz-DdOrbZq3.bin`,import.meta.url).href;wh=new URL(`auckland-linz-hd-TZmJ9-0x.bin`,import.meta.url).href;x=new URL("auckland-linz-hd-a_B.bin",import.meta.url)';
    const found = helpers.referencedAssets(code, 'https://example.com/game/assets/index-abc.js');
    expect(found).toEqual(['https://example.com/game/assets/auckland-linz-DdOrbZq3.bin']);
  });
});
