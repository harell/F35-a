/**
 * Regression tests for the i1 review findings "Auckland reads as a small box town in green
 * farmland; weak signature details" and "night city goes dark at distance".
 */
import { describe, expect, it } from 'vitest';
import { BoxGeometry, MeshBasicMaterial, Vector3 } from 'three';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { allFeatures } from '../src/world/scenery/Scenery';
import { bakeColorRows, dilateLandColour } from '../src/world/terrain/bake';
import { reduceView } from '../src/world/terrain/parallel';
import { createVegetation } from '../src/world/terrain/vegetation';
import { MAT_URBAN, MAT_VOLCANIC } from '../src/world/terrain/types';
import { WHENUAPAI_CROSS } from '../src/world/terrain/theaters/auckland';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';
import { LightList } from '../src/world/scenery/builders';
import { buildCBD, buildCentres } from '../src/world/scenery/auckland';
import { aucklandRoadPaths, RoadNetwork } from '../src/world/scenery/motorways';
import { ColorMapSampler, HouseSource, onStreet, TreeSource } from '../src/world/scenery/sources';
import { TileScatter, type ScatterSource, type TileInstances } from '../src/world/scenery/scatter';
import { buildCityLightPoints } from '../src/world/scenery/nightLights';
import { lightMinAlpha, windowGlowAverage, LIT_WINDOW_MEAN, WINDOW_STYLES } from '../src/world/scenery/materials';
import { skyPreset } from '../src/world/sky/presets';
import { OVERCAST_DECK } from '../src/world/clouds/Clouds';
import { AKL_CBD_GRID, terrainStyle, worldConfig } from '../src/world/config';
import { QUALITY_PRESETS } from '../src/core/data';
import { AKL, geoToWorld } from '../src/core/auckland';
import { coneUniforms, MAX_CONES } from '../src/world/terrain/TerrainRenderer';
import { terrainFragmentShader } from '../src/world/terrain/terrainShader';

const MISSION = [
  { type: 'airbase' as const, x: AKL.whenuapai.x, z: AKL.whenuapai.z, rotation: 30 },
  { type: 'airbase' as const, x: 26_500, z: -6200, rotation: 80, size: 0.8 },
];
const features = allFeatures('auckland', MISSION);
const hf = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 1024, features, pads: [] }));
const height = (x: number, z: number) => hf.meshHeightAt(x, z);
const m = 512;
const color = new Uint8Array(m * m * 4);
bakeColorRows(reduceView(hf, m), { theater: 'auckland', seed: 1840, features }, m, 0, m, color);
const cmap = new ColorMapSampler(color, m, hf.origin, hf.extent);
const roads = new RoadNetwork(aucklandRoadPaths());
const matAt = (x: number, z: number) => hf.mat[Math.round((z - hf.origin) / hf.cell) * hf.n + Math.round((x - hf.origin) / hf.cell)];

describe('CBD skyline', () => {
  const B = new GeometryBuilder();
  const lights = new LightList();
  const stats = buildCBD(B, lights, height, 0.7, AKL_CBD_GRID, roads);

  it('has 60–120 towers, tallest ≈ 180 m, many 60–140 m, all well below the Sky Tower', () => {
    expect(stats.towers).toBeGreaterThanOrEqual(60);
    expect(stats.towers).toBeLessThanOrEqual(120);
    expect(stats.tallest).toBeGreaterThanOrEqual(175);
    expect(stats.tallest).toBeLessThan(200);
    const over100 = stats.heights.filter((h) => h >= 100).length;
    const band = stats.heights.filter((h) => h >= 60 && h <= 140).length;
    expect(over100).toBeGreaterThanOrEqual(15);
    expect(band).toBeGreaterThanOrEqual(45);
    expect(B.vertexCount).toBeGreaterThan(5000);
  });

  it('town centres and industrial estates add a few hundred buildings', () => {
    const C = new GeometryBuilder();
    const n = buildCentres(C, new LightList(), height, 0.7, AKL_CBD_GRID, roads);
    expect(n).toBeGreaterThan(300);
    expect(n).toBeLessThan(2500);
  });
});

describe('suburbs visible from altitude (no hard 1,500 m cut)', () => {
  class Grid implements ScatterSource {
    readonly kinds = 1;
    generate(x0: number, z0: number, size: number, out: TileInstances): void {
      for (let z = z0 + 10; z < z0 + size; z += 20) for (let x = x0 + 10; x < x0 + size; x += 20) out.data[0].push(x, 0, z, 0, 1, 1, 1, 1, 1, 1, ((x * 0.37 + z * 0.71) % 1 + 1) % 1);
    }
  }
  const make = () => new TileScatter(new Grid(), [{ geometry: new BoxGeometry(), material: new MeshBasicMaterial(), capacity: 60_000, kind: 0 }], 300, 2400, 50);
  const settle = (s: TileScatter, agl: number) => {
    for (let i = 0; i < 400 && !(s.idle && i > 2); i++) s.update(new Vector3(0, agl, 0), agl);
    return s.instanceCount;
  };

  it('keeps houses at 1,800 m AGL, thinning smoothly with slant range, none above the radius', () => {
    const low = settle(make(), 0);
    const high = settle(make(), 1800);
    const above = settle(make(), 2500);
    expect(high).toBeGreaterThan(0);
    expect(high).toBeLessThan(low);
    expect(above).toBe(0);
    const cfg = worldConfig(QUALITY_PRESETS.medium);
    expect(cfg.houseRadius).toBeGreaterThanOrEqual(2200);
  });

  it('3D houses keep off the motorways', () => {
    const src = new HouseSource(hf, cmap, height, AKL_CBD_GRID, (x, z, mm) => roads.near(x, z, mm));
    // tiles straddling SH1 through Newmarket / Greenlane
    const p = geoToWorld(-36.8765, 174.7815);
    const out = { data: [[], []] as number[][] };
    for (let dz = -600; dz <= 600; dz += 300) for (let dx = -600; dx <= 600; dx += 300) src.generate(p.x + dx, p.z + dz, 300, out);
    let n = 0;
    for (const arr of out.data)
      for (let i = 0; i < arr.length; i += 11) {
        n++;
        expect(roads.edgeDistance(arr[i], arr[i + 2])).toBeGreaterThan(5);
      }
    expect(n).toBeGreaterThan(200);
    // …and the motorway really runs there
    expect(roads.edgeDistance(p.x, p.z)).toBeLessThan(0);
  });
});

describe('street trees', () => {
  it('3D garden / street trees never stand on the painted streets or motorways', () => {
    const veg = createVegetation('auckland', 1840, features);
    const src = new TreeSource(hf, cmap, veg, 'auckland', 1840, 14, (x, z, mm) => roads.near(x, z, mm), AKL_CBD_GRID);
    const scratch = {} as Parameters<typeof onStreet>[3];
    let n = 0;
    for (let tz = -1200; tz < 1200; tz += 400)
      for (let tx = -4000; tx < -1000; tx += 400) {
        const out = { data: [[], [], []] as number[][] };
        src.generate(tx, tz, 400, out);
        for (const arr of out.data)
          for (let i = 0; i < arr.length; i += 11) {
            if (cmap.urban(arr[i], arr[i + 2]) <= 0.05) continue;
            n++;
            expect(onStreet(arr[i], arr[i + 2], AKL_CBD_GRID, scratch)).toBe(false);
            expect(roads.edgeDistance(arr[i], arr[i + 2])).toBeGreaterThan(0);
          }
      }
    expect(n).toBeGreaterThan(100);
  });
});

describe('Auckland signature details', () => {
  it('the colour map paints suburbs roof-and-road grey, not pasture green', () => {
    let ur = 0, ug = 0, un = 0, pr = 0, pg = 0, pn = 0;
    for (let j = 0; j < m; j++)
      for (let i = 0; i < m; i++) {
        const k = (j * m + i) * 4;
        const x = hf.origin + (i / m) * hf.extent;
        const z = hf.origin + (j / m) * hf.extent;
        if (Math.abs(x) > 15_000 || Math.abs(z) > 15_000 || hf.heightAt(x, z) < 2) continue;
        const a = color[k + 3];
        if (a > 200) {
          ur += color[k];
          ug += color[k + 1];
          un++;
        } else if (a === 0 && matAt(x, z) === 0) {
          pr += color[k];
          pg += color[k + 1];
          pn++;
        }
      }
    expect(un).toBeGreaterThan(500);
    expect(pn).toBeGreaterThan(500);
    expect(ug / ur).toBeLessThan(1.1); // grey
    expect(pg / pr).toBeGreaterThan(ug / ur + 0.15); // pasture clearly greener
  });

  it('Rangitoto is bush over black lava down to the shore: no pasture, no paddock-able clearings', () => {
    const veg = createVegetation('auckland', 1840, features);
    const c = AKL.rangitoto;
    let land = 0;
    for (let r = 200; r < 2500; r += 150)
      for (let a = 0; a < Math.PI * 2; a += 0.3) {
        const x = c.x + Math.cos(a) * r;
        const z = c.z + Math.sin(a) * r;
        const h = hf.heightAt(x, z);
        if (h <= 0.5) continue;
        land++;
        expect(matAt(x, z)).toBe(MAT_VOLCANIC);
        const mm = matAt(x, z);
        const aux = hf.aux[Math.round((z - hf.origin) / hf.cell) * hf.n + Math.round((x - hf.origin) / hf.cell)];
        expect(veg.density(x, z, h, hf.slopeAt(x, z), mm, aux)).toBeGreaterThanOrEqual(0.3);
      }
    expect(land).toBeGreaterThan(200);
    // symmetric shield: summit ≈ 260 m, similar heights on all sides at 1.5 km
    expect(hf.heightAt(c.x, c.z)).toBeGreaterThan(190);
    const ring = [0, 1, 2, 3, 4, 5].map((k) => hf.heightAt(c.x + Math.cos(k) * 1500, c.z + Math.sin(k) * 1500));
    expect(Math.max(...ring) - Math.min(...ring)).toBeLessThan(25);
  });

  it('the shore strip continues the land colour (no sandy ring round Rangitoto)', () => {
    const view = reduceView(hf, m);
    const rgba = color.slice();
    dilateLandColour(rgba, view.data, m);
    const c = AKL.rangitoto;
    let n = 0;
    for (let a = 0; a < Math.PI * 2; a += 0.2) {
      // first water texel outside the island along this bearing
      for (let r = 2400; r < 3400; r += hf.extent / m / 2) {
        const x = c.x + Math.cos(a) * r;
        const z = c.z + Math.sin(a) * r;
        const i = Math.round((x - hf.origin) / (hf.extent / m));
        const j = Math.round((z - hf.origin) / (hf.extent / m));
        if (view.data[j * m + i] > 0) continue;
        const k = (j * m + i) * 4;
        expect(0.2126 * rgba[k] + 0.7152 * rgba[k + 1] + 0.0722 * rgba[k + 2]).toBeLessThan(95); // dark lava/bush, not sand (≈ 185)
        n++;
        break;
      }
    }
    expect(n).toBeGreaterThan(20);
  });

  it('Whenuapai has a level cross runway 08/26 and suburbs around the base', () => {
    const X = WHENUAPAI_CROSS;
    const hs: number[] = [];
    for (let s = -X.length / 2; s <= X.length / 2; s += 100) hs.push(hf.heightAt(X.x + Math.sin(X.heading) * s, X.z - Math.cos(X.heading) * s));
    expect(Math.max(...hs) - Math.min(...hs)).toBeLessThan(1.5);
    let urban = 0;
    for (let a = 0; a < Math.PI * 2; a += 0.2) {
      const x = AKL.whenuapai.x + Math.cos(a) * 3000;
      const z = AKL.whenuapai.z + Math.sin(a) * 3000;
      if (matAt(x, z) === MAT_URBAN) urban++;
    }
    expect(urban).toBeGreaterThan(8);
  });

  it('overcast is a real low deck with flat, diffuse light', () => {
    const clear = skyPreset('auckland', 'day', 'clear', 40_000);
    const over = skyPreset('auckland', 'day', 'overcast', 40_000);
    expect(over.sunIntensity).toBeLessThan(clear.sunIntensity * 0.2);
    expect(over.hemiIntensity).toBeGreaterThan(clear.hemiIntensity * 1.4);
    const sat = (c: { r: number; g: number; b: number }) => (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / Math.max(1e-6, Math.max(c.r, c.g, c.b));
    expect(sat(over.zenith)).toBeLessThan(0.2); // grey sky, not blue
    expect(over.waterDeep.getHSL({ h: 0, s: 0, l: 0 }).l).toBeLessThan(clear.waterDeep.getHSL({ h: 0, s: 0, l: 0 }).l);
    expect(OVERCAST_DECK.altitude).toBeLessThanOrEqual(2000);
    expect(OVERCAST_DECK.cover).toBeGreaterThan(0.95);
  });

  it('terrain style: Auckland has a vineyard region on Waiheke, a CBD grid, and a shore band', () => {
    const st = terrainStyle('auckland');
    expect(st.vineyard).not.toBeNull();
    const [vx, vz, rx, rz] = st.vineyard!;
    const w = AKL.waiheke;
    expect(((w.x - vx) / rx) ** 2 + ((w.z - vz) / rz) ** 2).toBeLessThan(1);
    expect(st.cbd).toEqual(AKL_CBD_GRID);
    expect(st.roofs.length).toBe(6);
  });
});

describe('volcanic cones (i1 re-check: Mt Eden crater invisible at 86 m heightfield resolution)', () => {
  const cones = terrainStyle('auckland').cones ?? [];
  it('the terrain shader gets every Auckland cone with its crater; Mt Eden 150 m wide, 50 m deep', () => {
    expect(cones.length).toBeGreaterThanOrEqual(12);
    expect(cones.length).toBeLessThanOrEqual(MAX_CONES);
    const eden = cones.find((c) => Math.hypot(c.x - 160, c.z - 3110) < 50)!;
    expect(eden).toBeDefined();
    expect(eden.craterR).toBe(150);
    expect(eden.craterDepth).toBe(50);
    expect(eden.terraces).toBe(true);
    // the heightfield alone cannot hold it: the crater spans < 3.5 cells of 86 m
    expect((2 * eden.craterR) / hf.cell).toBeLessThan(3.6);
    // Rangitoto's summit craters are shaded too, without pā terraces
    const rg = cones.filter((c) => Math.hypot(c.x - 8700, c.z + 6850) < 300);
    expect(rg.length).toBe(2);
    for (const c of rg) expect(c.terraces).toBe(false);
  });

  it('uniforms are packed (loop stops at the first empty slot) and the bounding box holds every cone', () => {
    const u = coneUniforms(cones);
    expect(u.uConeA.value.length).toBe(MAX_CONES);
    for (let i = 0; i < MAX_CONES; i++) expect(u.uConeB.value[i].x > 0).toBe(i < cones.length);
    const b = u.uConeBox.value;
    for (const c of cones) {
      expect(c.x - c.coneR).toBeGreaterThanOrEqual(b.x);
      expect(c.z - c.coneR).toBeGreaterThanOrEqual(b.y);
      expect(c.x + c.coneR).toBeLessThanOrEqual(b.z);
      expect(c.z + c.coneR).toBeLessThanOrEqual(b.w);
    }
    // other theatres: an empty box, so the shader skips the loop
    const none = coneUniforms(terrainStyle('mountains').cones ?? []).uConeBox.value;
    expect(none.z).toBeLessThan(none.x);
    expect(terrainFragmentShader).toContain('coneDetail(wp, mpp, albedo)');
  });
});

describe('night city lights at distance', () => {
  it('far-field window glow equals the detailed pattern average (was ~0.06, a 75 % drop)', () => {
    const avg = windowGlowAverage('office');
    const w = WINDOW_STYLES.office;
    const area = (1 - 2 * w.margin[0]) * (1 - 2 * w.margin[1]);
    for (let c = 0; c < 3; c++) expect(avg[c]).toBeCloseTo(LIT_WINDOW_MEAN[c] * w.lit * area, 6);
    const lum = (v: number[]) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    const oldFar = 0.62 * 0.1 * lum([1.5, 1.05, 0.57]); // cover·0.1 × the warm window colour
    expect(lum(avg)).toBeGreaterThan(oldFar * 2.5);
  });

  it('a carpet of city lights covers the built-up area (and only land)', () => {
    const list = new LightList();
    const n = buildCityLightPoints({ data: color, size: m, origin: hf.origin, extent: hf.extent }, height, 1840, 30_000, list);
    expect(n).toBeGreaterThan(8000);
    expect(n).toBeLessThanOrEqual(31_000);
    let cbd = 0;
    let shore = 0;
    list.forEach((x, y, z) => {
      expect(hf.heightAt(x, z)).toBeGreaterThan(0);
      if (Math.hypot(x - 300, z + 100) < 1500) cbd++;
      if (Math.hypot(x - AKL.takapuna.x, z - AKL.takapuna.z) < 2000) shore++;
    });
    expect(cbd).toBeGreaterThan(40);
    expect(shore).toBeGreaterThan(40);
  });

  it('small runway lights fade out with range, bright fixtures stay visible', () => {
    expect(lightMinAlpha(3.2)).toBeLessThan(0.06); // runway edge
    expect(lightMinAlpha(2.4)).toBeLessThan(0.06); // taxiway
    expect(lightMinAlpha(7)).toBeCloseTo(0.35, 5); // strobes / floodlights
    expect(lightMinAlpha(4.5)).toBeGreaterThan(0.15); // city carpet
  });
});
