/**
 * F35-A UI — Codex sound samples: the warning tones (same frequencies and rates as
 * audio/synth/WarningTones.ts) and the game's own voice clips (public/audio/voice/*.mp3).
 * One sample plays at a time; play() returns how long it lasts so the caller can reset its button.
 */
import { voiceUrl } from '../../audio/voice/voiceIds';
import type { WarnSound } from './data';

export class CodexTones {
  private ctx: AudioContext | null = null;
  private stops: (() => void)[] = [];
  private clip: HTMLAudioElement | null = null;

  private ac(): AudioContext | null {
    if (!this.ctx) {
      const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!C) return null;
      this.ctx = new C();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  stop(): void {
    for (const s of this.stops) {
      try {
        s();
      } catch {
        /* already stopped */
      }
    }
    this.stops = [];
    if (this.clip) {
      this.clip.pause();
      this.clip = null;
    }
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }

  /** Play a warning tone and/or voice clip; returns its length in seconds (0 if nothing played). */
  play(sound: WarnSound, voice?: string): number {
    this.stop();
    let dur = 0;
    const a = sound !== 'none' ? this.ac() : null;
    if (a) {
      const t = a.currentTime;
      if (sound === 'spike') dur = this.beeps(a, t, 1250, 4);
      else if (sound === 'mud') dur = this.beeps(a, t, 950, 4);
      else if (sound === 'launch') dur = this.warble(a, t, 4);
      else if (sound === 'missile') dur = this.sweeps(a, t, 9, 4);
      else if (sound === 'defeated') dur = this.sweeps(a, t, 6, 2.4) + this.chirp(a, t + 2.6);
      else if (sound === 'silent') dur = 3.5 + this.sweeps(a, t + 3.5, 4, 2.5);
      else if (sound === 'buzz') dur = this.buzz(a, t);
    }
    if (voice) {
      try {
        const el = new Audio(voiceUrl(voice, import.meta.env.BASE_URL ?? './'));
        el.volume = 0.9;
        // the silent-launch demo speaks when the missile's seeker switches on
        const delay = sound === 'silent' ? 3500 : 0;
        const id = window.setTimeout(() => void el.play().catch(() => undefined), delay);
        this.stops.push(() => window.clearTimeout(id));
        this.clip = el;
        dur = Math.max(dur, 1.6 + delay / 1000);
      } catch {
        /* no audio element */
      }
    }
    return dur;
  }

  private gain(a: AudioContext, v: number): GainNode {
    const g = a.createGain();
    g.gain.value = v;
    g.connect(a.destination);
    return g;
  }

  private osc(a: AudioContext, type: OscillatorType, f: number, g: AudioNode): OscillatorNode {
    const o = a.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.connect(g);
    this.stops.push(() => o.stop());
    return o;
  }

  /** RWR spike: square beeps at ~7.5 Hz. */
  private beeps(a: AudioContext, t0: number, f: number, dur: number): number {
    const g = this.gain(a, 0);
    const o = this.osc(a, 'square', f, g);
    const per = 1 / 7.5;
    for (let t = 0; t < dur; t += per) {
      g.gain.setValueAtTime(0.05, t0 + t);
      g.gain.setValueAtTime(0, t0 + t + per * 0.55);
    }
    o.start(t0);
    o.stop(t0 + dur);
    return dur;
  }

  /** RWR launch: 1,300 ± 340 Hz warble at 11 Hz. */
  private warble(a: AudioContext, t0: number, dur: number): number {
    const g = this.gain(a, 0.045);
    const o = this.osc(a, 'sine', 1300, g);
    const lfo = a.createOscillator();
    const depth = a.createGain();
    lfo.frequency.value = 11;
    depth.gain.value = 340;
    lfo.connect(depth);
    depth.connect(o.frequency);
    this.stops.push(() => lfo.stop());
    o.start(t0);
    lfo.start(t0);
    o.stop(t0 + dur);
    lfo.stop(t0 + dur);
    return dur;
  }

  /** Missile approach: 1,900 → 900 Hz sweeps, faster as time-to-impact falls. */
  private sweeps(a: AudioContext, t0: number, tti: number, dur: number): number {
    const g = this.gain(a, 0);
    const o = this.osc(a, 'sine', 1900, g);
    let t = 0;
    while (t < dur) {
      const per = Math.min(0.6, Math.max(0.15, 0.1 + 0.055 * tti));
      o.frequency.setValueAtTime(1900, t0 + t);
      o.frequency.exponentialRampToValueAtTime(900, t0 + t + per * 0.8);
      g.gain.setValueAtTime(0.05, t0 + t);
      g.gain.setValueAtTime(0, t0 + t + per * 0.8);
      t += per;
      tti = Math.max(0, tti - per);
    }
    o.start(t0);
    o.stop(t0 + dur);
    return dur;
  }

  private chirp(a: AudioContext, t0: number): number {
    const g = this.gain(a, 0.05);
    const o = this.osc(a, 'triangle', 600, g);
    o.frequency.setValueAtTime(600, t0);
    o.frequency.setValueAtTime(900, t0 + 0.12);
    o.frequency.setValueAtTime(1200, t0 + 0.24);
    g.gain.setValueAtTime(0, t0 + 0.45);
    o.start(t0);
    o.stop(t0 + 0.5);
    return 0.8;
  }

  private buzz(a: AudioContext, t0: number): number {
    const g = this.gain(a, 0.05);
    const o = this.osc(a, 'sawtooth', 130, g);
    o.start(t0);
    o.stop(t0 + 0.35);
    return 0.5;
  }

  /** AIM-9X seeker: growl while searching, then the steady lock tone. */
  growl(): number {
    this.stop();
    const a = this.ac();
    if (!a) return 0;
    const t = a.currentTime;
    const g1 = this.gain(a, 0);
    const o1 = this.osc(a, 'sawtooth', 210, g1);
    const g2 = this.gain(a, 0);
    const o2 = this.osc(a, 'triangle', 1150, g2);
    for (let k = 0; k < 1.6; k += 0.08) g1.gain.setValueAtTime(0.03 + 0.02 * Math.sin(k * 40), t + k);
    g1.gain.setValueAtTime(0, t + 1.6);
    g2.gain.setValueAtTime(0.06, t + 1.6);
    o1.start(t);
    o2.start(t);
    o1.stop(t + 3.2);
    o2.stop(t + 3.2);
    return 3.2;
  }
}
