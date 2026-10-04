import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { Difficulty } from '../src/core/types';
import { flatTerrain, makeWorld, run } from './sim-fakes';

function setup(difficulty: Difficulty) {
  const tw = makeWorld(difficulty, flatTerrain(50));
  const player = tw.world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 6000, 0), heading: 0, speed: 250, loadout: 'a2a_stealth' });
  const enemy = tw.world.spawnAircraft({ type: 'su35', team: 'red', position: new Vector3(0, 6000, -8000), heading: Math.PI, speed: 250 });
  return { tw, player, enemy };
}

describe('applyDamage — difficulty scaling', () => {
  it('recruit: a single missile hit is never fatal from full health (3 hits to kill)', () => {
    const { tw, player, enemy } = setup('recruit');
    tw.world.applyDamage(player, 400, enemy.id, 'r77');
    expect(player.alive).toBe(true);
    expect(player.health).toBeGreaterThan(55);
    tw.world.applyDamage(player, 400, enemy.id, 'r77');
    expect(player.alive).toBe(true);
    tw.world.applyDamage(player, 400, enemy.id, 'r77');
    expect(player.alive).toBe(false);
    expect(tw.of('player:down')).toEqual([{ reason: 'shot' }]);
  });

  it('pilot: first missile hit survivable, second kills', () => {
    const { tw, player, enemy } = setup('pilot');
    tw.world.applyDamage(player, 150, enemy.id, 'm_3m9');
    expect(player.alive).toBe(true);
    expect(player.health).toBeLessThan(80);
    tw.world.applyDamage(player, 150, enemy.id, 'm_3m9');
    expect(player.alive).toBe(false);
  });

  it('ace: a direct SA-6 hit is fatal', () => {
    const { tw, player } = setup('ace');
    const sam = tw.world.spawnSam({ type: 'sa6', team: 'red', position: new Vector3(0, 0, -20000) });
    tw.world.applyDamage(player, 120, sam.id, 'm_3m9');
    expect(player.alive).toBe(false);
    expect(tw.of('destroyed')[0].attackerId).toBe(sam.id);
  });

  it('scales gun damage for the player but not for AI', () => {
    const { tw, player, enemy } = setup('recruit');
    tw.world.applyDamage(player, 10, enemy.id, 'gun');
    expect(player.health).toBeCloseTo(100 - 10 * 0.35, 5);
    tw.world.applyDamage(enemy, 10, player.id, 'gun');
    expect(enemy.health).toBeCloseTo(90, 5);
  });
});

describe('applyDamage — events, credit, subsystems', () => {
  it('credits kills to the attacker and emits damage/destroyed/explosion', () => {
    const { tw, player, enemy } = setup('pilot');
    tw.world.applyDamage(enemy, 40, player.id, 'gun');
    expect(player.kills).toBe(0);
    tw.world.applyDamage(enemy, 200, player.id, 'aim120', enemy.position.clone());
    expect(player.kills).toBe(1);
    expect(player.hits).toBe(0); // hits are counted per shot by the CombatSystem
    expect(enemy.alive).toBe(false);
    expect(enemy.destroyedAt).toBeCloseTo(tw.world.time);
    const destroyed = tw.of('destroyed');
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]).toMatchObject({ attackerId: player.id, weapon: 'aim120' });
    expect(tw.of('damage').length).toBe(2);
    expect(tw.of('explosion').at(-1)).toMatchObject({ size: 'large', surface: 'air' });
    // further damage to a dead entity is ignored
    tw.world.applyDamage(enemy, 200, player.id, 'aim120');
    expect(player.kills).toBe(1);
  });

  it('player:hit carries the direction of the hit point', () => {
    const { tw, player, enemy } = setup('veteran');
    const hp = player.position.clone().add(new Vector3(0, 0, 10)); // from the south (behind)
    tw.world.applyDamage(player, 20, enemy.id, 'gun', hp);
    const hit = tw.of('player:hit')[0];
    expect(hit.amount).toBeCloseTo(20);
    expect(hit.direction!.z).toBeCloseTo(1, 3);
    tw.world.applyDamage(player, 5, enemy.id, 'flak');
    expect(tw.of('player:hit')[1].direction).toBeNull();
  });

  it('missile hits damage subsystems; fire burns and eventually kills with credit', () => {
    const { tw, player, enemy } = setup('pilot');
    // many hits from behind at a sturdy AI target to exercise the subsystem model
    let sawEngine = false;
    let sawOther = false;
    for (let i = 0; i < 20; i++) {
      const t = tw.world.spawnAircraft({ type: 'su27', team: 'red', position: new Vector3(5000 + i * 500, 7000, 0), heading: 0, speed: 250 });
      const behind = t.position.clone().add(new Vector3(0, 0, 8));
      tw.world.applyDamage(t, 60, player.id, 'aim120', behind);
      sawEngine ||= t.damage.engine > 0;
      sawOther ||= t.damage.hydraulics > 0 || t.damage.fuelLeak > 0 || t.damage.avionics > 0 || t.damage.fire;
    }
    expect(sawEngine).toBe(true);
    expect(sawOther).toBe(true);

    enemy.damage.fire = true;
    enemy.sim!.fireTimer = 1e9; // keeps burning
    tw.world.applyDamage(enemy, 90, player.id, 'aim9x');
    expect(enemy.alive).toBe(true);
    run(tw.world, 20, () => !enemy.alive);
    expect(enemy.alive).toBe(false);
    expect(player.kills).toBe(1);
    expect(tw.of('destroyed').at(-1)?.weapon).toBe('aim9x');
  });

  it('SAM sites and ground targets become wrecks that stay in their lists', () => {
    const { tw, player } = setup('pilot');
    const sam = tw.world.spawnSam({ type: 'sa6', team: 'red', position: new Vector3(2000, 0, 2000) });
    const fuel = tw.world.spawnGround({ type: 'fuel', team: 'red', position: new Vector3(-2000, 0, 2000) });
    const jet = tw.world.spawnGround({ type: 'parked_jet', team: 'red', position: new Vector3(-2500, 0, 2000), path: [new Vector3(-2500, 0, 0)] });
    tw.world.applyDamage(sam, 1000, player.id, 'aargm');
    tw.world.applyDamage(fuel, 1000, player.id, 'gbu31');
    tw.world.applyDamage(jet, 1000, player.id, 'gbu39');
    expect(sam.alive).toBe(false);
    expect(sam.radarOn).toBe(false);
    expect(player.kills).toBe(3);
    const ex = tw.of('explosion');
    expect(ex.filter((e) => e.surface === 'ground')).toHaveLength(3);
    expect(ex.some((e) => e.size === 'huge')).toBe(true);
    run(tw.world, 30);
    expect(tw.world.sams).toContain(sam);
    expect(tw.world.ground).toContain(fuel);
    expect(jet.position.z).toBeCloseTo(2000); // dead movers stop
    expect(tw.world.hostilesOf('blue')).not.toContain(sam);
  });

  it('crash shortly after being hit credits the attacker (manoeuvring kill)', () => {
    const tw = makeWorld('pilot', flatTerrain(0));
    const player = tw.world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 6000, 0), heading: 0, speed: 250 });
    const bandit = tw.world.spawnAircraft({ type: 'mig29', team: 'red', position: new Vector3(0, 300, -9000), heading: 0, speed: 250 });
    tw.world.applyDamage(bandit, 5, player.id, 'gun');
    run(tw.world, 10, () => {
      bandit.input.pitch = -1;
      return !bandit.alive;
    });
    expect(bandit.alive).toBe(false);
    expect(player.kills).toBe(1);
  });
});
