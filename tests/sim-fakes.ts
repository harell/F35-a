/**
 * Test fakes for the SIM-CORE tests: flat terrain, a minimal CombatSystemApi and an event log.
 */
import { Vector3 } from 'three';
import { EventBus, type GameEventMap, type GameEventName } from '../src/core/events';
import { DIFFICULTIES, LOADOUTS } from '../src/core/data';
import type { Difficulty, DifficultyParams } from '../src/core/types';
import type { CombatSystemApi, SimWorld, TerrainQuery } from '../src/sim/api';
import { createSimWorld } from '../src/sim/World';

/** Flat ground at `height` (sea if height ≤ 0). Optional ridge: terrain rises to `ridgeHeight` north of z < ridgeZ. */
export function flatTerrain(height = 0, ridge?: { z: number; height: number }): TerrainQuery {
  const h = (_x: number, z: number) => (ridge && z < ridge.z ? ridge.height : height);
  return {
    size: 80_000,
    heightAt: (x, z) => h(x, z),
    surfaceHeightAt: (x, z) => Math.max(0, h(x, z)),
    isWater: (x, z) => h(x, z) <= 0,
    lineOfSight: () => true,
    raycast(origin: Vector3, dir: Vector3, maxDist: number): number {
      // march (good enough for tests)
      const stepLen = 10;
      for (let d = 0; d <= maxDist; d += stepLen) {
        const x = origin.x + dir.x * d;
        const y = origin.y + dir.y * d;
        const z = origin.z + dir.z * d;
        if (y <= Math.max(0, h(x, z))) return d;
      }
      return -1;
    },
  };
}

export interface FakeCombat extends CombatSystemApi {
  updates: number;
}

/** Minimal combat system: loadouts only, everything else is a no-op. */
export function fakeCombat(): FakeCombat {
  const api: FakeCombat = {
    updates: 0,
    munitions: {} as CombatSystemApi['munitions'],
    update() {
      api.updates++;
    },
    applyLoadout(ac, id) {
      const l = LOADOUTS[id];
      ac.loadout = id;
      ac.stores = l.stores.map((s) => ({ ...s }));
      ac.gunAmmo = ac.gunMaxAmmo = l.gunAmmo;
      ac.flares = l.flares;
      ac.chaff = l.chaff;
    },
    applyDefaultLoadout(ac) {
      ac.gunAmmo = ac.gunMaxAmmo = 150;
      ac.flares = ac.chaff = 16;
    },
    cycleWeapon() {},
    selectWeapon() {},
    cycleTarget() {},
    designateNearestTo() {},
    designate() {},
    setRadarEmitting(ac, e) {
      ac.radar.emitting = e;
    },
    remaining: () => 0,
    launchZone: () => null,
    launchZoneFor: (_ac, weapon, target) => ({
      weapon,
      targetId: target.id,
      range: 0,
      rMin: 0,
      rNe: 0,
      rMax: 0,
      shoot: false,
      closure: 0,
      timeOfFlight: 0,
    }),
    fire: () => null,
    irSeekerState: () => ({ state: 'off', targetId: null, direction: null }),
    gunLeadPoint: () => null,
    bombImpactPoint: () => null,
  };
  return api;
}

export interface LoggedEvent {
  name: GameEventName;
  payload: unknown;
}

const LOGGED: GameEventName[] = [
  'explosion',
  'damage',
  'destroyed',
  'player:hit',
  'player:down',
  'warning',
  'hud:message',
  'transonic',
];

export interface TestWorld {
  world: SimWorld;
  events: EventBus;
  combat: FakeCombat;
  log: LoggedEvent[];
  of<K extends GameEventName>(name: K): GameEventMap[K][];
}

/** The retired Ace level's numbers (no level uses them now): keeps the no-flight-assist / G-LOC engine knobs covered. */
export const NO_ASSIST_PARAMS: DifficultyParams = {
  ...DIFFICULTIES.veteran,
  label: 'No-assist (ex-Ace)',
  playerDamageScale: 1.25,
  aiSkill: 0.95,
  aiReactionTime: 0.4,
  aiMaxG: 9,
  enemyMissileSkill: 1.2,
  samRangeScale: 1.1,
  samReactionTime: 1.5,
  playerLockTime: 2,
  countermeasureEffectiveness: 0.85,
  flightAssist: false,
  autoGcas: false,
  gEffects: true,
  generousShootCues: false,
  enemyCountScale: 1.5,
  scoreMultiplier: 2,
  playerMissileHitsToKill: 1,
  fuelBurnScale: 1,
  adBoatHarass: 0,
};

export function makeWorld(difficulty: Difficulty | DifficultyParams = 'pilot', terrain: TerrainQuery = flatTerrain(0)): TestWorld {
  const events = new EventBus();
  const combat = fakeCombat();
  const world = createSimWorld({ terrain, difficulty: typeof difficulty === 'string' ? DIFFICULTIES[difficulty] : difficulty, events, combat });
  const log: LoggedEvent[] = [];
  for (const name of LOGGED) events.on(name, (payload) => log.push({ name, payload }));
  return {
    world,
    events,
    combat,
    log,
    of: <K extends GameEventName>(name: K) => log.filter((e) => e.name === name).map((e) => e.payload as GameEventMap[K]),
  };
}

/** Step the world at 60 Hz for `seconds`, calling `each` before every step (return true to stop). */
export function run(world: SimWorld, seconds: number, each?: (t: number) => boolean | void): number {
  const dt = 1 / 60;
  const steps = Math.round(seconds * 60);
  let t = 0;
  for (let i = 0; i < steps; i++) {
    if (each?.(t)) break;
    world.step(dt);
    t += dt;
  }
  return t;
}

export const KT = 1 / 1.943844; // m/s per knot
export const DEG = Math.PI / 180;
