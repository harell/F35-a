/**
 * MISSIONS — gaps in the scripted competent player (tests/missions-bot.ts) that hid balance
 * questions in playtest r1-1:
 *  - 1.1-k: it never used the GBU-53/B StormBreaker, so a strike_sdb2 loadout dropped nothing
 *    (0 wins in 16 runs, 7 HUNG);
 *  - 1.1-l: its rearm leg always flew to Whenuapai, so in the procedural Instant Action theatres
 *    (rearm at the scenery's first airbase) it never rearmed (16 of 17 HUNG rows in an IA sweep).
 *    Rearming is gone since (issue #63): out of weapons, the bot now goes to the same home base;
 *  - 1.1-m: `ia_<mode>_<theater>` ids built a fresh random mission on every missionById() call,
 *    so the same id, difficulty and seed gave different runs (and the sweep built the terrain
 *    from one mission and flew another).
 * Sweeps: npx vite-node tools/playtest/bot-sweep.ts -- --missions=c04,c06,t03 --loadout=strike_sdb2
 */
import { describe, expect, it } from 'vitest';
import { buildInstantMission, missionById, terrainPadsFor } from '../src/missions';
import { AKL } from '../src/core/auckland';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import type { TerrainQuery } from '../src/sim/api';
import { homeBase, runPlaythrough } from './missions-bot';

function terrainFor(id: string): TerrainQuery {
  const def = missionById(id)!;
  return new TerrainQueryImpl(runSync(generateTerrain({ theater: def.theater, seed: def.seed, resolution: 512, features: allFeatures(def.theater, []), pads: terrainPadsFor(def) })));
}

describe('1.1-m: Instant Action ids are reproducible', () => {
  it('missionById(ia_*) builds the same mission every time, a different one per id', () => {
    const a = missionById('ia_strike_desert')!;
    const b = missionById('ia_strike_desert')!;
    expect(b.seed).toBe(a.seed);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(missionById('ia_strike_islands')!.seed).not.toBe(a.seed);
  });
  it('the Instant Action menu (buildInstantMission) still rolls a fresh mission per flight', () => {
    const opts = { mode: 'strike', theater: 'desert', timeOfDay: 'day', weather: 'scattered', enemyType: 'mixed', enemyCount: 4 } as const;
    const seeds = new Set(Array.from({ length: 4 }, () => buildInstantMission(opts).seed));
    expect(seeds.size).toBeGreaterThan(1);
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

describe('1.1-l: out of weapons, the bot goes home (no rearming, issue #63)', () => {
  it('procedural theatre: home is the first scenery airbase (Auckland: Whenuapai)', () => {
    const def = missionById('ia_strike_islands')!;
    const base = def.features.find((f) => f.type === 'airbase')!;
    expect(homeBase(def)).toMatchObject({ x: base.x, z: base.z });
    expect(Math.hypot(base.x - AKL.whenuapai.x, base.z - AKL.whenuapai.z)).toBeGreaterThan(5_000);
    expect(homeBase(missionById('c04')!)).toMatchObject({ x: AKL.whenuapai.x, z: AKL.whenuapai.z, name: 'Whenuapai' });
  });
  it('ia_strike_islands: Winchester after the first sortie, the bot flies to the home base and is never rearmed', { timeout: 60_000 }, () => {
    const def = missionById('ia_strike_islands')!;
    const home = homeBase(def)!;
    const r = runPlaythrough(def, 'recruit', 0, terrainFor('ia_strike_islands'), { maxT: 620, log: true });
    const w = r.events.findIndex((l) => /WINCHESTER/.test(l));
    expect(w, r.objectives).toBeGreaterThan(0);
    expect(r.events.some((l) => /REARM/.test(l))).toBe(false);
    const leg = r.events
      .slice(w)
      .map((l) => / BOT RTB pos=\((-?[\d.]+),(-?[\d.]+)\)km/.exec(l))
      .filter((m): m is RegExpExecArray => !!m)
      .map((m) => Math.hypot(Number(m[1]) * 1000 - home.x, Number(m[2]) * 1000 - home.z));
    expect(leg.length, JSON.stringify(r.modes)).toBeGreaterThan(3);
    expect(leg[leg.length - 1], 'closing on the home base').toBeLessThan(leg[0] - 5_000);
  });
});
