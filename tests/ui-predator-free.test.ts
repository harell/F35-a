/**
 * The main menu's Predator Free 2050 day counter (#211): whole days to 1 January 2050, 00:00 NZ time.
 */
import { describe, expect, it } from 'vitest';
import { PREDATOR_FREE_MS, daysToPredatorFree } from '../src/ui/predatorFree';

describe('daysToPredatorFree', () => {
  it('counts to 1 January 2050 00:00 NZDT, a fixed UTC instant', () => {
    expect(new Date(PREDATOR_FREE_MS).toISOString()).toBe('2049-12-31T11:00:00.000Z');
  });

  it('gives whole days, rounded down, for a fixed now', () => {
    // 6 October 2026 02:30 NZDT = 5 October 13:30 UTC
    expect(daysToPredatorFree(Date.UTC(2026, 9, 5, 13, 30))).toBe(8487);
    // exactly one day before, and one minute short of a whole day
    expect(daysToPredatorFree(PREDATOR_FREE_MS - 86_400_000)).toBe(1);
    expect(daysToPredatorFree(PREDATOR_FREE_MS - 86_400_000 + 60_000)).toBe(0);
  });

  it('gives 0 in the last minute before the deadline, and less after it', () => {
    expect(daysToPredatorFree(PREDATOR_FREE_MS - 60_000)).toBe(0);
    expect(daysToPredatorFree(PREDATOR_FREE_MS)).toBe(0);
    expect(daysToPredatorFree(PREDATOR_FREE_MS + 2 * 86_400_000)).toBeLessThan(0);
  });
});
