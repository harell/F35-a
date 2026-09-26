import { beforeAll, describe, expect, it } from 'vitest';
import {
  fillBrown,
  fillCrackle,
  fillGunLoop,
  fillPink,
  fillWhite,
  GAU22_STYLE,
  makeLoopable,
  makeRng,
  rms,
} from '../src/audio/dsp/generators';
import { VOICE_IDS, voiceChannel, voiceUrl } from '../src/audio/voice/voiceIds';

// node:fs without @types/node (the project doesn't ship node typings): the minimal surface used here
interface Fs {
  existsSync(p: URL): boolean;
  readFileSync(p: URL, enc: 'utf8'): string;
  readFileSync(p: URL): Uint8Array;
  statSync(p: URL): { size: number };
}
let fs: Fs;
beforeAll(async () => {
  fs = (await import(/* @vite-ignore */ 'node:fs' as string)) as Fs;
});
const file = (rel: string) => new URL(`../${rel}`, import.meta.url);

describe('voice clips', () => {
  it('lists every VoiceId declared in core/types.ts', () => {
    const src = fs.readFileSync(file('src/core/types.ts'), 'utf8');
    const block = src.slice(src.indexOf('export type VoiceId'), src.indexOf("'a_friendly_down'") + 20);
    const declared = [...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(30);
    expect([...VOICE_IDS].sort()).toEqual([...new Set(declared)].sort());
  });

  it('has a generated mp3 for every clip, within the size budget', () => {
    let total = 0;
    for (const id of VOICE_IDS) {
      const f = file(`public/audio/voice/${id}.mp3`);
      expect(fs.existsSync(f), `${id}.mp3 missing — run npm run voices`).toBe(true);
      const size = fs.statSync(f).size;
      expect(size).toBeGreaterThan(2000);
      // MPEG audio frame sync (or ID3 tag)
      const head = fs.readFileSync(f).subarray(0, 3);
      const isId3 = String.fromCharCode(...head) === 'ID3';
      const isSync = head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
      expect(isId3 || isSync).toBe(true);
      total += size;
    }
    expect(total).toBeLessThan(1.5 * 1024 * 1024);
  });

  it('routes Betty to the ICAWS channel and pilot/AWACS to the radio', () => {
    expect(voiceChannel('b_pull_up')).toBe('betty');
    expect(voiceChannel('p_fox3')).toBe('radio');
    expect(voiceChannel('a_bandits')).toBe('radio');
    expect(voiceUrl('b_missile')).toBe('./audio/voice/b_missile.mp3');
  });
});

describe('procedural buffers', () => {
  const N = 48000;

  it('white noise is zero-mean with the expected RMS', () => {
    const a = fillWhite(new Float32Array(N), makeRng(1));
    const mean = a.reduce((s, v) => s + v, 0) / N;
    expect(Math.abs(mean)).toBeLessThan(0.02);
    expect(rms(a)).toBeCloseTo(1 / Math.sqrt(3), 1);
  });

  it('pink and brown noise tilt energy towards low frequencies', () => {
    // high-frequency content ~ first difference energy relative to total energy
    const hfRatio = (a: Float32Array) => {
      let d = 0;
      for (let i = 1; i < a.length; i++) d += (a[i] - a[i - 1]) ** 2;
      return d / (rms(a) ** 2 * a.length);
    };
    const w = hfRatio(fillWhite(new Float32Array(N), makeRng(2)));
    const p = hfRatio(fillPink(new Float32Array(N), makeRng(2)));
    const b = hfRatio(fillBrown(new Float32Array(N), makeRng(2)));
    expect(p).toBeLessThan(w);
    expect(b).toBeLessThan(p);
  });

  it('normalises peaks and removes DC', () => {
    for (const a of [fillPink(new Float32Array(N), makeRng(3)), fillBrown(new Float32Array(N), makeRng(3)), fillCrackle(new Float32Array(N), 48000, makeRng(3))]) {
      let peak = 0;
      for (const v of a) peak = Math.max(peak, Math.abs(v));
      expect(peak).toBeCloseTo(0.95, 3);
    }
    const b = fillBrown(new Float32Array(N), makeRng(4));
    expect(Math.abs(b.reduce((s, v) => s + v, 0) / N)).toBeLessThan(1e-3);
  });

  it('GAU-22 loop has one transient per round at 55 rounds/s', () => {
    const sr = 48000;
    const n = Math.round((GAU22_STYLE.rounds / GAU22_STYLE.rate) * sr);
    const a = fillGunLoop(new Float32Array(n), sr, makeRng(5), GAU22_STYLE);
    // energy envelope in 1 ms windows, count onsets
    const win = 48;
    const env: number[] = [];
    for (let i = 0; i + win <= n; i += win) {
      let e = 0;
      for (let j = 0; j < win; j++) e += a[i + j] ** 2;
      env.push(e);
    }
    const max = Math.max(...env);
    let onsets = 0;
    let armed = true;
    for (const e of env) {
      if (armed && e > max * 0.3) {
        onsets++;
        armed = false;
      } else if (e < max * 0.05) armed = true;
    }
    expect(onsets).toBeGreaterThanOrEqual(GAU22_STYLE.rounds - 2);
    expect(onsets).toBeLessThanOrEqual(GAU22_STYLE.rounds + 1);
  });

  it('makeLoopable cross-fades the seam and shortens by the fade length', () => {
    const raw = fillBrown(new Float32Array(10_000), makeRng(6));
    const loop = makeLoopable(raw, 500);
    expect(loop.length).toBe(9500);
    // the last sample flows into the first: jump at the seam is as small as a normal step
    let maxStep = 0;
    for (let i = 1; i < loop.length; i++) maxStep = Math.max(maxStep, Math.abs(loop[i] - loop[i - 1]));
    expect(Math.abs(loop[0] - loop[loop.length - 1])).toBeLessThanOrEqual(maxStep * 1.5);
  });
});
