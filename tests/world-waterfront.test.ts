/**
 * The Tāmaki Drive waterfront (tools/hero/sites/tamaki_drive.py → tamaki_drive_bake.py → world/scenery/tamakiWaterfront.ts):
 * the baked data, where it stands in the game, the road resting on its measured floor instead of a viaduct over the
 * Hobson Bay causeway, the meshes and the measured trees.
 */
import { describe, expect, it } from 'vitest';
import { geoToWorld } from '../src/core/auckland';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { allFeatures } from '../src/world/scenery/Scenery';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';
import { LightList } from '../src/world/scenery/builders';
import { aucklandRoadPaths, RoadNetwork } from '../src/world/scenery/motorways';
import {
  applyWaterfrontFloor, buildTamakiWaterfront, decodeWaterfront, inWaterfrontStrip, tamakiWaterfront, waterfrontChunks, waterfrontRoadFloor, waterfrontTreesIn,
  WF_CYCLEWAY, WF_FILL, WF_FOOTPATH, WF_ROAD, WF_SHARED_PATH,
} from '../src/world/scenery/tamakiWaterfront';
import { WATERFRONT_BYTES, WATERFRONT_GZ } from './linz-setup';

const hf = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 1024, features: allFeatures('auckland', []), pads: [] }));
const height = (x: number, z: number) => hf.meshHeightAt(x, z);
const wf = tamakiWaterfront()!;
// the Hobson Bay causeway, half-way along (OSM: Tāmaki Drive over the bay, ~600 m east of The Strand)
const CAUSEWAY = geoToWorld(-36.8481, 174.7913);

const length = (x: Float32Array, z: Float32Array) => {
  let s = 0;
  for (let i = 1; i < x.length; i++) s += Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
  return s;
};

describe('Tāmaki Drive waterfront data', () => {
  it('is small, and decodes the same from the shipped file', () => {
    expect(WATERFRONT_GZ.length).toBeLessThan(70 * 1024);
    const again = decodeWaterfront(WATERFRONT_BYTES);
    expect(again.lamps.length).toBe(wf.lamps.length);
    expect(again.trees.length).toBe(wf.trees.length);
  });

  it('holds the paths both sides of the road on the causeway and the seawall along the drive', () => {
    const km = (k: number) => wf.lines.filter((l) => l.kind === k).reduce((s, l) => s + length(l.x, l.z), 0) / 1000;
    expect(km(WF_SHARED_PATH)).toBeGreaterThan(6.5); // 5.3 km harbour side + 2.1 km land side
    expect(km(WF_CYCLEWAY)).toBeGreaterThan(2.5);
    expect(km(WF_FOOTPATH)).toBeGreaterThan(6);
    expect(km(WF_ROAD)).toBeGreaterThan(7.5);
    expect(wf.lines.some((l) => l.kind === WF_FILL)).toBe(true);
    const wallKm = wf.walls.reduce((s, w) => s + length(w.cx, w.cz), 0) / 1000;
    expect(wallKm).toBeGreaterThan(5);
    // a seawall's crest stands above its toe
    for (const w of wf.walls) for (let i = 0; i < w.cx.length; i++) expect(w.cy[i]).toBeGreaterThan(w.ty[i]);
  });

  it('stands where Tāmaki Drive is: between The Strand and St Heliers, along the shore', () => {
    // The Strand is ~2 km east of the Sky Tower, St Heliers ~8.5 km
    const xs = wf.lines.flatMap((l) => [l.x[0], l.x[l.x.length - 1]]);
    expect(Math.min(...xs)).toBeLessThan(2200);
    expect(Math.max(...xs)).toBeGreaterThan(8000);
    // the lamps: ~12 m poles (point cloud), all near the measured road
    const tall = wf.lamps.map((l) => l.top - l.ground).sort((a, b) => a - b);
    expect(tall[Math.floor(tall.length / 2)]).toBeGreaterThan(10.5);
    expect(tall[Math.floor(tall.length / 2)]).toBeLessThan(14);
    expect(wf.lamps.length).toBeGreaterThan(200);
    expect(wf.trees.length).toBeGreaterThan(600);
    expect(wf.trees.filter((t) => t.palm).length).toBeGreaterThan(10);
  });
});

describe('Tāmaki Drive in the game', () => {
  it('the road rests on its measured floor over the causeway, not on a viaduct', () => {
    const floor = waterfrontRoadFloor(CAUSEWAY.x, CAUSEWAY.z);
    expect(floor).not.toBeNull();
    expect(floor!).toBeGreaterThan(2);
    expect(floor!).toBeLessThan(5);
    const roads = new RoadNetwork(aucklandRoadPaths());
    expect(applyWaterfrontFloor(roads.paths)).toBeGreaterThan(100);
    const geo = roads.buildRibbons(height, new GeometryBuilder(), new LightList(), false, (p) => p.kind === 'arterial' && !!p.floor);
    const pos = geo.getAttribute('position');
    let near = 0;
    for (let i = 0; i < pos.count; i++) {
      if (Math.hypot(pos.getX(i) - CAUSEWAY.x, pos.getZ(i) - CAUSEWAY.z) > 120) continue;
      near++;
      // the measured road is ~3.2 m up; the viaduct stood 7–12 m
      expect(pos.getY(i)).toBeGreaterThan(2);
      expect(pos.getY(i)).toBeLessThan(6);
    }
    expect(near).toBeGreaterThan(0);
  });

  it('builds paths, seawall, railings and lamps into culled chunks, with a light on every lamp head', () => {
    const chunks = waterfrontChunks();
    const lights = new LightList();
    const tris = buildTamakiWaterfront(chunks.get, lights, height, 1);
    expect(chunks.all.size).toBeGreaterThanOrEqual(5);
    expect(lights.count).toBe(wf.lamps.length);
    expect(tris).toBeGreaterThan(20_000);
    expect(tris).toBeLessThan(150_000);
    let built = 0;
    for (const b of chunks.all.values()) {
      const g = b.build()!;
      built += g.index!.count / 3;
      expect(g.boundingSphere!.radius).toBeLessThan(1600);
    }
    expect(built).toBeGreaterThan(20_000);
    // the causeway has ground under its paths again: the fill closes the sea the terrain has there
    const fillThere = wf.lines.some((l) => l.kind === WF_FILL && Array.from(l.x).some((x, i) => Math.hypot(x - CAUSEWAY.x, l.z[i] - CAUSEWAY.z) < 60));
    expect(fillThere).toBe(true);
  });

  it('grows the measured trees where they stand, and no procedural ones in the strip', () => {
    let n = 0;
    waterfrontTreesIn(CAUSEWAY.x - 400, CAUSEWAY.z - 400, 800, () => n++);
    expect(n).toBeGreaterThan(30);
    expect(inWaterfrontStrip(CAUSEWAY.x, CAUSEWAY.z)).toBe(true);
    expect(inWaterfrontStrip(CAUSEWAY.x, CAUSEWAY.z - 600)).toBe(false);
  });
});
