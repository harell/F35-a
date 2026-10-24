/**
 * #276 F8: the crater lakes (Lake Pupuke, Panmure Basin) were ringed by a continuous sand beach and
 * a white surf rim, like a giant paddling pool. Sheltered water breaks no surf and the gardens run
 * down to it, so neither has a beach: no sand in the terrain's materials, no sand band in the terrain
 * shader, and no shore foam in the water shader over them (the calm-water circles both shaders take).
 * #276: their shores are the real OSM ones, not circles, and the calm circles keep clear of the sea.
 */
import { describe, expect, it, vi } from 'vitest';
import { Color, DataTexture, Texture, TextureLoader, Vector4, type ShaderMaterial } from 'three';
import { aucklandCalmWater, aucklandLakes, aucklandMapData, createAuckland, LAKE_RIM } from '../src/world/terrain/theaters/auckland';
import { ringDistance } from '../src/world/terrain/features';
import { AKL_LAKES } from '../src/world/terrain/theaters/aucklandMap';
import { MAT_BEACH, type SampleOut } from '../src/world/terrain/types';
import { createAtmosphereUniforms } from '../src/world/sky/atmosphere';
import { skyPreset } from '../src/world/sky/presets';
import { Water } from '../src/world/water/Water';
import { CALM_MAX, terrainFragmentShader } from '../src/world/terrain/terrainShader';

describe('crater lakes have no beach and no surf (#276 F8)', () => {
  it('no sand anywhere round either lake, while the harbour coast keeps its beaches', () => {
    const gen = createAuckland(1);
    const out: SampleOut = { mat: 0, aux: 0 };
    const lakes = aucklandLakes();
    expect(lakes.length).toBe(2);
    let ring = 0;
    for (const l of lakes)
      for (let x = l.minX - LAKE_RIM; x <= l.maxX + LAKE_RIM; x += 8)
        for (let z = l.minZ - LAKE_RIM; z <= l.maxZ + LAKE_RIM; z += 8) {
          const r = ringDistance(l.pts, x, z);
          if (r.inside || r.dist > LAKE_RIM - 2) continue;
          gen.height(x, z, out);
          ring++;
          expect(out.mat, `${x},${z}`).not.toBe(MAT_BEACH);
        }
    expect(ring).toBeGreaterThan(2000);
    // the open coast still has sand: a sweep across the North Shore's east-coast beaches
    let beach = 0;
    for (let x = 0; x < 3000; x += 10)
      for (let z = -9000; z < -5000; z += 10) {
        gen.height(x, z, out);
        if (out.mat === MAT_BEACH) beach++;
      }
    expect(beach).toBeGreaterThan(0);
  });

  it('the terrain and water shaders take the lakes as calm water: no sand band, no shore foam', () => {
    vi.spyOn(TextureLoader.prototype, 'load').mockImplementation(() => new Texture()); // no DOM to load the normal map with
    const preset = skyPreset('auckland', 'day', 'clear', 12_000);
    const calm = aucklandCalmWater().circles;
    const w = new Water({
      atmo: createAtmosphereUniforms(preset, 12_000),
      heightTexture: new DataTexture(new Float32Array(4), 2, 2),
      detail: new Texture(),
      hf: { origin: 0, cell: 1, n: 2 },
      deep: new Color(),
      shallow: new Color(),
      shallowDepth: 4,
      radius: 1000,
      coast: null,
      dummy: new Texture(),
      calm: aucklandCalmWater(),
    });
    const m = w.mesh.material as ShaderMaterial;
    const u = m.uniforms.uCalm.value as Vector4[];
    expect(u.length).toBe(CALM_MAX);
    expect(calm.length).toBe(3); // Pupuke's one, Panmure's two
    calm.forEach((c, i) => expect(u[i].toArray()).toEqual([c[0], c[1], c[2], LAKE_RIM]));
    expect(u[calm.length].z).toBe(0); // unused slots are off
    expect(m.fragmentShader).toMatch(/float shore = .*\* \(1\.0 - calmAt\(wp\)\);/);
    expect(terrainFragmentShader).toMatch(/float band = .*\* \(1\.0 - calmAt\(wp\)\);/);
    w.dispose();
    vi.restoreAllMocks();
  });

  it('the lakes are their real OSM shores (#276): Lake Pupuke 1.06 km², Panmure Basin 0.50 km², both water in the map', () => {
    const area = (p: ArrayLike<number>) => {
      let a = 0;
      for (let i = 0, n = p.length / 2, j = n - 1; i < n; j = i++) a += p[j * 2] * p[i * 2 + 1] - p[i * 2] * p[j * 2 + 1];
      return Math.abs(a) / 2;
    };
    const [pupuke, panmure] = aucklandLakes();
    expect(area(pupuke.pts) / 1e6).toBeCloseTo(1.06, 1);
    expect(area(panmure.pts) / 1e6).toBeCloseTo(0.5, 1);
    // no longer a circle: Pupuke is 1.33 km east to west
    expect(pupuke.maxX - pupuke.minX).toBeGreaterThan(1300);
    const map = aucklandMapData();
    for (const l of [pupuke, panmure]) {
      // a point well inside each is water, the land past its shore is land
      let water = 0, land = 0;
      for (let x = l.minX; x <= l.maxX; x += 20)
        for (let z = l.minZ; z <= l.maxZ; z += 20) {
          const r = ringDistance(l.pts, x, z);
          if (r.inside && r.dist > 40) water += map.isLand(x, z) ? 0 : 1;
          else if (!r.inside && r.dist > 40) land += map.isLand(x, z) ? 1 : 0;
        }
      expect(water).toBeGreaterThan(500);
      expect(land).toBeGreaterThan(100);
    }
  });

  it('the calm-water circles cover each shore and keep clear of the sea (Takapuna Beach, the Tāmaki River)', () => {
    const map = aucklandMapData();
    const lakes = aucklandLakes();
    const calm = aucklandCalmWater().circles;
    expect(calm.length).toBeLessThanOrEqual(CALM_MAX);
    // no sea (water outside every lake) inside a circle's rim
    for (const [cx, cz, r] of calm)
      for (let a = 0; a < 360; a += 2)
        for (let d = 0; d <= r + LAKE_RIM; d += 15) {
          const x = cx + Math.cos((a * Math.PI) / 180) * d, z = cz + Math.sin((a * Math.PI) / 180) * d;
          if (map.isLand(x, z) || lakes.some((l) => ringDistance(l.pts, x, z).inside || ringDistance(l.pts, x, z).dist < 30)) continue;
          throw new Error(`sea at ${x.toFixed(0)},${z.toFixed(0)}, inside the calm circle at ${cx},${cz}`);
        }
    // the shore under full calm: all of Pupuke's; Panmure's but for its channel mouth
    AKL_LAKES.forEach((lake, i) => {
      const l = lakes[i];
      const n = l.pts.length / 2;
      let covered = 0, all = 0;
      for (let k = 0; k < n; k++) {
        const x = l.pts[k * 2], z = l.pts[k * 2 + 1];
        all++;
        if (lake.calm.some(([cx, cz, r]) => Math.hypot(x - cx * 1000, z - cz * 1000) <= r * 1000 + LAKE_RIM * 0.6)) covered++;
      }
      expect(covered / all, lake.name).toBeGreaterThan(i === 0 ? 0.999 : 0.9);
    });
  });
});
