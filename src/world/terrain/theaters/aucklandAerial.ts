/**
 * Open data 4 (#6): the real aerial photo of Auckland's CBD and waterfront (LINZ Auckland 0.075 m
 * Urban Aerial Photos 2024–2025, captured January 2024, CC BY 4.0), baked by tools/linz/aerial.py.
 *
 * One square over the city (AERIAL_RECT: Westhaven to the Ports of Auckland, Devonport and the naval
 * base to the Domain and Grafton) in game XZ, north up: image row 0 is z0, column 0 is x0.
 *
 *   auckland-aerial-2048.webp  2.5 m / px  (medium tier)
 *   auckland-aerial-4096.webp  1.25 m / px (high tier)
 *
 * RGB is the photo with its shadows lifted and contrast eased (the game lights it with its own sun);
 * alpha marks where the photo applies: land (≥ 2 m inside the LINZ coastline) and the OSM wharf, pier
 * and breakwater decks. Open water is alpha 0 (its colour is edge-padded from the land, which keeps
 * the file small and the filtered edges clean).
 *
 * The terrain shader replaces its procedural ground colour with the photo inside the square, faded
 * out over the outer AERIAL_FEATHER m; the wharf decks and the naval base's roofs take it on their top
 * faces (scenery building material). The scattered houses and trees stay off it: the photo already
 * shows the real ones. Low tier: never fetched. Each file is a separate Vite asset fetched once, only
 * by the tier that uses it (public/sw.js ON_DEMAND keeps both out of the precache).
 */
import type { TimeOfDay } from '../../../core/types';
import aerial2048Url from '../data/auckland-aerial-2048.webp?url';
import aerial4096Url from '../data/auckland-aerial-4096.webp?url';

/** Photo square (m, game XZ): x0, z0 = north-west corner, size = side. */
export const AERIAL_RECT = { x0: -1536, z0: -3072, size: 5120 } as const;
/** Width (m) of the fade from photo to procedural ground along the square's edge. */
export const AERIAL_FEATHER = 320;

/** Texture size per tier (0 = none). */
export type AerialSize = 0 | 2048 | 4096;

/** Resolved by Vite relative to the bundle. Importing the URLs downloads nothing. */
export const AERIAL_URLS: Record<Exclude<AerialSize, 0>, string> = { 2048: aerial2048Url, 4096: aerial4096Url };

/**
 * Weight of the photo at (x, z) from the square alone (1 inside, fading to 0 across the feather band
 * at the edge); the shader multiplies it by the photo's alpha. Same curve as the shader's.
 */
export function aerialEdgeWeight(x: number, z: number): number {
  const r = AERIAL_RECT;
  const e = Math.min(x - r.x0, r.x0 + r.size - x, z - r.z0, r.z0 + r.size - z);
  const t = Math.min(1, Math.max(0, e / AERIAL_FEATHER));
  return t * t * (3 - 2 * t);
}

/** True where the photo dominates the ground (edge weight > ½): no scattered houses or trees. */
export function aerialCovers(x: number, z: number): boolean {
  return aerialEdgeWeight(x, z) > 0.5;
}

export type AerialImage = ImageBitmap | HTMLImageElement;

/** Strength of the photo's colour grade by day; at dawn, dusk and night it is graded fully. */
export const AERIAL_GRADE_DAY = 0.15;

/**
 * Colour grade of the photo toward the procedural ground's palette (#61 item 5). The photo's average
 * (linear RGB, imageMeanLinear()) is darker and greyer than the procedural suburbs it fades into,
 * which by day barely shows but at dawn (a dark, flat photo next to bright lawns) and at night (cool
 * grey next to warm tan) draws the square's edge. Returns the per-channel gain that brings the
 * average onto `target` (the procedural suburbs' far albedo; clamped to 0.6–1.8) and how much of it
 * to apply: a trace by day, all of it at dawn, dusk and night.
 */
export function aerialGrade(mean: readonly [number, number, number] | null, target: readonly [number, number, number], tod: TimeOfDay): [number, number, number, number] {
  if (!mean) return [1, 1, 1, 0];
  const g = (i: number) => Math.min(1.8, Math.max(0.6, target[i] / Math.max(1e-4, mean[i])));
  return [g(0), g(1), g(2), tod === 'day' ? AERIAL_GRADE_DAY : 1];
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Average linear-RGB colour of the photo's land (alpha > ½), from a 64² downsample; null without a canvas. */
export function imageMeanLinear(img: AerialImage): [number, number, number] | null {
  try {
    const n = 64;
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(img, 0, 0, n, n);
    const d = g.getImageData(0, 0, n, n).data;
    let r = 0;
    let gr = 0;
    let b = 0;
    let k = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      r += srgbToLinear(d[i] / 255);
      gr += srgbToLinear(d[i + 1] / 255);
      b += srgbToLinear(d[i + 2] / 255);
      k++;
    }
    return k ? [r / k, gr / k, b / k] : null;
  } catch {
    return null;
  }
}

let current: { size: AerialSize; image: AerialImage } | null = null;
let pending: { size: AerialSize; promise: Promise<AerialImage | null> } | null = null;

/** The decoded photo of the given size, or null when it has not been (or could not be) loaded. */
export function aucklandAerial(size: AerialSize): AerialImage | null {
  return current && current.size === size ? current.image : null;
}

/** Decode a WebP blob without the browser flipping or premultiplying it (alpha is a mask, not coverage). */
async function decode(blob: Blob): Promise<AerialImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none', imageOrientation: 'none' });
    } catch {
      /* older Safari: options unsupported, fall through to an <img> */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Fetch and decode the photo of the given size. Resolves to null on any failure (the ground keeps
 * its procedural colours). Concurrent and repeated calls for the same size share the first load.
 */
export function loadAucklandAerial(size: AerialSize, url = size ? AERIAL_URLS[size] : ''): Promise<AerialImage | null> {
  if (!size) return Promise.resolve(null);
  const have = aucklandAerial(size);
  if (have) return Promise.resolve(have);
  if (pending && pending.size === size) return pending.promise;
  const promise = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.blob();
    })
    .then(decode)
    .then((image) => {
      current = { size, image };
      return image as AerialImage | null;
    })
    .catch((err) => {
      console.warn('[world] aerial photo unavailable, using procedural ground', err);
      return null;
    })
    .finally(() => {
      if (pending?.promise === promise) pending = null;
    });
  pending = { size, promise };
  return promise;
}
