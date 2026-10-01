/**
 * F-35A skin pass (issue #14): paint value, roughness atlas, heat/wear weathering.
 * Runs the painters against a recording fake 2D canvas (node has none) and checks the node fallback.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Color, MeshStandardMaterial, NoColorSpace, SRGBColorSpace, type Texture } from 'three';
import { F35_ATLAS } from '../src/render/models/aircraft/f35a';
import { F35_PAINT, f35RoughSize, registerF35Materials } from '../src/render/models/aircraft/liveries';
import { disposeMaterials, getMaterial, getVariant, modelQuality } from '../src/render/models/materials';

/** Every colour string the painter set (fill/stroke styles, gradient stops), plus the canvases created. */
interface Recording {
  canvases: FakeCanvas[];
  styles: string[];
}
let rec: Recording = { canvases: [], styles: [] };

class FakeCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {
    rec.canvases.push(this);
  }
  getContext(): unknown {
    const canvas = this;
    const state: Record<string | symbol, unknown> = { canvas };
    const gradient = { addColorStop: (_: number, c: string) => rec.styles.push(c) };
    return new Proxy(state, {
      get(t, k) {
        if (k in t) return t[k];
        if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => gradient;
        if (k === 'createImageData') return (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) });
        return () => {};
      },
      set(t, k, v) {
        if ((k === 'fillStyle' || k === 'strokeStyle') && typeof v === 'string') rec.styles.push(v);
        t[k] = v;
        return true;
      },
    });
  }
}

function buildSkin(textureSize: number): MeshStandardMaterial {
  rec = { canvases: [], styles: [] };
  modelQuality.textureSize = textureSize;
  disposeMaterials();
  registerF35Materials(F35_ATLAS);
  return getMaterial('f35.skin') as MeshStandardMaterial;
}

/** Parse 'rgba(r,g,b,a)' / '#rrggbb' into [r, g, b, a]. */
function parse(style: string): [number, number, number, number] | null {
  const m = style.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const [r, g, b, a = 1] = m[1].split(',').map(Number);
    return [r, g, b, a];
  }
  if (/^#[0-9a-f]{6}$/i.test(style)) {
    const n = parseInt(style.slice(1), 16);
    return [n >> 16, (n >> 8) & 255, n & 255, 1];
  }
  return null;
}

afterEach(() => {
  vi.unstubAllGlobals();
  modelQuality.textureSize = 1024;
  disposeMaterials();
});

describe('F-35A paint value (A1)', () => {
  it('base grey is darker than the old #5f6468 and near-monochrome', () => {
    const c = new Color(F35_PAINT.base);
    const old = new Color('#5f6468');
    const lum = (k: Color) => 0.2126 * k.r + 0.7152 * k.g + 0.0722 * k.b;
    expect(lum(c)).toBeLessThan(lum(old) * 0.85);
    const [r, g, b] = parse(F35_PAINT.base)!;
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(3);
    // not bluish: blue never exceeds red (the sky reflection already adds blue)
    expect(b).toBeLessThanOrEqual(r);
    expect(F35_PAINT.fallback).toBe(c.getHex());
  });

  it('paints no white highlight stripes (chine / leading-edge lines are toned down)', () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    buildSkin(1024);
    const whites = rec.styles.map(parse).filter((p): p is [number, number, number, number] => !!p && p[0] > 180 && p[1] > 180 && p[2] > 180);
    // only the colour canvas paints near-white tints, and only at grain/edge-tone strength;
    // the roughness canvas paints opaque greys (r = g = b), so exclude opaque values here
    const translucent = whites.filter((p) => p[3] < 1);
    expect(translucent.length).toBeGreaterThan(0);
    for (const p of translucent) expect(p[3]).toBeLessThanOrEqual(0.04);
  });
});

describe('F-35A roughness map (A2)', () => {
  it('wires a linear, single extra ≤1024² roughnessMap next to the colour map', () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const m = buildSkin(2048);
    // colour atlas + roughness atlas (the six 64² env-cube faces aside)
    expect(rec.canvases.filter((c) => c.width > 64)).toHaveLength(2);
    expect(m.map).toBeTruthy();
    expect((m.map as Texture).colorSpace).toBe(SRGBColorSpace);
    expect(m.roughnessMap).toBeTruthy();
    const rm = m.roughnessMap as Texture;
    expect(rm.colorSpace).toBe(NoColorSpace);
    const img = rm.image as { width: number; height: number };
    expect(img.width).toBeLessThanOrEqual(1024);
    expect(img.height).toBe(img.width);
    // the map holds absolute roughness
    expect(m.roughness).toBe(1);
  });

  it('roughness atlas is ≤1024² at every quality level', () => {
    for (const ts of [512, 1024, 2048, 4096]) {
      const s = f35RoughSize(ts);
      expect(s).toBeLessThanOrEqual(1024);
      expect(s).toBeGreaterThanOrEqual(256);
    }
    expect(f35RoughSize(2048)).toBe(1024);
  });

  it('paints sheen variation: grey-only values spanning glossy wear to matte tape and heat', () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    buildSkin(1024);
    // roughness values are written via rv(): opaque or translucent pure greys
    const greys = rec.styles
      .map(parse)
      .filter((p): p is [number, number, number, number] => !!p && p[0] === p[1] && p[1] === p[2] && p[3] >= 0.5)
      .map((p) => p[0] / 255);
    const lo = Math.min(...greys);
    const hi = Math.max(...greys);
    expect(lo).toBeLessThan(0.45); // burnished leading-edge wear / glossier markings
    expect(hi).toBeGreaterThan(0.8); // heat-dulled, sooty aft deck
    // panel-to-panel variation: many distinct values around the mean
    const near = new Set(greys.filter((g) => Math.abs(g - F35_PAINT.roughness) < 0.08).map((g) => g.toFixed(3)));
    expect(near.size).toBeGreaterThan(10);
  });

  it('degrades gracefully without a canvas (node): scalar roughness, no maps', () => {
    const m = buildSkin(1024);
    expect(m.map).toBeNull();
    expect(m.roughnessMap).toBeNull();
    expect(m.roughness).toBe(F35_PAINT.roughness);
    expect(m.color.getHex()).toBe(F35_PAINT.fallback);
  });

  it('LOD1 variant keeps the roughness map (shared texture, no copy)', () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    const m = buildSkin(1024);
    const v = getVariant('f35.skin', 'lod1', (b) => b.clone()) as MeshStandardMaterial;
    expect(v.roughnessMap).toBe(m.roughnessMap);
  });
});

describe('F-35A weathering (A4)', () => {
  it('adds warm heat-stain bands and dark soot on the colour map', () => {
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    buildSkin(1024);
    const tints = rec.styles.map(parse).filter((p): p is [number, number, number, number] => !!p && p[3] < 0.3);
    // heat stain: translucent warm browns (r > b)
    const warm = tints.filter(([r, g, b]) => r > 60 && r - b >= 20 && g < r);
    expect(warm.length).toBeGreaterThanOrEqual(2);
    // soot / exhaust wash streaks: translucent near-black
    const soot = tints.filter(([r, g, b]) => r < 25 && g < 25 && b < 25);
    expect(soot.length).toBeGreaterThan(20);
  });
});
