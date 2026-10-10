/**
 * The main menu points a player who only wants to see Auckland at the sightseeing flight (playtest
 * 2026-10-10, 1.4-n: A Stroll in the Park was named nowhere on the main menu, four taps away).
 */
import { describe, expect, it } from 'vitest';
import { MAIN_MENU_ITEMS, ONBOARD_BUTTONS, SIGHTSEEING_LABEL } from '../src/ui/screens/mainMenu';
import { TRAINING, missionById, missionForLesson } from '../src/missions';
import { suggestedLesson } from '../src/ui/career';
import type { CampaignProgress } from '../src/core/contracts';

describe('main menu: sightseeing', () => {
  it('Instant Action names sightseeing first, and the new-pilot card offers it', () => {
    const ia = MAIN_MENU_ITEMS.find((i) => i.id === 'instant')!;
    expect(ia.sub.split(' · ')[0]).toBe('Sightseeing');
    expect(SIGHTSEEING_LABEL).toMatch(/Auckland/);
    // the sightseeing flight is Instant Action's stroll, a free flight with no hostiles
    expect(missionById('ia_stroll_auckland')?.script.freeFlight).toBe(true);
  });

  it('the new-pilot card: sightseeing is a clear second button in one row with Start training, not a ghost like Not now (playtest r2 2.1-k)', () => {
    expect(ONBOARD_BUTTONS.map((b) => b.id)).toEqual(['instant', 'training']);
    const [look, go] = ONBOARD_BUTTONS;
    expect(look.label).toBe(SIGHTSEEING_LABEL);
    expect(look.class.split(' ')).not.toContain('ghost');
    expect(go.class.split(' ')).toContain('primary');
  });
});

describe('training list: each lesson names the mission it prepares for (playtest 2026-10-10, 1.4-j)', () => {
  it('every lesson belongs to a campaign mission, and the first campaign mission\'s lessons come first', () => {
    for (const t of TRAINING) expect(missionForLesson(t.id), t.id).not.toBeNull();
    expect(missionForLesson('t01')?.id).toBe('g01');
    expect(missionForLesson('g01')).toBeNull();
  });

  it('after g01 is won without its lessons, the suggestion is g02\'s first lesson, not T01', () => {
    const p: CampaignProgress = { unlocked: ['g01', 'g02'], best: {}, totals: { missions: 1, airKills: 10, groundKills: 0, deaths: 0 } };
    p.best.g01 = { grade: 'B', score: 1000, difficulty: 'pilot' } as CampaignProgress['best'][string];
    const next = suggestedLesson(p);
    expect(next?.id).toBe(missionById('g02')!.lessons![0]);
    // a fresh save: g01's first lesson
    expect(suggestedLesson({ unlocked: ['g01'], best: {}, totals: { missions: 0, airKills: 0, groundKills: 0, deaths: 0 } })?.id).toBe('t01');
  });
});
