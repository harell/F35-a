/**
 * Vitest setup file (vite.config.ts): installs the real LINZ Auckland data
 * (src/world/terrain/data/auckland-linz.bin) for every test, as the game does in the browser
 * (loadAucklandLinz). Tests of the hand-traced fallback clear it with setAucklandLinz(null).
 */
import { setAucklandLinz } from '../src/world/terrain/theaters/aucklandLinz';

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
