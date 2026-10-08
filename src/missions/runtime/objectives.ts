/**
 * F35-A — objective runtime: activation, progress, completion / failure and the related
 * events ('objective', 'hud:message', AWACS "objective complete").
 */
import type { ObjectiveStatus } from '../../core/contracts';
import type { ObjectiveDef } from '../schema';
import { evalCondition } from './conditions';
import { retaskGroup } from './spawner';
import { aliveCount, deadCount, difficultyAtLeast, drivenOffCount, type MissionState, type ObjectiveRt } from './state';
import { POINTS } from './scoring';
import { drillRecords } from './defenceCoach';

export function createObjectives(s: MissionState): void {
  for (const def of s.script.objectives) {
    if (!difficultyAtLeast(s.difficulty.id, def.minDifficulty)) continue;
    const status: ObjectiveStatus = { id: def.id, label: def.label, state: 'pending', primary: def.primary };
    const rt: ObjectiveRt = { def, status, accum: 0, aborted: false, drivenOff: 0 };
    s.objectives.push(rt);
    s.objectiveById.set(def.id, rt);
  }
}

export function objectiveBonus(def: ObjectiveDef): number {
  // the Harbour Bridge stunt already pays for the pass (MissionRunner.updateBridge): never pay it twice
  if (def.kind === 'bridge') return def.bonus ?? 0;
  return def.bonus ?? (def.primary ? POINTS.primary : POINTS.secondary);
}

/** Bonus actually earned: bandits driven off instead of killed are worth half. */
export function earnedBonus(o: ObjectiveRt): number {
  const base = objectiveBonus(o.def);
  const total = o.status.progress?.total ?? 0;
  if (o.drivenOff <= 0 || total <= 0) return base;
  return Math.round(base * (1 - (0.5 * Math.min(o.drivenOff, total)) / total));
}

function setState(s: MissionState, o: ObjectiveRt, state: ObjectiveStatus['state'], announce = true): void {
  if (o.status.state === state) return;
  o.status.state = state;
  if (state === 'active') o.openedAt = s.time;
  if (state === 'pending') return;
  s.events.emit('objective', { id: o.def.id, label: o.def.label, state });
  if (!announce) return;
  if (state === 'complete') {
    s.hud('OBJECTIVE COMPLETE', 'good', 3);
    s.radio.push({ from: s.awacsCallsign, text: `${s.callsign}, ${s.awacsSpoken}. Objective complete — ${o.def.label}.`, voice: 'a_objective_complete', priority: 2 });
  } else if (state === 'failed') {
    // a lost bonus is not a lost mission: amber and short, never the red primary-failure banner
    if (o.def.primary) s.hud('PRIMARY OBJECTIVE FAILED', 'bad', 3.5);
    else s.hud('BONUS FAILED', 'warn', 2.5);
  } else if (state === 'active' && s.time > 1) {
    s.hud(`NEW OBJECTIVE: ${o.def.label.toUpperCase()}`, 'info', 4);
  }
}

/** Activate an objective now (trigger action). */
export function activateObjective(s: MissionState, id: string): void {
  const o = s.objectiveById.get(id);
  if (o && o.status.state === 'pending') setState(s, o, 'active');
}

/**
 * Every primary other than protect/rtb objectives is complete (vacuously true if there are
 * none) — protect objectives then auto-complete and RTB objectives open.
 */
function otherPrimariesDone(s: MissionState, self: ObjectiveRt): boolean {
  for (const o of s.objectives) {
    if (o === self || !o.def.primary) continue;
    if (o.def.kind === 'protect' || o.def.kind === 'rtb') continue;
    if (o.status.state !== 'complete') return false;
  }
  return true;
}

function groupsProgress(s: MissionState, ids: string[], countDrivenOff = false): { done: number; total: number; spawnedAll: boolean; drivenOff: number } {
  let done = 0;
  let total = 0;
  let drivenOff = 0;
  let spawnedAll = true;
  for (const id of ids) {
    const g = s.groups.get(id);
    if (!g) continue;
    total += g.expected;
    done += deadCount(g);
    if (countDrivenOff) drivenOff += drivenOffCount(s, g);
    if (g.members.length < g.expected) spawnedAll = false;
  }
  return { done: done + drivenOff, total, spawnedAll, drivenOff };
}

/** Evaluate every objective (called at the runner's evaluation rate). */
export function updateObjectives(s: MissionState, dt: number): void {
  const p = s.player;
  for (const o of s.objectives) {
    const def = o.def;
    const st = o.status;

    if (st.state === 'pending') {
      if (def.kind === 'rtb') {
        // RTB opens once everything else that matters is done
        if (!otherPrimariesDone(s, o)) continue;
        setState(s, o, 'active');
      } else if (!def.activeAt || evalCondition(def.activeAt, s)) setState(s, o, 'active');
      else continue;
    }
    if (st.state !== 'active') continue;

    switch (def.kind) {
      case 'destroy': {
        // bandits that bugged out / ran home count as defeated (never a stalled mission)
        const pr = groupsProgress(s, def.groups, true);
        const need = def.count !== undefined ? Math.min(def.count, pr.total) : pr.total;
        st.progress = { done: Math.min(pr.done, need), total: need };
        o.drivenOff = Math.min(pr.drivenOff, need);
        if (need > 0 && pr.done >= need && (def.count !== undefined || pr.spawnedAll)) setState(s, o, 'complete');
        break;
      }
      case 'destroy_sams': {
        let total = 0;
        let done = 0;
        const r2 = def.radius * def.radius;
        for (const site of s.world.sams) {
          if (site.team === 'blue') continue;
          const dx = site.position.x - def.x;
          const dz = site.position.z - def.z;
          if (dx * dx + dz * dz > r2) continue;
          total++;
          if (!site.alive) done++;
        }
        // sites queued for a later spawn inside the circle still count
        for (const ps of s.pendingSites) {
          if (ps.kind !== 'sam') continue;
          const dx = ps.def.x - def.x;
          const dz = ps.def.z - def.z;
          if (dx * dx + dz * dz <= r2) total++;
        }
        st.progress = { done, total };
        if (total > 0 && done >= total) setState(s, o, 'complete');
        break;
      }
      case 'protect': {
        const g = s.groups.get(def.group);
        if (!g) break;
        const alive = g.members.length < g.expected ? g.expected - deadCount(g) : aliveCount(g);
        const min = Math.min(def.minSurvivors ?? 1, Math.max(1, g.expected));
        st.progress = { done: alive, total: g.expected };
        if (def.threat) {
          const tg = s.groups.get(def.threat.group);
          const left = tg ? Math.max(0, (tg.members.length < tg.expected ? tg.expected - deadCount(tg) : aliveCount(tg)) - drivenOffCount(s, tg)) : 0;
          if (!st.threat) st.threat = { label: def.threat.label, left };
          else st.threat.left = left;
        }
        if (g.spawnedAt >= 0 && alive < min) setState(s, o, 'failed');
        else if (def.until ? evalCondition(def.until, s) : false) setState(s, o, 'complete');
        else if (!def.until && def.primary && otherPrimariesDone(s, o) && hasOtherPrimaries(s, o)) setState(s, o, 'complete');
        break;
      }
      case 'intercept': {
        const pr = groupsProgress(s, def.groups);
        st.progress = { done: pr.done, total: pr.total };
        const r2 = def.radius * def.radius;
        let leaked = false;
        for (const id of def.groups) {
          const g = s.groups.get(id);
          if (!g) continue;
          for (const m of g.members) {
            if (!m.alive) continue;
            const dx = m.position.x - def.x;
            const dz = m.position.z - def.z;
            if (dx * dx + dz * dz <= r2) leaked = true;
          }
        }
        if (leaked && !o.aborted) {
          setState(s, o, 'failed');
          break;
        }
        if (pr.total > 0 && pr.spawnedAll && pr.done >= pr.total) {
          setState(s, o, 'complete');
          break;
        }
        const frac = def.abortFraction;
        if (frac !== undefined && pr.total > 0 && pr.spawnedAll && pr.done >= Math.max(1, Math.round(pr.total * frac)) && !o.aborted) {
          o.aborted = true;
          const to = def.abortTo ?? { x: 30_000, z: -30_000, altitude: 8000 };
          for (const id of def.groups) retaskGroup(s, id, { kind: 'rtb', x: to.x, z: to.z, altitude: to.altitude });
          s.radio.push({ from: s.awacsCallsign, text: `${s.callsign}, ${s.awacsSpoken}. The raid is turning back! Good work.`, voice: 'a_good_kill', priority: 2 });
          setState(s, o, 'complete');
        }
        break;
      }
      case 'waypoints': {
        let done = 0;
        for (const id of def.waypoints) if (s.waypointsReached.has(id)) done++;
        st.progress = { done, total: def.waypoints.length };
        if (done >= def.waypoints.length) setState(s, o, 'complete');
        break;
      }
      case 'reach': {
        if (p && p.alive) {
          const dx = p.position.x - def.x;
          const dz = p.position.z - def.z;
          const y = p.position.y;
          const inBand = (def.below === undefined || y <= def.below) && (def.above === undefined || y >= def.above);
          if (dx * dx + dz * dz <= def.radius * def.radius && inBand) setState(s, o, 'complete');
        }
        break;
      }
      case 'bridge': {
        if (s.stats.bridge) setState(s, o, 'complete');
        break;
      }
      case 'survive': {
        if (p && p.alive) {
          let inside = true;
          if (def.area) {
            const dx = p.position.x - def.area.x;
            const dz = p.position.z - def.area.z;
            inside = dx * dx + dz * dz <= def.area.radius * def.area.radius;
          }
          if (inside) o.accum += dt;
        }
        st.progress = { done: Math.floor(Math.min(o.accum, def.seconds)), total: def.seconds };
        if (o.accum >= def.seconds) setState(s, o, 'complete');
        break;
      }
      case 'missile_drill': {
        const recs = drillRecords(s, def.groups, o.openedAt ?? 0, def.guidance);
        let defeated = 0;
        let hits = 0;
        for (const r of recs) {
          if (r.outcome === 'hit') hits++;
          else if (r.outcome !== 'void' && (def.maxAgl === undefined || r.agl <= def.maxAgl)) defeated++;
        }
        st.progress = { done: Math.min(defeated, def.defeat), total: def.defeat };
        if (def.maxHits !== undefined && hits > def.maxHits) setState(s, o, 'failed');
        else if (defeated >= def.defeat) setState(s, o, 'complete');
        break;
      }
      case 'rtb': {
        if (p && p.alive) {
          const dx = p.position.x - def.x;
          const dz = p.position.z - def.z;
          if (dx * dx + dz * dz <= def.radius * def.radius) setState(s, o, 'complete');
        }
        break;
      }
    }
  }
  markObjectiveTargets(s);
}

/**
 * Flag the surface targets of the open primary objectives (`objective` on SAM sites and ground
 * targets): the sim's A/G auto-designation and TGT cycling rank them above every other surface target,
 * so a strike boxes its target, not the Shilka on the way, and a SEAD sortie still boxes its SAM first.
 * "Open" = active, or pending with no activation condition (it goes active on the first evaluation:
 * the flag is already set when the radar builds its first picture).
 */
export function markObjectiveTargets(s: MissionState): void {
  const w = s.world;
  for (const e of w.sams) e.objective = false;
  for (const e of w.ground) e.objective = false;
  for (const o of s.objectives) {
    const def = o.def;
    const st = o.status.state;
    if (!def.primary || !(st === 'active' || (st === 'pending' && !def.activeAt))) continue;
    if (def.kind === 'destroy') {
      for (const id of def.groups) {
        const g = s.groups.get(id);
        if (!g) continue;
        for (const m of g.members) if (m.kind === 'sam' || m.kind === 'ground') m.objective = true;
      }
    } else if (def.kind === 'destroy_sams') {
      const r2 = def.radius * def.radius;
      for (const site of w.sams) {
        const dx = site.position.x - def.x;
        const dz = site.position.z - def.z;
        if (site.team !== 'blue' && dx * dx + dz * dz <= r2) site.objective = true;
      }
    }
  }
}

function hasOtherPrimaries(s: MissionState, self: ObjectiveRt): boolean {
  for (const o of s.objectives) if (o !== self && o.def.primary && o.def.kind !== 'protect' && o.def.kind !== 'rtb') return true;
  return false;
}

/** Mark every still-active objective failed (mission lost) — no HUD spam. */
export function failOpenObjectives(s: MissionState): void {
  for (const o of s.objectives) if (o.status.state === 'active') setState(s, o, 'failed', false);
}

/** Summary used by the success/failure check and scoring. */
export function objectiveSummary(s: MissionState): {
  primaryTotal: number;
  primaryDone: number;
  primaryFailed: ObjectiveRt | null;
  secondaryTotal: number;
  secondaryDone: number;
  bonus: number;
} {
  let primaryTotal = 0;
  let primaryDone = 0;
  let secondaryTotal = 0;
  let secondaryDone = 0;
  let bonus = 0;
  let primaryFailed: ObjectiveRt | null = null;
  for (const o of s.objectives) {
    const done = o.status.state === 'complete';
    if (o.def.primary) {
      primaryTotal++;
      if (done) primaryDone++;
      if (o.status.state === 'failed' && !primaryFailed) primaryFailed = o;
    } else {
      secondaryTotal++;
      if (done) secondaryDone++;
    }
    if (done) bonus += earnedBonus(o);
  }
  return { primaryTotal, primaryDone, primaryFailed, secondaryTotal, secondaryDone, bonus };
}

/** Debrief tallies of protect objectives that ask for one (`tally`): survivors of the group. */
export function protectTallies(s: MissionState): { label: string; saved: number; total: number }[] {
  const out: { label: string; saved: number; total: number }[] = [];
  for (const o of s.objectives) {
    const def = o.def;
    if (def.kind !== 'protect' || !def.tally) continue;
    const g = s.groups.get(def.group);
    if (!g || g.expected <= 0) continue;
    const saved = g.members.length < g.expected ? g.expected - deadCount(g) : aliveCount(g);
    out.push({ label: def.tally, saved, total: g.expected });
  }
  return out;
}
