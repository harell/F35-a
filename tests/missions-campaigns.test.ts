/**
 * MISSIONS — several campaigns (issue #74): Operation Southern Cross and the IRGC campaign side by
 * side. Each campaign unlocks along its own chain, NEXT stays inside it, every lookup
 * finds missions in any campaign, and a save from the one-campaign days keeps its progress.
 *
 * The IRGC campaign has no missions until #78 lands, so this file swaps its content module for a
 * three-mission fixture (g01–g03, copies of c01–c03). The real, empty file is checked separately.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CampaignDef, CampaignProgress, MissionResult } from '../src/core/contracts';

vi.mock('../src/missions/content/irgc', async () => {
  const { CAMPAIGN_PART1 } = await import('../src/missions/content/campaign1');
  const missions = CAMPAIGN_PART1.slice(0, 3).map((m, i) => ({ ...m, id: `g0${i + 1}`, index: i + 1, title: `Fixture g0${i + 1}` }));
  const IRGC_CAMPAIGN: CampaignDef = { id: 'irgc', name: 'Fixture IRGC', description: 'Test fixture', missions };
  return { IRGC_CAMPAIGN, IRGC_CAMPAIGN_NAME: IRGC_CAMPAIGN.name };
});

import {
  CAMPAIGN,
  CAMPAIGNS,
  SOUTHERN_CROSS,
  TRAINING,
  campaignOf,
  failStreak,
  findMission,
  loadProgress,
  missionById,
  nextMissionAfter,
  nextMissionLabel,
  recordResult,
  saveProgress,
  skipMission,
  wasSkipped,
} from '../src/missions';
import { CAMPAIGN_PART1 } from '../src/missions/content/campaign1';
import { CAMPAIGN_PART2 } from '../src/missions/content/campaign2';
import { PROGRESS_KEY } from '../src/missions/progress';

function result(missionId: string, over: Partial<MissionResult> = {}): MissionResult {
  return {
    missionId,
    title: missionId,
    success: true,
    reason: 'All objectives complete',
    difficulty: 'pilot',
    time: 300,
    score: 1500,
    grade: 'B',
    kills: { air: 2, sam: 1, ground: 1 },
    friendlyLosses: 0,
    shotsFired: 4,
    hits: 3,
    accuracy: 0.75,
    damageTaken: 10,
    objectives: [],
    ...over,
  };
}

class MemStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  clear() {
    this.data.clear();
  }
  key() {
    return null;
  }
  get length() {
    return this.data.size;
  }
}

const g = globalThis as unknown as { localStorage?: MemStorage };
const IRGC = () => CAMPAIGNS.find((c) => c.id === 'irgc')!;
const SC_LAST = () => CAMPAIGN[CAMPAIGN.length - 1].id;
/** Ids unlocked by `after` that `before` didn't have. */
const newlyUnlocked = (before: CampaignProgress, after: CampaignProgress) => after.unlocked.filter((id) => !before.unlocked.includes(id));

describe('campaigns', () => {
  let saved: MemStorage | undefined;
  beforeEach(() => {
    saved = g.localStorage;
    g.localStorage = new MemStorage();
  });
  afterEach(() => {
    g.localStorage = saved;
  });

  it('lists Operation Southern Cross, unchanged, then the IRGC campaign', () => {
    expect(CAMPAIGNS.map((c) => c.id)).toEqual(['southern_cross', 'irgc']);
    expect(CAMPAIGNS[0]).toBe(SOUTHERN_CROSS);
    expect(SOUTHERN_CROSS.name).toBe('Operation Southern Cross');
    // CAMPAIGN stays Southern Cross's mission list, in the same order as before
    expect(CAMPAIGN).toBe(SOUTHERN_CROSS.missions);
    expect(CAMPAIGN.map((m) => m.id)).toEqual([...CAMPAIGN_PART1, ...CAMPAIGN_PART2].map((m) => m.id));
    for (const c of CAMPAIGNS) {
      expect(c.name.length, c.id).toBeGreaterThan(0);
      expect(c.description.length, c.id).toBeGreaterThan(0);
    }
  });

  it('the real IRGC campaign file is an empty campaign with a placeholder name (missions arrive in #78 and #82)', async () => {
    const real = await vi.importActual<typeof import('../src/missions/content/irgc')>('../src/missions/content/irgc');
    expect(real.IRGC_CAMPAIGN.id).toBe('irgc');
    expect(real.IRGC_CAMPAIGN.name).toBe(real.IRGC_CAMPAIGN_NAME);
    expect(real.IRGC_CAMPAIGN.name.length).toBeGreaterThan(0);
    expect(real.IRGC_CAMPAIGN.missions).toEqual([]);
  });

  it('mission ids are unique across every campaign and training (progress is keyed by mission id)', () => {
    const ids = [...CAMPAIGNS.flatMap((c) => c.missions), ...TRAINING].map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CAMPAIGNS) for (const m of c.missions) expect(m.kind, m.id).toBe('campaign');
  });

  it("each campaign's first mission is unlocked from the start, nothing after it", () => {
    const p = loadProgress();
    expect(p.unlocked).toContain('c01');
    expect(p.unlocked).toContain('g01');
    expect(p.unlocked).not.toContain('c02');
    expect(p.unlocked).not.toContain('g02');
    for (const t of TRAINING) expect(p.unlocked).toContain(t.id);
  });

  it('finishing an IRGC mission unlocks only the next IRGC mission', () => {
    const p0 = loadProgress();
    const p1 = recordResult(p0, result('g01'));
    expect(newlyUnlocked(p0, p1)).toEqual(['g02']);
    expect(p1.best.g01).toEqual({ score: 1500, grade: 'B', difficulty: 'pilot' });
    // ... and a Southern Cross win unlocks only the next Southern Cross mission
    expect(newlyUnlocked(p1, recordResult(p1, result('c01')))).toEqual(['c02']);
    // the last mission of either campaign unlocks nothing (never the other campaign)
    expect(newlyUnlocked(p1, recordResult(p1, result('g03')))).toEqual([]);
    expect(newlyUnlocked(p1, recordResult(p1, result(SC_LAST())))).toEqual([]);
    // career totals are the pilot's, shared by every campaign
    expect(recordResult(p1, result('c01')).totals.missions).toBe(2);
  });

  it("skips and fail streaks stay in their own campaign", () => {
    let p = loadProgress();
    p = recordResult(p, result('g01', { success: false, reason: 'Shot down', grade: 'F' }));
    p = recordResult(p, result('g01', { success: false, reason: 'Shot down', grade: 'F' }));
    expect(failStreak(p, 'g01')).toBe(2);
    expect(failStreak(p, 'c01')).toBe(0);
    const skipped = skipMission(p, 'g01');
    expect(newlyUnlocked(p, skipped)).toEqual(['g02']);
    expect(wasSkipped(skipped, 'g01')).toBe(true);
    expect(wasSkipped(skipped, 'c01')).toBe(false);
    // skipping a campaign's last mission unlocks nothing
    expect(newlyUnlocked(p, skipMission(p, 'g03'))).toEqual([]);
    expect(newlyUnlocked(p, skipMission(p, SC_LAST()))).toEqual([]);
    // a Southern Cross win doesn't reset the IRGC streak
    expect(failStreak(recordResult(p, result('c01')), 'g01')).toBe(2);
  });

  it('missionById, findMission, campaignOf and NEXT find missions in any campaign', () => {
    expect(missionById('g01')?.title).toBe('Fixture g01');
    expect(findMission('g02')?.id).toBe('g02');
    expect(missionById('c03')?.id).toBe('c03');
    expect(campaignOf('g02')?.id).toBe('irgc');
    expect(campaignOf('c03')?.id).toBe('southern_cross');
    expect(campaignOf('t01')).toBeNull();
    expect(campaignOf('ia_dogfight_auckland')).toBeNull();
    // NEXT walks the mission's own campaign and stops at its end
    expect(nextMissionAfter('g01')?.id).toBe('g02');
    expect(nextMissionAfter('g03')).toBeNull();
    expect(nextMissionAfter(SC_LAST())).toBeNull();
    expect(nextMissionAfter('c01')?.id).toBe('c02');
    expect(nextMissionLabel('g01')).toBe('Next mission');
    expect(nextMissionLabel('g03')).toBeNull();
    // training still leads into Southern Cross
    expect(nextMissionAfter('t03')?.id).toBe('c01');
    expect(IRGC().missions.map((m) => m.id)).toEqual(['g01', 'g02', 'g03']);
  });

  it('an old one-campaign save migrates with its Southern Cross progress intact', () => {
    // what master saved before the second campaign: Southern Cross c01–c04 won, c03 skipped first,
    // c05 failed three times, the tower down, training lesson 1 done
    const old = {
      unlocked: ['c01', 't01', 't02', 't03', 'c02', 'c03', 'c04', 'c05'],
      best: {
        c01: { score: 12450, grade: 'A', difficulty: 'pilot' },
        c02: { score: 9800, grade: 'B', difficulty: 'veteran' },
        c03: { score: 20100, grade: 'S', difficulty: 'ace' },
        c04: { score: 7000, grade: 'C', difficulty: 'recruit' },
        t01: { score: 3000, grade: 'C', difficulty: 'recruit' },
      },
      totals: { missions: 5, airKills: 14, groundKills: 6, deaths: 2 },
      failStreak: { c05: 3 },
      skipped: ['c03'],
      skyTowerDown: { fallHeading: 1.25 },
    };
    g.localStorage!.setItem(PROGRESS_KEY, JSON.stringify(old));
    const p = loadProgress();
    for (const id of old.unlocked) expect(p.unlocked, id).toContain(id);
    expect(p.unlocked).not.toContain('c06');
    expect(p.best).toEqual(old.best);
    expect(p.totals).toEqual(old.totals);
    expect(failStreak(p, 'c05')).toBe(3);
    expect(wasSkipped(p, 'c03')).toBe(true);
    // the Sky Tower is never down for good (#75): an old save's ruin is dropped on load
    expect(p).not.toHaveProperty('skyTowerDown');
    // the new campaign starts at its first mission
    expect(p.unlocked).toContain('g01');
    expect(p.unlocked).not.toContain('g02');
    // and the migrated save round-trips unchanged
    saveProgress(p);
    expect(loadProgress()).toEqual(p);
  });
});
