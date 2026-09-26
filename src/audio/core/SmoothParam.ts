/**
 * F35-A audio — AudioParam helper for continuous sounds: schedules a setTargetAtTime only
 * when the value really changed, so per-frame updates don't flood the automation timeline.
 */
export class SmoothParam {
  private last: number;

  constructor(
    readonly param: AudioParam,
    initial: number,
    /** Absolute change that is ignored. */
    private readonly absEps = 1e-4,
    /** Relative change that is ignored. */
    private readonly relEps = 0.004,
  ) {
    this.last = initial;
    param.value = initial;
  }

  get value(): number {
    return this.last;
  }

  /** Glide to `v` with time constant `tc` (s). */
  set(v: number, now: number, tc = 0.05): void {
    if (!Number.isFinite(v)) return;
    const d = Math.abs(v - this.last);
    if (d <= this.absEps || d <= this.relEps * Math.abs(this.last)) return;
    this.last = v;
    this.param.setTargetAtTime(v, now, tc);
  }

  /** Jump immediately (cancels pending glides). */
  jump(v: number, now: number): void {
    this.last = v;
    this.param.cancelScheduledValues(now);
    this.param.setValueAtTime(v, now);
  }
}

/** Frequency params use a relative epsilon (~0.2 %) — below the pitch JND. */
export function freqParam(param: AudioParam, initial: number): SmoothParam {
  return new SmoothParam(param, initial, 0.05, 0.002);
}

/** Gain params: tiny absolute epsilon so fades reach true silence. */
export function gainParam(param: AudioParam, initial: number): SmoothParam {
  return new SmoothParam(param, initial, 2e-4, 0.01);
}
