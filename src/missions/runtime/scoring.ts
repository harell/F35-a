/**
 * F35-A — mission scoring and grading (pure functions, unit-tested).
 *
 * Score (points shown in the debrief):
 *   kills (air 100, SAM 150, ground 75) + objective bonuses (500 primary / 250 secondary)
 *   + time bonus (success only, up to 300) + accuracy bonus (up to 250)
 *   + stunt bonus (Harbour Bridge) − damage penalty (2 per HP lost) − 150 per friendly loss,
 *   all × difficulty.scoreMultiplier, floored at 0.
 *
 * Grade: from a 0..1 performance rating that is independent of mission size (objective
 * completion, share of spawned enemies killed, time, accuracy, damage, friendly losses) so an
 * 'S' is equally hard in a small training sortie and the finale. Failure caps the grade at
 * D (some primary objective done) or F.
 */
import type { MissionResult } from '../../core/contracts';

export const POINTS = {
  air: 100,
  sam: 150,
  ground: 75,
  primary: 500,
  secondary: 250,
  timeMax: 300,
  accuracyMax: 250,
  damagePerHp: 2,
  friendlyLoss: 150,
  /** Survival: points per wave cleared. */
  wave: 300,
} as const;

export type Grade = MissionResult['grade'];

export interface ScoreInput {
  success: boolean;
  /** Mission time (s). */
  time: number;
  /** Nominal completion time (s). */
  parTime: number;
  kills: { air: number; sam: number; ground: number };
  /** Hostile entities that existed during the mission (for the kill-share rating). */
  enemiesSpawned: number;
  /** Completed objective bonuses already summed (points). */
  objectiveBonus: number;
  primaryDone: number;
  primaryTotal: number;
  secondaryDone: number;
  secondaryTotal: number;
  shotsFired: number;
  hits: number;
  /** Player HP lost (0..100). */
  damageTaken: number;
  friendlyLosses: number;
  /** Extra stunt points (flying under the Harbour Bridge…). */
  bonus: number;
  scoreMultiplier: number;
  /** Survival mode: waves cleared (switches to wave-based grading). */
  waves?: number;
}

export interface ScoreOutput {
  score: number;
  grade: Grade;
  /** 0..1 performance rating behind the grade. */
  rating: number;
  accuracy: number;
  breakdown: { kills: number; objectives: number; time: number; accuracy: number; damage: number; friendly: number; bonus: number; waves: number };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 1 when finished at ≤ half the par time, falling linearly to 0 at 1.5 × par. */
export function timeFactor(time: number, parTime: number): number {
  const par = Math.max(60, parTime);
  return clamp01(1 - (time - par * 0.5) / par);
}

export function gradeForRating(rating: number): Grade {
  if (rating >= 0.9) return 'S';
  if (rating >= 0.78) return 'A';
  if (rating >= 0.64) return 'B';
  if (rating >= 0.5) return 'C';
  if (rating >= 0.35) return 'D';
  return 'F';
}

/** Survival grading by waves cleared. */
export function gradeForWaves(waves: number): Grade {
  if (waves >= 10) return 'S';
  if (waves >= 7) return 'A';
  if (waves >= 5) return 'B';
  if (waves >= 3) return 'C';
  if (waves >= 1) return 'D';
  return 'F';
}

const GRADE_ORDER: Grade[] = ['F', 'D', 'C', 'B', 'A', 'S'];
export function gradeRank(g: Grade): number {
  return GRADE_ORDER.indexOf(g);
}

export function computeScore(i: ScoreInput): ScoreOutput {
  const accuracy = i.shotsFired > 0 ? clamp01(i.hits / i.shotsFired) : 0;
  const killPts = i.kills.air * POINTS.air + i.kills.sam * POINTS.sam + i.kills.ground * POINTS.ground;
  const tf = timeFactor(i.time, i.parTime);
  const timePts = i.success ? Math.round(tf * POINTS.timeMax) : 0;
  const accPts = i.shotsFired >= 2 ? Math.round(accuracy * POINTS.accuracyMax) : 0;
  const dmg = Math.max(0, Math.min(100, i.damageTaken));
  const dmgPts = -Math.round(dmg * POINTS.damagePerHp);
  const friendlyPts = -i.friendlyLosses * POINTS.friendlyLoss;
  const wavePts = (i.waves ?? 0) * POINTS.wave;
  const raw = killPts + i.objectiveBonus + timePts + accPts + dmgPts + friendlyPts + i.bonus + wavePts;
  const score = Math.max(0, Math.round(raw * i.scoreMultiplier));

  // Size-independent performance rating.
  const totalKills = i.kills.air + i.kills.sam + i.kills.ground;
  const primaryShare = i.primaryTotal > 0 ? i.primaryDone / i.primaryTotal : 1;
  const secondaryShare = i.secondaryTotal > 0 ? i.secondaryDone / i.secondaryTotal : 1;
  const killShare = i.enemiesSpawned > 0 ? clamp01(totalKills / Math.max(1, i.enemiesSpawned * 0.6)) : 1;
  const accShare = i.shotsFired > 0 ? clamp01(accuracy / 0.7) : 1;
  let rating =
    0.45 * primaryShare +
    0.1 * secondaryShare +
    0.15 * killShare +
    0.1 * (i.success ? tf : 0) +
    0.1 * accShare +
    0.1 * (1 - dmg / 100);
  rating -= 0.06 * i.friendlyLosses;
  if (i.bonus > 0) rating += 0.03;
  rating = clamp01(rating);

  let grade: Grade;
  if (i.waves !== undefined) grade = gradeForWaves(i.waves);
  else {
    grade = gradeForRating(rating);
    if (!i.success) grade = i.primaryDone > 0 && gradeRank(grade) >= gradeRank('D') ? 'D' : 'F';
  }
  return {
    score,
    grade,
    rating,
    accuracy,
    breakdown: { kills: killPts, objectives: i.objectiveBonus, time: timePts, accuracy: accPts, damage: dmgPts, friendly: friendlyPts, bonus: i.bonus, waves: wavePts },
  };
}
