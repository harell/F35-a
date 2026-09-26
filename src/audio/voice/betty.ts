/**
 * F35-A audio — "Bitching Betty" ICAWS voice scheduling (pure logic, unit-tested).
 *
 * Maps active cockpit warnings (player.warnings) to Betty clips and decides what to say:
 *  - priority order PULL UP > MISSILE > ENGINE FIRE > … (only one clip at a time, never overlapping)
 *  - urgent warnings repeat while active (pull up ≈ every 1.2 s, missile ≈ every 2.5 s)
 *  - others speak once on activation plus an occasional reminder
 *  - PULL UP / MISSILE may cut a lower-priority clip short (like the real ICAWS)
 *  - anti-chatter: a warning that flickers off/on is not re-announced within its re-arm time
 *  - no nagging: below MISSILE, a warning is reminded at most MAX_REMINDERS times per activation,
 *    and acknowledge() silences the reminders of everything active now (PULL UP / MISSILE never)
 *  - an urgent radio call (deferAll) never holds PULL UP or MISSILE back
 *  - mute(): a warning can be silenced for a moment (MISSILE right after the missile hit)
 */
import type { VoiceId, WarningId } from '../../core/types';

export interface BettyRule {
  voice: VoiceId;
  /** Higher = more important. */
  priority: number;
  /** Seconds between clip starts while the warning stays active (reminder period). */
  repeat: number;
  /** Minimum seconds since the last announcement before a re-activation is announced again. */
  rearm: number;
  /** May interrupt a lower-priority clip that is currently playing. */
  preempt: boolean;
  /** Plays the master-caution chime when it appears (cautions; warnings go straight to voice). */
  caution: boolean;
}

/** Warning → Betty clip mapping + timing rules. 'spike' has no voice (the RWR tone covers it). */
export const BETTY_RULES: Partial<Record<WarningId, BettyRule>> = {
  pull_up: { voice: 'b_pull_up', priority: 100, repeat: 1.2, rearm: 0.6, preempt: true, caution: false },
  missile: { voice: 'b_missile', priority: 90, repeat: 2.5, rearm: 1.5, preempt: true, caution: false },
  engine_fire: { voice: 'b_engine_fire', priority: 80, repeat: 6, rearm: 3, preempt: false, caution: false },
  engine_fail: { voice: 'b_warning', priority: 75, repeat: 15, rearm: 5, preempt: false, caution: true },
  over_g: { voice: 'b_over_g', priority: 70, repeat: 4, rearm: 3, preempt: false, caution: false },
  stall: { voice: 'b_aoa', priority: 65, repeat: 3.5, rearm: 2.5, preempt: false, caution: false },
  altitude: { voice: 'b_altitude', priority: 60, repeat: 5, rearm: 3, preempt: false, caution: false },
  hydraulics: { voice: 'b_hydraulics', priority: 50, repeat: 30, rearm: 10, preempt: false, caution: true },
  damage: { voice: 'b_warning', priority: 45, repeat: 30, rearm: 10, preempt: false, caution: true },
  bingo: { voice: 'b_bingo', priority: 40, repeat: 45, rearm: 20, preempt: false, caution: true },
  fuel_low: { voice: 'b_fuel_low', priority: 35, repeat: 60, rearm: 20, preempt: false, caution: true },
  speed_low: { voice: 'b_speed', priority: 30, repeat: 8, rearm: 4, preempt: false, caution: false },
  flares_low: { voice: 'b_flares_low', priority: 20, repeat: 60, rearm: 20, preempt: false, caution: true },
  chaff_low: { voice: 'b_chaff_low', priority: 15, repeat: 60, rearm: 20, preempt: false, caution: true },
};

/** Betty clip for a warning (undefined = no voice). */
export function voiceForWarning(id: WarningId): VoiceId | undefined {
  return BETTY_RULES[id]?.voice;
}

const RULE_IDS = Object.keys(BETTY_RULES) as WarningId[];

/** Warnings at or above this priority (MISSILE, PULL UP) always repeat and are never held by radio. */
export const URGENT_BETTY = 90;
/** Reminders per activation for warnings below URGENT_BETTY (then quiet until it clears). */
export const MAX_REMINDERS = 2;

export interface BettyDecision {
  warning: WarningId;
  voice: VoiceId;
  priority: number;
  /** Stop the clip that is playing now before starting this one. */
  preempt: boolean;
  /** A reminder (the warning was already announced during this activation). */
  repeat: boolean;
}

interface WarnState {
  active: boolean;
  /** Announced at least once during the current activation. */
  announced: boolean;
  lastStart: number;
  /** Reminders spoken during the current activation. */
  reminders: number;
  /** Pilot acknowledged this activation: no more reminders until it clears. */
  acked: boolean;
  /** Not announced before this time (e.g. MISSILE right after an impact). */
  mutedUntil: number;
}

export class BettyScheduler {
  /** Silence between two clips (s). */
  gap = 0.22;
  private readonly st = new Map<WarningId, WarnState>();
  private playing: { warning: WarningId; priority: number; until: number } | null = null;
  private holdUntil = -Infinity;
  /** Repeats (not first announcements) of warnings below PULL UP wait until this time (radio call in progress). */
  private repeatHoldUntil = -Infinity;
  /** Every clip below PULL UP waits until this time (urgent radio call on the air). */
  private allHoldUntil = -Infinity;
  /** Master-caution chime ringing: non-urgent clips wait for it, PULL UP / MISSILE don't. */
  private chimeUntil = -Infinity;
  private readonly decision: BettyDecision = { warning: 'pull_up', voice: 'b_pull_up', priority: 0, preempt: false, repeat: false };

  constructor() {
    this.reset();
  }

  reset(): void {
    for (const id of RULE_IDS) this.st.set(id, { active: false, announced: false, lastStart: -Infinity, reminders: 0, acked: false, mutedUntil: -Infinity });
    this.playing = null;
    this.holdUntil = -Infinity;
    this.repeatHoldUntil = -Infinity;
    this.allHoldUntil = -Infinity;
    this.chimeUntil = -Infinity;
  }

  /**
   * Let an important radio call finish: reminders (repeats) of warnings other than PULL UP wait
   * until `until`. First announcements are never held back.
   */
  deferRepeats(until: number): void {
    if (until > this.repeatHoldUntil) this.repeatHoldUntil = until;
  }

  /**
   * An urgent threat call (e.g. DARKSTAR "SAM launch") is on the air: every Betty clip below
   * MISSILE waits until `until`, then speaks right after it. MISSILE and PULL UP never wait —
   * the on-board warning is the more timely cue (the radio yields to them instead).
   */
  deferAll(until: number): void {
    if (until > this.allHoldUntil) this.allHoldUntil = until;
  }

  /**
   * ICAWS acknowledge: every warning below MISSILE that is active now stops reminding until it
   * clears and comes back. Returns how many warnings were acknowledged.
   */
  acknowledge(): number {
    let n = 0;
    for (let i = 0; i < RULE_IDS.length; i++) {
      const id = RULE_IDS[i];
      const s = this.st.get(id)!;
      if (s.active && !s.acked && BETTY_RULES[id]!.priority < URGENT_BETTY) {
        s.acked = true;
        s.announced = true; // seen on the ICAWS page: not even a first call
        n++;
      }
    }
    return n;
  }

  /** Do not announce `warning` before `until` (unmute() lifts it early). */
  mute(warning: WarningId, until: number): void {
    const s = this.st.get(warning);
    if (s && until > s.mutedUntil) s.mutedUntil = until;
  }

  unmute(warning: WarningId): void {
    const s = this.st.get(warning);
    if (s) s.mutedUntil = -Infinity;
  }

  isMuted(warning: WarningId, now: number): boolean {
    const s = this.st.get(warning);
    return !!s && now < s.mutedUntil;
  }

  /** Warning whose clip is playing at `now` (null = silent). */
  playingWarning(now: number): WarningId | null {
    return this.playing && now < this.playing.until ? this.playing.warning : null;
  }

  /** Delay the next non-urgent clip (let the master-caution chime ring first). */
  hold(until: number): void {
    if (until > this.chimeUntil) this.chimeUntil = until;
  }

  /** Is a clip still playing at `now`? */
  isSpeaking(now: number): boolean {
    return !!this.playing && now < this.playing.until;
  }

  /**
   * Feed the current set of active warnings. Returns what to say now (the returned object is
   * reused between calls) or null. The caller must then call `started()`.
   */
  update(now: number, active: { has(id: WarningId): boolean }): BettyDecision | null {
    let best: WarningId | null = null;
    let bestRule: BettyRule | null = null;
    for (let i = 0; i < RULE_IDS.length; i++) {
      const id = RULE_IDS[i];
      const s = this.st.get(id)!;
      const rule = BETTY_RULES[id]!;
      const on = active.has(id);
      if (on && !s.active) {
        s.active = true;
        s.announced = false;
        s.reminders = 0;
        s.acked = false;
      } else if (!on && s.active) {
        s.active = false;
      }
      if (!s.active) continue;
      if (now < s.mutedUntil) continue;
      const urgent = rule.priority >= URGENT_BETTY;
      if (s.announced && !urgent && (s.acked || s.reminders >= MAX_REMINDERS)) continue;
      const since = now - s.lastStart;
      const due = s.announced ? since >= rule.repeat && (rule.priority >= 100 || now >= this.repeatHoldUntil) : since >= rule.rearm;
      if (!due) continue;
      if (!urgent && now < this.allHoldUntil) continue;
      if (!bestRule || rule.priority > bestRule.priority) {
        best = id;
        bestRule = rule;
      }
    }
    if (!best || !bestRule) return null;

    const d = this.decision;
    d.warning = best;
    d.voice = bestRule.voice;
    d.priority = bestRule.priority;
    d.preempt = false;
    d.repeat = this.st.get(best)!.announced;
    if (this.playing && now < this.playing.until) {
      if (bestRule.preempt && bestRule.priority > this.playing.priority) {
        d.preempt = true;
        return d;
      }
      return null;
    }
    if (now < this.holdUntil) return null;
    if (now < this.chimeUntil && !bestRule.preempt) return null;
    return d;
  }

  /** Report that the clip for `warning` started now and lasts `duration` s (0 if the clip is missing). */
  started(warning: WarningId, now: number, duration: number): void {
    const s = this.st.get(warning);
    const rule = BETTY_RULES[warning];
    if (!s || !rule) return;
    if (s.announced) s.reminders++;
    s.lastStart = now;
    s.announced = true;
    this.playing = { warning, priority: rule.priority, until: now + duration };
    this.holdUntil = now + duration + this.gap;
  }

  /** Current clip was cut (preempted / stopped). */
  stopped(now: number): void {
    this.playing = null;
    this.holdUntil = Math.min(this.holdUntil, now);
  }
}
