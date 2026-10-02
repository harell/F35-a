/**
 * Open data 4 (#6): the CBD / waterfront aerial photo (src/world/terrain/theaters/aucklandAerial.ts,
 * src/world/terrain/data/auckland-aerial-{2048,4096}.webp baked by tools/linz/aerial.py).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AKL } from '../src/core/auckland';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../src/core/data';
import { worldConfig } from '../src/world/config';
import {
  AERIAL_FEATHER,
  AERIAL_RECT,
  AERIAL_URLS,
  aerialCovers,
  aerialEdgeWeight,
  aucklandAerial,
  loadAucklandAerial,
} from '../src/world/terrain/theaters/aucklandAerial';
import { terrainFragmentShader } from '../src/world/terrain/terrainShader';
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

const file = (size: number) => new Uint8Array(fs.readFileSync(new URL(`../src/world/terrain/data/auckland-aerial-${size}.webp`, import.meta.url)));

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
  });

  it('the service worker never precaches either size (other lazily referenced assets still are)', () => {
    const helpers = new Function('self', `${sw.slice(0, sw.indexOf("self.addEventListener('install'"))}; return { referencedAssets };`)({
      registration: { scope: 'https://example.com/game/' },
      location: { origin: 'https://example.com' },
    }) as { referencedAssets: (c: string, u: string) => string[] };
    const code =
      'a=new URL(`auckland-aerial-2048-Bx_9-k2Q.webp`,import.meta.url).href;b=new URL("auckland-aerial-4096-a1B2c3D4.webp",import.meta.url);c=new URL(`auckland-roads-C8f2.bin`,import.meta.url)';
    expect(helpers.referencedAssets(code, 'https://example.com/game/assets/index-abc.js')).toEqual(['https://example.com/game/assets/auckland-roads-C8f2.bin']);
  });
});
