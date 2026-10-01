/**
 * Phase 1 of the LINZ scenery upgrade: the Auckland theatre runs on the real coastline (NZ contour
 * 8 m DEM mean-high-water mask) and real terrain (NZ LiDAR 1 m DEM) baked by tools/linz/bake.py.
 * Checks the data against published geography, the mission content against the real coast, the
 * download budget for phones, and the hand-traced fallback.
 */
import { describe, expect, it } from 'vitest';
import { LINZ_BYTES, LINZ_GZ } from './linz-setup';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { geoToWorld, AKL } from '../src/core/auckland';
import { allFeatures } from '../src/world/scenery/Scenery';
import { footprintOf, runwayLengthFor } from '../src/world/terrain/features';
import { segmentDistance } from '../src/world/terrain/coastline';
import { aucklandMapData } from '../src/world/terrain/theaters/auckland';
import { aucklandLinz, decodeLinz, linzIsLand, setAucklandLinz } from '../src/world/terrain/theaters/aucklandLinz';
import { AKL_CONES, AKL_RANGITOTO } from '../src/world/terrain/theaters/aucklandMap';
import { CAMPAIGN, TRAINING, terrainPadsFor } from '../src/missions';
import { BASE_FEATURES, FEATURES } from '../src/missions/content/common';

const features = allFeatures('auckland', BASE_FEATURES);
const hf = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 1024, features, pads: [] }));
const q = new TerrainQueryImpl(hf);
const map = aucklandMapData();
const coastDist = (x: number, z: number) => (map.isLand(x, z) ? 1 : -1) * segmentDistance(map.segments, x, z);
const geo = (lat: number, lon: number) => geoToWorld(lat, lon);

describe('LINZ data file', () => {
  it('stays small enough to download on every page load (phones)', () => {
    expect(LINZ_GZ.length).toBeLessThan(600_000);
  });

  it('decodes: coastline rings + a 1024² height grid over the heightfield extent', () => {
    const d = decodeLinz(LINZ_BYTES);
    expect(d.n).toBe(1024);
    expect(d.extent).toBe(88_000);
    expect(d.rings.length).toBeGreaterThan(50);
    let max = 0;
    for (const h of d.heights) max = Math.max(max, h);
    expect(max).toBeGreaterThan(600); // Hunua Ranges (688 m) in the SE corner
    expect(max).toBeLessThan(700);
    expect(() => decodeLinz(LINZ_BYTES.slice(0, LINZ_BYTES.length - 1))).toThrow();
  });
});

describe('real coastline (published geography)', () => {
  it('puts known land on land and known water in water', () => {
    const land: [string, number, number][] = [
      ['Sky Tower', -36.8485, 174.7622],
      ['Rangitoto summit', -36.7867, 174.8584],
      ['Motuihe Island', -36.808, 174.9437],
      ['Waiheke (Onetangi)', -36.792, 175.06],
      ['Whangaparāoa Peninsula', -36.632, 174.75],
      ['Awhitu Peninsula', -37.15, 174.62],
      ['Devonport', -36.831, 174.796],
    ];
    const water: [string, number, number][] = [
      ['Rangitoto Channel', -36.81, 174.83],
      ['Waitematā under the Harbour Bridge', -36.8317, 174.7462],
      ['Manukau Harbour', -36.97, 174.68],
      ['Kaipara Harbour (south arm)', -36.5, 174.38],
      ['Tasman Sea off Piha', -36.95, 174.4],
      ['Tāmaki estuary', -36.88, 174.885],
    ];
    for (const [name, lat, lon] of land) {
      const p = geo(lat, lon);
      expect(map.isLand(p.x, p.z), name).toBe(true);
      expect(q.heightAt(p.x, p.z), name).toBeGreaterThan(0);
    }
    for (const [name, lat, lon] of water) {
      const p = geo(lat, lon);
      expect(map.isLand(p.x, p.z), name).toBe(false);
      expect(q.isWater(p.x, p.z), name).toBe(true);
    }
  });
});

describe('real terrain heights (LiDAR) on the 86 m heightfield', () => {
  const peak = (x: number, z: number, r: number) => {
    let m = -Infinity;
    for (let dz = -r; dz <= r; dz += 20) for (let dx = -r; dx <= r; dx += 20) m = Math.max(m, q.heightAt(x + dx, z + dz));
    return m;
  };

  it('volcanic cones reach close to their surveyed summits (≤ 15 % low at 86 m resolution)', () => {
    for (const c of AKL_CONES) {
      const h = peak(c.x * 1000, c.z * 1000, 300);
      expect(h, `cone at ${c.x},${c.z}`).toBeGreaterThan(c.h * 0.68);
      expect(h, `cone at ${c.x},${c.z}`).toBeLessThan(c.h + 5);
    }
    expect(peak(AKL.mt_eden.x, AKL.mt_eden.z, 300)).toBeGreaterThan(196 * 0.85); // Maungawhau 196 m
    expect(peak(AKL.one_tree_hill.x, AKL.one_tree_hill.z, 300)).toBeGreaterThan(182 * 0.85);
    expect(peak(AKL_RANGITOTO.x * 1000, AKL_RANGITOTO.z * 1000, 400)).toBeGreaterThan(259 * 0.85);
  });

  it('the Waitākere Ranges top out near Te Ahuahu (459 m) and the CBD ridge is ≈ 30–90 m', () => {
    const w = peak(AKL.waitakere.x, AKL.waitakere.z, 7000);
    expect(w).toBeGreaterThan(400);
    expect(w).toBeLessThan(480);
    expect(q.heightAt(0, 0)).toBeGreaterThan(20); // Sky Tower stands at ≈ 30–40 m
    expect(q.heightAt(0, 0)).toBeLessThan(90);
  });
});

describe('mission content fits the real coast', () => {
  it('every terrain pad (SAM sites, compounds) is on land with its radius to spare', () => {
    for (const m of [...CAMPAIGN, ...TRAINING]) {
      if (m.theater !== 'auckland') continue;
      for (const p of terrainPadsFor(m)) expect(coastDist(p.x, p.z), `${m.id} pad at ${p.x},${p.z}`).toBeGreaterThan(p.radius * 0.5);
    }
  });

  it('runways, taxiways and aprons of every Auckland airfield are on land', () => {
    const fields = [...allFeatures('auckland', []), ...Object.values(FEATURES)].filter((f) => f.type === 'airbase');
    expect(fields.length).toBe(3); // Auckland Airport, Whenuapai, the Waiheke strip
    for (const f of fields) {
      const h = ((f.rotation ?? 0) * Math.PI) / 180;
      const L = runwayLengthFor(f);
      // runway edge, centre line and parallel taxiway along the whole strip; apron (u ≈ 250–420) mid-field
      const pts: [number, number][] = [];
      for (let v = -L / 2; v <= L / 2; v += 50) for (const u of [-30, 0, 190]) pts.push([v, u]);
      for (let v = -400; v <= 400; v += 50) for (const u of [260, 340, 410]) pts.push([v, u]);
      for (const [v, u] of pts) {
        const x = f.x + Math.sin(h) * v + Math.cos(h) * u;
        const z = f.z - Math.cos(h) * v + Math.sin(h) * u;
        expect(coastDist(x, z), `${f.x},${f.z} v=${v} u=${u}`).toBeGreaterThan(20);
        expect(hf.heightAt(x, z)).toBeGreaterThan(2);
      }
    }
  });

  it('flattening keeps the sea: footprint corners over water stay water', () => {
    // Auckland Airport's flatten rectangle overhangs the Manukau on both sides of the promontory
    let wet = 0;
    for (const f of allFeatures('auckland', []).filter((g) => g.type === 'airbase')) {
      const fp = footprintOf(f);
      for (let v = -fp.halfL; v <= fp.halfL; v += 100)
        for (let u = -fp.halfW; u <= fp.halfW; u += 100) {
          const x = fp.x + Math.sin(fp.heading) * v + Math.cos(fp.heading) * u;
          const z = fp.z - Math.cos(fp.heading) * v + Math.sin(fp.heading) * u;
          if (coastDist(x, z) < -150) {
            wet++;
            expect(hf.heightAt(x, z), `${x},${z}`).toBeLessThan(0);
          }
        }
    }
    expect(wet).toBeGreaterThan(5);
  });
});

describe('hand-traced fallback (no LINZ data: offline without cache, old browser)', () => {
  it('still builds a complete Auckland, and restores the real one afterwards', () => {
    setAucklandLinz(null);
    try {
      expect(aucklandLinz()).toBeNull();
      const fb = aucklandMapData();
      expect(fb.linz).toBeNull();
      const t = new TerrainQueryImpl(runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 256, features, pads: [] })));
      expect(t.heightAt(0, 0)).toBeGreaterThan(8);
      expect(t.isWater(5000, -1200)).toBe(true);
    } finally {
      setAucklandLinz(LINZ_BYTES);
    }
    expect(aucklandMapData().linz).not.toBeNull();
  });
});
