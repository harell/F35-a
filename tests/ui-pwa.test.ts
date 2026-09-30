/**
 * PWA checks (manifest, icons, service worker). Files are read through Vite's ?raw / ?inline imports
 * so the test needs no Node typings.
 */
import { describe, expect, it } from 'vitest';
import manifestRaw from '../public/manifest.webmanifest?raw';
import sw from '../public/sw.js?raw';
import typesSrc from '../src/core/types.ts?raw';
import indexHtml from '../index.html?raw';

const icons = import.meta.glob('../public/icons/*', { query: '?inline', import: 'default', eager: true }) as Record<string, string>;
const iconNames = Object.keys(icons).map((k) => k.replace('../public/', ''));

/** Decode a data: URL (base64) to bytes. */
function bytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

describe('PWA manifest', () => {
  const m = JSON.parse(manifestRaw);

  it('names, display and orientation', () => {
    expect(m.name).toBe('F35-A Ratites');
    expect(m.short_name).toBe('F35-A');
    expect(m.display).toBe('fullscreen');
    expect(m.orientation).toBe('landscape');
    expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.start_url).toBe('./');
  });

  it('has 192/512 icons, a maskable 512 and every icon file exists', () => {
    const sizes = m.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(m.icons.some((i: { purpose?: string; sizes: string }) => i.purpose === 'maskable' && i.sizes === '512x512')).toBe(true);
    for (const i of m.icons) expect(iconNames, i.src).toContain(i.src);
  });

  it('index.html references icons that exist (apple 180, favicon 192)', () => {
    const refs = [...indexHtml.matchAll(/href="\.\/(icons\/[^"]+)"/g)].map((x) => x[1]);
    expect(refs.length).toBeGreaterThanOrEqual(2);
    for (const r of refs) expect(iconNames, r).toContain(r);
  });

  it('PNG icons have the declared pixel sizes', () => {
    for (const [file, size] of [
      ['icons/icon-192.png', 192],
      ['icons/icon-512.png', 512],
      ['icons/icon-maskable-512.png', 512],
      ['icons/icon-180.png', 180],
    ] as const) {
      const b = bytes(icons[`../public/${file}`]);
      expect(String.fromCharCode(b[1], b[2], b[3]), file).toBe('PNG');
      expect(u32(b, 16), file).toBe(size);
      expect(u32(b, 20), file).toBe(size);
    }
  });
});

/** Every un-hashed public asset whose change must reinstall the service worker (and so bump VERSION). */
const publicAssets = import.meta.glob(['../public/audio/**/*', '../public/textures/**/*', '../public/icons/**/*'], {
  query: '?inline',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** FNV-1a (32-bit) over the sorted asset paths and their bytes (base64 data URLs) plus the manifest. */
export function publicAssetHash(): string {
  let h = 0x811c9dc5;
  const feed = (str: string) => {
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const k of Object.keys(publicAssets).sort()) {
    feed(k);
    feed(publicAssets[k]);
  }
  feed('manifest.webmanifest');
  feed(manifestRaw);
  return h.toString(16).padStart(8, '0');
}

describe('service worker', () => {
  it('VERSION carries the content hash of the public assets (asset change => new SW => fresh caches)', () => {
    const v = /const VERSION = '([^']+)'/.exec(sw)?.[1] ?? '';
    const hash = publicAssetHash();
    expect(Object.keys(publicAssets).some((k) => k.includes('/audio/voice/'))).toBe(true);
    expect(Object.keys(publicAssets).some((k) => k.includes('/textures/'))).toBe(true);
    expect(v, `public assets changed: set VERSION in public/sw.js to end with '-${hash}'`).toMatch(new RegExp(`-${hash}$`));
    expect(v).not.toBe('1.0.0-1');
  });

  it('un-hashed public files (voices, textures, icons) are stale-while-revalidate, hashed bundles cache-first', () => {
    const helpers = new Function('self', `${sw.slice(0, sw.indexOf("self.addEventListener('install'"))}; ${sw.slice(sw.indexOf('function isUnhashed'), sw.indexOf('async function staleWhileRevalidate'))}; return { isUnhashed };`)({
      registration: { scope: 'https://example.com/game/' },
      location: { origin: 'https://example.com' },
    }) as { isUnhashed: (u: URL) => boolean };
    expect(helpers.isUnhashed(new URL('https://example.com/game/audio/voice/b_missile.mp3'))).toBe(true);
    expect(helpers.isUnhashed(new URL('https://example.com/game/textures/waternormals.jpg'))).toBe(true);
    expect(helpers.isUnhashed(new URL('https://example.com/game/icons/icon-192.png'))).toBe(true);
    expect(helpers.isUnhashed(new URL('https://example.com/game/manifest.webmanifest'))).toBe(true);
    expect(helpers.isUnhashed(new URL('https://example.com/game/assets/index-abc123.js'))).toBe(false);
    expect(sw).toContain('event.respondWith(staleWhileRevalidate(event))');
    expect(sw).toContain('event.waitUntil(refresh)');
  });

  it('precaches every VoiceId clip listed in core/types.ts', () => {
    const block = typesSrc.slice(typesSrc.indexOf('export type VoiceId'), typesSrc.indexOf('export type ExplosionSize'));
    const voiceIds = [...block.matchAll(/\|\s*'([a-z0-9_]+)'/g)].map((x) => x[1]).sort();
    const start = sw.indexOf('const VOICES = [');
    const listBlock = sw.slice(start, sw.indexOf('];', start));
    const swIds = [...listBlock.matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]).sort();
    expect(voiceIds.length).toBeGreaterThan(30);
    expect(swIds).toEqual(voiceIds);
  });

  it('is versioned, cleans old caches, network-first navigation, cache-first assets', () => {
    expect(sw).toMatch(/const VERSION = '[^']+'/);
    expect(sw).toContain('caches.delete(key)');
    expect(sw).toContain("req.mode === 'navigate'");
    expect(sw).toContain('networkFirstNavigation');
    expect(sw).toContain('cacheFirst');
    expect(sw).toContain("'index.html'");
    expect(sw).toContain("'manifest.webmanifest'");
  });

  it('parses, and discovers bundle + lazily referenced assets', () => {
    expect(() => new Function(sw)).not.toThrow();
    // evaluate the pure helpers with a fake scope
    const helpers = new Function('self', `${sw.slice(0, sw.indexOf("self.addEventListener('install'"))}; return { bundleAssets, referencedAssets };`)({
      registration: { scope: 'https://example.com/game/' },
      location: { origin: 'https://example.com' },
    }) as { bundleAssets: (h: string) => string[]; referencedAssets: (c: string, u: string) => string[] };
    expect(
      helpers.bundleAssets('<script type="module" crossorigin src="./assets/index-abc.js"></script><link rel="modulepreload" href="./assets/three-x.js"><link rel="stylesheet" href="./assets/index-1.css"><link rel="icon" href="https://cdn.example/x.png">'),
    ).toEqual(['./assets/index-abc.js', './assets/three-x.js', './assets/index-1.css']);
    const found = helpers.referencedAssets('new URL(`worker-D4qW.js`,import.meta.url); t.load("./textures/moon_1024.jpg"); new URL("B612-x.ttf", import.meta.url)', 'https://example.com/game/assets/index-abc.js');
    expect(found).toContain('https://example.com/game/assets/worker-D4qW.js');
    expect(found).toContain('https://example.com/game/assets/B612-x.ttf');
    expect(found).toContain('https://example.com/game/textures/moon_1024.jpg');
  });
});
