/**
 * F35-A audio — gun voices.
 *
 * GAU-22/A (player): 3,300 rds/min = 55 rounds per second → the loop buffer carries one
 * transient per round, so the "brrrt" pitch IS the rate of fire. Spin-up ramps the loop's
 * playback rate (rate of fire) from ~60 % to 100 % in 0.2 s; in the cockpit a barrel-drive
 * whine and a low airframe rumble are added. Enemy GSh-30-1 / ZSU-23-4 use their own loops
 * and are heard positionally (distance low-pass, pan).
 */
import type { SynthBuffers, GunKind } from '../core/buffers';
import type { SmoothParam } from '../core/SmoothParam';
import type { NoiseSet } from './NoiseBank';
import { VoiceGraph } from './VoiceGraph';

export class GunVoice extends VoiceGraph {
  firing = false;
  /** Shooter entity id (remote guns) or −1. */
  shooterId = -1;
  kind: GunKind;
  /** Context time the current burst started / ended. */
  startedAt = 0;
  stoppedAt = -Infinity;
  private loop: AudioBufferSourceNode | null = null;
  private readonly loopGain: GainNode;
  private readonly out: SmoothParam;
  private readonly tone: SmoothParam;
  private readonly pan: SmoothParam | null;
  private readonly rumble: SmoothParam;
  private readonly spin: SmoothParam;
  private readonly spinOsc: OscillatorNode;
  private readonly body: BiquadFilterNode;

  constructor(
    ctx: AudioContext,
    private readonly buffers: SynthBuffers,
    noise: NoiseSet,
    dest: AudioNode,
    kind: GunKind,
  ) {
    super(ctx);
    this.kind = kind;
    const out = this.gain(0);
    const tone = this.filter('lowpass', 9000, 0.6);
    const pan = this.panner();
    tone.connect(pan);
    pan.connect(out);
    this.setOutput(out, dest);
    this.out = this.gp(out.gain, 0);
    this.tone = this.fp(tone.frequency, 9000);
    this.pan = this.pp(pan);
    // loop path: loop → body EQ → loopGain → tone
    this.body = this.filter('peaking', 180, 0.9, 6);
    this.loopGain = this.gain(0);
    this.body.connect(this.loopGain);
    this.loopGain.connect(tone);
    // airframe rumble (cockpit)
    const rlp = this.filter('lowpass', 90, 0.9);
    this.rumble = this.layer(noise.brown, [rlp], tone, true);
    // barrel drive whine
    this.spinOsc = this.osc('sawtooth', 180);
    const slp = this.filter('lowpass', 1400, 0.7);
    this.spin = this.layer(this.spinOsc, [slp], tone, false);
  }

  /** Trigger pulled: new loop source, spin-up ramp. */
  start(now: number, interior: boolean): void {
    if (this.firing) return;
    this.firing = true;
    this.startedAt = now;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers.gun[this.kind];
    src.loop = true;
    const r = src.playbackRate;
    r.setValueAtTime(0.62, now);
    r.linearRampToValueAtTime(1, now + 0.2);
    src.connect(this.body);
    src.start(now, Math.random() * 0.05);
    this.loop = src;
    const g = this.loopGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0, now);
    g.linearRampToValueAtTime(1, now + 0.03);
    const f = this.spinOsc.frequency;
    f.cancelScheduledValues(now);
    f.setValueAtTime(170, now);
    f.linearRampToValueAtTime(420, now + 0.22);
    this.rumble.set(interior ? 0.55 : 0.15, now, 0.03);
    this.spin.set(interior ? 0.035 : 0, now, 0.03);
  }

  /** Trigger released: cut the rounds, spin the barrels down. */
  stop(now: number): void {
    if (!this.firing) return;
    this.firing = false;
    this.stoppedAt = now;
    const g = this.loopGain.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + 0.025);
    try {
      this.loop?.stop(now + 0.05);
    } catch {
      /* ignore */
    }
    const loop = this.loop;
    if (loop) loop.onended = () => loop.disconnect();
    this.loop = null;
    const f = this.spinOsc.frequency;
    f.cancelScheduledValues(now);
    f.setValueAtTime(420, now);
    f.exponentialRampToValueAtTime(60, now + 0.8);
    this.spin.set(0, now, 0.25);
    this.rumble.set(0, now, 0.06);
  }

  /** Firing, or still spinning down / fading. */
  busy(now: number): boolean {
    return this.firing || now - this.stoppedAt < 1.2;
  }

  /** Per-frame level / placement. */
  update(now: number, gain: number, pan: number, cutoff: number): void {
    this.out.set(gain, now, 0.04);
    this.pan?.set(pan, now, 0.05);
    this.tone.set(Math.max(150, cutoff), now, 0.05);
  }

  /** Immediate silence (stopAll). */
  kill(now: number): void {
    this.stop(now);
    this.out.set(0, now, 0.01);
    this.shooterId = -1;
  }

  override dispose(): void {
    try {
      this.loop?.stop();
      this.loop?.disconnect();
    } catch {
      /* ignore */
    }
    this.loop = null;
    super.dispose();
  }
}
