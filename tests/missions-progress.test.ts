/**
 * MISSIONS — campaign progress: unlocking, best results, totals, persistence.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MissionResult } from '../src/core/contracts';
import { PLAYABLE_CAMPAIGNS, TRAINING, failStreak, lessonsFor, loadProgress, nextMissionAfter, nextMissionLabel, recordResult, saveProgress } from '../src/missions';
import { LESSON_IDS_VERSION, PROGRESS_KEY, sanitizeProgress } from '../src/missions/progress';

/** The first playable campaign's missions (the IRGC campaign: g01, g02). */
const CAMPAIGN = PLAYABLE_CAMPAIGNS[0].missions;

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

describe('campaign progress', () => {
  let saved: MemStorage | undefined;
  beforeEach(() => {
    saved = g.localStorage;
    g.localStorage = new MemStorage();
  });
  afterEach(() => {
    g.localStorage = saved;
  });

  it('starts with the first campaign mission and all training unlocked', () => {
    const p = loadProgress();
    expect(p.unlocked).toContain(CAMPAIGN[0].id);
    expect(p.unlocked).not.toContain(CAMPAIGN[1].id);
    for (const t of TRAINING) expect(p.unlocked).toContain(t.id);
    expect(p.totals).toEqual({ missions: 0, airKills: 0, groundKills: 0, deaths: 0 });
  });

  it('success unlocks the next mission and records the best result', () => {
    const p0 = loadProgress();
    const p1 = recordResult(p0, result('g01'));
    expect(p1).not.toBe(p0);
    expect(p0.unlocked).not.toContain('g02'); // input not mutated
    expect(p1.unlocked).toContain('g02');
    expect(p1.best.g01).toEqual({ score: 1500, grade: 'B', difficulty: 'pilot' });
    expect(p1.totals).toEqual({ missions: 1, airKills: 2, groundKills: 2, deaths: 0 });
    // a worse run doesn't replace the best
    const p2 = recordResult(p1, result('g01', { score: 900, grade: 'C' }));
    expect(p2.best.g01.score).toBe(1500);
    const p3 = recordResult(p2, result('g01', { score: 2600, grade: 'A', difficulty: 'veteran' }));
    expect(p3.best.g01).toEqual({ score: 2600, grade: 'A', difficulty: 'veteran' });
  });

  it("a saved best result with difficulty 'ace' (the removed level) loads as 'veteran'", () => {
    g.localStorage!.setItem(PROGRESS_KEY, JSON.stringify({ unlocked: ['g01'], best: { g01: { score: 2600, grade: 'A', difficulty: 'ace' } }, totals: { missions: 1, airKills: 0, groundKills: 0, deaths: 0 } }));
    expect(loadProgress().best.g01).toEqual({ score: 2600, grade: 'A', difficulty: 'veteran' });
  });

  it('failure does not unlock and counts deaths', () => {
    const p = recordResult(loadProgress(), result('g01', { success: false, reason: 'Shot down', grade: 'F', score: 100 }));
    expect(p.unlocked).not.toContain('g02');
    expect(p.best.g01).toBeUndefined();
    expect(p.totals.deaths).toBe(1);
    expect(p.totals.missions).toBe(0);
    const p2 = recordResult(p, result('g01', { success: false, reason: 'Objective failed: x', grade: 'D' }));
    expect(p2.totals.deaths).toBe(1);
  });

  it('a failed Instant Action run records no best (Survival, which did, is gone: issue #63)', () => {
    const p = recordResult(loadProgress(), result('ia_dogfight_auckland', { success: false, reason: 'Shot down', score: 1800 }));
    expect(p.best.ia_dogfight_auckland).toBeUndefined();
  });

  it('the last campaign mission unlocks nothing new', () => {
    const last = CAMPAIGN[CAMPAIGN.length - 1];
    const p = recordResult(loadProgress(), result(last.id));
    expect(p.unlocked.length).toBe(loadProgress().unlocked.length);
    expect(nextMissionAfter(last.id)).toBeNull();
    expect(nextMissionAfter('g01')?.id).toBe('g02');
  });

  it('loading a save repairs its unlocks: a won or skipped mission unlocks the next one (issue #63)', () => {
    const won = { score: 1500, grade: 'B', difficulty: 'pilot' };
    // g01 won but g02 missing from `unlocked` (e.g. a mission removed from between them) → g02 unlocked
    const s = sanitizeProgress({ unlocked: ['g01'], best: { g01: won } }, [CAMPAIGN], TRAINING);
    expect(s.unlocked).toContain('g02');
    // a skipped mission unlocks the next one too; nothing unlocks past an unwon mission
    const chain = ['a1', 'a2', 'a3'].map((id, i) => ({ ...CAMPAIGN[0], id, index: i + 1 }));
    const k = sanitizeProgress({ unlocked: ['a1'], best: {}, skipped: ['a1'] }, [chain], TRAINING);
    expect(k.unlocked).toContain('a2');
    expect(k.unlocked).not.toContain('a3');
    // a finished campaign keeps everything unlocked (stale ids of removed missions do no harm)
    const done = sanitizeProgress({ unlocked: CAMPAIGN.map((m) => m.id).concat('gone1'), best: { g02: won, gone1: won } }, [CAMPAIGN], TRAINING);
    for (const m of CAMPAIGN) expect(done.unlocked).toContain(m.id);
  });

  it('training is ordered by the campaign mission each lesson prepares for', () => {
    // ids match the numbers players see (t01 is T01)
    expect(TRAINING.map((m) => m.id)).toEqual(['t01', 't02', 't03', 't04', 't05']);
    expect(TRAINING.map((m) => `t${String(m.index).padStart(2, '0')}`)).toEqual(TRAINING.map((m) => m.id));
    expect(lessonsFor('g01').map((m) => m.id)).toEqual(['t01', 't02']);
    expect(lessonsFor('g02').map((m) => m.id)).toEqual(['t01', 't02', 't03', 't04']);
    expect(lessonsFor('g03').map((m) => m.id)).toEqual(['t01', 't02', 't03', 't04', 't05']);
    // every lesson prepares for some campaign mission, and every campaign mission's lessons exist
    const wanted = new Set(PLAYABLE_CAMPAIGNS[0].missions.flatMap((m) => m.lessons ?? []));
    expect([...wanted].sort()).toEqual(TRAINING.map((m) => m.id).sort());
    // a lesson comes before the lessons of any later campaign mission
    const order = PLAYABLE_CAMPAIGNS[0].missions.flatMap((m) => m.lessons ?? []);
    expect(order).toEqual(TRAINING.map((m) => m.id));
  });

  it('a save from before T03 Maritime Strike: its SA-6 lesson moves from t03 to t05, once', () => {
    const sa6 = { score: 4200, grade: 'A' as const, difficulty: 'pilot' as const };
    const old = { unlocked: ['g01', 't01', 't03'], best: { t01: sa6, t03: sa6 }, totals: { missions: 2, airKills: 0, groundKills: 2, deaths: 0 }, failStreak: { t03: 2 }, skipped: ['t03'] };
    const p = sanitizeProgress(old, [CAMPAIGN], TRAINING);
    expect(p.best.t05).toEqual(sa6);
    expect(p.best.t03).toBeUndefined();
    expect(failStreak(p, 't05')).toBe(2);
    expect(failStreak(p, 't03')).toBe(0);
    // a Maritime Strike result after the move stays t03 through a save and a load
    p.best.t03 = { score: 900, grade: 'C', difficulty: 'pilot' };
    saveProgress(p);
    const again = loadProgress();
    expect(again.best.t03?.score).toBe(900);
    expect(again.best.t05).toEqual(sa6);
    // a save already in the new scheme is left alone
    expect(sanitizeProgress({ ...old, lessonIds: LESSON_IDS_VERSION }, [CAMPAIGN], TRAINING).best.t03).toEqual(sa6);
  });

  it("NEXT after a lesson: only the lessons the next campaign mission wants, then that mission", () => {
    const won = { score: 1, grade: 'B' as const, difficulty: 'pilot' as const };
    const fresh = loadProgress();
    // a new pilot: T01 → T02 → g01, not through all of training first
    expect(nextMissionAfter('t01', fresh)?.id).toBe('t02');
    expect(nextMissionAfter('t02', { ...fresh, best: { t01: won, t02: won } })?.id).toBe('g01');
    // T02 flown first: back to T01, which g01 also wants
    expect(nextMissionAfter('t02', { ...fresh, best: { t02: won } })?.id).toBe('t01');
    // g01 won: Maritime Strike → Gulf Defence → g02
    const afterG01 = { ...fresh, best: { t01: won, t02: won, g01: won, t03: won } };
    expect(nextMissionAfter('t03', afterG01)?.id).toBe('t04');
    const ready = { ...afterG01, best: { ...afterG01.best, t04: won } };
    expect(nextMissionAfter('t04', ready)?.id).toBe('g02');
    expect(nextMissionLabel('t04', ready)).toBe('Next mission');
    // a lesson ahead of the campaign walks on in training order
    expect(nextMissionAfter('t04', { ...fresh, best: { t04: won } })?.id).toBe('t05');
    expect(nextMissionAfter('t05', { ...fresh, best: { t05: won } })?.id).toBe('g01');
    // campaign won: the last lesson still leads somewhere sensible
    const all = { ...fresh, best: Object.fromEntries([...TRAINING.map((m) => m.id), ...CAMPAIGN.map((m) => m.id)].map((id) => [id, won])) };
    expect(nextMissionAfter('t05', all)?.id).toBe(CAMPAIGN[0].id);
    // the campaign's first mission is always unlocked, so NEXT from a lesson never hits a locked mission
    expect(loadProgress().unlocked).toContain(CAMPAIGN[0].id);
    expect(nextMissionAfter('ia_dogfight_auckland')).toBeNull();
    expect(nextMissionAfter('nope')).toBeNull();
  });

  it('persists to localStorage and survives garbage', () => {
    const p = recordResult(loadProgress(), result('g01'));
    saveProgress(p);
    expect(g.localStorage!.getItem(PROGRESS_KEY)).toBeTruthy();
    const back = loadProgress();
    expect(back.unlocked).toContain('g02');
    expect(back.best.g01.score).toBe(1500);
    g.localStorage!.setItem(PROGRESS_KEY, '{not json');
    expect(loadProgress().unlocked).toContain(CAMPAIGN[0].id);
    const s = sanitizeProgress({ unlocked: [42, 'g02'], best: { g01: { score: 'x' } }, totals: { missions: -3 } }, [CAMPAIGN], TRAINING);
    expect(s.unlocked).toContain('g02');
    expect(s.unlocked).toContain('g01');
    expect(s.best).toEqual({});
    expect(s.totals.missions).toBe(0);
  });

  it('works without localStorage', () => {
    g.localStorage = undefined;
    expect(loadProgress().unlocked).toContain('g01');
    expect(() => saveProgress(loadProgress())).not.toThrow();
  });
});
