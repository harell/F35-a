/**
 * A Stroll in the Park, sightseeing follow-ups (issue #113): the free-flight debrief shows what a
 * sightseer did (tour stops, distance flown, highest and lowest pass) instead of combat stats.
 */
import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../src/core/data';
import { EventBus } from '../src/core/events';
import { createAiBrain } from '../src/ai';
import { buildInstantMissionSeeded, createMissionRunner } from '../src/missions';
import type { MissionResultExt } from '../src/missions/runtime/resultExt';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { sightseeingRows } from '../src/ui/screens/debrief';
import { FlatTerrain } from './combat-helpers';

const DT = 1 / 60;
const stroll = () => buildInstantMissionSeeded({ mode: 'stroll', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 8 }, 7);

function setup() {
  const def = stroll();
  const events = new EventBus();
  const world = createSimWorld({ terrain: new FlatTerrain(0), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(1) });
  const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty: DIFFICULTIES.pilot, events });
  runner.setup(world, def.recommendedLoadout);
  const tick = (seconds: number) => {
    for (let i = 0; i < seconds * 60; i++) {
      world.step(DT);
      runner.update(world, DT);
    }
  };
  return { def, world, runner, tick };
}

const sights = (r: ReturnType<ReturnType<typeof createMissionRunner>['result']>) => (r as MissionResultExt).sightseeing!;

describe('A Stroll in the Park: the free-flight debrief (2.2-5)', () => {
  it('counts the tour stops visited, the distance flown and the highest and lowest pass', () => {
    const m = setup();
    m.tick(1);
    const p = m.world.player!;
    const wps = m.runner.waypoints;
    for (const i of [0, 1, 2]) {
      p.position.set(wps[i].position.x, 600, wps[i].position.z);
      m.tick(0.5);
    }
    // a low pass at ~120 m that the jet flies on from
    p.position.y = 120;
    m.tick(0.3);
    p.position.y = 900;
    m.tick(4);
    const t = sights(m.runner.result(m.world));
    expect(t.stops).toBe(3);
    expect(t.totalStops).toBe(11);
    // about 7 s at ~150 m/s (the teleports between the stops don't count)
    expect(t.distance).toBeGreaterThan(600);
    expect(t.distance).toBeLessThan(2000);
    expect(t.lowestAgl!).toBeGreaterThan(100);
    expect(t.lowestAgl!).toBeLessThan(140);
    expect(t.highestAgl!).toBeGreaterThan(880);
  });

  it("a crash isn't the lowest pass", () => {
    const m = setup();
    m.tick(3);
    const p = m.world.player!;
    p.position.y = 15; // heading for the water
    m.tick(0.5);
    m.world.applyDamage(p, p.maxHealth * 10, null, 'gun');
    m.tick(1);
    const t = sights(m.runner.result(m.world));
    expect(t.lowestAgl!).toBeGreaterThan(400);
  });

  it('shows sightseeing rows, no Accuracy, Damage or SAM kills', () => {
    const r = {
      freeFlight: true,
      time: 754,
      sightseeing: { stops: 7, totalStops: 11, distance: 92_600, highestAgl: 1210, lowestAgl: 61 },
    } as unknown as MissionResultExt;
    const rows = sightseeingRows(r);
    const labels = rows.map((x) => x[1]);
    expect(labels).toEqual(['Tour stops', 'Flight time', 'Distance flown', 'Highest pass', 'Lowest pass']);
    expect(labels.join(' ')).not.toMatch(/Accuracy|Damage|SAM|kills/);
    const v = Object.fromEntries(rows.map((x) => [x[1], x[2]]));
    expect(v['Tour stops']).toBe('7/11');
    expect(v['Flight time']).toBe('12:34');
    expect(v['Distance flown']).toBe('50 nm <small>93 km</small>');
    expect(v['Highest pass']).toBe('3,970 ft <small>1,210 m</small>');
    expect(v['Lowest pass']).toBe('200 ft <small>61 m</small>');
  });
});
