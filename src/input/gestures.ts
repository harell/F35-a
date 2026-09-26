/**
 * F35-A input — tap / drag / long-press classification (pure, unit-tested).
 *
 * A pointer on the free 3D view is a TAP when it is released quickly without travelling;
 * it becomes a DRAG (look-around) as soon as it travels more than the slop radius, and a
 * PRESS when held still for longer than the tap time (ignored — neither tap nor look).
 */

export interface GestureConfig {
  /** Max travel (CSS px) for a tap. */
  slop: number;
  /** Max duration (ms) for a tap. */
  tapMs: number;
  /** Max gap (ms) between two taps for a double-tap. */
  doubleTapMs: number;
  /** Max distance (CSS px) between two taps of a double-tap. */
  doubleTapSlop: number;
  /** Long-press threshold (ms) for buttons with a secondary action. */
  longPressMs: number;
}

export const GESTURES: GestureConfig = {
  slop: 12,
  tapMs: 320,
  doubleTapMs: 320,
  doubleTapSlop: 42,
  longPressMs: 480,
};

export type GestureKind = 'pending' | 'tap' | 'drag' | 'press';

/** Classify a pointer that is still down (`released` false) or has just been released. */
export function classifyGesture(dx: number, dy: number, durationMs: number, released: boolean, cfg: GestureConfig = GESTURES): GestureKind {
  if (dx * dx + dy * dy > cfg.slop * cfg.slop) return 'drag';
  if (!released) return durationMs > cfg.tapMs ? 'press' : 'pending';
  return durationMs <= cfg.tapMs ? 'tap' : 'press';
}

export interface TapRecord {
  x: number;
  y: number;
  /** ms timestamp. */
  t: number;
}

export function isDoubleTap(prev: TapRecord | null, tap: TapRecord, cfg: GestureConfig = GESTURES): boolean {
  if (!prev) return false;
  const dt = tap.t - prev.t;
  if (dt < 0 || dt > cfg.doubleTapMs) return false;
  return Math.hypot(tap.x - prev.x, tap.y - prev.y) <= cfg.doubleTapSlop;
}

/**
 * Look-around delta (rad) for a finger/mouse move of (dx, dy) CSS px.
 * Dragging the full screen height turns the view by ~1.6× the vertical FOV — enough to check six
 * with one swipe across the width. Swipe right = look right; swipe up = look up.
 */
export function lookDelta(dx: number, dy: number, viewportHeight: number, fovDeg: number, out: { yaw: number; pitch: number }): { yaw: number; pitch: number } {
  const k = ((fovDeg * Math.PI) / 180 / Math.max(1, viewportHeight)) * 1.6;
  out.yaw = dx * k;
  out.pitch = -dy * k;
  return out;
}
