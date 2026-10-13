/**
 * #276 F8: the crater lakes (Lake Pupuke, Panmure Basin) were ringed by a continuous sand beach and
 * a white surf rim, like a giant paddling pool. Sheltered water breaks no surf and the gardens run
 * down to it, so neither has a beach: no sand in the terrain's materials, no sand band in the terrain
 * shader, and no shore foam in the water shader over them (the calm-water circles both shaders take).
 */
import { describe, expect, it, vi } from 'vitest';
import { Color, DataTexture, Texture, TextureLoader, Vector4, type ShaderMaterial } from 'three';
import { aucklandCalmWater, aucklandLakeCircles, createAuckland, LAKE_RIM } from '../src/world/terrain/theaters/auckland';
import { MAT_BEACH, type SampleOut } from '../src/world/terrain/types';
import { createAtmosphereUniforms } from '../src/world/sky/atmosphere';
import { skyPreset } from '../src/world/sky/presets';
import { Water } from '../src/world/water/Water';
import { CALM_MAX, terrainFragmentShader } from '../src/world/terrain/terrainShader';

describe('crater lakes have no beach and no surf (#276 F8)', () => {
  it('no sand anywhere round either lake, while the harbour coast keeps its beaches', () => {
    const gen = createAuckland(1);
    const out: SampleOut = { mat: 0, aux: 0 };
    const lakes = aucklandLakeCircles();
    expect(lakes.length).toBe(2);
    let ring = 0;
    for (const [x, z, r] of lakes) {
      for (let d = 2; d < LAKE_RIM; d += 4)
        for (let a = 0; a < 360; a += 3) {
          const t = (a * Math.PI) / 180;
          gen.height(x + Math.cos(t) * (r + d), z + Math.sin(t) * (r + d), out);
          ring++;
          expect(out.mat).not.toBe(MAT_BEACH);
        }
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
    expect(u[0].toArray()).toEqual([calm[0][0], calm[0][1], calm[0][2], LAKE_RIM]);
    expect(u[1].toArray()).toEqual([calm[1][0], calm[1][1], calm[1][2], LAKE_RIM]);
    expect(u[2].z).toBe(0); // unused slots are off
    expect(m.fragmentShader).toMatch(/float shore = .*\* \(1\.0 - calmAt\(wp\)\);/);
    expect(terrainFragmentShader).toMatch(/float band = .*\* \(1\.0 - calmAt\(wp\)\);/);
    w.dispose();
    vi.restoreAllMocks();
  });
});
