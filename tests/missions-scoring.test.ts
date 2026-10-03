/**
 * MISSIONS — scoring / grades, AWACS call formatting, radio queue behaviour.
 */
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { POINTS, computeScore, gradeForRating, timeFactor, type ScoreInput } from '../src/missions/runtime/scoring';
import { angels, aspectOf, bearingText, compassWord } from '../src/missions/runtime/awacs';
import { groupNoun } from '../src/missions/runtime/names';
import { RadioQueue } from '../src/missions/runtime/radio';
import { segmentIntersect } from '../src/missions/MissionRunner';

const base: ScoreInput = {
  success: true,
  time: 240,
  parTime: 480,
  kills: { air: 4, sam: 0, ground: 0 },
  enemiesSpawned: 4,
  objectiveBonus: 1000,
  primaryDone: 2,
  primaryTotal: 2,
  secondaryDone: 1,
  secondaryTotal: 1,
  shotsFired: 4,
  hits: 4,
  damageTaken: 0,
  friendlyLosses: 0,
  bonus: 0,
  scoreMultiplier: 1,
};

describe('scoring', () => {
  it('adds kills, objectives, time and accuracy bonuses', () => {
    const r = computeScore(base);
    expect(r.breakdown.kills).toBe(4 * POINTS.air);
    expect(r.breakdown.time).toBe(POINTS.timeMax);
    expect(r.breakdown.accuracy).toBe(POINTS.accuracyMax);
    expect(r.score).toBe(400 + 1000 + 300 + 250);
    expect(r.accuracy).toBe(1);
    expect(r.grade).toBe('S');
  });

  it('applies the difficulty multiplier and penalties', () => {
    const r = computeScore({ ...base, scoreMultiplier: 2, damageTaken: 50, friendlyLosses: 1 });
    expect(r.breakdown.damage).toBe(-100);
    expect(r.breakdown.friendly).toBe(-POINTS.friendlyLoss);
    expect(r.score).toBe((400 + 1000 + 300 + 250 - 100 - 150) * 2);
  });

  it('never goes negative', () => {
    expect(computeScore({ ...base, success: false, kills: { air: 0, sam: 0, ground: 0 }, objectiveBonus: 0, damageTaken: 100, friendlyLosses: 3 }).score).toBe(0);
  });

  it('grades a sloppy success lower than a clean one', () => {
    const clean = computeScore(base);
    const sloppy = computeScore({ ...base, time: 700, hits: 1, damageTaken: 70, secondaryDone: 0, kills: { air: 1, sam: 0, ground: 0 } });
    expect(sloppy.rating).toBeLessThan(clean.rating);
    expect(['B', 'C', 'D']).toContain(sloppy.grade);
  });

  it('caps failed missions at D (some primary done) or F', () => {
    expect(computeScore({ ...base, success: false, primaryDone: 1 }).grade).toBe('D');
    expect(computeScore({ ...base, success: false, primaryDone: 0 }).grade).toBe('F');
  });

  it('grade thresholds and time factor', () => {
    expect(gradeForRating(0.95)).toBe('S');
    expect(gradeForRating(0.8)).toBe('A');
    expect(gradeForRating(0.65)).toBe('B');
    expect(gradeForRating(0.55)).toBe('C');
    expect(gradeForRating(0.4)).toBe('D');
    expect(gradeForRating(0.1)).toBe('F');
    expect(timeFactor(100, 480)).toBe(1);
    expect(timeFactor(720, 480)).toBe(0);
    expect(timeFactor(480, 480)).toBeCloseTo(0.5);
  });
});

describe('AWACS formatting', () => {
  it('bearing text is three digits, clockwise from north', () => {
    expect(bearingText(0, 0, 0, -1000)).toBe('360');
    expect(bearingText(0, 0, 1000, 0)).toBe('090');
    expect(bearingText(0, 0, 0, 1000)).toBe('180');
    expect(bearingText(0, 0, -1000, -1000)).toBe('315');
    expect(bearingText(0, 0, 1000, -1000)).toBe('045');
  });

  it('aspect: hot / flanking / beaming / cold', () => {
    // group at (0,-10000) (north of viewer at origin)
    expect(aspectOf(0, -10000, Math.PI, 0, 0)).toBe('hot'); // heading south, toward viewer
    expect(aspectOf(0, -10000, 0, 0, 0)).toBe('cold');
    expect(aspectOf(0, -10000, Math.PI / 2, 0, 0)).toBe('beaming');
    expect(aspectOf(0, -10000, (Math.PI * 3) / 4, 0, 0)).toBe('flanking');
  });

  it('angels and compass words', () => {
    expect(angels(7620)).toBe('angels 25');
    expect(angels(100)).toBe('angels 1');
    expect(compassWord((225 * Math.PI) / 180)).toBe('southwest');
    expect(compassWord(0)).toBe('north');
  });

  it('a mission noun goes singular for a single jet ("single striker", playtest 2026-10-02)', () => {
    expect(groupNoun('strikers', 1)).toBe('striker');
    expect(groupNoun('low Backfires', 1)).toBe('low Backfire');
    expect(groupNoun('strikers', 2)).toBe('strikers');
  });
});

describe('radio queue', () => {
  it('spaces calls, prioritises, de-duplicates and lets urgent calls interrupt', () => {
    const ev = new EventBus();
    const got: string[] = [];
    ev.on('radio', (r) => got.push(r.text));
    const q = new RadioQueue(ev);
    q.push({ from: 'A', text: 'low one', priority: 1 });
    q.push({ from: 'A', text: 'high', priority: 3 });
    q.push({ from: 'A', text: 'high', priority: 3 }); // duplicate
    q.update(0);
    expect(got).toEqual(['high']);
    q.update(0.5);
    expect(got).toEqual(['high']); // channel busy
    q.push({ from: 'D', text: 'Eject!', priority: 5 });
    q.update(0.6);
    expect(got).toEqual(['high', 'Eject!']);
    q.update(10);
    expect(got).toEqual(['high', 'Eject!', 'low one']);
    expect(q.length).toBe(0);
  });

  it('drops stale calls', () => {
    const ev = new EventBus();
    const got: string[] = [];
    ev.on('radio', (r) => got.push(r.text));
    const q = new RadioQueue(ev);
    q.push({ from: 'A', text: 'x'.repeat(200), priority: 2 });
    q.push({ from: 'A', text: 'stale', priority: 1, ttl: 1 });
    q.update(0);
    q.update(20);
    expect(got).toHaveLength(1);
  });
});

describe('bridge crossing geometry', () => {
  it('segment intersection returns the parameter along the bridge', () => {
    expect(segmentIntersect(-1, 5, 1, 5, 0, 0, 0, 10)).toBeCloseTo(0.5);
    expect(segmentIntersect(-1, 5, -0.5, 5, 0, 0, 0, 10)).toBe(-1);
  });
});
