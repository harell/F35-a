/**
 * MISSIONS — campaigns (issue #74): each campaign unlocks along its own chain, NEXT and the ending
 * stay inside it, every lookup finds missions in any campaign, and a save from the one-campaign days
 * keeps its progress.
 *
 * The IRGC campaign (g01–g03; no finale yet: it is still being built) is the only campaign. The "separate chains"
 * mechanics are checked against the lower-level progress functions (src/missions/progress.ts takes
 * the chains explicitly) with a synthetic second campaign (x01–x02) next to the real one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CampaignDef, CampaignProgress, MissionDef, MissionResult } from '../src/core/contracts';
import {
  CAMPAIGNS,
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
import { IRGC_CAMPAIGN, IRGC_CAMPAIGN_NAME } from '../src/missions/content/irgc';
import { P, mission, site } from '../src/missions/content/common';
import { PROGRESS_KEY, applyResult, sanitizeProgress, skipMission as skipIn } from '../src/missions/progress';
import { campaignStatus } from '../src/ui/format';
import { campaignEnding } from '../src/ui/screens/ending';
import { harness, killGroup, shieldPlayer } from './missions-helpers';

/** A minimal campaign mission: one SA-15 on Rangitoto to destroy (`finale`: the campaign's last). */
function fixtureMission(id: string, index: number, finale = false): MissionDef {
  return mission({
    id,
    kind: 'campaign',
    index,
    title: `Fixture ${id}`,
    subtitle: 'Test fixture',
    timeOfDay: 'day',
    weather: 'clear',
    briefing: ['Test fixture.'],
    recommendedLoadout: 'a2a_stealth',
    allowedLoadouts: ['a2a_stealth'],
    player: { x: -6000, z: -8000, altitude: 4000, heading: 60, speed: 240 },
    script: {
      sams: [site('fx_sa15', 'fx_sam', 'sa15', P.rangitoto)],
      objectives: [{ id: 'o_sam', kind: 'destroy', groups: ['fx_sam'], label: 'Destroy the SA-15', primary: true }],
      campaignFinale: finale,
    },
  });
}

/** A synthetic second campaign beside the real IRGC one (x02 its finale). */
const OTHER: CampaignDef = { id: 'irgc', name: 'Fixture campaign', description: 'Test fixture', missions: [fixtureMission('x01', 1), fixtureMission('x02', 2, true)] };
/** Two campaigns' chains: the real IRGC one and the fixture. */
const CHAINS = [IRGC_CAMPAIGN.missions, OTHER.missions];

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

  it('lists the IRGC campaign, named and described', () => {
    expect(CAMPAIGNS.map((c) => c.id)).toEqual(['irgc']);
    expect(CAMPAIGNS[0]).toBe(IRGC_CAMPAIGN);
    for (const c of CAMPAIGNS) {
      expect(c.name.length, c.id).toBeGreaterThan(0);
      expect(c.description.length, c.id).toBeGreaterThan(0);
    }
  });

  it('the IRGC campaign file lists g01 (#78), g02 (#82) then g03 (#196) and has a placeholder name', () => {
    expect(IRGC_CAMPAIGN.id).toBe('irgc');
    expect(IRGC_CAMPAIGN.name).toBe(IRGC_CAMPAIGN_NAME);
    expect(IRGC_CAMPAIGN.name.length).toBeGreaterThan(0);
    expect(IRGC_CAMPAIGN.missions.map((m) => m.id)).toEqual(['g01', 'g02', 'g03']);
    expect(IRGC_CAMPAIGN.missions.map((m) => m.index)).toEqual([1, 2, 3]);
    // a campaign with a mission is no longer "coming soon" in the picker
    expect(campaignStatus(IRGC_CAMPAIGN, loadProgress())).toEqual({ done: 0, total: 3, soon: false });
  });

  it('mission ids are unique across every campaign and training (progress is keyed by mission id)', () => {
    const ids = [...CAMPAIGNS.flatMap((c) => c.missions), ...TRAINING].map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CAMPAIGNS) for (const m of c.missions) expect(m.kind, m.id).toBe('campaign');
  });

  it("each campaign's first mission is unlocked from the start, nothing after it", () => {
    const p = loadProgress();
    expect(p.unlocked).toContain('g01');
    expect(p.unlocked).not.toContain('g02');
    for (const t of TRAINING) expect(p.unlocked).toContain(t.id);
    // with two campaigns, each one's first mission
    const two = sanitizeProgress(null, CHAINS, TRAINING);
    expect(two.unlocked).toContain('g01');
    expect(two.unlocked).toContain('x01');
    expect(two.unlocked).not.toContain('g02');
    expect(two.unlocked).not.toContain('x02');
  });

  it('finishing a mission unlocks only the next mission of its own campaign', () => {
    const p0 = loadProgress();
    const p1 = recordResult(p0, result('g01'));
    expect(newlyUnlocked(p0, p1)).toEqual(['g02']);
    expect(p1.best.g01).toEqual({ score: 1500, grade: 'B', difficulty: 'pilot' });
    expect(newlyUnlocked(p1, recordResult(p1, result('g02')))).toEqual(['g03']);
    // the campaign's last mission unlocks nothing
    expect(newlyUnlocked(p1, recordResult(p1, result('g03')))).toEqual([]);
    // two campaigns: an IRGC win unlocks only the next IRGC mission, a fixture win only the next fixture one
    const q0 = sanitizeProgress(null, CHAINS, TRAINING);
    const q1 = applyResult(q0, result('g01'), CHAINS);
    expect(newlyUnlocked(q0, q1)).toEqual(['g02']);
    expect(newlyUnlocked(q1, applyResult(q1, result('x01'), CHAINS))).toEqual(['x02']);
    // the last mission of either campaign unlocks nothing (never the other campaign)
    expect(newlyUnlocked(q1, applyResult(q1, result('g03'), CHAINS))).toEqual([]);
    expect(newlyUnlocked(q1, applyResult(q1, result('x02'), CHAINS))).toEqual([]);
    // career totals are the pilot's, shared by every campaign
    expect(applyResult(q1, result('x01'), CHAINS).totals.missions).toBe(2);
  });

  it('skips and fail streaks stay in their own campaign', () => {
    let p = loadProgress();
    p = recordResult(p, result('g01', { success: false, reason: 'Shot down', grade: 'F' }));
    p = recordResult(p, result('g01', { success: false, reason: 'Shot down', grade: 'F' }));
    expect(failStreak(p, 'g01')).toBe(2);
    const skipped = skipMission(p, 'g01');
    expect(newlyUnlocked(p, skipped)).toEqual(['g02']);
    expect(wasSkipped(skipped, 'g01')).toBe(true);
    // skipping a campaign's last mission unlocks nothing
    expect(newlyUnlocked(p, skipMission(p, 'g03'))).toEqual([]);
    // two campaigns: the other campaign's streak and skips are untouched
    let q = sanitizeProgress(null, CHAINS, TRAINING);
    q = applyResult(q, result('g01', { success: false, reason: 'Shot down', grade: 'F' }), CHAINS);
    q = applyResult(q, result('g01', { success: false, reason: 'Shot down', grade: 'F' }), CHAINS);
    expect(failStreak(q, 'g01')).toBe(2);
    expect(failStreak(q, 'x01')).toBe(0);
    const qs = skipIn(q, 'g01', CHAINS);
    expect(newlyUnlocked(q, qs)).toEqual(['g02']);
    expect(wasSkipped(qs, 'x01')).toBe(false);
    expect(newlyUnlocked(q, skipIn(q, 'g03', CHAINS))).toEqual([]);
    expect(newlyUnlocked(q, skipIn(q, 'x02', CHAINS))).toEqual([]);
    // a win in the other campaign doesn't reset the IRGC streak
    expect(failStreak(applyResult(q, result('x01'), CHAINS), 'g01')).toBe(2);
  });

  it('missionById, findMission, campaignOf and NEXT find campaign missions', () => {
    expect(missionById('g01')?.id).toBe('g01');
    expect(findMission('g02')?.id).toBe('g02');
    expect(campaignOf('g01')?.id).toBe('irgc');
    expect(campaignOf('g02')?.id).toBe('irgc');
    expect(campaignOf('t01')).toBeNull();
    expect(campaignOf('ia_dogfight_auckland')).toBeNull();
    // NEXT walks the mission's own campaign and stops at its end
    expect(nextMissionAfter('g01')?.id).toBe('g02');
    expect(nextMissionAfter('g02')?.id).toBe('g03');
    expect(nextMissionAfter('g03')).toBeNull();
    expect(nextMissionLabel('g01')).toBe('Next mission');
    expect(nextMissionLabel('g03')).toBeNull();
    // training leads into the first playable campaign
    expect(nextMissionAfter('t03')?.id).toBe('g01');
    expect(nextMissionAfter('t04')?.id).toBe('t05');
    expect(nextMissionAfter('t05')?.id).toBe('t06');
    expect(nextMissionAfter('t06')?.id).toBe('t07');
    expect(nextMissionAfter('t07')?.id).toBe('g01');
    expect(IRGC().missions.map((m) => m.id)).toEqual(['g01', 'g02', 'g03']);
  });

  it('an old one-campaign save migrates with its progress intact', () => {
    // a save from before a second campaign: g01 won and skipped first, g02 failed three times,
    // the tower down, training lesson 1 done
    const old = {
      unlocked: ['g01', 't01', 't02', 't03', 'g02'],
      best: {
        g01: { score: 12450, grade: 'A', difficulty: 'pilot' },
        t01: { score: 3000, grade: 'C', difficulty: 'recruit' },
      },
      totals: { missions: 5, airKills: 14, groundKills: 6, deaths: 2 },
      failStreak: { g02: 3 },
      skipped: ['g01'],
      skyTowerDown: { fallHeading: 1.25 },
    };
    g.localStorage!.setItem(PROGRESS_KEY, JSON.stringify(old));
    const p = loadProgress();
    for (const id of old.unlocked) expect(p.unlocked, id).toContain(id);
    expect(p.best).toEqual(old.best);
    expect(p.totals).toEqual(old.totals);
    expect(failStreak(p, 'g02')).toBe(3);
    expect(wasSkipped(p, 'g01')).toBe(true);
    // the Sky Tower is never down for good (#75): an old save's ruin is dropped on load
    expect(p).not.toHaveProperty('skyTowerDown');
    // and the migrated save round-trips unchanged
    saveProgress(p);
    expect(loadProgress()).toEqual(p);
    // a new campaign added beside it starts at its first mission, the old progress untouched
    const two = sanitizeProgress(old, CHAINS, TRAINING);
    for (const id of old.unlocked) expect(two.unlocked, id).toContain(id);
    expect(two.best).toEqual(old.best);
    expect(failStreak(two, 'g02')).toBe(3);
    expect(two.unlocked).toContain('x01');
    expect(two.unlocked).not.toContain('x02');
  });

  it('the picker counts missions won per campaign', () => {
    let p = sanitizeProgress(null, CHAINS, TRAINING);
    p = applyResult(p, result('g01'), CHAINS);
    p = applyResult(p, result('x01'), CHAINS);
    p = applyResult(p, result('x02'), CHAINS);
    expect(campaignStatus(IRGC(), p)).toEqual({ done: 1, total: 3, soon: false });
    expect(campaignStatus(OTHER, p)).toEqual({ done: 2, total: 2, soon: false });
    expect(campaignStatus({ ...OTHER, missions: [] }, p)).toEqual({ done: 0, total: 0, soon: true });
  });

  it('tells the Interspecies Revolutionary Guard Corps story (#211): the full name next to the letters, the IRGC Navy and no animal branch names', () => {
    expect(IRGC_CAMPAIGN_NAME).toBe('IRGC · Interspecies Revolutionary Guard Corps');
    expect(IRGC().description).toMatch(/Predator Free 2050/);
    const text = (id: string) => {
      const m = IRGC().missions.find((x) => x.id === id)!;
      return [...m.briefing, ...(m.script.opening ?? []).map((a) => ('text' in a ? String(a.text) : ''))].join(' ');
    };
    expect(text('g01')).toMatch(/The Guard's rusting mother ship/);
    expect(text('g02')).toMatch(/IRGC Navy/);
    expect(text('g03')).toMatch(/The Guard holds the island/);
    expect(text('g03')).toMatch(/IRGC Navy air-defence boats/);
  });

  it('the IRGC campaign has its own ending, a placeholder without a campaign medal', () => {
    const irgc = campaignEnding('irgc');
    expect(irgc.tag).toBe(IRGC().name.toUpperCase());
    expect(irgc.medal).toBeNull();
    expect(irgc.epilogue.join(' ')).toContain(`${IRGC().name}: the campaign is complete`);
    // the Interspecies Revolutionary Guard Corps story (#211): every force the campaign met is beaten
    for (const s of ['drones', 'IRGC Navy', 'off Waiheke', '2050']) expect(irgc.epilogue.join(' ')).toContain(s);
    expect(irgc.epilogue.join(' ')).not.toContain('Southern Cross');
    expect(irgc.roll[0]).toEqual(['Campaign', IRGC().name]);
    // an unknown campaign gets the same ending
    expect(campaignEnding(null)).toEqual(irgc);
  });

  it("winning a campaign's finale completes the campaign; any other win does not", () => {
    /** Fly a fixture mission and win it: its SA-15 dead. */
    const win = (def: MissionDef) => {
      const h = harness(def);
      h.run(1, () => shieldPlayer(h));
      killGroup(h, 'fx_sam');
      h.run(2, () => shieldPlayer(h));
      expect(h.runner.state).toBe('success');
      return h.runner.result(h.world);
    };
    // the IRGC campaign is still being built (#197): none of its missions is the finale yet
    for (const m of IRGC().missions) expect(m.script.campaignFinale, m.id).toBeFalsy();
    const [x01, x02] = OTHER.missions;
    expect(win(x02).campaignComplete).toBe(true);
    expect(win(x01).campaignComplete).toBeFalsy();
    // a finale flag outside a campaign (training) completes nothing
    expect(win({ ...x02, kind: 'training' }).campaignComplete).toBeFalsy();
  });
});
