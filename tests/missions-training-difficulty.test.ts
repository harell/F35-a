/**
 * Issue #68, item 2 (repo owner's decision, 2026-10-02): training always flies at Pilot, whatever
 * the difficulty setting. On Ace, T03 dropped to 1/3 (SA-6 with both JDAMs still aboard).
 */
import { describe, expect, it } from 'vitest';
import { CAMPAIGN, TRAINING, TRAINING_DIFFICULTY, fixedDifficulty, missionById, missionDifficulty, terrainPadsFor } from '../src/missions';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { RECRUIT_OFFER_AFTER, offerRecruitRetry } from '../src/ui/screens/debrief';
import type { Difficulty } from '../src/core/types';
import { runPlaythrough } from './missions-bot';

const DIFFS: Difficulty[] = ['recruit', 'pilot', 'veteran', 'ace'];

describe('#68: training flies at Pilot whatever the setting', () => {
  it('every lesson flies at Pilot; campaign and Instant Action missions follow the setting', () => {
    expect(TRAINING_DIFFICULTY).toBe('pilot');
    expect(TRAINING.map((m) => m.id)).toEqual(['t01', 't02', 't03']);
    for (const m of TRAINING) {
      expect(fixedDifficulty(m)).toBe('pilot');
      for (const d of DIFFS) expect(missionDifficulty(m, d)).toBe('pilot');
    }
    const instant = missionById('ia_strike_auckland')!;
    for (const m of [...CAMPAIGN, instant]) {
      expect(fixedDifficulty(m)).toBeNull();
      for (const d of DIFFS) expect(missionDifficulty(m, d)).toBe(d);
    }
  });

  it('T01–T03 run at Pilot on an Ace setting (the bot starts missions the way the game does)', { timeout: 240_000 }, () => {
    for (const def of TRAINING) {
      const terrain = new TerrainQueryImpl(runSync(generateTerrain({ theater: def.theater, seed: def.seed, resolution: 512, features: allFeatures(def.theater, []), pads: terrainPadsFor(def) })));
      const r = runPlaythrough(def.id, 'ace', 0, terrain, { maxT: 900 });
      expect(r.state, `${def.id}: ${r.reason}`).not.toBe('running');
      expect(r.result?.difficulty, def.id).toBe('pilot');
    }
  });

  it('no "Retry on Recruit" after failed lessons (they would still fly at Pilot); the campaign keeps it', () => {
    const lost = (missionId: string) => ({ success: false, missionId });
    for (const m of TRAINING) expect(offerRecruitRetry(lost(m.id), RECRUIT_OFFER_AFTER + 3, 'ace')).toBe(false);
    expect(offerRecruitRetry(lost('c02'), RECRUIT_OFFER_AFTER, 'ace')).toBe(true);
    expect(offerRecruitRetry(lost('c02'), RECRUIT_OFFER_AFTER - 1, 'ace')).toBe(false);
    expect(offerRecruitRetry(lost('c02'), RECRUIT_OFFER_AFTER, 'recruit')).toBe(false);
    expect(offerRecruitRetry({ success: true, missionId: 'c02' }, RECRUIT_OFFER_AFTER, 'ace')).toBe(false);
  });
});
