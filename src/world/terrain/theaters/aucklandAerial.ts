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
 *
 * The outer photo (#120): the rest of the Devonport peninsula (Stanley Bay, Bayswater, Belmont, Narrow Neck,
 * Cheltenham, North Head) at the square's resolution and the gulf islands (Rangitoto, Motutapu, Rakino, Motuihe,
 * Browns Island, Waiheke with Pakatoa and Rotoroa) at 5 m (high) / 10 m (medium), as boxes packed into one atlas
 * per tier (AERIAL_OUTER, auckland-aerial-outer.json, both baked by aerial.py):
 *
 *   auckland-aerial-outer-2048.webp  2048 px wide (medium tier)
 *   auckland-aerial-outer-4096.ktx2  4096 px wide (high tier), with its alpha in auckland-aerial-outer-cover.png
 *
 * The high tier's atlas is GPU-compressed (KTX2, Basis Universal ETC1S): three.js's KTX2Loader transcodes it in a
 * worker to the GPU's own block format (BC7, ASTC, ETC2 or BC3: 1 byte a pixel), so its 27.5 Mpx take ~35 MB of GPU
 * memory instead of ~140 MB as RGBA8 with mips, and arrive with their mips (none built on the main thread). A
 * compressed texture can't be read back, so the scatters read the alpha from the small cover PNG beside it.
 *
 * Each box fades out over its own feather; the Devonport boxes overlap the square (and each other) by their feather
 * so the fades cross over and no edge shows; the island boxes' alpha is the islands' land only. The terrain shader
 * sums the weights of the square and every box (aerialPhoto()); the scatters keep off where the sum is over ½
 * (aerialCovers with the outer photo's alpha, read back at load: AerialOuterCover).
 */
import type { CompressedTexture, WebGLRenderer } from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import type { TimeOfDay } from '../../../core/types';
import { scatterKeep } from '../../scenery/scatter';
import aerial2048Url from '../data/auckland-aerial-2048.webp?url';
import aerial4096Url from '../data/auckland-aerial-4096.webp?url';
import outer2048Url from '../data/auckland-aerial-outer-2048.webp?url';
import outer4096Url from '../data/auckland-aerial-outer-4096.ktx2?url';
import outerCoverUrl from '../data/auckland-aerial-outer-cover.png?url';
import outerLayout from '../data/auckland-aerial-outer.json';

/** Photo square (m, game XZ): x0, z0 = north-west corner, size = side. */
export const AERIAL_RECT = { x0: -1536, z0: -3072, size: 5120 } as const;
/** Width (m) of the fade from photo to procedural ground along the square's edge. */
export const AERIAL_FEATHER = 320;

/** Texture size per tier (0 = none). */
export type AerialSize = 0 | 2048 | 4096;

/** Resolved by Vite relative to the bundle. Importing the URLs downloads nothing. */
export const AERIAL_URLS: Record<Exclude<AerialSize, 0>, string> = { 2048: aerial2048Url, 4096: aerial4096Url };

/** A photo box in game XZ (m): north-west corner, width, height, and the width of the fade at its edge. */
export interface AerialBox {
  name: string;
  x0: number;
  z0: number;
  w: number;
  h: number;
  feather: number;
}

/** Weight of a box at (x, z): 1 inside, fading to 0 across its feather at the edge (smoothstep). Same curve as the shader's. */
export function aerialBoxWeight(b: Pick<AerialBox, 'x0' | 'z0' | 'w' | 'h' | 'feather'>, x: number, z: number): number {
  const e = Math.min(x - b.x0, b.x0 + b.w - x, z - b.z0, b.z0 + b.h - z);
  const t = Math.min(1, Math.max(0, e / b.feather));
  return t * t * (3 - 2 * t);
}

/**
 * Weight of the photo at (x, z) from the square alone (1 inside, fading to 0 across the feather band
 * at the edge); the shader multiplies it by the photo's alpha. Same curve as the shader's.
 */
export function aerialEdgeWeight(x: number, z: number): number {
  const r = AERIAL_RECT;
  return aerialBoxWeight({ x0: r.x0, z0: r.z0, w: r.size, h: r.size, feather: AERIAL_FEATHER }, x, z);
}

/** The outer photo's boxes (#120): the rest of the Devonport peninsula and the gulf islands. */
export const AERIAL_OUTER: readonly AerialBox[] = outerLayout.rects;
/** Most boxes the shader takes (terrainShader.ts MAX_AERIAL_BOXES). */
export const MAX_AERIAL_BOXES = 8;

/** Resolved by Vite relative to the bundle. Importing the URLs downloads nothing. */
export const AERIAL_OUTER_URLS: Record<Exclude<AerialSize, 0>, string> = { 2048: outer2048Url, 4096: outer4096Url };
/** The alpha of the KTX2 atlas (high tier), 512 px wide, for the scatters (imageAlphaMask). */
export const AERIAL_OUTER_COVER_URL: string = outerCoverUrl;
/** Tiers whose outer atlas is a KTX2 file (tools/linz/aerial.py OUTER_KTX2). */
export const aerialOuterKtx2 = (size: AerialSize): boolean => size === 4096;

/** Where each AERIAL_OUTER box lies in a tier's atlas: [u0, v0, u1, v1] (0..1; v = 0 is the image's top row). */
export function aerialOuterUv(size: Exclude<AerialSize, 0>): [number, number, number, number][] {
  const t = outerLayout.tiers[String(size) as '2048' | '4096'];
  return t.boxes.map(([a, b, c, d]) => [a / t.width, b / t.height, c / t.width, d / t.height]);
}

/** Atlas size (px) of a tier's outer photo. */
export function aerialOuterSize(size: Exclude<AerialSize, 0>): { width: number; height: number } {
  const t = outerLayout.tiers[String(size) as '2048' | '4096'];
  return { width: t.width, height: t.height };
}

/**
 * The outer photo's alpha, read back at load (imageAlphaMask) so the scatters know where it shows land: a coarse
 * copy of the atlas's alpha (row-major, top row first) and each box's place in it (aerialOuterUv).
 */
export interface AerialOuterCover {
  alpha: Uint8Array;
  width: number;
  height: number;
  uv: readonly (readonly [number, number, number, number])[];
}

/** Alpha (0..1) of the outer photo for box `i` at (x, z), nearest cell of the coarse copy. */
function outerAlpha(c: AerialOuterCover, i: number, x: number, z: number): number {
  const b = AERIAL_OUTER[i];
  const [u0, v0, u1, v1] = c.uv[i];
  const u = u0 + ((x - b.x0) / b.w) * (u1 - u0);
  const v = v0 + ((z - b.z0) / b.h) * (v1 - v0);
  const ci = Math.min(c.width - 1, Math.max(0, Math.floor(u * c.width)));
  const cj = Math.min(c.height - 1, Math.max(0, Math.floor(v * c.height)));
  return c.alpha[cj * c.width + ci] / 255;
}

/**
 * Weight of all the photo at (x, z), as the terrain shader sums it: the square's edge weight (its alpha left out, as
 * always: the scatters only stand on land), plus each outer box's edge weight × its alpha; at most 1.
 */
export function aerialWeight(x: number, z: number, outer?: AerialOuterCover | null): number {
  let w = aerialEdgeWeight(x, z);
  if (outer && w < 1) {
    for (let i = 0; i < AERIAL_OUTER.length; i++) {
      const b = AERIAL_OUTER[i];
      if (x <= b.x0 || x >= b.x0 + b.w || z <= b.z0 || z >= b.z0 + b.h) continue;
      const e = aerialBoxWeight(b, x, z);
      if (e > 0) w += e * outerAlpha(outer, i, x, z);
    }
  }
  return Math.min(1, w);
}

/** True where the photo dominates the ground (weight > ½): no scattered houses or trees. */
export function aerialCovers(x: number, z: number, outer?: AerialOuterCover | null): boolean {
  return aerialWeight(x, z, outer) > 0.5;
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

/**
 * Share of the photo lit like a roof facing a low sun (#61 item 5, part 2). The procedural near field
 * beside the photo shades its painted roofs and its 3D houses by their slope to the sun, so under a
 * low sun their sun-facing roofs and walls catch it, while the photo, lit as flat ground, only gets
 * sin(elevation) of the sun: at dawn and dusk it read dark and flat beside bright houses. The photo is
 * a city of roofs, so this share of it also takes the light of a 28° roof facing the sun (the
 * procedural houses' pitch), above what flat ground gets. By day a high sun lights flat ground as well
 * as such a roof, and the moon is high: nothing changes then.
 */
export const AERIAL_LOW_SUN_SHARE = 0.8;
// (the share was set against the houses drawn at full density, near the camera: see aerialHouseShare())

/**
 * Extra direct light on the photo (in units of the sun's light on ground facing it) for a sun whose
 * direction has height `sunY` (sin of the elevation). Same as the shaders' aerialLowSun() (AERIAL_LIGHT_GLSL).
 */
export function aerialLowSun(sunY: number): number {
  const y = Math.max(sunY, 0);
  const facing = 0.88 * y + 0.47 * Math.sqrt(1 - y * y);
  const t = Math.min(1, Math.max(0, (sunY - 0.2) / 0.25));
  return AERIAL_LOW_SUN_SHARE * Math.max(facing - y, 0) * (1 - t * t * (3 - 2 * t));
}

/**
 * How much of the photo's low-sun light applies at range `ds` (m) from the camera, for the procedural
 * houses' scatter radius `houseRadius` (config.ts; 0 = none). The light stands in for the 3D houses'
 * sun-facing roofs and walls beside the photo; they thin with range and stop at their radius (and are
 * hidden once the camera is higher than it), past which both sides are lit as flat ground. So the light
 * follows the houses' drawn share (scatter.ts scatterKeep), faded out before their edge rather than cut
 * there. Same as the shaders' aerialHouseShare() (AERIAL_LIGHT_GLSL).
 */
export function aerialHouseShare(ds: number, houseRadius: number): number {
  if (houseRadius <= 0) return 0;
  const R = houseRadius;
  const t = Math.min(1, Math.max(0, (ds - 0.9 * R) / (0.12 * R)));
  return scatterKeep(ds, R) * (1 - t * t * (3 - 2 * t));
}

/**
 * At night the photo's albedo is mixed this far toward the procedural ground's own colour at the same
 * place (#61 item 5, part 2). The night lamps and lit windows drawn over the photo are the procedural
 * pattern's (urbanPattern / cbdPattern run under the photo at night for them), and the procedural
 * ground they light is warmer than the moonlit photo, which stayed a cool grey square in the warm city.
 */
export const AERIAL_NIGHT_MIX = 0.5;

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

/** Alpha of an image downsampled to `width` columns (canvas), for AerialOuterCover; null without a canvas. */
export function imageAlphaMask(img: AerialImage, width = 512): { alpha: Uint8Array; width: number; height: number } | null {
  try {
    const w = Math.min(width, img.width);
    const h = Math.max(1, Math.round((img.height * w) / img.width));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(img, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const alpha = new Uint8Array(w * h);
    for (let k = 0; k < alpha.length; k++) alpha[k] = d[4 * k + 3];
    return { alpha, width: w, height: h };
  } catch {
    return null;
  }
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

const fetchOk = (url: string): Promise<Response> =>
  fetch(url).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  });

/** Fetch and decode an image file (WebP, PNG). */
const readImage = (url: string): Promise<AerialImage> =>
  fetchOk(url)
    .then((res) => res.blob())
    .then(decode);

/**
 * One photo file per tier, fetched and read once by `read`: concurrent and repeated calls for a size share the first
 * load.
 */
function photoLoader<T, A extends unknown[] = []>(urls: Record<Exclude<AerialSize, 0>, string>, what: string, read: (url: string, size: AerialSize, ...args: A) => Promise<T>) {
  let current: { size: AerialSize; photo: T } | null = null;
  let pending: { size: AerialSize; promise: Promise<T | null> } | null = null;
  const get = (size: AerialSize): T | null => (current && current.size === size ? current.photo : null);
  const load = (size: AerialSize, url = size ? urls[size] : '', ...args: A): Promise<T | null> => {
    if (!size) return Promise.resolve(null);
    const have = get(size);
    if (have) return Promise.resolve(have);
    if (pending && pending.size === size) return pending.promise;
    const promise = read(url, size, ...args)
      .then((photo) => {
        current = { size, photo };
        return photo as T | null;
      })
      .catch((err) => {
        console.warn(`[world] ${what} unavailable, using procedural ground`, err);
        return null;
      })
      .finally(() => {
        if (pending?.promise === promise) pending = null;
      });
    pending = { size, promise };
    return promise;
  };
  return { get, load };
}

/**
 * The outer photo of a tier: the decoded image (WebP, medium), or the GPU-compressed texture (KTX2, high) with its
 * alpha cover beside it (null if the cover failed: the scatters then ignore the outer photo, as before #120).
 */
export type AerialOuterPhoto = { image: AerialImage; texture?: undefined; cover?: undefined } | { image?: undefined; texture: CompressedTexture; cover: AerialImage | null };

/** Fetch the KTX2 atlas and transcode it for this renderer's GPU (three.js KTX2Loader, in a worker), and its cover. */
async function readKtx2(url: string, renderer?: WebGLRenderer): Promise<AerialOuterPhoto> {
  if (!renderer) throw new Error('a KTX2 atlas needs the renderer');
  const cover = readImage(AERIAL_OUTER_COVER_URL).catch((err) => {
    console.warn('[world] outer aerial photo cover unavailable, the scatters ignore the outer photo', err);
    return null;
  });
  const buffer = await fetchOk(url).then((res) => res.arrayBuffer());
  const loader = new KTX2Loader().detectSupport(renderer);
  try {
    const texture = await new Promise<CompressedTexture>((resolve, reject) => loader.parse(buffer, resolve, reject));
    return { texture, cover: await cover };
  } finally {
    // once per tier: the transcoder's workers aren't needed after
    loader.dispose();
  }
}

const square = photoLoader(AERIAL_URLS, 'aerial photo', readImage);
const outer = photoLoader(AERIAL_OUTER_URLS, 'outer aerial photo (Devonport, gulf islands)', (url, size, renderer?: WebGLRenderer) =>
  aerialOuterKtx2(size) ? readKtx2(url, renderer) : readImage(url).then((image): AerialOuterPhoto => ({ image })),
);

/** The decoded photo of the given size, or null when it has not been (or could not be) loaded. */
export function aucklandAerial(size: AerialSize): AerialImage | null {
  return square.get(size);
}

/**
 * Fetch and decode the photo of the given size. Resolves to null on any failure (the ground keeps
 * its procedural colours). Concurrent and repeated calls for the same size share the first load.
 */
export function loadAucklandAerial(size: AerialSize, url?: string): Promise<AerialImage | null> {
  return square.load(size, url);
}

/** The loaded outer photo (Devonport, the gulf islands; #120) of the given size, or null. */
export function aucklandAerialOuter(size: AerialSize): AerialOuterPhoto | null {
  return outer.get(size);
}

/**
 * Fetch and decode the outer photo of the given size, as loadAucklandAerial; null on any failure. The high tier's
 * KTX2 atlas is transcoded for `renderer`'s GPU (without one it fails).
 */
export function loadAucklandAerialOuter(size: AerialSize, renderer?: WebGLRenderer, url?: string): Promise<AerialOuterPhoto | null> {
  return outer.load(size, url, renderer);
}
