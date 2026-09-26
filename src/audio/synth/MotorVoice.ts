/**
 * F35-A audio — rocket motor roar that follows a burning missile (own shots departing,
 * SAMs climbing towards you, a missile whooshing past). Tearing mid band + low rumble +
 * crackle, with Doppler/pan/distance from the retarded-time spatialiser.
 */
import type { SmoothParam } from '../core/SmoothParam';
import type { NoiseSet } from './NoiseBank';
import { VoiceGraph } from './VoiceGraph';

export class MotorVoice extends VoiceGraph {
  /** Missile currently assigned (entity id), or −1. */
  missileId = -1;
  /** Listener was inside the missile's Mach cone last frame (supersonic near-miss crack). */
  heard: boolean | null = null;
  private readonly out: SmoothParam;
  private readonly tone: SmoothParam;
  private readonly pan: SmoothParam | null;
  private readonly mid: SmoothParam;
  private readonly midF: SmoothParam;
  private readonly low: SmoothParam;
  private readonly lowF: SmoothParam;
  private readonly cr: SmoothParam;

  constructor(ctx: AudioContext, noise: NoiseSet, dest: AudioNode) {
    super(ctx);
    const out = this.gain(0);
    const tone = this.filter('lowpass', 16000, 0.5);
    const pan = this.panner();
    tone.connect(pan);
    pan.connect(out);
    this.setOutput(out, dest);
    this.out = this.gp(out.gain, 0);
    this.tone = this.fp(tone.frequency, 16000);
    this.pan = this.pp(pan);
    const bp = this.filter('bandpass', 1100, 0.55);
    this.mid = this.layer(noise.pink, [bp], tone, true);
    this.midF = this.fp(bp.frequency, 1100);
    const lp = this.filter('lowpass', 300, 0.8);
    this.low = this.layer(noise.brown, [lp], tone, true);
    this.lowF = this.fp(lp.frequency, 300);
    const hp = this.filter('highpass', 1500, 0.7);
    this.cr = this.layer(noise.crackle, [hp], tone, true);
  }

  /**
   * @param big   SAM-sized motor (deeper, louder)
   * @param gain  overall level after distance attenuation
   */
  update(now: number, gain: number, pan: number, cutoff: number, doppler: number, big: boolean): void {
    const f = big ? 0.7 : 1;
    this.midF.set(1100 * f * doppler, now, 0.03);
    this.lowF.set(300 * f * doppler, now, 0.03);
    this.mid.set(big ? 0.9 : 1.0, now, 0.05);
    this.low.set(big ? 1.4 : 0.8, now, 0.05);
    this.cr.set(big ? 0.5 : 0.35, now, 0.05);
    this.tone.set(Math.max(150, cutoff), now, 0.05);
    this.pan?.set(pan, now, 0.05);
    this.out.set(gain, now, 0.05);
  }

  silence(now: number, tc = 0.1): void {
    this.out.set(0, now, tc);
    this.missileId = -1;
    this.heard = null;
  }
}
