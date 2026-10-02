/**
 * Instant Action's A Stroll in the Park: free flight over Auckland with no hostiles. No enemy
 * aircraft, SAMs or targets, no objectives; the heaviest loadout by default with every loadout
 * allowed; the sortie only ends when the player quits or goes down; shooting down an airliner costs
 * nothing and bringing the Sky Tower down doesn't end it. A saved setup and the menu default pick it.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { AKL } from '../src/core/auckland';
import { DIFFICULTIES } from '../src/core/data';
import { EventBus } from '../src/core/events';
import { createAiBrain } from '../src/ai';
import { buildInstantMissionSeeded, createMissionRunner, missionById, validateMission } from '../src/missions';
import type { MissionResultExt } from '../src/missions/runtime/resultExt';
import { destroyLandmark } from '../src/sim/landmarks';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { parseInstantSetup } from '../src/ui/screens/instantAction';
import { FlatTerrain } from './combat-helpers';

const DT = 1 / 60;
const stroll = () => buildInstantMissionSeeded({ mode: 'stroll', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 8 }, 7);

function setup() {
  const def = stroll();
  const events = new EventBus();
  const world = createSimWorld({ terrain: new FlatTerrain(0), difficulty: DIFFICULTIES.ace, events, combat: createCombatSystemSeeded(1) });
  const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty: DIFFICULTIES.ace, events });
  runner.setup(world, def.recommendedLoadout);
  const radio: string[] = [];
  events.on('radio', (e) => radio.push(e.text));
  const tick = (seconds: number) => {
    for (let i = 0; i < seconds * 60; i++) {
      world.step(DT);
      runner.update(world, DT);
    }
  };
  return { world, runner, radio, tick };
}

describe('Instant Action: A Stroll in the Park', () => {
  it('has no hostiles, no objectives and every loadout, the heaviest by default', () => {
    const def = stroll();
    expect(validateMission(def)).toEqual([]);
    expect(def.title).toBe('A Stroll in the Park — Auckland');
    expect(def.script.freeFlight).toBe(true);
    // the enemy count is ignored: 8 asked for, none spawned
    expect(def.script.groups).toEqual([]);
    expect(def.script.sams).toEqual([]);
    expect(def.script.ground).toEqual([]);
    expect(def.script.objectives).toEqual([]);
    expect(def.script.survival).toBeUndefined();
    expect(def.intel.filter((i) => i.kind === 'sam' || i.kind === 'air')).toEqual([]);
    expect(def.recommendedLoadout).toBe('strike_beast');
    expect(def.allowedLoadouts).toContain('strike_sdb2_full');
    expect(def.allowedLoadouts).toContain('a2a_beast');
    expect(def.briefing[0]).toMatch(/^Everyone's friendly\. It's New Zealand\./);
    expect(def.objectiveText).toEqual(['Free flight: no objectives. Explore Auckland at your own pace.']);
    expect(missionById('ia_stroll_auckland')?.script.freeFlight).toBe(true);
  });

  it('only civilians in the air, and it keeps running until the player quits', () => {
    const m = setup();
    m.tick(60);
    expect(m.world.aircraft.some((a) => a.civil)).toBe(true);
    expect(m.world.aircraft.filter((a) => a !== m.world.player && a.team !== 'neutral')).toEqual([]);
    expect(m.world.sams).toEqual([]);
    expect(m.runner.state).toBe('running');
    expect(m.radio.some((t) => /Nothing hostile/.test(t))).toBe(true);
    expect(m.radio.some((t) => /picture/i.test(t))).toBe(false);
  });

  it('shooting down an airliner costs nothing', () => {
    const m = setup();
    m.tick(1);
    const p = m.world.player!;
    const civ = m.world.aircraft.find((a) => a.civil)!;
    m.world.applyDamage(civ, 10_000, p.id, 'gun');
    m.tick(6);
    expect(civ.alive).toBe(false);
    expect(m.runner.state).toBe('running');
    expect((m.runner.result(m.world) as MissionResultExt).civilianKills).toBeUndefined();
  });

  it('bringing the Sky Tower down does not end it', () => {
    const m = setup();
    m.tick(1);
    const p = m.world.player!;
    const tower = m.world.landmarks[0];
    destroyLandmark(tower, m.world.events, m.world.time, new Vector3(AKL.skytower.x + 10, 200, AKL.skytower.z), p.id, 'gbu31', p.position);
    m.tick(5);
    expect(tower.alive).toBe(false);
    expect(m.runner.state).toBe('running');
  });

  it('crashing still ends it', () => {
    const m = setup();
    m.tick(1);
    const p = m.world.player!;
    m.world.applyDamage(p, p.maxHealth * 10, null, 'gun');
    m.tick(1);
    expect(m.runner.state).toBe('failed');
  });

  it('is the menu default, and a saved stroll setup loads as one', () => {
    expect(parseInstantSetup(null).mode).toBe('stroll');
    expect(parseInstantSetup(JSON.stringify({ mode: 'stroll', theater: 'auckland' })).mode).toBe('stroll');
    // an existing player's saved mode is kept
    expect(parseInstantSetup(JSON.stringify({ mode: 'dogfight' })).mode).toBe('dogfight');
  });
});
