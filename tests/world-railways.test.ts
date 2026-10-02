/**
 * Civil traffic 4/6 (#31): the LINZ railway lines (Topo50 railway centrelines, baked into
 * auckland-roads.bin by tools/linz/railways.ts) drawn as ribbons, with houses and trees kept off the tracks.
 */
import { describe, expect, it } from 'vitest';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { allFeatures } from '../src/world/scenery/Scenery';
import { bakeColorRows } from '../src/world/terrain/bake';
import { reduceView } from '../src/world/terrain/parallel';
import { createVegetation } from '../src/world/terrain/vegetation';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';
import { LightList } from '../src/world/scenery/builders';
import { aucklandRailPaths, aucklandRoadPaths, RoadNetwork } from '../src/world/scenery/motorways';
import { ColorMapSampler, HouseSource, TreeSource } from '../src/world/scenery/sources';
import { aucklandRoads, encodeRoads, ROAD_RAIL } from '../src/world/scenery/aucklandRoads';
import { AKL_CBD_GRID } from '../src/world/config';
import { QUALITY_PRESETS } from '../src/core/data';
import { geoToWorld } from '../src/core/auckland';

interface Zlib {
  gzipSync(b: Uint8Array, o?: { level: number }): Uint8Array;
}
const zlib = (await import(/* @vite-ignore */ 'node:zlib' as string)) as Zlib;

const data = aucklandRoads()!;
const railLines = data.lines.filter((l) => l.kind === ROAD_RAIL);
const rails = new RoadNetwork(aucklandRailPaths());

/** Distance (m) from a point to the nearest railway line of `name` (any line when omitted), tunnels included. */
function railDistance(lat: number, lon: number, name?: string): number {
  const { x, z } = geoToWorld(lat, lon);
  let best = Infinity;
  for (const l of railLines) {
    if (name && l.name !== name) continue;
    const p = l.pts;
    for (let i = 2; i < p.length; i += 2) {
      const ax = p[i - 2];
      const az = p[i - 1];
      const dx = p[i] - ax;
      const dz = p[i + 1] - az;
      const l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
    }
  }
  return best;
}

const km = (ls: typeof railLines) =>
  ls.reduce((s, l) => {
    for (let i = 2; i < l.pts.length; i += 2) s += Math.hypot(l.pts[i] - l.pts[i - 2], l.pts[i + 1] - l.pts[i - 1]);
    return s;
  }, 0) / 1000;

describe('LINZ railway lines (auckland-roads.bin)', () => {
  it('are small: the railway lines take < 50 kB gzip', () => {
    const gz = zlib.gzipSync(encodeRoads({ region: new Float32Array(0), lines: railLines }), { level: 9 });
    expect(gz.length).toBeLessThan(50 * 1024);
    expect(railLines.length).toBeGreaterThan(20);
  });

  it('hold the NIMT, the Western, Eastern and Onehunga lines through their stations, clipped to the world', () => {
    expect(km(railLines)).toBeGreaterThan(150);
    for (const l of railLines) for (const v of l.pts) expect(Math.abs(v)).toBeLessThanOrEqual(44_000);
    const NIMT = 'NORTH ISLAND MAIN TRUNK';
    const WESTERN = 'NORTH AUCKLAND LINE';
    const ONEHUNGA = 'ONEHUNGA BRANCH';
    // station positions from memory (±300 m): the line has to run through the suburb, not past it
    const stations: [string, number, number, string][] = [
      // Eastern line (the NIMT along the Waitematā waterfront and through the eastern suburbs)
      ['Ōrākei', -36.8655, 174.8105, NIMT],
      ['Glen Innes', -36.879, 174.8545, NIMT],
      ['Panmure', -36.8985, 174.85, NIMT],
      // Southern
      ['Ōtāhuhu', -36.944, 174.836, NIMT],
      ['Papakura', -37.0645, 174.9455, NIMT],
      // Western
      ['Kingsland', -36.8723, 174.7445, WESTERN],
      ['Mt Albert', -36.8846, 174.7196, WESTERN],
      ['Henderson', -36.8813, 174.631, WESTERN],
      ['Swanson', -36.867, 174.577, WESTERN],
      // Onehunga
      ['Onehunga', -36.9235, 174.786, ONEHUNGA],
    ];
    for (const [station, lat, lon, line] of stations) expect(railDistance(lat, lon, line), station).toBeLessThan(500);
    // Britomart: the lines end at the downtown terminus, in its approach tunnel
    expect(railDistance(-36.8442, 174.7676)).toBeLessThan(150);
    expect(railLines.some((l) => l.tunnel)).toBe(true);
  });

  it('are left out of the road ribbons and have no hand-traced fallback', () => {
    expect(aucklandRoadPaths().some((p) => p.kind === 'rail')).toBe(false);
    expect(aucklandRailPaths(null)).toEqual([]);
    const paths = aucklandRailPaths();
    expect(paths.every((p) => p.kind === 'rail' && p.width >= 6)).toBe(true);
    // double track: the whole two-track texture; single track: half of it
    expect(paths.some((p) => p.span === 1) && paths.some((p) => p.span === 0.5)).toBe(true);
  });
});

describe('railway ribbons', () => {
  const flat = () => 10;
  const roads = new RoadNetwork([...aucklandRoadPaths(), ...aucklandRailPaths()]);

  it('build one mesh of their own, without lamp posts, next to the road mesh', () => {
    const lights = new LightList();
    const rail = roads.buildRibbons(flat, new GeometryBuilder(), lights, true, (p) => p.kind === 'rail');
    expect(lights.count).toBe(0);
    const road = roads.buildRibbons(flat, new GeometryBuilder(), new LightList(), false, (p) => p.kind !== 'rail');
    const all = roads.buildRibbons(flat, new GeometryBuilder(), new LightList(), false);
    const verts = (g: typeof rail) => g.getAttribute('position').count;
    expect(verts(rail)).toBeGreaterThan(5000);
    expect(verts(rail) + verts(road)).toBe(verts(all));
  });

  it('can be turned off per quality tier (on by default)', () => {
    for (const q of Object.values(QUALITY_PRESETS)) expect(q.railways).toBe(true);
  });
});

describe('houses and trees keep off the tracks', () => {
  const features = allFeatures('auckland', []);
  const hf = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 1024, features, pads: [] }));
  const height = (x: number, z: number) => hf.meshHeightAt(x, z);
  const m = 512;
  const color = new Uint8Array(m * m * 4);
  bakeColorRows(reduceView(hf, m), { theater: 'auckland', seed: 1840, features }, m, 0, m, color);
  const cmap = new ColorMapSampler(color, m, hf.origin, hf.extent);
  // the game's blocker: roads and railways in one network
  const network = new RoadNetwork([...aucklandRoadPaths(), ...aucklandRailPaths()]);
  const blocked = (x: number, z: number, mm: number) => network.near(x, z, mm);
  // suburban stretches of the Western line (Kingsland – Mt Albert) and the Eastern line (Glen Innes):
  // the track point nearest each
  const along = [geoToWorld(-36.8762, 174.736), geoToWorld(-36.8805, 174.726), geoToWorld(-36.879, 174.8545)].map((q) => {
    let best = { x: 0, z: 0, d: Infinity };
    for (const p of aucklandRailPaths())
      for (let i = 0; i < p.x.length; i++) {
        const d = Math.hypot(p.x[i] - q.x, p.z[i] - q.z);
        if (d < best.d && !p.tunnel[i]) best = { x: p.x[i], z: p.z[i], d };
      }
    return best;
  });

  it('no 3D houses on the tracks', () => {
    const src = new HouseSource(hf, cmap, height, AKL_CBD_GRID, blocked);
    let n = 0;
    for (const p of along) {
      const out = { data: [[], []] as number[][] };
      for (let dz = -450; dz <= 450; dz += 300) for (let dx = -450; dx <= 450; dx += 300) src.generate(p.x + dx, p.z + dz, 300, out);
      for (const arr of out.data)
        for (let i = 0; i < arr.length; i += 11) {
          n++;
          expect(rails.edgeDistance(arr[i], arr[i + 2])).toBeGreaterThan(5);
        }
    }
    expect(n).toBeGreaterThan(200);
    // …and the railway really runs there
    for (const p of along) {
      expect(p.d).toBeLessThan(600);
      expect(rails.edgeDistance(p.x, p.z)).toBeLessThan(0);
    }
  });

  it('no trees on the tracks', () => {
    const veg = createVegetation('auckland', 1840, features);
    const src = new TreeSource(hf, cmap, veg, 'auckland', 1840, 14, blocked, AKL_CBD_GRID);
    let n = 0;
    for (const p of along) {
      const out = { data: [[], [], []] as number[][] };
      for (let dz = -400; dz <= 400; dz += 400) for (let dx = -400; dx <= 400; dx += 400) src.generate(p.x + dx, p.z + dz, 400, out);
      for (const arr of out.data)
        for (let i = 0; i < arr.length; i += 11) {
          n++;
          expect(rails.edgeDistance(arr[i], arr[i + 2])).toBeGreaterThan(0);
        }
    }
    expect(n).toBeGreaterThan(100);
  });

  it('without the railways in the network, houses would stand on the tracks (the test can fail)', () => {
    const roadsOnly = new RoadNetwork(aucklandRoadPaths());
    const src = new HouseSource(hf, cmap, height, AKL_CBD_GRID, (x, z, mm) => roadsOnly.near(x, z, mm));
    let onTrack = 0;
    for (const p of along) {
      const out = { data: [[], []] as number[][] };
      for (let dz = -450; dz <= 450; dz += 300) for (let dx = -450; dx <= 450; dx += 300) src.generate(p.x + dx, p.z + dz, 300, out);
      for (const arr of out.data) for (let i = 0; i < arr.length; i += 11) if (rails.edgeDistance(arr[i], arr[i + 2]) < 0) onTrack++;
    }
    expect(onTrack).toBeGreaterThan(0);
  });
});
