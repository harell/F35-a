/**
 * Real suburbs 2/9 (#121): the real houses of the Devonport peninsula, Waiheke and the gulf islands
 * (src/world/terrain/data/auckland-houses.bin, tools/linz/houses.py + houses.ts), drawn by the house scatter.
 */
import { describe, expect, it } from 'vitest';
import { Color } from 'three';
import { HOUSES_BYTES, HOUSES_GZ } from './linz-setup';
import SPOT from './fixtures/linz-house-spotchecks.json';
import {
  aucklandHouses,
  decodeHouses,
  encodeHouses,
  HOUSE_BYTES,
  houseCoverage,
  housesCover,
  housesIn,
  setAucklandHouses,
  unionMasks,
  type HouseRecord,
} from '../src/world/scenery/aucklandHouses';
import { APARTMENT, ColorMapSampler, HOUSE, HOUSE_OVERHANG_D, HOUSE_OVERHANG_W, HouseSource, REAL_FLAG, roofColorFn } from '../src/world/scenery/sources';
import { REC, type TileInstances } from '../src/world/scenery/scatter';
import { maskFromRings } from '../src/world/scenery/lotMask';
import { siteRings } from '../src/world/scenery/aucklandSites';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { allFeatures } from '../src/world/scenery/Scenery';
import { bakeColorRows } from '../src/world/terrain/bake';
import { reduceView } from '../src/world/terrain/parallel';
import { AKL_CBD_GRID } from '../src/world/config';
import { AERIAL_RECT } from '../src/world/terrain/theaters/aucklandAerial';

const h = aucklandHouses()!;

/** Settlements (game XZ, m): the densest 400 m of each from the LINZ outlines' localities. */
const ONEROA = [22160, -6969] as const;
const ONETANGI = [28320, -5931] as const;
const RANGITOTO_WHARF = [8547, -4364] as const;
const ISLINGTON_BAY = [11747, -7964] as const;
const DEVONPORT_VILLAGE = [2966, -1886] as const;

const within = (c: readonly [number, number], r: number) => housesIn(h, c[0] - r, c[1] - r, c[0] + r, c[1] + r).filter((k) => Math.hypot(h.x[k] - c[0], h.z[k] - c[1]) <= r);

describe('real houses data (auckland-houses.bin)', () => {
  it('holds the peninsula and the islands at ≈ 8 bytes a house (raw), < 140 kB gzip', () => {
    expect(h.count).toBeGreaterThan(16_000);
    expect(HOUSES_BYTES.length / h.count).toBeLessThan(HOUSE_BYTES + 1); // + the palette, cell table and coverage
    expect(HOUSES_GZ.length).toBeLessThan(140_000);
    // every house under 600 m² (bigger buildings are #124's) and of a house's shape and height
    for (let k = 0; k < h.count; k++) {
      expect(h.w[k] * h.d[k]).toBeLessThan(700);
      expect(h.eave[k]).toBeGreaterThanOrEqual(1.9);
      expect(h.eave[k]).toBeLessThanOrEqual(25.5);
      expect(h.rise[k]).toBeLessThanOrEqual(12);
    }
    // a good share of pitched roofs (a gable or hip fitted to the LiDAR, or a spread of heights)
    let pitched = 0;
    for (let k = 0; k < h.count; k++) if (h.rise[k] > 0.3) pitched++;
    expect(pitched / h.count).toBeGreaterThan(0.4);
  });

  it('round-trips through the encoder and rejects malformed data', () => {
    const recs: HouseRecord[] = [
      { x: 10.3, z: -20.7, w: 8.5, d: 12.25, dir: 0.5, eave: 3.2, rise: 2.1, c: 1 },
      { x: -300.1, z: 512.9, w: 30, d: 6, dir: 3.0, eave: 9, rise: 0, c: 0 },
    ];
    const cover = { x0: -1000, z0: -640, cell: 32, cols: 3, rows: 2, bits: Uint8Array.from([0, 1, 1, 1, 0, 0]) };
    const bytes = encodeHouses(recs, [0x112233, 0x8a4a38], cover);
    const d = decodeHouses(bytes);
    expect(d.count).toBe(2);
    for (let k = 0; k < 2; k++) {
      const r = recs.find((q) => Math.abs(q.x - d.x[k]) < 0.5)!;
      expect(d.z[k]).toBeCloseTo(r.z, 0);
      expect(d.w[k]).toBeCloseTo(r.w, 1);
      expect(d.d[k]).toBeCloseTo(r.d, 1);
      expect(Math.abs(d.dir[k] - r.dir)).toBeLessThan(0.02);
      expect(d.eave[k]).toBeCloseTo(r.eave, 1);
      expect(d.rise[k]).toBeCloseTo(r.rise, 1);
      expect(d.color[k]).toBe(r.c ? 0x8a4a38 : 0x112233);
    }
    expect(d.cover).toEqual(cover);
    expect(housesCover(d, -1000 + 40, -640 + 5)).toBe(true);
    expect(housesCover(d, -1000 + 5, -640 + 5)).toBe(false);
    expect(housesCover(d, -1000 + 40, -640 + 40)).toBe(false);
    expect(decodeHouses(encodeHouses(recs, [0x112233, 0x8a4a38], cover))).toEqual(d);
    expect(() => decodeHouses(HOUSES_BYTES.subarray(0, HOUSES_BYTES.length - 3))).toThrow();
    const bad = HOUSES_BYTES.slice();
    bad[0] = 0;
    expect(() => decodeHouses(bad)).toThrow();
  });
});

describe('real houses on the ground', () => {
  it('stand on the photo’s roofs in Devonport: 20 random spot checks within 2 m, ridges within 2 m of the LiDAR', () => {
    expect(SPOT.length).toBe(20);
    const off: number[] = [];
    for (const s of SPOT) {
      const k = s.house;
      const d = Math.hypot(h.x[k] - s.x, h.z[k] - s.z);
      off.push(d);
      expect(d, `outline ${s.id}`).toBeLessThanOrEqual(2);
      // the LiDAR roof's top (p95 inside the outline) against the baked ridge
      expect(Math.abs(h.eave[k] + h.rise[k] - s.ridge), `outline ${s.id} ridge`).toBeLessThanOrEqual(2);
      // they are Devonport's (under the photo, north of the harbour)
      expect(s.z).toBeLessThan(-1500);
    }
    off.sort((a, b) => a - b);
    expect(off[10]).toBeLessThan(1);
  });

  it('Oneroa and Onetangi have their real houses, Rangitoto its baches', () => {
    expect(within(ONEROA, 200).length).toBeGreaterThan(80);
    expect(within(ONETANGI, 200).length).toBeGreaterThan(60);
    expect(within(RANGITOTO_WHARF, 400).length).toBeGreaterThanOrEqual(15);
    expect(within(ISLINGTON_BAY, 400).length).toBeGreaterThanOrEqual(10);
    expect(within(DEVONPORT_VILLAGE, 300).length).toBeGreaterThan(150);
  });

  it('cover the procedural lots where they stand, and only there', () => {
    const cover = houseCoverage(h)!;
    for (const c of [ONEROA, ONETANGI, RANGITOTO_WHARF, DEVONPORT_VILLAGE]) expect(cover.masked(c[0], c[1])).toBe(true);
    // the open sea and the CBD are not covered
    expect(cover.masked(1000, -1200)).toBe(false);
    expect(cover.masked(0, 0)).toBe(false);
    // every house's own cell is covered
    for (let k = 0; k < h.count; k += 7) expect(cover.masked(h.x[k], h.z[k])).toBe(true);
    // joined to the landmark sites' mask (Scenery.siteMask), both sets of cells stay set
    const sites = maskFromRings(siteRings(), 8)!;
    const both = unionMasks(sites, cover)!;
    for (let k = 0; k < h.count; k += 13) expect(both.masked(h.x[k], h.z[k])).toBe(true);
    let n = 0;
    for (let j = 0; j < sites.texH * 4; j += 3)
      for (let i = 0; i < sites.texW * 8; i += 3) {
        const x = sites.x0 + (i + 0.5) * sites.cell;
        const z = sites.z0 + (j + 0.5) * sites.cell;
        if (sites.masked(x, z)) {
          n++;
          expect(both.masked(x, z)).toBe(true);
        }
      }
    expect(n).toBeGreaterThan(100);
    // on a phone's texture limits (RGBA8 texels of 8 × 4 cells)
    expect(both.texW).toBeLessThanOrEqual(4096);
    expect(both.texH).toBeLessThanOrEqual(4096);
  });
});

describe('the house scatter draws them', () => {
  const SEED = 1840;
  const features = allFeatures('auckland', []);
  const hf = runSync(generateTerrain({ theater: 'auckland', seed: SEED, resolution: 1024, features, pads: [] }));
  const m = 512;
  const color = new Uint8Array(m * m * 4);
  bakeColorRows(reduceView(hf, m), { theater: 'auckland', seed: SEED, features }, m, 0, m, color);
  const cmap = new ColorMapSampler(color, m, hf.origin, hf.extent);
  const ground = (x: number, z: number) => hf.meshHeightAt(x, z);
  const cover = houseCoverage(h);
  const run = (src: HouseSource, c: readonly [number, number], size = 600) => {
    const out: TileInstances = { data: [[], []] };
    src.generate(c[0] - size / 2, c[1] - size / 2, size, out);
    return out;
  };

  it('as they were measured, through the house and apartment archetypes, and no procedural houses round them', () => {
    const src = new HouseSource(hf, cmap, ground, AKL_CBD_GRID, null, cover, null, null, h, null);
    for (const c of [ONEROA, ONETANGI, DEVONPORT_VILLAGE]) {
      const out = run(src, c);
      let real = 0;
      let proc = 0;
      for (const kind of [HOUSE, APARTMENT])
        for (let i = 0; i < out.data[kind].length; i += REC) {
          if (out.data[kind][i + 11] > 0) real++;
          else proc++;
        }
      expect(real).toBe(housesIn(h, c[0] - 300, c[1] - 300, c[0] + 300, c[1] + 300).length);
      expect(proc).toBe(0);
    }
    // a house's record: its centre, the ridge along the measured direction, the roof as the outline's, its colour
    const out = run(src, ONEROA);
    const recs = out.data[HOUSE];
    const k = housesIn(h, ONEROA[0] - 300, ONEROA[1] - 300, ONEROA[0] + 300, ONEROA[1] + 300).find((q) => h.rise[q] > 1 && h.eave[q] < 8)!;
    const i = (() => {
      for (let i = 0; i < recs.length; i += REC) if (recs[i] === h.x[k] && recs[i + 2] === h.z[k]) return i;
      return -1;
    })();
    expect(i).toBeGreaterThanOrEqual(0);
    expect(recs[i + 4] * HOUSE_OVERHANG_W).toBeCloseTo(h.w[k], 4);
    expect(recs[i + 6] * HOUSE_OVERHANG_D).toBeCloseTo(h.d[k], 4);
    expect(recs[i + 11]).toBeCloseTo(1 + h.rise[k], 5);
    // the archetype's ridge runs along local +Z: yaw turns it onto the measured direction
    const yaw = recs[i + 3];
    expect(Math.sin(yaw)).toBeCloseTo(Math.cos(h.dir[k]), 4);
    expect(Math.cos(yaw)).toBeCloseTo(Math.sin(h.dir[k]), 4);
    // eave at the measured height above the ground at its centre (the walls start at the lowest corner)
    expect(recs[i + 1] + recs[i + 5]).toBeCloseTo(Math.max(0.2, hf.meshHeightAt(h.x[k], h.z[k])) + h.eave[k], 0);
    // the roof colour is the photo's (sRGB in the file, linear in the instance colour)
    const c = new Color().setHex(h.color[k]);
    const got = new Color();
    roofColorFn([new Color(0x777777)])(recs.slice(i, i + REC), i, got);
    expect(got.r).toBeCloseTo(c.r, 5);
    expect(got.g).toBeCloseTo(c.g, 5);
    expect(got.b).toBeCloseTo(c.b, 5);
    // a real flat block takes the apartment archetype with its own roof (aux = REAL_FLAG, no rise)
    const apt = run(src, DEVONPORT_VILLAGE, 1200).data[APARTMENT];
    for (let j = 0; j < apt.length; j += REC) expect(apt[j + 11]).toBe(REAL_FLAG);
  });

  it('keep off the road ribbons and landmark sites they are given, and without the file the suburbs are procedural again', () => {
    const none = new HouseSource(hf, cmap, ground, AKL_CBD_GRID, null, cover, null, null, h, () => true);
    const out = run(none, ONEROA);
    expect(out.data[HOUSE].length + out.data[APARTMENT].length).toBe(0);
    // the offline fallback: no real houses, no coverage → the procedural lots and houses at Oneroa (outside the photo
    // square: the islands' photo keeps them off only when it loaded)
    expect(ONEROA[0]).toBeGreaterThan(AERIAL_RECT.x0 + AERIAL_RECT.size);
    const saved = HOUSES_BYTES;
    setAucklandHouses(null);
    try {
      expect(aucklandHouses()).toBeNull();
      const proc = new HouseSource(hf, cmap, ground, AKL_CBD_GRID, null, null, null, null, aucklandHouses(), null);
      const o2 = run(proc, ONEROA);
      let n = 0;
      for (const kind of [HOUSE, APARTMENT]) for (let i = 0; i < o2.data[kind].length; i += REC) if (o2.data[kind][i + 11] === 0) n++;
      expect(n).toBeGreaterThan(50);
    } finally {
      setAucklandHouses(saved);
    }
  });
});
