/**
 * Playtest tooling (#118): the test-hook logic that runs without a browser. The hooks themselves
 * (`window.__f35.*`) are exercised in the dev server; see .claude/skills/play-f35/SKILL.md.
 */
import { describe, expect, it } from 'vitest';
import { missionById } from '../src/missions';
import { testConditions } from '../src/game/testParams';

describe('Instant Action time of day and weather (?tod= / ?weather=, missionById conditions)', () => {
  it('missionById builds an ia_* id at the asked time of day and weather, on the same seeded layout', () => {
    const day = missionById('ia_stroll_auckland')!;
    const night = missionById('ia_stroll_auckland', { timeOfDay: 'night', weather: 'clear' })!;
    expect(day.timeOfDay).toBe('day');
    expect(day.weather).toBe('scattered');
    expect(night.timeOfDay).toBe('night');
    expect(night.weather).toBe('clear');
    expect(night.id).toBe(day.id);
    expect(night.seed).toBe(day.seed);
    expect(JSON.stringify(night.script)).toBe(JSON.stringify(day.script));
    // one condition alone keeps the other's default
    expect(missionById('ia_dogfight_auckland', { weather: 'overcast' })!.timeOfDay).toBe('day');
  });

  it("conditions don't change campaign or training missions", () => {
    const c10 = missionById('c10')!;
    expect(missionById('c10', { timeOfDay: 'day', weather: 'clear' })).toBe(c10);
  });

  it('parses and validates the URL values (case-insensitive); unknown values are listed, not applied', () => {
    const q = (s: string) => testConditions(new URLSearchParams(s), true);
    expect(q('?mission=ia_stroll_auckland&tod=night&weather=clear')).toEqual({ conditions: { timeOfDay: 'night', weather: 'clear' }, invalid: [] });
    expect(q('?tod=Dusk')).toEqual({ conditions: { timeOfDay: 'dusk' }, invalid: [] });
    expect(q('?weather=overcast')).toEqual({ conditions: { weather: 'overcast' }, invalid: [] });
    const bad = q('?tod=midnight&weather=rain');
    expect(bad.conditions).toEqual({});
    expect(bad.invalid).toHaveLength(2);
    expect(bad.invalid[0]).toContain('tod=midnight');
    expect(bad.invalid[1]).toContain('weather=rain');
    expect(q('')).toEqual({ conditions: {}, invalid: [] });
  });

  it('nothing without the test hooks (the deployed game)', () => {
    expect(testConditions(new URLSearchParams('?tod=night&weather=clear'), false)).toEqual({ conditions: {}, invalid: [] });
  });
});
