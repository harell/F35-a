/**
 * F35-A input — haptic feedback (Vibration API; silently unavailable on iOS Safari).
 * Rate-limited so held buttons / fast slider moves don't queue a buzz storm.
 */
export class Haptics {
  enabled = true;
  private last = 0;
  private readonly can = typeof navigator !== 'undefined' && 'vibrate' in navigator;

  /** Short tick for button presses. */
  tap(): void {
    this.buzz(8, 40);
  }

  /** Double tick for the AB detent / idle stop. */
  detent(): void {
    this.buzz([12, 40, 12], 90);
  }

  /** Heavier bump (e.g. MAX AB via double-tap). */
  bump(): void {
    this.buzz(22, 60);
  }

  private buzz(pattern: number | number[], minGapMs: number): void {
    if (!this.enabled || !this.can) return;
    const now = performance.now();
    if (now - this.last < minGapMs) return;
    this.last = now;
    try {
      navigator.vibrate(pattern);
    } catch {
      /* ignore */
    }
  }
}
