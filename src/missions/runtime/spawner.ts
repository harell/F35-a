/**
 * F35-A — spawning: the player, aircraft groups (formations, AI brains, tasks), SAM sites and
 * ground targets; difficulty-scaled group sizes; AI task resolution.
 */
import { Vector3 } from 'three';
import { AIRCRAFT_INFO } from '../../core/data';
import { DEG, clamp } from '../../core/math';
import { isHostile, type DifficultyParams, type LoadoutId, type Team } from '../../core/types';
import type { AiTask, TerrainQuery } from '../../sim/api';
import type { AircraftEntity, AnyEntity } from '../../sim/entities';
import type { AircraftGroupDef, Formation, GroundTargetDef, SamSiteDef, TaskDef } from '../schema';
import { createOneWay, placeOneWay } from '../../sim/drone/oneWay';
import { armMissionGun } from './gunAmmo';
import { difficultyAtLeast, firstAlive, type GroupRt, type MissionState } from './state';
import { JITTER_HDG, JITTER_POS, jitter } from './variation';

/** Everything stays inside this half-extent (m). */
export const SPAWN_LIMIT = 37_000;

const HEAVIES = new Set(['tu22m', 'a50']);

/**
 * Aircraft never spawn closer than this to the ground under them or SPAWN_CLEAR_AHEAD ahead (m).
 * Mission altitudes are above sea level, so a hill can sit under or in front of a "low" raid: Defend
 * strikers once spawned inside the terrain of a since-removed procedural theatre, or just above a
 * rising slope, and died in the first seconds (playtest 2026-10-02, 1.1-a). Auckland's ranges
 * (Waitākere ≤ 474 m, Hunua ≤ 688 m) still need it.
 */
export const SPAWN_MIN_AGL = 100;
export const SPAWN_CLEAR_AHEAD = 3_000;

/** Lowest altitude a jet may appear at (x, z) flying along the unit vector (fx, fz): clear of the ground under and ahead of it. */
export function spawnFloor(terrain: TerrainQuery, x: number, z: number, fx: number, fz: number): number {
  let h = 0;
  for (let d = 0; d <= SPAWN_CLEAR_AHEAD; d += 500) h = Math.max(h, terrain.surfaceHeightAt(x + fx * d, z + fz * d));
  return h + SPAWN_MIN_AGL;
}

/** Difficulty-scaled size of an aircraft group. */
export function scaledCount(def: AircraftGroupDef, enemyCountScale: number): number {
  let n = def.count;
  if (def.team === 'red' && !def.fixedCount) n = Math.max(1, Math.round(def.count * enemyCountScale));
  if (def.maxCount !== undefined) n = Math.min(n, def.maxCount);
  return Math.max(1, n);
}

/** Aircraft type actually flown on this difficulty (see AircraftGroupDef.downgrade). */
export function groupType(def: AircraftGroupDef, difficulty: DifficultyParams['id']): AircraftGroupDef['type'] {
  if (def.downgrade && !difficultyAtLeast(difficulty, def.downgrade.below)) return def.downgrade.type;
  return def.type;
}

/**
 * Scale a list of base group sizes so their TOTAL follows `scale` (min 1 aircraft overall):
 * shrinking takes from the last groups first, growing adds one per group round-robin.
 */
export function scaleTotal(counts: number[], scale: number, maxEach = 4): number[] {
  const out = [...counts];
  const base = counts.reduce((a, b) => a + b, 0);
  if (base <= 0) return out;
  let target = Math.max(1, Math.round(base * scale));
  let cur = base;
  for (let i = out.length - 1; i >= 0 && cur > target; i--) {
    while (out[i] > 0 && cur > target) {
      out[i]--;
      cur--;
    }
  }
  target = Math.min(target, out.length * maxEach);
  for (let k = 0; cur < target && k < 64; k++) {
    const i = k % out.length;
    if (out[i] < maxEach) {
      out[i]++;
      cur++;
    }
  }
  return out;
}

/** AI skill for a group member. */
export function groupSkill(def: AircraftGroupDef, aiSkill: number): number {
  if (def.skill !== undefined) return clamp(def.skill, 0, 1);
  // The player's fighting-wing wingman (Viper 2…) is a generous shooter only on Recruit; from Pilot up
  // it is a steady but average wingman so the player's missiles decide the fight (i2 review: Viper 2 did most
  // of the killing and the player got an A with one kill). Other friendlies stay competent.
  const ownFlight = def.team === 'blue' && def.role === 'wingman';
  const base = ownFlight ? (aiSkill < 0.4 ? 0.75 : 0.6) : def.team === 'blue' ? 0.65 + 0.3 * aiSkill : aiSkill;
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
    case 'triangle': {
      // row r holds r + 1 members, centred on the lead's track
      const r = Math.floor((Math.sqrt(8 * i + 1) - 1) / 2);
      const j = i - (r * (r + 1)) / 2;
      out.right = (j - r / 2) * s;
      out.aft = r * s;
      break;
    }
  }
}

const _slot = { right: 0, aft: 0 };

function clampXZ(v: Vector3): Vector3 {
  v.x = clamp(v.x, -SPAWN_LIMIT, SPAWN_LIMIT);
  v.z = clamp(v.z, -SPAWN_LIMIT, SPAWN_LIMIT);
  return v;
}

/** Resolve a mission task to an AiTask (null = none / unresolvable). */
export function resolveTask(task: TaskDef | undefined, s: MissionState, forTeam: Team = 'red'): AiTask | undefined {
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
      if (t) return { kind: 'attack', targetId: t.id };
      // nothing to attack (not spawned / all dead): hostiles go for the player, friendlies idle
      return s.player && isHostile(forTeam, s.player.team) ? { kind: 'attack', targetId: s.player.id } : undefined;
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
  // missions built around the gun carry more rounds than the loadout's 180 (MissionDef.gunAmmo)
  armMissionGun(ac, s.def, s.difficulty.id);
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
  if (def.oneWay) {
    spawnOneWayGroup(s, g);
    return;
  }
  const world = s.world;
  const n = g.expected;
  // retries: hostile flights appear up to ±1.5 km / ±10° from the designed point (variation.ts)
  const jk = s.attempt > 0 && def.team === 'red' ? s.enemiesSpawned + g.id.length * 17 : -1;
  const hdgDeg = jk >= 0 ? def.heading + jitter(s.def.seed, jk) * JITTER_HDG : def.heading;
  const ox = jk >= 0 ? jitter(s.def.seed, jk + 1) * JITTER_POS : 0;
  const oz = jk >= 0 ? jitter(s.def.seed, jk + 2) * JITTER_POS : 0;
  const heading = hdgDeg * DEG;
  const fx = Math.sin(heading);
  const fz = -Math.cos(heading);
  const rx = Math.cos(heading);
  const rz = Math.sin(heading);
  const spacing = def.spacing ?? (HEAVIES.has(groupType(def, s.difficulty.id)) ? 600 : 300);
  const formation: Formation = def.formation ?? (n === 1 ? 'single' : n >= 4 ? 'box' : 'pair');
  const skill = groupSkill(def, s.difficulty.aiSkill);
  const task = def.task ?? defaultTask(def);
  const type = groupType(def, s.difficulty.id);
  const stem = def.callsign ?? AIRCRAFT_INFO[type].nato;
  const first = def.firstNumber ?? 1;
  let leadId: number | null = null;

  g.spawnedAt = world.time;
  g.task = task;
  for (let i = 0; i < n; i++) {
    formationOffset(formation, i, n, spacing, _slot);
    const pos = new Vector3(
      def.x + ox + rx * _slot.right - fx * _slot.aft,
      def.altitude + (i % 2 === 1 ? 40 : 0),
      def.z + oz + rz * _slot.right - fz * _slot.aft,
    );
    clampXZ(pos);
    pos.y = Math.max(pos.y, spawnFloor(world.terrain, pos.x, pos.z, fx, fz));
    const aiTask = resolveTask(task, s, def.team);
    const ai = s.deps.createAi(def.role, { skill, task: aiTask, seed: (s.def.seed * 31 + s.enemiesSpawned * 7 + i * 13) >>> 0 });
    const wingman = def.role === 'wingman';
    const ac = world.spawnAircraft({
      type,
      team: def.team,
      position: pos,
      heading,
      speed: def.speed,
      callsign: `${stem} ${first + i}`,
      ai,
      leaderId: wingman ? (s.player?.id ?? null) : i === 0 ? null : leadId,
      groupId: g.id,
      fuel: def.fuel ?? 0.8,
      loadout: def.team === 'blue' && type === 'f35a' ? (def.loadout ?? 'a2a_stealth') : undefined,
      enemyLoadout: def.enemyLoadout,
    });
    if (i === 0) {
      leadId = ac.id;
      g.leadId = ac.id;
    }
    if (def.unarmed) disarm(ac);
    g.members.push(ac);
    if (def.team === 'red') s.enemiesSpawned++;
  }
  assignGroundAttack(s, g, true);
}

/**
 * Spawn a one-way drone group (Shahed-136): the formation (default 'triangle', 150 m) is laid out
 * nose towards the first waypoint (or the target); every member flies the route shifted by its
 * slot, at the group's altitude and speed, and dives into the shared target point. Drones fly
 * the designed geometry on every attempt (no retry jitter): the route is the mission.
 */
function spawnOneWayGroup(s: MissionState, g: GroupRt): void {
  const def = g.air!;
  const ow = def.oneWay!;
  const world = s.world;
  const n = g.expected;
  const first = ow.route?.[0] ?? { x: ow.targetX, z: ow.targetZ };
  const heading = Math.atan2(first.x - def.x, -(first.z - def.z));
  const fx = Math.sin(heading);
  const fz = -Math.cos(heading);
  const rx = Math.cos(heading);
  const rz = Math.sin(heading);
  const spacing = def.spacing ?? 150;
  const formation: Formation = def.formation ?? 'triangle';
  const type = groupType(def, s.difficulty.id);
  const stem = def.callsign ?? AIRCRAFT_INFO[type].nato;
  const firstNumber = def.firstNumber ?? 1;
  const target = new Vector3(ow.targetX, ow.targetY ?? world.terrain.surfaceHeightAt(ow.targetX, ow.targetZ), ow.targetZ);

  g.spawnedAt = world.time;
  g.task = undefined;
  for (let i = 0; i < n; i++) {
    formationOffset(formation, i, n, spacing, _slot);
    const dx = rx * _slot.right - fx * _slot.aft;
    const dz = rz * _slot.right - fz * _slot.aft;
    const pos = clampXZ(new Vector3(def.x + dx, def.altitude, def.z + dz));
    const ac = world.spawnAircraft({
      type,
      team: def.team,
      position: pos,
      heading,
      speed: def.speed,
      callsign: `${stem} ${firstNumber + i}`,
      ai: null,
      leaderId: null,
      groupId: g.id,
    });
    // the route shifted by the slot (world frame): the formation holds its first-leg orientation
    // (fixed-speed drones can't wheel it round a corner; see OneWayDef)
    const route = (ow.route ?? []).map((p) => new Vector3(p.x + dx, def.altitude, p.z + dz));
    placeOneWay(ac, createOneWay({ target, altitude: def.altitude, speed: def.speed, route }), pos);
    if (i === 0) g.leadId = ac.id;
    g.members.push(ac);
    if (def.team === 'red') s.enemiesSpawned++;
  }
}

/** The ground / SAM group an 'attack_group' task points at (null for air groups and other tasks). */
function groundAttackTargets(s: MissionState, task: TaskDef | undefined): GroupRt | null {
  if (task?.kind !== 'attack_group') return null;
  const t = s.groups.get(task.group);
  return t && !t.air ? t : null;
}

/**
 * 'attack_group' on a ground / SAM group: give each live attacker a live target of that group,
 * spread out (the target with the fewest attackers, nearest on a tie), and a new one when its
 * target is destroyed. With `reset` every attacker is re-assigned (spawn, re-task). Called at the
 * runner's evaluation rate; a no-op for other tasks.
 */
export function assignGroundAttack(s: MissionState, g: GroupRt, reset = false): void {
  const targets = groundAttackTargets(s, g.task);
  if (!targets) {
    g.strikeTargets = undefined;
    return;
  }
  const map = (g.strikeTargets ??= new Map());
  if (reset) map.clear();
  const load = new Map<number, number>();
  for (const t of targets.members) if (t.alive) load.set(t.id, 0);
  if (load.size === 0) return; // nothing left: the strikers egress on their own
  for (const [m, t] of map) {
    const ac = s.world.getEntity(m);
    if (ac && ac.alive && load.has(t)) load.set(t, load.get(t)! + 1);
  }
  for (const m of g.members) {
    if (m.kind !== 'aircraft' || !m.alive || !m.ai?.setTask) continue;
    const cur = map.get(m.id);
    if (cur !== undefined && load.has(cur)) continue;
    let best: AnyEntity | null = null;
    let bestKey = Infinity;
    for (const t of targets.members) {
      if (!t.alive) continue;
      const key = load.get(t.id)! * 1e9 + t.position.distanceTo(m.position);
      if (key < bestKey) {
        bestKey = key;
        best = t;
      }
    }
    if (!best) break;
    map.set(m.id, best.id);
    load.set(best.id, load.get(best.id)! + 1);
    m.ai.setTask({ kind: 'attack', targetId: best.id });
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
    scenery: def.scenery,
    vessel: def.vessel,
    hitsToSink: def.hitsToSink,
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
  if (sc.scaleEnemyTotal) {
    const list = sc.groups.filter((d) => d.team === 'red' && !d.fixedCount && difficultyAtLeast(diff, d.minDifficulty));
    const counts = scaleTotal(
      list.map((d) => d.count),
      scale,
    );
    list.forEach((d, i) => {
      const g = s.groups.get(d.id)!;
      g.expected = d.maxCount !== undefined ? Math.min(counts[i], d.maxCount) : counts[i];
    });
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
  // SAM sites and ground targets first so 'attack_group' tasks on them (SEAD flights) resolve,
  // then aircraft groups in definition order (bombers before their escorts).
  spawnInitialSurface(s, diff, sc);
  for (const def of sc.groups) {
    const g = s.groups.get(def.id)!;
    if (g.expected <= 0) continue;
    if (!def.spawn || def.spawn.kind === 'start') spawnAirGroup(s, g);
    else s.pendingAir.push(g);
  }
}

function spawnInitialSurface(s: MissionState, diff: MissionState['difficulty']['id'], sc: MissionState['script']): void {
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
  const aiTask = resolveTask(task, s, g.team);
  if (!aiTask) return;
  g.task = task;
  for (const m of g.members) {
    if (m.kind === 'aircraft' && m.alive && m.ai?.setTask) m.ai.setTask(aiTask);
  }
  assignGroundAttack(s, g, true);
}

/**
 * The rest of a route from `pos`: drops the points already flown (everything up to the point
 * nearest to `pos`, and that one too once `pos` is past it towards the next).
 */
export function remainingRoute(task: Extract<TaskDef, { kind: 'route' }>, pos: { x: number; z: number }): Extract<TaskDef, { kind: 'route' }> {
  const pts = task.points;
  if (pts.length <= 1 || task.loop) return task;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pos.x, pts[i].z - pos.z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best < pts.length - 1) {
    // past the nearest point already? (closer to the next one than the nearest is to it)
    const a = pts[best];
    const b = pts[best + 1];
    const ab = Math.hypot(b.x - a.x, b.z - a.z);
    const pb = Math.hypot(b.x - pos.x, b.z - pos.z);
    if (pb < ab || bestD < 2_000) best++;
  }
  return { kind: 'route', points: pts.slice(best), loop: false };
}

/**
 * A group's lead went down: the survivors (formation followers of a dead lead) re-take the
 * group's route from where they are, so a strike package still reaches its target.
 */
export function updateGroupLead(s: MissionState, g: GroupRt): void {
  if (g.leadId === undefined || g.leadId < 0 || !g.task) return;
  const lead = s.world.getEntity(g.leadId);
  if (lead && lead.alive) return;
  const next = firstAlive(g);
  if (!next) {
    g.leadId = -1;
    return;
  }
  g.leadId = next.id;
  if (g.task.kind === 'route') retaskGroup(s, g.id, remainingRoute(g.task, next.position));
}
