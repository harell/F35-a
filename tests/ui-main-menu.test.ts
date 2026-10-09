/**
 * The main menu points a player who only wants to see Auckland at the sightseeing flight (playtest
 * 2026-10-10, 1.4-n: A Stroll in the Park was named nowhere on the main menu, four taps away).
 */
import { describe, expect, it } from 'vitest';
import { MAIN_MENU_ITEMS, SIGHTSEEING_LABEL } from '../src/ui/screens/mainMenu';
import { missionById } from '../src/missions';

describe('main menu: sightseeing', () => {
  it('Instant Action names sightseeing first, and the new-pilot card offers it', () => {
    const ia = MAIN_MENU_ITEMS.find((i) => i.id === 'instant')!;
    expect(ia.sub.split(' · ')[0]).toBe('Sightseeing');
    expect(SIGHTSEEING_LABEL).toMatch(/Auckland/);
    // the sightseeing flight is Instant Action's stroll, a free flight with no hostiles
    expect(missionById('ia_stroll_auckland')?.script.freeFlight).toBe(true);
  });
});
