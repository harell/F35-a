/**
 * MISSIONS — campaign progress: unlocking, best results, totals, persistence.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MissionResult } from '../src/core/contracts';
import { CAMPAIGN, TRAINING, loadProgress, nextMissionAfter, recordResult, saveProgress } from '../src/missions';
import { PROGRESS_KEY, sanitizeProgress } from '../src/missions/progress';

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
    const p1 = recordResult(p0, result('c01'));
    expect(p1).not.toBe(p0);
    expect(p0.unlocked).not.toContain('c02'); // input not mutated
    expect(p1.unlocked).toContain('c02');
    expect(p1.best.c01).toEqual({ score: 1500, grade: 'B', difficulty: 'pilot' });
    expect(p1.totals).toEqual({ missions: 1, airKills: 2, groundKills: 2, deaths: 0 });
    // a worse run doesn't replace the best
    const p2 = recordResult(p1, result('c01', { score: 900, grade: 'C' }));
    expect(p2.best.c01.score).toBe(1500);
    const p3 = recordResult(p2, result('c01', { score: 2600, grade: 'A', difficulty: 'ace' }));
    expect(p3.best.c01).toEqual({ score: 2600, grade: 'A', difficulty: 'ace' });
  });

  it('failure does not unlock and counts deaths', () => {
    const p = recordResult(loadProgress(), result('c01', { success: false, reason: 'Shot down', grade: 'F', score: 100 }));
    expect(p.unlocked).not.toContain('c02');
    expect(p.best.c01).toBeUndefined();
    expect(p.totals.deaths).toBe(1);
    expect(p.totals.missions).toBe(0);
    const p2 = recordResult(p, result('c01', { success: false, reason: 'Objective failed: x', grade: 'D' }));
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
    expect(nextMissionAfter('c01')?.id).toBe('c02');
  });

  it('an old save stuck on the removed c07 unlocks c08 (c07 and c12 were removed, issue #63)', () => {
    const won = { score: 1500, grade: 'B', difficulty: 'pilot' };
    // won c06 → c07 unlocked; c07 is gone, so c06's win now unlocks c08
    const s = sanitizeProgress({ unlocked: ['c01', 'c02', 'c03', 'c04', 'c05', 'c06', 'c07'], best: { c06: won } }, [CAMPAIGN], TRAINING);
    expect(s.unlocked).toContain('c08');
    expect(s.unlocked).not.toContain('c09');
    // a skipped mission unlocks the next one too; nothing unlocks past an unwon mission
    const k = sanitizeProgress({ unlocked: ['c01', 'c02'], best: {}, skipped: ['c01'] }, [CAMPAIGN], TRAINING);
    expect(k.unlocked).toContain('c02');
    expect(k.unlocked).not.toContain('c03');
    // a finished campaign keeps everything unlocked and the finale is c11
    const done = sanitizeProgress({ unlocked: CAMPAIGN.map((m) => m.id).concat('c07', 'c12'), best: { c11: won, c12: won } }, [CAMPAIGN], TRAINING);
    for (const m of CAMPAIGN) expect(done.unlocked).toContain(m.id);
  });

  it('training lessons chain T01 → T02 → T03 → the first campaign mission', () => {
    expect(TRAINING.map((m) => m.id)).toEqual(['t01', 't02', 't03']);
    expect(nextMissionAfter('t01')?.id).toBe('t02');
    expect(nextMissionAfter('t02')?.id).toBe('t03');
    expect(nextMissionAfter('t03')?.id).toBe(CAMPAIGN[0].id);
    // the campaign's first mission is always unlocked, so NEXT after T03 never hits a locked mission
    expect(loadProgress().unlocked).toContain(CAMPAIGN[0].id);
    expect(nextMissionAfter('ia_dogfight_auckland')).toBeNull();
    expect(nextMissionAfter('nope')).toBeNull();
  });

  it('persists to localStorage and survives garbage', () => {
    const p = recordResult(loadProgress(), result('c01'));
    saveProgress(p);
    expect(g.localStorage!.getItem(PROGRESS_KEY)).toBeTruthy();
    const back = loadProgress();
    expect(back.unlocked).toContain('c02');
    expect(back.best.c01.score).toBe(1500);
    g.localStorage!.setItem(PROGRESS_KEY, '{not json');
    expect(loadProgress().unlocked).toContain(CAMPAIGN[0].id);
    const s = sanitizeProgress({ unlocked: [42, 'c05'], best: { c01: { score: 'x' } }, totals: { missions: -3 } }, [CAMPAIGN], TRAINING);
    expect(s.unlocked).toContain('c05');
    expect(s.unlocked).toContain('c01');
    expect(s.best).toEqual({});
    expect(s.totals.missions).toBe(0);
  });

  it('works without localStorage', () => {
    g.localStorage = undefined;
    expect(loadProgress().unlocked).toContain('c01');
    expect(() => saveProgress(loadProgress())).not.toThrow();
  });
});
