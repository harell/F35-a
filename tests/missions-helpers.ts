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
import { createMissionRunner } from '../src/missions';
import { NEVER, P, flight, mission, site, wingmen } from '../src/missions/content/common';

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

const DS = 'DARKSTAR';
const sweepStart = { x: -9000, z: -6200, altitude: 3000, heading: 75, speed: 230, fuel: 0.9 };

/**
 * A test-only air-to-air sweep (the shape of the removed Southern Cross c01): the player and Viper 2
 * on CAP over the upper harbour, a MiG-29 pair ('fulcrum1', objective 'o_sweep'), a second pair
 * ('fulcrum2', spawned by a trigger once the first is down, objective 'o_second') and the steering
 * cue on 'wp_cap'. For the generic air-to-air mechanics (Winchester, bingo, driven-off bandits,
 * debrief tips, dispose) that no remaining mission has in this form.
 */
export function sweepFixture(): MissionDef {
  return mission({
    id: 'fx_sweep',
    kind: 'campaign',
    index: 1,
    title: 'Sweep fixture',
    subtitle: 'test',
    timeOfDay: 'day',
    weather: 'clear',
    briefing: ['test'],
    recommendedLoadout: 'a2a_stealth',
    allowedLoadouts: ['a2a_stealth', 'a2a_beast'],
    player: sweepStart,
    script: {
      autoHints: true,
      parTime: 360,
      groups: [
        wingmen(1, sweepStart),
        flight('fulcrum1', 'mig29', 2, { x: 22000, z: -21000 }, 5500, 235, 240, 'fighter', {
          skillOffset: -0.2,
          task: { kind: 'patrol', x: 4000, z: -12000, radius: 6000, altitude: 5000 },
        }),
        flight('fulcrum2', 'mig29', 2, { x: 27000, z: -13000 }, 6000, 262, 250, 'fighter', {
          skillOffset: -0.15,
          spawn: NEVER,
          task: { kind: 'patrol', x: 6000, z: -9000, radius: 6000, altitude: 5500 },
        }),
      ],
      objectives: [
        { id: 'o_sweep', kind: 'destroy', groups: ['fulcrum1'], label: 'Splash the MiG-29 sweep', primary: true },
        { id: 'o_second', kind: 'destroy', groups: ['fulcrum2'], label: 'Splash the second MiG pair', primary: true, activeAt: { kind: 'objective', id: 'o_sweep', state: 'complete' } },
      ],
      waypoints: [
        { id: 'wp_cap', label: 'CAP Alpha', kind: 'cap', x: -1000, z: -7500, altitude: 5000, objective: 'o_second' },
        { id: 'wp_home', label: 'Whenuapai', kind: 'rtb', x: P.whenuapai.x, z: P.whenuapai.z, altitude: 1000 },
      ],
      triggers: [
        {
          id: 't_second',
          when: { kind: 'objective', id: 'o_sweep', state: 'complete' },
          delay: 7,
          actions: [
            { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Two more Fulcrums heading your way.' },
            { kind: 'spawn', group: 'fulcrum2' },
          ],
        },
      ],
      hints: [{ id: 'h_start', text: '{controls}. Climb toward the CAP and follow the steering cue', when: { kind: 'time', t: 9 }, duration: 8 }],
      opening: [{ kind: 'radio', from: DS, text: 'Viper 1, Darkstar. Fulcrums over the Gulf. Cleared to engage.', priority: 2 }],
    },
  });
}

const seadStart = { x: -13000, z: -2000, altitude: 4000, heading: 80, speed: 240 };

/**
 * A test-only SEAD mission (the shape of the removed Southern Cross c03): an SA-6 ('rangi_sa6') on
 * Rangitoto's south-west slope, an SA-8 ('rangi_sa8') on its east shore with a 'wp_sa8' waypoint,
 * Shilkas and an EW radar ('rangi_ewr'), flown with the SEAD loadout. No scripted hints, so every
 * hint comes from the weapon-aware auto hints. One trigger: after the SA-8 shoots down two of the
 * player's weapons (the 'munitions_shot_down' condition) Darkstar calls it, reveals it and steers
 * the player to it. Pass `timeLimit` for the time-limit countdown.
 */
export function seadFixture(timeLimit?: number): MissionDef {
  return mission({
    id: 'fx_sead',
    kind: 'campaign',
    index: 1,
    title: 'SEAD fixture',
    subtitle: 'test',
    timeOfDay: 'day',
    weather: 'clear',
    briefing: ['test'],
    recommendedLoadout: 'sead_stealth',
    allowedLoadouts: ['sead_stealth', 'strike_stealth', 'strike_beast', 'strike_sdb2'],
    player: seadStart,
    timeLimit,
    script: {
      autoHints: true,
      parTime: 420,
      groups: [wingmen(1, seadStart)],
      sams: [
        site('sa6', 'rangi_sa6', 'sa6', P.rangSW, { heading: 225 }),
        site('sa8', 'rangi_sa8', 'sa8', P.rangE, { heading: 90 }),
        site('zsu1', 'rangi_aaa', 'zsu23', P.rangS),
      ],
      objectives: [
        { id: 'o_sa6', kind: 'destroy', groups: ['rangi_sa6'], label: 'Destroy the SA-6 battery', primary: true },
        { id: 'o_sa8', kind: 'destroy', groups: ['rangi_sa8'], label: 'Destroy the SA-8', primary: true },
      ],
      waypoints: [
        { id: 'wp_sa6', label: 'SA-6', kind: 'target', x: P.rangSW.x, z: P.rangSW.z, objective: 'o_sa6' },
        { id: 'wp_sa8', label: 'SA-8', kind: 'target', x: P.rangE.x, z: P.rangE.z, objective: 'o_sa8' },
      ],
      triggers: [
        {
          id: 't_sa8_eating',
          when: { kind: 'all', of: [{ kind: 'munitions_shot_down', group: 'rangi_sa8', count: 2 }, { kind: 'not', of: { kind: 'objective', id: 'o_sa8', state: 'complete' } }] },
          delay: 2,
          actions: [
            { kind: 'radio', from: DS, text: 'Viper 1, Darkstar. The Gecko is shooting your weapons down.', priority: 3 },
            { kind: 'reveal', group: 'rangi_sa8' },
            { kind: 'set_waypoint', id: 'wp_sa8' },
          ],
        },
      ],
    },
  });
}

/**
 * A test-only mission: the sweep fixture plus a lone Su-27 strike jet (bomber role, orbiting a
 * station) to shoot down, bullseye AWACS calls and a 720 s time limit (features no remaining
 * campaign mission has).
 */
export function raiderFixture(): MissionDef {
  const base = sweepFixture();
  return {
    ...base,
    id: 'fx_raider',
    timeLimit: 720,
    script: {
      ...base.script,
      awacs: { style: 'bullseye', bullseye: { x: 0, z: 0, name: 'Tower' } },
      groups: [
        ...base.script.groups,
        flight('raider', 'su27', 1, { x: 9000, z: -29000 }, 9000, 0, 220, 'bomber', { fixedCount: true, task: { kind: 'patrol', x: 8000, z: -29000, radius: 5000, altitude: 9000 } }),
      ],
      objectives: [...base.script.objectives, { id: 'o_raider', kind: 'destroy', groups: ['raider'], label: 'Shoot down the Su-27 strike jet', primary: true }],
    },
  };
}
