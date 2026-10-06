/**
 * Generated textures for the Codex pests (DataTextures, no DOM): the rat's scaly tail and the wasp's
 * veined wings and faceted eyes. Each is built once and shared.
 */
import { DataTexture, LinearFilter, LinearMipmapLinearFilter, RepeatWrapping, RGBAFormat, SRGBColorSpace, type Texture } from 'three';

function tex(w: number, h: number, px: (x: number, y: number) => [number, number, number, number], srgb = true): DataTexture {
  const d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = px(x, y);
      const i = (y * w + x) * 4;
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = a;
    }
  const t = new DataTexture(d, w, h, RGBAFormat);
  if (srgb) t.colorSpace = SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  t.magFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

const cache = new Map<string, Texture>();
function once(key: string, make: () => Texture): Texture {
  let t = cache.get(key);
  if (!t) cache.set(key, (t = make()));
  return t;
}

/**
 * Rat tail scales: rings of overlapping scales (a brick pattern), one tile = one ring, u along the
 * tail, v around it. Grey-white (multiplied by the vertex colour); the grooves dark. Used as map and bump.
 */
export function tailScales(): Texture {
  return once('tailScales', () => {
    const W = 32;
    const H = 128;
    const t = tex(W, H, (x, y) => {
      const ring = x / W; // 0..1 within one ring
      const nScales = 16;
      const off = 0; // one ring per tile; alternate rings are handled by repeat offset below
      const sv = ((y / H) * nScales + off) % 1;
      const edge = Math.min(ring, 1 - ring) * 2; // 0 at the ring groove
      const side = Math.min(sv, 1 - sv) * 2;
      // a scale is brighter at its rear edge (it overlaps the next ring)
      const v = 0.55 + 0.45 * Math.pow(ring, 0.6) * Math.min(1, side * 3);
      const groove = edge < 0.12 || side < 0.08 ? 0.35 : 1;
      const g = Math.round(255 * v * groove);
      return [g, g, g, 255];
    });
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
    return t;
  });
}

/** A line from (x0,y0) to (x1,y1) of width w stamped into an alpha buffer (max). */
function stroke(buf: Float32Array, W: number, H: number, x0: number, y0: number, x1: number, y1: number, w0: number, w1 = w0): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.ceil(len * 2) + 1;
  for (let s = 0; s <= steps; s++) {
    const u = s / steps;
    const cx = x0 + (x1 - x0) * u;
    const cy = y0 + (y1 - y0) * u;
    const w = w0 + (w1 - w0) * u;
    const r = Math.ceil(w + 1);
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(H - 1, Math.ceil(cy + r)); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, Math.ceil(cx + r)); x++) {
        const d = Math.hypot(x - cx, y - cy);
        const a = Math.min(1, Math.max(0, w - d + 0.5));
        const i = y * W + x;
        if (a > buf[i]) buf[i] = a;
      }
  }
}

/**
 * Wasp wing veins over a clear, faintly smoky membrane. Coordinates are the wing's own: u 0..1 from
 * the root to the tip, v 0..1 from the leading (front) edge to the trailing edge. `hind` = the smaller
 * hind wing with fewer cells.
 */
export function waspWing(hind: boolean): Texture {
  return once(hind ? 'wingH' : 'wingF', () => {
    const W = 512;
    const H = 192;
    const veins = new Float32Array(W * H);
    const P = (u: number, v: number): [number, number] => [u * (W - 1), v * (H - 1)];
    const line = (a: [number, number], b: [number, number], w0: number, w1 = w0) => stroke(veins, W, H, a[0], a[1], b[0], b[1], w0, w1);
    if (!hind) {
      // costa and subcosta along the leading edge, the dark pterostigma, radial and cubital cells
      line(P(0.0, 0.18), P(0.62, 0.05), 3.2, 2.2);
      line(P(0.0, 0.26), P(0.6, 0.1), 2.6, 1.8);
      for (let i = 0; i < 14; i++) line(P(0.6 + i * 0.006, 0.05), P(0.6 + i * 0.006, 0.12), 2); // pterostigma
      line(P(0.6, 0.11), P(0.94, 0.16), 1.6, 1.0); // radial cell (long, closed near the tip)
      line(P(0.66, 0.2), P(0.94, 0.16), 1.4, 1.0);
      line(P(0.0, 0.34), P(0.38, 0.32), 2.4, 1.8); // media + cubitus
      line(P(0.38, 0.32), P(0.6, 0.11), 1.8, 1.6);
      line(P(0.38, 0.32), P(0.52, 0.42), 1.6);
      line(P(0.52, 0.42), P(0.66, 0.2), 1.4); // 1st submarginal
      line(P(0.52, 0.42), P(0.72, 0.4), 1.4);
      line(P(0.72, 0.4), P(0.74, 0.21), 1.3); // 2nd / 3rd submarginal
      line(P(0.72, 0.4), P(0.82, 0.38), 1.2);
      line(P(0.82, 0.38), P(0.82, 0.19), 1.1);
      line(P(0.0, 0.42), P(0.36, 0.56), 2.0, 1.6); // discoidal / medial cells
      line(P(0.36, 0.56), P(0.52, 0.42), 1.4);
      line(P(0.36, 0.56), P(0.62, 0.66), 1.3, 1.0);
      line(P(0.62, 0.66), P(0.72, 0.4), 1.2);
      line(P(0.62, 0.66), P(0.85, 0.78), 1.0, 0.6);
      line(P(0.0, 0.5), P(0.3, 0.74), 1.8, 1.2); // anal
      line(P(0.3, 0.74), P(0.36, 0.56), 1.2);
      line(P(0.3, 0.74), P(0.5, 0.86), 1.0, 0.6);
    } else {
      line(P(0.0, 0.2), P(0.66, 0.12), 2.6, 1.4);
      line(P(0.0, 0.32), P(0.36, 0.34), 2.0, 1.6);
      line(P(0.36, 0.34), P(0.66, 0.12), 1.4);
      line(P(0.36, 0.34), P(0.82, 0.42), 1.2, 0.7);
      line(P(0.0, 0.46), P(0.26, 0.54), 1.6, 1.2);
      line(P(0.26, 0.54), P(0.36, 0.34), 1.2);
      line(P(0.26, 0.54), P(0.55, 0.72), 1.0, 0.6);
      for (let i = 0; i < 4; i++) line(P(0.45 + i * 0.012, 0.06), P(0.46 + i * 0.012, 0.1), 0.9); // hamuli
    }
    return tex(W, H, (x, y) => {
      const a = veins[y * W + x];
      const u = x / W;
      const v = y / H;
      // pterostigma darker; membrane faintly amber near the root and smoky along the front edge
      const stig = !hind && u > 0.59 && u < 0.69 && v > 0.04 && v < 0.13 ? 1 : 0;
      const mr = 214 - 30 * (1 - u) * (1 - v);
      const membrane: [number, number, number] = [mr, mr - 14, mr - 40];
      const vein: [number, number, number] = stig ? [92, 58, 22] : [78, 56, 32];
      const k = Math.max(a, stig);
      const alpha = 0.16 + 0.1 * (1 - v) + 0.74 * k;
      return [
        Math.round(membrane[0] + (vein[0] - membrane[0]) * k),
        Math.round(membrane[1] + (vein[1] - membrane[1]) * k),
        Math.round(membrane[2] + (vein[2] - membrane[2]) * k),
        Math.round(255 * Math.min(1, alpha)),
      ];
    });
  });
}

/** Compound-eye facets: a hexagonal grid of tiny lenses (used as a bump map on the eyes). */
export function facets(): Texture {
  return once('facets', () => {
    const W = 128;
    const H = 128;
    const cells = 16;
    const t = tex(
      W,
      H,
      (x, y) => {
        const sx = (x / W) * cells;
        const sy = (y / H) * cells * 1.1547;
        const row = Math.floor(sy);
        const fx = sx + (row % 2 ? 0.5 : 0);
        const dx = (fx % 1) - 0.5;
        const dy = (sy % 1) - 0.5;
        const d = Math.min(1, Math.hypot(dx, dy * 0.9) * 2);
        const g = Math.round(255 * Math.sqrt(Math.max(0, 1 - d * d)));
        return [g, g, g, 255];
      },
      false,
    );
    t.wrapS = RepeatWrapping;
    t.wrapT = RepeatWrapping;
    return t;
  });
}
