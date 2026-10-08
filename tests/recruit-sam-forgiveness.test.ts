/**
 * Recruit against SAMs (player feedback 2026-10-08: stuck at g02 on Recruit, "struggling to evade the
 * missiles"). An air-defence boat's two-round salvo took two of Recruit's three hits at once, and the
 * automatic countermeasure program covered air-to-air missiles only. Now:
 *  - a salvo counts as one hit: missile damage within DifficultyParams.playerMissileHitGrace of the
 *    last missile hit does nothing (Recruit only);
 *  - Recruit's auto-CMDS answers a SAM round with two timed salvos (AUTO_SAM_PULSES), not a held
 *    program that emptied the dispenser on the first round.
 * The bands were measured with a "novice" bot (no climb, release close in) in g02 and g03's intended
 * route (bot-sweep --route=golden): see the PR for the tables.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { AUTO_SAM_PULSES } from '../src/sim/weapons/countermeasures';
import { flatLand } from './missions-helpers';
import { FakeWorld, FlatTerrain, v3 } from './combat-helpers';
import type { Difficulty } from '../src/core/types';

function jetIn(diff: Difficulty) {
  const world = createSimWorld({ terrain: flatLand(0), difficulty: DIFFICULTIES[diff], events: new EventBus(), combat: createCombatSystemSeeded(1) });
  const p = world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 3000, 0), heading: 0, speed: 250, loadout: 'a2a_stealth', fuel: 0.6 });
  const step = (s: number) => {
    for (let i = 0; i < s * 60; i++) world.step(1 / 60);
  };
  return { world, p, step };
}

describe('Recruit: a SAM salvo counts as one hit', () => {
  it('a second round 1.5 s after the first does no damage on Recruit; one 4 s later does', () => {
    const { world, p, step } = jetIn('recruit');
    step(0.5);
    world.applyDamage(p, 200, null, 'm_9m330');
    expect(p.health).toBeLessThan(p.maxHealth);
    step(1.5);
    // (compared just before each round: the first hit may have started a fire that keeps burning)
    let before = p.health;
    world.applyDamage(p, 200, null, 'm_9m330');
    expect(p.health).toBe(before);
    step(2.5);
    before = p.health;
    world.applyDamage(p, 200, null, 'm_igla');
    expect(p.health).toBeLessThan(before - 20);
    // still three separate hits to kill
    expect(p.alive).toBe(true);
  });

  it('the grace is Recruit only, and only for missiles (gun and collision damage still land)', () => {
    const pilot = jetIn('pilot');
    pilot.step(0.5);
    pilot.world.applyDamage(pilot.p, 30, null, 'm_9m330');
    pilot.step(1.5);
    const h1 = pilot.p.health;
    pilot.world.applyDamage(pilot.p, 30, null, 'm_9m330');
    expect(pilot.p.health).toBeLessThan(h1 - 10);
    expect(DIFFICULTIES.pilot.playerMissileHitGrace).toBeUndefined();
    expect(DIFFICULTIES.veteran.playerMissileHitGrace).toBeUndefined();

    const rec = jetIn('recruit');
    rec.step(0.5);
    rec.world.applyDamage(rec.p, 200, null, 'm_9m330');
    rec.step(0.5);
    const r1 = rec.p.health;
    rec.world.applyDamage(rec.p, 20, null, 'gun');
    expect(rec.p.health).toBeLessThan(r1 - 5);
  });
});

describe('Recruit: auto-CMDS against a SAM round', () => {
  /** An undefended jet flying at an AD boat; chaff and flares spent per round fired at it. */
  function run(diff: Difficulty, seed: number) {
    const w = new FakeWorld({ difficulty: diff, seed, terrain: new FlatTerrain(0) });
    w.spawnSam({ type: 'ad_boat', team: 'red', position: v3(0, 0, 0) });
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 2000, -9000), heading: Math.PI, speed: 230, loadout: 'a2a_beast' });
    const cm0 = p.chaff + p.flares;
    let rounds = 0;
    w.events.on('munition:launch', (e) => {
      if (e.targetId === p.id) rounds++;
    });
    const apply = w.applyDamage.bind(w);
    w.applyDamage = (target, amount, attackerId, weapon) => {
      if (target !== p) apply(target, amount, attackerId, weapon); // keep the jet flying
    };
    w.run(40);
    return { rounds, spent: cm0 - p.chaff - p.flares, left: p.chaff };
  }

  it('two salvos a round on Recruit (the dispenser outlasts the boat), none on Pilot', () => {
    let rounds = 0;
    let spent = 0;
    for (let s = 0; s < 4; s++) {
      const r = run('recruit', 300 + s);
      rounds += r.rounds;
      spent += r.spent;
    }
    expect(rounds).toBeGreaterThan(4);
    expect(spent).toBeGreaterThan(0);
    // two pulses of two decoys each, at most (overlapping rounds share a pulse)
    expect(spent).toBeLessThanOrEqual(rounds * AUTO_SAM_PULSES.length * 2);
    const pilot = run('pilot', 300);
    expect(pilot.rounds).toBeGreaterThan(0);
    expect(pilot.spent).toBe(0);
  });
});
