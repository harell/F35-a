/**
 * Tap-to-designate support: every frame the HUD registers the screen positions of the symbols it drew
 * (target boxes, ground diamonds, SAM symbols). `pick(x, y)` returns the nearest one within a
 * thumb-sized radius. Taps are processed by Game before the next HUD frame, so the registry always
 * holds the symbols the player actually saw. Fixed-size typed arrays: no per-frame allocation.
 *
 * Clusters (a drone swarm at range: ten boxes inside a few px): a tap inside several overlapping
 * boxes picks the one nearest the tap that none of our missiles is flying at; tapping the same spot
 * again within CYCLE_TIME steps through the rest of the cluster, one box per tap.
 */

export const PICK_RADIUS = 44;
/** A tap within this time (s) and distance (px) of the last one is "again": it cycles the cluster. */
export const CYCLE_TIME = 1.5;
export const CYCLE_DIST = 24;
/** Slop (px) around a box for "the tap is inside it". */
const BOX_SLOP = 6;

export class PickRegistry {
  private readonly xs: Float32Array;
  private readonly ys: Float32Array;
  private readonly ids: Int32Array;
  /** Symbol half-size (px): taps inside a big box win over a nearby small symbol. */
  private readonly rs: Float32Array;
  private n = 0;
  /** Scratch: indices of the boxes the tap is inside. */
  private readonly cluster: Int32Array;
  /** Ids already picked in the current run of taps on one cluster. */
  private readonly seen: Int32Array;
  private nSeen = 0;
  private lastX = NaN;
  private lastY = NaN;
  private lastT = -Infinity;

  constructor(readonly capacity = 128) {
    this.xs = new Float32Array(capacity);
    this.ys = new Float32Array(capacity);
    this.ids = new Int32Array(capacity);
    this.rs = new Float32Array(capacity);
    this.cluster = new Int32Array(capacity);
    this.seen = new Int32Array(capacity);
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

  /**
   * Nearest registered symbol within `radius` CSS px of (x, y), else null. Inside overlapping boxes:
   * see the header (`now` in s, `engaged(id)`: one of our missiles is flying at it).
   */
  pick(x: number, y: number, radius = PICK_RADIUS, now = 0, engaged?: (id: number) => boolean): number | null {
    const again = now - this.lastT <= CYCLE_TIME && Math.hypot(x - this.lastX, y - this.lastY) <= CYCLE_DIST;
    this.lastX = x;
    this.lastY = y;
    this.lastT = now;
    let k = 0;
    for (let i = 0; i < this.n; i++) {
      const r = this.rs[i] + BOX_SLOP;
      if (this.rs[i] > 0 && Math.abs(this.xs[i] - x) <= r && Math.abs(this.ys[i] - y) <= r) this.cluster[k++] = i;
    }
    if (k >= 2) {
      if (!again) this.nSeen = 0;
      let i = this.clusterPick(k, x, y, engaged, true);
      if (i < 0) {
        this.nSeen = 0; // every box picked once: round again
        i = this.clusterPick(k, x, y, engaged, false);
      }
      this.seen[this.nSeen++] = this.ids[i];
      return this.ids[i];
    }
    this.nSeen = 0;
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

  private wasSeen(id: number): boolean {
    for (let j = 0; j < this.nSeen; j++) if (this.seen[j] === id) return true;
    return false;
  }

  /** Cluster box to pick (index): not engaged first, then nearest the tap; -1 if all were picked. */
  private clusterPick(k: number, x: number, y: number, engaged: ((id: number) => boolean) | undefined, skipSeen: boolean): number {
    let best = -1;
    let bestKey = Infinity;
    for (let j = 0; j < k; j++) {
      const i = this.cluster[j];
      if (skipSeen && this.wasSeen(this.ids[i])) continue;
      const key = Math.hypot(this.xs[i] - x, this.ys[i] - y) + (engaged?.(this.ids[i]) ? 1e6 : 0);
      if (key < bestKey) {
        bestKey = key;
        best = i;
      }
    }
    return best;
  }
}
