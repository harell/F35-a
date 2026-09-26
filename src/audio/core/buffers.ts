/**
 * F35-A audio — procedural AudioBuffers, generated once per AudioContext (≈ 10 ms of work).
 */
import {
  fillBrown,
  fillCrackle,
  fillGunLoop,
  fillPink,
  fillWhite,
  GAU22_STYLE,
  GSH301_STYLE,
  makeLoopable,
  makeRng,
  ZSU23_STYLE,
  type GunLoopStyle,
} from '../dsp/generators';

export type GunKind = 'gau22' | 'gsh301' | 'zsu23';

export interface SynthBuffers {
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
  /** Sparse impulses (afterburner popcorn, debris, static). */
  crackle: AudioBuffer;
  /** Seamless gun loops per weapon. */
  gun: Record<GunKind, AudioBuffer>;
}

function toBuffer(ctx: BaseAudioContext, data: Float32Array): AudioBuffer {
  const b = ctx.createBuffer(1, data.length, ctx.sampleRate);
  b.getChannelData(0).set(data);
  return b;
}

function noise(ctx: BaseAudioContext, seconds: number, fill: (a: Float32Array) => void): AudioBuffer {
  const fade = Math.floor(ctx.sampleRate * 0.05);
  const raw = new Float32Array(Math.floor(ctx.sampleRate * seconds) + fade);
  fill(raw);
  return toBuffer(ctx, makeLoopable(raw, fade));
}

function gunLoop(ctx: BaseAudioContext, style: GunLoopStyle, seed: number): AudioBuffer {
  const n = Math.round((style.rounds / style.rate) * ctx.sampleRate);
  const a = new Float32Array(n);
  fillGunLoop(a, ctx.sampleRate, makeRng(seed), style);
  return toBuffer(ctx, a);
}

export function createSynthBuffers(ctx: BaseAudioContext): SynthBuffers {
  const sr = ctx.sampleRate;
  return {
    white: noise(ctx, 2.3, (a) => fillWhite(a, makeRng(11))),
    pink: noise(ctx, 3.1, (a) => fillPink(a, makeRng(23))),
    brown: noise(ctx, 3.7, (a) => fillBrown(a, makeRng(37))),
    crackle: noise(ctx, 2.9, (a) => fillCrackle(a, sr, makeRng(41), 70)),
    gun: {
      gau22: gunLoop(ctx, GAU22_STYLE, 101),
      gsh301: gunLoop(ctx, GSH301_STYLE, 202),
      zsu23: gunLoop(ctx, ZSU23_STYLE, 303),
    },
  };
}
