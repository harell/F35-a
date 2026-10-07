/**
 * Real suburbs 3/9 (#122): the OSM land-use grid (src/world/scenery/data/auckland-landuse.bin, tools/osm/landuse.py),
 * what the terrain and the house scatter make of it, and the OSM re-bake over the full world box.
 */
import { describe, expect, it } from 'vitest';
import { LANDUSE_BYTES, LANDUSE_GZ, MANIFEST, installLandUse } from './landuse-setup';
import {
  LU_CLASSES,
  LU_INDUSTRIAL,
  LU_NAMES,
  LU_NONE,
  LU_RESIDENTIAL,
  LU_SCHOOL,
  decodeLandUse,
  landUseAt,
  landUseCell,
  landUseShares,
  luOpen,
  luSheds,
} from '../src/world/scenery/aucklandLandUse';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { applyLandUse } from '../src/world/terrain/landUse';
import { Heightfield } from '../src/world/terrain/Heightfield';
import { MAT_NONE, MAT_URBAN } from '../src/world/terrain/types';
import { allFeatures } from '../src/world/scenery/Scenery';
import { bakeColorRows } from '../src/world/terrain/bake';
import { reduceView } from '../src/world/terrain/parallel';
import { APARTMENT, ColorMapSampler, HOUSE, HouseSource, SHED } from '../src/world/scenery/sources';
import { REC } from '../src/world/scenery/scatter';
import { AKL_CBD_GRID, worldConfig } from '../src/world/config';
import { QUALITY_PRESETS } from '../src/core/data';
import { geoToWorld } from '../src/core/auckland';
import { siteLayout } from '../src/world/scenery/aucklandSites';
import { aucklandOsm, OSM_PIER } from '../src/world/scenery/aucklandOsm';
import { terrainFragmentShader } from '../src/world/terrain/terrainShader';

const lu = installLandUse();
const SEED = 1840;
const features = allFeatures('auckland', []);
const terrain = (landUse: boolean) => runSync(generateTerrain({ theater: 'auckland', seed: SEED, resolution: 1024, features, pads: [], landUse }));

describe('land-use grid', () => {
  it('is one file of ≤ 500 kB gzip at 16 m over the ±40 km world, ODbL and CC BY attributed', () => {
    expect(LANDUSE_GZ.length).toBeLessThan(500_000);
    expect(LANDUSE_GZ.length).toBe(MANIFEST.landuse.gzip_bytes);
    expect(lu.cell).toBe(16);
    expect(lu.cols * lu.cell).toBe(80_000);
    expect(lu.rows * lu.cell).toBe(80_000);
    expect(lu.x0).toBe(-40_000);
    expect(lu.attribution).toMatch(/© OpenStreetMap contributors, ODbL/);
    expect(lu.attribution).toMatch(/LINZ Topo50, CC BY/);
    // on the GPU as RGBA8 texels of 4 × 2 cells, within WebGL 2's minimum texture size on phones (4096)
    expect(lu.texW).toBeLessThanOrEqual(4096);
    expect(lu.texH).toBeLessThanOrEqual(4096);
    expect(lu.data.length).toBe(lu.texW * lu.texH * 4);
  });

  it('rejects malformed data', () => {
    expect(() => decodeLandUse(LANDUSE_BYTES.subarray(0, LANDUSE_BYTES.length - 2))).toThrow();
    const bad = LANDUSE_BYTES.slice();
    bad[0] = 0;
    expect(() => decodeLandUse(bad)).toThrow();
  });

  it('packs 4-bit classes as the shader reads them (byte (j & 1)·2 + (i & 3) >> 1, low nibble for even i)', () => {
    // the decoder and the per-cell reader agree with the shader's arithmetic (landUseAt in terrainShader.ts)
    expect(terrainFragmentShader).toContain('float b = f.y < 0.5 ? (f.x < 1.5 ? v.r : v.g) : (f.x < 1.5 ? v.b : v.a);');
    expect(terrainFragmentShader).toContain('return mod(f.x, 2.0) < 0.5 ? mod(b, 16.0) : floor(b / 16.0);');
    let seen = 0;
    for (let j = 2900; j < 2910; j++)
      for (let i = 2200; i < 2600; i++) {
        const c = landUseCell(lu, i, j);
        expect(c).toBeLessThan(LU_CLASSES);
        expect(landUseAt(lu, lu.x0 + (i + 0.5) * lu.cell, lu.z0 + (j + 0.5) * lu.cell)).toBe(c);
        if (c !== LU_NONE) seen++;
      }
    expect(seen).toBeGreaterThan(100);
    expect(landUseAt(lu, 41_000, 0)).toBe(LU_NONE);
  });

  it('matches the source polygons: class shares per suburb within 5 points', () => {
    // The bake fills unclassified gaps ≤ 32 m between two cells of one class (the streets between residential
    // polygons): 'none' turns residential there, which the game treats alike (no class = the hand-traced suburbs).
    // So residential is checked together with none, every other class on its own.
    const suburbs = MANIFEST.landuse.suburbs as Record<string, { rect: number[]; shares: Record<string, number> }>;
    expect(Object.keys(suburbs)).toEqual(expect.arrayContaining(['mt_roskill', 'avondale', 'henderson', 'mangere', 'onetangi']));
    const out = new Float64Array(LU_CLASSES);
    for (const [name, s] of Object.entries(suburbs)) {
      const [x0, z0, x1, z1] = s.rect;
      landUseShares(lu, x0, z0, x1, z1, out);
      for (let c = 2; c < LU_CLASSES; c++) {
        const want = s.shares[LU_NAMES[c]] ?? 0;
        expect(Math.abs(out[c] - want), `${name} ${LU_NAMES[c]}: grid ${out[c].toFixed(3)}, polygons ${want}`).toBeLessThan(0.05);
      }
      const homes = (s.shares.residential ?? 0) + (s.shares.none ?? 0);
      expect(Math.abs(out[LU_RESIDENTIAL] + out[LU_NONE] - homes), `${name} residential + none`).toBeLessThan(0.05);
      expect(out[LU_RESIDENTIAL], `${name} residential`).toBeGreaterThan((s.shares.residential ?? 0) - 0.05);
    }
    // the places the issue names have what the photo has
    const sh = (n: string) => suburbs[n].shares;
    expect(sh('mt_roskill').park + sh('mt_roskill').pitch + sh('mt_roskill').golf).toBeGreaterThan(0.15); // Keith Hay Park, Akarana golf
    expect(sh('mt_roskill').industrial + sh('mt_roskill').commercial).toBeGreaterThan(0.05); // Stoddard Road
    expect(sh('avondale').residential).toBeGreaterThan(0.3);
    expect(sh('onetangi').vineyard).toBeGreaterThan(0.02);
    expect(sh('onetangi').residential).toBeGreaterThan(0.1);
  });
});

describe('terrain and scatter on the real land use', () => {
  const hand = terrain(false);
  const real = terrain(true);
  const k = (hf: Heightfield, x: number, z: number) => Math.round((z - hf.origin) / hf.cell) * hf.n + Math.round((x - hf.origin) / hf.cell);
  const share = (x: number, z: number, cell: number) => landUseShares(lu, x - cell / 2, z - cell / 2, x + cell / 2, z + cell / 2);

  it('is off without the flag or the grid (the low tier and offline keep the hand-traced suburbs)', () => {
    const off = terrain(false);
    expect(Array.from(off.mat)).toEqual(Array.from(hand.mat));
    const copy = new Heightfield(hand.n, hand.extent);
    copy.data.set(hand.data);
    copy.mat.set(hand.mat);
    copy.aux.set(hand.aux);
    expect(applyLandUse(copy, lu, SEED)).toBeGreaterThan(1000);
    expect(worldConfig(QUALITY_PRESETS.low).landUse).toBe(false);
    expect(worldConfig(QUALITY_PRESETS.medium).landUse).toBe(true);
    expect(worldConfig(QUALITY_PRESETS.high).landUse).toBe(true);
  }, 60_000);

  it('parks and fields are no longer built up; Waiheke gets its real settlements', () => {
    let parks = 0;
    let homes = 0;
    for (let z = -12_000; z <= 16_000; z += real.cell)
      for (let x = -16_000; x <= 36_000; x += real.cell) {
        const i = k(real, x, z);
        if (real.data[i] <= 2 || (real.mat[i] !== MAT_NONE && real.mat[i] !== MAT_URBAN)) continue;
        if (hand.mat[i] !== MAT_NONE && hand.mat[i] !== MAT_URBAN) continue;
        // the CBD's own apartments density stays (its parks come from the LINZ street map: cbdPattern)
        if (hand.mat[i] === MAT_URBAN && hand.aux[i] > 0.9 * 255) continue;
        const s = share(hand.pos(i % hand.n), hand.pos(Math.floor(i / hand.n)), hand.cell);
        let open = 0;
        for (let c = 0; c < LU_CLASSES; c++) if (luOpen(c)) open += s[c];
        if (open > 0.95) {
          parks++;
          expect(real.mat[i] === MAT_NONE || real.aux[i] < 0.1 * 255, `${x},${z} mat ${real.mat[i]} aux ${real.aux[i]} hand ${hand.mat[i]}/${hand.aux[i]} open ${open.toFixed(2)} none ${s[0].toFixed(2)}`).toBe(true);
        }
        if (s[LU_RESIDENTIAL] > 0.9 && x > 18_000) {
          homes++;
          expect(real.mat[i]).toBe(MAT_URBAN);
        }
      }
    expect(parks).toBeGreaterThan(300);
    expect(homes).toBeGreaterThan(50);
  });

  it('houses stand only off open ground, sheds on commercial and industrial land', () => {
    const m = 512;
    const color = new Uint8Array(m * m * 4);
    bakeColorRows(reduceView(real, m), { theater: 'auckland', seed: SEED, features }, m, 0, m, color);
    const cmap = new ColorMapSampler(color, m, real.origin, real.extent);
    const src = new HouseSource(real, cmap, (x, z) => real.meshHeightAt(x, z), AKL_CBD_GRID, null, null, null, lu);
    expect(src.kinds).toBe(3);
    const c = MANIFEST.landuse.suburbs.mt_roskill.rect as number[];
    const out = { data: [[], [], []] as number[][] };
    for (let z = c[1]; z < c[3]; z += 250) for (let x = c[0]; x < c[2]; x += 250) src.generate(x, z, 250, out);
    let houses = 0;
    let onOpen = 0;
    for (const kind of [HOUSE, APARTMENT])
      for (let i = 0; i < out.data[kind].length; i += REC) {
        houses++;
        if (luOpen(landUseAt(lu, out.data[kind][i], out.data[kind][i + 2]))) onOpen++;
      }
    const sheds = out.data[SHED].length / REC;
    expect(houses).toBeGreaterThan(500);
    // a house's centre sits up to ≈ 6 m off its lot's centre, which decides: a few straddle a park's edge
    expect(onOpen / houses).toBeLessThan(0.03);
    expect(sheds).toBeGreaterThan(20);
    let industrial = 0;
    for (let i = 0; i < out.data[SHED].length; i += REC) {
      const cl = landUseAt(lu, out.data[SHED][i], out.data[SHED][i + 2]);
      expect(luSheds(cl) || cl === LU_SCHOOL).toBe(true);
      if (cl === LU_INDUSTRIAL) industrial++;
    }
    expect(industrial).toBeGreaterThan(0);
  });
});

describe('OSM re-bake over the full world box', () => {
  it('takes in the strip east of BBBike’s box: Kennedy Point and Orapiu wharves on eastern Waiheke', () => {
    const inputs = MANIFEST.inputs.map((i: { file: string }) => i.file);
    expect(inputs).toEqual(['Auckland.osm.pbf', 'akl-strips.osm.pbf']);
    const s = siteLayout()!;
    const near = (lat: number, lon: number) => {
      const p = geoToWorld(lat, lon);
      const ring = s.piers.some((r) => Math.hypot((r.x0 + r.x1) / 2 - p.x, (r.z0 + r.z1) / 2 - p.z) < 150);
      const line = aucklandOsm()!.features.some((f) => f.layer === OSM_PIER && !f.area && Math.hypot(f.pts[0] - p.x, f.pts[1] - p.z) < 150);
      return ring || line;
    };
    expect(near(-36.8298, 175.0654)).toBe(true); // Kennedy Point (lon 175.065: east of BBBike's 175.05)
    expect(near(-36.8437, 175.1479)).toBe(true); // Orapiu
    // every vertex inside the world box (lon 174.31…175.21 is ±44 km east-west)
    expect(MANIFEST.bbox).toEqual([174.31, -37.21, 175.21, -36.49]);
  });

  it('only grows the existing layers', () => {
    // counts of the previous (BBBike + Dairy Flat) bake
    const before: Record<string, number> = { aerodrome: 7, apron: 73, breakwater: 186, building: 471, core: 6, depot: 1, dock: 1, grandstand: 26, hangar: 127, helipad: 9, marina: 17, military: 24, naval: 1, pier: 1487, port: 3, runway: 25, stadium: 15, tank: 115, taxiway: 259, terminal: 7 };
    for (const [layer, n] of Object.entries(before)) expect(MANIFEST.layers[layer], layer).toBeGreaterThanOrEqual(n);
  });
});
