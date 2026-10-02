/**
 * Polish 5/5 (#61 items 5 and 6): Auckland at night and at dawn. The aerial photo is graded toward the
 * procedural ground it fades into (its edge showed at night and dawn), takes the low sun's light on
 * roofs at dawn and dusk and the procedural ground's colour at night, the road ribbons glow with their
 * street lights at night, and the CBD's streets glow under the towers (the CBD was a dark disc ringed
 * by black motorways).
 */
import { describe, expect, it } from 'vitest';
import { DataTexture, Vector4 } from 'three';
import {
  AERIAL_GRADE_DAY,
  AERIAL_LOW_SUN_SHARE,
  AERIAL_NIGHT_MIX,
  AERIAL_RECT,
  aerialGrade,
  aerialHouseShare,
  aerialLowSun,
} from '../src/world/terrain/theaters/aucklandAerial';
import { aerialUniforms } from '../src/world/terrain/TerrainRenderer';
import { scatterKeep } from '../src/world/scenery/scatter';
import { QUALITY_PRESETS } from '../src/core/data';
import { AERIAL_LIGHT_GLSL, terrainFragmentShader } from '../src/world/terrain/terrainShader';
import { CBD_PLAZA_LIT, CBD_SHOP_LIT, cbdNightGlow, NIGHT_GLOW, suburbFarGlow } from '../src/world/terrain/nightGlow';
import { aucklandStreets, FOOTPATH, type CbdStreets } from '../src/world/scenery/cbdStreets';
import { createBuildingMaterial } from '../src/world/scenery/materials';
import type { TimeOfDay } from '../src/core/types';
import { BARE_MIX, LEAFY_MIX, suburbFarAlbedo } from '../src/world/terrain/urbanColor';
import { terrainStyle, worldConfig } from '../src/world/config';
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
  // The grade matches the average albedo; the low-sun light and the night mix (below) do the lighting.
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

// Light on flat ground (luminance of the irradiance) under a preset's sun and sky, with `extra` more of
// the sun's light, as the terrain shader's atmoDiffuse() + the photo's low-sun term give it.
function flatLight(tod: TimeOfDay, extra: number): number {
  const p = skyPreset('auckland', tod, 'clear', 20_000);
  const sun = p.sunColor.clone().multiplyScalar(p.sunIntensity);
  const sky = p.hemiSky.clone().multiplyScalar(p.hemiIntensity);
  const ndl = Math.max(p.sunDir.y, 0) + extra;
  return lum([sun.r * ndl + sky.r, sun.g * ndl + sky.g, sun.b * ndl + sky.b]);
}

describe('under a low sun the photo takes the light of roofs facing it (#61 item 5, part 2)', () => {
  const sunY = (tod: TimeOfDay) => skyPreset('auckland', tod, 'clear', 20_000).sunDir.y;

  // the photo-capable tiers' house scatter radius (config.ts): medium 2400 m, high 3400 m
  const radii = (['medium', 'high'] as const).map((q) => worldConfig(QUALITY_PRESETS[q]).houseRadius);

  // At dawn the procedural houses round the photo read about twice as bright as the photo in the
  // world lab (c01's light, the Newmarket edge, 300 m up): the photo was lit as flat ground under a 7° sun.
  it('near the camera, where the 3D houses are drawn, the photo is lit about twice as brightly as flat ground at dawn and dusk', () => {
    for (const tod of ['dawn', 'dusk'] as const) {
      for (const R of radii) {
        const extra = aerialLowSun(sunY(tod)) * aerialHouseShare(0.3 * R, R);
        const gain = flatLight(tod, extra) / flatLight(tod, 0);
        expect(gain, `${tod} R ${R}`).toBeGreaterThan(1.6);
        expect(gain, `${tod} R ${R}`).toBeLessThan(2.6);
      }
      // never more than all of it facing the sun like a roof
      expect(aerialLowSun(sunY(tod)) + sunY(tod), tod).toBeLessThan(0.88 * sunY(tod) + 0.47 + 1e-9);
    }
  });

  // From afar (or once the camera is higher than the house radius) no 3D houses are drawn beside the
  // photo and the procedural ground is lit as flat ground: the photo must be too, or it shows as a
  // bright square (the review's far-dawn camera 1000, 2700, 8500 looking at the photo's south edge).
  it('beyond the houses’ range, and from above it, the photo is lit as flat ground like the procedural ground', () => {
    for (const R of radii) {
      for (let ds = 1.02 * R; ds < 20_000; ds += 50) expect(aerialHouseShare(ds, R), `${ds} m`).toBe(0);
      // the camera higher than R hides the houses: every ground point is at least that far
      for (let ds = R; ds < 1.02 * R; ds += 2) expect(aerialHouseShare(ds, R), `${ds} m`).toBeLessThan(0.02);
    }
    const farCam = { x: 1000, y: 2700, z: 8500 };
    const edge = { x: 1000, y: 0, z: AERIAL_RECT.z0 + AERIAL_RECT.size - 10 };
    const ds = Math.hypot(farCam.x - edge.x, farCam.y - edge.y, farCam.z - edge.z);
    for (const tod of ['dawn', 'dusk'] as const) {
      for (const R of radii) {
        const extra = aerialLowSun(sunY(tod)) * aerialHouseShare(ds, R);
        expect(flatLight(tod, extra) / flatLight(tod, 0), `${tod} R ${R}`).toBe(1);
      }
    }
    // without houses (or a photo) there is nothing to stand in for
    expect(aerialHouseShare(100, 0)).toBe(0);
  });

  it('in between, the light follows the share of houses drawn (scatter.ts), faded out before their edge', () => {
    for (const R of radii) {
      let prev = 1;
      for (let ds = 0; ds <= 1.05 * R; ds += R / 200) {
        const share = aerialHouseShare(ds, R);
        if (ds <= 0.9 * R) expect(share, `${ds} m`).toBeCloseTo(scatterKeep(ds, R), 9);
        else expect(share, `${ds} m`).toBeLessThanOrEqual(scatterKeep(ds, R));
        expect(share, `${ds} m`).toBeLessThanOrEqual(prev + 1e-12);
        prev = share;
      }
    }
  });

  it('by day and under the moon nothing changes', () => {
    expect(aerialLowSun(sunY('day'))).toBe(0);
    expect(aerialLowSun(sunY('night'))).toBe(0);
  });

  it('the terrain and the photo-topped buildings use the same term, with the game’s house radius', () => {
    expect(AERIAL_LIGHT_GLSL).toContain(`${AERIAL_LOW_SUN_SHARE.toFixed(3)} * max(facing - y, 0.0) * (1.0 - smoothstep(0.2, 0.45, uSunDir.y))`);
    // the same thinning as scatterKeep and aerialHouseShare
    expect(AERIAL_LIGHT_GLSL).toContain('float keep = ds < 0.35 * R ? 1.0 : max(0.22, 1.0 - (ds - 0.35 * R) / (0.65 * R) * 0.78);');
    expect(AERIAL_LIGHT_GLSL).toContain('return keep * (1.0 - smoothstep(0.9 * R, 1.02 * R, ds));');
    expect(terrainFragmentShader).toContain('float aerialLowSun()');
    expect(terrainFragmentShader).toContain('col += albedo * uSunColor * (s.a * aerialLowSun() * aerialHouseShare(dist) * photo.a * 0.3183099)');
    const atmo = createAtmosphereUniforms(skyPreset('auckland', 'dawn', 'clear', 20_000), 20_000);
    const tex = new DataTexture(new Uint8Array(4), 1, 1);
    const info = { texture: tex, x0: 0, z0: 0, size: 1, feather: 1, houseRadius: 2400 };
    expect(aerialUniforms(info, tex).uAerialHouseR.value).toBe(2400);
    expect(aerialUniforms(null, tex).uAerialHouseR.value).toBe(0);
    const mat = createBuildingMaterial(atmo, { aerial: aerialUniforms(info, tex) });
    expect(mat.uniforms.uAerialHouseR.value).toBe(2400);
    expect(mat.fragmentShader).toContain('float aerialLowSun()');
    expect(mat.fragmentShader).toContain('lit += base * uSunColor * (aerialLowSun() * aerialHouseShare(distance(vWorld, uCamPos)) * photoW * 0.3183099)');
  });
});

describe('at night the photo takes the procedural ground’s colour (#61 item 5, part 2)', () => {
  it('half of the photo’s colour gives way to the procedural ground’s at night, none of it by dusk', () => {
    expect(AERIAL_NIGHT_MIX).toBe(0.5);
    expect(terrainFragmentShader).toContain(`if (uNight > 0.0) photoCol = mix(photoCol, albedo, ${AERIAL_NIGHT_MIX.toFixed(2)} * smoothstep(0.5, 1.0, uNight));`);
    // the photo-topped wharf decks and roofs at the wharf roots do the same with their own colour
    const atmo = createAtmosphereUniforms(skyPreset('auckland', 'night', 'clear', 20_000), 20_000);
    const tex = new DataTexture(new Uint8Array(4), 1, 1);
    const mat = createBuildingMaterial(atmo, { aerial: aerialUniforms({ texture: tex, x0: 0, z0: 0, size: 1, feather: 1 }, tex) });
    expect(mat.fragmentShader).toContain(`if (uNight > 0.0) photoCol = mix(photoCol, base, ${AERIAL_NIGHT_MIX.toFixed(2)} * smoothstep(0.5, 1.0, uNight));`);
    expect(mat.fragmentShader).toContain('base = mix(base, photoCol, photoW);');
    // the procedural ground (urbanPattern) still runs under the photo at night, so 'albedo' is its colour
    expect(terrainFragmentShader).toContain('bool photoFull = photo.a > 0.99 && uNight <= 0.0;');
    // dusk's lamps are on at 0.2: below the mix's 0.5 threshold
    expect(skyPreset('auckland', 'dusk', 'clear', 20_000).lights).toBeLessThan(0.5);
    expect(skyPreset('auckland', 'night', 'clear', 20_000).lights).toBe(1);
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

  // Measured: the far value is 1.12x the suburbs' far glow; from 0.5 to 4.5 m/px the CBD averages
  // 0.85x of it (0.76x its own far value), peaking at 1.17x around 14 m/px.
  it('the CBD’s ground outshines the suburbs’ from afar and keeps most of that glow at every range (no dark ring)', () => {
    expect(samples.length).toBeGreaterThan(100_000);
    // at least as bright as the suburbs from afar (the city centre)
    expect(far).toBeGreaterThan(suburbFarGlow());
    // and no dark ring on the way in: the old glow fell to about a tenth of this between 3 and 18 m/px
    for (const mpp of [0.5, 1, 2, 3, 4.5, 6, 8, 10, 14, 18, 24, 32, 45, 60]) {
      const m = mean(mpp);
      expect(m, `${mpp} m/px`).toBeGreaterThan(far * 0.7);
      expect(m, `${mpp} m/px`).toBeLessThan(far * 1.15);
      // never far below the suburbs' far glow either
      expect(m, `${mpp} m/px`).toBeGreaterThan(suburbFarGlow() * 0.8);
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
