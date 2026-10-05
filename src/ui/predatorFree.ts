/**
 * F35-A UI — the Predator Free 2050 day counter on the main menu (#211). Pure: no DOM, so it's
 * unit-tested in tests/ui-predator-free.test.ts.
 */

/** 1 January 2050, 00:00 New Zealand time (NZDT, UTC+13): the goal's deadline as one fixed instant. */
export const PREDATOR_FREE_MS = Date.UTC(2049, 11, 31, 11, 0, 0);

const DAY_MS = 86_400_000;

/**
 * Whole days left until Predator Free 2050, rounded down. Counted from the fixed UTC instant, never
 * the device's time zone, so every player sees the same number. 0 or less: the deadline has come
 * (the menu hides the line).
 */
export function daysToPredatorFree(nowMs: number): number {
  return Math.floor((PREDATOR_FREE_MS - nowMs) / DAY_MS);
}
