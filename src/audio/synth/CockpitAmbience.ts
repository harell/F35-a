/**
 * F35-A audio — airflow and cockpit ambience for the player's jet.
 *
 *   wind     canopy air-rush rising with IAS (band moves up with speed) and AoA
 *   whistle  canopy-seal whistle at high speed
 *   buffet   low rumble with an irregular amplitude flutter near stall / high AoA / transonic
 *   ECS      avionics cooling hiss + the faint 400 Hz aircraft AC power hum in the headset
 *   G-suit   inflation hiss while G builds (cockpit only)
 *   breath   oxygen-mask breathing (calm → faster under stress) and anti-G straining
 *            ("hook" manoeuvre) above ~5.5 G — scheduled here, played as one-shots
 *
 * Interior (cockpit/hud views) is the full mix; external views keep only a little wind.
 */
import type { SmoothParam } from '../core/SmoothParam';
import type { NoiseSet } from './NoiseBank';
import { VoiceGraph } from './VoiceGraph';

export interface AmbienceDrive {
  interior: boolean;
  /** Player alive and in the air (breathing / G-suit only when true). */
  alive: boolean;
  ias: number;
  tas: number;
  /** Angle of attack (rad). */
  alpha: number;
  mach: number;
  gLoad: number;
  /** 0..1 buffet from the flight model (or derived). */
  buffet: number;
  /** 0..1 how threatened the pilot is (incoming missiles, spikes) — speeds up breathing. */
  stress: number;
}

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

export class CockpitAmbience extends VoiceGraph {
  private readonly wind: SmoothParam;
  private readonly windF: SmoothParam;
  private readonly whistle: SmoothParam;
  private readonly whistleF: SmoothParam;
  private readonly buffet: SmoothParam;
  private readonly flutter: SmoothParam;
  private readonly flutterRate: SmoothParam;
  private readonly ecs: SmoothParam;
  private readonly hum: SmoothParam;
  private readonly gsuit: SmoothParam;
  private lastG = 1;
  private gHold = 0;

  constructor(ctx: AudioContext, noise: NoiseSet, dest: AudioNode) {
    super(ctx);
    const out = this.gain(1);
    out.connect(dest);

    const whp = this.filter('highpass', 140, 0.7);
    const wbp = this.filter('bandpass', 600, 0.55);
    this.wind = this.layer(noise.pink, [whp, wbp], out, true);
    this.windF = this.fp(wbp.frequency, 600);

    const sbp = this.filter('bandpass', 3400, 4);
    this.whistle = this.layer(noise.white, [sbp], out, true);
    this.whistleF = this.fp(sbp.frequency, 3400);

    // buffet: brown noise → low-pass → flutter VCA (LFO on its gain) → level
    const blp = this.filter('lowpass', 75, 1.1);
    const vca = this.gain(0.5);
    const lfo = this.osc('triangle', 9);
    const lfoDepth = this.gain(0.45);
    lfo.connect(lfoDepth);
    lfoDepth.connect(vca.gain);
    this.flutterRate = this.fp(lfo.frequency, 9);
    this.flutter = this.gp(lfoDepth.gain, 0.45);
    this.buffet = this.layer(noise.brown, [blp, vca], out, true);

    const ebp = this.filter('bandpass', 5200, 0.6);
    this.ecs = this.layer(noise.white, [ebp], out, true);
    const hum = this.osc('sine', 400);
    this.hum = this.layer(hum, [], out, false);

    const gbp = this.filter('bandpass', 2300, 0.9);
    this.gsuit = this.layer(noise.white, [gbp], out, true);
  }

  update(now: number, dt: number, d: AmbienceDrive): void {
    const inside = d.interior;
    const v = clamp(d.ias / 340, 0, 1.6);
    const aoa = clamp(d.alpha / 0.35, 0, 1.5);
    // wind: louder & brighter with speed; AoA adds a lower, rougher component
    this.windF.set((280 + 1900 * v) * (1 - 0.25 * aoa), now, 0.08);
    const windLvl = (0.015 + 0.3 * v * v) * (1 + 0.6 * aoa);
    this.wind.set(inside ? windLvl : windLvl * 0.22, now, 0.1);
    this.whistleF.set(3000 + 1800 * v, now, 0.1);
    this.whistle.set(inside ? 0.035 * clamp((v - 0.55) / 0.6, 0, 1) : 0, now, 0.15);
    // buffet (+ a little transonic roughness around Mach 0.95–1.05)
    const trans = Math.max(0, 1 - Math.abs(d.mach - 1) / 0.06) * clamp(d.gLoad / 4, 0, 1);
    const b = clamp(Math.max(d.buffet, trans * 0.5), 0, 1);
    this.buffet.set((inside ? 0.9 : 0.25) * b, now, 0.06);
    this.flutterRate.set(7 + 9 * b + 3 * Math.random(), now, 0.1);
    this.flutter.set(0.3 + 0.3 * Math.random(), now, 0.05);
    // ECS + 400 Hz hum (headset, cockpit only)
    this.ecs.set(inside ? 0.012 : 0, now, 0.2);
    this.hum.set(inside ? 0.0035 : 0, now, 0.2);
    // G-suit: hiss while G is building above ~2.5 G, sustained low hiss when heavy
    const g = d.alive ? d.gLoad : 1;
    const dg = (g - this.lastG) / Math.max(1e-3, dt);
    this.lastG = g;
    if (dg > 0.5 && g > 2.5) this.gHold = 0.35;
    this.gHold = Math.max(0, this.gHold - dt);
    const inflate = this.gHold > 0 ? clamp((g - 2.5) / 4, 0.2, 1) : 0;
    const sustain = clamp((g - 4.5) / 4, 0, 1) * 0.35;
    this.gsuit.set(inside && d.alive ? 0.09 * Math.max(inflate, sustain) : 0, now, 0.05);
  }

  silence(now: number): void {
    for (const p of [this.wind, this.whistle, this.buffet, this.ecs, this.hum, this.gsuit]) p.set(0, now, 0.05);
  }
}

/**
 * Breathing rhythm (pure logic): returns which breath one-shot to play, if any.
 * Calm: inhale/exhale every ~4.5 s; stressed: every ~2.6 s; above 5.5 G: AGSM strain every ~2.2 s.
 */
export class BreathingScheduler {
  private next = 2;
  private phase: 'in' | 'out' = 'in';

  reset(now: number): void {
    this.next = now + 2 + Math.random() * 2;
    this.phase = 'in';
  }

  update(now: number, gLoad: number, stress: number): 'in' | 'out' | 'strain' | null {
    if (now < this.next) return null;
    if (gLoad > 5.5) {
      this.next = now + 1.9 + Math.random() * 0.6;
      this.phase = 'in';
      return 'strain';
    }
    const period = 4.6 - 2 * clamp(stress, 0, 1) - 0.25 * clamp(gLoad - 2, 0, 3);
    if (this.phase === 'in') {
      this.phase = 'out';
      this.next = now + period * 0.38;
      return 'in';
    }
    this.phase = 'in';
    this.next = now + period * 0.62 + Math.random() * 0.4;
    return 'out';
  }
}
