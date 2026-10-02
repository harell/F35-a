/**
 * #7: the Auckland terrain re-bake with real land cover (LINZ Topo50 native / exotic / scrub polygons) and real
 * bathymetry (LINZ ENC depth areas, chart datum moved to mean high water), baked by tools/linz/bake.py into version 2 of
 * auckland-linz.bin. Checks the bush, forests and water depth against published geography, that the coastline
 * and land heights are untouched, the download budget, and the hand-traced fallback.
 */
import { describe, expect, it } from 'vitest';
import { LINZ_BYTES, LINZ_GZ } from './linz-setup';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import type { Heightfield } from '../src/world/terrain/Heightfield';
import { geoToWorld } from '../src/core/auckland';
import { allFeatures } from '../src/world/scenery/Scenery';
import { BASE_FEATURES } from '../src/missions/content/common';
import { MAT_BUSH, MAT_NONE, MAT_PINE, MAT_VOLCANIC } from '../src/world/terrain/types';
import { COVER_EXOTIC, COVER_NATIVE, decodeLinz, linzCover, linzDepth, setAucklandLinz } from '../src/world/terrain/theaters/aucklandLinz';
import { createVegetation, TREE_CONIFER } from '../src/world/terrain/vegetation';

const features = allFeatures('auckland', BASE_FEATURES);
const hf = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 1024, features, pads: [] }));
const data = decodeLinz(LINZ_BYTES);

/** Share of each material among the heightfield samples within `r` m of a point (lat, lon). */
function materials(field: Heightfield, lat: number, lon: number, r = 1000): Record<number, number> {
  const p = geoToWorld(lat, lon);
  const counts: Record<number, number> = {};
  let n = 0;
  for (let dz = -r; dz <= r; dz += field.cell) {
    for (let dx = -r; dx <= r; dx += field.cell) {
      if (dx * dx + dz * dz > r * r) continue;
      const i = Math.round((p.x + dx - field.origin) / field.cell);
      const j = Math.round((p.z + dz - field.origin) / field.cell);
      const m = field.mat[j * field.n + i];
      counts[m] = (counts[m] ?? 0) + 1;
      n++;
    }
  }
  for (const k in counts) counts[k] /= n;
  return counts;
}

/** Mean terrain height (m; negative = water depth) within `r` m of a point. */
function meanHeight(lat: number, lon: number, r: number): number {
  const p = geoToWorld(lat, lon);
  let s = 0;
  let n = 0;
  for (let dz = -r; dz <= r; dz += hf.cell) {
    for (let dx = -r; dx <= r; dx += hf.cell) {
      if (dx * dx + dz * dz > r * r) continue;
      s += hf.heightAt(p.x + dx, p.z + dz);
      n++;
    }
  }
  return s / n;
}

function fnv1a(arrays: Float32Array[]): number {
  let h = 0x811c9dc5;
  for (const a of arrays) {
    const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193) >>> 0;
  }
  return h;
}

describe('LINZ data file, version 2', () => {
  it('decodes the 512² land cover and depth grids', () => {
    expect(data.auxN).toBe(512);
    expect(data.cover?.length).toBe(512 * 512);
    expect(data.depth?.length).toBe(512 * 512);
  });

  it('keeps the coastline and land heights of the version 1 bake (same rings and heights)', () => {
    // FNV-1a of the decoded rings + 1024² heights of the pre-#7 file (version 1, 509 986 bytes gzip)
    expect(fnv1a([...data.rings, data.heights]).toString(16)).toBe('bb42cf46');
  });

  it('grows the base download by less than 150 kB gzip', () => {
    expect(LINZ_GZ.length - 509_986).toBeLessThan(150 * 1024);
  });
});

describe('real bush and forest (Topo50 polygons)', () => {
  it('covers the Waitākere and Hunua ranges (regional parks) with native bush', () => {
    for (const [name, lat, lon] of [
      ['Waitākere Ranges, Cascades', -36.89, 174.53],
      ['Waitākere Ranges, Huia', -36.97, 174.56],
      ['Hunua Ranges', -37.07, 175.1],
    ] as const) {
      expect(materials(hf, lat, lon)[MAT_BUSH] ?? 0, name).toBeGreaterThan(0.85);
    }
  });

  it('plants the Woodhill and Riverhead pine forests', () => {
    expect(materials(hf, -36.709, 174.368)[MAT_PINE] ?? 0, 'Woodhill').toBeGreaterThan(0.6);
    expect(materials(hf, -36.714, 174.573)[MAT_PINE] ?? 0, 'Riverhead').toBeGreaterThan(0.6);
    const veg = createVegetation('auckland', 1840, features);
    let conifers = 0;
    for (let k = 0; k < 100; k++) if (veg.species(50, MAT_PINE, k / 100) === TREE_CONIFER) conifers++;
    expect(conifers).toBeGreaterThan(85);
    expect(veg.density(0, 0, 50, 0.1, MAT_PINE, 255)).toBeGreaterThan(0.8);
  });

  it('leaves the Kumeu farmland open and Rangitoto its lava-field material', () => {
    const kumeu = materials(hf, -36.78, 174.56);
    expect((kumeu[MAT_BUSH] ?? 0) + (kumeu[MAT_PINE] ?? 0)).toBeLessThan(0.1);
    expect(kumeu[MAT_NONE]).toBeGreaterThan(0.8);
    expect(materials(hf, -36.786, 174.858, 600)[MAT_VOLCANIC]).toBeGreaterThan(0.9);
  });

  it('interpolates the cover share per class (edges, not blocks)', () => {
    const out = { cls: 0, cover: 0 };
    const p = geoToWorld(-36.97, 174.56);
    expect(linzCover(data, p.x, p.z, out)).toBe(true);
    expect(out.cls).toBe(COVER_NATIVE);
    expect(out.cover).toBeGreaterThan(0.9);
    const w = geoToWorld(-36.709, 174.368);
    linzCover(data, w.x, w.z, out);
    expect(out.cls).toBe(COVER_EXOTIC);
    // along a line out of the Hunua bush the share falls through every level, not in one step
    const seen = new Set<number>();
    const a = geoToWorld(-37.07, 175.1);
    for (let t = 0; t < 12_000; t += 20) {
      linzCover(data, a.x - t, a.z, out);
      seen.add(Math.round(out.cover * 10));
    }
    expect(seen.size).toBeGreaterThan(8);
  });
});

describe('real bathymetry (LINZ chart depth areas)', () => {
  it('cuts the Rangitoto Channel deep between North Head and Rangitoto', () => {
    const p = geoToWorld(-36.8125, 174.8265);
    expect(linzDepth(data, p.x, p.z)).toBeGreaterThan(9);
    expect(meanHeight(-36.8125, 174.8265, 150)).toBeLessThan(-8);
    // the shelf off Rangitoto's south-west shore is shallow
    expect(meanHeight(-36.7979, 174.8411, 100)).toBeGreaterThan(-3);
  });

  it('keeps the Manukau flats shallow and its channels deep', () => {
    // drying flats (charted 4.2 m drying height; MHW ≈ 4 m above chart datum there): a few metres at high water
    for (const [lat, lon] of [
      [-36.9936, 174.7217],
      [-37.0866, 174.7622],
      [-36.9785, 174.6628],
    ]) {
      expect(meanHeight(lat, lon, 200), `${lat}, ${lon}`).toBeGreaterThan(-4);
    }
    expect(meanHeight(-37.035, 174.55, 300), 'Manukau Heads').toBeLessThan(-15);
  });

  it('is shallower in the harbours than out in the Gulf and the Tasman', () => {
    const gulf = geoToWorld(-36.62, 175.1);
    const tasman = geoToWorld(-36.95, 174.3);
    expect(linzDepth(data, gulf.x, gulf.z)).toBeGreaterThan(30);
    expect(linzDepth(data, tasman.x, tasman.z)).toBeGreaterThan(40);
  });
});

describe('hand-traced fallback (no LINZ data)', () => {
  it('still has a procedural bush mask and the Riverhead pine plantation', () => {
    setAucklandLinz(null);
    try {
      const low = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 512, features, pads: [] }));
      expect(materials(low, -36.97, 174.56, 3000)[MAT_BUSH] ?? 0).toBeGreaterThan(0.3);
      expect(materials(low, -36.718, 174.583, 2500)[MAT_PINE] ?? 0).toBeGreaterThan(0.3);
    } finally {
      setAucklandLinz(LINZ_BYTES);
    }
  });
});
