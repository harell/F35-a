/**
 * Polish 5/5 (#61 items 5 and 6): Auckland at night and at dawn. The aerial photo is graded toward the
 * procedural ground it fades into (its edge showed at night and dawn), the road ribbons glow with their
 * street lights at night, and the CBD's streets glow under the towers (the CBD was a dark disc ringed
 * by black motorways).
 */
import { describe, expect, it } from 'vitest';
import { DataTexture } from 'three';
import { AERIAL_GRADE_DAY, aerialGrade } from '../src/world/terrain/theaters/aucklandAerial';
import { terrainFragmentShader } from '../src/world/terrain/terrainShader';
import { CBD_PLAZA_LIT, CBD_SHOP_LIT, cbdNightGlow, NIGHT_GLOW, suburbFarGlow } from '../src/world/terrain/nightGlow';
import { aucklandStreets, FOOTPATH, type CbdStreets } from '../src/world/scenery/cbdStreets';
import { BARE_MIX, LEAFY_MIX, suburbFarAlbedo } from '../src/world/terrain/urbanColor';
import { terrainStyle } from '../src/world/config';
import { skyPreset } from '../src/world/sky/presets';
import { createAtmosphereUniforms } from '../src/world/sky/atmosphere';
import { createRoadMaterial, ROAD_NIGHT_GLOW } from '../src/world/scenery/materials';

const style = terrainStyle('auckland');
const leafy = suburbFarAlbedo(style, LEAFY_MIX);
const bare = suburbFarAlbedo(style, BARE_MIX);
const target: [number, number, number] = [(leafy.r + bare.r) / 2, (leafy.g + bare.g) / 2, (leafy.b + bare.b) / 2];
// the shipped photo's land average (linear), as imageMeanLinear measures it at load
const photo: [number, number, number] = [0.098, 0.105, 0.095];
const lum = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const graded = (g: number[], c: readonly number[]) => c.map((v, i) => v * (1 + (g[i] - 1) * g[3]));

describe('the aerial photo is graded toward the procedural ground (#61 item 5)', () => {
  // Only the average albedo is matched: the procedural near field's low-sun roof lighting has no term on
  // the photo, so the edge can still show at dawn (item 5 is partly fixed).
  it('at night and from dawn on, the photo’s average albedo matches the procedural suburbs’ far albedo', () => {
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

describe('the CBD’s streets glow under the towers at night (#61 item 6, part 2)', () => {
  const st = aucklandStreets() as CbdStreets;
  const smooth = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  // the street map inside the CBD region every 3 m, with cbdPattern's park cover (parks and verges, off the street)
  const samples: { kerb: number; park: number; h: number }[] = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const b = st.bounds;
  for (let z = b.minZ; z < b.maxZ; z += 3)
    for (let x = b.minX; x < b.maxX; x += 3) {
      if (st.regionSD(x, z) <= 0) continue;
      const kerb = st.streetSD(x, z);
      const off = smooth(FOOTPATH, FOOTPATH + 2, kerb);
      const park = Math.max(smooth(0.35, 0.65, st.park(x, z)) * off, smooth(0.35, 0.65, st.verge(x, z)) * off);
      samples.push({ kerb, park, h: rnd() });
    }
  const mean = (mpp: number) => samples.reduce((a, p) => a + cbdNightGlow(p.kerb, p.park, mpp, p.h), 0) / samples.length;
  const far = mean(200);

  it('the CBD’s ground glows at least as much as the suburbs’ from every range', () => {
    expect(samples.length).toBeGreaterThan(100_000);
    // brighter than the suburbs from afar (the city centre)
    expect(far).toBeGreaterThan(suburbFarGlow() * 1.1);
    // and no dark ring on the way in: the old glow fell to about a tenth of this between 3 and 18 m/px
    for (const mpp of [0.5, 1, 2, 3, 4.5, 6, 8, 10, 14, 18, 24, 32, 45, 60]) {
      const m = mean(mpp);
      expect(m, `${mpp} m/px`).toBeGreaterThan(far * 0.7);
      expect(m, `${mpp} m/px`).toBeLessThan(far * 1.15);
    }
  }, 60_000);

  it('the far constant is the near pattern’s average over the real streets', () => {
    // without the haze (which comes in with range), the near pattern averages to the far constant
    const nearMean = samples.reduce((a, p) => a + cbdNightGlow(p.kerb, p.park, 1, p.h), 0) / samples.length;
    const parkMean = samples.reduce((a, p) => a + p.park, 0) / samples.length;
    expect(nearMean / (NIGHT_GLOW.cbdAvg * (1 - 0.8 * parkMean))).toBeGreaterThan(0.9);
    expect(nearMean / (NIGHT_GLOW.cbdAvg * (1 - 0.8 * parkMean))).toBeLessThan(1.1);
  }, 60_000);

  it('the shader draws the same terms', () => {
    const cbd = terrainFragmentShader.slice(terrainFragmentShader.indexOf('vec3 cbdPattern('), terrainFragmentShader.indexOf('vec3 urbanPattern('));
    expect(cbd).toContain(`streetCov * kerbPool * ${NIGHT_GLOW.cbdStreet.toFixed(3)}`);
    expect(cbd).toContain(`(frontCov - roadCov) * shopLit * ${NIGHT_GLOW.cbdShop.toFixed(3)}`);
    expect(cbd).toContain(`(1.0 - frontCov) * plazaLit * ${NIGHT_GLOW.cbdPlaza.toFixed(3)}`);
    expect(cbd).toContain(`mix(step(0.5, fract(h * 5.3)), ${CBD_SHOP_LIT.toFixed(3)}, hashBlend)`);
    expect(cbd).toContain(`${CBD_PLAZA_LIT.toFixed(3)}, hashBlend)`);
    expect(cbd).toContain(`mix(nearGlow, ${NIGHT_GLOW.cbdAvg.toFixed(3)} * (1.0 - park * 0.8), smoothstep(24.0, 60.0, mpp))`);
    // the hashed terms' means are the hashes' real means
    let shop = 0;
    let plaza = 0;
    const n = 200_000;
    for (let i = 0; i < n; i++) {
      const h = (i + 0.5) / n;
      shop += (h * 5.3) % 1 >= 0.5 ? 1 : 0;
      plaza += h < 0.45 && (h * 7.9) % 1 >= 0.5 ? 1 : 0;
    }
    expect(shop / n).toBeCloseTo(CBD_SHOP_LIT, 2);
    expect(plaza / n).toBeCloseTo(CBD_PLAZA_LIT, 2);
  });
});
