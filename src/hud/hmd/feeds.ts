/**
 * Timed text feeds for the HMD — pure logic, unit tested (no DOM).
 *
 *  RadioQueue    radio subtitles ("[DARKSTAR] Bandits BRAA 045/40…"), one at a time, queued, length
 *                dependent display time (faster when a backlog builds), priority calls jump the queue.
 *                Long calls are PAGED (max 2 lines per page, the drawer reports the page count) instead
 *                of being truncated: the display time grows with the number of pages.
 *  MessageQueue  the single centre message slot: ONE message at a time, highest priority wins
 *                (MISSION COMPLETE/FAILED › bad › warn › good › info), lower-priority messages wait
 *                (and are dropped if they waited too long), a higher-priority one pre-empts.
 *  KillFeed      "SPLASH MIG-29" / "SA-6 DESTROYED" lines, newest first, max 3, ~5 s each. A mission
 *                kill message for the same kill merges into the HUD's own line (no duplicates).
 *  classifyHudMessage  routes a 'hud:message' text to its zone (centre slot, kill feed, title banner,
 *                or dropped because the HUD already shows it as a dedicated cue).
 */
import type { Team } from '../../core/types';

/* ───────────────────────── Radio subtitles ───────────────────────── */

export interface Subtitle {
  from: string;
  text: string;
  priority: number;
  team: Team | undefined;
}

/** Minimum time a subtitle page stays on screen (s). */
export const RADIO_PAGE_MIN = 2.4;
/** Lines per subtitle page. */
export const RADIO_PAGE_LINES = 2;

export class RadioQueue {
  current: Subtitle | null = null;
  /** Seconds the current subtitle has been shown. */
  age = 0;
  /** How long the current subtitle stays up (s). */
  duration = 0;
  /** Pages of the current subtitle (reported by the drawer from its line wrap; ≥ 1). */
  pages = 1;
  private cut = false;
  private readonly queue: Subtitle[] = [];

  constructor(
    readonly maxQueue = 5,
    readonly minDuration = 2.6,
    readonly maxDuration = 5.5,
  ) {}

  get pending(): number {
    return this.queue.length;
  }

  /** Display time for a subtitle: ~4 s for a typical call, scaled by length and backlog. */
  durationFor(text: string, backlog: number): number {
    const base = Math.max(this.minDuration, Math.min(this.maxDuration, 2.2 + text.length * 0.035));
    return backlog >= 2 ? Math.max(this.minDuration * 0.8, base * 0.65) : base;
  }

  /**
   * The drawer wrapped the current subtitle into `n` pages: make sure every page gets at least
   * RADIO_PAGE_MIN seconds (the call is never truncated). Unless an urgent call is cutting it short.
   */
  setPages(n: number): void {
    const pages = Math.max(1, Math.floor(n));
    if (pages === this.pages) return;
    this.pages = pages;
    if (!this.cut) this.duration = Math.max(this.duration, pages * RADIO_PAGE_MIN * (this.queue.length >= 2 ? 0.8 : 1));
  }

  /** Index of the page to show now (0-based). */
  get page(): number {
    if (this.pages <= 1 || this.duration <= 0) return 0;
    return Math.min(this.pages - 1, Math.floor(this.age / (this.duration / this.pages)));
  }

  push(from: string, text: string, priority = 0, team?: Team): void {
    if (!text) return;
    // drop exact duplicates of what is on screen or already queued
    if (this.current && this.current.text === text && this.current.from === from) return;
    for (const q of this.queue) if (q.text === text && q.from === from) return;
    const item: Subtitle = { from, text, priority, team };
    // high-priority calls ("SAM launch!") jump ahead of lower-priority ones
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].priority < priority) i--;
    this.queue.splice(i, 0, item);
    if (this.queue.length > this.maxQueue) {
      // drop the lowest-priority, oldest entry
      let drop = 0;
      for (let k = 1; k < this.queue.length; k++) if (this.queue[k].priority < this.queue[drop].priority) drop = k;
      this.queue.splice(drop, 1);
    }
    if (!this.current) this.next();
    else if (priority >= 3 && this.current.priority < priority) {
      // urgent: cut the current one short
      this.duration = Math.min(this.duration, this.age + 0.25);
      this.cut = true;
    }
  }

  update(dt: number): void {
    if (!this.current) return;
    this.age += dt;
    if (this.age >= this.duration) this.next();
  }

  /** 0..1 opacity: quick fade in / out (and a short dip between pages). */
  get alpha(): number {
    if (!this.current) return 0;
    const fin = Math.min(1, this.age / 0.15);
    const fout = Math.min(1, (this.duration - this.age) / 0.3);
    let a = Math.max(0, Math.min(fin, fout));
    if (this.pages > 1) {
      const pd = this.duration / this.pages;
      const t = this.age - this.page * pd;
      if (this.page > 0) a = Math.min(a, 0.35 + t / 0.2);
    }
    return Math.max(0, Math.min(1, a));
  }

  clear(): void {
    this.queue.length = 0;
    this.current = null;
    this.age = 0;
    this.pages = 1;
    this.cut = false;
  }

  private next(): void {
    this.current = this.queue.shift() ?? null;
    this.age = 0;
    this.pages = 1;
    this.cut = false;
    this.duration = this.current ? this.durationFor(this.current.text, this.queue.length) : 0;
  }
}

/* ───────────────────────── Centre message slot ───────────────────────── */

export type MessageTone = 'info' | 'good' | 'bad' | 'warn';

export interface HudMessage {
  text: string;
  tone: MessageTone;
  age: number;
  duration: number;
  priority: number;
  /** Seconds spent waiting in the queue. */
  wait: number;
}

/** Default centre-slot priority of a message (higher wins). */
export function messagePriority(text: string, tone: MessageTone): number {
  if (/^MISSION (COMPLETE|FAILED)/.test(text)) return 5;
  if (tone === 'bad') return 4;
  if (tone === 'warn') return 3;
  if (tone === 'good') return 2;
  return 1;
}

/**
 * The single centre message slot. `items` holds the message on screen (0 or 1 entries) so drawers
 * can iterate it; `queue` holds the waiting ones (highest priority first).
 */
export class MessageQueue {
  readonly items: HudMessage[] = [];
  readonly queue: HudMessage[] = [];

  constructor(
    readonly maxQueue = 4,
    /** Seconds a low-priority message may wait before it is dropped. */
    readonly maxWait = 5,
  ) {}

  get current(): HudMessage | null {
    return this.items[0] ?? null;
  }

  push(text: string, tone: MessageTone = 'info', duration = 2.5, priority = messagePriority(text, tone)): void {
    const dur = Math.max(0.8, Math.min(6, duration));
    const cur = this.current;
    if (cur && cur.text === text) {
      // refresh instead of stacking duplicates
      cur.age = Math.min(cur.age, 0.2);
      cur.duration = Math.max(cur.duration, dur);
      cur.tone = tone;
      return;
    }
    for (const q of this.queue) {
      if (q.text === text) {
        q.duration = Math.max(q.duration, dur);
        q.wait = 0;
        return;
      }
    }
    const m: HudMessage = { text, tone, age: 0, duration: dur, priority, wait: 0 };
    if (!cur) {
      this.items.push(m);
      return;
    }
    if (priority > cur.priority) {
      // pre-empt; the interrupted message goes back to the queue if it still has a while to run
      this.items[0] = m;
      if (cur.duration - cur.age > 1 && cur.priority >= 2) {
        cur.duration = cur.duration - cur.age;
        cur.age = 0;
        cur.wait = 0;
        this.enqueue(cur);
      }
      return;
    }
    this.enqueue(m);
  }

  private enqueue(m: HudMessage): void {
    let i = this.queue.length;
    while (i > 0 && this.queue[i - 1].priority < m.priority) i--;
    this.queue.splice(i, 0, m);
    if (this.queue.length > this.maxQueue) {
      let drop = this.queue.length - 1;
      for (let k = this.queue.length - 1; k >= 0; k--) if (this.queue[k].priority < this.queue[drop].priority) drop = k;
      this.queue.splice(drop, 1);
    }
  }

  /**
   * `held`: a life-critical warning (MISSILE, PULL UP, STALL) holds the slot back, so a message below
   * priority 4 isn't on screen: it doesn't age (nor does good news waiting behind it) and shows when
   * the warning is over (playtest r3.1: an AARGM's HIT — DAMAGED aged out unseen during the defence).
   */
  update(dt: number, held = false): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i];
      if (!held || q.priority < 2) q.wait += dt;
      // info waits maxWait, good news a bit longer; warn / bad / mission end never expire in the queue
      if (q.priority < 3 && q.wait > this.maxWait * (q.priority >= 2 ? 1.6 : 1)) this.queue.splice(i, 1);
    }
    const cur = this.current;
    if (!cur) return this.advance();
    if (held && cur.priority < 4) return;
    cur.age += dt;
    // a backlog of more important messages: don't linger
    if (this.queue.length >= 2 && cur.age > 1.2) cur.duration = Math.min(cur.duration, cur.age + 0.3);
    if (cur.age >= cur.duration) {
      this.items.length = 0;
      this.advance();
    }
  }

  private advance(): void {
    const n = this.queue.shift();
    if (!n) return;
    n.age = 0;
    if (this.queue.length >= 2) n.duration = Math.max(1.2, n.duration * 0.65);
    this.items.push(n);
  }

  static alpha(m: HudMessage): number {
    return Math.max(0, Math.min(1, m.age / 0.12, (m.duration - m.age) / 0.45));
  }

  clear(): void {
    this.items.length = 0;
    this.queue.length = 0;
  }
}

/* ───────────────────────── Kill feed ───────────────────────── */

export interface KillEntry {
  text: string;
  tone: MessageTone;
  age: number;
  /** A mission kill message already merged into this line. */
  merged: boolean;
}

export class KillFeed {
  readonly items: KillEntry[] = [];
  constructor(
    readonly maxItems = 3,
    readonly life = 5,
  ) {}

  push(text: string, tone: MessageTone = 'good'): void {
    for (const e of this.items) {
      if (e.text === text && e.age < 0.6) {
        e.age = 0;
        return;
      }
    }
    this.items.unshift({ text, tone, age: 0, merged: false });
    if (this.items.length > this.maxItems) this.items.length = this.maxItems;
  }

  /**
   * A mission's kill message ("SPLASH MIG-29", "VIPER 2: SPLASH SHAHED", "SA-6 SITE DESTROYED"): if the
   * HUD pushed a line for the same kill a moment ago, replace its text (the mission's wording is richer)
   * instead of adding a second line; else push it.
   */
  merge(text: string, tone: MessageTone): void {
    for (const e of this.items) {
      if (e.merged || e.age > 0.6) continue;
      e.merged = true;
      // keep the HUD's own "VIPER 2 DOWN" over a generic "FRIENDLY DOWN"
      if (!/^FRIENDLY (DOWN)?$/.test(text) && !text.startsWith('FRIENDLY DOWN')) {
        e.text = text;
        e.tone = tone;
      }
      return;
    }
    this.push(text, tone);
    this.items[0].merged = true;
  }

  update(dt: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      this.items[i].age += dt;
      if (this.items[i].age >= this.life) this.items.splice(i, 1);
    }
  }

  alpha(e: KillEntry): number {
    return Math.max(0, Math.min(1, e.age / 0.15, (this.life - e.age) / 0.6));
  }

  clear(): void {
    this.items.length = 0;
  }
}

/* ───────────────────────── Routing ───────────────────────── */

export type MessageRoute = 'centre' | 'kill' | 'title' | 'drop';

/**
 * Which HUD zone a 'hud:message' belongs to.
 *  - kill / loss reports go to the kill feed (top-right), never the centre of the screen
 *  - the mission title becomes a short banner in the top band
 *  - "AUTO GCAS" is dropped: the HUD shows its own AUTO GCAS cue (chevrons + warning band) while active
 */
export function classifyHudMessage(text: string, missionTitle: string | null): MessageRoute {
  const t = text.trim();
  if (missionTitle && t === missionTitle.toUpperCase()) return 'title';
  if (t === 'AUTO GCAS') return 'drop';
  if (/^SPLASH\b/.test(t) || /: SPLASH\b/.test(t)) return 'kill';
  if (/\bDESTROYED$/.test(t) && !/OBJECTIVE/.test(t)) return 'kill';
  if (/\bDOWN$/.test(t) || /\bDRIVEN OFF$/.test(t) || /\bSHOT DOWN\b/.test(t)) return 'kill';
  return 'centre';
}
