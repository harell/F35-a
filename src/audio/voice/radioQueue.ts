/**
 * F35-A audio — radio message queue (pure logic, unit-tested).
 *
 * 'radio' events with a voice clip are queued and played one at a time (key-up click →
 * clip → squelch tail → gap). The queue is short: urgent calls jump ahead, stale chatter
 * expires, identical clips are not stacked.
 */
import type { VoiceId } from '../../core/types';

export interface RadioItem {
  voice: VoiceId;
  priority: number;
  /** Time the message was queued (s). */
  time: number;
}

export class RadioQueue {
  private items: RadioItem[] = [];

  constructor(
    readonly capacity = 4,
    /** Seconds a normal-priority message may wait before it is dropped. */
    readonly maxAge = 6,
    /** Priority ≥ this waits up to 3 × maxAge. */
    readonly urgentPriority = 3,
  ) {}

  get length(): number {
    return this.items.length;
  }

  /** Queue a message. Returns false if it was dropped (duplicate, or queue full of more important calls). */
  push(voice: VoiceId, priority: number, time: number): boolean {
    for (const it of this.items) {
      if (it.voice === voice) {
        // same clip already waiting: keep one, upgrade its priority/freshness
        it.priority = Math.max(it.priority, priority);
        it.time = time;
        return false;
      }
    }
    if (this.items.length >= this.capacity) {
      // evict the least important (oldest among equals) if the new one beats it
      let worst = 0;
      for (let i = 1; i < this.items.length; i++) {
        const a = this.items[i];
        const w = this.items[worst];
        if (a.priority < w.priority || (a.priority === w.priority && a.time < w.time)) worst = i;
      }
      if (this.items[worst].priority >= priority) return false;
      this.items.splice(worst, 1);
    }
    this.items.push({ voice, priority, time });
    return true;
  }

  /** Remove and return the next message to play (highest priority, then oldest); drops expired ones. */
  next(now: number): RadioItem | null {
    this.expire(now);
    if (!this.items.length) return null;
    let best = 0;
    for (let i = 1; i < this.items.length; i++) {
      const a = this.items[i];
      const b = this.items[best];
      if (a.priority > b.priority || (a.priority === b.priority && a.time < b.time)) best = i;
    }
    return this.items.splice(best, 1)[0];
  }

  expire(now: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      const age = it.priority >= this.urgentPriority ? this.maxAge * 3 : this.maxAge;
      if (now - it.time > age) this.items.splice(i, 1);
    }
  }

  clear(): void {
    this.items.length = 0;
  }
}
