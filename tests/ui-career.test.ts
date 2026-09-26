/**
 * UI i1 regressions: difficulty text derived from the live numbers, briefing difficulty change
 * persists, first-launch Training prompt, training nudge, career rank, medal tally, IA count note.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CampaignProgress } from '../src/core/contracts';
import { DIFFICULTIES } from '../src/core/data';
import { loadSettings } from '../src/core/settings';
import type { Settings } from '../src/core/types';
import { CAMPAIGN, MEDAL_LIST, TRAINING, failStreak, recordResult } from '../src/missions';
import {
  BASIC_TRAINING,
  DIFFICULTY_ORDER,
  RANKS,
  basicTrainingDone,
  careerRank,
  difficultyFacts,
  difficultyShort,
  dismissOnboarding,
  isFirstLaunch,
  loadMedals,
  recordMedals,
  setDifficulty,
} from '../src/ui/career';
import { RECRUIT_OFFER_AFTER } from '../src/ui/screens/debrief';
import { countNote } from '../src/ui/screens/instantAction';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}
const g = globalThis as unknown as { localStorage?: MemStorage };
beforeEach(() => {
  g.localStorage = new MemStorage();
});
afterEach(() => {
  delete g.localStorage;
});

const emptyProgress = (): CampaignProgress => ({ unlocked: ['c01', ...TRAINING.map((m) => m.id)], best: {}, totals: { missions: 0, airKills: 0, groundKills: 0, deaths: 0 } });

describe('difficulty text comes from the live numbers', () => {
  it('covers the four levels in order', () => {
    expect(DIFFICULTY_ORDER).toEqual(Object.keys(DIFFICULTIES));
  });
  for (const id of DIFFICULTY_ORDER) {
    const d = DIFFICULTIES[id];
    it(`${id}: facts match hits-to-kill, enemy scale, assists and score`, () => {
      const f = difficultyFacts(d).join(' | ');
      if (d.playerMissileHitsToKill > 1) expect(f).toContain(`Survive ${d.playerMissileHitsToKill} missile hits`);
      else expect(f).toContain('One missile hit kills');
      const pct = Math.round((d.enemyCountScale - 1) * 100);
      if (pct === 0) expect(f).toContain('Standard enemy numbers');
      else expect(f).toContain(`${pct > 0 ? '+' : ''}${pct}% enemies`);
      expect(f).toContain(d.flightAssist ? 'Flight-path hold' : 'No flight-path hold');
      expect(f).toContain(`Score ×${d.scoreMultiplier}`);
      expect(d.description.startsWith(difficultyShort(d))).toBe(true);
      expect(difficultyShort(d).length).toBeGreaterThan(8);
    });
  }
  it('reviewer case: Veteran (enemyCountScale 1) no longer claims "+25% enemies"', () => {
    const f = difficultyFacts({ ...DIFFICULTIES.veteran, enemyCountScale: 1 });
    expect(f.join(' ')).not.toMatch(/\+25%/);
    expect(f).toContain('Standard enemy numbers');
  });
});

describe('briefing difficulty picker', () => {
  it('updates the live settings object and persists only the difficulty', () => {
    const live: Settings = { ...loadSettings(), difficulty: 'pilot', quality: 'low' };
    setDifficulty(live, 'ace');
    expect(live.difficulty).toBe('ace');
    const saved = loadSettings();
    expect(saved.difficulty).toBe('ace');
    // URL-only overrides on the live object (e.g. ?quality=low) are not written to storage
    expect(saved.quality).toBe(loadSettings().quality);
    expect(JSON.parse(g.localStorage!.getItem('f35a.settings.v1')!).quality).not.toBe('low');
  });
  it('ignores unknown ids', () => {
    const live: Settings = { ...loadSettings(), difficulty: 'pilot' };
    setDifficulty(live, 'godmode' as Settings['difficulty']);
    expect(live.difficulty).toBe('pilot');
  });
  it('debrief offers Retry on Recruit after two failures in a row (progress failStreak)', () => {
    expect(RECRUIT_OFFER_AFTER).toBe(2);
    let p = emptyProgress();
    const fail = { missionId: 'c01', title: 'x', success: false, reason: 'Shot down', difficulty: 'pilot' as const, time: 60, score: 0, grade: 'F' as const, kills: { air: 0, sam: 0, ground: 0 }, friendlyLosses: 0, shotsFired: 0, hits: 0, accuracy: 0, damageTaken: 100, objectives: [] };
    p = recordResult(p, fail);
    expect(failStreak(p, 'c01')).toBe(1);
    p = recordResult(p, fail);
    expect(failStreak(p, 'c01')).toBeGreaterThanOrEqual(RECRUIT_OFFER_AFTER);
  });
});

describe('onboarding', () => {
  it('first launch until something is saved or the prompt is dismissed', () => {
    expect(isFirstLaunch()).toBe(true);
    dismissOnboarding();
    expect(isFirstLaunch()).toBe(false);
    g.localStorage = new MemStorage();
    g.localStorage.setItem('f35a.progress.v1', '{}');
    expect(isFirstLaunch()).toBe(false);
  });
  it('no storage → never nags', () => {
    delete g.localStorage;
    expect(isFirstLaunch()).toBe(false);
  });
  it('campaign nudge shows until T01–T03 are all done', () => {
    expect(BASIC_TRAINING.every((id) => TRAINING.some((m) => m.id === id))).toBe(true);
    const p = emptyProgress();
    expect(basicTrainingDone(p)).toBe(false);
    p.best.t01 = { score: 1, grade: 'B', difficulty: 'pilot' };
    p.best.t02 = { score: 1, grade: 'B', difficulty: 'pilot' };
    expect(basicTrainingDone(p)).toBe(false);
    p.best.t03 = { score: 1, grade: 'C', difficulty: 'recruit' };
    expect(basicTrainingDone(p)).toBe(true);
  });
});

describe('service record', () => {
  it('rank climbs with career points', () => {
    const p = emptyProgress();
    expect(careerRank(p).rank.name).toBe('Pilot Officer');
    p.totals.missions = 12;
    p.totals.airKills = 20;
    expect(careerRank(p).rank.at).toBeGreaterThan(0);
    for (let i = 1; i < RANKS.length; i++) expect(RANKS[i].at).toBeGreaterThan(RANKS[i - 1].at);
    p.totals.missions = 100;
    expect(careerRank(p).next).toBeNull();
  });
  it('medals from a sortie are tallied; first-time medals are reported as new', () => {
    expect(MEDAL_LIST.length).toBeGreaterThan(3);
    const m = MEDAL_LIST[0];
    expect(recordMedals({ missionId: 'c01', medals: [m] })).toEqual([m.id]);
    expect(recordMedals({ missionId: 'c02', medals: [m] })).toEqual([]);
    expect(loadMedals()[m.id]).toEqual({ count: 2, first: 'c01' });
    expect(recordMedals({ missionId: 'c03' })).toEqual([]);
  });
  it('corrupt medal storage is ignored', () => {
    g.localStorage!.setItem('f35a.medals.v1', '{not json');
    expect(loadMedals()).toEqual({});
  });
  it('campaign list is intact (12 missions) for the grade strip', () => {
    expect(CAMPAIGN.length).toBeGreaterThanOrEqual(12);
  });
});

describe('instant action enemy-count label', () => {
  it('states the real scaling instead of "More bandits on harder difficulties"', () => {
    const t = countNote();
    expect(t).not.toMatch(/More bandits on harder/);
    const r = DIFFICULTIES.recruit.enemyCountScale;
    const a = DIFFICULTIES.ace.enemyCountScale;
    if (r !== 1 || a !== 1) {
      expect(t).toContain(`×${r}`);
      expect(t).toContain(`×${a}`);
    }
  });
});
