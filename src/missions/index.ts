/**
 * F35-A — missions module public API.  STUB — to be replaced by the MISSIONS agent.
 * Must keep these exports: CAMPAIGN, TRAINING, buildInstantMission, loadProgress,
 * saveProgress, recordResult, nextMissionAfter, terrainPadsFor, createMissionRunner.
 */
import type { CampaignProgress, InstantActionOptions, MissionDef, MissionResult } from '../core/contracts';
export { createMissionRunner } from './MissionRunner';

const stub: MissionDef = {
  id: 'c01',
  kind: 'campaign',
  index: 1,
  title: 'First Light',
  subtitle: 'Stub mission',
  theater: 'desert',
  timeOfDay: 'day',
  weather: 'scattered',
  seed: 1234,
  briefing: ['Stub briefing.'],
  objectiveText: ['Fly.'],
  recommendedLoadout: 'a2a_stealth',
  allowedLoadouts: ['a2a_stealth', 'a2a_beast'],
  player: { x: 0, z: 10000, altitude: 3000, heading: 0, speed: 230 },
  features: [],
  intel: [],
  script: {},
};

export const CAMPAIGN: MissionDef[] = [stub];
export const TRAINING: MissionDef[] = [];

export function buildInstantMission(opts: InstantActionOptions): MissionDef {
  return { ...stub, id: 'instant', kind: 'instant', theater: opts.theater, timeOfDay: opts.timeOfDay, weather: opts.weather };
}

export function loadProgress(): CampaignProgress {
  return { unlocked: CAMPAIGN.map((m) => m.id), best: {}, totals: { missions: 0, airKills: 0, groundKills: 0, deaths: 0 } };
}
export function saveProgress(_p: CampaignProgress): void {}
export function recordResult(p: CampaignProgress, _r: MissionResult): CampaignProgress {
  return p;
}
export function nextMissionAfter(id: string): MissionDef | null {
  const i = CAMPAIGN.findIndex((m) => m.id === id);
  return i >= 0 && i + 1 < CAMPAIGN.length ? CAMPAIGN[i + 1] : null;
}

/** Flat terrain pads (SAM sites, ground target compounds) the terrain generator must flatten. */
export function terrainPadsFor(_def: MissionDef): { x: number; z: number; radius: number }[] {
  return [];
}
