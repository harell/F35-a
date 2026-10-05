/**
 * F35-A — targets too small to track on the move (g03's stoat, #200): the GBU-53/B's seeker and the
 * launcher's datalink pick a ground target smaller than SMALL_TARGET_RADIUS out of the ground clutter
 * only while it stands still (guidance.ts smallTargetGuidance; missile.ts never leads it at launch).
 */

/** Radius (m) below which a ground target is a small one. */
export const SMALL_TARGET_RADIUS = 0.5;
/** Speed (m/s) under which a small target counts as standing still. */
export const STILL_SPEED = 0.5;

/** A ground target too small for a bomb to track on the move. */
export function isSmallGround(t: { kind: string; radius: number }): boolean {
  return t.kind === 'ground' && t.radius < SMALL_TARGET_RADIUS;
}
