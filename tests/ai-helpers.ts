/**
 * Test harness for the AI module: the REAL SimWorld (flight model, damage, collisions) and the
 * REAL CombatSystem (seeded) over simple fake terrains.
 */
import { Vector3 } from 'three';
import { EventBus, type GameEventMap } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import type { Difficulty } from '../src/core/types';
import type { SimWorld, TerrainQuery } from '../src/sim/api';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';

/** Generic terrain from a height function (sea where h ≤ 0), with marching LOS / raycast. */
export class FnTerrain implements TerrainQuery {
  readonly size = 80_000;
  constructor(private readonly h: (x: number, z: number) => number) {}
  heightAt(x: number, z: number): number {
    return this.h(x, z);
  }
  surfaceHeightAt(x: number, z: number): number {
    return Math.max(0, this.h(x, z));
  }
  isWater(x: number, z: number): boolean {
    return this.h(x, z) <= 0;
  }
  lineOfSight(a: Vector3, b: Vector3): boolean {
    const d = a.distanceTo(b);
    const n = Math.min(200, Math.max(2, Math.ceil(d / 100)));
    for (let i = 1; i < n; i++) {
      const f = i / n;
      const x = a.x + (b.x - a.x) * f;
      const y = a.y + (b.y - a.y) * f;
      const z = a.z + (b.z - a.z) * f;
      if (y < this.surfaceHeightAt(x, z) - 0.5) return false;
    }
    return true;
  }
  raycast(o: Vector3, dir: Vector3, maxDist: number): number {
    for (let d = 0; d <= maxDist; d += 20) {
      if (o.y + dir.y * d <= this.surfaceHeightAt(o.x + dir.x * d, o.z + dir.z * d)) return d;
    }
    return -1;
  }
}

export const flat = (h = 0) => new FnTerrain(() => h);

/** Rolling hills 100–700 m with ridges (no sea). */
export const hills = () =>
  new FnTerrain((x, z) => {
    const a = Math.sin(x / 2_300) * Math.cos(z / 1_900);
    const b = Math.sin((x + z) / 3_700 + 1.3);
    const ridge = Math.max(0, Math.sin(x / 5_000 - z / 7_000)) ** 3;
    return 380 + 180 * a + 120 * b + 260 * ridge;
  });

export interface AiTestWorld {
  world: SimWorld;
  events: EventBus;
  launches: GameEventMap['munition:launch'][];
  ends: GameEventMap['munition:end'][];
  destroyed: GameEventMap['destroyed'][];
  radio: GameEventMap['radio'][];
}

export function makeAiWorld(difficulty: Difficulty = 'veteran', terrain: TerrainQuery = flat(0), seed = 1): AiTestWorld {
  const events = new EventBus();
  const combat = createCombatSystemSeeded(seed);
  const world = createSimWorld({ terrain, difficulty: DIFFICULTIES[difficulty], events, combat });
  const out: AiTestWorld = { world, events, launches: [], ends: [], destroyed: [], radio: [] };
  events.on('munition:launch', (p) => out.launches.push(p));
  events.on('munition:end', (p) => out.ends.push(p));
  events.on('destroyed', (p) => out.destroyed.push(p));
  events.on('radio', (p) => out.radio.push(p));
  return out;
}

/** Step at 60 Hz for `seconds`; `each(t)` runs before every step (return true to stop early). */
export function runFor(world: SimWorld, seconds: number, each?: (t: number) => boolean | void): number {
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

/** Every `period` s (for sampling inside runFor callbacks). */
export function every(t: number, period: number): boolean {
  return Math.abs(t / period - Math.round(t / period)) < 0.5 / 60 / period;
}

export const v3 = (x: number, y: number, z: number) => new Vector3(x, y, z);
