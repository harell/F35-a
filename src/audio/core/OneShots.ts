/**
 * F35-A audio — one-shot voice pool.
 *
 * Every transient sound (explosion, click, launch, impact…) is a short-lived node group that
 * ends in one output GainNode. The pool caps simultaneous one-shots (quality-scaled, ~16) and
 * steals the oldest lowest-priority one when full, fading it out in ~15 ms.
 */

export interface OneShot {
  /** Connect the recipe's nodes here. */
  readonly out: GainNode;
  /** Absolute end time (context seconds). */
  end: number;
  priority: number;
  readonly sources: AudioScheduledSourceNode[];
  /** Head of the chain (out → [lowpass] → [pan] → dest) — disconnected when the shot ends. */
  readonly nodes: AudioNode[];
  done: boolean;
}

export interface SpatialShot {
  /** Linear gain applied at the output. */
  gain: number;
  /** −1..1 */
  pan: number;
  /** Low-pass cutoff (Hz); ≥ 16 kHz skips the filter. */
  cutoff: number;
  /** Reverb send amount 0..1 (ignored when reverb is off). */
  reverb?: number;
}

export class OneShotPool {
  private readonly active: OneShot[] = [];

  constructor(
    private readonly ctx: AudioContext,
    public max = 16,
    private readonly reverb: () => AudioNode | null = () => null,
  ) {}

  get count(): number {
    return this.active.length;
  }

  /**
   * Start a one-shot routed to `dest`, lasting at least `duration` s from `when` (recipes
   * extend `end` as they add longer layers).
   */
  begin(dest: AudioNode, when: number, duration: number, priority = 0, spatial?: SpatialShot): OneShot {
    const ctx = this.ctx;
    this.prune(ctx.currentTime);
    if (this.active.length >= this.max) this.steal(priority);
    const out = ctx.createGain();
    out.gain.value = spatial ? spatial.gain : 1;
    const nodes: AudioNode[] = [out];
    let tail: AudioNode = out;
    if (spatial) {
      if (spatial.cutoff < 16000) {
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = Math.max(60, spatial.cutoff);
        lp.Q.value = 0.5;
        tail.connect(lp);
        tail = lp;
        nodes.push(lp);
      }
      if (Math.abs(spatial.pan) > 0.02 && typeof ctx.createStereoPanner === 'function') {
        const p = ctx.createStereoPanner();
        p.pan.value = Math.max(-1, Math.min(1, spatial.pan));
        tail.connect(p);
        tail = p;
        nodes.push(p);
      }
      const rv = spatial.reverb ? this.reverb() : null;
      if (rv && spatial.reverb) {
        const send = ctx.createGain();
        send.gain.value = spatial.reverb;
        tail.connect(send);
        send.connect(rv);
        nodes.push(send);
      }
    }
    tail.connect(dest);
    const shot: OneShot = { out, end: when + duration, priority, sources: [], nodes, done: false };
    this.active.push(shot);
    return shot;
  }

  /** Register a source so stealing / stopAll can stop it. */
  track<T extends AudioScheduledSourceNode>(shot: OneShot, src: T): T {
    shot.sources.push(src);
    return src;
  }

  /** Drop finished shots (disconnect so the nodes can be collected). */
  prune(now: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const s = this.active[i];
      if (now > s.end + 0.05) {
        this.release(s);
        this.active.splice(i, 1);
      }
    }
  }

  private steal(priority: number): void {
    let victim = -1;
    for (let i = 0; i < this.active.length; i++) {
      const s = this.active[i];
      if (s.priority > priority) continue;
      if (victim < 0 || s.priority < this.active[victim].priority || (s.priority === this.active[victim].priority && s.end < this.active[victim].end)) victim = i;
    }
    if (victim < 0) victim = 0;
    const s = this.active[victim];
    this.active.splice(victim, 1);
    this.fadeAndStop(s, 0.015);
  }

  private fadeAndStop(s: OneShot, tc: number): void {
    const now = this.ctx.currentTime;
    try {
      s.out.gain.cancelScheduledValues(now);
      s.out.gain.setTargetAtTime(0, now, tc);
      for (const src of s.sources) src.stop(now + tc * 5);
    } catch {
      /* already stopped */
    }
    setTimeout(() => this.release(s), 200);
  }

  private release(s: OneShot): void {
    if (s.done) return;
    s.done = true;
    for (const n of s.nodes) {
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
  }

  /** Stop everything now (mission end / restart). */
  stopAll(): void {
    const list = this.active.splice(0);
    for (const s of list) this.fadeAndStop(s, 0.01);
  }
}
