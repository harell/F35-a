/**
 * Polish 5/5 (#61 items 5 and 6): Auckland at night and at dawn. The aerial photo is graded toward the
 * procedural ground it fades into (its edge showed at night and dawn), and the road ribbons glow with
 * their street lights at night (the CBD was a dark disc ringed by black motorways).
 */
import { describe, expect, it } from 'vitest';
import { DataTexture } from 'three';
import { AERIAL_GRADE_DAY, aerialGrade } from '../src/world/terrain/theaters/aucklandAerial';
import { BARE_MIX, LEAFY_MIX, suburbFarAlbedo } from '../src/world/terrain/urbanColor';
import { terrainStyle } from '../src/world/config';
import { skyPreset } from '../src/world/sky/presets';
import { createAtmosphereUniforms } from '../src/world/sky/atmosphere';
import { createRoadMaterial, ROAD_NIGHT_GLOW } from '../src/world/scenery/materials';

const style = terrainStyle('auckland');
const leafy = suburbFarAlbedo(style, LEAFY_MIX);
const bare = suburbFarAlbedo(style, BARE_MIX);
const target: [number, number, number] = [(leafy.r + bare.r) / 2, (leafy.g + bare.g) / 2, (leafy.b + bare.b) / 2];
// a city photo averages darker and greyer than the procedural suburbs (roofs, roads, real shadows)
const photo: [number, number, number] = [target[0] * 0.8, target[1] * 0.62, target[2] * 0.9];
const lum = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const graded = (g: number[], c: readonly number[]) => c.map((v, i) => v * (1 + (g[i] - 1) * g[3]));

describe('the aerial photo is graded toward the procedural ground (#61 item 5)', () => {
  it('at night and from dawn on, the photo averages the procedural suburbs’ colour', () => {
    for (const tod of ['dawn', 'dusk', 'night'] as const) {
      const g = aerialGrade(photo, target, tod);
      expect(g[3], tod).toBe(1);
      const out = graded(g, photo);
      for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(target[i], 4);
    }
  });

  it('by day it barely changes the photo, and without a measurement it does nothing', () => {
    const g = aerialGrade(photo, target, 'day');
    expect(g[3]).toBe(AERIAL_GRADE_DAY);
    expect(Math.abs(lum(graded(g, photo)) / lum(photo) - 1)).toBeLessThan(0.1);
    expect(aerialGrade(null, target, 'night')).toEqual([1, 1, 1, 0]);
  });

  it('a wildly off measurement is clamped (no neon photo)', () => {
    const g = aerialGrade([0.001, 0.5, 2], target, 'night');
    for (let i = 0; i < 3; i++) expect(g[i]).toBeGreaterThanOrEqual(0.6), expect(g[i]).toBeLessThanOrEqual(1.8);
  });
});

describe('the road ribbons glow with their street lights at night (#61 item 6)', () => {
  const atmo = createAtmosphereUniforms(skyPreset('auckland', 'night', 'clear', 20_000), 20_000);
  const tex = new DataTexture(new Uint8Array(4), 1, 1);

  it('roads are lit, railways are not', () => {
    expect(createRoadMaterial(atmo, tex, true).uniforms.uLit.value).toBe(1);
    expect(createRoadMaterial(atmo, tex).uniforms.uLit.value).toBe(0);
    const frag = createRoadMaterial(atmo, tex, true).fragmentShader;
    expect(frag).toContain('uLit * uNight');
    expect(ROAD_NIGHT_GLOW).toBeGreaterThan(0.03);
  });
});
