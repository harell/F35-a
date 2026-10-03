/**
 * MISSIONS — Operation Southern Cross is disabled (owner's decision, 2026-10-03): its code, missions and
 * tests stay, but the player never sees it and playtests don't cover it until it is enabled again
 * (`enabled: false` on SOUTHERN_CROSS in src/missions/index.ts).
 */
import { describe, expect, it } from 'vitest';
import { CAMPAIGNS, PLAYABLE_CAMPAIGNS, SOUTHERN_CROSS, findMission, nextMissionAfter, nextMissionLabel } from '../src/missions';

describe('Operation Southern Cross is disabled', () => {
  it('is kept in the code but is not a playable campaign', () => {
    expect(SOUTHERN_CROSS.enabled).toBe(false);
    expect(CAMPAIGNS.map((c) => c.id)).toContain('southern_cross');
    expect(PLAYABLE_CAMPAIGNS.map((c) => c.id)).toEqual(['irgc']);
    // its missions still load (tests, ?mission= in the dev and test builds)
    expect(findMission('c01')?.id).toBe('c01');
  });

  it('training leads into the IRGC campaign, not into c01', () => {
    expect(nextMissionAfter('t03')?.id).toBe('g01');
    expect(nextMissionLabel('t03')).toBe('Start the campaign');
  });
});
