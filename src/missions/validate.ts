/**
 * F35-A — mission definition validator (used by the unit tests and handy in dev):
 * unique ids, positions inside the world, every referenced group/objective/waypoint exists,
 * loadouts and gun rounds, pads under every SAM and static ground target, and a player start
 * outside the threat rings of every SAM that exists at mission start.
 */
import type { MissionDef } from '../core/contracts';
import { DIFFICULTIES, LOADOUTS } from '../core/data';
import { SAM_DATA } from '../sim/sam/samData';
import type { Difficulty, SamType } from '../core/types';
import { conditionRefs } from './runtime/conditions';
import { groundPadRadius, samPadRadius, terrainPadsFor } from './pads';
import type { Action, Condition, TaskDef } from './schema';

/** Everything must stay inside ±LIMIT metres. */
export const WORLD_LIMIT = 36_000;

/** Worst-case (Veteran) SAM range scale. */
const WORST_RANGE_SCALE = 1;

/**
 * Radius (m) inside which a SAM of this type can reasonably engage a (stealthy or beast-mode)
 * F-35 — the player should never start inside it.
 */
export function samThreatRadius(type: SamType): number {
  const d = SAM_DATA[type];
  return Math.min(d.engageMax, d.detectRange * 0.45) * WORST_RANGE_SCALE;
}

export function validateMission(def: MissionDef): string[] {
  const errors: string[] = [];
  const err = (m: string) => errors.push(`${def.id}: ${m}`);
  const sc = def.script;
  const inWorld = (x: number, z: number, what: string) => {
    if (!isFinite(x) || !isFinite(z) || Math.abs(x) > WORLD_LIMIT || Math.abs(z) > WORLD_LIMIT) err(`${what} out of bounds (${Math.round(x)}, ${Math.round(z)})`);
  };

  if (!def.id) err('missing id');
  if (!def.title) err('missing title');
  if (def.briefing.length === 0) err('empty briefing');
  if (!def.allowedLoadouts.includes(def.recommendedLoadout)) err('allowedLoadouts does not include the recommended loadout');
  for (const l of def.allowedLoadouts) if (!LOADOUTS[l]) err(`unknown loadout ${l}`);
  // per-mission gun rounds: a whole number, or a non-empty per-difficulty table of them
  if (def.gunAmmo !== undefined) {
    const rounds = (n: unknown, what: string) => {
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) err(`gunAmmo${what} must be a whole number of rounds ≥ 0`);
    };
    if (typeof def.gunAmmo === 'number') rounds(def.gunAmmo, '');
    else {
      const entries = Object.entries(def.gunAmmo);
      if (entries.length === 0) err('gunAmmo per difficulty is empty');
      for (const [d, n] of entries) {
        if (!DIFFICULTIES[d as Difficulty]) err(`gunAmmo for unknown difficulty "${d}"`);
        rounds(n, `.${d}`);
      }
    }
  }

  // player start
  const p = def.player;
  inWorld(p.x, p.z, 'player start');
  if (!(p.altitude >= 200)) err('player altitude below 200 m');
  if (!(p.speed >= 150 && p.speed <= 420)) err('player speed out of range');

  // unique ids
  const unique = (ids: string[], what: string) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (!id) err(`${what} with empty id`);
      if (seen.has(id)) err(`duplicate ${what} id "${id}"`);
      seen.add(id);
    }
  };
  unique(sc.groups.map((g) => g.id), 'aircraft group');
  unique(sc.sams.map((s) => s.id), 'SAM site');
  unique(sc.ground.map((g) => g.id), 'ground target');
  unique(sc.objectives.map((o) => o.id), 'objective');
  unique(sc.waypoints.map((w) => w.id), 'waypoint');
  unique(sc.triggers.map((t) => t.id), 'trigger');
  unique((sc.hints ?? []).map((h) => h.id), 'hint');

  const groups = new Set<string>([...sc.groups.map((g) => g.id), ...sc.sams.map((s) => s.group), ...sc.ground.map((g) => g.group)]);
  for (const g of sc.groups) if (sc.sams.some((s) => s.group === g.id) || sc.ground.some((t) => t.group === g.id)) err(`group id "${g.id}" used by both aircraft and ground/SAM`);
  const objectives = new Set(sc.objectives.map((o) => o.id));
  const waypoints = new Set(sc.waypoints.map((w) => w.id));
  const triggers = new Set(sc.triggers.map((t) => t.id));

  const checkGroup = (id: string, where: string) => {
    if (!groups.has(id)) err(`${where} references unknown group "${id}"`);
  };
  const checkCond = (c: Condition | undefined, where: string) => {
    if (!c) return;
    const refs = { groups: [] as string[], objectives: [] as string[], waypoints: [] as string[], triggers: [] as string[] };
    conditionRefs(c, refs);
    for (const t of refs.triggers) if (!triggers.has(t)) err(`${where} references unknown trigger "${t}"`);
    for (const g of refs.groups) checkGroup(g, where);
    for (const o of refs.objectives) if (!objectives.has(o)) err(`${where} references unknown objective "${o}"`);
    for (const w of refs.waypoints) if (!waypoints.has(w)) err(`${where} references unknown waypoint "${w}"`);
    if (c.kind === 'area') inWorld(c.x, c.z, `${where} area`);
    if (c.kind === 'all' || c.kind === 'any') for (const sub of c.of) if (sub.kind === 'area') inWorld(sub.x, sub.z, `${where} area`);
  };
  const checkTask = (t: TaskDef | undefined, where: string) => {
    if (!t) return;
    switch (t.kind) {
      case 'patrol':
      case 'rtb':
        inWorld(t.x, t.z, `${where} task`);
        break;
      case 'route':
        if (t.points.length === 0) err(`${where} route has no points`);
        t.points.forEach((q, i) => inWorld(q.x, q.z, `${where} route point ${i}`));
        break;
      case 'attack_group':
      case 'escort_group':
        checkGroup(t.group, `${where} task`);
        break;
      default:
        break;
    }
  };
  const checkAction = (a: Action, where: string) => {
    switch (a.kind) {
      case 'spawn':
      case 'reveal':
      case 'hold_fire':
        checkGroup(a.group, where);
        break;
      case 'respawn':
        if (!sc.groups.some((g) => g.id === a.group)) err(`${where} respawns "${a.group}", which is not an aircraft group`);
        break;
      case 'retask':
        checkGroup(a.group, where);
        checkTask(a.task, where);
        break;
      case 'strike':
        checkGroup(a.group, where);
        if (a.by) checkGroup(a.by, where);
        break;
      case 'activate_objective':
        if (!objectives.has(a.id)) err(`${where} activates unknown objective "${a.id}"`);
        break;
      case 'set_waypoint':
        if (!waypoints.has(a.id)) err(`${where} sets unknown waypoint "${a.id}"`);
        break;
      default:
        break;
    }
  };

  // aircraft groups
  sc.groups.forEach((g, idx) => {
    const where = `group ${g.id}`;
    inWorld(g.x, g.z, where);
    if (!(g.count >= 1)) err(`${where} count < 1`);
    // a group placed relative to the player has its altitude above the player (spawnAirGroup keeps it clear of the ground)
    if (g.relative === 'player') {
      if (!(Math.abs(g.altitude) <= 3000)) err(`${where} is more than 3 km above or below the player`);
    } else if (!(g.altitude >= 100)) err(`${where} altitude below 100 m`);
    if (g.oneWay) {
      // one-way drones (Shahed-136) cruise at about 51 m/s
      if (!(g.speed >= 30)) err(`${where} drone speed below 30 m/s`);
      inWorld(g.oneWay.targetX, g.oneWay.targetZ, `${where} drone target`);
      g.oneWay.route?.forEach((q, i) => inWorld(q.x, q.z, `${where} drone route ${i}`));
      if (g.oneWay.stagger !== undefined && !(g.oneWay.stagger >= 0 && g.oneWay.stagger <= 500)) err(`${where} drone stagger outside 0–500 m`);
    } else if (!(g.speed >= 100)) err(`${where} speed below 100 m/s`);
    checkCond(g.spawn, where);
    checkTask(g.task, where);
    if (g.task?.kind === 'escort_group' || g.task?.kind === 'attack_group') {
      const ref = g.task.group;
      const j = sc.groups.findIndex((o) => o.id === ref);
      if (j > idx && (!g.spawn || g.spawn.kind === 'start')) err(`${where} escorts/attacks group "${ref}" defined after it`);
    }
  });
  // SAMs & ground
  for (const s of sc.sams) {
    inWorld(s.x, s.z, `SAM ${s.id}`);
    checkCond(s.spawn, `SAM ${s.id}`);
    s.path?.forEach((q, i) => inWorld(q.x, q.z, `SAM ${s.id} path ${i}`));
    if ((s.path || s.escort) && s.type !== 'ad_boat') err(`SAM ${s.id}: only an AD boat moves (path / escort)`);
    if (s.escort) checkGroup(s.escort, `SAM ${s.id} escort`);
  }
  for (const g of sc.ground) {
    inWorld(g.x, g.z, `ground ${g.id}`);
    g.path?.forEach((q, i) => inWorld(q.x, q.z, `ground ${g.id} path ${i}`));
    checkCond(g.spawn, `ground ${g.id}`);
    if (g.vessel && g.type !== 'ship') err(`ground ${g.id} has a vessel class but is not a ship`);
    if (g.type === 'ship' && !g.vessel) err(`ground ${g.id}: a ship needs a vessel class`);
    if (g.hitsToSink !== undefined && (!g.vessel || !(g.hitsToSink >= 1))) err(`ground ${g.id}: hitsToSink needs a vessel class and must be ≥ 1`);
    if (g.hitsToSink !== undefined && g.team !== 'neutral') err(`ground ${g.id}: hitsToSink needs team 'neutral' (only a civil ship takes several hits)`);
    if (g.chase !== undefined && g.type !== 'suicide_boat') err(`ground ${g.id}: only a suicide boat chases`);
    if (g.strike !== undefined && g.type !== 'missile_boat') err(`ground ${g.id}: only a missile boat has a strike`);
    if (g.runner !== undefined && g.type !== 'stoat' && g.type !== 'rat') err(`ground ${g.id}: only a stoat or a rat has a runner route`);
    if ((g.type === 'stoat' || g.type === 'rat') && (!g.runner || g.runner.route.length === 0)) err(`ground ${g.id}: a ${g.type} needs its route (stations, then the goal)`);
    if (g.runner) for (const k of g.runner.stations) if (!(k >= 0 && k < g.runner.route.length - 1)) err(`ground ${g.id}: bait station ${k} is not a point before the goal`);
    if (g.chase) checkGroup(g.chase, `ground ${g.id} chase`);
    if (g.strike) checkGroup(g.strike.group, `ground ${g.id} strike`);
  }
  // objectives
  if (!sc.freeFlight && !sc.objectives.some((o) => o.primary)) err('no primary objective');
  for (const o of sc.objectives) {
    const where = `objective ${o.id}`;
    checkCond(o.activeAt, where);
    switch (o.kind) {
      case 'destroy':
        if (o.groups.length === 0) err(`${where} has no groups`);
        o.groups.forEach((g) => checkGroup(g, where));
        break;
      case 'protect':
        checkGroup(o.group, where);
        checkCond(o.until, where);
        if (o.threat) checkGroup(o.threat.group, `${where} threat`);
        break;
      case 'intercept':
        o.groups.forEach((g) => checkGroup(g, where));
        inWorld(o.x, o.z, where);
        break;
      case 'waypoints':
        for (const w of o.waypoints) if (!waypoints.has(w)) err(`${where} references unknown waypoint "${w}"`);
        break;
      case 'destroy_sams':
        inWorld(o.x, o.z, where);
        if (!sc.sams.some((s) => Math.hypot(s.x - o.x, s.z - o.z) <= o.radius)) err(`${where} circle contains no SAM site`);
        break;
      case 'reach':
      case 'rtb':
        inWorld(o.x, o.z, where);
        break;
      case 'survive':
        if (o.area) inWorld(o.area.x, o.area.z, where);
        break;
      case 'bridge':
        if (def.theater !== 'auckland') err(`${where} needs the Harbour Bridge (Auckland theatre)`);
        break;
      case 'missile_drill':
        if (!sc.defenceCoach) err(`${where} needs script.defenceCoach (the coach keeps the missile log it counts)`);
        if (o.groups.length === 0) err(`${where} has no groups`);
        o.groups.forEach((g) => checkGroup(g, where));
        if (!(o.defeat >= 1)) err(`${where} defeat must be ≥ 1`);
        if (o.moveOn !== undefined && !(o.moveOn >= 1)) err(`${where} moveOn must be ≥ 1`);
        break;
    }
  }
  // objectives about difficulty-gated groups must be gated at least as strictly
  const order = ['recruit', 'pilot', 'veteran'];
  const gate = (id: string): number => {
    const a = sc.groups.find((g) => g.id === id);
    if (a) return order.indexOf(a.minDifficulty ?? 'recruit');
    const members = [...sc.sams.filter((x) => x.group === id), ...sc.ground.filter((x) => x.group === id)];
    return members.length ? Math.min(...members.map((m) => order.indexOf(m.minDifficulty ?? 'recruit'))) : 0;
  };
  for (const o of sc.objectives) {
    const refs = o.kind === 'destroy' || o.kind === 'intercept' ? o.groups : o.kind === 'protect' ? [o.group] : [];
    const need = Math.max(0, ...refs.map(gate));
    if (need > order.indexOf(o.minDifficulty ?? 'recruit')) err(`objective ${o.id} references a difficulty-gated group but has no matching minDifficulty`);
  }

  // waypoints
  for (const w of sc.waypoints) {
    inWorld(w.x, w.z, `waypoint ${w.id}`);
    if (w.objective && !objectives.has(w.objective)) err(`waypoint ${w.id} references unknown objective "${w.objective}"`);
  }
  // triggers & hints
  for (const t of sc.triggers) {
    checkCond(t.when, `trigger ${t.id}`);
    t.actions.forEach((a) => checkAction(a, `trigger ${t.id}`));
  }
  (sc.opening ?? []).forEach((a) => checkAction(a, 'opening'));
  for (const h of sc.hints ?? []) {
    checkCond(h.when, `hint ${h.id}`);
    checkCond(h.until, `hint ${h.id}`);
  }
  // briefing data
  for (const m of def.intel) inWorld(m.x, m.z, `intel "${m.label}"`);
  for (const f of def.features) inWorld(f.x, f.z, `feature ${f.type}`);

  // pads under every SAM and static land target
  const pads = terrainPadsFor(def);
  const covered = (x: number, z: number) => pads.some((pd) => Math.hypot(pd.x - x, pd.z - z) <= pd.radius + 1);
  for (const s of sc.sams) if (samPadRadius(s) > 0 && !covered(s.x, s.z)) err(`SAM ${s.id} has no terrain pad`);
  for (const g of sc.ground) if (groundPadRadius(g) > 0 && !covered(g.x, g.z)) err(`ground ${g.id} has no terrain pad`);

  // player starts outside every initial threat ring
  for (const s of sc.sams) {
    if (s.spawn && s.spawn.kind !== 'start') continue;
    const d = Math.hypot(s.x - p.x, s.z - p.z);
    const r = samThreatRadius(s.type);
    if (d < r) err(`player starts inside the ${s.type} ${s.id} threat ring (${(d / 1000).toFixed(1)} km < ${(r / 1000).toFixed(1)} km)`);
  }
  return errors;
}
