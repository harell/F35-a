/**
 * F35-A — the stoat (SIM-CORE, g03 "Stoat of Emergency", #200): a 0.3 kg ground target on the
 * Onetangi dunes that runs to a nest of dotterel chicks.
 *
 *  - It runs its route (start → bait stations → nest) in short dashes and stops at each bait
 *    station for `stopTime` s: those stops are the drop windows. Reaching the last point is reaching
 *    the nest (StoatState.atNest; the mission fails the sortie on it).
 *  - Its clock starts at mission start (`clockStart`), not when it is spawned: g03 spawns it only
 *    once the player is under the cloud near the nest, and on its first step it catches up with
 *    where it would be by then (so the undisturbed arrival time doesn't depend on the reveal).
 *  - Targeted (the player designates or locks it, or a weapon is in flight at it): at its next stop
 *    it stands up in the "periscope" stance, looks up at the jet and puffs its tail
 *    (StoatState.alert, read by the renderer), then dithers. Targeted while running, it keeps
 *    running: the stance comes at the stop.
 *  - A near miss (a weapon aimed at it that went off within NEAR_MISS m and left it alive) makes it
 *    bolt at BOLT_FACTOR × speed to the next station, cutting a stop short.
 *  - Over water it swims (StoatState.swimming): a steady `swimSpeed`, no dashes and no bolting, and no
 *    stops, so a StormBreaker can't track it there (sim/weapons/small.ts) and a JDAM's blast has to.
 *
 * t04's sewer rats ('rat') run on the same runner: down a Herne Bay street with a stop at each drain,
 * across the beach and out to Watchman Island, which is their "nest".
 *
 * Pure stepping over the world's ground list, like sim/boats.ts; no allocations per step.
 */
import { Vector3 } from 'three';
import type { SimWorld } from './api';
import type { GroundTargetEntity } from './entities';
import { setQuatFromHPR } from './flight/attitude';

/** Default dash speed (m/s, average) and stop at a bait station (s). */
export const STOAT_SPEED = 2.4;
export const STOAT_STOP = 20;
/** A weapon aimed at the stoat that goes off within this distance and leaves it alive is a near miss (m). */
export const NEAR_MISS = 30;
/** Bolting after a near miss: this many times its speed, to the next station. */
export const BOLT_FACTOR = 2;
/** Catch-up step when it spawns after its clock started (s). */
const CATCH_UP_DT = 0.25;
/** Default swimming speed (m/s): steady, whatever its speed on land. */
export const SWIM_SPEED = 1.2;

export type StoatPhase = 'run' | 'stop' | 'nest';

/** How a mission spawns a stoat (GroundSpawn.stoat). */
export interface StoatSpawn {
  /** Start, the bait stations and the nest, in order (y resolved to the ground). */
  route: Vector3[];
  /** Indices into `route` of the bait stations (a stop at each). */
  stations: number[];
  speed?: number;
  stopTime?: number;
  /** World time its clock started (default 0: mission start). */
  clockStart?: number;
  /** Swimming speed over water (m/s, default SWIM_SPEED). */
  swimSpeed?: number;
}

export interface StoatState {
  route: Vector3[];
  stations: number[];
  speed: number;
  stopTime: number;
  clockStart: number;
  swimSpeed: number;
  /** In the water (swimming), this step. For the renderer and the HUD. */
  swimming: boolean;
  /** Index of the route point it is heading for (or stopped at). */
  leg: number;
  phase: StoatPhase;
  /** Seconds in the current phase. */
  phaseT: number;
  /** Bolting after a near miss (until the next station). */
  bolting: boolean;
  /** The player has it designated / locked or a weapon in flight at it (this step). */
  targeted: boolean;
  /** 0..1: the periscope stance (rises while targeted at a stop, sinks back otherwise). For the renderer. */
  alert: number;
  /** Running gait phase (rad), for the renderer's bounds. */
  gait: number;
  /** Reached the nest. */
  atNest: boolean;
  /** Caught up with its clock (spawned late). */
  synced: boolean;
  /** Weapons in flight at it and where each last was (missile id → position), for near misses. */
  readonly incoming: Map<number, Vector3>;
}

/** Make `e` a stoat (World.spawnGround does it for the 'stoat' type). */
export function makeStoat(e: GroundTargetEntity, spec: StoatSpawn): void {
  const route = spec.route.map((p) => p.clone());
  e.stoat = {
    route,
    stations: [...spec.stations].sort((a, b) => a - b),
    speed: spec.speed ?? STOAT_SPEED,
    stopTime: spec.stopTime ?? STOAT_STOP,
    clockStart: spec.clockStart ?? 0,
    swimSpeed: spec.swimSpeed ?? SWIM_SPEED,
    swimming: false,
    leg: 1,
    phase: 'run',
    phaseT: 0,
    bolting: false,
    targeted: false,
    alert: 0,
    gait: 0,
    atNest: false,
    synced: false,
    incoming: new Map(),
  };
  if (route.length > 0) e.position.set(route[0].x, e.position.y, route[0].z);
  e.path = null;
}

const _v = new Vector3();

/** Step every live stoat: catch up with its clock, run, stop, alert and bolt. */
export function stepStoats(world: SimWorld, dt: number): void {
  for (const g of world.ground) {
    const s = g.stoat;
    if (!s || !g.alive) continue;
    if (!s.synced) {
      s.synced = true;
      let t = Math.max(0, world.time - s.clockStart);
      while (t > 1e-6 && !s.atNest) {
        const h = Math.min(CATCH_UP_DT, t);
        advance(world, g, s, h);
        t -= h;
      }
    }
    s.targeted = isTargeted(world, g);
    nearMisses(world, g, s);
    advance(world, g, s, dt);
    // the periscope stance: up while targeted at a stop (≈ 0.4 s to rise), back down otherwise
    const want = s.phase !== 'run' && s.targeted ? 1 : 0;
    s.alert += Math.sign(want - s.alert) * Math.min(Math.abs(want - s.alert), dt * (want ? 2.5 : 1.2));
  }
}

/** The player has it designated or locked, or a weapon of the player's is in flight at it. */
function isTargeted(world: SimWorld, g: GroundTargetEntity): boolean {
  const p = world.player;
  if (p && p.alive && (p.radar.designatedId === g.id || p.radar.lockedId === g.id)) return true;
  for (const m of world.missiles) if (m.alive && m.targetId === g.id && (!p || m.shooterId === p.id)) return true;
  return false;
}

/** Track the weapons aimed at it; one that went off within NEAR_MISS m of a still-live stoat makes it bolt. */
function nearMisses(world: SimWorld, g: GroundTargetEntity, s: StoatState): void {
  for (const [id, last] of s.incoming) {
    const m = world.getEntity(id);
    if (m && m.alive && m.kind === 'missile') {
      last.copy(m.position);
      continue;
    }
    s.incoming.delete(id);
    if (Math.hypot(last.x - g.position.x, last.z - g.position.z) <= NEAR_MISS && !s.atNest) {
      s.bolting = true;
      if (s.phase === 'stop') {
        s.phase = 'run';
        s.phaseT = 0;
        s.leg = Math.min(s.leg + 1, s.route.length - 1);
      }
    }
  }
  for (const m of world.missiles) if (m.alive && m.targetId === g.id && !s.incoming.has(m.id)) s.incoming.set(m.id, m.position.clone());
}

/** One step of the route: dash to the next point, stop at a station, end at the nest. */
function advance(world: SimWorld, g: GroundTargetEntity, s: StoatState, dt: number): void {
  s.phaseT += dt;
  s.swimming = world.terrain.isWater(g.position.x, g.position.z);
  if (s.phase === 'nest') {
    g.velocity.set(0, 0, 0);
    return;
  }
  if (s.phase === 'stop') {
    g.velocity.set(0, 0, 0);
    if (s.phaseT >= s.stopTime) {
      s.phase = 'run';
      s.phaseT = 0;
      s.leg = Math.min(s.leg + 1, s.route.length - 1);
    }
    return;
  }
  const target = s.route[s.leg];
  _v.set(target.x - g.position.x, 0, target.z - g.position.z);
  const dist = _v.length();
  // dashes: the pace swings between ~0.3 and ~1.7 × speed over each bound (average = speed); in the
  // water a steady paddle
  s.gait += dt * (s.swimming ? 5 : 9);
  const pace = s.swimming ? s.swimSpeed : s.speed * (s.bolting ? BOLT_FACTOR : 1) * (1 + 0.7 * Math.sin(s.gait * 0.25));
  const step = pace * dt;
  const oldY = g.position.y;
  if (dist <= step + 1e-3) {
    g.position.x = target.x;
    g.position.z = target.z;
    if (s.leg >= s.route.length - 1) {
      s.phase = 'nest';
      s.atNest = true;
      s.phaseT = 0;
    } else if (s.stations.includes(s.leg)) {
      s.phase = 'stop';
      s.phaseT = 0;
      s.bolting = false;
    } else s.leg++;
  } else {
    g.position.x += (_v.x / dist) * step;
    g.position.z += (_v.z / dist) * step;
  }
  g.position.y = world.terrain.surfaceHeightAt(g.position.x, g.position.z);
  if (dist > 1e-3) setQuatFromHPR(g.quaternion, Math.atan2(_v.x, -_v.z), 0, 0);
  if (s.phase === 'run') g.velocity.set((_v.x / Math.max(dist, 1e-3)) * pace, (g.position.y - oldY) / Math.max(dt, 1e-3), (_v.z / Math.max(dist, 1e-3)) * pace);
  else g.velocity.set(0, 0, 0);
}

/**
 * Seconds an undisturbed stoat takes from its start to the nest (route at `speed`, a stop at each station).
 * All on land: a route that swims (t04's rats) takes longer by its water legs at the slower swimSpeed.
 */
export function stoatArrival(spec: Pick<StoatSpawn, 'route' | 'stations' | 'speed' | 'stopTime'>): number {
  let len = 0;
  for (let i = 1; i < spec.route.length; i++) len += Math.hypot(spec.route[i].x - spec.route[i - 1].x, spec.route[i].z - spec.route[i - 1].z);
  const stops = spec.stations.filter((k) => k > 0 && k < spec.route.length - 1).length;
  return len / (spec.speed ?? STOAT_SPEED) + stops * (spec.stopTime ?? STOAT_STOP);
}
