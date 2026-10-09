/**
 * Issue #68, item 2 (repo owner's decision, 2026-10-02): training always flies at Pilot, whatever
 * the difficulty setting. On Veteran (then Ace), T03 dropped to 1/3 (SA-6 with both JDAMs still aboard).
 * Review follow-up: nothing tells the player to change the difficulty of a lesson (the S-grade
 * "try it on a harder difficulty" tip, the pause-menu settings note and toast).
 */
import { describe, expect, it } from 'vitest';
import { CAMPAIGNS, TRAINING, TRAINING_DIFFICULTY, fixedDifficulty, missionById, missionDifficulty, terrainPadsFor } from '../src/missions';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { RECRUIT_OFFER_AFTER, offerRecruitRetry } from '../src/ui/screens/debrief';
import type { Difficulty } from '../src/core/types';
import type { MissionResult } from '../src/core/contracts';
import { DIFFICULTIES } from '../src/core/data';
import { EventBus } from '../src/core/events';
import { buildTips } from '../src/missions/runtime/debrief';
import { MissionState } from '../src/missions/runtime/state';
import { difficultyChangeToast, midSortieDifficultyNote } from '../src/ui/career';
import { runPlaythrough } from './missions-bot';
import { stubAi } from './missions-helpers';

const DIFFS: Difficulty[] = ['recruit', 'pilot', 'veteran'];

describe('#68: training flies at Pilot whatever the setting', () => {
  it('every lesson flies at Pilot; campaign and Instant Action missions follow the setting', () => {
    expect(TRAINING_DIFFICULTY).toBe('pilot');
    expect(TRAINING.map((m) => m.id)).toEqual(['t01', 't02', 't03', 't04', 't05', 't06', 't07']);
    for (const m of TRAINING) {
      expect(fixedDifficulty(m)).toBe('pilot');
      for (const d of DIFFS) expect(missionDifficulty(m, d)).toBe('pilot');
    }
    const instant = missionById('ia_strike_auckland')!;
    for (const m of [...CAMPAIGNS.flatMap((c) => c.missions), instant]) {
      expect(fixedDifficulty(m)).toBeNull();
      for (const d of DIFFS) expect(missionDifficulty(m, d)).toBe(d);
    }
  });

  it('every lesson runs at Pilot on a Veteran setting (the bot starts missions the way the game does)', { timeout: 240_000 }, () => {
    for (const def of TRAINING) {
      const terrain = new TerrainQueryImpl(runSync(generateTerrain({ theater: def.theater, seed: def.seed, resolution: 512, features: allFeatures(def.theater, []), pads: terrainPadsFor(def) })));
      const r = runPlaythrough(def.id, 'veteran', 0, terrain, { maxT: 900 });
      expect(r.state, `${def.id}: ${r.reason}`).not.toBe('running');
      expect(r.result?.difficulty, def.id).toBe('pilot');
    }
  });

  it('no "Retry on Recruit" after failed lessons (they would still fly at Pilot); the campaign keeps it', () => {
    const lost = (missionId: string) => ({ success: false, missionId });
    for (const m of TRAINING) expect(offerRecruitRetry(lost(m.id), RECRUIT_OFFER_AFTER + 3, 'veteran')).toBe(false);
    expect(offerRecruitRetry(lost('g02'), RECRUIT_OFFER_AFTER, 'veteran')).toBe(true);
    expect(offerRecruitRetry(lost('g02'), RECRUIT_OFFER_AFTER - 1, 'veteran')).toBe(false);
    expect(offerRecruitRetry(lost('g02'), RECRUIT_OFFER_AFTER, 'recruit')).toBe(false);
    expect(offerRecruitRetry({ success: true, missionId: 'g02' }, RECRUIT_OFFER_AFTER, 'veteran')).toBe(false);
  });

  it('an S-graded lesson is not told to try a harder difficulty; a campaign mission still is', () => {
    const harder = (id: string) => {
      const def = missionById(id)!;
      const st = new MissionState(def, { createAi: stubAi({ created: [], retasked: [] }), difficulty: DIFFICULTIES.pilot, events: new EventBus() });
      const r: MissionResult = {
        missionId: id,
        title: def.title,
        success: true,
        reason: 'All objectives complete',
        difficulty: 'pilot',
        time: 60,
        score: 5000,
        grade: 'S',
        kills: { air: 0, sam: 0, ground: 0 },
        friendlyLosses: 0,
        shotsFired: 0,
        hits: 0,
        accuracy: 0,
        damageTaken: 0,
        objectives: [],
      };
      return buildTips(st, r).some((t) => /harder difficulty/.test(t));
    };
    for (const m of TRAINING) expect(harder(m.id), m.id).toBe(false);
    expect(harder('g01')).toBe(true);
  });

  it('settings opened from the pause menu of a lesson do not promise the change applies on restart', () => {
    const t01 = missionById('t01')!;
    const g01 = missionById('g01')!;
    expect(midSortieDifficultyNote(t01)).toMatch(/Lessons always fly at Pilot/);
    expect(midSortieDifficultyNote(t01)).not.toMatch(/RESTART|next sortie/);
    expect(midSortieDifficultyNote(g01)).toMatch(/next sortie \(or RESTART\)/);
    expect(midSortieDifficultyNote(null)).toMatch(/next sortie \(or RESTART\)/);
    expect(difficultyChangeToast('veteran', t01)).toMatch(/^Difficulty: Veteran — .*lessons always fly at Pilot$/);
    expect(difficultyChangeToast('veteran', t01)).not.toMatch(/restart/);
    expect(difficultyChangeToast('veteran', g01)).toBe('Difficulty: Veteran — applies from the next sortie or a restart');
  });
});
