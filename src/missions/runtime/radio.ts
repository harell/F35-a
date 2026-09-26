/**
 * F35-A — radio queue: spaces out radio calls so subtitles/voice clips don't pile up.
 *  - higher priority calls jump the queue; priority ≥ 4 (urgent: "Eject!", "Friendly down!")
 *    interrupts whatever is playing
 *  - identical calls already waiting are dropped (no "Good kill" stutter)
 *  - stale calls expire (an old picture call is worse than none)
 *  - on overflow the oldest lowest-priority call is dropped
 */
import type { EventBus } from '../../core/events';
import type { Team, VoiceId } from '../../core/types';

export interface RadioMsg {
  from: string;
  text: string;
  voice?: VoiceId;
  priority?: number;
  team?: Team;
  /** Seconds the call may wait in the queue before it is dropped (default 10–16 by priority). */
  ttl?: number;
}

interface Queued extends RadioMsg {
  expires: number;
}

const MAX_QUEUE = 8;
export const URGENT_PRIORITY = 4;

/** Air time of a call (s): time to read the subtitle. */
export function airTime(text: string): number {
  return Math.min(4.5, 1.0 + text.length * 0.035);
}

export class RadioQueue {
  private readonly queue: Queued[] = [];
  private nextTime = 0;
  private now = 0;

  constructor(private readonly events: EventBus) {}

  get length(): number {
    return this.queue.length;
  }

  /** Queue a call (plays on the next update if the channel is free). */
  push(msg: RadioMsg): void {
    const p = msg.priority ?? 1;
    for (const q of this.queue) if (q.text === msg.text && q.from === msg.from) return;
    const ttl = msg.ttl ?? (p >= 3 ? 10 : p === 2 ? 14 : 16);
    const item: Queued = { ...msg, expires: this.now + ttl };
    let i = this.queue.length;
    while (i > 0 && (this.queue[i - 1].priority ?? 1) < p) i--;
    this.queue.splice(i, 0, item);
    if (p >= URGENT_PRIORITY) this.nextTime = Math.min(this.nextTime, this.now);
    if (this.queue.length > MAX_QUEUE) {
      let worst = 0;
      for (let k = 1; k < this.queue.length; k++) if ((this.queue[k].priority ?? 1) < (this.queue[worst].priority ?? 1)) worst = k;
      this.queue.splice(worst, 1);
    }
  }

  /** Emit the next call when the channel is free. */
  update(time: number): void {
    this.now = time;
    if (this.queue.length === 0 || time < this.nextTime) return;
    let msg: Queued | undefined;
    while ((msg = this.queue.shift()) && msg.expires < time) {
      /* drop stale call */
    }
    if (!msg) return;
    this.events.emit('radio', { from: msg.from, text: msg.text, voice: msg.voice, priority: msg.priority ?? 1, team: msg.team ?? 'blue' });
    this.nextTime = time + airTime(msg.text);
  }

  /** Drop everything still queued. */
  clear(): void {
    this.queue.length = 0;
  }
}
