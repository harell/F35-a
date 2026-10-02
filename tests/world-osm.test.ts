/**
 * Open data 1: the OpenStreetMap layer (src/world/scenery/data/auckland-osm.bin, tools/osm/) and the real
 * airfields built from it — Whenuapai, Auckland Airport, Ardmore and North Shore (Dairy Flat).
 */
import { describe, expect, it } from 'vitest';
import { OSM_BYTES, OSM_GZ } from './linz-setup';
import { AKL } from '../src/core/auckland';
import { AIRFIELD_IDS, AIRFIELDS, airfieldFeature, airfieldNear, airfieldRotation, mainRunway, runwaysOf, type AirfieldId } from '../src/core/airfields';
import { airfieldLayout, aucklandOsm, decodeOsm, OSM_AERODROME, OSM_APRON, OSM_LAST_LAYER, OSM_PIER, OSM_RUNWAY, OSM_TANK, OSM_TAXIWAY, pointInRing, setAucklandOsm } from '../src/world/scenery/aucklandOsm';
import { allFeatures } from '../src/world/scenery/Scenery';
import { airfieldOf, footprintOf, footprintWeight, runwayLengthFor } from '../src/world/terrain/features';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { buildRealAirfield } from '../src/world/scenery/airbase';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';
import { DecalBuilder, LightList } from '../src/world/scenery/builders';
import { FEATURES, P } from '../src/missions/content/common';

const DEG = 180 / Math.PI;
/** Auckland's magnetic variation (≈ 20° E in 2026): runway designators are magnetic. */
const VARIATION = 20;

const terrainFor = (features = allFeatures('auckland', [FEATURES.whenuapai])) =>
  runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 1024, features, pads: [] }));

describe('OSM data file', () => {
  it('is small (≤ 300 kB gzip budget for the whole layer) and decodes', () => {
    expect(OSM_GZ.length).toBeLessThan(120_000);
    const d = decodeOsm(OSM_BYTES);
    expect(d.features.length).toBeGreaterThan(1000);
    expect(d.attribution).toMatch(/© OpenStreetMap contributors/);
    expect(d.attribution).toMatch(/ODbL/);
  });

  it('holds the layers this PR and Open data 2 need, and nothing from LINZ', () => {
    const d = aucklandOsm()!;
    const count = (layer: number) => d.features.filter((f) => f.layer === layer).length;
    expect(count(OSM_AERODROME)).toBeGreaterThanOrEqual(4);
    expect(count(OSM_RUNWAY)).toBeGreaterThan(5);
    expect(count(OSM_TAXIWAY)).toBeGreaterThan(100);
    expect(count(OSM_APRON)).toBeGreaterThan(20);
    expect(count(OSM_PIER)).toBeGreaterThan(100); // Open data 2: wharves, marinas
    expect(count(OSM_TANK)).toBeGreaterThan(20); // Open data 2: Wiri terminal (farm water tanks dropped)
    expect(Math.max(...d.features.map((f) => f.layer))).toBeLessThanOrEqual(OSM_LAST_LAYER);
    // every vertex inside the world (±44 km) — the bake clips to the world box
    for (const f of d.features) for (let i = 0; i < f.pts.length; i++) expect(Math.abs(f.pts[i])).toBeLessThan(50_000);
  });

  it('rejects malformed data and falls back cleanly when the file is missing', () => {
    expect(() => decodeOsm(OSM_BYTES.subarray(0, OSM_BYTES.length - 3))).toThrow();
    const bad = OSM_BYTES.slice();
    bad[0] = 0;
    expect(() => decodeOsm(bad)).toThrow();
    setAucklandOsm(null);
    try {
      expect(airfieldLayout('whenuapai')).toBeNull();
      const fs = allFeatures('auckland', []).filter((f) => f.type === 'airbase');
      expect(fs.map((f) => f.airfield).sort()).toEqual([...AIRFIELD_IDS].sort());
      // template strip on the real main runway: same centre, heading and length
      for (const f of fs) {
        expect(f.outline).toBeUndefined();
        const fp = footprintOf(f);
        expect(fp.kind).toBe('rect');
        const rw = mainRunway(f.airfield as AirfieldId);
        expect(Math.hypot(fp.x - rw.x, fp.z - rw.z)).toBeLessThan(600); // centre offset towards the apron side
        const d = Math.abs(((((f.rotation! - rw.heading * DEG) % 180) + 180) % 180));
        expect(Math.min(d, 180 - d)).toBeLessThan(0.1);
        expect(runwayLengthFor(f)).toBe(Math.round(rw.length));
      }
      // fallback terrain still levels both Whenuapai runways
      const hf = terrainFor();
      const hs: number[] = [];
      for (const rw of runwaysOf('whenuapai')) for (let t = 0; t <= 1; t += 0.1) hs.push(hf.heightAt(rw.ax + (rw.bx - rw.ax) * t, rw.az + (rw.bz - rw.az) * t));
      expect(Math.max(...hs) - Math.min(...hs)).toBeLessThan(1.5);
    } finally {
      setAucklandOsm(OSM_BYTES);
    }
    expect(airfieldLayout('whenuapai')).not.toBeNull();
  });
});

describe('real airfields', () => {
  it('the runway table (src/core/airfields.ts) matches the baked OSM runways', () => {
    const osm = aucklandOsm()!.features.filter((f) => f.layer === OSM_RUNWAY);
    for (const id of AIRFIELD_IDS) {
      for (const rw of runwaysOf(id)) {
        const n = (f: (typeof osm)[number]) => f.pts.length;
        const match = osm.find((f) => {
          const [x0, z0, x1, z1] = [f.pts[0], f.pts[1], f.pts[n(f) - 2], f.pts[n(f) - 1]];
          const same = Math.hypot(x0 - rw.ax, z0 - rw.az) < 5 && Math.hypot(x1 - rw.bx, z1 - rw.bz) < 5;
          const rev = Math.hypot(x1 - rw.ax, z1 - rw.az) < 5 && Math.hypot(x0 - rw.bx, z0 - rw.bz) < 5;
          return f.ref === rw.ref && (same || rev);
        });
        expect(match, `${id} ${rw.ref}`).toBeTruthy();
      }
    }
  });

  it('threshold a is the first designator: true heading ≈ designator × 10° + variation', () => {
    for (const id of AIRFIELD_IDS) {
      for (const rw of runwaysOf(id)) {
        const mag = (((rw.heading * DEG - VARIATION) % 360) + 360) % 360;
        const des = parseInt(rw.names[0], 10) * 10;
        const diff = Math.abs(((mag - des + 540) % 360) - 180);
        expect(diff, `${id} ${rw.ref}: ${(rw.heading * DEG).toFixed(1)}° true`).toBeLessThan(10);
      }
    }
    // the headline values
    expect(mainRunway('whenuapai').heading * DEG).toBeCloseTo(52.8, 0);
    expect(mainRunway('whenuapai').length).toBeGreaterThan(1990);
    expect(mainRunway('whenuapai').length).toBeLessThan(2060);
    expect(runwaysOf('whenuapai')[1].heading * DEG).toBeCloseTo(97.8, 0);
    expect(mainRunway('akl_airport').heading * DEG).toBeCloseTo(71, 0);
    expect(mainRunway('akl_airport').length).toBeGreaterThan(3600);
  });

  it('the landmarks and the mission home base sit on the real main runways', () => {
    for (const id of AIRFIELD_IDS) {
      const rw = mainRunway(id);
      expect(Math.hypot(AKL[id].x - rw.x, AKL[id].z - rw.z), id).toBeLessThan(5);
      expect(airfieldNear(AKL[id].x, AKL[id].z)?.id).toBe(id);
    }
    expect(FEATURES.whenuapai).toEqual(airfieldFeature('whenuapai'));
    expect(Math.hypot(P.whenuapai.x - AIRFIELDS.whenuapai.x, P.whenuapai.z - AIRFIELDS.whenuapai.z)).toBeLessThan(2);
    // the template's apron side (right of the yaw) is where the real aprons are
    for (const id of AIRFIELD_IDS) {
      const lay = airfieldLayout(id)!;
      const h = airfieldRotation(id) / DEG;
      let right = 0;
      let left = 0;
      for (const a of lay.aprons) {
        const u = (a.pts[0] - AIRFIELDS[id].x) * Math.cos(h) + (a.pts[1] - AIRFIELDS[id].z) * Math.sin(h);
        if (u > 0) right++;
        else left++;
      }
      expect(right, id).toBeGreaterThanOrEqual(left);
    }
  });

  it('every airfield has its OSM layout: runways inside a levelled core, taxiways and aprons', () => {
    for (const id of AIRFIELD_IDS) {
      const lay = airfieldLayout(id);
      expect(lay, id).not.toBeNull();
      expect(lay!.taxiways.length, id).toBeGreaterThan(id === 'dairy_flat' ? 0 : 3);
      expect(lay!.aprons.length, id).toBeGreaterThan(0);
      for (const rw of runwaysOf(id)) {
        for (let t = 0.02; t < 1; t += 0.06) expect(pointInRing(lay!.core, rw.ax + (rw.bx - rw.ax) * t, rw.az + (rw.bz - rw.az) * t), `${id} ${rw.ref} ${t}`).toBe(true);
      }
    }
    expect(airfieldLayout('akl_airport')!.terminals.length).toBeGreaterThan(0);
    expect(airfieldLayout('whenuapai')!.hangars.length).toBeGreaterThan(5);
  });

  it('allFeatures: the four real airfields level their OSM outlines; a mission airbase on one is not doubled', () => {
    const fs = allFeatures('auckland', Object.values(FEATURES)).filter((f) => f.type === 'airbase');
    expect(fs.filter((f) => f.airfield).map((f) => f.airfield).sort()).toEqual([...AIRFIELD_IDS].sort());
    expect(fs.length).toBe(5); // + the fictional Waiheke strip
    for (const f of fs.filter((g) => g.airfield)) {
      expect(f.outline!.length).toBeGreaterThan(12);
      const fp = footprintOf(f);
      expect(fp.kind).toBe('poly');
      expect(airfieldOf(f)).toBe(f.airfield);
      // core weight 1 on the runway, 0 far outside the outline + blend
      const rw = mainRunway(f.airfield as AirfieldId);
      expect(footprintWeight(fp, rw.x, rw.z)).toBe(1);
      expect(footprintWeight(fp, rw.x + 9000, rw.z)).toBe(0);
    }
  });

  it('terrain: every paved runway, taxiway and apron of the real airfields is level', () => {
    const hf = terrainFor();
    for (const id of AIRFIELD_IDS) {
      const lay = airfieldLayout(id)!;
      const hs: number[] = [];
      for (const rw of runwaysOf(id)) for (let t = 0; t <= 1; t += 0.05) hs.push(hf.heightAt(rw.ax + (rw.bx - rw.ax) * t, rw.az + (rw.bz - rw.az) * t));
      for (const a of lay.aprons) for (let i = 0; i < a.pts.length; i += 2) hs.push(hf.heightAt(a.pts[i], a.pts[i + 1]));
      expect(Math.max(...hs) - Math.min(...hs), id).toBeLessThan(1.5);
      expect(Math.min(...hs), id).toBeGreaterThan(2);
    }
  });

  it('terrain: flattening follows the outline, not a rotated rectangle', () => {
    // Whenuapai's real cross runway runs 45° off the main one: the old 03/21 rectangle (at 30°) left
    // its west end in the hills; and ground far beyond the outline's blend is untouched
    const flat = terrainFor();
    const raw = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 1024, features: [], pads: [] }));
    const lay = airfieldLayout('whenuapai')!;
    let touched = 0;
    for (let i = 0; i < lay.core.length; i += 2) if (Math.abs(flat.heightAt(lay.core[i], lay.core[i + 1]) - raw.heightAt(lay.core[i], lay.core[i + 1])) > 0.01) touched++;
    expect(touched).toBeGreaterThan(0);
    // 3 km beyond Ardmore's outline (blend 1.5 km): no change
    const ard = AIRFIELDS.ardmore;
    expect(flat.heightAt(ard.x + 4500, ard.z + 2000)).toBeCloseTo(raw.heightAt(ard.x + 4500, ard.z + 2000), 3);
  });
});

describe('airfield scenery from OSM', () => {
  const flat = () => 10;

  for (const id of AIRFIELD_IDS) {
    it(`${id}: builds runways, taxiways, aprons, buildings and lights on the real runway ends`, () => {
      const lay = airfieldLayout(id)!;
      const runways = runwaysOf(id);
      const b = new GeometryBuilder();
      const decals = new Map<string, DecalBuilder>();
      const concrete = new DecalBuilder();
      const lights = new LightList();
      buildRealAirfield(lay, runways, { buildings: b, runway: (rw) => decals.get(rw.ref) ?? decals.set(rw.ref, new DecalBuilder()).get(rw.ref)!, concrete, lights }, flat, 1);
      // a runway decal per paved runway, concrete for taxiways / aprons, a tower at least
      expect([...decals.keys()].sort()).toEqual(runways.filter((r) => r.paved).map((r) => r.ref).sort());
      const cg = concrete.build()!;
      expect(cg.index!.count / 3).toBeGreaterThan(20);
      // decals face up (normals from the wound triangles)
      const pos = cg.getAttribute('position');
      const idx = cg.index!;
      for (let t = 0; t < idx.count; t += 3) {
        const [a, bb, c] = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
        const up = (pos.getZ(bb) - pos.getZ(a)) * (pos.getX(c) - pos.getX(a)) - (pos.getX(bb) - pos.getX(a)) * (pos.getZ(c) - pos.getZ(a));
        expect(up).toBeGreaterThanOrEqual(-1e-6);
      }
      expect(b.triangleCount).toBeGreaterThan(20);
      // green threshold lights across both ends of each paved runway
      for (const rw of runways.filter((r) => r.paved)) {
        for (const [ex, ez] of [[rw.ax, rw.az], [rw.bx, rw.bz]]) {
          let n = 0;
          lights.forEach((x, _y, z, r, g) => {
            if (g > 0.5 && r < 0.4 && Math.hypot(x - ex, z - ez) < rw.width) n++;
          });
          expect(n, `${id} ${rw.ref}`).toBeGreaterThanOrEqual(8);
        }
      }
    });
  }

  it('taxiways stop at the runway edge (no concrete over the runway markings)', () => {
    const lay = airfieldLayout('akl_airport')!;
    const rw = mainRunway('akl_airport');
    const concrete = new DecalBuilder();
    buildRealAirfield(lay, [rw], { buildings: new GeometryBuilder(), runway: () => new DecalBuilder(), concrete, lights: new LightList() }, () => 5, 1);
    const pos = concrete.build()!.getAttribute('position');
    const sh = Math.sin(rw.heading);
    const ch = Math.cos(rw.heading);
    let inside = 0;
    for (let i = 0; i < pos.count; i++) {
      const dx = pos.getX(i) - rw.x;
      const dz = pos.getZ(i) - rw.z;
      const u = dx * ch + dz * sh;
      const v = dx * sh - dz * ch;
      if (Math.abs(u) < rw.width / 2 - 4 && Math.abs(v) < rw.length / 2 - 4) inside++;
    }
    expect(inside).toBe(0);
  });
});
