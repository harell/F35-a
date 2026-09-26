/**
 * F35-A audio — mixer.
 *
 *   engine ─┐
 *   sfx ────┼─ world (ducked under voice) ─┐
 *   reverb ─┘                               ├─ mission (muted while paused) ─┐
 *   warn (RWR / MAWS / growl / chimes) ─────┤                                 ├─ master → compressor → limiter → out
 *   voice (Betty + radio) ──────────────────┘                                 │
 *   ui (menu clicks) ──────────────────────────────────────────────────────────┘
 *
 * Settings: master volume → master gain, sfx volume → engine/sfx/warn/ui, voice volume → voice.
 * Volumes use a squared taper (perceptually more even slider).
 */
import { makeRng } from '../dsp/generators';

export type BusId = 'engine' | 'sfx' | 'warn' | 'voice' | 'ui';

/** Relative bus levels (the mix). */
const BUS_LEVEL: Record<BusId, number> = { engine: 0.45, sfx: 1, warn: 0.5, voice: 1.05, ui: 0.45 };

export class Mixer {
  readonly bus: Record<BusId, GainNode>;
  /** Send for reverberant one-shots (explosions, guns) — null unless enabled (high quality). */
  reverbSend: GainNode | null = null;
  private readonly master: GainNode;
  private readonly mission: GainNode;
  private readonly world: GainNode;
  private readonly comp: DynamicsCompressorNode;
  private readonly limiter: DynamicsCompressorNode;
  private convolver: ConvolverNode | null = null;
  private reverbReturn: GainNode | null = null;
  private vol = { master: 0.9, sfx: 0.9, voice: 1 };
  private muted = false;

  constructor(private readonly ctx: AudioContext) {
    const g = (v = 1) => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };
    this.master = g(0.9);
    this.mission = g(1);
    this.world = g(1);
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -18;
    this.comp.knee.value = 12;
    this.comp.ratio.value = 4;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.25;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2.5;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.08;

    this.bus = { engine: g(), sfx: g(), warn: g(), voice: g(), ui: g() };
    this.bus.engine.connect(this.world);
    this.bus.sfx.connect(this.world);
    this.world.connect(this.mission);
    this.bus.warn.connect(this.mission);
    this.bus.voice.connect(this.mission);
    this.mission.connect(this.master);
    this.bus.ui.connect(this.master);
    this.master.connect(this.comp);
    this.comp.connect(this.limiter);
    this.limiter.connect(ctx.destination);
    this.applyVolumes();
  }

  /** Last node before the destination (for analysers / recording taps in the lab). */
  get output(): AudioNode {
    return this.limiter;
  }

  setVolumes(master: number, sfx: number, voice: number): void {
    const c = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1);
    this.vol = { master: c(master), sfx: c(sfx), voice: c(voice) };
    this.applyVolumes();
  }

  private applyVolumes(): void {
    const now = this.ctx.currentTime;
    const taper = (v: number) => v * v;
    const sfx = taper(this.vol.sfx);
    this.master.gain.setTargetAtTime(taper(this.vol.master), now, 0.03);
    for (const id of ['engine', 'sfx', 'warn', 'ui'] as const) this.bus[id].gain.setTargetAtTime(BUS_LEVEL[id] * sfx, now, 0.03);
    this.bus.voice.gain.setTargetAtTime(BUS_LEVEL.voice * taper(this.vol.voice), now, 0.03);
  }

  /** Pause: fade every mission bus out (UI clicks keep working). */
  setMissionMuted(muted: boolean): void {
    if (muted === this.muted) return;
    this.muted = muted;
    this.mission.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, muted ? 0.04 : 0.12);
  }

  /** Duck engine + sfx while a voice speaks (1 = no ducking). */
  setDuck(level: number): void {
    this.world.gain.setTargetAtTime(level, this.ctx.currentTime, level < 1 ? 0.06 : 0.25);
  }

  /** Outdoor "rolling echo" convolution reverb for explosions & guns (high quality only). */
  enableReverb(on: boolean): void {
    if (on === !!this.convolver) return;
    if (!on) {
      this.reverbSend?.disconnect();
      this.convolver?.disconnect();
      this.reverbReturn?.disconnect();
      this.reverbSend = this.convolver = this.reverbReturn = null;
      return;
    }
    const ctx = this.ctx;
    const conv = ctx.createConvolver();
    conv.normalize = true;
    conv.buffer = makeOutdoorImpulse(ctx);
    const send = ctx.createGain();
    send.gain.value = 1;
    const ret = ctx.createGain();
    ret.gain.value = 0.55;
    send.connect(conv);
    conv.connect(ret);
    ret.connect(this.world);
    this.reverbSend = send;
    this.convolver = conv;
    this.reverbReturn = ret;
  }

  dispose(): void {
    this.enableReverb(false);
    try {
      this.limiter.disconnect();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Procedural outdoor impulse response: a few discrete early echoes (ground / hills) followed
 * by a darkening, slowly decaying diffuse tail (~2.4 s). Stereo decorrelated.
 */
function makeOutdoorImpulse(ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * 2.4);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const rng = makeRng(911 + ch * 77);
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      // tail gets darker over time (one-pole low-pass with falling coefficient)
      const k = 0.5 * Math.exp(-t * 1.6) + 0.04;
      lp += k * ((rng() * 2 - 1) - lp);
      const env = t < 0.03 ? t / 0.03 : Math.exp(-(t - 0.03) * 2.2);
      d[i] = lp * env * 0.6;
    }
    // early reflections
    const taps = [0.045, 0.11, 0.19, 0.33, 0.52];
    for (let k = 0; k < taps.length; k++) {
      const idx = Math.floor((taps[k] + (ch ? 0.007 * k : 0)) * sr);
      const a = 0.5 * Math.pow(0.7, k);
      for (let j = 0; j < 200 && idx + j < len; j++) d[idx + j] += a * Math.exp(-j / 40) * (rng() * 2 - 1);
    }
  }
  return buf;
}
