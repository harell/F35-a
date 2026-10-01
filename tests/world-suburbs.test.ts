/**
 * Regression tests for the i2 review finding "Beyond the CBD, Auckland reads as khaki gravel or a
 * Voronoi crackle, not a leafy suburban city (worst from combat altitude)".
 */
import { describe, expect, it } from 'vitest';
import { Color } from 'three';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { allFeatures } from '../src/world/scenery/Scenery';
import { bakeColorRows } from '../src/world/terrain/bake';
import { reduceView } from '../src/world/terrain/parallel';
import { MAT_CONE, MAT_URBAN } from '../src/world/terrain/types';
import { aucklandRoadPaths } from '../src/world/scenery/motorways';
import { lightsForSun, skyPreset } from '../src/world/sky/presets';
import { terrainStyle } from '../src/world/config';
import { AKL } from '../src/core/auckland';
import { terrainFragmentShader } from '../src/world/terrain/terrainShader';
import { BARE_MIX, LEAFY_MIX, roofAverage, suburbFarAlbedo } from '../src/world/terrain/urbanColor';

const lum = (c: Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

describe('far-field suburb colour (combat altitude)', () => {
  const style = terrainStyle('auckland');

  it('reproduces the old khaki: ~50 % brownish roof + 35 % canopy averaged to r ≈ g', () => {
    // the i2 formula (terrainShader.ts:240) for a mid-density suburb, for the record
    const roof = roofAverage(terrainStyle('auckland').roofs);
    const old = new Color(0, 0, 0);
    const roofCover = 0.46;
    const tree = 0.36;
    old.r = roof.r * roofCover + style.canopy.r * tree + 0.18 * 0.2;
    old.g = roof.g * roofCover + style.canopy.g * tree + 0.18 * 0.2;
    old.b = roof.b * roofCover + style.canopy.b * tree + 0.18 * 0.2;
    expect(old.g / old.r).toBeLessThan(1.05); // khaki / grey-brown: no green dominance
  });

  it('is grey-green: canopy 30-45 %, green channel dominant, darker than the old khaki', () => {
    for (const mix of [LEAFY_MIX, BARE_MIX]) {
      expect(mix.canopy + mix.roofs + mix.lawn + mix.paving).toBeCloseTo(1, 5);
      expect(mix.canopy).toBeGreaterThanOrEqual(0.3);
      expect(mix.canopy).toBeLessThanOrEqual(0.45);
      const c = suburbFarAlbedo(style, mix);
      expect(c.g / c.r).toBeGreaterThan(1.1); // green, not khaki (old: < 1.05)
      expect(c.g / c.b).toBeGreaterThan(1.35);
      expect(lum(c)).toBeGreaterThan(0.07);
      expect(lum(c)).toBeLessThan(0.15);
    }
    // leafy neighbourhoods are darker / greener than bare ones
    const leafy = suburbFarAlbedo(style, LEAFY_MIX);
    const bare = suburbFarAlbedo(style, BARE_MIX);
    expect(lum(leafy)).toBeLessThan(lum(bare));
  });

  it('NZ roof palette: corrugated-iron red, terracotta, charcoal / grey and off-white', () => {
    const roofs = style.roofs.map((c) => c.getHSL({ h: 0, s: 0, l: 0 }));
    expect(roofs.filter((h) => (h.h < 0.06 || h.h > 0.95) && h.s > 0.35).length).toBeGreaterThanOrEqual(2); // reds
    expect(roofs.filter((h) => h.l > 0.4 && h.s < 0.2).length).toBeGreaterThanOrEqual(1); // off-white
    expect(roofs.filter((h) => h.l < 0.1).length).toBeGreaterThanOrEqual(1); // charcoal
  });

  it('the shader uses the CPU far colour and paints no arterials / lamps on Voronoi district borders', () => {
    expect(terrainFragmentShader).toContain('uniform vec3 uSuburbLeafy');
    expect(terrainFragmentShader).toContain('mix(uSuburbBare, uSuburbLeafy, leafy)');
    // the old 7.5 m "arterial" on every jittered district border and its lamps / lane marks
    expect(terrainFragmentShader).not.toMatch(/float arterial/);
    expect(terrainFragmentShader).not.toMatch(/7\.5 [-+] aa/);
    // district borders are ordinary 3.6 m streets
    expect(terrainFragmentShader).toContain('road = max(road, 1.0 - smoothstep(3.6 - aa * 0.5, 3.6 + aa * 0.5, dist.w))');
  });
});

describe('city lights follow the sun (dawn read as a light carpet under a sunrise sky)', () => {
  it('lightsForSun: off with the sun above +7°, on from -3°', () => {
    expect(lightsForSun(58)).toBe(0);
    expect(lightsForSun(7)).toBe(0);
    expect(lightsForSun(5)).toBeCloseTo(0.2, 5);
    expect(lightsForSun(-3)).toBe(1);
    expect(lightsForSun(-10)).toBe(1);
  });

  it('presets: dawn 0 (was 0.55), dusk faint (was 0.8), night full, day 0', () => {
    expect(skyPreset('auckland', 'dawn', 'clear', 40_000).lights).toBe(0);
    expect(skyPreset('auckland', 'dusk', 'clear', 40_000).lights).toBeLessThanOrEqual(0.25);
    expect(skyPreset('auckland', 'dusk', 'clear', 40_000).lights).toBeGreaterThan(0.05);
    expect(skyPreset('auckland', 'night', 'clear', 40_000).lights).toBe(1);
    expect(skyPreset('auckland', 'day', 'clear', 40_000).lights).toBe(0);
  });

  it('dawn hemisphere ground term is lifted (land not near-black at sunrise)', () => {
    const p = skyPreset('auckland', 'dawn', 'clear', 40_000);
    const old = new Color().setHex(0x5a4a44);
    expect(lum(p.hemiGround) * p.hemiIntensity).toBeGreaterThan(lum(old) * 0.95 * 1.3);
  });
});

describe('real arterial roads and softer volcanic cones', () => {
  const features = allFeatures('auckland', [{ type: 'airbase', x: AKL.whenuapai.x, z: AKL.whenuapai.z, rotation: 30 }]);
  const hf = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 1024, features, pads: [] }));

  it('Dominion Rd, Great North Rd, Lake Rd, Onewa Rd etc. are road ribbons, on land', () => {
    const paths = aucklandRoadPaths();
    const names = paths.map((p) => p.name);
    for (const n of ['Dominion Rd', 'Great North Rd', 'Lake Rd', 'Onewa Rd', 'Manukau Rd', 'Mt Eden Rd']) expect(names).toContain(n);
    const arterials = paths.filter((p) => p.width < 20);
    expect(arterials.length).toBeGreaterThanOrEqual(8);
    for (const p of arterials) {
      // Only short river / creek bridges (the builder raises a deck there), e.g. Great North Rd over
      // the Whau at Avondale on the real (LINZ) coastline — never a run along the harbour.
      let run = 0;
      let longest = 0;
      let urban = 0;
      for (let i = 0; i < p.x.length; i++) {
        const wet = hf.heightAt(p.x[i], p.z[i]) < 0.6;
        run = wet && i > 0 ? run + Math.hypot(p.x[i] - p.x[i - 1], p.z[i] - p.z[i - 1]) : 0;
        longest = Math.max(longest, run);
        const k = Math.round((p.z[i] - hf.origin) / hf.cell) * hf.n + Math.round((p.x[i] - hf.origin) / hf.cell);
        if (hf.mat[k] === MAT_URBAN) urban++;
      }
      expect(longest, `${p.name} runs over water`).toBeLessThan(300); // Whau bridge incl. shore ramps ≈ 270 m
      expect(urban / p.x.length, `${p.name} runs through the suburbs`).toBeGreaterThan(0.6);
    }
    // motorway-only list still available
    expect(aucklandRoadPaths(false).every((p) => p.width >= 20)).toBe(true);
  });

  it('cones are blended by slope with noise, not one flat categorical colour', () => {
    const m = 1024;
    const color = new Uint8Array(m * m * 4);
    bakeColorRows(reduceView(hf, m), { theater: 'auckland', seed: 1840, features }, m, 0, m, color);
    const cone: number[][] = [];
    for (let k = 0; k < m * m; k++) if (hf.mat[k] === MAT_CONE) cone.push([color[k * 4], color[k * 4 + 1], color[k * 4 + 2]]);
    expect(cone.length).toBeGreaterThan(50);
    const mean = [0, 1, 2].map((c) => cone.reduce((s, v) => s + v[c], 0) / cone.length);
    const sd = Math.sqrt(cone.reduce((s, v) => s + (v[1] - mean[1]) ** 2, 0) / cone.length);
    expect(sd).toBeGreaterThan(4); // varied (was a single blendInto(p.cone, 0.8))
    // not a bright lime disc: mean green channel close to the suburb tone
    expect(mean[1]).toBeLessThan(135);
  });
});
