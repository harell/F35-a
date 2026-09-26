/**
 * F35-A audio — shared, always-running noise sources for the continuous voices.
 *
 * Continuous voices (engines, wind, motors…) don't own noise sources; they tap one of a few
 * shared "noise sets" and shape it with their own filters. Two decorrelated sets are enough
 * (player/cockpit vs. other aircraft) and keep the node count low on phones.
 */
import type { SynthBuffers } from '../core/buffers';

export interface NoiseSet {
  white: AudioNode;
  pink: AudioNode;
  brown: AudioNode;
  crackle: AudioNode;
}

export class NoiseBank {
  readonly sets: NoiseSet[] = [];
  private readonly sources: AudioBufferSourceNode[] = [];

  constructor(ctx: AudioContext, buffers: SynthBuffers, count = 2) {
    const start = ctx.currentTime + 0.01;
    for (let i = 0; i < count; i++) {
      const mk = (buf: AudioBuffer, rate: number) => {
        const s = ctx.createBufferSource();
        s.buffer = buf;
        s.loop = true;
        s.playbackRate.value = rate;
        s.start(start, (buf.duration * (0.13 + 0.37 * i)) % buf.duration);
        this.sources.push(s);
        return s;
      };
      // slightly different rates between sets → decorrelated even though buffers are shared
      const r = 1 + i * 0.013;
      this.sets.push({ white: mk(buffers.white, r), pink: mk(buffers.pink, r), brown: mk(buffers.brown, r), crackle: mk(buffers.crackle, r) });
    }
  }

  set(i: number): NoiseSet {
    return this.sets[Math.min(i, this.sets.length - 1)];
  }

  dispose(): void {
    for (const s of this.sources) {
      try {
        s.stop();
        s.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.sources.length = 0;
    this.sets.length = 0;
  }
}
