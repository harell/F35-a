/**
 * Look and life 1/8 (#139): aerial perspective and a light colour grade over Auckland. The city under
 * the jet stays crisp, far islands soften toward a sun-tinted haze, the haze thins with altitude, and
 * every world shader (and the sky) shares the new uniforms.
 */
import { describe, expect, it } from 'vitest';
import { aerialFactor, skyPreset } from '../src/world/sky/presets';
import { ATMOSPHERE_GLSL, blendAtmosphere, createAtmosphereUniforms } from '../src/world/sky/atmosphere';
import type { TimeOfDay, Weather } from '../src/core/types';
import { QUALITY_PRESETS } from '../src/core/data';
import { BLOOM_BLUR_FRAG, BLOOM_BRIGHT_FRAG, BLOOM_DOWNSCALE, BLOOM_INTENSITY, BLOOM_THRESHOLD, bloomEnabled } from '../src/render/Bloom';

const P = (tod: TimeOfDay, w: Weather = 'clear') => skyPreset('auckland', tod, w, 20_000);

describe('aerial perspective (#139)', () => {
  it('leaves the CBD within 4 km untouched, at any altitude', () => {
    for (const tod of ['dawn', 'day', 'dusk', 'night'] as TimeOfDay[]) {
      const a = P(tod).aerial;
      for (const d of [0, 1000, 3000, 4000]) expect(aerialFactor(a, d, 260, 0)).toBe(0);
    }
  });

  it('softens Rangitoto seen from the CBD (about 9 km, low)', () => {
    const f = aerialFactor(P('day').aerial, 9000, 260, 0);
    expect(f).toBeGreaterThan(0.1);
    expect(f).toBeLessThan(0.4);
  });

  it('grows with distance and thins as the jet climbs', () => {
    const a = P('day').aerial;
    expect(aerialFactor(a, 20_000, 300, 0)).toBeGreaterThan(aerialFactor(a, 9000, 300, 0));
    expect(aerialFactor(a, 20_000, 6000, 0)).toBeLessThan(aerialFactor(a, 20_000, 300, 0));
  });

  it('is warm and denser at dawn and dusk, grey and denser overcast, almost none at night', () => {
    const s = (tod: TimeOfDay, w: Weather = 'clear') => P(tod, w).aerial.strength;
    expect(s('dusk')).toBeGreaterThan(s('day'));
    expect(s('dawn')).toBeGreaterThan(s('day'));
    expect(s('day', 'overcast')).toBeGreaterThan(s('day'));
    expect(s('night')).toBeLessThan(0.1);
    for (const tod of ['dawn', 'day', 'dusk', 'night'] as TimeOfDay[]) {
      for (const w of ['clear', 'scattered', 'overcast'] as Weather[]) expect(s(tod, w)).toBeLessThanOrEqual(0.6);
    }
  });
});

describe('colour grade (#139)', () => {
  it('stays subtle: within 10 % of neutral, neutral at night, flatter overcast', () => {
    for (const tod of ['dawn', 'day', 'dusk', 'night'] as TimeOfDay[]) {
      for (const w of ['clear', 'scattered', 'overcast'] as Weather[]) {
        const g = P(tod, w).grade;
        expect(Math.abs(g.contrast - 1)).toBeLessThanOrEqual(0.1);
        expect(Math.abs(g.saturation - 1)).toBeLessThanOrEqual(0.1);
      }
    }
    expect(P('night').grade).toEqual({ contrast: 1, saturation: 1 });
    expect(P('day', 'overcast').grade.contrast).toBeLessThan(P('day').grade.contrast);
  });
});

describe('shared atmosphere uniforms (#139)', () => {
  it('carries the aerial perspective and the grade, and blends them across the cloud deck', () => {
    const below = P('day', 'overcast');
    const above = P('day', 'clear');
    const u = createAtmosphereUniforms(below, 20_000);
    expect(u.uAerialPersp.value.toArray()).toEqual([below.aerial.near, below.aerial.range, below.aerial.strength, below.aerial.height]);
    expect(u.uGrade.value.toArray()).toEqual([below.grade.contrast, below.grade.saturation]);
    blendAtmosphere(u, below, above, 1);
    expect(u.uAerialPersp.value.z).toBeCloseTo(above.aerial.strength, 6);
    expect(u.uGrade.value.x).toBeCloseTo(above.grade.contrast, 6);
  });

  it('declares the uniforms and applies them in the shared fog, under names no other shader uses', () => {
    expect(ATMOSPHERE_GLSL).toMatch(/uniform vec4 uAerialPersp;/);
    expect(ATMOSPHERE_GLSL).toMatch(/uniform vec2 uGrade;/);
    // atmoApplyFog ends in the aerial blend and the grade
    const fog = ATMOSPHERE_GLSL.slice(ATMOSPHERE_GLSL.indexOf('vec3 atmoApplyFog'));
    expect(fog).toMatch(/atmoAerial\(/);
    expect(fog).toMatch(/atmoGrade\(/);
    // the terrain and photo-roofed buildings already declare `uAerial` (the aerial photo sampler)
    expect(ATMOSPHERE_GLSL).not.toMatch(/\buAerial\b/);
  });
});

describe('bloom (#139 item 4)', () => {
  it('is on for the high tier only', () => {
    expect(bloomEnabled(QUALITY_PRESETS.low)).toBe(false);
    expect(bloomEnabled(QUALITY_PRESETS.medium)).toBe(false);
    expect(bloomEnabled(QUALITY_PRESETS.high)).toBe(true);
  });

  it('keeps only bright pixels, at a quarter size, and adds a modest glow', () => {
    expect(BLOOM_THRESHOLD).toBeGreaterThan(0.6);
    expect(BLOOM_THRESHOLD).toBeLessThan(1);
    expect(BLOOM_DOWNSCALE).toBe(4);
    expect(BLOOM_INTENSITY).toBeLessThanOrEqual(1);
    expect(BLOOM_BRIGHT_FRAG).toMatch(/smoothstep\(uThreshold, 1\.0/);
    // separable Gaussian: the weights sum to 1
    const w = [...BLOOM_BLUR_FRAG.matchAll(/\* (0\.\d+);/g)].map((m) => Number(m[1]));
    expect(w).toHaveLength(5);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 4);
  });
});
