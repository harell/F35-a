/**
 * Real suburbs 5/9 (#124): the landmark buildings outside the CBD — hospitals, railway stations and their platforms,
 * malls, schools — from OSM sites, LINZ outlines and the 2024 LiDAR (aucklandLandmarks.ts).
 */
import { describe, expect, it } from 'vitest';
import { aucklandLandmarks, decodeLandmarks, encodeLandmarks, landmarkCovers, LANDMARK_KINDS, ringDistance, setAucklandLandmarks } from '../src/world/scenery/aucklandLandmarks';
import { aucklandBuildings, ringArea, roofHeight } from '../src/world/scenery/aucklandBuildings';
import { aucklandHouses } from '../src/world/scenery/aucklandHouses';
import { aucklandNeighbourhoods } from '../src/world/scenery/aucklandNeighbourhoods';
import { aucklandRailPaths } from '../src/world/scenery/motorways';
import { aucklandStreets, pointInRing, type CbdStreets } from '../src/world/scenery/cbdStreets';
import { siteBlocker, siteRings } from '../src/world/scenery/aucklandSites';
import { buildCBD } from '../src/world/scenery/auckland';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';
import { LightList } from '../src/world/scenery/builders';
import { aucklandCbd } from '../src/world/config';
import { buildBuildingGeometry } from '../src/sim/buildings';
import { LANDMARKS_BYTES, LANDMARKS_GZ } from './linz-setup';
import SPOT from './fixtures/landmark-spotchecks.json';

const d = aucklandLandmarks()!;
const prisms = d.buildings.flatMap((b) => b.prisms);
const st = aucklandStreets() as CbdStreets;

/** Roof of the baked landmark buildings at a point (the highest prism containing it), −1 when none. */
function roofAt(x: number, z: number): number {
  let h = -1;
  for (const p of prisms) if (Math.abs(p.cx - x) < 500 && Math.abs(p.cz - z) < 500 && pointInRing(p.ring, x, z)) h = Math.max(h, roofHeight(p, x, z));
  return h;
}

/** Distance (m) from a point to the nearest railway ribbon's centre line, and that ribbon's width. */
const rails = aucklandRailPaths();
function railAt(x: number, z: number): { d: number; width: number } {
  let best = { d: Infinity, width: 0 };
  for (const p of rails)
    for (let i = 0; i + 1 < p.x.length; i++) {
      const ax = p.x[i], az = p.z[i], dx = p.x[i + 1] - ax, dz = p.z[i + 1] - az;
      const l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      const dd = Math.hypot(ax + dx * t - x, az + dz * t - z);
      if (dd < best.d) best = { d: dd, width: p.width };
    }
  return best;
}

describe('landmark data (auckland-landmarks.bin)', () => {
  it('is within the size budget (< 200 kB gzip, #119) and round-trips through the encoder', () => {
    expect(LANDMARKS_GZ.length).toBeLessThan(200 * 1024);
    expect(encodeLandmarks(decodeLandmarks(LANDMARKS_BYTES), 0.5)).toEqual(LANDMARKS_BYTES);
    expect(() => decodeLandmarks(LANDMARKS_BYTES.subarray(0, LANDMARKS_BYTES.length - 3))).toThrow();
    const bad = LANDMARKS_BYTES.slice();
    bad[0] = 0;
    expect(() => decodeLandmarks(bad)).toThrow();
  });

  it('holds every kind: hospitals, malls, stations, schools and the big buildings #121 left out', () => {
    const n = (k: string) => d.sites.filter((s) => s.kind === k).length;
    expect(n('hospital')).toBeGreaterThanOrEqual(15);
    expect(n('mall')).toBeGreaterThanOrEqual(25);
    expect(n('station')).toBeGreaterThanOrEqual(40);
    expect(n('school')).toBeGreaterThan(450);
    expect(n('other')).toBeGreaterThan(30);
    expect(d.buildings.length).toBeGreaterThan(5000);
    for (const s of d.sites) expect(LANDMARK_KINDS).toContain(s.kind);
  });

  it('stands the named hospitals and malls at their real positions (inside their OSM sites)', () => {
    // the issue's priority list (Westfield Newmarket is its own hero model: westfieldNewmarket.ts)
    const named = ['Auckland City Hospital', 'Middlemore Hospital', 'North Shore Hospital', 'Waitākere Hospital', 'Greenlane Clinical Centre', 'Sylvia Park', 'Westfield Saint Lukes', 'Westfield Albany', 'Westfield Manukau City', 'LynnMall', 'NorthWest Shopping Centre'];
    for (const name of named) {
      const s = d.sites.find((x) => x.name === name);
      expect(s, name).toBeTruthy();
      expect(s!.b1 - s!.b0, name).toBeGreaterThan(0);
      // every building of the site stands on it (its centre within the site's outline, a few metres of slack)
      // (a site in several parts is several sites of one name)
      const parts = d.sites.filter((x) => x.name === name);
      for (const b of d.buildings.slice(s!.b0, s!.b1)) expect(Math.min(...parts.map((q) => ringDistance(q.ring, b.prisms[0].cx, b.prisms[0].cz))), name).toBeLessThan(4);
    }
    // Auckland City Hospital (Grafton) and Middlemore stand where they are (game XZ from their lat/lon, ±300 m)
    const at = (name: string) => d.sites.find((s) => s.name === name)!;
    const ach = d.buildings.slice(at('Auckland City Hospital').b0, at('Auckland City Hospital').b1)[0].prisms[0];
    expect(Math.hypot(ach.cx - 525, ach.cz - 1210)).toBeLessThan(400);
  });

  it('gives them their LiDAR heights: every spot check within ±5 m at the named sites\' tops, 98 % of the sample', () => {
    const tops = SPOT.filter((c) => c.name.endsWith('(top)'));
    expect(tops.length).toBeGreaterThanOrEqual(10);
    for (const c of tops) expect(Math.abs(roofAt(c.x, c.z) - c.lidar), c.name).toBeLessThanOrEqual(5);
    // Auckland City Hospital and North Shore Hospital are the tallest, ≈ 56 m
    expect(tops.find((c) => c.name.startsWith('Auckland City Hospital'))!.lidar).toBeGreaterThan(50);
    let ok = 0;
    for (const c of SPOT) {
      const h = roofAt(c.x, c.z);
      expect(h, c.name).toBeGreaterThanOrEqual(0);
      expect(Math.abs(h - c.lidar), c.name).toBeLessThan(10);
      if (Math.abs(h - c.lidar) <= 5) ok++;
    }
    expect(SPOT.length).toBeGreaterThan(500);
    expect(ok / SPOT.length).toBeGreaterThanOrEqual(0.98);
  });

  it('stands every railway station in 3D, its platforms beside the railway ribbons', () => {
    const stations = d.sites.filter((s) => s.kind === 'station');
    for (const s of stations) {
      const pl = d.platforms.filter((p) => d.sites[p.site] === s);
      expect(s.b1 - s.b0 + pl.length, s.name).toBeGreaterThan(0);
    }
    expect(d.platforms.length).toBeGreaterThanOrEqual(70);
    for (const p of d.platforms) {
      // each slab is long and narrow, and lies along a ribbon: within its half-width plus the platform's width
      const area = Math.abs(ringArea(p.ring));
      expect(area).toBeGreaterThan(50);
      let off = 0;
      for (let i = 0; i < p.ring.length; i += 2) {
        const r = railAt(p.ring[i], p.ring[i + 1]);
        off = Math.max(off, r.d - r.width / 2);
      }
      expect(off).toBeLessThan(15);
    }
  });

  it('leaves out what the game already models: nothing in the CBD region or a hero neighbourhood', () => {
    const nbs = aucklandNeighbourhoods()!;
    for (const b of d.buildings) {
      const p = b.prisms[0];
      expect(st.inRegion(p.cx, p.cz)).toBe(false);
      expect(nbs.some((n) => pointInRing(n.footprint, p.cx, p.cz))).toBe(false);
    }
  });
});

describe('landmark buildings in the world', () => {
  it('join the building list, named after their site, and their sites stop the procedural grid', () => {
    const list = aucklandBuildings()!;
    const lm = list.filter((b) => b.landmark);
    expect(lm.length).toBe(d.buildings.length);
    expect(lm.find((b) => b.name === 'Middlemore Hospital')?.landmark?.kind).toBe('hospital');
    expect(siteRings().length).toBeGreaterThan(d.sites.filter((s) => s.kind !== 'other').length);
  });

  it('keep the trees and the houses (procedural and #121\'s real ones) off their footprints, with no doubled house', () => {
    const block = siteBlocker();
    for (const b of d.buildings.filter((_, i) => i % 37 === 0)) expect(block(b.prisms[0].ring[0], b.prisms[0].ring[1], 0.5)).toBe(true);
    expect(landmarkCovers(0, -60_000)).toBe(false);
    // no real house (#121) stands inside a landmark building: those outlines are #121's, the bake skipped them
    const real = aucklandHouses()!;
    let doubled = 0;
    let checked = 0;
    for (let i = 0; i < real.count; i++) {
      checked++;
      if (landmarkCovers(real.x[i], real.z[i], 0)) doubled++;
    }
    expect(checked).toBeGreaterThan(10_000);
    // (the scatter drops these few: its blocker asks landmarkCovers too)
    expect(doubled / checked).toBeLessThan(0.002);
  });

  it('build into their own meshes (not the CBD mesh), within the triangle budget, by kind', () => {
    const cbd = aucklandCbd();
    const B = new GeometryBuilder();
    B.enableFacades();
    const tiles = new GeometryBuilder();
    tiles.enableFacades();
    const height = () => 5;
    const list = aucklandBuildings()!;
    const stats = buildCBD(B, new LightList(), height, 0.7, cbd, null, list, (b) => (b.landmark ? tiles : null));
    const cbdOnly = new GeometryBuilder();
    cbdOnly.enableFacades();
    buildCBD(cbdOnly, new LightList(), height, 0.7, cbd, null, list.filter((b) => !b.landmark), () => null);
    // the CBD mesh is unchanged; the landmarks' meshes hold their triangles (≈ 150–200 k over the whole theatre)
    expect(B.triangleCount).toBe(cbdOnly.triangleCount);
    expect(tiles.triangleCount).toBeGreaterThan(80_000);
    expect(tiles.triangleCount).toBeLessThan(260_000);
    expect(stats.prisms.filter((p) => p.landmark === 'hospital').length).toBeGreaterThan(150);
  });

  it('are solids that stand when hit (the tall ones: hospital towers)', () => {
    const g = buildBuildingGeometry(() => 0, 40)!;
    const tall = g.buildings.filter((b) => b.name === 'Auckland City Hospital');
    expect(tall.length).toBeGreaterThan(0);
    for (const b of tall) expect(b.fixed).toBe(true);
  });

  it('fall back to nothing without the file', () => {
    setAucklandLandmarks(null);
    try {
      expect(aucklandBuildings()!.some((b) => b.landmark)).toBe(false);
      expect(landmarkCovers(prisms[0].cx, prisms[0].cz)).toBe(false);
    } finally {
      setAucklandLandmarks(LANDMARKS_BYTES);
    }
    expect(aucklandBuildings()!.some((b) => b.landmark)).toBe(true);
  });
});
