/**
 * Real suburbs 6/9 (#125): the helipad table (src/core/sites.ts HELIPADS, baked by tools/osm/helipads.py from
 * OpenStreetMap with rooftop heights from the 2024 LiDAR) and the pads the scenery draws.
 */
import { describe, expect, it } from 'vitest';
import { MANIFEST } from './landuse-setup';
import { HELIPADS, helipad, helipadArea, HELIPAD_AREAS, type Helipad } from '../src/core/sites';
import { geoToWorld } from '../src/core/auckland';
import { aucklandOsm, OSM_HELIPAD } from '../src/world/scenery/aucklandOsm';
import { buildHelipadDecks, buildHelipads, padIsConcrete, padIsLit, padSurface, roofLookup } from '../src/world/scenery/helipads';
import { aucklandBuildings } from '../src/world/scenery/aucklandBuildings';
import { DecalBuilder, LightList } from '../src/world/scenery/builders';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';

const M = MANIFEST.helipads;
const near = (lat: number, lon: number, r: number) => {
  const p = geoToWorld(lat, lon);
  return HELIPADS.filter((h) => Math.hypot(h.x - p.x, h.z - p.z) < r);
};

describe('helipad table', () => {
  it('holds every OSM helipad and heliport in the world box (the bake’s count)', () => {
    expect(HELIPADS.length).toBe(M.total);
    // ≈ 85 helipads + 2 heliports in OSM (#125, 2026-07 snapshot): a few pads are mapped twice (node + polygon)
    expect(M.osm_objects).toBeGreaterThanOrEqual(85);
    expect(M.total).toBeGreaterThanOrEqual(80);
    expect(HELIPADS.filter((h) => h.heliport).length).toBe(M.heliports);
    expect(M.heliports).toBeGreaterThanOrEqual(2);
    expect(new Set(HELIPADS.map((h) => h.id)).size).toBe(HELIPADS.length);
    for (const h of HELIPADS) {
      expect(Math.abs(h.x)).toBeLessThan(41_000);
      expect(Math.abs(h.z)).toBeLessThan(41_000);
      expect(h.size).toBeGreaterThan(3);
      expect(h.size).toBeLessThan(120);
      expect(h.heading).toBeGreaterThanOrEqual(0);
      expect(h.heading).toBeLessThan(Math.PI + 1e-6);
    }
  });

  it('counts pads per area (Waiheke, isthmus, North Shore) as the manifest does', () => {
    const count: Record<string, number> = {};
    for (const h of HELIPADS) {
      const a = helipadArea(h.x, h.z);
      expect(a).toBe(h.area);
      count[a] = (count[a] ?? 0) + 1;
    }
    expect(count).toEqual(M.by_area);
    for (const a of ['waiheke', 'isthmus', 'north_shore']) expect(count[a], a).toBeGreaterThan(5);
    expect(Object.keys(HELIPAD_AREAS)).toEqual(['waiheke', 'north_shore', 'isthmus']);
  });

  it('has all of Waiheke’s pads, east of the old extract’s lon 175.05 too', () => {
    const wai = HELIPADS.filter((h) => h.area === 'waiheke');
    expect(wai.length).toBe(M.by_area.waiheke);
    const east = wai.filter((h) => h.x > geoToWorld(-36.8, 175.05).x);
    expect(east.length).toBeGreaterThan(5);
    // the rescue helicopter's Onetangi Sports Park pad (#144)
    expect(near(-36.80548, 175.06987, 120).length).toBeGreaterThan(0);
  });

  it('puts Auckland City Hospital’s pad on its roof, within 2 m of the LiDAR roof; Middlemore’s is a ground pad', () => {
    const ach = helipad('auckland_city_hospital')!;
    expect(ach.kind).toBe('hospital');
    expect(ach.roof).toBe(true);
    const lidar = M.roof_pads.auckland_city_hospital;
    expect(Math.abs(ach.height - lidar.dsm)).toBeLessThan(2);
    expect(ach.height - lidar.dem).toBeGreaterThan(8); // a building's height above the ground
    // within 150 m of the issue's position for the Grafton roof pad
    expect(near(-36.85924, 174.76818, 150).some((h) => h.id === ach.id)).toBe(true);
    const mm = HELIPADS.find((h) => h.site === 'Middlemore Hospital')!;
    expect(mm).toBeDefined();
    expect(mm.roof).toBe(false); // the 2024 photo and LiDAR: a pad on the lawn east of the wards
  });

  it('keeps the bake’s helipad layer in step (nodes and polygons, as points with their size)', () => {
    const layer = aucklandOsm()!.features.filter((f) => f.layer === OSM_HELIPAD);
    expect(layer.length).toBe(MANIFEST.layers.helipad);
    expect(MANIFEST.layers.helipad).toBe(M.osm_objects);
  });
});

describe('helipad scenery', () => {
  it('lays one marked square per pad, rooftop pads at their LiDAR roof, lights on hospital and airfield pads', () => {
    const decal = new DecalBuilder();
    const lights = new LightList();
    const flat = () => 5;
    const roofAt = roofLookup(aucklandBuildings(), flat);
    const ach = helipad('auckland_city_hospital')!;
    const n = buildHelipads(decal, lights, flat, roofAt);
    expect(n).toBe(HELIPADS.length);
    const lit = HELIPADS.filter(padIsLit).length;
    expect(lit).toBeGreaterThan(10);
    expect(lights.count).toBe(lit * 12);
    const g = decal.build()!;
    // 4 vertices per pad (one grid cell)
    expect(g.getAttribute('position').count).toBe(n * 4);
    // the rooftop pad is drawn at its LiDAR roof
    expect(padSurface(ach, flat, roofAt(ach.x, ach.z)).at(ach.x, ach.z)).toBeCloseTo(ach.height + 0.25, 5);
    // The game models no building under it yet (the LINZ CBD buildings stop short of Grafton; #124 adds the
    // hospitals): it stands on a block from the ground up to the pad instead of floating, as do the other rooftop pads
    // on land the game draws no building under
    expect(roofAt(ach.x, ach.z)).toBeNull();
    const B = new GeometryBuilder();
    const decks = buildHelipadDecks(B, flat, roofAt);
    const unseated = HELIPADS.filter((h) => h.roof && roofAt(h.x, h.z) === null && h.height - 4 >= 2);
    expect(decks).toBe(unseated.length);
    expect(decks).toBeGreaterThanOrEqual(1);
    let top = -Infinity;
    const pos = B.build()!.getAttribute('position');
    for (let i = 0; i < pos.count; i++) top = Math.max(top, pos.getY(i));
    expect(top).toBeCloseTo(Math.max(...unseated.map((h) => h.height)), 3);
    const grassy = HELIPADS.filter((h: Helipad) => !padIsConcrete(h));
    expect(grassy.length).toBeGreaterThan(0);
  });
});
