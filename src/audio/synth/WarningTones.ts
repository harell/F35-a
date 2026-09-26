/**
 * F35-A audio — continuous avionics tones (headset, 'warn' bus).
 *
 *   spike    RWR lock / track: steady repeating beep while any emitter tracks us
 *            (lower pitch for SAM/AAA "mud spike", higher for fighters)
 *   launch   RWR missile launch: urgent fast two-tone warble
 *   MAWS     DAS missile approach warning: descending sweeps, repetition rate rising as the
 *            time-to-impact shrinks (scheduled beeps on one persistent oscillator)
 *   growl    AIM-9X seeker: low noise-modulated growl while searching, high steady tone
 *            with a slight warble when the seeker has a target (locked)
 */
import type { SmoothParam } from '../core/SmoothParam';
import type { NoiseSet } from './NoiseBank';
import { VoiceGraph } from './VoiceGraph';

export interface WarningDrive {
  /** An RWR contact is tracking us. */
  spike: boolean;
  /** Spike is from a SAM/AAA radar (mud spike). */
  spikeGround: boolean;
  /** An RWR contact is guiding a missile at us. */
  launch: boolean;
  /** Missile approach (DAS): shortest time-to-impact (s) or −1 when none. */
  mawsTti: number;
  /** AIM-9X seeker state. */
  growl: 'off' | 'search' | 'locked';
}

export function makeWarningDrive(): WarningDrive {
  return { spike: false, spikeGround: false, launch: false, mawsTti: -1, growl: 'off' };
}

export class WarningTones extends VoiceGraph {
  private readonly spike: SmoothParam;
  private readonly spikeF: SmoothParam;
  private readonly launch: SmoothParam;
  private readonly mawsOsc: OscillatorNode;
  private readonly mawsGain: GainNode;
  private readonly growl: SmoothParam;
  private readonly growlF: SmoothParam;
  private readonly lockTone: SmoothParam;
  private nextMaws = 0;

  constructor(ctx: AudioContext, noise: NoiseSet, dest: AudioNode) {
    super(ctx);
    const out = this.gain(1);
    this.setOutput(out, dest);

    // spike: square tone gated by a smoothed square LFO (~7.5 beeps/s)
    const so = this.osc('square', 1250);
    const slp = this.filter('lowpass', 3500, 0.7);
    const gate = this.gain(0.5);
    const lfo = this.osc('square', 7.5);
    const lfoLp = this.filter('lowpass', 90, 0.7);
    const lfoAmt = this.gain(0.5);
    lfo.connect(lfoLp);
    lfoLp.connect(lfoAmt);
    lfoAmt.connect(gate.gain);
    this.spike = this.layer(so, [slp, gate], out, false);
    this.spikeF = this.fp(so.frequency, 1250);

    // launch: frequency-modulated warble (square LFO → ±340 Hz around 1300 Hz)
    const lo = this.osc('square', 1300);
    const wob = this.osc('square', 11);
    const wobAmt = this.gain(340);
    wob.connect(wobAmt);
    wobAmt.connect(lo.frequency);
    const llp = this.filter('lowpass', 4200, 0.7);
    this.launch = this.layer(lo, [llp], out, false);

    // MAWS: persistent oscillator; sweeps scheduled from update()
    this.mawsOsc = this.osc('sawtooth', 1800);
    const mlp = this.filter('lowpass', 3800, 0.8);
    this.mawsGain = this.gain(0);
    this.mawsOsc.connect(mlp);
    mlp.connect(this.mawsGain);
    this.mawsGain.connect(out);

    // AIM-9X growl: saw → band-pass → noise-modulated VCA
    const go = this.osc('sawtooth', 210);
    const gbp = this.filter('bandpass', 420, 1.3);
    const vca = this.gain(0.35);
    const am = this.filter('lowpass', 40, 0.7);
    const amAmt = this.gain(1.4);
    this.tap(noise.brown, am);
    am.connect(amAmt);
    amAmt.connect(vca.gain);
    const vib = this.osc('sine', 5.5);
    const vibAmt = this.gain(9);
    vib.connect(vibAmt);
    vibAmt.connect(go.frequency);
    this.growl = this.layer(go, [gbp, vca], out, false);
    this.growlF = this.fp(go.frequency, 210);

    // AIM-9X lock tone: high triangle with a gentle warble
    const to = this.osc('triangle', 1150);
    const tvib = this.osc('sine', 7);
    const tvibAmt = this.gain(16);
    tvib.connect(tvibAmt);
    tvibAmt.connect(to.frequency);
    this.lockTone = this.layer(to, [], out, false);
  }

  update(now: number, d: WarningDrive): void {
    this.gate(now, d.spike || d.launch || d.mawsTti >= 0 || d.growl !== 'off');
    // launch warble overrides the spike tone
    this.launch.set(d.launch ? 0.09 : 0, now, 0.015);
    this.spikeF.set(d.spikeGround ? 950 : 1250, now, 0.01);
    this.spike.set(d.spike && !d.launch ? 0.1 : 0, now, 0.015);

    // MAWS sweeps, faster as the missile closes
    if (d.mawsTti >= 0) {
      if (now >= this.nextMaws - 0.03) {
        const t = Math.max(now, this.nextMaws);
        const f = this.mawsOsc.frequency;
        const g = this.mawsGain.gain;
        f.cancelScheduledValues(t);
        f.setValueAtTime(1900, t);
        f.exponentialRampToValueAtTime(900, t + 0.11);
        g.cancelScheduledValues(t);
        g.setValueAtTime(0, t);
        g.linearRampToValueAtTime(0.16, t + 0.006);
        g.setValueAtTime(0.16, t + 0.1);
        g.linearRampToValueAtTime(0, t + 0.12);
        const period = Math.min(0.6, Math.max(0.15, 0.1 + 0.055 * d.mawsTti));
        this.nextMaws = t + period;
      }
    } else if (this.nextMaws > now + 1) {
      this.nextMaws = now;
    }

    // AIM-9X
    const searching = d.growl === 'search';
    const locked = d.growl === 'locked';
    this.growl.set(searching ? 0.28 : 0, now, 0.04);
    this.growlF.set(searching ? 210 : 260, now, 0.1);
    this.lockTone.set(locked ? 0.1 : 0, now, 0.03);
  }

  silence(now: number): void {
    this.launch.set(0, now, 0.01);
    this.spike.set(0, now, 0.01);
    this.growl.set(0, now, 0.01);
    this.lockTone.set(0, now, 0.01);
    this.mawsGain.gain.cancelScheduledValues(now);
    this.mawsGain.gain.setTargetAtTime(0, now, 0.01);
    this.nextMaws = now;
  }
}
