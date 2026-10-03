/**
 * F35-A — missions module public API (used by src/game/Game.ts):
 * CAMPAIGNS (CAMPAIGN = Southern Cross's missions), TRAINING, buildInstantMission, loadProgress,
 * saveProgress, recordResult, nextMissionAfter, nextMissionLabel, missionDifficulty, campaignOf,
 * terrainPadsFor, createMissionRunner.
 *
 *   schema.ts          MissionScript types (spawns, SAMs, targets, objectives, triggers…)
 *   MissionRunner.ts   runtime (implements MissionRunnerApi) + ./runtime/* helpers
 *   content/*          campaigns "Operation Southern Cross" and IRGC (irgc.ts), training, Instant Action generator
 *   progress.ts        localStorage progress (unlocks chain within each campaign)
 *   pads.ts            terrain pads under SAM sites / compounds
 *   difficulty.ts      the difficulty a mission flies at (training: always Pilot)
 *   validate.ts        mission definition validator (tests / dev)
 */
import type { CampaignDef, CampaignProgress, InstantActionOptions, MissionDef, MissionResult } from '../core/contracts';
import type { TheaterId, TimeOfDay, Weather } from '../core/types';
import { buildInstantMissionSeeded } from './content/instant';
import { CAMPAIGN_PART1 } from './content/campaign1';
import { CAMPAIGN_PART2 } from './content/campaign2';
import { IRGC_CAMPAIGN } from './content/irgc';
import { TRAINING_MISSIONS } from './content/training';
import { applyResult, loadProgressFrom, saveProgressTo, skipMission as skipMissionIn } from './progress';

export { failStreak, wasSkipped, type ProgressExtras } from './progress';

export { createMissionRunner } from './MissionRunner';
/** Hints and mission texts follow the scheme Input is actually flying (Game reports it every frame). */
export { followActiveScheme } from './runtime/controlsText';
export { buildInstantMission, buildInstantMissionSeeded } from './content/instant';
export { terrainPadsFor } from './pads';
export { validateMission } from './validate';
/** The player's gun rounds in a mission (MissionDef.gunAmmo, else the loadout's). */
export { missionGunAmmo } from './runtime/gunAmmo';
/** Debrief awards (ids, names, descriptions) — MissionResult.medals entries come from here. */
export { MEDALS, MEDAL_LIST, type MedalDef, type MedalId } from './runtime/debrief';
export type { MissionScript } from './schema';

/** Operation Southern Cross — 10 missions over Auckland, in order (ids c01–c06, c08–c11: c07 and c12 were removed with rearming, issue #63). */
export const CAMPAIGN: MissionDef[] = [...CAMPAIGN_PART1, ...CAMPAIGN_PART2];

/** Training missions (always unlocked). */
export const TRAINING: MissionDef[] = TRAINING_MISSIONS;

/**
 * Operation Southern Cross, the first campaign (its missions are CAMPAIGN). Disabled (owner's decision,
 * 2026-10-03): its code, missions and tests stay, but players don't see it and playtests don't cover it
 * until it is enabled again. To enable it, delete `enabled: false`.
 */
export const SOUTHERN_CROSS: CampaignDef = {
  id: 'southern_cross',
  name: 'Operation Southern Cross',
  description: 'Drive the hostile force off the Hauraki Gulf islands and defend Auckland',
  missions: CAMPAIGN,
  enabled: false,
};

/** Every campaign, in menu order, disabled ones included. Each has its own unlock chain and ending. */
export const CAMPAIGNS: CampaignDef[] = [SOUTHERN_CROSS, IRGC_CAMPAIGN];

/** The campaigns the player sees (CampaignDef.enabled not false), in menu order. */
export const PLAYABLE_CAMPAIGNS: CampaignDef[] = CAMPAIGNS.filter((c) => c.enabled !== false);

/** Each campaign's ordered mission list (what progress.ts unlocks along). */
const chains = (): MissionDef[][] => CAMPAIGNS.map((c) => c.missions);

/** The campaign a mission belongs to (null for training, Instant Action and unknown ids). */
export function campaignOf(missionId: string): CampaignDef | null {
  return CAMPAIGNS.find((c) => c.missions.some((m) => m.id === missionId)) ?? null;
}

/** Load progress (localStorage 'f35a.progress.v1'); each campaign's first mission + training always unlocked. */
export function loadProgress(): CampaignProgress {
  return loadProgressFrom(chains(), TRAINING);
}

export function saveProgress(p: CampaignProgress): void {
  saveProgressTo(p);
}

/** Fold a result into the progress (a win unlocks the next mission of the same campaign). Returns a new object. */
export function recordResult(p: CampaignProgress, r: MissionResult): CampaignProgress {
  return applyResult(p, r, chains());
}

/**
 * Safety valve: unlock the mission after `id` without a win (offer it after repeated failures —
 * see failStreak()). Returns a new progress object; save it with saveProgress().
 */
export function skipMission(p: CampaignProgress, id: string): CampaignProgress {
  return skipMissionIn(p, id, chains());
}

/**
 * What the debrief's NEXT button flies: the next mission of the same campaign, the next training
 * lesson (the last lesson leads into the first playable campaign's first mission, which is always unlocked), or
 * null after a campaign's last mission (never into another campaign) / for Instant Action ids.
 */
export function nextMissionAfter(id: string): MissionDef | null {
  const campaign = campaignOf(id)?.missions;
  if (campaign) {
    const i = campaign.findIndex((m) => m.id === id);
    return i + 1 < campaign.length ? campaign[i + 1] : null;
  }
  const t = TRAINING.findIndex((m) => m.id === id);
  if (t < 0) return null;
  return t + 1 < TRAINING.length ? TRAINING[t + 1] : (PLAYABLE_CAMPAIGNS[0]?.missions[0] ?? null);
}

/**
 * Label of the debrief button that flies nextMissionAfter(id): 'Next lesson' between training
 * lessons, 'Start the campaign' after the last lesson, 'Next mission' in the campaign; null when
 * there is nothing next.
 */
export function nextMissionLabel(id: string): string | null {
  const next = nextMissionAfter(id);
  if (!next) return null;
  if (!TRAINING.some((m) => m.id === id)) return 'Next mission';
  return next.kind === 'training' ? 'Next lesson' : 'Start the campaign';
}

export { TRAINING_DIFFICULTY, fixedDifficulty, missionDifficulty } from './difficulty';

/** Any campaign's mission or training mission by id (or null). */
export function findMission(id: string): MissionDef | null {
  for (const c of CAMPAIGNS) {
    const m = c.missions.find((x) => x.id === id);
    if (m) return m;
  }
  return TRAINING.find((m) => m.id === id) ?? null;
}

const IA_MODES: InstantActionOptions['mode'][] = ['stroll', 'dogfight', 'sam_gauntlet', 'strike', 'defend'];
const THEATERS: TheaterId[] = ['auckland'];

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
 * Mission of any campaign or training by id, or an Instant Action mission from an id of the form
 * `ia_<mode>_<theater>` (e.g. `ia_dogfight_auckland`, `ia_sam_gauntlet_auckland`; Auckland is the
 * only theatre, any other returns null) with default options (4 mixed bandits, day, scattered cloud;
 * `conditions` picks another time of day or weather, e.g. a night stroll). Handy for `?mission=` URLs
 * (`&tod=night&weather=clear`), test hooks and the headless bot sweep. The Instant Action layout and
 * terrain are seeded from a hash of the id, so the same id is the same mission every time, whatever
 * the conditions (the Instant Action menu builds its missions with buildInstantMission(), a fresh
 * random seed per flight). `conditions` don't apply to campaign or training missions.
 */
export function missionById(id: string, conditions: InstantConditions = {}): MissionDef | null {
  const found = findMission(id);
  if (found) return found;
  const m = /^ia_(.+)_([a-z]+)$/.exec(id);
  if (!m) return null;
  const mode = m[1] as InstantActionOptions['mode'];
  const theater = m[2] as TheaterId;
  if (!IA_MODES.includes(mode) || !THEATERS.includes(theater)) return null;
  const timeOfDay = conditions.timeOfDay ?? 'day';
  const weather = conditions.weather ?? 'scattered';
  return buildInstantMissionSeeded({ mode, theater, timeOfDay, weather, enemyType: 'mixed', enemyCount: 4 }, hashId(id));
}

/** Time of day and weather of an Instant Action mission built by missionById() (unset: day, scattered). */
export interface InstantConditions {
  timeOfDay?: TimeOfDay;
  weather?: Weather;
}
/** Every TimeOfDay / Weather value (the Instant Action setup screen offers each). */
export const TIMES_OF_DAY: readonly TimeOfDay[] = ['dawn', 'day', 'dusk', 'night'];
export const WEATHERS: readonly Weather[] = ['clear', 'scattered', 'overcast'];
