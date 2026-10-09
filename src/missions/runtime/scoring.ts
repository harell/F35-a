/**
 * F35-A — mission scoring and grading (pure functions, unit-tested).
 *
 * Score (points shown in the debrief):
 *   kills (air 100, SAM 150, ground 75) + objective bonuses (500 primary / 250 secondary)
 *   + time bonus (success only, up to 300) + accuracy bonus (up to 250)
 *   + stunt bonus (Harbour Bridge) − damage penalty (2 per HP lost) − 150 per friendly loss
 *   − 500 per civil airliner or ship the player destroyed − 100 per home the player's bombs hit
 *   (missions that count them, MissionScript.collateral),
 *   all × difficulty.scoreMultiplier, floored at 0.
 *
 * Grade: from a 0..1 performance rating that is independent of mission size (objective
 * completion, share of spawned enemies killed, time, accuracy, damage, friendly losses) so an
 * 'S' is equally hard in a small training sortie and the finale. Failure caps the grade at
 * D (some primary objective done) or F.
 *
 * Player contribution: objectives completed mostly by the player's own flight (Viper 2…) earn
 * less. The player's kill share = player kills / (player kills + flight kills); below 50 % the
 * objective term is scaled down, and the grade is capped at B (share < 50 %) or C (< 25 %), so
 * S and A mean "you won this fight", not "your wingman did".
 *
 * No fight, no credit: a win where hostiles existed but the player hit nothing and killed nothing
 * (the enemy was only driven off, or someone else did the killing) rates a share of 0 and an
 * accuracy of 0, so it caps at C (playtest 2026-10-02, 2.3-b: a parked Defend win graded A).
 */
import type { MissionDef, MissionResult } from '../../core/contracts';

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
  /** Civil airliner or ship destroyed by the player. */
  civilian: 500,
  /** A home inside the damage ring of one of the player's bombs (runtime/collateral.ts). */
  home: 100,
} as const;

/** Rating lost per home hit: a JDAM on a street (four or five homes) costs about a grade. */
export const HOME_RATING_PENALTY = 0.03;

export type Grade = MissionResult['grade'];

/** Par time (s) when a mission sets neither `script.parTime` nor `timeLimit`. */
export const DEFAULT_PAR = 480;

/** A mission's nominal completion time (s): what the time bonus and the debrief's time tip measure against. */
export function parTimeFor(def: Pick<MissionDef, 'script' | 'timeLimit'>): number {
  return def.script.parTime ?? def.timeLimit ?? DEFAULT_PAR;
}

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
  /** Neutral civil traffic (airliners + ships) the player destroyed. */
  civilianKills?: number;
  /** Homes the player's bombs hit (missions that count them). */
  homesHit?: number;
  /** Extra stunt points (flying under the Harbour Bridge…). */
  bonus: number;
  scoreMultiplier: number;
  /** Hostiles killed by the player's own flight (AI wingmen); 0/undefined = the player fought alone. */
  flightKills?: number;
}

export interface ScoreOutput {
  score: number;
  grade: Grade;
  /** 0..1 performance rating behind the grade. */
  rating: number;
  accuracy: number;
  /**
   * Player kills / (player kills + flight kills); 1 when nobody scored, except 0 when hostiles
   * existed and the player neither hit nor killed anything (see noFight()).
   */
  playerShare: number;
  breakdown: { kills: number; objectives: number; time: number; accuracy: number; damage: number; friendly: number; bonus: number };
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

const GRADE_ORDER: Grade[] = ['F', 'D', 'C', 'B', 'A', 'S'];
export function gradeRank(g: Grade): number {
  return GRADE_ORDER.indexOf(g);
}

/** Best grade reachable with this share of the flight's kills (S/A need ≥ 50 %). */
export function contributionCap(playerShare: number): Grade {
  if (playerShare < 0.25) return 'C';
  if (playerShare < 0.5) return 'B';
  return 'S';
}

/**
 * Hostiles existed but the player took no part in the fight: no hit on a hostile and no kill.
 * Whatever won the mission (bandits driven off, the wingman's kills), it wasn't the player. Counts
 * hits, not shots: one gun burst into the air is a shot, and must not buy back the grade (#64 review).
 */
export function noFight(i: Pick<ScoreInput, 'enemiesSpawned' | 'hits' | 'kills'>): boolean {
  return i.enemiesSpawned > 0 && i.hits <= 0 && i.kills.air + i.kills.sam + i.kills.ground <= 0;
}

export function computeScore(i: ScoreInput): ScoreOutput {
  const accuracy = i.shotsFired > 0 ? clamp01(i.hits / i.shotsFired) : 0;
  const killPts = i.kills.air * POINTS.air + i.kills.sam * POINTS.sam + i.kills.ground * POINTS.ground;
  const tf = timeFactor(i.time, i.parTime);
  const timePts = i.success ? Math.round(tf * POINTS.timeMax) : 0;
  const accPts = i.shotsFired >= 2 ? Math.round(accuracy * POINTS.accuracyMax) : 0;
  const dmg = Math.max(0, Math.min(100, i.damageTaken));
  const dmgPts = -Math.round(dmg * POINTS.damagePerHp);
  const friendlyPts = -i.friendlyLosses * POINTS.friendlyLoss - (i.civilianKills ?? 0) * POINTS.civilian - (i.homesHit ?? 0) * POINTS.home;
  const raw = killPts + i.objectiveBonus + timePts + accPts + dmgPts + friendlyPts + i.bonus;
  const score = Math.max(0, Math.round(raw * i.scoreMultiplier));

  // Size-independent performance rating.
  const totalKills = i.kills.air + i.kills.sam + i.kills.ground;
  const flightKills = Math.max(0, i.flightKills ?? 0);
  const idle = noFight(i);
  const playerShare = idle ? 0 : totalKills + flightKills > 0 ? totalKills / (totalKills + flightKills) : 1;
  const contrib = clamp01(playerShare / 0.5);
  const primaryShare = (i.primaryTotal > 0 ? i.primaryDone / i.primaryTotal : 1) * (0.55 + 0.45 * contrib);
  const secondaryShare = i.secondaryTotal > 0 ? i.secondaryDone / i.secondaryTotal : 1;
  const killShare = i.enemiesSpawned > 0 ? clamp01(totalKills / Math.max(1, i.enemiesSpawned * 0.6)) : 1;
  const accShare = i.shotsFired > 0 ? clamp01(accuracy / 0.7) : idle ? 0 : 1;
  let rating =
    0.45 * primaryShare +
    0.1 * secondaryShare +
    0.15 * killShare +
    0.1 * (i.success ? tf : 0) +
    0.1 * accShare +
    0.1 * (1 - dmg / 100);
  rating -= 0.06 * i.friendlyLosses + 0.15 * (i.civilianKills ?? 0) + HOME_RATING_PENALTY * (i.homesHit ?? 0);
  if (i.bonus > 0) rating += 0.03;
  rating = clamp01(rating);

  let grade = gradeForRating(rating);
  if (!i.success) grade = i.primaryDone > 0 && gradeRank(grade) >= gradeRank('D') ? 'D' : 'F';
  else {
    const cap = contributionCap(playerShare);
    if (gradeRank(grade) > gradeRank(cap)) grade = cap;
  }
  return {
    score,
    grade,
    rating,
    accuracy,
    playerShare,
    breakdown: { kills: killPts, objectives: i.objectiveBonus, time: timePts, accuracy: accPts, damage: dmgPts, friendly: friendlyPts, bonus: i.bonus },
  };
}
