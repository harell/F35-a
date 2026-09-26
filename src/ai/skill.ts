/**
 * F35-A — AI pilot skill model.
 *
 * Combines the global difficulty (world.difficulty: aiSkill, aiReactionTime, aiMaxG) with the
 * per-spawn `opts.skill` (0..1) handed to createAiBrain by the mission. The blend is additive
 * (level = ½·spawn + ½·difficulty) because missions already default a group's skill to
 * difficulty.aiSkill — so a default group flies exactly at the difficulty's level, while an
 * explicit "ace squadron" (skill 0.9) or "rookie flight" (0.2) still shifts it on any
 * difficulty. Friendly (blue) AI is driven by its own spawn skill so wingmen are useful on
 * every difficulty.
 *
 * Every tactical knob the brains use lives here so tuning is one place.
 */
import type { DifficultyParams, Team } from '../core/types';
import { AIRCRAFT_PERF } from '../sim/flight/aircraftData';
import type { AircraftType } from '../core/types';
import { clampN } from './geom';

export interface PilotSkill {
  /** Overall 0..1 (0 = hopeless rookie, 1 = ace). */
  level: number;
  /** Seconds before reacting to a new threat / opportunity (missile launch, new bandit). */
  reaction: number;
  /** Max g the pilot is willing to pull. */
  maxG: number;
  /** Gun aim error (rad, 1-sigma, re-rolled every ~0.5 s). */
  aimSigma: number;
  /** Opens fire when the pipper is within this angle of the target (rad). */
  gunCone: number;
  /** Max gun firing range (m) — aces hold fire until close, rookies spray from far out. */
  gunRange: number;
  /** Energy-management quality 0..1: corner-speed discipline, yo-yos, AB use. */
  energy: number;
  /** Defensive quality 0..1: beam/notch accuracy, countermeasure timing, last-ditch timing. */
  defense: number;
  /** Target re-evaluation interval (s). */
  retargetInterval: number;
  /** Minimum height above ground the pilot is comfortable with (m). */
  minAgl: number;
  /** Visual detection range for bandits (m) — eyeballs find even a stealth jet close in. */
  visualRange: number;
}

/**
 * Derive a pilot's skill for an aircraft. `spawnSkill` is the mission's 0..1 value.
 */
export function deriveSkill(diff: DifficultyParams, spawnSkill: number, team: Team, type: AircraftType): PilotSkill {
  const s = clampN(Number.isFinite(spawnSkill) ? spawnSkill : 0.5, 0, 1);
  let level: number;
  let reaction: number;
  let maxG: number;
  if (team === 'blue') {
    // Friendly wingmen: competent regardless of difficulty (they must help, not hinder).
    level = clampN(0.45 + 0.5 * s, 0.3, 0.95);
    reaction = 1.2 - 0.7 * s;
    maxG = 7 + 1.5 * s;
  } else {
    level = clampN(0.5 * s + 0.5 * diff.aiSkill, 0.05, 1);
    reaction = diff.aiReactionTime * (1.3 - 0.6 * s);
    maxG = diff.aiMaxG + (s - diff.aiSkill) * 1.5;
  }
  const perf = AIRCRAFT_PERF[type];
  maxG = clampN(maxG, 2, perf.maxG);
  return {
    level,
    reaction: Math.max(0.25, reaction),
    maxG,
    aimSigma: 0.0025 + 0.02 * (1 - level) * (1 - level),
    gunCone: 0.012 + 0.035 * (1 - level),
    gunRange: 950 - 350 * level,
    energy: level,
    defense: clampN(level * 1.05, 0, 1),
    retargetInterval: 2.5 - 1.5 * level,
    minAgl: 220 - 110 * level,
    visualRange: 2_500 + 4_000 * level,
  };
}
