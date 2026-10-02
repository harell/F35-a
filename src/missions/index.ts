/**
 * F35-A — missions module public API (used by src/game/Game.ts):
 * CAMPAIGN, TRAINING, buildInstantMission, loadProgress, saveProgress, recordResult,
 * nextMissionAfter, terrainPadsFor, createMissionRunner.
 *
 *   schema.ts          MissionScript types (spawns, SAMs, targets, objectives, triggers…)
 *   MissionRunner.ts   runtime (implements MissionRunnerApi) + ./runtime/* helpers
 *   content/*          campaign "Operation Southern Cross", training, Instant Action generator
 *   progress.ts        localStorage campaign progress
 *   pads.ts            terrain pads under SAM sites / compounds
 *   validate.ts        mission definition validator (tests / dev)
 */
import type { CampaignProgress, InstantActionOptions, MissionDef, MissionResult } from '../core/contracts';
import type { TheaterId } from '../core/types';
import { buildInstantMissionSeeded } from './content/instant';
import { CAMPAIGN_PART1 } from './content/campaign1';
import { CAMPAIGN_PART2 } from './content/campaign2';
import { TRAINING_MISSIONS } from './content/training';
import { applyResult, loadProgressFrom, saveProgressTo, skipMission as skipMissionIn } from './progress';

export { failStreak, markSkyTowerDown, skyTowerRuin, wasSkipped, type ProgressExtras } from './progress';

export { createMissionRunner } from './MissionRunner';
export { buildInstantMission, buildInstantMissionSeeded } from './content/instant';
export { terrainPadsFor } from './pads';
export { validateMission } from './validate';
/** Debrief awards (ids, names, descriptions) — MissionResult.medals entries come from here. */
export { MEDALS, MEDAL_LIST, type MedalDef, type MedalId } from './runtime/debrief';
export type { MissionScript } from './schema';

/** Operation Southern Cross — 12 missions over Auckland, in order. */
export const CAMPAIGN: MissionDef[] = [...CAMPAIGN_PART1, ...CAMPAIGN_PART2];

/** Training missions (always unlocked). */
export const TRAINING: MissionDef[] = TRAINING_MISSIONS;

/** Load campaign progress (localStorage 'f35a.progress.v1'); first mission + training always unlocked. */
export function loadProgress(): CampaignProgress {
  return loadProgressFrom(CAMPAIGN, TRAINING);
}

export function saveProgress(p: CampaignProgress): void {
  saveProgressTo(p);
}

/** Fold a result into the progress (unlocks the next campaign mission on success). Returns a new object. */
export function recordResult(p: CampaignProgress, r: MissionResult): CampaignProgress {
  return applyResult(p, r, CAMPAIGN);
}

/**
 * Safety valve: unlock the mission after `id` without a win (offer it after repeated failures —
 * see failStreak()). Returns a new progress object; save it with saveProgress().
 */
export function skipMission(p: CampaignProgress, id: string): CampaignProgress {
  return skipMissionIn(p, id, CAMPAIGN);
}

/**
 * What the debrief's NEXT button flies: the next campaign mission in order, the next training lesson
 * (the last lesson leads into the campaign's first mission, which is always unlocked), or null after
 * the last campaign mission / for Instant Action ids.
 */
export function nextMissionAfter(id: string): MissionDef | null {
  const i = CAMPAIGN.findIndex((m) => m.id === id);
  if (i >= 0) return i + 1 < CAMPAIGN.length ? CAMPAIGN[i + 1] : null;
  const t = TRAINING.findIndex((m) => m.id === id);
  if (t < 0) return null;
  return t + 1 < TRAINING.length ? TRAINING[t + 1] : (CAMPAIGN[0] ?? null);
}

/** Any campaign / training mission by id (or null). */
export function findMission(id: string): MissionDef | null {
  return CAMPAIGN.find((m) => m.id === id) ?? TRAINING.find((m) => m.id === id) ?? null;
}

const IA_MODES: InstantActionOptions['mode'][] = ['dogfight', 'sam_gauntlet', 'strike', 'defend', 'survival'];
const THEATERS: TheaterId[] = ['auckland', 'desert', 'islands', 'mountains', 'arctic'];

/** FNV-1a hash of a string (32-bit, unsigned): a stable seed from a mission id. */
function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Campaign / training mission by id, or an Instant Action mission from an id of the form
 * `ia_<mode>_<theater>` (e.g. `ia_dogfight_auckland`, `ia_sam_gauntlet_desert`) with default
 * options (4 mixed bandits, day, scattered cloud). Handy for `?mission=` URLs, test hooks and the
 * headless bot sweep. The Instant Action layout and terrain are seeded from a hash of the id, so
 * the same id is the same mission every time (the Instant Action menu builds its missions with
 * buildInstantMission(), a fresh random seed per flight).
 */
export function missionById(id: string): MissionDef | null {
  const found = findMission(id);
  if (found) return found;
  const m = /^ia_(.+)_([a-z]+)$/.exec(id);
  if (!m) return null;
  const mode = m[1] as InstantActionOptions['mode'];
  const theater = m[2] as TheaterId;
  if (!IA_MODES.includes(mode) || !THEATERS.includes(theater)) return null;
  return buildInstantMissionSeeded({ mode, theater, timeOfDay: 'day', weather: 'scattered', enemyType: 'mixed', enemyCount: 4 }, hashId(id));
}
