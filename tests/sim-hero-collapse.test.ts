/**
 * The 3D-modelled landmarks collapse under the player's jet: the Sky Tower, Spark Arena and the
 * Auckland War Memorial Museum. A jet into one crashes and brings it down at once; the HUD, AWACS and
 * the debrief name it; anybody else's aircraft crashes on it and it stands. The Domain is terrain:
 * a crash into the hill leaves the museum standing. The death cam's framing and the outro wait for
 * the collapse (game/outro.ts).
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { DIFFICULTIES } from '../src/core/data';
import { EventBus, type GameEventMap } from '../src/core/events';
import { MUSEUM, MUSEUM_COLUMNS, MUSEUM_TOP, museumSolids } from '../src/core/museum';
import { SPARK_ARENA } from '../src/core/sparkArena';
import { COLLAPSE } from '../src/core/skyTower';
import { createAiBrain } from '../src/ai';
import { buildInstantMissionSeeded, createMissionRunner } from '../src/missions';
import { crashedInto } from '../src/missions/runtime/reasons';
import { HERO_BUILDINGS, MUSEUM_ID, pointInRing } from '../src/sim/buildings';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { initFlight } from '../src/sim/flight/FlightModel';
import { END_DELAY_COLLAPSE, END_DELAY_FAILED, END_DELAY_SUCCESS, END_SETTLE_AFTER_STRIKE, endDelay } from '../src/game/outro';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';
import { LightList } from '../src/world/scenery/builders';
import { buildMuseum } from '../src/world/scenery/museum';
import { FlatTerrain } from './combat-helpers';

const DT = 1 / 60;

/** The Domain as a block of hill (60 m) south of the museum, clear of its footprint. */
const DOMAIN_HILL = { x0: MUSEUM.x - 300, x1: MUSEUM.x + 300, z0: MUSEUM.z + 200, z1: MUSEUM.z + 600, h: 60 };

function stroll(terrain = new FlatTerrain(0)) {
  const def = buildInstantMissionSeeded({ mode: 'stroll', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 4 }, 5);
  const events = new EventBus();
  const world = createSimWorld({ terrain, difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(1) });
  const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty: DIFFICULTIES.pilot, events });
  runner.setup(world, def.recommendedLoadout);
  const radio: string[] = [];
  const hud: string[] = [];
  const falls: GameEventMap['building:collapsed'][] = [];
  events.on('radio', (e) => radio.push(e.text));
  events.on('hud:message', (e) => hud.push(e.text));
  events.on('building:collapsed', (e) => falls.push(e));
  const tick = (seconds: number) => {
    for (let i = 0; i < seconds * 60; i++) {
      world.step(DT);
      runner.update(world, DT);
    }
  };
  /**
   * Level at `y`, `dist` m out on bearing `fromDeg` from (x, z), flying at it. (Close: Auto-GCAS sees
   * only the terrain, and from farther out it climbs a jet this low over a low building.)
   */
  const aim = (x: number, z: number, y: number, fromDeg: number, dist = 100) => {
    const p = world.player!;
    const b = (fromDeg * Math.PI) / 180;
    p.position.set(x + Math.sin(b) * dist, y, z - Math.cos(b) * dist);
    initFlight(p, { heading: b + Math.PI, speed: 150 });
  };
  return { world, runner, tick, aim, radio, hud, falls };
}

describe('the museum as a solid', () => {
  it('its prisms hold the drawn model: every vertex inside a prism footprint and under its top', () => {
    const solids = museumSolids();
    const B = new GeometryBuilder();
    const ground = 1.5;
    buildMuseum(B, new LightList(), () => ground);
    const pos = B.build()!.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const inside = solids.filter((s) => pointInRing(s.ring, x, z) || ringDistance(s.ring, x, z) < 0.05);
      expect(inside.length, `vertex ${x.toFixed(1)},${z.toFixed(1)}`).toBeGreaterThan(0);
      expect(y).toBeLessThanOrEqual(ground + Math.max(...inside.map((s) => s.h)) + 0.01);
    }
    expect(Math.max(...solids.map((s) => s.h))).toBe(MUSEUM_TOP);
    // the portico's eight columns are solid too
    for (const [cx, cz] of MUSEUM_COLUMNS) expect(solids.some((s) => pointInRing(s.ring, cx, cz))).toBe(true);
  });
});

describe("the player's jet into a 3D-modelled landmark", () => {
  it('the museum: the jet crashes, the museum collapses, named on the HUD, the radio and in the debrief', () => {
    const m = stroll();
    m.tick(1);
    m.aim(MUSEUM.x, MUSEUM.z, 15, 300);
    m.tick(4);
    const p = m.world.player!;
    expect(p.alive).toBe(false);
    expect(m.falls).toHaveLength(1);
    expect(m.falls[0]).toMatchObject({ building: MUSEUM_ID, isPlayer: true, hero: HERO_BUILDINGS.museum });
    const idx = m.world.buildings!;
    expect(idx.collapsed.has(idx.heroIndex('museum'))).toBe(true);
    expect(idx.collapsed.has(idx.heroIndex('spark_arena'))).toBe(false);
    expect(m.runner.result(m.world).reason).toBe(crashedInto('the Auckland Museum'));
    expect(m.hud).toContain('AUCKLAND MUSEUM DESTROYED');
    expect(m.radio.some((t) => t.startsWith('The Auckland Museum has been destroyed!'))).toBe(true);
    const strike = m.world.structureStrike!;
    expect(strike.name).toBe('the Auckland Museum');
    // the death cam frames the whole building
    expect(Math.hypot(strike.center.x - MUSEUM.x, strike.center.z - MUSEUM.z)).toBeLessThan(5);
    expect(strike.radius).toBeGreaterThan(52);
  });

  it('Spark Arena: "Crashed into Spark Arena", SPARK ARENA DESTROYED', () => {
    const m = stroll();
    m.tick(1);
    m.aim(SPARK_ARENA.x, SPARK_ARENA.z, 15, 270);
    m.tick(4);
    expect(m.world.player!.alive).toBe(false);
    expect(m.runner.result(m.world).reason).toBe('Crashed into Spark Arena');
    expect(m.hud).toContain('SPARK ARENA DESTROYED');
    expect(m.radio.some((t) => t.startsWith('Spark Arena has been destroyed!'))).toBe(true);
  });

  it('an AI jet into the museum crashes and the museum stands', () => {
    const m = stroll();
    m.tick(1);
    const a = m.world.spawnAircraft({ type: 'mig29', team: 'red', position: new Vector3(MUSEUM.x - 300, 15, MUSEUM.z), heading: Math.PI / 2, speed: 200 });
    a.position.y = 15;
    for (let i = 0; i < 240 && a.alive; i++) m.world.step(DT);
    expect(a.alive).toBe(false);
    expect(m.falls).toHaveLength(0);
    expect(m.world.buildings!.collapsed.size).toBe(0);
    expect(m.world.structureStrike).toBeNull();
  });

  it('the Domain is terrain: a crash into the hill leaves the museum standing, and a crash into the museum leaves the hill', () => {
    const terrain = new FlatTerrain(0, [DOMAIN_HILL]);
    const hill = stroll(terrain);
    hill.tick(1);
    // into the hill's east face, 400 m south of the museum (the path never crosses it)
    hill.aim(DOMAIN_HILL.x1, MUSEUM.z + 400, 30, 90);
    hill.tick(4);
    expect(hill.world.player!.alive).toBe(false);
    expect(hill.falls).toHaveLength(0);
    expect(hill.world.buildings!.collapsed.size).toBe(0);
    expect(hill.world.structureStrike).toBeNull();
    expect(hill.runner.result(hill.world).reason).not.toMatch(/Museum/);

    const museum = stroll(terrain);
    museum.tick(1);
    museum.aim(MUSEUM.x, MUSEUM.z, 15, 0);
    museum.tick(4);
    expect(museum.falls.map((f) => f.hero?.id)).toEqual(['museum']);
    expect(terrain.heightAt(MUSEUM.x, DOMAIN_HILL.z0 + 10)).toBe(DOMAIN_HILL.h);
  });
});

describe('the outro waits for the collapse', () => {
  const world = (strike: { time: number; duration: number } | null, time: number, towerDown = false) =>
    ({ landmarks: towerDown ? [{ alive: false }] : [], structureStrike: strike && { ...strike, name: null, label: null, center: new Vector3(), radius: 1 }, time }) as unknown as Parameters<typeof endDelay>[1];

  it('the usual delays without a strike', () => {
    expect(endDelay('success', world(null, 10))).toBe(END_DELAY_SUCCESS);
    expect(endDelay('failed', world(null, 10))).toBe(END_DELAY_FAILED);
    expect(endDelay('failed', world(null, 10, true))).toBe(END_DELAY_COLLAPSE);
  });

  it('a jet into a building: until it lies in rubble, plus time for the dust', () => {
    expect(endDelay('failed', world({ time: 10, duration: 3.7 }, 10))).toBeCloseTo(3.7 + END_SETTLE_AFTER_STRIKE, 6);
    expect(endDelay('failed', world({ time: 10, duration: 3.7 }, 10))).toBeGreaterThan(END_DELAY_FAILED + 3);
    // the Sky Tower: longer than its old 10 s
    expect(endDelay('failed', world({ time: 10, duration: COLLAPSE.ruinsAt }, 10, true))).toBeGreaterThan(END_DELAY_COLLAPSE);
    // the debrief's first frame still comes, however late the end was noticed
    expect(endDelay('failed', world({ time: 0, duration: 3.7 }, 30))).toBe(END_DELAY_FAILED);
  });
});

function ringDistance(r: Float32Array, x: number, z: number): number {
  let best = Infinity;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = r[j * 2], az = r[j * 2 + 1], bx = r[i * 2], bz = r[i * 2 + 1];
    const dx = bx - ax, dz = bz - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
  }
  return best;
}
