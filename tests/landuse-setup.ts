/**
 * The real land-use grid (src/world/scenery/data/auckland-landuse.bin, #122) for the tests that need it. Not in the
 * global setup (linz-setup.ts): decoding the 5000² grid costs every test file ≈ 0.3 s, and the game only reads it on the
 * medium and high tiers (TerrainSpec.landUse), so the other tests see the hand-traced suburbs as the low tier does.
 */
import { setAucklandLandUse, aucklandLandUse, type LandUse } from '../src/world/scenery/aucklandLandUse';

interface Fs {
  readFileSync(p: URL): Uint8Array;
}
interface Zlib {
  gunzipSync(b: Uint8Array): Uint8Array;
}
const fs = (await import(/* @vite-ignore */ 'node:fs' as string)) as Fs;
const zlib = (await import(/* @vite-ignore */ 'node:zlib' as string)) as Zlib;

export const LANDUSE_GZ = new Uint8Array(fs.readFileSync(new URL('../src/world/scenery/data/auckland-landuse.bin', import.meta.url)));
export const LANDUSE_BYTES = new Uint8Array(zlib.gunzipSync(LANDUSE_GZ));

/** Install the grid (once) and return it. */
export function installLandUse(): LandUse {
  if (!aucklandLandUse()) setAucklandLandUse(LANDUSE_BYTES);
  return aucklandLandUse()!;
}

export const MANIFEST = JSON.parse(new TextDecoder().decode(fs.readFileSync(new URL('../tools/osm/manifest.json', import.meta.url))));
