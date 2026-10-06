/**
 * The Tāmaki Drive waterfront (tamakiDriveData.ts, tamakiDrive.ts; measured by tools/hero/sites/tamaki_drive.py): the
 * baked data, where it lies, its numbers against the model's ledger, the triangle budget per tier, the ground on the
 * Hobson Bay causeway (sea in the game's terrain: the road ribbon was a viaduct there), and the scatter, the lamps and
 * the site mask keeping off the strip.
 */
import { describe, expect, it } from 'vitest';
import { AKL } from '../src/core/auckland';
import { allFeatures } from '../src/world/scenery/Scenery';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { decodeTamakiDrive, tamakiDrive, tamakiDriveRings, tdAt, tdPlace, tdPoint, type TamakiDrive } from '../src/world/scenery/tamakiDriveData';
import { buildTamakiDrive, tamakiCovers, tamakiGround, tamakiTrees } from '../src/world/scenery/tamakiDrive';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';
import { LightList } from '../src/world/scenery/builders';
import { aucklandRoadPaths, RoadNetwork } from '../src/world/scenery/motorways';
import { siteRings } from '../src/world/scenery/aucklandSites';
import { maskFromRings } from '../src/world/scenery/lotMask';
import { ColorMapSampler, TreeSource } from '../src/world/scenery/sources';
import { createVegetation, TREE_PALM } from '../src/world/terrain/vegetation';
import { bakeColorRows } from '../src/world/terrain/bake';
import { reduceView } from '../src/world/terrain/parallel';
import { aucklandCbd } from '../src/world/config';
import { TAMAKI_BYTES, TAMAKI_GZ } from './linz-setup';

const td = tamakiDrive() as TamakiDrive;
const station = (s: number) => Math.round(s / td.step);

describe('Tāmaki Drive data (tamaki-drive.bin)', () => {
  it('decodes: 8.2 km of 10 m stations, the paths, seawall, railings, ~229 lamps and the trees', () => {
    expect(td).not.toBeNull();
    expect(decodeTamakiDrive(TAMAKI_BYTES).n).toBe(td.n);
    expect(td.step).toBe(10);
    expect((td.n - 1) * td.step).toBeGreaterThan(8100);
    expect((td.n - 1) * td.step).toBeLessThan(8250);
    expect(td.paths.length).toBeGreaterThan(20);
    expect(td.walls.length).toBeGreaterThan(10);
    expect(td.rails.length).toBeGreaterThan(2);
    // the point cloud found 229 poles; the ones standing on the two bridge decks are left out
    expect(Math.abs(td.lamps.length - 229)).toBeLessThanOrEqual(5);
    expect(td.trees.length).toBeGreaterThan(600);
    expect(td.trees.filter((t) => t.palm).length).toBeGreaterThan(10);
  });

  it('stays inside the hero budget: ≤ 15 kB gzip of measured numbers', () => {
    expect(TAMAKI_GZ.length).toBeLessThan(15_000);
  });

  it('runs from The Strand to St Heliers, the harbour on its negative side', () => {
    // The Strand ≈ 1.9 km east of the Sky Tower, St Heliers ≈ 8.6 km
    expect(td.x[0]).toBeGreaterThan(1800);
    expect(td.x[0]).toBeLessThan(2000);
    expect(td.x[td.n - 1]).toBeGreaterThan(8500);
    expect(td.x[td.n - 1]).toBeLessThan(8800);
    for (let k = 1; k < td.n; k++) expect(Math.hypot(td.x[k] - td.x[k - 1], td.z[k] - td.z[k - 1])).toBeLessThan(10.6);
    // Mission Bay: the harbour is north (−z) of the drive
    const k = station(5900);
    expect(td.nz[k]).toBeGreaterThan(0.5);
    // the AKL place 'tamaki_drive' (Mission Bay) is on the drive, inland of the seawall
    const p = tdPlace(td, AKL.tamaki_drive.x, AKL.tamaki_drive.z)!;
    expect(p).not.toBeNull();
    expect(Math.abs(p.o)).toBeLessThan(60);
  });

  it('matches the model: road level ~3 m, lamps 12.6 m (median), seawall toes at the water', () => {
    const lv = Array.from(td.level).sort((a, b) => a - b);
    expect(lv[Math.floor(lv.length / 2)]).toBeGreaterThan(2.7);
    expect(lv[Math.floor(lv.length / 2)]).toBeLessThan(3.6);
    // the causeway (0.5–0.95 km): 3.0–3.4 m in the LiDAR
    for (let s = 500; s <= 950; s += 50) expect(Math.abs(td.level[station(s)] - 3.2)).toBeLessThan(0.45);
    const h = td.lamps.map((l) => l.h).sort((a, b) => a - b);
    expect(Math.abs(h[Math.floor(h.length / 2)] - 12.6)).toBeLessThan(0.3);
    for (const l of td.lamps) {
      expect(l.h).toBeGreaterThanOrEqual(9.4);
      expect(l.h).toBeLessThanOrEqual(16.1);
      expect(Math.hypot(l.ax, l.az)).toBeLessThan(6.5);
    }
    const toes = td.walls.flatMap((w) => Array.from(w.zt)).sort((a, b) => a - b);
    expect(toes[Math.floor(toes.length / 2)]).toBeLessThan(1);
    // the two bridges, the Hobson Bay outlet (~1.0 km) and Ngapipi Road (~2.1 km)
    expect(td.bridge[station(1010)]).toBe(1);
    expect(td.bridge[station(2090)]).toBe(1);
    expect(td.bridge[station(600)]).toBe(0);
    for (const p of td.paths) for (let i = 0; i < p.w.length; i++) expect(p.w[i]).toBeGreaterThan(1.7);
  });

  it('every lamp and nearly every tree stands on the strip', () => {
    const covers = tamakiCovers(td);
    // (the recipe kept the poles inside its own 5 m stations' strip; one at The Strand stands 11 m seaward of this one's)
    for (const l of td.lamps) expect(covers(l.x, l.z, 12)).toBe(true);
    expect(td.lamps.filter((l) => covers(l.x, l.z, 1)).length / td.lamps.length).toBeGreaterThan(0.98);
    expect(td.trees.filter((t) => covers(t.x, t.z, 2)).length / td.trees.length).toBeGreaterThan(0.97);
  });
});

describe('Tāmaki Drive in the world', () => {
  const features = allFeatures('auckland', []);
  const hf = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 1024, features, pads: [] }));
  const height = (x: number, z: number) => hf.meshHeightAt(x, z);
  const ground = tamakiGround(td, height);

  it('the Hobson Bay causeway stands on ground at the road level, where the terrain has sea', () => {
    let wet = 0;
    for (let s = 550; s <= 950; s += 10) {
      const k = station(s);
      for (const o of [-8, 0, 8]) {
        const [x, z] = tdPoint(td, k, o);
        if (height(x, z) < 0.6) wet++;
        expect(ground(x, z)).toBeGreaterThan(td.level[k] - 0.01);
        expect(ground(x, z)).toBeGreaterThan(2.5);
      }
    }
    // (the terrain is sea along much of it: the reason for the raised ground)
    expect(wet).toBeGreaterThan(20);
    // off the strip the terrain is untouched: Hobson Bay 150 m inland of the causeway
    const [bx, bz] = tdPoint(td, station(800), 150);
    expect(ground(bx, bz)).toBe(height(bx, bz));
  });

  it('the road ribbon runs along the causeway on that ground, not on a viaduct', () => {
    const roads = new RoadNetwork(aucklandRoadPaths());
    const near = (x: number, z: number) => {
      const p = tdPlace(td, x, z, 20);
      return p && p.k > station(560) && p.k < station(940) && Math.abs(p.o) < 9;
    };
    const top = (g: ReturnType<RoadNetwork['buildRibbons']>) => {
      const pos = g.getAttribute('position');
      let n = 0;
      let max = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        if (!near(pos.getX(i), pos.getZ(i))) continue;
        n++;
        max = Math.max(max, pos.getY(i));
      }
      return { n, max };
    };
    const before = top(roads.buildRibbons(height, new GeometryBuilder(), new LightList(), false, (p) => p.kind !== 'rail'));
    const after = top(roads.buildRibbons(height, new GeometryBuilder(), new LightList(), false, (p) => p.kind !== 'rail', { ground }));
    expect(after.n).toBeGreaterThan(20);
    // the viaduct's deck stood 7–12 m up; on the causeway the road is ≈ 3.5 m
    expect(before.max).toBeGreaterThan(6);
    expect(after.max).toBeLessThan(5);
  });

  it('builds within budget per tier, every lamp lit', () => {
    const tris: number[] = [];
    for (const d of [0.35, 0.7, 1]) {
      const B = new GeometryBuilder();
      const L = new LightList();
      tris.push(buildTamakiDrive(B, L, td, ground, height, d));
      expect(L.count).toBe(td.lamps.length);
    }
    // 8.2 km of strip: ~4 k triangles a km on medium (the prototype's port plan: ~55 k at 5 m stations)
    expect(tris[0]).toBeLessThan(20_000);
    expect(tris[1]).toBeLessThan(40_000);
    expect(tris[2]).toBeLessThan(48_000);
    expect(tris[0]).toBeLessThan(tris[1]);
    expect(tris[1]).toBeLessThan(tris[2]);
  });

  it('the paths and the lamps stand on the ground (the causeway included), never in the water', () => {
    const B = new GeometryBuilder();
    buildTamakiDrive(B, null, td, ground, height, 0.7);
    const g = B.build()!;
    const pos = g.getAttribute('position');
    const nrm = g.getAttribute('normal');
    let paths = 0;
    for (let i = 0; i < pos.count; i++) {
      if (nrm.getY(i) < 0.99) continue;
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const p = tdPlace(td, x, z, 60);
      if (!p || p.k < station(560) || p.k > station(940)) continue;
      // every upward face on the causeway's land: at or a little above the ground, never under it
      if (p.o < tdAt(td.lo, p.k) + 6) continue;
      expect(y).toBeGreaterThan(ground(x, z) - 0.05);
      expect(y).toBeGreaterThan(2.5);
      paths++;
    }
    expect(paths).toBeGreaterThan(100);
    for (const l of td.lamps) expect(ground(l.x, l.z)).toBeGreaterThan(-0.5);
  });

  it('the generic road lamps keep off the strip, which has its own', () => {
    const roads = new RoadNetwork(aucklandRoadPaths());
    const covers = tamakiCovers(td);
    const count = (noLamp?: (x: number, z: number) => boolean) => {
      const L = new LightList();
      roads.buildRibbons(height, new GeometryBuilder(), L, true, (p) => p.kind !== 'rail', { ground, noLamp });
      let n = 0;
      L.forEach((x, _y, z) => {
        if (covers(x, z)) n++;
      });
      return n;
    };
    expect(count()).toBeGreaterThan(10);
    expect(count(covers)).toBe(0);
  });

  it('the site mask covers the strip (no procedural lots or houses on the waterfront)', () => {
    expect(tamakiDriveRings(td).length).toBeGreaterThan(50);
    const mask = maskFromRings(siteRings(), 8)!;
    for (const s of [300, 1500, 3000, 4500, 6000, 7500]) {
      const [x, z] = tdPoint(td, station(s), 0);
      expect(mask.masked(x, z)).toBe(true);
    }
  });

  it('the tree scatter grows the measured trees on the strip and no others', () => {
    const m = 512;
    const color = new Uint8Array(m * m * 4);
    bakeColorRows(reduceView(hf, m), { theater: 'auckland', seed: 1840, features }, m, 0, m, color);
    const cmap = new ColorMapSampler(color, m, hf.origin, hf.extent);
    const covers = tamakiCovers(td);
    const trees = tamakiTrees(td, ground);
    const src = new TreeSource(hf, cmap, createVegetation('auckland', 1840, features), 'auckland', 1840, 14, null, aucklandCbd(), null, null, null, { trees, covers });
    const out = { data: [[], [], []] as number[][] };
    // Mission Bay to Kohimarama, in 280 m tiles
    for (let z = -560; z < 560; z += 280) for (let x = 6160; x < 8120; x += 280) src.generate(x, z, 280, out);
    const inBox = (x: number, z: number) => x >= 6160 && x < 8120 && z >= -560 && z < 560;
    const measured = new Set<string>();
    for (let i = 0; i < trees.length; i += 7) if (inBox(trees[i], trees[i + 2])) measured.add(`${trees[i].toFixed(2)},${trees[i + 2].toFixed(2)}`);
    let ours = 0, others = 0, palms = 0;
    out.data.forEach((arr, kind) => {
      for (let i = 0; i < arr.length; i += 11) {
        const key = `${arr[i].toFixed(2)},${arr[i + 2].toFixed(2)}`;
        if (measured.has(key)) {
          ours++;
          if (kind === TREE_PALM) palms++;
        } else if (covers(arr[i], arr[i + 2])) others++;
      }
    });
    expect(ours).toBe(measured.size);
    expect(palms).toBeGreaterThan(5);
    expect(others).toBe(0);
  });
});
