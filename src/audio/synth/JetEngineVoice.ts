/**
 * F35-A audio — jet engine synthesis (F135 for the player, AL-31/RD-33/NK-25… for others).
 *
 *   whine   compressor blade-pass tone (≈1.5 kHz idle → 2.9 kHz MIL) + a softer sub-partial
 *   fan     low saw "buzz-saw" from the fan at high power (inlet, forward arc)
 *   roar    pink noise, low-passed with rising power — the jet mixing noise (aft arc)
 *   rumble  brown noise < 110 Hz (felt more than heard)
 *   AB      deep brown rumble + mid "tearing" band + crackle popcorn (external, aft)
 *   rush    airframe air-rush for fast external passes
 *
 * Cockpit (interior) mix: roar strongly low-passed, whine from the intakes beside the pilot,
 * rumble/AB felt through the seat. External mix: full roar, directivity (whine forward, roar and
 * crackle aft), distance gain, air absorption, stereo pan and Doppler (applied to every
 * oscillator and filter frequency — shifting a noise band's filter == Doppler-shifting noise).
 */
import type { AircraftType } from '../../core/types';
import type { SmoothParam } from '../core/SmoothParam';
import type { NoiseSet } from './NoiseBank';
import { VoiceGraph } from './VoiceGraph';

export interface EngineProfile {
  whine: number;
  fan: number;
  roar: number;
  rumble: number;
  /** Full level inside this distance (m). */
  ref: number;
  /** Silent beyond (m). */
  maxDist: number;
}

export const ENGINE_PROFILES: Record<AircraftType, EngineProfile> = {
  f35a: { whine: 1, fan: 1, roar: 1, rumble: 1, ref: 36, maxDist: 5500 },
  mig29: { whine: 1.12, fan: 1.1, roar: 0.95, rumble: 0.9, ref: 30, maxDist: 5000 },
  su27: { whine: 0.9, fan: 0.92, roar: 1.1, rumble: 1.1, ref: 32, maxDist: 5500 },
  su35: { whine: 0.88, fan: 0.9, roar: 1.12, rumble: 1.12, ref: 32, maxDist: 5500 },
  su57: { whine: 0.95, fan: 0.95, roar: 1.05, rumble: 1.05, ref: 32, maxDist: 5500 },
  // high-bypass LEAP / PW1100G: fan whine and buzz-saw, little jet roar
  a320: { whine: 0.8, fan: 0.85, roar: 0.6, rumble: 1.0, ref: 55, maxDist: 6000 },
  // Shahed-136: no turbine; its piston buzz is PistonBuzzVoice (audio/world/DroneSounds.ts), and
  // the jet pool never picks it. Kept near-silent in case anything plays it as a jet.
  shahed136: { whine: 0.05, fan: 0.05, roar: 0.05, rumble: 0.1, ref: 15, maxDist: 1500 },
};

export interface EngineDrive {
  /** Core rpm (flight.engineRpm, idle ≈ 0.63, MIL = 1). */
  rpm: number;
  /** Afterburner 0..1. */
  ab: number;
  /** True airspeed (m/s). */
  speed: number;
  interior: boolean;
  /** Overall output gain (distance attenuation etc.). */
  gain: number;
  pan: number;
  /** Final low-pass (air absorption / canopy). */
  cutoff: number;
  doppler: number;
  /** Directivity weights 0..1 (listener in front of / behind / beside the jet). */
  front: number;
  aft: number;
  side: number;
  profile: EngineProfile;
}

export function makeEngineDrive(): EngineDrive {
  return { rpm: 0, ab: 0, speed: 0, interior: false, gain: 0, pan: 0, cutoff: 18000, doppler: 1, front: 0, aft: 0, side: 1, profile: ENGINE_PROFILES.f35a };
}

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

export class JetEngineVoice extends VoiceGraph {
  private readonly full: boolean;
  private readonly out: SmoothParam;
  private readonly tone: SmoothParam;
  private readonly pan: SmoothParam | null;
  private readonly w1: SmoothParam;
  private readonly w2: SmoothParam;
  private readonly whine: SmoothParam;
  private readonly roar: SmoothParam;
  private readonly roarF: SmoothParam;
  private readonly roarPk: SmoothParam;
  private readonly rumble: SmoothParam;
  private readonly rumF: SmoothParam;
  private readonly ab: SmoothParam;
  private readonly abF: SmoothParam;
  private readonly fan: SmoothParam | null = null;
  private readonly fanF: SmoothParam | null = null;
  private readonly tear: SmoothParam | null = null;
  private readonly tearF: SmoothParam | null = null;
  private readonly crackle: SmoothParam | null = null;
  private readonly crF: SmoothParam | null = null;
  private readonly rush: SmoothParam | null = null;
  private readonly rushF: SmoothParam | null = null;

  constructor(
    ctx: AudioContext,
    noise: NoiseSet,
    dest: AudioNode,
    /** 'low' quality skips the fan, tear, crackle and rush layers. */
    quality: 'low' | 'medium' | 'high',
  ) {
    super(ctx);
    this.full = quality !== 'low';
    const out = this.gain(0);
    const tone = this.filter('lowpass', 18000, 0.5);
    const pan = this.panner();
    tone.connect(pan);
    pan.connect(out);
    this.setOutput(out, dest);
    this.out = this.gp(out.gain, 0);
    this.tone = this.fp(tone.frequency, 18000);
    this.pan = this.pp(pan);

    // whine: blade-pass tone + a softer partial an octave below (body, less piercing on phone speakers)
    const o1 = this.osc('triangle', 1500);
    const o2 = this.osc('sine', 750);
    const wsum = this.gain(1);
    const o2g = this.gain(0.6);
    o2.connect(o2g);
    o2g.connect(wsum);
    this.whine = this.layer(o1, [wsum], tone, false);
    this.w1 = this.fp(o1.frequency, 1500);
    this.w2 = this.fp(o2.frequency, 750);

    // roar
    const roarLp = this.filter('lowpass', 800, 0.6);
    const roarPeak = this.filter('peaking', 260, 0.9, 5);
    this.roar = this.layer(noise.pink, [roarLp, roarPeak], tone, true);
    this.roarF = this.fp(roarLp.frequency, 800);
    this.roarPk = this.fp(roarPeak.frequency, 260);

    // rumble
    const rumLp = this.filter('lowpass', 110, 0.8);
    this.rumble = this.layer(noise.brown, [rumLp], tone, true);
    this.rumF = this.fp(rumLp.frequency, 110);

    // afterburner low roar
    const abLp = this.filter('lowpass', 250, 0.9);
    this.ab = this.layer(noise.brown, [abLp], tone, true);
    this.abF = this.fp(abLp.frequency, 250);

    if (this.full) {
      const fan = this.osc('sawtooth', 140);
      const fanLp = this.filter('lowpass', 1300, 0.7);
      this.fan = this.layer(fan, [fanLp], tone, false);
      this.fanF = this.fp(fan.frequency, 140);
      const tearBp = this.filter('bandpass', 700, 0.8);
      this.tear = this.layer(noise.pink, [tearBp], tone, true);
      this.tearF = this.fp(tearBp.frequency, 700);
      const crHp = this.filter('highpass', 700, 0.7);
      this.crackle = this.layer(noise.crackle, [crHp], tone, true);
      this.crF = this.fp(crHp.frequency, 700);
      const rushBp = this.filter('bandpass', 1700, 0.6);
      this.rush = this.layer(noise.white, [rushBp], tone, true);
      this.rushF = this.fp(rushBp.frequency, 1700);
    }
  }

  update(now: number, d: EngineDrive): void {
    const tc = 0.06;
    const ftc = 0.035;
    const pr = d.profile;
    const rpm = clamp(d.rpm, 0, 1.1);
    const pw = clamp((rpm - 0.55) / 0.45, 0, 1.1);
    const ab = clamp(d.ab, 0, 1);
    const dop = d.doppler;
    const inside = d.interior;
    const { front, aft, side } = d;

    // whine
    const fw = (560 + 2300 * rpm * rpm) * pr.whine * dop;
    this.w1.set(fw, now, ftc);
    this.w2.set(fw * 0.502, now, ftc);
    const whine = inside ? 0.014 + 0.014 * pw : (0.008 + 0.034 * pw) * (0.25 + 1.3 * front);
    this.whine.set(rpm > 0.05 ? whine : 0, now, tc);

    // roar
    const roarCut = (300 + 2400 * Math.pow(pw, 1.5) + 1500 * ab) * dop * (inside ? 0.3 : 0.55 + 0.7 * aft);
    this.roarF.set(clamp(roarCut, 80, 16000), now, ftc);
    this.roarPk.set(260 * dop, now, ftc);
    this.roar.set((0.1 + 0.9 * Math.pow(pw, 1.7)) * pr.roar * (inside ? 0.5 : 0.35 + 0.85 * aft + 0.5 * side), now, tc);

    // rumble
    this.rumF.set(110 * dop, now, ftc);
    this.rumble.set((0.08 + 0.55 * pw * pw + 0.7 * ab) * pr.rumble * (inside ? 0.85 : 0.5 + 0.6 * aft + 0.3 * side), now, tc);

    // afterburner
    this.abF.set((170 + 280 * ab) * dop, now, ftc);
    this.ab.set(ab * (inside ? 0.55 : 0.9 * (0.35 + 0.9 * aft + 0.45 * side)), now, tc);

    if (this.full) {
      this.fanF!.set((38 + 115 * rpm) * pr.fan * dop, now, ftc);
      this.fan!.set(Math.pow(pw, 3) * (inside ? 0.022 : 0.06 * (0.25 + front + 0.4 * side)), now, tc);
      this.tearF!.set(700 * dop, now, ftc);
      this.tear!.set(ab * (inside ? 0.05 : 0.36 * (0.25 + aft)), now, tc);
      this.crF!.set(700 * dop, now, ftc);
      this.crackle!.set(ab * (inside ? 0.02 : 0.4 * (0.15 + aft)), now, tc);
      const sp = clamp(d.speed / 320, 0, 1.6);
      this.rushF!.set(1700 * dop, now, ftc);
      this.rush!.set(inside ? 0 : sp * sp * 0.22 * (0.4 + side), now, tc);
    }

    this.tone.set(clamp(d.cutoff, 120, 18000), now, 0.05);
    this.pan?.set(d.pan, now, 0.05);
    this.out.set(d.gain, now, 0.05);
  }

  /** Fade out (voice unused / muted). */
  silence(now: number, tc = 0.08): void {
    this.out.set(0, now, tc);
  }

  /** Current target output level. */
  get level(): number {
    return this.out.value;
  }
}
