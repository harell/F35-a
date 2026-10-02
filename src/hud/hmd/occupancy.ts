/**
 * Screen-space occupancy registry (pure, unit tested) — the HUD's text de-collision pass.
 *
 * Every frame the symbols that must never be covered by text (flight path marker, target designator box
 * and its labels, gun pipper, AIM-9X seeker circle, bomb pipper, the jet in external views) register
 * their rectangles first. Text placers then ask for a free spot (`freeY`) near their preferred position,
 * or check `hits` to skip / fade a label. Fixed-size typed arrays: no per-frame allocation.
 */

export class Occupancy {
  private readonly x0: Float32Array;
  private readonly y0: Float32Array;
  private readonly x1: Float32Array;
  private readonly y1: Float32Array;
  /** 1 = protected symbol (FPM, target box, pipper, jet), 0 = text / secondary label. */
  private readonly lvl: Uint8Array;
  private n = 0;

  constructor(readonly capacity = 96) {
    this.x0 = new Float32Array(capacity);
    this.y0 = new Float32Array(capacity);
    this.x1 = new Float32Array(capacity);
    this.y1 = new Float32Array(capacity);
    this.lvl = new Uint8Array(capacity);
  }

  get count(): number {
    return this.n;
  }

  clear(): void {
    this.n = 0;
  }

  /** Register a rectangle (any corner order). level 1 = protected symbol, 0 = text / label. */
  add(ax: number, ay: number, bx: number, by: number, level = 0): void {
    if (this.n >= this.capacity || !Number.isFinite(ax + ay + bx + by)) return;
    const i = this.n++;
    this.x0[i] = Math.min(ax, bx);
    this.x1[i] = Math.max(ax, bx);
    this.y0[i] = Math.min(ay, by);
    this.y1[i] = Math.max(ay, by);
    this.lvl[i] = level;
  }

  /** Register a centred box of half-size (hw, hh). */
  addBox(cx: number, cy: number, hw: number, hh: number, level = 0): void {
    this.add(cx - hw, cy - hh, cx + hw, cy + hh, level);
  }

  /**
   * Does [ax, bx] × [ay, by] overlap any registered rectangle of level `minLevel`..`maxLevel`?
   * (Level 2 = the flight path marker: protected from text, but the pitch ladder runs through it.)
   */
  hits(ax: number, ay: number, bx: number, by: number, minLevel = 0, maxLevel = 255): boolean {
    const l = Math.min(ax, bx);
    const r = Math.max(ax, bx);
    const t = Math.min(ay, by);
    const b = Math.max(ay, by);
    for (let i = 0; i < this.n; i++) {
      if (this.lvl[i] < minLevel || this.lvl[i] > maxLevel) continue;
      if (l < this.x1[i] && r > this.x0[i] && t < this.y1[i] && b > this.y0[i]) return true;
    }
    return false;
  }

  /**
   * Nearest top y in [yMin, yMax − h] (searching outward from `yPref`, preferring `prefer` first) at
   * which the rectangle [x0, x1] × [y, y + h] is free (in this registry and in `also`, if given). NaN
   * if there is none.
   */
  freeY(x0: number, x1: number, h: number, yPref: number, yMin: number, yMax: number, prefer: 'down' | 'up' = 'down', step = 4, also?: Occupancy): number {
    const lo = yMin;
    const hi = yMax - h;
    if (hi < lo) return NaN;
    const start = Math.max(lo, Math.min(hi, yPref));
    if (!this.hits(x0, start, x1, start + h) && !also?.hits(x0, start, x1, start + h)) return start;
    const maxK = Math.ceil((hi - lo) / step) + 1;
    for (let k = 1; k <= maxK; k++) {
      for (let s = 0; s < 2; s++) {
        const dir = (s === 0) === (prefer === 'down') ? 1 : -1;
        const y = start + dir * k * step;
        if (y < lo || y > hi) continue;
        if (!this.hits(x0, y, x1, y + h) && !also?.hits(x0, y, x1, y + h)) return y;
      }
    }
    return NaN;
  }
}
