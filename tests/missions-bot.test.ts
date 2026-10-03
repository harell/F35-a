/**
 * MISSIONS — gaps in the scripted competent player (tests/missions-bot.ts) that hid balance
 * questions in playtest r1-1:
 *  - 1.1-k: it never used the GBU-53/B StormBreaker, so a strike_sdb2 loadout dropped nothing
 *    (0 wins in 16 runs, 7 HUNG);
 *  - 1.1-l: its rearm leg always flew to Whenuapai, so in the procedural Instant Action theatres
 *    (rearm at the scenery's first airbase) it never rearmed (16 of 17 HUNG rows in an IA sweep).
 *    Those theatres are gone (issue #73), and so is rearming (issue #63): out of weapons, the bot
 *    now flies home to Whenuapai and stays out of the fight;
 *  - 1.1-m: `ia_<mode>_<theater>` ids built a fresh random mission on every missionById() call,
 *    so the same id, difficulty and seed gave different runs (and the sweep built the terrain
 *    from one mission and flew another).
 * and in playtest 2026-10-02 r4:
 *  - 4.3-f (#69): the air-to-air PlayerBot (tests/ai-playerbot.ts) never fired its gun (0 of 180
 *    rounds in 6 gun-only runs on Pilot), so gun balance couldn't be measured.
 * Sweeps: npx vite-node tools/playtest/bot-sweep.ts -- --missions=c04,c06,t03 --loadout=strike_sdb2
 */
import { describe, expect, it } from 'vitest';
import { Autopilot } from '../src/ai/pilot/Autopilot';
import { buildInstantMission, missionById, terrainPadsFor } from '../src/missions';
import { AKL } from '../src/core/auckland';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import type { TerrainQuery } from '../src/sim/api';
import { CRIPPLED_FRACTION, MissionBot, OUT_THREAT_RANGE, homeBase, outOfFightAction, runPlaythrough, shouldEgress } from './missions-bot';
import { harness } from './missions-helpers';
import type { AircraftEntity } from '../src/sim/entities';
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
    expect(JSON.stringify(missionById('ia_defend_auckland'))).not.toBe(JSON.stringify(a));
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

describe('1.1-l: out of weapons, the bot goes home (no rearming, issue #63)', () => {
  it('Auckland, the only theatre: home is Whenuapai for campaign and Instant Action missions', () => {
    for (const id of ['c04', 'ia_strike_auckland', 'ia_sam_gauntlet_auckland']) {
      expect(homeBase(missionById(id)!), id).toMatchObject({ x: AKL.whenuapai.x, z: AKL.whenuapai.z, name: 'Whenuapai' });
    }
  });
  it('c04 Recruit: Winchester after the strike, the bot flies to Whenuapai and is never rearmed', { timeout: 60_000 }, () => {
    const def = missionById('c04')!;
    const home = homeBase(def);
    const r = runPlaythrough(def, 'recruit', 0, terrainFor('c04'), { maxT: 620, log: true });
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

  it('gun-only probe (c01, Recruit): no missiles all mission long, and the pilot fights with the gun', { timeout: 240_000 }, async () => {
    // a mission-level check of the harness; the gun steering itself is pinned by the trail
    // chases above. Rounds fired per seed (2026-10-02): 26 (and a gun kill), 0, 0, 0, 0, 18 (and
    // a kill) — so the assertion is "some seed fires", not any one seed.
    const rows: string[] = [];
    let rounds = 0;
    for (const seed of [0, 1, 2, 3, 4, 5]) {
      // yield between runs: a worker blocked for long stretches can trip vitest's RPC timeout
      await new Promise((r) => setTimeout(r, 0));
      let stores = 0;
      const r = runBalanceMission('c01', 'recruit', seed, flat(0), {
        gunOnly: true,
        onStep: (_w, p) => {
          stores = Math.max(stores, p.stores.reduce((n, s) => n + s.count, 0));
        },
      });
      expect(stores, `seed ${seed}`).toBe(0);
      expect(r.playerShots, `seed ${seed}`).toBe(0);
      // it doesn't end as Winchester-and-home at the start (it is at home with no missiles)
      expect(r.state, `seed ${seed}`).not.toBe('rtb');
      rounds += r.gunRounds;
      rows.push(`seed ${seed}: ${r.state} t=${r.t.toFixed(0)} rounds=${r.gunRounds} kills=${r.playerKills}`);
    }
    expect(rounds, rows.join('; ')).toBeGreaterThan(0);
  });

  it('gun-only probe on Pilot (c01, ia_dogfight_auckland): no missiles, and c01 fights reach the gun (was 0 rounds)', { timeout: 300_000 }, async () => {
    // the playtest's probe (#69): missile stores zeroed every step, rtbWhenWinchester false. The
    // bot used to lose every fight before a gun shot: crippled by a head-on R-27 or R-73 in the
    // first merge, then 9 g pursuit down to 100 m/s. Rounds fired per seed on a flat sea
    // (2026-10-02): c01 0, 102, 0, 0, 102 (a gun kill), 6, so the assertion is "some c01 seed
    // fires", not any one seed. ia_dogfight_auckland fires on 1 seed of 0-15 (seed 8, 6 rounds:
    // the a2a_beast wingman often splashes all four first, or the bot dies in a four-ship merge),
    // so its rounds aren't asserted; its rows (the playtest's seeds) check that no missile flies.
    const probe: [string, number[]][] = [
      ['c01', [0, 1, 2, 3, 4, 5]],
      ['ia_dogfight_auckland', [1, 2, 3]],
    ];
    const rows: string[] = [];
    let c01Rounds = 0;
    for (const [id, seeds] of probe)
      for (const seed of seeds) {
        await new Promise((r) => setTimeout(r, 0)); // yield: vitest's worker RPC times out on long blocks
        const r = runBalanceMission(id, 'pilot', seed, flat(0), { gunOnly: true });
        expect(r.playerShots, `${id} seed ${seed}`).toBe(0);
        if (id === 'c01') c01Rounds += r.gunRounds;
        rows.push(`${id} seed ${seed}: ${r.state} t=${r.t.toFixed(0)} rounds=${r.gunRounds} kills=${r.playerKills}`);
      }
    expect(c01Rounds, rows.join('; ')).toBeGreaterThan(0);
  });
});

describe('#63: out of the fight (no rearming) — Winchester with a bandit close, and a crippled jet', () => {
  it('outOfFightAction: shoot with what is left, gun a merge, run from a close or hot bandit, else go home', () => {
    const a = (aa: number, gunAmmo: number, banditD: number | null, hot = false) => outOfFightAction({ aa, gunAmmo, banditD, hot });
    expect(a(0, 180, null)).toBe('home');
    expect(a(0, 180, OUT_THREAT_RANGE + 1_000, true)).toBe('home');
    // an AIM-9X left: the bandit is shot, not given our tail
    expect(a(1, 180, 7_000)).toBe('air');
    expect(a(1, 180, 20_000)).toBe('home');
    expect(a(1, 180, 20_000, true)).toBe('air');
    // nothing but the gun: a merge is fought, anything further off or closing fast is run from low
    expect(a(0, 180, 2_000)).toBe('guns');
    expect(a(0, 0, 2_000)).toBe('extend');
    expect(a(0, 180, 7_000)).toBe('extend');
    expect(a(0, 180, 20_000, true)).toBe('extend');
    expect(a(0, 180, 20_000)).toBe('home');
  });

  it('shouldEgress: below a quarter of its health', () => {
    expect(CRIPPLED_FRACTION).toBe(0.25);
    expect(shouldEgress({ health: 20, maxHealth: 100 } as AircraftEntity)).toBe(true);
    expect(shouldEgress({ health: 30, maxHealth: 100 } as AircraftEntity)).toBe(false);
  });

  /** ia_sam_gauntlet_auckland (stub AI, flat land): a MiG-29 `R` m ahead of the bot, nose on it; the bot's modes over `secs` s. */
  function closeBandit(R: number, opts: { missiles: boolean; secs: number }): { modes: Set<string>; away: number; agl0: number; agl: number } {
    const h = harness(missionById('ia_sam_gauntlet_auckland')!);
    const p = h.world.player!;
    for (const s of p.stores) if (!opts.missiles || (s.weapon !== 'aim120' && s.weapon !== 'aim9x')) s.count = 0;
    const fwd = v3(p.velocity.x, 0, p.velocity.z).normalize();
    const heading = Math.atan2(fwd.x, -fwd.z);
    const mig = h.world.spawnAircraft({ type: 'mig29', team: 'red', position: p.position.clone().addScaledVector(fwd, R), heading: heading + Math.PI, speed: 230 });
    const bot = new MissionBot(h.runner, h.world, p);
    const modes = new Set<string>();
    h.run(0.5); // the radar picks the bandit up
    const agl0 = p.flight.agl;
    for (let i = 0; i < opts.secs * 20; i++) {
      bot.update(0.05);
      modes.add(bot.mode);
      h.run(0.05);
    }
    // where the bot is flying relative to the bandit: > 0 = away from it
    const away = v3(p.position.x - mig.position.x, 0, p.position.z - mig.position.z).normalize().dot(v3(p.velocity.x, 0, p.velocity.z).normalize());
    return { modes, away, agl0, agl: p.flight.agl };
  }

  it('Winchester, MiG-29 in a merge (2 km): the bot guns it instead of turning for home', () => {
    const r = closeBandit(2_000, { missiles: false, secs: 1 });
    expect([...r.modes]).toContain('GUNS');
    expect(r.modes.has('RTB')).toBe(false);
  });

  it('Winchester, MiG-29 closing from 8 km: the bot extends low, away from it, instead of flying home past it', () => {
    const r = closeBandit(8_000, { missiles: false, secs: 15 });
    expect([...r.modes]).toEqual(['EXTEND']);
    expect(r.away, 'flying away from the bandit').toBeGreaterThan(0.5);
    expect(r.agl, `descending from ${Math.round(r.agl0)} m`).toBeLessThan(r.agl0 - 400);
  });

  it('bombs gone, AMRAAMs left, MiG-29 at 8 km: the bot shoots it instead of going home (was a straight RTB)', () => {
    const r = closeBandit(8_000, { missiles: true, secs: 1 });
    expect([...r.modes]).toEqual(['AIR']);
  });

  it('crippled (hp 20) on a strike: stops attacking and egresses, with or without a wingman left', () => {
    for (const wingman of [true, false]) {
      const h = harness(missionById('ia_strike_auckland')!);
      const p = h.world.player!;
      for (const a of h.world.aircraft) if (a !== p && a.team === p.team) a.alive = false;
      if (wingman) h.world.spawnAircraft({ type: 'f35a', team: p.team, position: p.position.clone().add(v3(500, 0, 500)), heading: 0, speed: 230 });
      p.health = 20;
      const bot = new MissionBot(h.runner, h.world, p);
      const modes = new Set<string>();
      for (let i = 0; i < 20; i++) {
        bot.update(0.05);
        modes.add(bot.mode);
        h.run(0.05);
      }
      expect([...modes], wingman ? 'with a wingman' : 'alone').toEqual(['CRIPPLED']);
    }
  });
});
