/**
 * MISSIONS — gaps in the scripted competent player (tests/missions-bot.ts) that hid balance
 * questions in playtest r1-1:
 *  - 1.1-k: it never used the GBU-53/B StormBreaker, so a strike_sdb2 loadout dropped nothing
 *    (0 wins in 16 runs, 7 HUNG);
 *  - 1.1-l: its rearm leg always flew to Whenuapai, so in the procedural Instant Action theatres
 *    (rearm at the scenery's first airbase) it never rearmed (16 of 17 HUNG rows in an IA sweep).
 *    Those theatres are gone (issue #73): every mission rearms at Whenuapai again;
 *  - 1.1-m: `ia_<mode>_<theater>` ids built a fresh random mission on every missionById() call,
 *    so the same id, difficulty and seed gave different runs (and the sweep built the terrain
 *    from one mission and flew another).
 * Sweeps: npx vite-node tools/playtest/bot-sweep.ts -- --missions=c04,c06,t03 --loadout=strike_sdb2
 */
import { describe, expect, it } from 'vitest';
import { buildInstantMission, missionById, terrainPadsFor } from '../src/missions';
import { rearmHome } from '../src/missions/runtime/rearm';
import { AKL } from '../src/core/auckland';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import type { TerrainQuery } from '../src/sim/api';
import { runPlaythrough } from './missions-bot';

function terrainFor(id: string): TerrainQuery {
  const def = missionById(id)!;
  return new TerrainQueryImpl(runSync(generateTerrain({ theater: def.theater, seed: def.seed, resolution: 512, features: allFeatures(def.theater, []), pads: terrainPadsFor(def) })));
}

describe('1.1-m: Instant Action ids are reproducible', () => {
  it('missionById(ia_*) builds the same mission every time, a different one per id', () => {
    const a = missionById('ia_dogfight_auckland')!;
    const b = missionById('ia_dogfight_auckland')!;
    expect(b.seed).toBe(a.seed);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(missionById('ia_survival_auckland'))).not.toBe(JSON.stringify(a));
  });
  it('the Instant Action menu (buildInstantMission) still rolls a fresh mission per flight', () => {
    // Auckland's terrain seed is fixed (AKL_SEED); the layout's rng (mixed bandit types) is not
    const opts = { mode: 'dogfight', theater: 'auckland', timeOfDay: 'day', weather: 'scattered', enemyType: 'mixed', enemyCount: 8 } as const;
    const rolls = new Set(Array.from({ length: 4 }, () => JSON.stringify(buildInstantMission(opts).script.groups)));
    expect(rolls.size).toBeGreaterThan(1);
  });
});

describe('1.1-k: the bot flies the GBU-53/B StormBreaker', () => {
  it('t03 with strike_sdb2: it releases StormBreakers and wins', { timeout: 60_000 }, () => {
    const r = runPlaythrough('t03', 'pilot', 1, terrainFor('t03'), { loadout: 'strike_sdb2', maxT: 400, log: true });
    const drops = r.events.filter((l) => / LAUNCH gbu53 PLAYER /.test(l));
    expect(drops.length, r.objectives).toBeGreaterThan(0);
    expect(r.playerKills).toBeGreaterThan(0);
    expect(r.state, `${r.objectives} ${JSON.stringify(r.modes)}`).toBe('success');
  });
});

describe('1.1-l: the bot rearms where the mission rearms it', () => {
  it('Auckland, the only theatre: campaign and Instant Action missions rearm at Whenuapai', () => {
    for (const id of ['c04', 'ia_strike_auckland', 'ia_sam_gauntlet_auckland']) {
      expect(rearmHome(missionById(id)!), id).toMatchObject({ x: AKL.whenuapai.x, z: AKL.whenuapai.z, name: 'Whenuapai' });
    }
  });
});
