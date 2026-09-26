/**
 * F35-A — spawning: the player, aircraft groups (formations, AI brains, tasks), SAM sites and
 * ground targets; difficulty-scaled group sizes; AI task resolution.
 */
import { Vector3 } from 'three';
import { AIRCRAFT_INFO } from '../../core/data';
import { DEG, clamp } from '../../core/math';
import type { LoadoutId } from '../../core/types';
import type { AiTask } from '../../sim/api';
import type { AircraftEntity } from '../../sim/entities';
import type { AircraftGroupDef, Formation, GroundTargetDef, SamSiteDef, TaskDef } from '../schema';
import { difficultyAtLeast, firstAlive, type GroupRt, type MissionState } from './state';

/** Everything stays inside this half-extent (m). */
export const SPAWN_LIMIT = 37_000;

const HEAVIES = new Set(['tu22m', 'a50']);

/** Difficulty-scaled size of an aircraft group. */
export function scaledCount(def: AircraftGroupDef, enemyCountScale: number): number {
  let n = def.count;
  if (def.team === 'red' && !def.fixedCount) n = Math.max(1, Math.round(def.count * enemyCountScale));
  if (def.maxCount !== undefined) n = Math.min(n, def.maxCount);
  return Math.max(1, n);
}

/** AI skill for a group member. */
export function groupSkill(def: AircraftGroupDef, aiSkill: number): number {
  if (def.skill !== undefined) return clamp(def.skill, 0, 1);
  const base = def.team === 'blue' ? 0.65 + 0.3 * aiSkill : aiSkill;
  return clamp(base + (def.skillOffset ?? 0), 0, 1);
}

/**
 * Formation slot offset of member `i` (of `n`) as (right, aft) metres relative to the lead.
 */
export function formationOffset(f: Formation, i: number, n: number, s: number, out: { right: number; aft: number }): void {
  out.right = 0;
  out.aft = 0;
  if (i === 0 && f !== 'wall') return;
  switch (f) {
    case 'single':
      out.right = i * 60;
      out.aft = i * 60;
      break;
    case 'pair':
      out.right = i * s;
      out.aft = i * s * 0.4;
      break;
    case 'echelon':
      out.right = i * s;
      out.aft = i * s;
      break;
    case 'vic': {
      const k = Math.ceil(i / 2);
      out.right = (i % 2 === 1 ? 1 : -1) * k * s;
      out.aft = k * s * 0.8;
      break;
    }
    case 'trail':
      out.aft = i * s * 3;
      break;
    case 'wall':
      out.right = (i - (n - 1) / 2) * s * 3;
      break;
    case 'box':
      out.right = (i % 2) * s * 1.2;
      out.aft = Math.floor(i / 2) * s * 1.6;
      break;
  }
}

const _slot = { right: 0, aft: 0 };

function clampXZ(v: Vector3): Vector3 {
  v.x = clamp(v.x, -SPAWN_LIMIT, SPAWN_LIMIT);
  v.z = clamp(v.z, -SPAWN_LIMIT, SPAWN_LIMIT);
  return v;
}

/** Resolve a mission task to an AiTask (null = none / unresolvable). */
export function resolveTask(task: TaskDef | undefined, s: MissionState): AiTask | undefined {
  if (!task) return undefined;
  switch (task.kind) {
    case 'patrol':
      return { kind: 'patrol', center: new Vector3(task.x, task.altitude, task.z), radius: task.radius, altitude: task.altitude };
    case 'route':
      return { kind: 'route', waypoints: task.points.map((p) => new Vector3(p.x, p.altitude, p.z)), loop: !!task.loop };
    case 'attack_player':
      return s.player ? { kind: 'attack', targetId: s.player.id } : undefined;
    case 'attack_group': {
      const t = firstAlive(s.groups.get(task.group));
      return t ? { kind: 'attack', targetId: t.id } : s.player ? { kind: 'attack', targetId: s.player.id } : undefined;
    }
    case 'escort_group': {
      const t = firstAlive(s.groups.get(task.group));
      return t ? { kind: 'escort', leaderId: t.id } : undefined;
    }
    case 'escort_player':
      return s.player ? { kind: 'escort', leaderId: s.player.id } : undefined;
    case 'rtb':
      return { kind: 'rtb', point: new Vector3(task.x, task.altitude, task.z) };
  }
}

/** Default task when a group has none (keeps AI inside the AO and doing something sensible). */
function defaultTask(def: AircraftGroupDef): TaskDef | undefined {
  switch (def.role) {
    case 'wingman':
      return { kind: 'escort_player' };
    case 'interceptor':
      return { kind: 'attack_player' };
    case 'awacs':
      return { kind: 'patrol', x: def.x, z: def.z, radius: 9000, altitude: def.altitude };
    case 'cap':
    case 'fighter':
      return { kind: 'patrol', x: def.x, z: def.z, radius: 8000, altitude: def.altitude };
    default:
      return undefined;
  }
}

/** Spawn the player jet. */
export function spawnPlayer(s: MissionState, loadout: LoadoutId): AircraftEntity {
  const p = s.def.player;
  const ac = s.world.spawnAircraft({
    type: 'f35a',
    team: 'blue',
    isPlayer: true,
    position: clampXZ(new Vector3(p.x, p.altitude, p.z)),
    heading: p.heading * DEG,
    speed: p.speed,
    loadout,
    fuel: p.fuel ?? 0.85,
    callsign: s.callsign,
    name: 'F-35A Lightning II',
    groupId: 'player',
  });
  s.player = ac;
  return ac;
}

/** Remove every store and the gun (training drones). */
export function disarm(ac: AircraftEntity): void {
  for (const st of ac.stores) st.count = 0;
  ac.gunAmmo = 0;
  ac.gunMaxAmmo = 0;
  ac.flares = 0;
  ac.chaff = 0;
}

/** Spawn every member of an aircraft group. */
export function spawnAirGroup(s: MissionState, g: GroupRt): void {
  const def = g.air!;
  const world = s.world;
  const n = g.expected;
  const heading = def.heading * DEG;
  const fx = Math.sin(heading);
  const fz = -Math.cos(heading);
  const rx = Math.cos(heading);
  const rz = Math.sin(heading);
  const spacing = def.spacing ?? (HEAVIES.has(def.type) ? 600 : 300);
  const formation: Formation = def.formation ?? (n === 1 ? 'single' : n >= 4 ? 'box' : 'pair');
  const skill = groupSkill(def, s.difficulty.aiSkill);
  const task = def.task ?? defaultTask(def);
  const stem = def.callsign ?? AIRCRAFT_INFO[def.type].nato;
  const first = def.firstNumber ?? 1;
  let leadId: number | null = null;

  g.spawnedAt = world.time;
  for (let i = 0; i < n; i++) {
    formationOffset(formation, i, n, spacing, _slot);
    const pos = new Vector3(
      def.x + rx * _slot.right - fx * _slot.aft,
      def.altitude + (i % 2 === 1 ? 40 : 0),
      def.z + rz * _slot.right - fz * _slot.aft,
    );
    clampXZ(pos);
    const aiTask = resolveTask(task, s);
    const ai = s.deps.createAi(def.role, { skill, task: aiTask, seed: (s.def.seed * 31 + s.enemiesSpawned * 7 + i * 13) >>> 0 });
    const wingman = def.role === 'wingman';
    const ac = world.spawnAircraft({
      type: def.type,
      team: def.team,
      position: pos,
      heading,
      speed: def.speed,
      callsign: `${stem} ${first + i}`,
      ai,
      leaderId: wingman ? (s.player?.id ?? null) : i === 0 ? null : leadId,
      groupId: g.id,
      fuel: def.fuel ?? 0.8,
      loadout: def.team === 'blue' && def.type === 'f35a' ? (def.loadout ?? 'a2a_stealth') : undefined,
    });
    if (i === 0) leadId = ac.id;
    if (def.unarmed) disarm(ac);
    g.members.push(ac);
    if (def.team === 'red') s.enemiesSpawned++;
  }
}

/** Spawn one SAM site. */
export function spawnSamSite(s: MissionState, def: SamSiteDef): void {
  const g = s.groups.get(def.group);
  const team = def.team ?? 'red';
  const e = s.world.spawnSam({
    type: def.type,
    team,
    position: new Vector3(def.x, 0, def.z),
    heading: (def.heading ?? 0) * DEG,
    name: def.name,
    groupId: def.group,
    emcon: !!def.emcon,
    known: def.known ?? !def.emcon,
  });
  if (g) {
    if (g.spawnedAt < 0) g.spawnedAt = s.world.time;
    g.members.push(e);
  }
  if (team === 'red') s.enemiesSpawned++;
}

/** Spawn one ground target (static, convoy or ship). */
export function spawnGroundTarget(s: MissionState, def: GroundTargetDef): void {
  const g = s.groups.get(def.group);
  const team = def.team ?? 'red';
  const e = s.world.spawnGround({
    type: def.type,
    team,
    position: new Vector3(def.x, 0, def.z),
    heading: def.heading !== undefined ? def.heading * DEG : undefined,
    name: def.name,
    groupId: def.group,
    path: def.path?.map((p) => new Vector3(p.x, 0, p.z)),
    speed: def.speed,
    loopPath: def.loop,
    health: def.health,
  });
  if (g) {
    if (g.spawnedAt < 0) g.spawnedAt = s.world.time;
    g.members.push(e);
  }
  if (team === 'red') s.enemiesSpawned++;
}

/**
 * Build group runtimes for every aircraft group, SAM site and ground target the current
 * difficulty allows (expected sizes known up front so objectives can show progress).
 */
export function buildGroups(s: MissionState): void {
  const scale = s.difficulty.enemyCountScale;
  const diff = s.difficulty.id;
  const sc = s.script;
  const ensure = (id: string, team: GroupRt['team']): GroupRt => {
    let g = s.groups.get(id);
    if (!g) {
      g = { id, team, air: null, expected: 0, members: [], spawnedAt: -1, announced: false, threatCalled: false };
      s.groups.set(id, g);
    }
    return g;
  };
  for (const def of sc.groups) {
    if (!difficultyAtLeast(diff, def.minDifficulty)) {
      // keep an empty (never spawning) group so references stay valid
      const g = ensure(def.id, def.team);
      g.air = def;
      g.expected = 0;
      continue;
    }
    const g = ensure(def.id, def.team);
    g.air = def;
    g.expected = scaledCount(def, scale);
  }
  for (const def of sc.sams) {
    const g = ensure(def.group, def.team ?? 'red');
    if (difficultyAtLeast(diff, def.minDifficulty)) g.expected++;
  }
  for (const def of sc.ground) {
    const g = ensure(def.group, def.team ?? 'red');
    if (difficultyAtLeast(diff, def.minDifficulty)) g.expected++;
  }
}

/** Spawn everything whose spawn condition is 'start' (or absent); queue the rest. */
export function spawnInitial(s: MissionState): void {
  const diff = s.difficulty.id;
  const sc = s.script;
  // Aircraft groups in definition order (bombers before their escorts so escort tasks resolve).
  for (const def of sc.groups) {
    const g = s.groups.get(def.id)!;
    if (g.expected <= 0) continue;
    if (!def.spawn || def.spawn.kind === 'start') spawnAirGroup(s, g);
    else s.pendingAir.push(g);
  }
  for (const def of sc.sams) {
    if (!difficultyAtLeast(diff, def.minDifficulty)) continue;
    if (!def.spawn || def.spawn.kind === 'start') spawnSamSite(s, def);
    else s.pendingSites.push({ kind: 'sam', def, when: def.spawn });
  }
  for (const def of sc.ground) {
    if (!difficultyAtLeast(diff, def.minDifficulty)) continue;
    if (!def.spawn || def.spawn.kind === 'start') spawnGroundTarget(s, def);
    else s.pendingSites.push({ kind: 'ground', def, when: def.spawn });
  }
}

/** Re-task every live member of a group. */
export function retaskGroup(s: MissionState, groupId: string, task: TaskDef): void {
  const g = s.groups.get(groupId);
  if (!g) return;
  const aiTask = resolveTask(task, s);
  if (!aiTask) return;
  for (const m of g.members) {
    if (m.kind === 'aircraft' && m.alive && m.ai?.setTask) m.ai.setTask(aiTask);
  }
}
