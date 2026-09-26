/**
 * Tap-to-designate support: every frame the HUD registers the screen positions of the symbols it drew
 * (target boxes, ground diamonds, SAM symbols). `pick(x, y)` returns the nearest one within a
 * thumb-sized radius. Taps are processed by Game before the next HUD frame, so the registry always
 * holds the symbols the player actually saw. Fixed-size typed arrays: no per-frame allocation.
 */

export const PICK_RADIUS = 44;

export class PickRegistry {
  private readonly xs: Float32Array;
  private readonly ys: Float32Array;
  private readonly ids: Int32Array;
  /** Symbol half-size (px): taps inside a big box win over a nearby small symbol. */
  private readonly rs: Float32Array;
  private n = 0;

  constructor(readonly capacity = 128) {
    this.xs = new Float32Array(capacity);
    this.ys = new Float32Array(capacity);
    this.ids = new Int32Array(capacity);
    this.rs = new Float32Array(capacity);
  }

  get count(): number {
    return this.n;
  }

  /** Start a new frame (forget last frame's symbols). */
  begin(): void {
    this.n = 0;
  }

  add(id: number, x: number, y: number, halfSize = 0): void {
    if (this.n >= this.capacity || !Number.isFinite(x) || !Number.isFinite(y)) return;
    // Same entity drawn twice (e.g. box + label) → keep the first.
    for (let i = 0; i < this.n; i++) if (this.ids[i] === id) return;
    this.xs[this.n] = x;
    this.ys[this.n] = y;
    this.ids[this.n] = id;
    this.rs[this.n] = halfSize;
    this.n++;
  }

  /** Nearest registered symbol within `radius` CSS px of (x, y), else null. */
  pick(x: number, y: number, radius = PICK_RADIUS): number | null {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.n; i++) {
      const d = Math.hypot(this.xs[i] - x, this.ys[i] - y);
      // distance to the symbol's edge (never negative) + a small bias toward the centre
      const eff = Math.max(0, d - this.rs[i]) + d * 0.05;
      if (d <= radius + this.rs[i] && eff < bestD) {
        bestD = eff;
        best = i;
      }
    }
    return best >= 0 ? this.ids[best] : null;
  }
}
