/**
 * Hero neighbourhoods: Herne Bay and Westhaven measured from the 2024 LiDAR and aerial on OSM outlines
 * (aucklandNeighbourhoods.ts, tools/hero/sites/neighbourhoods_bake.py), drawn inside the real-streets region.
 */
import { describe, expect, it } from 'vitest';
import { aucklandNeighbourhoods, canopyAt, decodeNeighbourhoods, neighbourhoodAt, setAucklandNeighbourhoods, type Neighbourhood } from '../src/world/scenery/aucklandNeighbourhoods';
import { aucklandBuildings, ringArea, roofHeight } from '../src/world/scenery/aucklandBuildings';
import { pitchedHeight, ridgeHeight, roofFacets, wallBreaks, type PitchedRoof } from '../src/world/scenery/pitchedRoof';
import { aucklandStreets, GARDEN_B, pointInRing, type CbdStreets } from '../src/world/scenery/cbdStreets';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';
import { LightList } from '../src/world/scenery/builders';
import { buildCBD } from '../src/world/scenery/auckland';
import { aucklandRoadPaths, RoadNetwork } from '../src/world/scenery/motorways';
import { buildRealWaterside, siteLayout } from '../src/world/scenery/aucklandSites';
import { ColorMapSampler, TreeSource } from '../src/world/scenery/sources';
import { aucklandCbd } from '../src/world/config';
import { allFeatures } from '../src/world/scenery/Scenery';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { bakeColorRows } from '../src/world/terrain/bake';
import { reduceView } from '../src/world/terrain/parallel';
import { createVegetation } from '../src/world/terrain/vegetation';
import { airfieldFeature } from '../src/core/airfields';
import { geoToWorld } from '../src/core/auckland';
import { NEIGHBOURHOODS_BYTES, NEIGHBOURHOODS_GZ } from './linz-setup';

const nbs = aucklandNeighbourhoods() as Neighbourhood[];
const hb = nbs.find((n) => n.name === 'Herne Bay')!;
const wh = nbs.find((n) => n.name === 'Westhaven')!;
const st = aucklandStreets() as CbdStreets;

describe('pitched roofs (pitchedRoof.ts)', () => {
  // a 20 × 8 m house along +X, eaves at 3 m, 0.5 m/m
  const gable: PitchedRoof = { kind: 1, eave: 3, pitch: 0.5, cx: 0, cz: 0, ax: 1, az: 0, a: 10, b: 4 };
  const hip: PitchedRoof = { ...gable, kind: 2 };
  const rect = Float32Array.from([-10, -4, 10, -4, 10, 4, -10, 4]);

  it('rises from the eaves to the ridge: along the whole length for a gable, hipped at the ends for a hip', () => {
    expect(pitchedHeight(gable, 0, 4)).toBeCloseTo(3, 6);
    expect(pitchedHeight(gable, 0, 0)).toBeCloseTo(5, 6);
    expect(pitchedHeight(gable, 10, 0)).toBeCloseTo(5, 6); // the gable end reaches the ridge
    expect(pitchedHeight(hip, 10, 0)).toBeCloseTo(3, 6); // the hip comes down to the eave
    expect(pitchedHeight(hip, 6, 0)).toBeCloseTo(5, 6);
    expect(ridgeHeight(gable)).toBe(5);
    expect(ridgeHeight(hip)).toBe(5);
  });

  it('one planar facet per eave edge, covering the footprint exactly', () => {
    for (const [r, n] of [[gable, 2], [hip, 4]] as const) {
      const fs = roofFacets(r, rect);
      expect(fs.length).toBe(n);
      expect(fs.reduce((s, f) => s + Math.abs(ringArea(f.ring)), 0)).toBeCloseTo(160, 3);
      for (const f of fs) for (let i = 0; i < f.heights.length; i++) expect(f.heights[i]).toBeCloseTo(pitchedHeight(r, f.ring[i * 2], f.ring[i * 2 + 1]), 5);
    }
    // an L-shaped house under the same roof: the facets cover the L, not the rectangle
    const L = Float32Array.from([-10, -4, 10, -4, 10, 0, 0, 0, 0, 4, -10, 4]);
    expect(roofFacets(hip, L).reduce((s, f) => s + Math.abs(ringArea(f.ring)), 0)).toBeCloseTo(120, 3);
  });

  it('a gable end wall is split at the ridge, so it reaches it', () => {
    expect(wallBreaks(gable, 10, -4, 10, 4)).toEqual([0, 0.5, 1]);
    expect(wallBreaks(gable, -10, -4, 10, -4)).toEqual([0, 1]); // the eave wall stays one quad
  });

  it('GeometryBuilder.pitchedPrism: walls face out, the roof faces up and reaches the ridge', () => {
    const B = new GeometryBuilder();
    B.pitchedPrism(rect, 0, 0, gable, 0xffffff, 0x884433);
    const g = B.build()!;
    const p = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    let top = 0;
    for (let i = 0; i < p.count; i++) top = Math.max(top, p.getY(i));
    expect(top).toBeCloseTo(5, 4);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const out = nrm.getX(i) * x + nrm.getZ(i) * z;
      // every face points away from the house's axis or up
      expect(out > -1e-3 || nrm.getY(i) > 0.3, `${x},${y},${z}`).toBe(true);
    }
  });
});

describe('neighbourhood data (auckland-neighbourhoods.bin)', () => {
  it('is small enough for phones (< 100 kB gzip) and holds Herne Bay and Westhaven', () => {
    expect(NEIGHBOURHOODS_GZ.length).toBeLessThan(100_000);
    expect(decodeNeighbourhoods(NEIGHBOURHOODS_BYTES).map((n) => n.name)).toEqual(['Herne Bay', 'Westhaven']);
    expect(() => decodeNeighbourhoods(NEIGHBOURHOODS_BYTES.subarray(0, NEIGHBOURHOODS_BYTES.length - 3))).toThrow();
  });

  it('Herne Bay: 1,100+ buildings on their measured roofs, inside its footprint and the real-streets region', () => {
    expect(hb.buildings.length).toBeGreaterThan(1100);
    let pitched = 0;
    let tallest = 0;
    for (const parts of hb.buildings)
      for (const p of parts) {
        expect(ringArea(p.ring)).toBeGreaterThan(0);
        expect(p.eave).toBeGreaterThanOrEqual(2.4); // at least a storey over the ground at the centroid
        expect(p.eave).toBeLessThan(70);
        if (p.roof) {
          pitched++;
          expect(p.roof.pitch).toBeGreaterThan(0.1);
          expect(p.roof.pitch).toBeLessThan(1.5);
        }
        tallest = Math.max(tallest, p.eave);
      }
    expect(pitched).toBeGreaterThan(400); // villas and bungalows: most houses have a gable or hip roof
    expect(tallest).toBeGreaterThan(45); // the Sentinel Rd towers (≈ 56 m)
    // the footprint: Jervois Rd to the harbour, Cox's Bay to Shelly Beach Rd
    const sentinel = geoToWorld(-36.8425, 174.733);
    expect(neighbourhoodAt(sentinel.x, sentinel.z)).toBe(hb);
    const ponsonby = geoToWorld(-36.852, 174.742);
    expect(neighbourhoodAt(ponsonby.x, ponsonby.z)).toBe(null);
    for (const parts of hb.buildings) {
      const r = parts[0].ring;
      expect(st.inRegion(r[0], r[1])).toBe(true);
    }
  });

  it('Westhaven: every boat and pontoon of the marina, on the water', () => {
    expect(wh.boats.length).toBeGreaterThan(1500);
    expect(wh.pontoons.length).toBeGreaterThan(300);
    for (const b of wh.boats) {
      expect(neighbourhoodAt(b.x, b.z)).toBe(wh);
      expect(b.length).toBeGreaterThan(3);
      expect(b.length).toBeLessThan(46);
      expect(b.beam).toBeLessThanOrEqual(b.length + 0.2); // (both quantised)
    }
    const sail = wh.boats.filter((b) => b.mast > 0).length;
    expect(sail).toBeGreaterThan(300);
  });

  it('a canopy grid per area: Herne Bay about a third under trees', () => {
    let cov = 0;
    let n = 0;
    const g = hb.canopy;
    for (let j = 0; j < g.nz; j++)
      for (let i = 0; i < g.nx; i++) {
        const x = g.x0 + (i + 0.5) * g.cell;
        const z = g.z0 + (j + 0.5) * g.cell;
        if (!pointInRing(hb.footprint, x, z)) continue;
        cov += canopyAt(g, x, z)!.cover;
        n++;
      }
    expect(cov / n).toBeGreaterThan(0.2);
    expect(cov / n).toBeLessThan(0.45);
  });
});

describe('the neighbourhoods in the building list (applyNeighbourhoods)', () => {
  const bs = aucklandBuildings()!;
  const houses = bs.filter((b) => b.hero === 'house');

  it('replace the LINZ buildings inside their footprints and join with roofs, colours and collision heights', () => {
    expect(houses.length).toBe(hb.buildings.length + wh.buildings.length);
    for (const b of bs) if (b.hero !== 'house') expect(neighbourhoodAt(b.prisms[0].cx, b.prisms[0].cz)).toBe(null);
    const pitched = houses.flatMap((b) => b.prisms).filter((p) => p.pitch);
    expect(pitched.length).toBeGreaterThan(400);
    for (const p of pitched) {
      expect(p.h).toBeCloseTo(ridgeHeight(p.pitch!), 6); // collision box up to the ridge
      expect(roofHeight(p, p.pitch!.cx, p.pitch!.cz)).toBeLessThanOrEqual(p.h + 1e-6);
    }
    expect(houses.every((b) => b.colors)).toBe(true);
  });

  it('are built in the city mesh: measured roofs over the terrain, within a budget of their own', () => {
    const cbd = aucklandCbd();
    const roads = new RoadNetwork(aucklandRoadPaths());
    const height = () => 10;
    const count = (detail: number, list: typeof bs) => {
      const B = new GeometryBuilder();
      return buildCBD(B, new LightList(), height, detail, cbd, roads, list).triangles;
    };
    const linz = bs.filter((b) => b.hero !== 'house');
    const medium = count(0.7, bs) - count(0.7, linz);
    const low = count(0.35, bs) - count(0.35, linz);
    // ≈ 1,200 houses: ~40 triangles each on medium; the low tier drops garages and sheds (< 60 m²)
    expect(medium).toBeLessThan(60_000);
    expect(low).toBeLessThan(medium * 0.8);
  });
});

describe('gardens, trees and the marina', () => {
  it('the street map paints the neighbourhoods as gardens (lawn), off the streets', () => {
    const sentinel = geoToWorld(-36.8425, 174.733);
    const g = st.park(sentinel.x, sentinel.z);
    expect(g).toBeGreaterThan(0.6); // lawn in cbdPattern
    expect(g).toBeLessThan(0.8); // but not a park's painted trees
    expect(Math.abs(g - GARDEN_B / 255)).toBeLessThan(0.05);
  });

  const features = allFeatures('auckland', [airfieldFeature('whenuapai')]);
  const hf = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 1024, features, pads: [] }));
  const m = 512;
  const color = new Uint8Array(m * m * 4);
  bakeColorRows(reduceView(hf, m), { theater: 'auckland', seed: 1840, features }, m, 0, m, color);
  const cmap = new ColorMapSampler(color, m, hf.origin, hf.extent);

  it("trees grow to Herne Bay's measured canopy: its density, never inside a house or on a street", () => {
    const veg = createVegetation('auckland', 1840, features);
    const src = new TreeSource(hf, cmap, veg, 'auckland', 1840, 14, null, aucklandCbd(), nbs);
    const out = { data: [[], [], []] as number[][] };
    const [x0, z0] = [hb.canopy.x0, hb.canopy.z0];
    for (let z = z0; z < z0 + hb.canopy.nz * hb.canopy.cell; z += 280) for (let x = x0; x < x0 + hb.canopy.nx * hb.canopy.cell; x += 280) src.generate(x, z, 280, out);
    const recs: number[][] = [];
    for (const a of out.data) for (let i = 0; i < a.length; i += 11) recs.push(a.slice(i, i + 11));
    const inHb = recs.filter((r) => neighbourhoodAt(r[0], r[2]) === hb);
    expect(inHb.length).toBeGreaterThan(1500);
    const rings = hb.buildings.flatMap((b) => b.map((p) => p.ring));
    let crown = 0;
    for (const r of inHb) {
      expect(rings.some((ring) => pointInRing(ring, r[0], r[2]))).toBe(false);
      expect(st.streetSD(r[0], r[2])).toBeGreaterThanOrEqual(2);
      crown += Math.PI * (r[4] / 2) ** 2;
    }
    // crown area ≈ the measured canopy (≈ 25 ha); trees on streets and in houses are skipped, so a little under
    let measured = 0;
    for (let k = 0; k < hb.canopy.cover.length; k++) measured += (hb.canopy.cover[k] / 15) * hb.canopy.cell ** 2;
    expect(crown / measured).toBeGreaterThan(0.5);
    expect(crown / measured).toBeLessThan(1.3);
  });

  it("Westhaven's marina is the measured one: its boats and pontoons instead of procedural yachts", () => {
    const build = () => buildRealWaterside(new GeometryBuilder(), new LightList(), () => 0, 1, siteLayout()!);
    const withMeasured = build();
    setAucklandNeighbourhoods(null);
    const procedural = build();
    setAucklandNeighbourhoods(NEIGHBOURHOODS_BYTES);
    // every measured boat is built, and Westhaven no longer gets procedural yachts on top of them
    expect(withMeasured).toBeGreaterThanOrEqual(wh.boats.length);
    expect(withMeasured).toBeLessThan(procedural + wh.boats.length);
  });
});
