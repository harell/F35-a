/**
 * UI i1 regressions: difficulty text derived from the live numbers, briefing difficulty change
 * persists, first-launch Training prompt, training nudge, career rank, medal tally, IA count note.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CampaignProgress } from '../src/core/contracts';
import { DIFFICULTIES } from '../src/core/data';
import { loadSettings } from '../src/core/settings';
import type { Settings } from '../src/core/types';
import { MEDAL_LIST, TRAINING, failStreak, recordResult } from '../src/missions';
import {
  DIFFICULTY_ORDER,
  RANKS,
  basicTrainingDone,
  careerRank,
  difficultyFacts,
  difficultyShort,
  dismissOnboarding,
  isFirstLaunch,
  lessonsLeft,
  loadMedals,
  recordMedals,
  setDifficulty,
} from '../src/ui/career';
import { RECRUIT_OFFER_AFTER, debriefPrimary } from '../src/ui/screens/debrief';
import { countNote } from '../src/ui/screens/instantAction';
import { IA_ENEMY_COUNT_SCALE } from '../src/missions/content/instant';

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

const emptyProgress = (): CampaignProgress => ({ unlocked: ['g01', ...TRAINING.map((m) => m.id)], best: {}, totals: { missions: 0, airKills: 0, groundKills: 0, deaths: 0 } });

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
    setDifficulty(live, 'veteran');
    expect(live.difficulty).toBe('veteran');
    const saved = loadSettings();
    expect(saved.difficulty).toBe('veteran');
    // URL-only overrides on the live object (e.g. ?quality=low) are not written to storage
    expect(saved.quality).toBe(loadSettings().quality);
    expect(JSON.parse(g.localStorage!.getItem('f35a.settings.v1')!).quality).not.toBe('low');
  });
  it("a saved difficulty 'ace' (the removed fourth level) loads as 'veteran'", () => {
    g.localStorage!.setItem('f35a.settings.v1', JSON.stringify({ difficulty: 'ace' }));
    expect(loadSettings().difficulty).toBe('veteran');
  });
  it('ignores unknown ids', () => {
    const live: Settings = { ...loadSettings(), difficulty: 'pilot' };
    setDifficulty(live, 'godmode' as Settings['difficulty']);
    expect(live.difficulty).toBe('pilot');
  });
  it('debrief offers Retry on Recruit after two failures in a row (progress failStreak)', () => {
    expect(RECRUIT_OFFER_AFTER).toBe(2);
    let p = emptyProgress();
    const fail = { missionId: 'g01', title: 'x', success: false, reason: 'Shot down', difficulty: 'pilot' as const, time: 60, score: 0, grade: 'F' as const, kills: { air: 0, sam: 0, ground: 0 }, friendlyLosses: 0, shotsFired: 0, hits: 0, accuracy: 0, damageTaken: 100, objectives: [] };
    p = recordResult(p, fail);
    expect(failStreak(p, 'g01')).toBe(1);
    p = recordResult(p, fail);
    expect(failStreak(p, 'g01')).toBeGreaterThanOrEqual(RECRUIT_OFFER_AFTER);
  });
});

describe('debrief primary button', () => {
  it('NEXT after a win with a next mission or lesson, MENU after any other win, RETRY only after a failure', () => {
    expect(debriefPrimary({ success: true }, true)).toBe('next');
    expect(debriefPrimary({ success: true }, false)).toBe('menu');
    expect(debriefPrimary({ success: true, campaignComplete: true }, false)).toBe('ending');
    expect(debriefPrimary({ success: false }, false)).toBe('retry');
    expect(debriefPrimary({ success: false }, true)).toBe('retry');
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
  it('campaign nudge asks only for the lessons the next campaign mission wants', () => {
    const won = { score: 1, grade: 'B' as const, difficulty: 'pilot' as const };
    const p = emptyProgress();
    expect(basicTrainingDone(p)).toBe(false);
    expect(lessonsLeft(p)?.mission.id).toBe('g01');
    expect(lessonsLeft(p)?.lessons.map((m) => m.id)).toEqual(['t01', 't02', 't03']);
    p.best.t01 = won;
    expect(lessonsLeft(p)?.lessons.map((m) => m.id)).toEqual(['t02', 't03']);
    // T01–T03 are all g01 needs: no strike or SAM lessons before the first mission
    p.best.t02 = won;
    p.best.t03 = won;
    expect(basicTrainingDone(p)).toBe(true);
    // g01 won: Maritime Strike and Gulf Defence before g02
    p.best.g01 = won;
    expect(lessonsLeft(p)?.mission.id).toBe('g02');
    expect(lessonsLeft(p)?.lessons.map((m) => m.id)).toEqual(['t04', 't05']);
    p.best.t04 = won;
    p.best.t05 = won;
    expect(basicTrainingDone(p)).toBe(true);
    // g02 won: Live SAMs before g03
    p.best.g02 = won;
    expect(lessonsLeft(p)?.lessons.map((m) => m.id)).toEqual(['t06']);
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
    expect(recordMedals({ missionId: 'g01', medals: [m] })).toEqual([m.id]);
    expect(recordMedals({ missionId: 'g02', medals: [m] })).toEqual([]);
    expect(loadMedals()[m.id]).toEqual({ count: 2, first: 'g01' });
    expect(recordMedals({ missionId: 't01' })).toEqual([]);
  });
  it('corrupt medal storage is ignored', () => {
    g.localStorage!.setItem('f35a.medals.v1', '{not json');
    expect(loadMedals()).toEqual({});
  });
});

describe('instant action enemy-count label', () => {
  it('states the real scaling instead of "More bandits on harder difficulties"', () => {
    const t = countNote();
    expect(t).not.toMatch(/More bandits on harder/);
    const r = IA_ENEMY_COUNT_SCALE.recruit ?? DIFFICULTIES.recruit.enemyCountScale;
    const a = IA_ENEMY_COUNT_SCALE.veteran ?? DIFFICULTIES.veteran.enemyCountScale;
    expect(a).toBe(1);
    if (r !== 1 || a !== 1) {
      expect(t).toContain(`×${r}`);
      expect(t).toContain(`×${a}`);
    }
  });
});
