/**
 * The difficulty a mission flies at (repo owner's decision, #68): training lessons always fly at
 * Pilot, everything else follows the player's setting. Used by Game.runSession, the briefing, the
 * debrief (tips, Retry on Recruit), the settings toast and the test bot.
 */
import type { MissionDef } from '../core/contracts';
import type { Difficulty } from '../core/types';

/** Training lessons always fly at this difficulty, whatever the setting (repo owner's decision, #68). */
export const TRAINING_DIFFICULTY: Difficulty = 'pilot';

/**
 * The difficulty a mission flies at whatever the player's setting, or null when it follows the
 * setting. Training is a lesson, not a wall: lessons always fly at Pilot, so a Veteran setting chosen
 * for the campaign doesn't turn the SAMs & Strike SA-6 into a 1-in-3 (playtest finding 4.3-b).
 */
export function fixedDifficulty(def: Pick<MissionDef, 'kind'>): Difficulty | null {
  return def.kind === 'training' ? TRAINING_DIFFICULTY : null;
}

/** The difficulty a mission actually flies at: fixedDifficulty(def), else the player's setting. */
export function missionDifficulty(def: Pick<MissionDef, 'kind'>, chosen: Difficulty): Difficulty {
  return fixedDifficulty(def) ?? chosen;
}
