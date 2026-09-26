/**
 * F35-A audio — voice playback: the Betty ICAWS channel and the radio channel.
 *
 *  Betty  priority-scheduled warnings (BettyScheduler), master-caution chime before cautions,
 *         urgent calls cut lower ones short; never two Betty clips at once.
 *  Radio  queued calls (RadioQueue): key-up click → clip (squelch tail baked in) → gap.
 *         What is said always matches the subtitle (radioSpeech: the fixed clip if it says what
 *         the subtitle says, else the AWACS call composed from word segments, else text-only).
 *         Ducked under Betty. Text-only calls get a click + static burst.
 *  MISSILE / PULL UP are never held by radio: if one fires while a call is on the air the call
 *  is cut and re-queued after it (a DARKSTAR "SAM launch" is dropped — Betty already said it).
 *  After a missile impact MISSILE is muted briefly unless another missile is inbound.
 *  Engine and weapon sounds duck slightly while anyone speaks.
 *
 * Time base: a voice clock that only advances while the mission runs (pause-safe).
 */
import type { VoiceId, WarningId } from '../../core/types';
import { cautionChime, radioStatic, squelchKey } from '../synth/recipes';
import type { SynthEnv } from '../synth/build';
import { gainNode } from '../synth/build';
import { BETTY_RULES, BettyScheduler, URGENT_BETTY } from './betty';
import { RadioQueue, type RadioItem } from './radioQueue';
import { PAUSE, resolveRadioSpeech, type ClipId, type SpeechToken } from './radioSpeech';
import type { VoiceBank } from './VoiceBank';
import { voiceChannel } from './voiceIds';

const KEYUP = 0.075;
const RADIO_GAP = 0.35;
/** A radio call waits this long after a Betty clip ends before keying up (so neither masks the other). */
const AFTER_BETTY = 0.12;
/** Radio calls at or above this priority (threat calls: SAM launch…) hold Betty — except PULL UP — until they end. */
const URGENT_RADIO = 3;
/** Fade (time constant, s) when a Betty clip is cut because its warning cleared. */
const CLEAR_FADE = 0.03;
/** Composed calls: gap between words (segments carry ~50 ms of air already) and at a comma. */
const WORD_GAP = -0.05;
const PHRASE_GAP = 0.07;
/** MISSILE stays quiet this long after an impact unless a new missile shows up. */
export const POST_HIT_MUTE = 1.2;
/** A cut radio call is re-queued if less than this share of it was heard. */
const REQUEUE_BELOW = 0.7;

export class VoicePlayer {
  readonly betty = new BettyScheduler();
  readonly radio = new RadioQueue(4, 6, 3);
  /** Voice clock (s). */
  clock = 0;
  private bettySrc: AudioBufferSourceNode | null = null;
  private bettyUntil = -1;
  private readonly radioSrcs: AudioBufferSourceNode[] = [];
  private radioCallGain: GainNode | null = null;
  private radioItem: RadioItem | null = null;
  private radioStart = 0;
  private radioUntil = 0;
  /** Missile ids inbound when the last missile hit (MISSILE stays muted unless a new one appears). */
  private readonly hitIds = new Int32Array(16);
  private hitCount = 0;
  /** Missiles inbound in the last frame (noteIncoming). */
  private readonly lastIds = new Int32Array(16);
  private lastCount = 0;
  private radioNext = 0;
  private lastStatic = -99;
  private readonly bettyGain: GainNode;
  private readonly radioGain: GainNode;
  private ducked = false;
  private radioDucked = false;
  /** Someone (Betty or radio) is speaking — read by the music ducker. */
  speaking = false;
  /** Called when a clip starts: voice id + channel (for logs / tests). */
  onClipStart: ((id: ClipId, channel: 'betty' | 'radio', clock: number) => void) | null = null;
  /** Called when a radio call starts: its hint voice and the clips actually spoken (logs / tests). */
  onRadioStart: ((voice: ClipId, clips: readonly SpeechToken[] | null, clock: number) => void) | null = null;

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

  /** A 'radio' event (`text` = the subtitle, `from` = the speaker). */
  onRadio(voice: VoiceId | undefined, priority: number, text?: string, from?: string): void {
    const tokens = resolveRadioSpeech(text, voice, from);
    if (tokens && voice) {
      const single = tokens.length === 1 && tokens[0] === voice;
      this.radio.push(voice, priority, this.clock, single ? null : tokens, single ? voice : (text ?? voice));
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
   * The player was hit by a missile: stop a MISSILE clip that is playing and keep MISSILE quiet
   * for POST_HIT_MUTE s unless a missile that was not inbound at the impact appears
   * (`ids[0..n)` = the missiles inbound in the last frame, including the one that hit).
   */
  onMissileImpact(ids: ArrayLike<number>, n: number): void {
    const now = this.clock;
    this.hitCount = Math.min(n, this.hitIds.length);
    for (let i = 0; i < this.hitCount; i++) this.hitIds[i] = ids[i];
    // another missile of the salvo still inbound: MISSILE stays exactly as it is
    if (this.otherInbound(this.lastIds, this.lastCount)) return;
    if (this.betty.playingWarning(now) === 'missile' && this.bettySrc) {
      this.stopBetty(CLEAR_FADE);
      this.betty.stopped(now);
    }
    this.betty.mute('missile', now + POST_HIT_MUTE);
  }

  /** Is any of `ids[0..n)` a missile other than the ones that just hit? */
  private otherInbound(ids: ArrayLike<number>, n: number): boolean {
    for (let i = 0; i < n; i++) {
      let known = false;
      for (let j = 0; j < this.hitCount && !known; j++) known = this.hitIds[j] === ids[i];
      if (!known) return true;
    }
    return false;
  }

  /** Per frame: the missiles inbound now (lifts the post-impact mute if a new one appears). */
  noteIncoming(ids: ArrayLike<number>, n: number): void {
    this.lastCount = Math.min(n, this.lastIds.length);
    for (let i = 0; i < this.lastCount; i++) this.lastIds[i] = ids[i];
    if (this.betty.isMuted('missile', this.clock) && this.otherInbound(ids, n)) this.betty.unmute('missile');
  }

  /**
   * ICAWS acknowledge (e.g. a tap on the warning band): cautions/warnings below MISSILE that are
   * active stop reminding until they clear; a clip of one of them that is playing is cut.
   * Returns how many warnings were acknowledged.
   */
  acknowledge(): number {
    const now = this.clock;
    const n = this.betty.acknowledge();
    const cur = this.betty.playingWarning(now);
    if (cur && (BETTY_RULES[cur]?.priority ?? 0) < URGENT_BETTY && this.bettySrc) {
      this.stopBetty(CLEAR_FADE);
      this.betty.stopped(now);
    }
    return n;
  }

  /** Cut the call on the air (fade), optionally re-queueing it to play again afterwards. */
  private cutRadio(requeue: boolean): void {
    const ctx = this.env.ctx;
    const g = this.radioCallGain;
    const item = this.radioItem;
    const heard = this.radioUntil > this.radioStart ? (this.clock - this.radioStart) / (this.radioUntil - this.radioStart) : 1;
    if (g) g.gain.setTargetAtTime(0, ctx.currentTime, 0.015);
    for (const src of this.radioSrcs) {
      try {
        src.stop(ctx.currentTime + 0.08);
      } catch {
        /* already ended */
      }
    }
    this.radioSrcs.length = 0;
    this.radioCallGain = null;
    this.radioItem = null;
    this.radioUntil = this.clock;
    this.radioNext = this.clock + 0.1;
    if (requeue && item && heard < REQUEUE_BELOW && (item.cuts ?? 0) < 1) this.radio.requeue(item, this.clock);
  }

  /** Play a radio call now. Returns false if none of its clips is available. */
  private startRadio(item: RadioItem, now: number, warnings: { has(id: WarningId): boolean } | null): boolean {
    const ctx = this.env.ctx;
    const tokens: readonly SpeechToken[] | null = item.clips;
    // the fixed clip, or the composed word list (+ the squelch tail the segments don't carry)
    let total = 0;
    let missing = 0;
    let words = 0;
    if (!tokens) {
      const buf = this.bank.get(item.voice);
      if (!buf) return false;
      total = buf.duration;
    } else {
      for (const t of tokens) {
        if (t === PAUSE) {
          total += PHRASE_GAP;
          continue;
        }
        words++;
        const b = this.bank.get(t);
        if (b) total += b.duration + WORD_GAP;
        else missing++;
      }
      // segments not loaded (offline / still decoding): fall back to a text-only call
      if (words === 0 || missing > words * 0.2) {
        this.radioStatic();
        return false;
      }
      const tail = this.bank.get('s_tail');
      if (tail) total += tail.duration;
    }
    const end = now + KEYUP + total + 0.1;
    // an urgent call holds Betty's lesser clips; MISSILE / PULL UP never wait (see betty.deferAll)
    if (item.priority >= URGENT_RADIO && !(warnings && warnings.has('missile'))) this.betty.deferAll(end);
    this.betty.deferRepeats(end);
    // log what is actually heard: a whole-call replacement (Hammer) by its own id
    this.onClipStart?.(tokens && tokens.length === 1 && tokens[0] !== PAUSE ? tokens[0] : item.voice, 'radio', now);
    this.onRadioStart?.(item.voice, tokens, now);
    const t0 = ctx.currentTime + 0.01;
    squelchKey(this.env, t0, 1);
    const g = gainNode(ctx, 1);
    g.connect(this.radioGain);
    this.radioCallGain = g;
    this.radioSrcs.length = 0;
    let at = t0 + KEYUP;
    const play = (buf: AudioBuffer) => {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(g);
      src.start(at);
      src.onended = () => src.disconnect();
      this.radioSrcs.push(src);
      at += buf.duration;
    };
    if (!tokens) play(this.bank.get(item.voice)!);
    else {
      for (const t of tokens) {
        if (t === PAUSE) {
          at += PHRASE_GAP;
          continue;
        }
        const b = this.bank.get(t as ClipId);
        if (!b) continue;
        play(b);
        at += WORD_GAP;
      }
      const tail = this.bank.get('s_tail');
      if (tail) {
        at -= WORD_GAP;
        play(tail);
      }
    }
    const last = this.radioSrcs[this.radioSrcs.length - 1];
    if (last) {
      last.onended = () => {
        last.disconnect();
        g.disconnect();
      };
    }
    this.radioItem = item;
    this.radioStart = now;
    this.radioUntil = now + KEYUP + total;
    this.radioNext = this.radioUntil + RADIO_GAP;
    return true;
  }

  private radioStatic(): void {
    if (this.clock - this.lastStatic > 1.5) {
      this.lastStatic = this.clock;
      radioStatic(this.env, this.env.ctx.currentTime + 0.01);
    }
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
        // a new MISSILE / any PULL UP pre-empts the radio: the call is cut and re-queued after Betty
        // (MISSILE reminders wait for the call instead — see deferRepeats in startRadio)
        if (d.priority >= URGENT_BETTY && (!d.repeat || d.priority >= 100) && this.radioBusy()) this.cutRadio(true);
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
      // DARKSTAR's "SAM launch" adds nothing once Betty is calling MISSILE: drop it
      if (item && !(item.voice === 'a_sam_launch' && warnings && warnings.has('missile'))) this.startRadio(item, now, warnings);
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
    for (const r of this.radioSrcs) {
      try {
        r.stop();
      } catch {
        /* ignore */
      }
    }
    this.radioSrcs.length = 0;
    this.radioCallGain = null;
    this.radioItem = null;
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
