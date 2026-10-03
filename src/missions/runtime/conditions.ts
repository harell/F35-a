/**
 * F35-A — mission condition evaluation (spawn triggers, objective activation, triggers, hints).
 */
import type { Condition } from '../schema';
import { isHostile } from '../../core/types';
import { deadCount, defeatedCount, type MissionState } from './state';

/** Horizontal distance² between an entity-ish position and a point. */
function dist2(px: number, pz: number, x: number, z: number): number {
  const dx = px - x;
  const dz = pz - z;
  return dx * dx + dz * dz;
}

function inBand(y: number, below?: number, above?: number): boolean {
  if (below !== undefined && y > below) return false;
  if (above !== undefined && y < above) return false;
  return true;
}

export function evalCondition(c: Condition, s: MissionState): boolean {
  switch (c.kind) {
    case 'start':
      return true;
    case 'time':
      return s.time >= c.t;
    case 'objective': {
      const o = s.objectiveById.get(c.id);
      if (!o) return false;
      const st = o.status.state;
      return c.state === 'active' ? st === 'active' : st === c.state;
    }
    case 'area': {
      const r2 = c.radius * c.radius;
      if (!c.who || c.who === 'player') {
        const p = s.player;
        if (!p || !p.alive) return false;
        return dist2(p.position.x, p.position.z, c.x, c.z) <= r2 && inBand(p.position.y, c.below, c.above);
      }
      const g = s.groups.get(c.who.group);
      if (!g) return false;
      for (const m of g.members) {
        if (m.alive && dist2(m.position.x, m.position.z, c.x, c.z) <= r2 && inBand(m.position.y, c.below, c.above)) return true;
      }
      return false;
    }
    case 'group_destroyed': {
      const g = s.groups.get(c.group);
      if (!g || g.spawnedAt < 0) return false;
      const need = c.count === undefined ? g.expected : Math.min(c.count, g.expected);
      // all members must have spawned for an "all destroyed" check
      if (c.count === undefined && g.members.length < g.expected) return false;
      return deadCount(g) >= need;
    }
    case 'group_defeated': {
      const g = s.groups.get(c.group);
      if (!g || g.spawnedAt < 0) return false;
      const need = c.count === undefined ? g.expected : Math.min(c.count, g.expected);
      if (c.count === undefined && g.members.length < g.expected) return false;
      return defeatedCount(s, g) >= need;
    }
    case 'group_spawned': {
      const g = s.groups.get(c.group);
      return !!g && g.spawnedAt >= 0;
    }
    case 'waypoint':
      return s.waypointsReached.has(c.id);
    case 'player_kills': {
      const k = s.kills;
      const cat = c.category ?? 'any';
      const n = cat === 'any' ? k.air + k.sam + k.ground : k[cat];
      return n >= c.count;
    }
    case 'sam_engaged':
      return s.samEngaged;
    case 'trigger':
      return s.firedTriggers.has(c.id);
    case 'missile_inbound': {
      const p = s.player;
      return !!p && p.alive && p.incoming.length > 0;
    }
    case 'munitions_clear': {
      const g = s.groups.get(c.group);
      if (!g) return true;
      for (const m of s.world.missiles) if (m.alive && g.members.some((e) => e.id === m.shooterId)) return false;
      return true;
    }
    case 'player_fired': {
      const p = s.player;
      return !!p && p.shotsFired >= (c.count ?? 1);
    }
    case 'munitions_shot_down':
      return (s.munitionsShotDown.get(c.group) ?? 0) >= (c.count ?? 1);
    case 'player_radar': {
      const p = s.player;
      if (!p || !p.alive) return false;
      const id = c.state === 'locked' ? p.radar.lockedId : p.radar.designatedId;
      const e = s.world.getEntity(id);
      if (!e || !e.alive || e.kind !== 'aircraft' || !isHostile(p.team, e.team)) return false;
      return c.state === 'locked' || p.radar.lockedId !== id;
    }
    case 'player_weapon': {
      const p = s.player;
      return !!p && p.alive && p.selectedWeapon === c.weapon;
    }
    case 'all':
      for (const sub of c.of) if (!evalCondition(sub, s)) return false;
      return true;
    case 'any':
      for (const sub of c.of) if (evalCondition(sub, s)) return true;
      return false;
    case 'not':
      return !evalCondition(c.of, s);
  }
}

/** Every group / objective / waypoint id a condition references (for validation). */
export function conditionRefs(c: Condition, out: { groups: string[]; objectives: string[]; waypoints: string[]; triggers?: string[] }): void {
  switch (c.kind) {
    case 'trigger':
      out.triggers?.push(c.id);
      break;
    case 'objective':
      out.objectives.push(c.id);
      break;
    case 'area':
      if (c.who && c.who !== 'player') out.groups.push(c.who.group);
      break;
    case 'group_destroyed':
    case 'group_defeated':
    case 'group_spawned':
    case 'munitions_clear':
    case 'munitions_shot_down':
      out.groups.push(c.group);
      break;
    case 'waypoint':
      out.waypoints.push(c.id);
      break;
    case 'all':
    case 'any':
      for (const sub of c.of) conditionRefs(sub, out);
      break;
    case 'not':
      conditionRefs(c.of, out);
      break;
    default:
      break;
  }
}
