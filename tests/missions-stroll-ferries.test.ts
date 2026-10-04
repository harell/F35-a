/**
 * A Stroll in the Park: the harbour ferries are sim ships the player can box and shoot (missions/runtime/shipping.ts),
 * sailing their render timetable (render/traffic/ferryRoutes.ts) so the drawn ferry and the sim's one are the same boat.
 * In wartime they stay scenery: no sim entity at all.
 */
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import { createAiBrain } from '../src/ai';
import { buildInstantMissionSeeded, createMissionRunner } from '../src/missions';
import { FERRY_NAMES } from '../src/missions/runtime/shipping';
import { FERRY_FLEET, ferryAt, ferryRoutes, type FerryState } from '../src/render/traffic/ferryRoutes';
import { VESSEL_DATA } from '../src/sim/damage/tables';
import { vesselNoun } from '../src/sim/civil/vessels';
import type { InstantActionOptions } from '../src/core/contracts';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { FlatTerrain } from './combat-helpers';

const DT = 1 / 60;

function sortie(mode: InstantActionOptions['mode']) {
  const def = buildInstantMissionSeeded({ mode, theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 2 }, 5);
  const events = new EventBus();
  const world = createSimWorld({ terrain: new FlatTerrain(-20), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(1) });
  const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty: DIFFICULTIES.pilot, events });
  runner.setup(world, def.recommendedLoadout);
  const radio: string[] = [];
  events.on('radio', (e) => radio.push(e.text));
  const tick = (seconds: number) => {
    for (let i = 0; i < seconds * 60; i++) {
      world.step(DT);
      runner.update(world, DT);
    }
  };
  const ferries = () => world.ground.filter((g) => g.vessel === 'ferry');
  return { world, runner, tick, ferries, radio };
}

describe('the stroll’s harbour ferries', () => {
  it('the whole fleet: neutral ships, drawn by HarbourFerries (scenery), one slot each, named', () => {
    const m = sortie('stroll');
    const f = m.ferries();
    expect(f).toHaveLength(FERRY_FLEET.length);
    expect(f.map((g) => g.ferrySlot).sort((a, b) => a - b)).toEqual(FERRY_FLEET.map((_, i) => i));
    for (const g of f) {
      expect(g).toMatchObject({ type: 'ship', team: 'neutral', groupId: 'civil-ship', scenery: true, alive: true });
      expect(FERRY_NAMES).toContain(g.name);
    }
    expect(vesselNoun('ferry')).toBe('ferry');
    expect(VESSEL_DATA.ferry.length).toBe(34);
  });

  it('they sail the timetable the renderer draws, minute after minute', () => {
    const m = sortie('stroll');
    const routes = ferryRoutes();
    const st: FerryState = { x: 0, z: 0, heading: 0, speed: 0, dock: -1 };
    let moving = 0;
    for (let k = 0; k < 4; k++) {
      m.tick(30);
      for (const g of m.ferries()) {
        const slot = FERRY_FLEET[g.ferrySlot];
        ferryAt(routes[slot.route], slot.k, m.world.time, st);
        expect(Math.hypot(g.position.x - st.x, g.position.z - st.z)).toBeLessThan(0.01);
        expect(g.position.y).toBe(0);
        expect(g.velocity.length()).toBeCloseTo(Math.abs(st.speed), 3);
        if (st.speed > 1) moving++;
      }
    }
    expect(moving).toBeGreaterThan(10);
  });

  it('the player can designate one and the gun sinks it; Darkstar names it and it stops where it went down', () => {
    const m = sortie('stroll');
    m.tick(20);
    const p = m.world.player!;
    const g = m.ferries().find((x) => x.velocity.length() > 3)!;
    // within the EOTS's reach the player's own sensors track it
    p.position.set(g.position.x - 3000, 600, g.position.z);
    m.tick(1);
    m.world.combat.designate(p, g.id, m.world);
    expect(p.radar.designatedId).toBe(g.id);
    for (let i = 0; i < 20 && g.alive; i++) m.world.applyDamage(g, 30, p.id, 'gun', g.position.clone());
    expect(g.alive).toBe(false);
    m.tick(2);
    expect(m.radio.some((t) => t.includes(g.name!))).toBe(true);
    const at = g.position.clone();
    m.tick(30);
    expect(g.position.distanceTo(at)).toBe(0);
  });

  it('in wartime the ferries are scenery only', () => {
    expect(sortie('dogfight').ferries()).toHaveLength(0);
  });
});
