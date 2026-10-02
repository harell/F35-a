/**
 * F35-A audio — the Shahed-136's engine: a small two-stroke piston engine and pusher propeller,
 * the loud, nasal "moped" buzz people on the ground know it by. A sawtooth at the firing rate plus
 * its second harmonic through a nasal band-pass, a rasp of exhaust noise, and a slight irregular
 * wobble; Doppler shifts the pitch, the retarded-time spatialiser gives pan, distance and air
 * absorption (like the jets).
 */
import type { SmoothParam } from '../core/SmoothParam';
import type { NoiseSet } from './NoiseBank';
import { VoiceGraph } from './VoiceGraph';

/** Firing frequency at cruise (Hz): ~7,000 rpm, two cylinders. */
export const BUZZ_FUNDAMENTAL = 118;
/** Full level inside this distance (m), silent beyond `BUZZ_MAX_DIST`. */
export const BUZZ_REF = 40;
export const BUZZ_MAX_DIST = 4000;

export class PistonBuzzVoice extends VoiceGraph {
  /** Aircraft currently assigned (entity id), or −1. */
  targetId = -1;
  private readonly out: SmoothParam;
  private readonly tone: SmoothParam;
  private readonly pan: SmoothParam | null;
  private readonly f1: SmoothParam;
  private readonly f2: SmoothParam;
  private readonly wobbleF: SmoothParam;

  constructor(ctx: AudioContext, noise: NoiseSet, dest: AudioNode) {
    super(ctx);
    const out = this.gain(0);
    const tone = this.filter('lowpass', 12000, 0.5);
    const pan = this.panner();
    tone.connect(pan);
    pan.connect(out);
    this.setOutput(out, dest);
    this.out = this.gp(out.gain, 0);
    this.tone = this.fp(tone.frequency, 12000);
    this.pan = this.pp(pan);

    // engine: fundamental + 2nd harmonic, slightly detuned, through a nasal band-pass
    const nasal = this.filter('bandpass', 950, 0.9);
    const body = this.gain(0.9);
    nasal.connect(body);
    body.connect(tone);
    const o1 = this.osc('sawtooth', BUZZ_FUNDAMENTAL);
    const o2 = this.osc('square', BUZZ_FUNDAMENTAL * 2.01);
    const g1 = this.gain(0.7);
    const g2 = this.gain(0.25);
    o1.connect(g1);
    o2.connect(g2);
    g1.connect(nasal);
    g2.connect(nasal);
    // a bit of the raw saw for the low end
    const low = this.filter('lowpass', 400, 0.7);
    const lowG = this.gain(0.35);
    g1.connect(low);
    low.connect(lowG);
    lowG.connect(tone);
    this.f1 = this.fp(o1.frequency, BUZZ_FUNDAMENTAL);
    this.f2 = this.fp(o2.frequency, BUZZ_FUNDAMENTAL * 2.01);

    // irregular firing: a slow wobble on the engine level
    const wobble = this.osc('triangle', 6.3);
    const depth = this.gain(0.18);
    wobble.connect(depth);
    depth.connect(body.gain);
    this.wobbleF = this.fp(wobble.frequency, 6.3);

    // exhaust rasp
    const bp = this.filter('bandpass', 1800, 0.8);
    const rasp = this.layer(noise.pink, [bp], tone, true);
    rasp.set(0.25, ctx.currentTime, 0.01);
  }

  /**
   * @param gain     overall level after distance attenuation
   * @param doppler  pitch ratio from the spatialiser
   */
  update(now: number, gain: number, pan: number, cutoff: number, doppler: number): void {
    const f = BUZZ_FUNDAMENTAL * doppler;
    this.f1.set(f, now, 0.04);
    this.f2.set(f * 2.01, now, 0.04);
    this.wobbleF.set(6.3 * doppler, now, 0.1);
    this.tone.set(Math.max(150, cutoff), now, 0.05);
    this.pan?.set(pan, now, 0.05);
    this.out.set(gain, now, 0.05);
  }

  silence(now: number, tc = 0.1): void {
    this.out.set(0, now, tc);
    this.targetId = -1;
  }
}
