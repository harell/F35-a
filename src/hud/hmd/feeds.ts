/**
 * Timed text feeds for the HMD — pure logic, unit tested (no DOM).
 *
 *  RadioQueue    radio subtitles ("[DARKSTAR] Bandits BRAA 045/40…"), one at a time, queued,
 *                ~4 s each (length dependent, faster when a backlog builds), priority calls jump the queue.
 *  MessageQueue  centre-screen 'hud:message' texts with tones, up to 2 stacked, fade out.
 *  KillFeed      "SPLASH MIG-29" / "SA-6 DESTROYED" lines, newest first, ~5 s each.
 */
import type { Team } from '../../core/types';

/* ───────────────────────── Radio subtitles ───────────────────────── */

export interface Subtitle {
  from: string;
  text: string;
  priority: number;
  team: Team | undefined;
}

export class RadioQueue {
  current: Subtitle | null = null;
  /** Seconds the current subtitle has been shown. */
  age = 0;
  /** How long the current subtitle stays up (s). */
  duration = 0;
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
    }
  }

  update(dt: number): void {
    if (!this.current) return;
    this.age += dt;
    if (this.age >= this.duration) this.next();
  }

  /** 0..1 opacity: quick fade in / out. */
  get alpha(): number {
    if (!this.current) return 0;
    const fin = Math.min(1, this.age / 0.15);
    const fout = Math.min(1, (this.duration - this.age) / 0.3);
    return Math.max(0, Math.min(fin, fout));
  }

  clear(): void {
    this.queue.length = 0;
    this.current = null;
    this.age = 0;
  }

  private next(): void {
    this.current = this.queue.shift() ?? null;
    this.age = 0;
    this.duration = this.current ? this.durationFor(this.current.text, this.queue.length) : 0;
  }
}

/* ───────────────────────── Centre messages ───────────────────────── */

export type MessageTone = 'info' | 'good' | 'bad' | 'warn';

export interface HudMessage {
  text: string;
  tone: MessageTone;
  age: number;
  duration: number;
}

export class MessageQueue {
  readonly items: HudMessage[] = [];
  constructor(readonly maxVisible = 2) {}

  push(text: string, tone: MessageTone = 'info', duration = 2.5): void {
    for (const m of this.items) {
      if (m.text === text) {
        // refresh instead of stacking duplicates
        m.age = Math.min(m.age, 0.2);
        m.duration = Math.max(m.duration, duration);
        m.tone = tone;
        return;
      }
    }
    this.items.unshift({ text, tone, age: 0, duration: Math.max(0.5, duration) });
    if (this.items.length > this.maxVisible) this.items.length = this.maxVisible;
  }

  update(dt: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const m = this.items[i];
      m.age += dt;
      if (m.age >= m.duration) this.items.splice(i, 1);
    }
  }

  static alpha(m: HudMessage): number {
    return Math.max(0, Math.min(1, m.age / 0.12, (m.duration - m.age) / 0.45));
  }

  clear(): void {
    this.items.length = 0;
  }
}

/* ───────────────────────── Kill feed ───────────────────────── */

export interface KillEntry {
  text: string;
  tone: MessageTone;
  age: number;
}

export class KillFeed {
  readonly items: KillEntry[] = [];
  constructor(
    readonly maxItems = 4,
    readonly life = 5,
  ) {}

  push(text: string, tone: MessageTone = 'good'): void {
    this.items.unshift({ text, tone, age: 0 });
    if (this.items.length > this.maxItems) this.items.length = this.maxItems;
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
