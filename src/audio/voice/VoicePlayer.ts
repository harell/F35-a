/**
 * F35-A audio — voice playback: the Betty ICAWS channel and the radio channel.
 *
 *  Betty  priority-scheduled warnings (BettyScheduler), master-caution chime before cautions,
 *         urgent calls cut lower ones short; never two Betty clips at once.
 *  Radio  queued calls (RadioQueue): key-up click → clip (squelch tail baked in) → gap.
 *         Ducked under Betty. Text-only calls get a click + static burst.
 *  Engine and weapon sounds duck slightly while anyone speaks.
 *
 * Time base: a voice clock that only advances while the mission runs (pause-safe).
 */
import type { VoiceId, WarningId } from '../../core/types';
import { cautionChime, radioStatic, squelchKey } from '../synth/recipes';
import type { SynthEnv } from '../synth/build';
import { gainNode } from '../synth/build';
import { BETTY_RULES, BettyScheduler } from './betty';
import { RadioQueue } from './radioQueue';
import type { VoiceBank } from './VoiceBank';
import { voiceChannel } from './voiceIds';

const KEYUP = 0.075;
const RADIO_GAP = 0.35;
/** A radio call waits this long after a Betty clip ends before keying up (so neither masks the other). */
const AFTER_BETTY = 0.12;
/** Fade (time constant, s) when a Betty clip is cut because its warning cleared. */
const CLEAR_FADE = 0.03;

export class VoicePlayer {
  readonly betty = new BettyScheduler();
  readonly radio = new RadioQueue(4, 6, 3);
  /** Voice clock (s). */
  clock = 0;
  private bettySrc: AudioBufferSourceNode | null = null;
  private bettyUntil = 0;
  private radioSrc: AudioBufferSourceNode | null = null;
  private radioUntil = 0;
  private radioNext = 0;
  private lastStatic = -99;
  private readonly bettyGain: GainNode;
  private readonly radioGain: GainNode;
  private ducked = false;
  private radioDucked = false;
  /** Someone (Betty or radio) is speaking — read by the music ducker. */
  speaking = false;
  /** Called when a clip starts: voice id + channel (for logs / tests). */
  onClipStart: ((id: VoiceId, channel: 'betty' | 'radio', clock: number) => void) | null = null;

  constructor(
    private readonly env: SynthEnv,
    private readonly bank: VoiceBank,
  ) {
    const ctx = env.ctx;
    this.bettyGain = gainNode(ctx, 1.0);
    this.radioGain = gainNode(ctx, 0.9);
    this.bettyGain.connect(env.mixer.bus.voice);
    this.radioGain.connect(env.mixer.bus.voice);
  }

  /** A 'warning' event: cautions ring the master-caution chime and hold Betty briefly. */
  onWarning(id: WarningId, active: boolean): void {
    if (!active) return;
    const rule = BETTY_RULES[id];
    if (rule?.caution) {
      cautionChime(this.env, this.env.ctx.currentTime + 0.01);
      this.betty.hold(this.clock + 0.45);
    }
  }

  /** A 'radio' event. */
  onRadio(voice: VoiceId | undefined, priority: number): void {
    if (voice) {
      this.radio.push(voice, priority, this.clock);
    } else if (this.clock - this.lastStatic > 1.5 && !this.radioBusy()) {
      this.lastStatic = this.clock;
      radioStatic(this.env, this.env.ctx.currentTime + 0.01);
    }
  }

  /** Direct playback (AudioApi.playVoice). */
  play(id: VoiceId): void {
    if (voiceChannel(id) === 'radio') {
      this.radio.push(id, 2, this.clock);
      return;
    }
    const buf = this.bank.get(id);
    if (!buf) return;
    this.stopBetty(0.02);
    this.startBetty(buf);
  }

  private radioBusy(): boolean {
    return this.clock < this.radioUntil;
  }

  /**
   * Per frame (not while paused).
   * @param warnings the player's active warnings (null = no player / dead)
   */
  update(dt: number, warnings: { has(id: WarningId): boolean } | null): void {
    this.clock += dt;
    const now = this.clock;
    const ctx = this.env.ctx;

    // Betty: a clip whose warning has cleared (missile defeated, pulled up…) is cut at once
    const cur = this.betty.playingWarning(now);
    if (cur && this.bettySrc && (!warnings || !warnings.has(cur))) {
      this.stopBetty(CLEAR_FADE);
      this.betty.stopped(now);
    }
    if (warnings) {
      const d = this.betty.update(now, warnings);
      if (d) {
        if (d.preempt) {
          this.stopBetty(0.015);
          this.betty.stopped(now);
        }
        const buf = this.bank.get(d.voice);
        this.betty.started(d.warning, now, buf ? buf.duration : 0);
        if (buf) {
          this.startBetty(buf, d.preempt ? 0.03 : 0);
          this.onClipStart?.(d.voice, 'betty', now);
        }
      }
    }
    const bettyOn = now < this.bettyUntil;

    // Radio: never keys up over Betty — it waits for the clip to end (+ a short gap); while the
    // call plays, Betty's reminders (not new warnings, not PULL UP) wait for it to finish.
    if (!this.radioBusy() && now >= this.radioNext && now >= this.bettyUntil + AFTER_BETTY) {
      const item = this.radio.next(now);
      if (item) {
        const buf = this.bank.get(item.voice);
        if (buf) {
          this.betty.deferRepeats(now + KEYUP + buf.duration + 0.1);
          this.onClipStart?.(item.voice, 'radio', now);
          const t = ctx.currentTime + 0.01;
          squelchKey(this.env, t, 1);
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(this.radioGain);
          src.start(t + KEYUP);
          src.onended = () => src.disconnect();
          this.radioSrc = src;
          this.radioUntil = now + KEYUP + buf.duration;
          this.radioNext = this.radioUntil + RADIO_GAP;
        }
      }
    }
    const radioOn = this.radioBusy();

    // ducking
    if (bettyOn !== this.radioDucked) {
      this.radioDucked = bettyOn;
      this.radioGain.gain.setTargetAtTime(bettyOn ? 0.32 : 0.9, ctx.currentTime, 0.05);
    }
    const speaking = bettyOn || radioOn;
    this.speaking = speaking;
    if (speaking !== this.ducked) {
      this.ducked = speaking;
      this.env.mixer.setDuck(speaking ? 0.72 : 1);
    }
  }

  private startBetty(buf: AudioBuffer, delay = 0): void {
    const ctx = this.env.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.bettyGain);
    src.start(ctx.currentTime + 0.005 + delay);
    src.onended = () => src.disconnect();
    this.bettySrc = src;
    this.bettyUntil = this.clock + delay + buf.duration;
  }

  private stopBetty(fade: number): void {
    const src = this.bettySrc;
    if (!src) return;
    this.bettySrc = null;
    this.bettyUntil = this.clock;
    const ctx = this.env.ctx;
    // a short private fade so the cut doesn't click
    const g = gainNode(ctx, 1);
    try {
      src.disconnect();
      src.connect(g);
      g.connect(this.bettyGain);
      g.gain.setTargetAtTime(0, ctx.currentTime, fade);
      src.stop(ctx.currentTime + fade * 5);
      src.onended = () => {
        src.disconnect();
        g.disconnect();
      };
    } catch {
      /* already ended */
    }
  }

  /** Stop speaking now (pause / mission end). Queued radio is kept unless `clearQueue`. */
  stopAll(clearQueue: boolean): void {
    this.stopBetty(0.01);
    const r = this.radioSrc;
    this.radioSrc = null;
    try {
      r?.stop();
    } catch {
      /* ignore */
    }
    this.radioUntil = this.clock;
    this.radioNext = this.clock + 0.3;
    if (clearQueue) {
      this.radio.clear();
      this.betty.reset();
    } else {
      this.betty.stopped(this.clock);
    }
    if (this.ducked) {
      this.ducked = false;
      this.env.mixer.setDuck(1);
    }
    if (this.radioDucked) {
      this.radioDucked = false;
      this.radioGain.gain.setTargetAtTime(0.9, this.env.ctx.currentTime, 0.02);
    }
  }
}
