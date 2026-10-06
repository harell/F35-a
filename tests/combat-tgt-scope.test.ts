/**
 * TGT steps through the selected weapon's targets (owner, 2026-10-06): air tracks with an A/A missile,
 * surface tracks with an A/G weapon, both with the gun (nearest in front first). FIRE with the box on
 * the wrong kind of target names it ('AIR TGT: GUN OR A-A') instead of a bare 'NO TARGET'.
 * Played on the stroll: no hostiles, only civil traffic (airliners, helicopters, ships, trains).
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { WeaponId } from '../src/core/types';
import { forwardOf } from '../src/core/math';
import { DIFFICULTIES } from '../src/core/data';
import { EventBus } from '../src/core/events';
import { createAiBrain } from '../src/ai';
import { buildInstantMissionSeeded, createMissionRunner } from '../src/missions';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { FlatTerrain } from './combat-helpers';

const DT = 1 / 60;

function setup(loadout: 'beast' | 'sead' = 'beast') {
  const def = buildInstantMissionSeeded({ mode: 'stroll', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 8 }, 7);
  const events = new EventBus();
  const world = createSimWorld({ terrain: new FlatTerrain(0), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(1) });
  const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty: DIFFICULTIES.pilot, events });
  runner.setup(world, loadout === 'sead' ? 'sead_precision' : 'strike_beast');
  const denied: string[] = [];
  events.on('weapon:denied', (e) => denied.push(e.reason));
  for (let i = 0; i < 120; i++) {
    world.step(DT);
    runner.update(world, DT);
  }
  const p = world.player!;
  /** The kinds TGT steps through with `weapon` selected, over enough presses to go round. */
  const cycled = (weapon: WeaponId) => {
    world.combat.selectWeapon(p, weapon, world);
    world.combat.designate(p, null, world);
    const ids: number[] = [];
    for (let k = 0; k < 2 * p.radar.contacts.length + 2; k++) {
      world.combat.cycleTarget(p, world);
      if (p.radar.designatedId !== null && !ids.includes(p.radar.designatedId)) ids.push(p.radar.designatedId);
    }
    return ids.map((id) => world.getEntity(id)!);
  };
  return { world, p, cycled, denied };
}

describe('TGT follows the selected weapon', () => {
  it('an A/A missile steps through air tracks only, helicopters included', () => {
    const { cycled } = setup();
    const got = cycled('aim120');
    expect(got.length).toBeGreaterThan(1);
    expect(got.every((e) => e.kind === 'aircraft')).toBe(true);
    expect(got.some((e) => e.kind === 'aircraft' && e.heli)).toBe(true);
  });

  it('an A/G weapon steps through surface tracks only', () => {
    const { cycled } = setup();
    const got = cycled('gbu31');
    expect(got.length).toBeGreaterThan(1);
    expect(got.every((e) => e.kind === 'ground' || e.kind === 'sam')).toBe(true);
  });

  it('the gun steps through air and surface tracks, the nearest in front first', () => {
    const { p, cycled } = setup();
    const got = cycled('gun');
    expect(got.some((e) => e.kind === 'aircraft')).toBe(true);
    expect(got.some((e) => e.kind === 'ground')).toBe(true);
    // all civil, so the order is in front (±60°) first, then by range
    const fwd = forwardOf(p.quaternion, new Vector3());
    const key = (e: (typeof got)[number]) => {
      const rel = e.position.clone().sub(p.position);
      const d = rel.length();
      return (rel.dot(fwd) / d >= 0.5 ? 1e7 : 0) - d;
    };
    for (let i = 1; i < got.length; i++) expect(key(got[i - 1])).toBeGreaterThanOrEqual(key(got[i]) - 500);
  });
});

describe('FIRE with the box on the wrong kind of target', () => {
  it('an AARGM on a locked airliner is denied naming the fix (the owner could not shoot an A320)', () => {
    const { world, p, denied } = setup('sead');
    world.combat.selectWeapon(p, 'aargm', world);
    const airliner = world.aircraft.find((a) => a.civil)!;
    world.combat.designate(p, airliner.id, world);
    expect(world.combat.fire(p, world)).toBeNull();
    expect(denied.at(-1)).toBe('AIR TGT: GUN OR A-A');
  });

  it('an AIM-120 on a ship is denied naming the fix', () => {
    const { world, p, denied } = setup();
    world.combat.selectWeapon(p, 'aim120', world);
    const ship = p.radar.contacts.find((c) => world.getEntity(c.id)?.kind === 'ground')!;
    world.combat.designate(p, ship.id, world);
    expect(world.combat.fire(p, world)).toBeNull();
    expect(denied.at(-1)).toBe('GND TGT: GUN OR A-G');
  });
});
