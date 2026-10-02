/**
 * Test harness for the MISSIONS module: the REAL SimWorld + CombatSystem on a flat fake
 * terrain, a stub AI factory that records roles/tasks, and an event log.
 */
import { Vector3 } from 'three';
import { EventBus, type GameEventMap, type GameEventName } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import type { MissionDef, MissionRunnerApi } from '../src/core/contracts';
import type { Difficulty, LoadoutId } from '../src/core/types';
import type { AiBrain, AiRole, AiTask, CreateAiBrain, SimWorld, TerrainQuery } from '../src/sim/api';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createMissionRunner, missionById } from '../src/missions';
import { flight } from '../src/missions/content/common';

/** Flat land at `height` m everywhere (no water). */
export function flatLand(height = 20): TerrainQuery {
  return {
    size: 80_000,
    heightAt: () => height,
    surfaceHeightAt: () => height,
    isWater: () => false,
    lineOfSight: () => true,
    raycast(origin: Vector3, dir: Vector3, maxDist: number): number {
      if (dir.y >= 0) return -1;
      const d = (origin.y - height) / -dir.y;
      return d <= maxDist ? d : -1;
    },
  };
}

export interface AiLog {
  created: { role: AiRole; skill: number; task?: AiTask }[];
  retasked: AiTask[];
}

/** AI stub: flies straight and level, records creation + re-tasking. */
export function stubAi(log: AiLog): CreateAiBrain {
  return (role, opts) => {
    log.created.push({ role, skill: opts.skill, task: opts.task });
    const brain: AiBrain = {
      role,
      update(ac) {
        ac.input.pitch = 0;
        ac.input.roll = 0;
        ac.input.yaw = 0;
      },
      setTask(t) {
        log.retasked.push(t);
      },
    };
    return brain;
  };
}

export interface Harness {
  events: EventBus;
  world: SimWorld;
  runner: MissionRunnerApi;
  ai: AiLog;
  log: { name: GameEventName; payload: unknown }[];
  of<K extends GameEventName>(name: K): GameEventMap[K][];
  /** Step world + runner at 60 Hz. */
  run(seconds: number, each?: () => boolean | void): void;
}

const LOGGED: GameEventName[] = ['radio', 'hud:message', 'objective', 'mission:end', 'destroyed', 'player:down'];

export function harness(def: MissionDef, difficulty: Difficulty = 'pilot', loadout?: LoadoutId, terrain: TerrainQuery = flatLand()): Harness {
  const events = new EventBus();
  const diff = DIFFICULTIES[difficulty];
  const world = createSimWorld({ terrain, difficulty: diff, events, combat: createCombatSystemSeeded(7) });
  const ai: AiLog = { created: [], retasked: [] };
  const runner = createMissionRunner(def, { createAi: stubAi(ai), difficulty: diff, events });
  const log: Harness['log'] = [];
  for (const name of LOGGED) events.on(name, (payload) => log.push({ name, payload }));
  runner.setup(world, loadout ?? def.recommendedLoadout);
  return {
    events,
    world,
    runner,
    ai,
    log,
    of: <K extends GameEventName>(name: K) => log.filter((e) => e.name === name).map((e) => e.payload as GameEventMap[K]),
    run(seconds, each) {
      const steps = Math.round(seconds * 60);
      for (let i = 0; i < steps; i++) {
        if (each?.()) break;
        world.step(1 / 60);
        runner.update(world, 1 / 60);
      }
    },
  };
}

/** Destroy every live member of a mission group (credited to the player by default). */
export function killGroup(h: Harness, groupId: string, byPlayer = true): number {
  const w = h.world;
  const attacker = byPlayer ? (w.player?.id ?? null) : null;
  let n = 0;
  const all = [...w.aircraft, ...w.sams, ...w.ground];
  for (const e of all) {
    if (e.groupId === groupId && e.alive) {
      w.applyDamage(e, e.maxHealth * 10 + 500, attacker, 'aim120');
      n++;
    }
  }
  return n;
}

/** Keep the player alive and out of trouble during long runs (tests about logic, not combat). */
export function shieldPlayer(h: Harness): void {
  const p = h.world.player;
  if (p && p.alive) {
    p.health = p.maxHealth;
    p.damage.fire = false;
  }
}

/**
 * A test-only mission: c01 plus an A-50 Mainstay to shoot down, bullseye AWACS calls and a 720 s
 * time limit. Those features have no campaign mission since c07 was removed (issue #63).
 */
export function mainstayFixture(): MissionDef {
  const base = missionById('c01')!;
  return {
    ...base,
    id: 'fx_mainstay',
    timeLimit: 720,
    script: {
      ...base.script,
      awacs: { style: 'bullseye', bullseye: { x: 0, z: 0, name: 'Tower' } },
      groups: [
        ...base.script.groups,
        flight('mainstay', 'a50', 1, { x: 9000, z: -29000 }, 9000, 0, 190, 'awacs', { fixedCount: true, task: { kind: 'patrol', x: 8000, z: -29000, radius: 5000, altitude: 9000 } }),
      ],
      objectives: [...base.script.objectives, { id: 'o_awacs', kind: 'destroy', groups: ['mainstay'], label: 'Shoot down the A-50 Mainstay', primary: true }],
    },
  };
}
