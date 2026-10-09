/**
 * F35-A — missions module public API (used by src/game/Game.ts):
 * CAMPAIGNS, TRAINING, buildInstantMission, loadProgress,
 * saveProgress, recordResult, nextMissionAfter, nextMissionLabel, missionDifficulty, campaignOf,
 * terrainPadsFor, createMissionRunner.
 *
 *   schema.ts          MissionScript types (spawns, SAMs, targets, objectives, triggers…)
 *   MissionRunner.ts   runtime (implements MissionRunnerApi) + ./runtime/* helpers
 *   content/*          the IRGC campaign (irgc.ts, irgcHauraki.ts), training, Instant Action generator
 *   progress.ts        localStorage progress (unlocks chain within each campaign)
 *   pads.ts            terrain pads under SAM sites / compounds
 *   difficulty.ts      the difficulty a mission flies at (training: always Pilot)
 *   validate.ts        mission definition validator (tests / dev)
 */
import type { CampaignDef, CampaignProgress, InstantActionOptions, MissionDef, MissionResult } from '../core/contracts';
import type { TheaterId, TimeOfDay, Weather } from '../core/types';
import { buildInstantMissionSeeded } from './content/instant';
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

/** Training missions (always unlocked). */
export const TRAINING: MissionDef[] = TRAINING_MISSIONS;

/** Every campaign, in menu order, disabled ones included. Each has its own unlock chain and ending. */
export const CAMPAIGNS: CampaignDef[] = [IRGC_CAMPAIGN];

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
 * The lessons a campaign mission wants flown first, in training order: its own (MissionDef.lessons)
 * and every earlier mission's in its campaign. Empty for anything that isn't a campaign mission.
 */
export function lessonsFor(missionId: string): MissionDef[] {
  const chain = campaignOf(missionId)?.missions ?? [];
  const upTo = chain.slice(0, chain.findIndex((m) => m.id === missionId) + 1);
  const ids = new Set(upTo.flatMap((m) => m.lessons ?? []));
  return TRAINING.filter((m) => ids.has(m.id));
}

/**
 * The campaign mission the player is training for (the first playable campaign's first mission not
 * yet won; null once every one is) and the lessons it wants that aren't flown yet. `flown` says
 * which lessons count as flown (default: those with a result in `p`).
 */
export function trainingTarget(
  p: CampaignProgress,
  flown: (id: string) => boolean = (id) => !!p.best[id],
): { mission: MissionDef; lessons: MissionDef[] } | null {
  const mission = PLAYABLE_CAMPAIGNS[0]?.missions.find((m) => !p.best[m.id]);
  return mission ? { mission, lessons: lessonsFor(mission.id).filter((m) => !flown(m.id)) } : null;
}

/**
 * What the debrief's NEXT button flies: the next mission of the same campaign (null after its last
 * one, never into another campaign), null for Instant Action ids, and after a training lesson:
 * - a lesson the next campaign mission wants (trainingTarget) leads to the next one it still wants,
 *   then into that mission, so a player flies only the lessons it needs, just before it;
 * - any other lesson leads to the next lesson in training order, and the last one into that mission.
 * Without `progress`, the lessons before `id` count as flown and no campaign mission as won.
 */
export function nextMissionAfter(id: string, progress?: CampaignProgress): MissionDef | null {
  const campaign = campaignOf(id)?.missions;
  if (campaign) {
    const i = campaign.findIndex((m) => m.id === id);
    return i + 1 < campaign.length ? campaign[i + 1] : null;
  }
  const t = TRAINING.findIndex((m) => m.id === id);
  if (t < 0) return null;
  const p = progress ?? { unlocked: [], best: {}, totals: { missions: 0, airKills: 0, groundKills: 0, deaths: 0 } };
  const flown = progress ? (x: string) => x === id || !!progress.best[x] : (x: string) => TRAINING.findIndex((m) => m.id === x) <= t;
  const target = trainingTarget(p, flown);
  const firstMission = target?.mission ?? PLAYABLE_CAMPAIGNS[0]?.missions[0] ?? null;
  if (target && lessonsFor(target.mission.id).some((m) => m.id === id)) return target.lessons[0] ?? target.mission;
  return t + 1 < TRAINING.length ? TRAINING[t + 1] : firstMission;
}

/**
 * Label of the debrief button that flies nextMissionAfter(id, progress): 'Next lesson' into a
 * lesson, 'Start the campaign' from a lesson into the campaign's first mission, 'Next mission'
 * otherwise; null when there is nothing next.
 */
export function nextMissionLabel(id: string, progress?: CampaignProgress): string | null {
  const next = nextMissionAfter(id, progress);
  if (!next) return null;
  if (next.kind === 'training') return 'Next lesson';
  return TRAINING.some((m) => m.id === id) && next.index === 1 ? 'Start the campaign' : 'Next mission';
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
