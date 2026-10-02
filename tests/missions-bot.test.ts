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
 * and in playtest 2026-10-02 r4:
 *  - 4.3-f (#69): the air-to-air PlayerBot (tests/ai-playerbot.ts) never fired its gun (0 of 180
 *    rounds in 6 gun-only runs), so gun balance couldn't be measured.
 * Sweeps: npx vite-node tools/playtest/bot-sweep.ts -- --missions=c04,c06,t03 --loadout=strike_sdb2
 */
import { describe, expect, it } from 'vitest';
import { Autopilot } from '../src/ai/pilot/Autopilot';
import { buildInstantMission, missionById, terrainPadsFor } from '../src/missions';
import { rearmHome } from '../src/missions/runtime/rearm';
import { AKL } from '../src/core/auckland';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import type { TerrainQuery } from '../src/sim/api';
import { runPlaythrough } from './missions-bot';
import { PlayerBot, runBalanceMission } from './ai-playerbot';
import { flat, makeAiWorld, v3 } from './ai-helpers';

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

describe('4.3-f (#69): the PlayerBot fires its gun', () => {
  /**
   * Gun-only F-35 1 km behind a MiG-29 (no AI, no weapons of its own) flying straight and level,
   * or held in a constant level turn of `turnRate` rad/s at 230 m/s (0.15 ≈ 3.5 g, 0.25 ≈ its 5 g limit).
   */
  function trailChase(seed: number, turnRate = 0): { killedAt: number; rounds: number } {
    const { world, destroyed } = makeAiWorld('pilot', flat(0), seed);
    const p = world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 5_000, 0), heading: 0, speed: 250, loadout: 'a2a_stealth' });
    for (const s of p.stores) s.count = 0;
    const mig = world.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 5_000, -1_000), heading: 0, speed: 230 });
    for (const s of mig.stores) s.count = 0;
    mig.gunAmmo = 0;
    const straight = new Autopilot();
    const bot = new PlayerBot({ home: v3(0, 5_000, 30_000), rtbWhenWinchester: false });
    bot.attach(world, p);
    const ammo = p.gunAmmo;
    const dt = 1 / 60;
    for (let i = 0; i < 30 * 60 && mig.alive; i++) {
      if (i % 3 === 0) {
        bot.update(p, world, dt * 3);
        const it = straight.begin(mig, 150); // keep its altitude at 230 m/s, heading 0 or turning
        const psi = turnRate * world.time;
        it.dir.set(-Math.sin(psi), 0, -Math.cos(psi));
        it.track = turnRate > 0;
        it.gMax = 5;
        it.speed = 230;
        straight.fly(mig, world, dt * 3);
      }
      world.step(dt);
    }
    const kill = destroyed.find((e) => e.entity === mig);
    return { killedAt: kill && kill.attackerId === p.id ? world.time : -1, rounds: ammo - p.gunAmmo };
  }

  it('kills a straight-flying MiG-29 from 1 km in trail with the gun within 30 s (was 0 rounds fired)', { timeout: 60_000 }, () => {
    for (const seed of [1, 2, 3]) {
      const r = trailChase(seed);
      expect(r.rounds, `seed ${seed}`).toBeGreaterThan(0);
      expect(r.killedAt, `seed ${seed}: ${r.rounds} rounds fired`).toBeGreaterThan(0);
      expect(r.killedAt).toBeLessThan(30);
    }
  });

  it('keeps the pipper on a MiG-29 in a sustained 3.5–5 g turn and kills it from 1 km in trail within 30 s', { timeout: 60_000 }, () => {
    // the old loop fed the jet's own turn rate back through the autopilot's feed-forward: the
    // pipper swung 0.06–0.2 rad round the bandit and the bot fired one burst at most
    for (const turnRate of [0.15, 0.25])
      for (const seed of [1, 2, 3]) {
        const r = trailChase(seed, turnRate);
        expect(r.killedAt, `${turnRate} rad/s, seed ${seed}: ${r.rounds} rounds fired`).toBeGreaterThan(0);
        expect(r.killedAt).toBeLessThan(30);
      }
  });

  it('gun-only probe (c01, Recruit): no missiles all mission long, the pilot fights with the gun and kills a MiG with it', { timeout: 120_000 }, () => {
    let stores = 0;
    const r = runBalanceMission('c01', 'recruit', 0, flat(0), {
      gunOnly: true,
      onStep: (_w, p) => {
        stores = Math.max(stores, p.stores.reduce((n, s) => n + s.count, 0));
      },
    });
    expect(stores).toBe(0);
    expect(r.playerShots).toBe(0);
    // it doesn't end as Winchester-and-home at the start (it is at home with no missiles)
    expect(r.state).not.toBe('rtb');
    expect(r.gunRounds, JSON.stringify(r)).toBeGreaterThan(0);
    expect(r.playerKills, JSON.stringify(r)).toBeGreaterThan(0);
  });
});
