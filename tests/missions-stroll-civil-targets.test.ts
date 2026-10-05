/**
 * A Stroll in the Park: the player can box every kind of civil traffic that moves (AeroFlop airliners, container ships,
 * cruise liners and a crude carrier), while the harbour ferries stay scenery in every mission and mode: never a sim
 * entity, so never on a sensor and never targetable (render/traffic/HarbourFerries.ts).
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import { createAiBrain } from '../src/ai';
import { CAMPAIGNS, TRAINING, buildInstantMissionSeeded, createMissionRunner } from '../src/missions';
import type { InstantActionOptions, MissionDef } from '../src/core/contracts';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { setQuatFromHPR } from '../src/sim/flight/attitude';
import type { Entity } from '../src/sim/entities';
import { FERRY_LENGTH } from '../src/render/traffic/ferryRoutes';
import { VESSEL_DATA } from '../src/sim/damage/tables';
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

describe('A Stroll in the Park: civil targets', () => {
  it('every merchant class sails (container, cruise, tanker) and the player can designate each, and an airliner', () => {
    const m = sortie(instant('stroll'));
    m.tick(40); // the first departure is off the runway
    const ships = m.world.ground.filter((g) => g.type === 'ship' && g.team === 'neutral');
    expect(new Set(ships.map((g) => g.vessel))).toEqual(new Set(['container', 'cruise', 'tanker']));
    const airliner = m.world.aircraft.find((a) => a.civil && a.alive)!;
    expect(airliner).toBeTruthy();
    const targets: Entity[] = [airliner, ...['container', 'cruise', 'tanker'].map((v) => ships.find((g) => g.vessel === v)!)];
    const p = m.world.player!;
    for (const t of targets) {
      // 3 km short of it, nose on, where the player's own sensors track it
      const at = t.position.clone();
      const from = at.clone().add(new Vector3(-3000, 0, 0));
      from.y = Math.max(600, at.y);
      p.position.copy(from);
      setQuatFromHPR(p.quaternion, Math.PI / 2, Math.atan2(at.y - from.y, 3000), 0);
      m.tick(1);
      m.world.combat.designate(p, t.id, m.world);
      expect(p.radar.designatedId, `${t.kind} ${t.id}`).toBe(t.id);
    }
    m.runner.dispose?.();
  });

  it('no mission or mode makes a harbour ferry a sim entity', () => {
    const defs: MissionDef[] = [
      ...(['stroll', 'dogfight', 'sam_gauntlet', 'strike', 'defend'] as const).map(instant),
      ...TRAINING,
      ...CAMPAIGNS.flatMap((c) => c.missions),
    ];
    const smallest = Math.min(...Object.values(VESSEL_DATA).map((v) => v.length));
    expect(smallest).toBeGreaterThan(FERRY_LENGTH * 3);
    for (const def of defs) {
      const m = sortie(def);
      for (const g of m.world.ground) {
        if (g.team === 'neutral') expect(['container', 'cruise', 'tanker'], `${def.id}: ${g.name}`).toContain(g.vessel);
      }
      m.runner.dispose?.();
    }
  });
});
