/**
 * F35-A — per-attempt variation (i2 review: campaign retries replayed identically, so a death at
 * 55 s was exactly repeatable). Every retry of a mission in this session salts the AI seed and
 * jitters where the hostile flights appear (within designed bounds: ±1.5 km, ±10° heading).
 * Attempt 0 is the designed mission. Terrain stays keyed to the theatre seed (Game uses def.seed).
 *
 * On by default in the browser; node test harnesses pass their own seeds, so it is off there
 * unless a test turns it on (setAttemptVariation).
 */
let enabled = typeof window !== 'undefined';
const attempts = new Map<string, number>();

export function setAttemptVariation(on: boolean): void {
  enabled = on;
  attempts.clear();
}

/** 0 on the first start of `missionId`, then 1, 2… on each retry (0 always when disabled). */
export function nextAttempt(missionId: string): number {
  if (!enabled) return 0;
  const n = attempts.get(missionId) ?? 0;
  attempts.set(missionId, n + 1);
  return n;
}

/** Seed for attempt `n` of a mission whose designed seed is `seed`. */
export function attemptSeed(seed: number, n: number): number {
  return (seed + n * 101) >>> 0;
}

/** Deterministic hash → [-1, 1) for spawn jitter (no allocation). */
export function jitter(seed: number, k: number): number {
  let t = (seed * 2654435761 + k * 0x9e3779b9) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
}

/** Max jitter of a hostile flight's appearance point (m) and heading (deg) on a retry. */
export const JITTER_POS = 1500;
export const JITTER_HDG = 10;
