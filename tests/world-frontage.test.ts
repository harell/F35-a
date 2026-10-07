/**
 * The arterials and main streets (LINZ) are lined with lots that face them (frontage.ts), and the suburbs' street
 * grid turns to the arterial that runs through a district (urbanGrid.ts districtAngles): blocks laid out along
 * the roads, not cut across by them.
 */
import { describe, expect, it } from 'vitest';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { allFeatures } from '../src/world/scenery/Scenery';
import { aucklandRailPaths, aucklandRoadPaths, clipRailToLand, RoadNetwork } from '../src/world/scenery/motorways';
import { bakeColorRows } from '../src/world/terrain/bake';
import { reduceView } from '../src/world/terrain/parallel';
import { ColorMapSampler, HouseSource } from '../src/world/scenery/sources';
import { LotMask, maskFromRings, urbanBounds } from '../src/world/scenery/lotMask';
import { aucklandCbd } from '../src/world/config';
import { siteRings } from '../src/world/scenery/aucklandSites';
import { inTownCentre } from '../src/world/scenery/auckland';
import {
  FRONT_APARTMENT,
  FRONT_BAND,
  FRONT_DEPTH,
  FRONT_EMPTY,
  FRONT_FOOTPATH,
  FRONT_HOUSE,
  FRONT_SHOP,
  FRONT_TEX_W,
  FrontageMap,
  lotAlong,
  sideStreetFamilies,
  type FrontHouse,
} from '../src/world/scenery/frontage';
import { aucklandRoads, ROAD_ARTERIAL } from '../src/world/scenery/aucklandRoads';
import { BLOCK_D, BLOCK_W, districtAt, districtAngles, hash12, toLocal } from '../src/world/scenery/urbanGrid';
import { terrainFragmentShader } from '../src/world/terrain/terrainShader';

const features = allFeatures('auckland', []);
const hf = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 1024, features, pads: [] }));
const height = (x: number, z: number) => hf.meshHeightAt(x, z);
const m = 512;
const color = new Uint8Array(m * m * 4);
bakeColorRows(reduceView(hf, m), { theater: 'auckland', seed: 1840, features }, m, 0, m, color);
const cmap = new ColorMapSampler(color, m, hf.origin, hf.extent);
const network = new RoadNetwork([...aucklandRoadPaths(), ...clipRailToLand(aucklandRailPaths(), height)]);
const cbd = aucklandCbd();
const site = maskFromRings(siteRings(), 8);
const t0 = performance.now();
const map = new FrontageMap(network.paths, {
  ribbonEdge: (x, z) => network.edgeDistance(x, z),
  urban: (x, z) => cmap.urban(x, z),
  ground: height,
  excluded: (x, z) => (site?.masked(x, z) ?? false) || cbd.streets!.regionSD(x, z) > -4,
  centre: inTownCentre,
  cbd,
}, urbanBounds(color, m, hf.origin, hf.extent));
const buildMs = performance.now() - t0;
const urban = urbanBounds(color, m, hf.origin, hf.extent)!;
const lotMask = LotMask.fromSegments(network.segmentsWith((p) => (p.kind === 'arterial' ? FRONT_BAND : 0)), urban);
const all: FrontHouse[] = map.housesIn(-44000, -44000, 88000);

/** A house's footprint corners (x, z). */
function corners(x: number, z: number, yaw: number, w: number, d: number): [number, number][] {
  // the instance's local X (width) is at world angle −yaw
  const c = Math.cos(-yaw);
  const s = Math.sin(-yaw);
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([a, b]) => [x + (c * a * w) / 2 - (s * b * d) / 2, z + (s * a * w) / 2 + (c * b * d) / 2]);
}

describe('arterial frontage (frontage.ts)', () => {
  it('builds in a reasonable time, with compact textures', () => {
    console.log(`frontage: ${map.segments.length} segments, lots ${map.counts.join('/')} (empty/house/apt/shop), ${map.cols}×${map.rows} cells, list ${map.listRows} rows, ${buildMs.toFixed(0)} ms`);
    expect(buildMs).toBeLessThan(6000);
    expect(map.cellData.length + map.listData.length + map.segData.byteLength + map.flagData.length).toBeLessThan(4 * 1024 * 1024);
  });

  it('lines the arterials with houses, shops in the town centres', () => {
    expect(map.counts[FRONT_HOUSE]).toBeGreaterThan(10_000);
    expect(map.counts[FRONT_SHOP]).toBeGreaterThan(200);
    expect(map.counts[FRONT_APARTMENT] + map.counts[FRONT_EMPTY]).toBeGreaterThan(0);
    // Dominion Rd through Mt Eden, Remuera Rd: built up along most of the way
    for (const [name, x, z] of [
      ['Dominion Rd', -1430, 3750],
      ['Remuera Rd', 3300, 3000],
    ] as const) {
      const near = map.housesIn(x - 400, z - 400, 800);
      expect(near.length, name).toBeGreaterThan(20);
    }
  });

  // (all ≈ 30k houses, four corners each: ≈ 3 s here, more on the CI runner)
  it('every house faces its road: square to it, set back behind the footpath', { timeout: 30_000 }, () => {
    for (const h of all) {
      const s = map.segments[h.seg];
      const hit = map.at(h.x, h.z)!;
      expect(hit.seg).toBe(h.seg);
      expect(hit.lot).toBe(h.lot);
      // the house's walls run along / square to the road
      const a = Math.abs(Math.sin(2 * (-h.yaw - Math.atan2(s.uz, s.ux))));
      expect(a).toBeLessThan(1e-6);
      for (const [cx, cz] of corners(h.x, h.z, h.yaw, h.w, h.d)) {
        const c = map.at(cx, cz);
        // inside its own lot, behind the footpath
        expect(c && c.seg === h.seg && c.lot === h.lot, `house corner off its lot at ${cx.toFixed(0)}, ${cz.toFixed(0)}`).toBe(true);
        expect(c!.kerb).toBeGreaterThan(FRONT_FOOTPATH - 0.01);
      }
    }
  });

  it('no house stands on a road or railway ribbon, or on another lot’s house', () => {
    let bad = 0;
    for (const h of all) for (const [cx, cz] of corners(h.x, h.z, h.yaw, h.w, h.d)) if (network.edgeDistance(cx, cz) < 1) bad++;
    expect(bad).toBe(0);
    // overlaps between frontage houses (by bucket)
    let overlaps = 0;
    for (const h of all) {
      for (const o of map.housesIn(h.x - 40, h.z - 40, 80)) {
        if (o === h) continue;
        const r = Math.hypot(h.w, h.d) / 2 + Math.hypot(o.w, o.d) / 2;
        if (Math.hypot(o.x - h.x, o.z - h.z) > r) continue;
        if (corners(o.x, o.z, o.yaw, o.w, o.d).some(([x, z]) => insideRect(h, x, z))) overlaps++;
      }
    }
    expect(overlaps).toBe(0);
  });

  it('the grid’s houses keep behind the band: none stands on a frontage lot', () => {
    const src = new HouseSource(hf, cmap, height, cbd, null, lotMask);
    const out = { data: [[], []] as number[][] };
    for (const [x, z] of [
      [-1430, 3750],
      [3300, 3000],
      [-4126, 3800],
    ])
      for (let dz = -600; dz < 600; dz += 300) for (let dx = -600; dx < 600; dx += 300) src.generate(x + dx, z + dz, 300, out);
    let n = 0;
    let inBand = 0;
    for (const recs of out.data)
      for (let i = 0; i < recs.length; i += 12) {
        n++;
        for (const [cx, cz] of corners(recs[i], recs[i + 2], recs[i + 3], recs[i + 4], recs[i + 6])) {
          const hit = map.at(cx, cz);
          if (hit && hit.kerb < FRONT_BAND - 0.5) {
            inBand++;
            break;
          }
        }
      }
    expect(n).toBeGreaterThan(300);
    expect(inBand).toBe(0);
  });

  it('side streets: no grid street that crosses the band runs through a frontage house', () => {
    let bad = 0;
    for (const h of all) {
      const s = map.segments[h.seg];
      for (const [cx, cz] of [[h.x, h.z], ...corners(h.x, h.z, h.yaw, h.w, h.d)]) {
        const d = districtAt(cx, cz, undefined, undefined, cbd);
        const [fx, fz] = sideStreetFamilies(d, s.ux, s.uz);
        const [px, pz] = toLocal(d, cx, cz);
        const ex = Math.abs(px - Math.round(px / BLOCK_W) * BLOCK_W);
        const ez = Math.abs(pz - Math.round(pz / BLOCK_D) * BLOCK_D);
        if ((fx && ex < 4.3) || (fz && ez < 4.3)) bad++;
      }
    }
    expect(bad).toBe(0);
  });

  it('the shader reads the same lots back from the textures (a port of frontageLot())', () => {
    const f = Math.fround;
    const fetch = (data: Uint8Array, i: number) => data[i * 4] + data[i * 4 + 1] * 256 + data[i * 4 + 2] * 65536;
    const glsl = (x: number, z: number) => {
      const ci = Math.floor(f(f(x - map.x0) / map.cell));
      const cj = Math.floor(f(f(z - map.z0) / map.cell));
      if (ci < 0 || cj < 0 || ci >= map.cols || cj >= map.rows) return null;
      const q = cj * map.cols + ci;
      const count = map.cellData[q * 4 + 3];
      if (!count) return null;
      const start = fetch(map.cellData, q);
      let best = -1;
      let bd = FRONT_BAND;
      let bs = 0;
      let bt = 0;
      for (let i = 0; i < count; i++) {
        const k = fetch(map.listData, start + i);
        const A = map.segData.subarray(k * 16, k * 16 + 8);
        const vx = f(x - A[0]);
        const vz = f(z - A[1]);
        const s = f(f(vx * A[2]) + f(vz * A[3]));
        const t = f(f(-vx * A[3]) + f(vz * A[2]));
        const d = f(Math.hypot(s - Math.min(Math.max(s, 0), A[4]), t) - A[5]);
        if (d < bd) {
          bd = d;
          best = k;
          bs = s;
          bt = t;
        }
      }
      if (best < 0) return null;
      const side = bt >= 0 ? 0 : 1;
      const L = map.segData.subarray(best * 16 + 8 + side * 4, best * 16 + 12 + side * 4);
      const ly = Math.abs(bt) - map.segData[best * 16 + 5] - FRONT_FOOTPATH;
      // (L = s0, lot width, lots, side-street period)
      const lot = L[2] > 0 && ly >= 0 && ly < FRONT_DEPTH ? lotAlong(bs - L[0], L[1], L[3], L[2])[0] : -1;
      const kind = lot >= 0 ? map.flagData[map.segData[best * 16 + 6 + side] + lot] : 0;
      return { seg: best, lot, kind };
    };
    let checked = 0;
    for (const h of all.filter((_, i) => i % 7 === 0)) {
      const g = glsl(h.x, h.z)!;
      expect(g.seg).toBe(h.seg);
      expect(g.lot).toBe(h.lot);
      expect(g.kind).toBe(h.kind);
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
    expect(map.segData.length).toBe(FRONT_TEX_W * map.segRows * 4);
    // the lot hash is the same expression
    expect(terrainFragmentShader).toContain('lh = hash12(vec2(fLot.w + 17.0, fId.x + 101.0));');
    expect(terrainFragmentShader).toContain('n = v < 0.0 || j >= m ? -1.0 : b * m + j;');
    expect(hash12(3 + 17, 5 * 2 + 1 + 101)).toBeGreaterThanOrEqual(0);
  });
});

describe('district grids turn to their arterials (urbanGrid.ts districtAngles)', () => {
  it('districts with an arterial through them get its direction (modulo 90°)', () => {
    const a = districtAngles();
    expect(a).not.toBeNull();
    let n = 0;
    let aligned = 0;
    for (const l of aucklandRoads()!.lines) {
      if (l.kind !== ROAD_ARTERIAL) continue;
      for (let i = 0; i + 3 < l.pts.length; i += 2) {
        const dx = l.pts[i + 2] - l.pts[i];
        const dz = l.pts[i + 3] - l.pts[i + 1];
        if (Math.hypot(dx, dz) < 60) continue;
        const d = districtAt((l.pts[i] + l.pts[i + 2]) / 2, (l.pts[i + 1] + l.pts[i + 3]) / 2, undefined, undefined, cbd);
        if (d.real) continue;
        n++;
        // angle between the road and the nearest grid axis
        const off = Math.abs(Math.sin(2 * (Math.atan2(dz, dx) - d.angle)));
        if (off < Math.sin(2 * (20 * Math.PI) / 180)) aligned++;
      }
    }
    expect(n).toBeGreaterThan(500);
    // most long straight stretches run along their district's grid (bends and crossings don't)
    expect(aligned / n).toBeGreaterThan(0.6);
  });
});

function insideRect(h: FrontHouse, x: number, z: number): boolean {
  const c = Math.cos(h.yaw);
  const s = Math.sin(h.yaw);
  // inverse of corners(): local = R(yaw) · (p − centre)
  const vx = x - h.x;
  const vz = z - h.z;
  const lx = c * vx - s * vz;
  const lz = s * vx + c * vz;
  return Math.abs(lx) < h.w / 2 - 0.05 && Math.abs(lz) < h.d / 2 - 0.05;
}
