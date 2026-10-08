/**
 * Civil traffic toggle (key I): off at the start of a combat sortie, on in A Stroll in the Park. Hidden civil traffic
 * has no box and TGT never steps to it; civil traffic a protect objective covers (g02's tanker) stays shown either way.
 */
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import { createAiBrain } from '../src/ai';
import { buildInstantMissionSeeded, createMissionRunner, missionById } from '../src/missions';
import type { InstantActionOptions, MissionDef } from '../src/core/contracts';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { civilHidden } from '../src/sim/entities';
import { G02_TANKER } from '../src/missions/content/irgcHauraki';
import { FlatTerrain } from './combat-helpers';

const DT = 1 / 60;

const instant = (mode: InstantActionOptions['mode']) =>
  buildInstantMissionSeeded({ mode, theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 2 }, 5);

function sortie(def: MissionDef) {
  const events = new EventBus();
  const world = createSimWorld({ terrain: new FlatTerrain(-20), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(1) });
  const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty: DIFFICULTIES.pilot, events });
  runner.setup(world, def.recommendedLoadout);
  const tick = (seconds: number) => {
    for (let i = 0; i < seconds * 60; i++) {
      world.step(DT);
      runner.update(world, DT);
    }
  };
  return { world, runner, tick };
}

describe('civil traffic toggle', () => {
  it('starts shown in A Stroll in the Park and hidden in a combat sortie', () => {
    const stroll = sortie(instant('stroll'));
    expect(stroll.world.player!.civilShown).toBe(true);
    stroll.runner.dispose?.();
    const dogfight = sortie(instant('dogfight'));
    const p = dogfight.world.player!;
    expect(p.civilShown).toBe(false);
    const airliner = dogfight.world.aircraft.find((a) => a.civil)!;
    expect(civilHidden(p, airliner)).toBe(true);
    // never hides a hostile
    const bandit = dogfight.world.aircraft.find((a) => a.team === 'red')!;
    expect(civilHidden(p, bandit)).toBe(false);
    dogfight.runner.dispose?.();
  });

  it('hidden civil traffic is never stepped to by TGT, shown it is', () => {
    const m = sortie(instant('stroll'));
    const p = m.world.player!;
    const start = p.position.clone();
    for (let t = 0; t < 60; t++) {
      p.position.copy(start);
      m.tick(1);
    }
    expect(p.radar.contacts.some((c) => c.team === 'neutral')).toBe(true);
    p.civilShown = false;
    for (let i = 0; i < 4; i++) m.world.combat.cycleTarget(p, m.world);
    expect(p.radar.designatedId).toBeNull();
    p.civilShown = true;
    m.world.combat.cycleTarget(p, m.world);
    expect(p.radar.designatedId).not.toBeNull();
    m.runner.dispose?.();
  });

  it("g02's escorted tanker stays shown with civil traffic hidden", () => {
    const m = sortie(missionById('g02')!);
    const p = m.world.player!;
    expect(p.civilShown).toBe(false);
    const tanker = m.world.ground.find((g) => g.groupId === G02_TANKER.group)!;
    expect(tanker.team).toBe('neutral');
    expect(tanker.missionCivil).toBe(true);
    expect(civilHidden(p, tanker)).toBe(false);
    // the Gulf's other civil shipping is hidden
    for (const g of m.world.ground) if (g.team === 'neutral' && g !== tanker) expect(civilHidden(p, g), g.name).toBe(true);
    m.runner.dispose?.();
  });
});
