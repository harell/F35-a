/**
 * MISSIONS — Instant Action balance (issue #60), on the ids the bot sweep flies
 * (`ia_<mode>_auckland`, seeded from the id, so these numbers reproduce):
 *  - the wingman (Viper 2) can't win Defend or Dogfight for a player who never fires: it holds
 *    fire until the player has fired, and in Defend it never takes the strikers;
 * Sweep: npx vite-node tools/playtest/bot-sweep.ts -- --missions=ia_strike_auckland,ia_sam_gauntlet_auckland,ia_dogfight_auckland,ia_defend_auckland --diffs=recruit,pilot,veteran,ace --seeds=6
 */
import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../src/core/data';
import { EventBus } from '../src/core/events';
import type { Difficulty } from '../src/core/types';
import type { TerrainQuery } from '../src/sim/api';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createAiBrain } from '../src/ai';
import { createMissionRunner, missionById, terrainPadsFor } from '../src/missions';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { MissionBot } from './missions-bot';
import { makeAiWorld, runFor, v3 } from './ai-helpers';

const terrains = new Map<string, TerrainQuery>();
function terrainFor(id: string): TerrainQuery {
  let t = terrains.get(id);
  if (!t) {
    const def = missionById(id)!;
    t = new TerrainQueryImpl(runSync(generateTerrain({ theater: def.theater, seed: def.seed, resolution: 512, features: allFeatures(def.theater, []), pads: terrainPadsFor(def) })));
    terrains.set(id, t);
  }
  return t;
}

/**
 * The competent bot flies the mission (navigates, designates, defends), but its triggers are cut:
 * it never fires a missile, a bomb or the gun. Returns how the mission ended and who killed what.
 */
function noFireRun(id: string, diff: Difficulty, seed: number, maxT = 600) {
  const def = missionById(id)!;
  const events = new EventBus();
  const d = DIFFICULTIES[diff];
  const world = createSimWorld({ terrain: terrainFor(id), difficulty: d, events, combat: createCombatSystemSeeded(seed) });
  const runner = createMissionRunner({ ...def, seed: def.seed + seed * 101 }, { createAi: createAiBrain, difficulty: d, events });
  runner.setup(world, def.recommendedLoadout);
  const p = world.player!;
  const bot = new MissionBot(runner, world, p, { rearm: false });
  let playerShots = 0;
  let wingKills = 0;
  events.on('munition:launch', (e) => {
    if (e.shooter === p) playerShots++;
  });
  events.on('destroyed', (e) => {
    const by = world.getEntity(e.attackerId);
    if (e.entity.kind === 'aircraft' && e.entity.team === 'red' && by && by.kind === 'aircraft' && by.team === 'blue' && by !== p) wingKills++;
  });
  const dt = 1 / 60;
  for (let i = 0; i < maxT * 60 && runner.state === 'running'; i++) {
    if (i % 3 === 0 && p.alive) bot.update(dt * 3);
    p.input.fireWeapon = false;
    p.input.fireGun = false;
    world.step(dt);
    runner.update(world, dt);
  }
  return { state: runner.state, t: Math.round(world.time), playerShots, wingKills, gunAmmo: p.gunAmmo };
}

describe('Instant Action: the wingman supports, it does not win the mission (issue #60)', () => {
  it('the Dogfight and Defend wingmen hold fire until the player fires; the Defend one never takes the strikers', () => {
    const dog = missionById('ia_dogfight_auckland')!.script.groups.find((g) => g.role === 'wingman')!;
    expect(dog.orders?.holdFireUntilPlayerFires).toBe(true);
    const def = missionById('ia_defend_auckland')!.script.groups.find((g) => g.role === 'wingman')!;
    expect(def.orders?.holdFireUntilPlayerFires).toBe(true);
    expect(def.orders?.ignoreGroups).toContain('strikers');
  });

  it('a holding wingman stays on the wing past a bandit at 14 km, and engages it once the player has fired', () => {
    const tw = makeAiWorld('pilot', undefined, 8);
    const w = tw.world;
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 4_000, 0), heading: 0, speed: 240, isPlayer: true, callsign: 'Viper 1', loadout: 'a2a_stealth' });
    const wm = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(80, 4_000, 60), heading: 0, speed: 240, callsign: 'Viper 2', leaderId: p.id, ai: createAiBrain('wingman', { skill: 0.8, seed: 3, orders: { holdFireUntilPlayerFires: true } }) });
    const bandit = w.spawnAircraft({ type: 'su27', team: 'red', position: v3(3_000, 4_000, -14_000), heading: Math.PI, speed: 240, ai: createAiBrain('fighter', { skill: 0.1, seed: 5 }) });
    bandit.stores.forEach((st) => (st.count = 0));
    bandit.gunAmmo = 0;
    runFor(w, 40);
    expect(tw.launches.filter((l) => l.shooter === wm)).toEqual([]);
    expect((wm.ai as unknown as { target: number | null }).target).toBeNull();
    // the player opens fire (one gun burst is enough)
    p.gunAmmo -= 20;
    runFor(w, 90, () => !bandit.alive);
    expect(tw.launches.some((l) => l.shooter === wm && l.targetId === bandit.id) || !bandit.alive).toBe(true);
  });

  it('an ordered wingman never targets an ignored group', () => {
    const tw = makeAiWorld('pilot', undefined, 8);
    const w = tw.world;
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 4_000, 0), heading: 0, speed: 240, isPlayer: true, callsign: 'Viper 1', loadout: 'a2a_stealth' });
    const wm = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(80, 4_000, 60), heading: 0, speed: 240, callsign: 'Viper 2', leaderId: p.id, ai: createAiBrain('wingman', { skill: 0.8, seed: 3, orders: { ignoreGroups: ['strikers'] } }) });
    const striker = w.spawnAircraft({ type: 'su27', team: 'red', position: v3(3_000, 4_000, -12_000), heading: Math.PI, speed: 240, groupId: 'strikers', ai: createAiBrain('fighter', { skill: 0.1, seed: 5 }) });
    striker.stores.forEach((st) => (st.count = 0));
    striker.gunAmmo = 0;
    runFor(w, 40);
    expect(tw.launches.filter((l) => l.shooter === wm)).toEqual([]);
    expect(striker.alive).toBe(true);
  });

  // The bot flies to the fight (it designates and defends) but never pulls a trigger. Before
  // issue #60 Viper 2 won Dogfight on Recruit alone (4 of 6 bot wins had 0 player kills) and
  // Defend (the playtest's 'VIPER 2: SPLASH SU-27').
  for (const id of ['ia_dogfight_auckland', 'ia_defend_auckland']) {
    it(`${id}: a player who never fires does not win (Recruit and Pilot, 3 seeds each)`, { timeout: 240_000 }, () => {
      const log: string[] = [];
      for (const diff of ['recruit', 'pilot'] as const) {
        for (const seed of [0, 1, 2]) {
          const r = noFireRun(id, diff, seed);
          log.push(`${diff} seed ${seed}: ${r.state}@${r.t}s, player shots ${r.playerShots}, wingman kills ${r.wingKills}`);
          expect(r.playerShots, log.join('\n')).toBe(0);
          expect(r.state, log.join('\n')).not.toBe('success');
          expect(r.wingKills, log.join('\n')).toBe(0);
        }
      }
    });
  }
});
