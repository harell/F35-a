/**
 * Open data 4 (#6): the CBD / waterfront aerial photo (src/world/terrain/theaters/aucklandAerial.ts,
 * src/world/terrain/data/auckland-aerial-{2048,4096}.webp baked by tools/linz/aerial.py), and its outer atlas
 * (#120: the rest of the Devonport peninsula and the gulf islands, auckland-aerial-outer-{2048,4096}.webp and
 * auckland-aerial-outer.json).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AKL } from '../src/core/auckland';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../src/core/data';
import { worldConfig } from '../src/world/config';
import {
  AERIAL_FEATHER,
  AERIAL_OUTER,
  AERIAL_OUTER_URLS,
  AERIAL_RECT,
  AERIAL_URLS,
  MAX_AERIAL_BOXES,
  aerialBoxWeight,
  aerialCovers,
  aerialEdgeWeight,
  aerialOuterSize,
  aerialOuterUv,
  aerialWeight,
  aucklandAerial,
  aucklandAerialOuter,
  loadAucklandAerial,
  loadAucklandAerialOuter,
  type AerialOuterCover,
} from '../src/world/terrain/theaters/aucklandAerial';
import { aerialOuterUniforms } from '../src/world/terrain/TerrainRenderer';
import { terrainFragmentShader } from '../src/world/terrain/terrainShader';
import { geoToWorld } from '../src/core/auckland';
import { aucklandMapData } from '../src/world/terrain/theaters/auckland';
import { Texture } from 'three';
import sw from '../public/sw.js?raw';

interface Fs {
  readFileSync(p: URL): Uint8Array;
}
const fs = (await import(/* @vite-ignore */ 'node:fs' as string)) as Fs;

/** Width, height and alpha flag of a WebP file (RIFF VP8X / VP8L / VP8 header). */
function webpInfo(b: Uint8Array): { width: number; height: number; alpha: boolean } {
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  expect(tag(0)).toBe('RIFF');
  expect(tag(8)).toBe('WEBP');
  const chunk = tag(12);
  const u24 = (o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
  if (chunk === 'VP8X') return { width: u24(24) + 1, height: u24(27) + 1, alpha: (b[20] & 0x10) !== 0 };
  if (chunk === 'VP8L') {
    const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1, alpha: ((v >>> 28) & 1) === 1 };
  }
  return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff, alpha: false };
}

/** Download budgets of the outer atlas (KiB): measured + ~10 %. */
const OUTER_KIB = { 2048: 290, 4096: 650 } as const;
const file = (size: number) => new Uint8Array(fs.readFileSync(new URL(`../src/world/terrain/data/auckland-aerial-${size}.webp`, import.meta.url)));
const outerFile = (size: number) => new Uint8Array(fs.readFileSync(new URL(`../src/world/terrain/data/auckland-aerial-outer-${size}.webp`, import.meta.url)));

describe('aerial photo files', () => {
  it.each([
    [2048, 320],
    [4096, 700],
  ])('%i²: RGBA WebP within its download budget (≤ %i KiB)', (size, kib) => {
    const b = file(size);
    const info = webpInfo(b);
    expect(info).toEqual({ width: size, height: size, alpha: true });
    expect(b.length / 1024).toBeLessThanOrEqual(kib);
  });
});

describe('outer photo atlas (#120)', () => {
  it.each([
    [2048, OUTER_KIB[2048]],
    [4096, OUTER_KIB[4096]],
  ] as const)('%i: RGBA WebP of the layout\'s size, within its download budget (≤ %i KiB)', (size, kib) => {
    const b = outerFile(size);
    expect(webpInfo(b)).toEqual({ ...aerialOuterSize(size), alpha: true });
    expect(aerialOuterSize(size).width).toBe(size);
    expect(b.length / 1024).toBeLessThanOrEqual(kib);
  });

  it('every box lies inside the atlas without overlapping another, at its tier\'s resolution', () => {
    expect(AERIAL_OUTER.length).toBeLessThanOrEqual(MAX_AERIAL_BOXES);
    for (const size of [2048, 4096] as const) {
      const { width, height } = aerialOuterSize(size);
      const px = aerialOuterUv(size).map(([u0, v0, u1, v1]) => [u0 * width, v0 * height, u1 * width, v1 * height]);
      px.forEach(([a, b, c, d], i) => {
        const box = AERIAL_OUTER[i];
        expect(a).toBeGreaterThanOrEqual(0);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(width);
        expect(d).toBeLessThanOrEqual(height);
        // metres per pixel: Devonport at the square's (2.5 / 1.25 m), the islands 10 / 5 m
        const mpp = box.w / (c - a);
        expect(box.h / (d - b)).toBeCloseTo(mpp, 6);
        const devonport = box.name.startsWith('devonport');
        expect(mpp, box.name).toBeCloseTo(devonport ? AERIAL_RECT.size / size : size === 4096 ? 5 : 10, 6);
        for (let j = 0; j < i; j++) {
          const [e, f, g, h] = px[j];
          expect(a >= g || c <= e || b >= h || d <= f, `${box.name} / ${AERIAL_OUTER[j].name}`).toBe(true);
        }
      });
    }
  });

  /** A cover whose alpha is 1 everywhere (land everywhere): the weight is the boxes' and the square's fades alone. */
  const allLand: AerialOuterCover = { alpha: new Uint8Array(64 * 64).fill(255), width: 64, height: 64, uv: aerialOuterUv(2048) };
  const at = (lat: number, lon: number) => geoToWorld(lat, lon);

  it('covers the whole Devonport peninsula with the photo at full weight, and no straight edge crosses it', () => {
    // Narrow Neck, Cheltenham, North Head, Bayswater, Belmont, Stanley Bay (and the repro camera's spot on the old edge)
    const places: [string, { x: number; z: number }][] = [
      ['north_head', AKL.north_head],
      ['cheltenham', at(-36.8215, 174.8095)],
      ['narrow_neck', at(-36.8145, 174.8035)],
      ['bayswater', at(-36.8170, 174.7720)],
      ['belmont', at(-36.8060, 174.7850)],
      ['stanley_bay', at(-36.8240, 174.7820)],
      ['old_edge', { x: 3560, z: -2375 }],
    ];
    for (const [id, p] of places) {
      expect(aerialWeight(p.x, p.z, allLand), id).toBeCloseTo(1, 9);
      expect(aerialCovers(p.x, p.z, allLand), id).toBe(true);
    }
    // every point of the peninsula south of the Belmont neck has the full weight (the fades cross over where the
    // boxes and the square meet: their weights add up to ≥ 1), so the only fade on it is the neck's
    // (on the game's land: Bayswater's tip is at x ≈ 340, Narrow Neck's beach at x ≈ 4100, North Head's at x ≈ 4650)
    const map = aucklandMapData();
    let n = 0;
    for (let z = -5170; z <= -1500; z += 20)
      for (let x = 330; x <= 5000; x += 20) {
        if (!map.isLand(x, z)) continue;
        n++;
        expect(aerialWeight(x, z, allLand), `${x}, ${z}`).toBeCloseTo(1, 9);
      }
    expect(n).toBeGreaterThan(15_000); // ≈ 7 km² of peninsula
    // north of the neck it is gone, and the fade there is the box's own (monotone)
    expect(aerialWeight(2000, -5520, allLand)).toBe(0);
    let prev = 0;
    for (let z = -5500; z <= -5170; z += 10) {
      const w = aerialWeight(2000, z, allLand);
      expect(w).toBeGreaterThanOrEqual(prev);
      prev = w;
    }
    // without the outer photo the square alone is as before
    expect(aerialCovers(AKL.north_head.x, AKL.north_head.z)).toBe(false);
  });

  it('covers Rangitoto, Motutapu, Rakino, Motuihe, Browns Island and all of Waiheke', () => {
    const places: [string, { x: number; z: number }][] = [
      ['rangitoto summit', at(-36.7867, 174.8606)],
      ['motutapu', at(-36.7600, 174.9100)],
      ['rakino', at(-36.7230, 174.9500)],
      ['motuihe', at(-36.8100, 174.9430)],
      ['browns island', at(-36.8320, 174.8950)],
      ['oneroa', at(-36.7860, 175.0100)],
      ['onetangi', at(-36.7790, 175.0700)],
      ['man o war', at(-36.7860, 175.1650)],
      ['stony batter', at(-36.7700, 175.1850)],
    ];
    for (const [id, p] of places) {
      expect(aerialWeight(p.x, p.z, allLand), id).toBe(1);
      expect(aerialCovers(p.x, p.z, null), id).toBe(false);
    }
    // where the photo's alpha is 0 (the sea, Ponui's tip in Waiheke's box) nothing is covered
    const noLand: AerialOuterCover = { ...allLand, alpha: new Uint8Array(64 * 64) };
    for (const [id, p] of places) expect(aerialCovers(p.x, p.z, noLand), id).toBe(false);
  });

  it('box weights fade over each box\'s feather and overlapping boxes cross over', () => {
    for (const b of AERIAL_OUTER) {
      const zc = b.z0 + b.h / 2;
      expect(aerialBoxWeight(b, b.x0, zc)).toBe(0);
      expect(aerialBoxWeight(b, b.x0 + b.feather / 2, zc)).toBeCloseTo(0.5, 6);
      expect(aerialBoxWeight(b, b.x0 + b.feather, zc)).toBe(1);
    }
  });

  it('the terrain shader sums the square and the outer boxes, sampling the atlas with explicit gradients', () => {
    expect(terrainFragmentShader).toContain(`uniform vec4 uAerialBox[${MAX_AERIAL_BOXES}];`);
    expect(terrainFragmentShader).toContain('textureGrad(uAerialOuter');
    expect(terrainFragmentShader).toContain('return vec4(acc.rgb / acc.a');
    const none = aerialOuterUniforms(null, new Texture());
    expect(none.uAerialBox.value.every((v) => v.z === 0)).toBe(true);
    const tex = new Texture();
    const u = aerialOuterUniforms({ texture: tex, boxes: AERIAL_OUTER, uv: aerialOuterUv(4096) }, new Texture());
    expect(u.uAerialOuter.value).toBe(tex);
    AERIAL_OUTER.forEach((b, i) => {
      expect(u.uAerialBox.value[i].x).toBe(b.x0);
      expect(u.uAerialBox.value[i].z).toBeCloseTo(1 / b.w, 12);
      expect(u.uAerialBoxFeather.value[i]).toBe(b.feather);
    });
    expect(u.uAerialBox.value[AERIAL_OUTER.length]?.z ?? 0).toBe(0);
    expect(u.uAerialOuterBounds.value.x).toBe(Math.min(...AERIAL_OUTER.map((b) => b.x0)));
  });
});

describe('photo square', () => {
  it('covers the CBD, the waterfront and Devonport with the photo at full weight', () => {
    for (const id of ['skytower', 'cbd', 'britomart', 'viaduct', 'wynyard', 'westhaven', 'port', 'devonport', 'naval_base', 'domain', 'parnell']) {
      const p = AKL[id];
      expect(aerialEdgeWeight(p.x, p.z), id).toBe(1);
      expect(aerialCovers(p.x, p.z), id).toBe(true);
    }
    for (const id of ['north_head', 'eden_park', 'newmarket']) expect(aerialCovers(AKL[id].x, AKL[id].z), id).toBe(false);
  });

  it('fades out across the feather band at the edge', () => {
    const r = AERIAL_RECT;
    const zc = r.z0 + r.size / 2;
    expect(aerialEdgeWeight(r.x0 - 1, zc)).toBe(0);
    expect(aerialEdgeWeight(r.x0, zc)).toBe(0);
    expect(aerialEdgeWeight(r.x0 + AERIAL_FEATHER / 2, zc)).toBeCloseTo(0.5, 6);
    expect(aerialEdgeWeight(r.x0 + AERIAL_FEATHER, zc)).toBe(1);
    expect(aerialEdgeWeight(r.x0 + r.size - AERIAL_FEATHER / 4, zc)).toBeCloseTo(aerialEdgeWeight(r.x0 + AERIAL_FEATHER / 4, zc), 9);
    let prev = 0;
    for (let x = r.x0; x <= r.x0 + AERIAL_FEATHER; x += 8) {
      const w = aerialEdgeWeight(x, zc);
      expect(w).toBeGreaterThanOrEqual(prev);
      prev = w;
    }
  });

  it('the terrain shader replaces the procedural ground with it and skips the hidden patterns', () => {
    expect(terrainFragmentShader).toContain('vec4 photo = aerialPhoto(wp);');
    expect(terrainFragmentShader).toContain('vec3 photoCol = photo.rgb');
    expect(terrainFragmentShader).toContain('albedo = mix(albedo, photoCol, photo.a);');
    expect(terrainFragmentShader).toContain('bool photoFull = photo.a > 0.99 && uNight <= 0.0;');
    expect(terrainFragmentShader).toContain('if (urban > 0.01 && !photoFull) albedo = urbanPattern(');
  });
});

describe('aerial photo download scope', () => {
  it('low never asks for it, medium gets 2048², high 4096², and the setting turns it off', () => {
    expect(worldConfig(QUALITY_PRESETS.low).aerial).toBe(0);
    expect(worldConfig(QUALITY_PRESETS.medium).aerial).toBe(2048);
    expect(worldConfig(QUALITY_PRESETS.high).aerial).toBe(4096);
    expect(DEFAULT_SETTINGS.aerialPhoto).toBe(true);
    expect(worldConfig({ ...QUALITY_PRESETS.low, aerialPhoto: true }).aerial).toBe(0);
    expect(worldConfig({ ...QUALITY_PRESETS.medium, aerialPhoto: false }).aerial).toBe(0);
    expect(worldConfig({ ...QUALITY_PRESETS.high, aerialPhoto: false }).aerial).toBe(0);
  });

  describe('loader', () => {
    const realFetch = globalThis.fetch;
    const realBitmap = (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
    afterEach(() => {
      globalThis.fetch = realFetch;
      (globalThis as { createImageBitmap?: unknown }).createImageBitmap = realBitmap;
    });

    it('fetches once per size and shares concurrent calls; a failure leaves the procedural ground', async () => {
      const calls: string[] = [];
      globalThis.fetch = (async (u: string) => {
        calls.push(String(u));
        return new Response(file(2048).slice());
      }) as typeof fetch;
      const bitmap = { width: 2048, height: 2048 };
      const opts: unknown[] = [];
      (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async (_b: Blob, o: unknown) => {
        opts.push(o);
        return bitmap;
      };
      const [a, b] = await Promise.all([loadAucklandAerial(2048), loadAucklandAerial(2048)]);
      expect(a).toBe(bitmap);
      expect(b).toBe(bitmap);
      expect(await loadAucklandAerial(2048)).toBe(bitmap);
      expect(calls).toEqual([AERIAL_URLS[2048]]);
      expect(aucklandAerial(2048)).toBe(bitmap);
      expect(aucklandAerial(4096)).toBeNull();
      // the alpha channel is a mask: no premultiplication, no flip, no colour conversion
      expect(opts[0]).toMatchObject({ premultiplyAlpha: 'none', imageOrientation: 'none', colorSpaceConversion: 'none' });
      expect(await loadAucklandAerial(0)).toBeNull();

      globalThis.fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch;
      const warn = console.warn;
      console.warn = () => undefined;
      try {
        expect(await loadAucklandAerial(4096)).toBeNull();
      } finally {
        console.warn = warn;
      }
      expect(aucklandAerial(4096)).toBeNull();
    });

    it('the outer photo has its own files and cache', async () => {
      const calls: string[] = [];
      globalThis.fetch = (async (u: string) => {
        calls.push(String(u));
        return new Response(outerFile(2048).slice());
      }) as typeof fetch;
      const bitmap = { width: 2048, height: 100 };
      (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => bitmap;
      expect(await loadAucklandAerialOuter(2048)).toBe(bitmap);
      expect(await loadAucklandAerialOuter(2048)).toBe(bitmap);
      expect(calls).toEqual([AERIAL_OUTER_URLS[2048]]);
      expect(aucklandAerialOuter(2048)).toBe(bitmap);
      expect(aucklandAerialOuter(4096)).toBeNull();
      expect(await loadAucklandAerialOuter(0)).toBeNull();

      // a failed download leaves the square (and the procedural ground) as before
      globalThis.fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch;
      const warn = console.warn;
      console.warn = () => undefined;
      try {
        expect(await loadAucklandAerialOuter(4096)).toBeNull();
      } finally {
        console.warn = warn;
      }
      expect(aucklandAerialOuter(4096)).toBeNull();
    });
  });

  it('the service worker never precaches either size (other lazily referenced assets still are)', () => {
    const helpers = new Function('self', `${sw.slice(0, sw.indexOf("self.addEventListener('install'"))}; return { referencedAssets };`)({
      registration: { scope: 'https://example.com/game/' },
      location: { origin: 'https://example.com' },
    }) as { referencedAssets: (c: string, u: string) => string[] };
    const code =
      'a=new URL(`auckland-aerial-2048-Bx_9-k2Q.webp`,import.meta.url).href;b=new URL("auckland-aerial-4096-a1B2c3D4.webp",import.meta.url);c=new URL(`auckland-roads-C8f2.bin`,import.meta.url);d=new URL(`auckland-aerial-outer-2048-Zz9_x.webp`,import.meta.url);e=new URL(`auckland-aerial-outer-4096-Qq1.webp`,import.meta.url)';
    expect(helpers.referencedAssets(code, 'https://example.com/game/assets/index-abc.js')).toEqual(['https://example.com/game/assets/auckland-roads-C8f2.bin']);
  });
});
