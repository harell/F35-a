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
import { buildInstantMission } from './content/instant';
import { CAMPAIGN_PART1 } from './content/campaign1';
import { CAMPAIGN_PART2 } from './content/campaign2';
import { TRAINING_MISSIONS } from './content/training';
import { applyResult, loadProgressFrom, saveProgressTo, skipMission as skipMissionIn } from './progress';

export { failStreak, wasSkipped, type ProgressExtras } from './progress';

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

/** Next campaign mission in order, or null after the last / for non-campaign ids. */
export function nextMissionAfter(id: string): MissionDef | null {
  const i = CAMPAIGN.findIndex((m) => m.id === id);
  return i >= 0 && i + 1 < CAMPAIGN.length ? CAMPAIGN[i + 1] : null;
}

/** Any campaign / training mission by id (or null). */
export function findMission(id: string): MissionDef | null {
  return CAMPAIGN.find((m) => m.id === id) ?? TRAINING.find((m) => m.id === id) ?? null;
}

const IA_MODES: InstantActionOptions['mode'][] = ['dogfight', 'sam_gauntlet', 'strike', 'survival'];
const THEATERS: TheaterId[] = ['auckland', 'desert', 'islands', 'mountains', 'arctic'];

/**
 * Campaign / training mission by id, or an Instant Action mission from an id of the form
 * `ia_<mode>_<theater>` (e.g. `ia_dogfight_auckland`, `ia_sam_gauntlet_desert`) with default
 * options (4 mixed bandits, day, scattered cloud). Handy for `?mission=` URLs.
 */
export function missionById(id: string): MissionDef | null {
  const found = findMission(id);
  if (found) return found;
  const m = /^ia_(.+)_([a-z]+)$/.exec(id);
  if (!m) return null;
  const mode = m[1] as InstantActionOptions['mode'];
  const theater = m[2] as TheaterId;
  if (!IA_MODES.includes(mode) || !THEATERS.includes(theater)) return null;
  return buildInstantMission({ mode, theater, timeOfDay: 'day', weather: 'scattered', enemyType: 'mixed', enemyCount: 4 });
}
