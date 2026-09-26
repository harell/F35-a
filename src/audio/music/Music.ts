/**
 * F35-A audio — procedural soundtrack (no files). Cheap by design: one persistent pad
 * (3 detuned oscillators → one low-pass with a slow LFO) plus short-lived oscillator notes
 * scheduled ~0.35 s ahead from a 120 ms timer (never from the render loop).
 *
 *   menu      moody D-minor theme: pad, bell arpeggio, soft bass pulse (~84 bpm)
 *   mission   adaptive layer driven by `tension` (0..1):
 *               < 0.3   cruise — quiet pad only
 *               ≥ 0.3   engaged / spiked / locked — bass pulse in 8ths, off-beat ticks
 *               ≥ 0.75  missile inbound / launch — kick on the beat, 16th ticks, faster tempo
 *   stingers  kill confirmation, mission complete (major swell), mission failed (falling minor)
 *
 * Output: the mixer's 'music' bus (ducked under voice + warnings by AudioSystem).
 * The pure pieces (progression, tension → layer) are exported for tests.
 */
import type { SynthEnv } from '../synth/build';
import { gainNode } from '../synth/build';

export type MusicMode = 'off' | 'menu' | 'mission';
export type MusicStinger = 'kill' | 'win' | 'fail';

/** Chord progression (MIDI root + intervals): Dm – B♭ – Gm – A (i – VI – iv – V). */
export const PROGRESSION: readonly (readonly number[])[] = [
  [50, 53, 57], // D F A
  [46, 50, 53], // Bb D F
  [43, 46, 50], // G Bb D
  [45, 49, 52], // A C# E
];

export const midiHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

/** Layer for a mission tension value: 0 cruise, 1 engaged, 2 defensive. */
export function tensionLayer(t: number): 0 | 1 | 2 {
  return t >= 0.75 ? 2 : t >= 0.3 ? 1 : 0;
}

/** Tempo (bpm) for a mode / layer. */
export function tempoFor(mode: MusicMode, layer: number): number {
  if (mode === 'menu') return 84;
  return layer >= 2 ? 118 : layer === 1 ? 104 : 84;
}

/**
 * Tension follower: rises at once, falls only after `hold` seconds of calm (combat music
 * doesn't flicker on and off between radar sweeps).
 */
export class TensionFollower {
  value = 0;
  private calmSince = 0;
  constructor(private readonly hold = 8) {}

  update(now: number, target: number): number {
    if (target >= this.value) {
      this.value = target;
      this.calmSince = now;
    } else if (now - this.calmSince > this.hold) {
      // step down one layer at a time
      this.value = Math.max(target, this.value - 0.35);
      this.calmSince = now;
    }
    return this.value;
  }

  reset(): void {
    this.value = 0;
    this.calmSince = 0;
  }
}

const LOOKAHEAD = 0.35;
const TICK_MS = 120;
const ARP = [0, 1, 2, 1, 3, 2, 1, 2];

export class Music {
  mode: MusicMode = 'off';
  readonly tension = new TensionFollower();
  private readonly out: GainNode;
  private readonly padGain: GainNode;
  private readonly padFilter: BiquadFilterNode;
  private readonly pad: OscillatorNode[] = [];
  private readonly lfo: OscillatorNode;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextStep = 0;
  private step = 0;
  private chord = 0;
  /** No new phrase until then (a stinger is ringing). */
  private holdUntil = 0;
  private started = false;
  /** Notes scheduled so far (tests / diagnostics). */
  notes = 0;
  /** Asked on every scheduler tick for the wanted mode (menu vs mission). */
  resolveMode: (() => MusicMode) | null = null;

  constructor(private readonly env: SynthEnv) {
    const ctx = env.ctx;
    this.out = gainNode(ctx, 1);
    this.out.connect(env.mixer.bus.music);
    this.padGain = gainNode(ctx, 0);
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 700;
    this.padFilter.Q.value = 0.9;
    this.padFilter.connect(this.padGain);
    this.padGain.connect(this.out);
    const detune = [-7, 0, 6];
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator();
      o.type = i === 1 ? 'triangle' : 'sawtooth';
      o.detune.value = detune[i];
      o.frequency.value = midiHz(PROGRESSION[0][i]);
      const g = gainNode(ctx, i === 1 ? 0.5 : 0.22);
      o.connect(g);
      g.connect(this.padFilter);
      this.pad.push(o);
    }
    // slow filter sweep for movement
    this.lfo = ctx.createOscillator();
    this.lfo.frequency.value = 0.07;
    const lfoAmt = gainNode(ctx, 260);
    this.lfo.connect(lfoAmt);
    lfoAmt.connect(this.padFilter.frequency);
  }

  /** Start the scheduler (after the AudioContext is unlocked). */
  start(): void {
    if (this.timer) return;
    if (!this.started) {
      const t = this.env.ctx.currentTime + 0.05;
      for (const o of this.pad) o.start(t);
      this.lfo.start(t);
      this.started = true;
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  setMode(mode: MusicMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode !== 'mission') this.tension.reset();
    const now = this.env.ctx.currentTime;
    this.padGain.gain.setTargetAtTime(this.padLevel(), Math.max(now, this.holdUntil - 1), 0.8);
  }

  private padLevel(): number {
    if (this.mode === 'off') return 0;
    if (this.mode === 'menu') return 0.16;
    return tensionLayer(this.tension.value) >= 1 ? 0.1 : 0.075;
  }

  /** Scheduler tick (timer). Schedules every step that starts inside the look-ahead window. */
  tick(): void {
    const ctx = this.env.ctx;
    if (ctx.state !== 'running') return;
    if (this.resolveMode) this.setMode(this.resolveMode());
    const now = ctx.currentTime;
    if (this.nextStep < now - 0.1) this.nextStep = now + 0.05;
    let guard = 0;
    while (this.nextStep < now + LOOKAHEAD && guard++ < 16) {
      const layer = this.mode === 'mission' ? tensionLayer(this.tension.value) : 0;
      const bpm = tempoFor(this.mode, layer);
      const sixteenth = 60 / bpm / 4;
      if (this.mode !== 'off' && this.nextStep >= this.holdUntil) this.playStep(this.nextStep, layer, sixteenth);
      this.nextStep += sixteenth;
      this.step = (this.step + 1) % 128;
      if (this.step % 32 === 0) this.nextChord(this.nextStep);
    }
  }

  private nextChord(t: number): void {
    this.chord = (this.chord + 1) % PROGRESSION.length;
    const c = PROGRESSION[this.chord];
    for (let i = 0; i < 3; i++) this.pad[i].frequency.setTargetAtTime(midiHz(c[i]), t, 0.25);
    this.padGain.gain.setTargetAtTime(this.padLevel(), t, 0.6);
  }

  private playStep(t: number, layer: number, sixteenth: number): void {
    const c = PROGRESSION[this.chord];
    const s = this.step % 16;
    if (this.mode === 'menu') {
      // bell arpeggio on 8ths, bass on 1 and the "and" of 3
      if (s % 2 === 0) {
        const k = ARP[(s / 2) % 8];
        const m = k < 3 ? c[k] + 24 : c[0] + 36;
        this.note(t, midiHz(m), 'sine', 0.05, 0.004, 0.5);
        this.note(t, midiHz(m) * 2.01, 'sine', 0.008, 0.002, 0.15);
      }
      if (s === 0 || s === 10) this.note(t, midiHz(c[0] - 12), 'triangle', 0.16, 0.02, 0.9);
      return;
    }
    // mission
    if (layer === 0) {
      if (s === 0 && this.step % 32 === 0) this.note(t, midiHz(c[0] - 12), 'sine', 0.08, 0.3, 2.2);
      return;
    }
    // engaged: bass pulse on 8ths, ticks on the off-beats
    if (s % 2 === 0) this.note(t, midiHz(c[0] - 12), 'sawtooth', layer === 2 ? 0.07 : 0.055, 0.004, sixteenth * 1.3, 500);
    if (s % 4 === 2) this.tick8(t, 0.05);
    if (layer === 2) {
      if (s % 4 === 0) this.kick(t);
      if (s % 2 === 1) this.tick8(t, 0.025);
      if (s === 14) this.note(t, midiHz(c[2]), 'square', 0.03, 0.004, 0.12, 1800);
    } else if (s === 12) {
      this.note(t, midiHz(c[1] + 12), 'triangle', 0.035, 0.01, 0.4);
    }
  }

  /** One short oscillator note with an exponential decay (optionally low-passed). */
  private note(t: number, f: number, type: OscillatorType, gain: number, attack: number, tau: number, lp = 0): void {
    const ctx = this.env.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.setTargetAtTime(0, t + attack, tau / 3);
    let head: AudioNode = g;
    if (lp > 0) {
      const f2 = ctx.createBiquadFilter();
      f2.type = 'lowpass';
      f2.frequency.value = lp;
      o.connect(f2);
      f2.connect(g);
      head = f2;
    } else {
      o.connect(g);
    }
    g.connect(this.out);
    o.start(t);
    o.stop(t + attack + tau * 2 + 0.05);
    o.onended = () => {
      o.disconnect();
      if (head !== g) head.disconnect();
      g.disconnect();
    };
    this.notes++;
  }

  private tick8(t: number, gain: number): void {
    const ctx = this.env.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.env.buffers.white;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.setTargetAtTime(0, t, 0.012);
    src.connect(f);
    f.connect(g);
    g.connect(this.out);
    const off = (this.step * 0.37) % 1.5;
    src.start(t, off, 0.08);
    src.onended = () => {
      src.disconnect();
      f.disconnect();
      g.disconnect();
    };
  }

  private kick(t: number): void {
    const ctx = this.env.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.setTargetAtTime(0, t + 0.01, 0.07);
    o.connect(g);
    g.connect(this.out);
    o.start(t);
    o.stop(t + 0.4);
    o.onended = () => {
      o.disconnect();
      g.disconnect();
    };
  }

  /** Musical stinger; the running phrase pauses while it rings. */
  stinger(kind: MusicStinger, delay = 0): void {
    const ctx = this.env.ctx;
    if (ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.02 + delay;
    if (kind === 'kill') {
      // bright rising fifth + octave, short
      [62, 69, 74].forEach((m, i) => this.note(t + i * 0.08, midiHz(m + 12), 'triangle', 0.1, 0.004, i === 2 ? 0.5 : 0.12));
      return;
    }
    const pg = this.padGain.gain;
    pg.cancelScheduledValues(t);
    pg.setTargetAtTime(0, t, 0.15);
    if (kind === 'win') {
      // D major swell + bell run
      for (const m of [50, 54, 57, 62]) this.note(t + 0.1, midiHz(m), 'sawtooth', 0.045, 0.6, 2.4, 1600);
      [74, 78, 81, 86].forEach((m, i) => this.note(t + 0.15 + i * 0.12, midiHz(m), 'sine', 0.07, 0.004, 0.8));
      this.note(t + 0.1, midiHz(38), 'triangle', 0.2, 0.3, 2.5);
      this.holdUntil = t + 4.2;
    } else {
      // falling minor line over a low drone
      [57, 53, 50, 45].forEach((m, i) => this.note(t + i * 0.45, midiHz(m), 'triangle', 0.12, 0.02, 0.9));
      this.note(t, midiHz(38), 'sawtooth', 0.08, 1.0, 3.0, 400);
      this.holdUntil = t + 4.5;
    }
    pg.setTargetAtTime(this.padLevel(), this.holdUntil, 1.2);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.stop();
    try {
      for (const o of this.pad) o.stop();
      this.lfo.stop();
    } catch {
      /* not started */
    }
    this.out.disconnect();
  }
}
