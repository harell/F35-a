/**
 * F35-A audio — small node-building helpers shared by the synth recipes and voices.
 */
import type { Mixer } from '../core/Mixer';
import type { OneShot, OneShotPool } from '../core/OneShots';
import type { SynthBuffers } from '../core/buffers';

/** Everything a recipe needs. */
export interface SynthEnv {
  readonly ctx: AudioContext;
  readonly mixer: Mixer;
  readonly buffers: SynthBuffers;
  readonly pool: OneShotPool;
}

export function gainNode(ctx: BaseAudioContext, v = 1): GainNode {
  const g = ctx.createGain();
  g.gain.value = v;
  return g;
}

export function biquad(ctx: BaseAudioContext, type: BiquadFilterType, f: number, q = 0.707, gainDb = 0): BiquadFilterNode {
  const b = ctx.createBiquadFilter();
  b.type = type;
  b.frequency.value = f;
  b.Q.value = q;
  if (gainDb) b.gain.value = gainDb;
  return b;
}

export function panner(ctx: BaseAudioContext, pan = 0): AudioNode & { pan?: AudioParam } {
  if (typeof (ctx as AudioContext).createStereoPanner === 'function') {
    const p = (ctx as AudioContext).createStereoPanner();
    p.pan.value = pan;
    return p;
  }
  return gainNode(ctx, 1); // very old Safari: mono
}

/** Looping noise source starting at a random offset (so repeated shots never sound identical). */
export function noiseSource(ctx: BaseAudioContext, buf: AudioBuffer, rate = 1, loop = true): AudioBufferSourceNode {
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.loop = loop;
  s.playbackRate.value = rate;
  return s;
}

export function startNoise(src: AudioBufferSourceNode, when: number, dur?: number): void {
  const len = src.buffer ? src.buffer.duration : 1;
  src.start(when, Math.random() * len * 0.9);
  if (dur !== undefined) src.stop(when + dur);
}

/**
 * Attack / exponential-decay envelope on a gain param.
 * @param tau decay time constant (s) — the sound is ~−40 dB after 4.6 τ
 */
export function adEnvelope(p: AudioParam, when: number, peak: number, attack: number, tau: number): void {
  p.cancelScheduledValues(when);
  p.setValueAtTime(0, when);
  p.linearRampToValueAtTime(peak, when + Math.max(0.001, attack));
  p.setTargetAtTime(0, when + Math.max(0.001, attack), Math.max(0.001, tau));
}

/** Frequency glide (exponential) — both ends must be > 0. */
export function glide(p: AudioParam, when: number, from: number, to: number, dur: number): void {
  p.setValueAtTime(Math.max(1, from), when);
  p.exponentialRampToValueAtTime(Math.max(1, to), when + Math.max(0.005, dur));
}

export interface BurstSpec {
  buf: 'white' | 'pink' | 'brown' | 'crackle';
  /** Filter; omitted = raw noise. */
  type?: BiquadFilterType;
  f?: number;
  /** Filter frequency glide target. */
  fEnd?: number;
  q?: number;
  gain: number;
  attack: number;
  tau: number;
  /** Delay after `when`. */
  delay?: number;
  rate?: number;
}

/** Filtered noise burst into a one-shot (returns its end time offset). */
export function burst(env: SynthEnv, shot: OneShot, when: number, s: BurstSpec): number {
  const ctx = env.ctx;
  const t = when + (s.delay ?? 0);
  const dur = s.attack + s.tau * 5;
  const src = noiseSource(ctx, env.buffers[s.buf], s.rate ?? 1);
  const g = gainNode(ctx, 0);
  let head: AudioNode = src;
  if (s.type) {
    const f = biquad(ctx, s.type, s.f ?? 1000, s.q ?? 0.707);
    if (s.fEnd) glide(f.frequency, t, s.f ?? 1000, s.fEnd, dur * 0.8);
    head.connect(f);
    head = f;
  }
  head.connect(g);
  g.connect(shot.out);
  adEnvelope(g.gain, t, s.gain, s.attack, s.tau);
  env.pool.track(shot, src);
  startNoise(src, t, dur);
  if (t + dur > shot.end) shot.end = t + dur;
  return (s.delay ?? 0) + dur;
}

export interface ToneSpec {
  type: OscillatorType;
  f: number;
  fEnd?: number;
  /** Duration of the glide (default = whole tone). */
  glideDur?: number;
  gain: number;
  attack: number;
  tau: number;
  delay?: number;
  /** Optional low-pass to tame square/saw tones. */
  lp?: number;
}

/** Oscillator tone with AD envelope and optional glide. */
export function tone(env: SynthEnv, shot: OneShot, when: number, s: ToneSpec): number {
  const ctx = env.ctx;
  const t = when + (s.delay ?? 0);
  const dur = s.attack + s.tau * 5;
  const o = ctx.createOscillator();
  o.type = s.type;
  if (s.fEnd) glide(o.frequency, t, s.f, s.fEnd, s.glideDur ?? dur);
  else o.frequency.value = s.f;
  const g = gainNode(ctx, 0);
  let head: AudioNode = o;
  if (s.lp) {
    const f = biquad(ctx, 'lowpass', s.lp, 0.7);
    head.connect(f);
    head = f;
  }
  head.connect(g);
  g.connect(shot.out);
  adEnvelope(g.gain, t, s.gain, s.attack, s.tau);
  env.pool.track(shot, o);
  o.start(t);
  o.stop(t + dur);
  if (t + dur > shot.end) shot.end = t + dur;
  return (s.delay ?? 0) + dur;
}

/** Gated beep (flat top, short ramps) — for RWR / lock tones. */
export function beep(env: SynthEnv, shot: OneShot, when: number, type: OscillatorType, f: number, dur: number, gain: number, lp = 5000): void {
  const ctx = env.ctx;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = f;
  const flt = biquad(ctx, 'lowpass', lp, 0.7);
  const g = gainNode(ctx, 0);
  o.connect(flt);
  flt.connect(g);
  g.connect(shot.out);
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(gain, when + 0.004);
  g.gain.setValueAtTime(gain, when + dur - 0.006);
  g.gain.linearRampToValueAtTime(0, when + dur);
  env.pool.track(shot, o);
  o.start(when);
  o.stop(when + dur + 0.01);
  if (when + dur + 0.01 > shot.end) shot.end = when + dur + 0.01;
}
