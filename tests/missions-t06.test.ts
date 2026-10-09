/**
 * Live SAMs (t06, src/missions/content/training.ts), reworked for g03 (playtest 2026-10-10, 1.4-a): it
 * flew a JDAM (no campaign mission carries one) round a 60 km route with 200 s of nothing. Now it flies
 * g03's loadout from 20 km out: low over the harbour, an AARGM-ER at the SA-6 by the one rule, then a
 * StormBreaker on the tank behind it. Also the rule itself, the same in every text (1.4-h), the
 * heat-seeker advice (1.4-o) and the debrief's fallback tip (1.4-p).
 * Sweep: npx vite-node tools/playtest/bot-sweep.ts -- --missions=t06 --seeds=3 --log
 */
import { describe, expect, it } from 'vitest';
import { AARGM_CLOSE_RANGE, AARGM_RULE, LOADOUTS } from '../src/core/data';
import { PLAYABLE_CAMPAIGNS, TRAINING, missionById, terrainPadsFor } from '../src/missions';
import { T06, T06_SAM } from '../src/missions/content/training';
import { lessonTip } from '../src/missions/runtime/debrief';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { ARM_RELEASE, runPlaythrough } from './missions-bot';

let terrain: TerrainQueryImpl | null = null;
function realTerrain(): TerrainQueryImpl {
  if (!terrain) terrain = new TerrainQueryImpl(runSync(generateTerrain({ theater: T06.theater, seed: T06.seed, resolution: 512, features: allFeatures(T06.theater, []), pads: terrainPadsFor(T06) })));
  return terrain;
}

describe('t06 Live SAMs on g03\'s loadout', () => {
  it('flies sead_precision (AARGM-ERs and StormBreakers, no JDAM), as g03 does', () => {
    expect(T06.allowedLoadouts).toEqual(['sead_precision']);
    expect(missionById('g03')?.allowedLoadouts).toEqual(['sead_precision']);
    expect(LOADOUTS.sead_precision.stores.some((s) => s.weapon === 'gbu31')).toBe(false);
    expect(T06.briefing.join(' ')).not.toMatch(/JDAM/);
  });

  it('starts about 20 km from the SA-6 (no northern transit), with the tank behind it', () => {
    const d = Math.hypot(T06_SAM.start.x - T06_SAM.sa6.x, T06_SAM.start.z - T06_SAM.sa6.z);
    expect(d).toBeGreaterThan(15_000);
    expect(d).toBeLessThan(25_000);
    expect(T06.script.waypoints.filter((w) => w.kind === 'nav' || w.kind === 'ip')).toHaveLength(1);
    // the tank lies beyond the SA-6 from the start
    expect(Math.hypot(T06_SAM.depot.x - T06_SAM.start.x, T06_SAM.depot.z - T06_SAM.start.z)).toBeGreaterThan(d);
    expect(T06.briefing.length).toBeLessThanOrEqual(3);
  });

  it('the bot wins it in about two minutes: an AARGM at the SA-6 from inside the rule, then a StormBreaker', { timeout: 300_000 }, () => {
    const log: string[] = [];
    for (const seed of [0, 1, 2]) {
      const r = runPlaythrough('t06', 'pilot', seed, realTerrain(), { maxT: 400 });
      log.push(`seed ${seed}: ${r.state}@${r.t}s ${r.launches.map((l) => `${l.weapon}@${Math.round(l.t)}`).join(' ')}`);
      expect(r.state, log.join('\n')).toBe('success');
      expect(r.t, log.join('\n')).toBeLessThanOrEqual(200);
      expect(r.launches[0]?.weapon, log.join('\n')).toBe('aargm');
      expect(r.launches.some((l) => l.weapon === 'gbu53' && l.group === 'depot'), log.join('\n')).toBe(true);
    }
  });
});

describe('one AARGM rule everywhere (1.4-h)', () => {
  it('the briefings that teach the AARGM-ER say the rule, and no text says another one', () => {
    expect(AARGM_RULE).toMatch(/inside about 10 km while its radar is on, then press straight in/);
    expect(AARGM_CLOSE_RANGE).toBe(10_000);
    expect(ARM_RELEASE).toBeLessThanOrEqual(AARGM_CLOSE_RANGE);
    for (const id of ['t04', 't06']) expect(missionById(id)!.briefing.join(' '), id).toContain(AARGM_RULE);
    const all = [...TRAINING, ...PLAYABLE_CAMPAIGNS.flatMap((c) => c.missions)];
    for (const m of all) {
      const text = [...m.briefing, ...(m.script.hints ?? []).map((h) => h.text)].join(' ');
      expect(text, m.id).not.toMatch(/outside its 12 km reach|keeps homing even if/);
    }
  });
});

describe('the debrief points at the lessons the mission asks for (1.4-p)', () => {
  it('names the mission\'s own lessons by number and title', () => {
    expect(lessonTip(missionById('g02')!)).toBe('Fly Training 04, Maritime Strike and Training 05, Gulf Defence first: they prepare this mission.');
    expect(lessonTip(missionById('g03')!)).toBe('Fly Training 06, Live SAMs and Training 07, Small Targets first: they prepare this mission.');
    expect(lessonTip({})).toMatch(/^Fly Training first/);
  });
});
