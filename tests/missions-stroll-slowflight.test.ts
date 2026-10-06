/**
 * A Stroll in the Park: slow flight for sightseeing (#113 item 3). With the throttle back the
 * free-flight autothrottle holds 150 KIAS level instead of letting the clean jet bleed to the AoA
 * limiter and sink; more throttle from the pilot always wins, and combat missions don't have it.
 */
import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../src/core/data';
import { EventBus } from '../src/core/events';
import { createAiBrain } from '../src/ai';
import { buildInstantMissionSeeded, createMissionRunner, missionById } from '../src/missions';
import type { MissionDef } from '../src/core/contracts';
import { FREE_FLIGHT_SPEED_FLOOR, initFlight, setSpeedFloor } from '../src/sim/flight/FlightModel';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { FlatTerrain } from './combat-helpers';

const DT = 1 / 60;
const KT = 0.514444;
const stroll = () => buildInstantMissionSeeded({ mode: 'stroll', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 8 }, 7);

/** Fly the mission's player level at 300 m and 220 KTAS with the throttle at `throttle`, for `seconds`. */
function fly(def: MissionDef, throttle: number, seconds: number, floor?: number) {
  const events = new EventBus();
  const world = createSimWorld({ terrain: new FlatTerrain(0), difficulty: DIFFICULTIES.veteran, events, combat: createCombatSystemSeeded(1) });
  const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty: DIFFICULTIES.veteran, events });
  runner.setup(world, def.recommendedLoadout);
  const p = world.player!;
  p.position.y = 300;
  initFlight(p, { heading: 0, speed: 220 * KT });
  if (floor !== undefined) setSpeedFloor(p, floor);
  let minIas = Infinity;
  let sawAt = false;
  for (let i = 0; i < seconds * 60; i++) {
    p.input.throttle = throttle;
    p.input.pitch = p.input.roll = p.input.yaw = 0;
    world.step(DT);
    runner.update(world, DT);
    minIas = Math.min(minIas, p.flight.ias);
    sawAt ||= p.flight.autoThrottle;
  }
  return { p, minIas, sawAt };
}

describe('A Stroll in the Park: slow flight (#113)', () => {
  it('holds about 150 KIAS level with the throttle at idle', () => {
    const { p, minIas, sawAt } = fly(stroll(), 0, 90);
    expect(sawAt).toBe(true);
    expect(p.flight.autoThrottle).toBe(true);
    expect(p.flight.ias / KT).toBeGreaterThan(145);
    expect(p.flight.ias / KT).toBeLessThan(156);
    expect(minIas / KT).toBeGreaterThan(140); // no undershoot towards the ~115 kt limiter speed
    expect(Math.abs(p.flight.verticalSpeed)).toBeLessThan(1.5); // level, not 4,800 ft/min down
    expect(p.position.y).toBeGreaterThan(270);
    expect(p.flight.afterburner).toBe(0); // never lights the afterburner
  });

  it('without the floor the same jet bleeds to the AoA limiter (the playtest finding)', () => {
    const { minIas } = fly(stroll(), 0, 90, 0);
    expect(minIas / KT).toBeLessThan(135);
  });

  it('lets the pilot fly faster: more throttle always wins and A/T goes out', () => {
    const { p } = fly(stroll(), 0.8, 40);
    expect(p.flight.ias / KT).toBeGreaterThan(200);
    expect(p.flight.autoThrottle).toBe(false);
  });

  it('is free flight only: a combat mission has no floor', () => {
    const def = missionById('g01')!;
    const { minIas, sawAt } = fly(def, 0, 90);
    expect(sawAt).toBe(false);
    expect(minIas).toBeLessThan(FREE_FLIGHT_SPEED_FLOOR - 10 * KT);
  });
});
