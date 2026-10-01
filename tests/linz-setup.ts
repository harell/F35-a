/**
 * Vitest setup file (vite.config.ts): installs the real LINZ Auckland data
 * (src/world/terrain/data/auckland-linz.bin: terrain, auckland-roads.bin: road centrelines,
 * auckland-buildings.bin: CBD buildings) for every test, as the game does in the browser
 * (loadAucklandLinz / loadAucklandRoads / loadAucklandBuildings). Tests of the hand-traced fallbacks
 * clear them with setAucklandLinz(null) / setAucklandRoads(null) / setAucklandBuildings(null).
 */
import { setAucklandLinz } from '../src/world/terrain/theaters/aucklandLinz';
import { setAucklandRoads } from '../src/world/scenery/aucklandRoads';
import { setAucklandBuildings } from '../src/world/scenery/aucklandBuildings';

// node:fs / node:zlib without @types/node (the project doesn't ship node typings): the surface used here
interface Fs {
  readFileSync(p: URL): Uint8Array;
}
interface Zlib {
  gunzipSync(b: Uint8Array): Uint8Array;
}
const fs = (await import(/* @vite-ignore */ 'node:fs' as string)) as Fs;
const zlib = (await import(/* @vite-ignore */ 'node:zlib' as string)) as Zlib;

export const LINZ_GZ = new Uint8Array(fs.readFileSync(new URL('../src/world/terrain/data/auckland-linz.bin', import.meta.url)));
export const LINZ_BYTES = new Uint8Array(zlib.gunzipSync(LINZ_GZ));
setAucklandLinz(LINZ_BYTES);

export const ROADS_GZ = new Uint8Array(fs.readFileSync(new URL('../src/world/terrain/data/auckland-roads.bin', import.meta.url)));
export const ROADS_BYTES = new Uint8Array(zlib.gunzipSync(ROADS_GZ));
setAucklandRoads(ROADS_BYTES);

export const BUILDINGS_GZ = new Uint8Array(fs.readFileSync(new URL('../src/world/terrain/data/auckland-buildings.bin', import.meta.url)));
export const BUILDINGS_BYTES = new Uint8Array(zlib.gunzipSync(BUILDINGS_GZ));
setAucklandBuildings(BUILDINGS_BYTES);
