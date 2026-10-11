/**
 * The Training screen's packs: one per campaign mission (MissionDef.lessons), showing the next lesson
 * to fly, Complete once all are flown, and moved to the end as Mission won when the mission was won
 * without them. A lesson may repeat in a later pack (a skill that mission is built on), never a
 * foundation lesson, and every pack needs a lesson of its own.
 */
import { describe, expect, it } from 'vitest';
import type { CampaignDef, CampaignProgress, MissionDef } from '../src/core/contracts';
import { PLAYABLE_CAMPAIGNS, TRAINING, trainingPacks, validateLessonPacks } from '../src/missions';

const won = { score: 1, grade: 'B' as const, difficulty: 'pilot' as const };
const progress = (ids: string[]): CampaignProgress => ({
  unlocked: ['g01'],
  best: Object.fromEntries(ids.map((id) => [id, won])),
  totals: { missions: ids.length, airKills: 0, groundKills: 0, deaths: 0 },
});
const base = PLAYABLE_CAMPAIGNS[0];
/** The campaign with a made-up fourth mission whose pack is `lessons`. */
const withPack = (lessons: string[]): CampaignDef[] => [{ ...base, missions: [...base.missions, { ...base.missions[2], id: 'g04', index: 4, lessons } as MissionDef] }];
const summary = (p: CampaignProgress) => trainingPacks(p).map((k) => `${k.mission.id}:${k.state}:${k.next?.id ?? '-'}:${k.flown}${k.suggested ? '*' : ''}`);

describe('training packs', () => {
  it('a new pilot: one pack per mission, each on its first lesson, g01 suggested', () => {
    expect(summary(progress([]))).toEqual(['g01:open:t01:0*', 'g02:open:t04:0', 'g03:open:t06:0']);
  });

  it('a pack shows its next unflown lesson, even when a later one was flown first', () => {
    expect(summary(progress(['t01']))[0]).toBe('g01:open:t02:1*');
    // T05 flown out of order: g02 still asks for T04 first
    expect(summary(progress(['t05']))[1]).toBe('g02:open:t04:1');
  });

  it('every lesson flown: Complete; the suggestion moves on once the mission is won', () => {
    // g01 is what the player should fly now: no pack is suggested
    expect(summary(progress(['t01', 't02', 't03']))).toEqual(['g01:complete:-:3', 'g02:open:t04:0', 'g03:open:t06:0']);
    expect(summary(progress(['t01', 't02', 't03', 'g01']))).toEqual(['g01:complete:-:3', 'g02:open:t04:0*', 'g03:open:t06:0']);
    expect(trainingPacks(progress(TRAINING.map((m) => m.id))).every((k) => k.state === 'complete' && !k.suggested)).toBe(true);
  });

  it('a mission won without its lessons: Mission won, after the packs still ahead', () => {
    expect(summary(progress(['g01', 't01']))).toEqual(['g02:open:t04:0*', 'g03:open:t06:0', 'g01:won:t02:1']);
    // won and every lesson flown is plain Complete, in campaign order
    expect(summary(progress(['g01', 't01', 't02', 't03']))[0]).toBe('g01:complete:-:3');
  });

  it('a lesson in two packs counts as flown in both', () => {
    const packs = trainingPacks(progress(['t04']), withPack(['t04', 't07']));
    expect(packs.find((k) => k.mission.id === 'g02')?.flown).toBe(1);
    expect(packs.find((k) => k.mission.id === 'g04')).toMatchObject({ flown: 1, next: { id: 't07' } });
  });
});

describe('training pack rules (validateLessonPacks)', () => {
  // a made-up eighth lesson for g04 to have one of its own
  const training = [...TRAINING, { ...TRAINING[6], id: 't08', index: 8 } as MissionDef];
  const check = (lessons: string[]) => validateLessonPacks(withPack(lessons), training);

  it('the shipped campaign follows them', () => {
    expect(validateLessonPacks()).toEqual([]);
  });

  it('a specialised lesson may repeat in a later pack that has a lesson of its own', () => {
    expect(check(['t04', 't08'])).toEqual([]);
  });

  it('a pack made only of repeats, a repeated foundation lesson and an unknown id are refused', () => {
    expect(check(['t04', 't05'])).toEqual(['g04: no lesson of its own (every one is in an earlier pack)', "t08: in no mission's training pack"]);
    expect(check(['t01', 't08'])).toEqual(['g04: foundation lesson t01 repeats an earlier pack']);
    expect(check(['t99', 't08'])).toEqual(['g04: unknown lesson t99']);
  });

  it('a lesson in no pack is refused (the Training screen would never show it)', () => {
    const missions = base.missions.map((m) => (m.id === 'g03' ? { ...m, lessons: ['t06'] } : m));
    expect(validateLessonPacks([{ ...base, missions }])).toEqual(['t07: in no mission\'s training pack']);
  });
});
