/**
 * F35-A — aircraft sensors & sensor fusion (updated at ~10 Hz per aircraft, staggered by id).
 *
 *  Fire-control radar  radar-equation range vs aspect-dependent RCS, ±60° gimbal, look-down
 *                      clutter + Doppler notch, terrain masking. Silent (EMCON) ⇒ no radar tracks.
 *  F-35 DAS            360° IR: aircraft within 15 km (missile launches → MAWS, see maws.ts)
 *  F-35 EOTS           forward: ground targets / SAM sites within 20 km with line of sight
 *  F-35 SAR            radar ground mode: ground targets / SAMs within 40 km in the gimbal
 *  Enemy IRST          forward ±60°, range ∝ √IR — finds a silent F-35 close in, no RWR warning
 *  Datalink            team picture (friendly own-sensor tracks, red GCI from EWRs/SAM radars,
 *                      A-50), friendly positions, known SAM sites / targets for blue
 *
 * Also: designation (cycle / nearest-to / direct / auto), radar lock, ground designation point.
 */
import { Vector3 } from 'three';
import type { Team } from '../../core/types';
import { forwardOf } from '../../core/math';
import type { AircraftEntity, AnyEntity, GroundTargetEntity, SamSiteEntity } from '../entities';
import type { AcCombatState, CombatCtx, TrackContact } from '../weapons/context';
import { acState, CONTACT_MEMORY, SENSOR_DIV } from '../weapons/context';
import { notchDepth } from '../weapons/guidance';
import { aircraftRcs, EWR_RANGE, EWR_STEALTH_BONUS, FIGHTER_RADAR, irIntensity, isStealthy, rcsRangeFactor } from './signatures';
import { lineOfSight } from './los';
import { updateRwr } from './rwr';
import { updateMaws } from './maws';
import { updateIrSeeker } from './irSeeker';

export const DAS_RANGE = 15_000;
/** DAS detects every missile launch (motor plume) within this range. */
export const DAS_LAUNCH_RANGE = 30_000;
export const EOTS_RANGE = 20_000;
export const SAR_RANGE = 40_000;
export const ACM_RANGE = 18_500;
export const KNOWN_TARGET_RANGE = 100_000;

const TEAMS: readonly Team[] = ['blue', 'red'];
const SOURCE_PRIORITY = { radar: 3, eots: 2, das: 2, datalink: 1 } as const;
type Source = keyof typeof SOURCE_PRIORITY;

const _rel = new Vector3();
const _fwd = new Vector3();
const _eye = new Vector3();

/* ───────────────────────── Team pictures (datalink) ───────────────────────── */

interface PictureEntry {
  id: number;
  team: Team;
  kind: 'aircraft' | 'sam' | 'ground';
  position: Vector3;
  velocity: Vector3;
  time: number;
}

export interface SensorShared {
  pictures: Record<Team, Map<number, PictureEntry>>;
  pool: PictureEntry[];
}

export function createSensorShared(): SensorShared {
  return { pictures: { blue: new Map(), red: new Map() }, pool: [] };
}

function pictureAdd(sh: SensorShared, team: Team, e: AnyEntity, time: number): void {
  const map = sh.pictures[team];
  let p = map.get(e.id);
  if (!p) {
    p = sh.pool.pop() ?? { id: 0, team: 'red', kind: 'aircraft', position: new Vector3(), velocity: new Vector3(), time: 0 };
    map.set(e.id, p);
  }
  p.id = e.id;
  p.team = e.team;
  p.kind = e.kind === 'aircraft' ? 'aircraft' : e.kind === 'sam' ? 'sam' : 'ground';
  p.position.copy(e.position);
  p.velocity.copy(e.velocity);
  p.time = time;
}

function buildTeamPictures(ctx: CombatCtx, sh: SensorShared): void {
  const world = ctx.world;
  const now = ctx.time;
  for (const team of TEAMS) {
    const map = sh.pictures[team];
    for (const p of map.values()) sh.pool.push(p);
    map.clear();
  }
  // own-sensor tracks of every friendly aircraft
  for (const ac of world.aircraft) {
    if (!ac.alive) continue;
    const st = acState(ac);
    for (const c of st.contacts.values()) {
      if (c.team === ac.team || c.ownTime < now - 0.35) continue;
      const e = world.getEntity(c.id);
      if (e && e.alive) pictureAdd(sh, ac.team, e, c.ownTime);
    }
  }
  // IADS: SAM radars share their tracks
  for (const s of world.sams) {
    if (!s.alive || !s.radarOn || s.trackedTargetId == null) continue;
    const t = world.getEntity(s.trackedTargetId);
    if (t && t.alive) pictureAdd(sh, s.team, t, now);
  }
  // GCI: early-warning radars (VHF — better against stealth), terrain-masked, radar horizon
  for (const g of world.ground) {
    if (!g.alive || !g.emitter) continue;
    _eye.copy(g.position);
    _eye.y += 20;
    for (const t of world.aircraft) {
      if (!t.alive || t.team === g.team) continue;
      const d = t.position.distanceTo(g.position);
      if (d > EWR_RANGE * 1.6) continue;
      const sigma = aircraftRcs(t, g.position) * (isStealthy(t) ? EWR_STEALTH_BONUS : 1);
      if (d > EWR_RANGE * rcsRangeFactor(sigma)) continue;
      const agl = t.position.y - world.terrain.surfaceHeightAt(t.position.x, t.position.z);
      if (agl < 150 && d > 20_000) continue; // below the radar horizon / in the clutter
      if (!lineOfSight(world.terrain, _eye, t.position)) continue;
      pictureAdd(sh, g.team, t, now);
    }
  }
}

/* ───────────────────────── Contacts ───────────────────────── */

function upsert(st: AcCombatState, e: AnyEntity, source: Source, now: number, pos: Vector3 | null, vel: Vector3 | null, time: number): TrackContact {
  let c = st.contacts.get(e.id);
  if (!c) {
    c = st.contactPool.pop() ?? {
      id: 0,
      lastSeen: -1,
      position: new Vector3(),
      velocity: new Vector3(),
      team: 'red',
      source: 'datalink',
      radarTime: -999,
      ownTime: -999,
      inGimbal: false,
      entityKind: 'aircraft',
    };
    c.id = e.id;
    c.lastSeen = -1;
    c.radarTime = -999;
    c.ownTime = -999;
    c.inGimbal = false;
    st.contacts.set(e.id, c);
  }
  c.entityKind = e.kind === 'aircraft' ? 'aircraft' : e.kind === 'sam' ? 'sam' : 'ground';
  c.team = e.team;
  if (source === 'datalink') {
    if (c.ownTime === now) return c; // an onboard sensor already holds it this sweep
    c.source = 'datalink';
    c.position.copy(pos ?? e.position);
    c.velocity.copy(vel ?? e.velocity);
    c.lastSeen = time;
    return c;
  }
  if (c.ownTime !== now || SOURCE_PRIORITY[source] > SOURCE_PRIORITY[c.source]) c.source = source;
  c.position.copy(pos ?? e.position);
  c.velocity.copy(vel ?? e.velocity);
  c.lastSeen = now;
  c.ownTime = now;
  if (source === 'radar') c.radarTime = now;
  return c;
}

/** Full sensor sweep of one aircraft. */
function scan(ctx: CombatCtx, ac: AircraftEntity, st: AcCombatState, sh: SensorShared): void {
  const world = ctx.world;
  const now = ctx.time;
  const spec = FIGHTER_RADAR[ac.type];
  const radarOn = ac.radar.emitting && spec.range > 0 && ac.damage.avionics < 0.9;
  forwardOf(ac.quaternion, _fwd);
  const cosGimbal = Math.cos(spec.gimbal);
  const f35 = ac.type === 'f35a';
  for (const c of st.contacts.values()) c.inGimbal = false;

  // ── air targets ──
  for (const t of world.aircraft) {
    if (t === ac || !t.alive) continue;
    if (t.team === ac.team) {
      upsert(st, t, 'datalink', now, null, null, now); // friendly positions via datalink
      continue;
    }
    _rel.subVectors(t.position, ac.position);
    const d = _rel.length();
    if (d < 1) continue;
    const cosOff = _fwd.dot(_rel) / d;
    let los = -1; // lazy terrain check: -1 unknown, 0 blocked, 1 clear
    let inGimbal = false;
    if (radarOn && cosOff >= cosGimbal) {
      inGimbal = true;
      let R = spec.range * rcsRangeFactor(aircraftRcs(t, ac.position));
      if (ac.radar.mode === 'acm') R = Math.min(R, ACM_RANGE);
      else if (ac.radar.mode === 'ground') R *= 0.6; // interleaved A/A while mapping
      if (_rel.y < -0.03 * d) R *= 0.85; // look-down clutter
      if (d <= R && notchDepth(ctx, ac.position, t) < 0.5) {
        los = lineOfSight(world.terrain, ac.position, t.position) ? 1 : 0;
        if (los === 1) upsert(st, t, 'radar', now, null, null, now);
      }
    }
    let passive = false;
    if (f35) passive = d <= DAS_RANGE;
    else if (spec.irst > 0 && cosOff >= 0.5) passive = d <= spec.irst * Math.sqrt(irIntensity(t, ac.position));
    if (passive) {
      if (los < 0) los = lineOfSight(world.terrain, ac.position, t.position) ? 1 : 0;
      if (los === 1) upsert(st, t, f35 ? 'das' : 'eots', now, null, null, now);
    }
    const c = st.contacts.get(t.id);
    if (c && inGimbal) c.inGimbal = true;
  }

  // ── ground targets / SAM sites (F-35 EOTS + SAR + known intel) ──
  if (f35 || ac.team === 'blue') {
    scanGround(ctx, ac, st, world.sams, radarOn, now);
    scanGround(ctx, ac, st, world.ground, radarOn, now);
  }

  // ── datalink team picture ──
  const pic = sh.pictures[ac.team];
  for (const p of pic.values()) {
    const existing = st.contacts.get(p.id);
    if (existing && existing.ownTime === now) continue;
    if (p.time < now - 0.5) continue;
    const e = world.getEntity(p.id);
    if (!e || !e.alive) continue;
    upsert(st, e, 'datalink', now, p.position, p.velocity, p.time);
  }

  // ── prune ──
  for (const c of st.contacts.values()) {
    const e = world.getEntity(c.id);
    if (!e || !e.alive || c.lastSeen < now - CONTACT_MEMORY) {
      st.contacts.delete(c.id);
      st.contactPool.push(c);
    }
  }
  const arr = ac.radar.contacts;
  arr.length = 0;
  for (const c of st.contacts.values()) arr.push(c);
}

function scanGround(
  ctx: CombatCtx,
  ac: AircraftEntity,
  st: AcCombatState,
  list: readonly (SamSiteEntity | GroundTargetEntity)[],
  radarOn: boolean,
  now: number,
): void {
  const world = ctx.world;
  const f35 = ac.type === 'f35a';
  const cosGimbal = Math.cos(FIGHTER_RADAR[ac.type].gimbal);
  for (const g of list) {
    if (!g.alive || g.team === ac.team) continue;
    _rel.subVectors(g.position, ac.position);
    const d = _rel.length();
    if (d > KNOWN_TARGET_RANGE) continue;
    const cosOff = d > 1 ? _fwd.dot(_rel) / d : 1;
    let seen = false;
    if (f35 && d <= SAR_RANGE && ((d <= EOTS_RANGE && cosOff >= 0) || (radarOn && ac.radar.mode === 'ground' && cosOff >= cosGimbal))) {
      _eye.copy(g.position);
      _eye.y += 8;
      if (lineOfSight(world.terrain, ac.position, _eye)) {
        const src: Source = d <= EOTS_RANGE && cosOff >= 0 ? 'eots' : 'radar';
        upsert(st, g, src, now, null, null, now);
        seen = true;
        if (g.kind === 'sam' && ac.team === 'blue') g.known = true;
      }
    }
    if (!seen && g.known && ac.team === 'blue') upsert(st, g, 'datalink', now, null, null, now);
  }
}

/**
 * F-35 DAS sees every missile launch within 30 km: the launching aircraft becomes a DAS track
 * (for a few seconds) even if it is outside radar / DAS aircraft range — a key fusion cue.
 */
export function dasLaunchCue(ctx: CombatCtx, shooter: AircraftEntity): void {
  const world = ctx.world;
  for (const ac of world.aircraft) {
    if (!ac.alive || ac.type !== 'f35a' || ac.team === shooter.team) continue;
    if (ac.position.distanceTo(shooter.position) > DAS_LAUNCH_RANGE) continue;
    if (!lineOfSight(world.terrain, ac.position, shooter.position)) continue;
    const st = acState(ac);
    const had = st.contacts.has(shooter.id);
    const c = upsert(st, shooter, 'das', ctx.time, null, null, ctx.time);
    if (!had) ac.radar.contacts.push(c);
  }
}

/* ───────────────────────── Designation & lock ───────────────────────── */

export function setDesignation(ctx: CombatCtx, ac: AircraftEntity, id: number | null): void {
  const r = ac.radar;
  if (r.designatedId === id) return;
  r.designatedId = id;
  r.lockProgress = 0;
  const st = acState(ac);
  st.designationStale = 0;
  if (r.lockedId !== null && r.lockedId !== id) {
    const old = r.lockedId;
    r.lockedId = null;
    ctx.world.events.emit('lock', { ownerId: ac.id, targetId: old, locked: false });
  }
  updateGroundPoint(ctx, ac, st);
  ctx.world.events.emit('designate', { ownerId: ac.id, targetId: id });
}

function updateGroundPoint(ctx: CombatCtx, ac: AircraftEntity, st: AcCombatState): void {
  const e = ctx.world.getEntity(ac.radar.designatedId);
  if (e && e.alive && (e.kind === 'ground' || e.kind === 'sam')) {
    const c = st.contacts.get(e.id);
    st.groundPoint.copy(c ? c.position : e.position);
    ac.radar.groundPoint = st.groundPoint;
  } else {
    ac.radar.groundPoint = null;
  }
}

function isAirMode(ac: AircraftEntity): boolean {
  return ac.radar.mode !== 'ground';
}

/** Threat rank of a hostile aircraft toward `ac`: 2 = locked/guiding on us, 1 = designating us. */
function threatRank(ctx: CombatCtx, ac: AircraftEntity, id: number): number {
  const e = ctx.world.getEntity(id);
  if (!e || e.kind !== 'aircraft') return 0;
  if (e.radar.lockedId === ac.id) return 2;
  if (e.radar.designatedId === ac.id) return 1;
  return 0;
}

/**
 * Designation priority of a contact (higher first), or NaN if not eligible in the current mode.
 * A/A: threat to us › in front (±60°) › range. A/G: (emitting, with AARGM) › in front › range.
 * Requires _fwd = nose of `ac`.
 */
function candidateKey(ctx: CombatCtx, ac: AircraftEntity, c: TrackContact): number {
  if (c.team === ac.team) return NaN;
  const air = isAirMode(ac);
  if (air !== (c.entityKind === 'aircraft')) return NaN;
  _rel.subVectors(c.position, ac.position);
  const d = Math.max(1, _rel.length());
  const inFront = _fwd.dot(_rel) / d >= (air ? 0.5 : 0.7) ? 1 : 0;
  if (air) return threatRank(ctx, ac, c.id) * 1e9 + inFront * 1e7 - d;
  const e = ctx.world.getEntity(c.id);
  const emitting = e && ((e.kind === 'sam' && e.radarOn) || (e.kind === 'ground' && e.emitter)) ? 1 : 0;
  return (ac.selectedWeapon === 'aargm' ? emitting * 1e9 : 0) + inFront * 1e7 - d;
}

/** Candidates for designation in the current mode, sorted by priority (allocates; input-driven). */
function candidates(ctx: CombatCtx, ac: AircraftEntity, st: AcCombatState): TrackContact[] {
  forwardOf(ac.quaternion, _fwd);
  const list: { c: TrackContact; key: number }[] = [];
  for (const c of st.contacts.values()) {
    const key = candidateKey(ctx, ac, c);
    if (!Number.isNaN(key)) list.push({ c, key });
  }
  list.sort((a, b) => b.key - a.key);
  return list.map((x) => x.c);
}

export function cycleTarget(ctx: CombatCtx, ac: AircraftEntity): void {
  const st = acState(ac);
  const list = candidates(ctx, ac, st);
  if (list.length === 0) return;
  const idx = list.findIndex((c) => c.id === ac.radar.designatedId);
  const next = list[(idx + 1) % list.length];
  setDesignation(ctx, ac, next.id);
}

export function designateNearestTo(ctx: CombatCtx, ac: AircraftEntity, dir: Vector3): void {
  const st = acState(ac);
  const dl = dir.length();
  if (dl < 1e-6) return;
  let best: TrackContact | null = null;
  let bestCos = Math.cos(0.5);
  for (const c of st.contacts.values()) {
    if (c.team === ac.team) continue;
    _rel.subVectors(c.position, ac.position);
    const d = _rel.length();
    if (d < 1) continue;
    const cos = _rel.dot(dir) / (d * dl);
    if (cos > bestCos) {
      bestCos = cos;
      best = c;
    }
  }
  if (best) setDesignation(ctx, ac, best.id);
}

export function designate(ctx: CombatCtx, ac: AircraftEntity, id: number | null): void {
  if (id === null) return setDesignation(ctx, ac, null);
  const st = acState(ac);
  const c = st.contacts.get(id);
  if (!c || c.team === ac.team) return;
  setDesignation(ctx, ac, id);
}

/** Drop designations of dead targets or targets missing from the picture for > 3 s. */
function validateDesignation(ctx: CombatCtx, ac: AircraftEntity, st: AcCombatState, sdt: number): void {
  const id = ac.radar.designatedId;
  if (id === null) return;
  const e = ctx.world.getEntity(id);
  if (!e || !e.alive) return setDesignation(ctx, ac, null);
  if (!st.contacts.has(id)) {
    st.designationStale += sdt;
    if (st.designationStale > 3) setDesignation(ctx, ac, null);
  } else st.designationStale = 0;
}

/** With nothing designated, pick the most threatening contact in front. */
function autoDesignate(ctx: CombatCtx, ac: AircraftEntity, st: AcCombatState): void {
  if (ac.radar.designatedId !== null) return;
  forwardOf(ac.quaternion, _fwd);
  let c: TrackContact | null = null;
  let best = -Infinity;
  for (const k of st.contacts.values()) {
    const key = candidateKey(ctx, ac, k);
    if (key > best) {
      best = key;
      c = k;
    }
  }
  if (!c) return;
  _rel.subVectors(c.position, ac.position);
  const d = Math.max(1, _rel.length());
  const inFront = _fwd.dot(_rel) / d >= (isAirMode(ac) ? 0.5 : 0.7);
  const threat = c.entityKind === 'aircraft' && threatRank(ctx, ac, c.id) > 0;
  if (inFront || threat) setDesignation(ctx, ac, c.id);
}

/** Radar STT lock progression (every step). */
function updateLock(ctx: CombatCtx, ac: AircraftEntity, st: AcCombatState, dt: number): void {
  const r = ac.radar;
  const des = r.designatedId;
  const c = des !== null ? st.contacts.get(des) : undefined;
  const canLock = !!c && c.entityKind === 'aircraft' && r.emitting && c.inGimbal && c.radarTime >= ctx.time - 0.35;
  const lockTime = ac.isPlayer ? ctx.world.difficulty.playerLockTime : st.lockTime;
  if (canLock) {
    st.lockLostTimer = 0;
    if (r.lockedId !== des) {
      r.lockProgress = Math.min(1, r.lockProgress + dt / Math.max(0.05, lockTime));
      if (r.lockProgress >= 1) {
        r.lockedId = des;
        ctx.world.events.emit('lock', { ownerId: ac.id, targetId: des, locked: true });
      }
    }
  } else if (r.lockedId !== null) {
    st.lockLostTimer += dt;
    if (st.lockLostTimer > 2 || !r.emitting) {
      const old = r.lockedId;
      r.lockedId = null;
      r.lockProgress = 0;
      st.lockLostTimer = 0;
      ctx.world.events.emit('lock', { ownerId: ac.id, targetId: old, locked: false });
    }
  } else {
    r.lockProgress = Math.max(0, r.lockProgress - dt * 0.5);
  }
}

/** Radar emission on/off (EMCON). Silent: radar tracks and the STT lock drop. */
export function setRadarEmitting(ctx: CombatCtx, ac: AircraftEntity, emitting: boolean): void {
  ac.radar.emitting = emitting;
  if (!emitting && ac.radar.lockedId !== null) {
    const old = ac.radar.lockedId;
    ac.radar.lockedId = null;
    ac.radar.lockProgress = 0;
    ctx.world.events.emit('lock', { ownerId: ac.id, targetId: old, locked: false });
  }
}

/* ───────────────────────── Main entry ───────────────────────── */

export function updateSensors(ctx: CombatCtx, sh: SensorShared, dt: number): void {
  const world = ctx.world;
  if (ctx.tick % SENSOR_DIV === 0) buildTeamPictures(ctx, sh);
  for (const ac of world.aircraft) {
    const st = acState(ac);
    if (!ac.alive) {
      if (ac.radar.lockedId !== null) {
        const old = ac.radar.lockedId;
        ac.radar.lockedId = null;
        ac.radar.lockProgress = 0;
        ctx.world.events.emit('lock', { ownerId: ac.id, targetId: old, locked: false });
      }
      ac.incoming.length = 0;
      ac.rwr.length = 0;
      continue;
    }
    if (st.lastSensorTime < 0) st.lockTime = 3 - 2.2 * world.difficulty.aiSkill;
    if ((ctx.tick + ac.id) % SENSOR_DIV === 0 || st.lastSensorTime < 0) {
      const sdt = st.lastSensorTime < 0 ? SENSOR_DIV / 60 : ctx.time - st.lastSensorTime;
      st.lastSensorTime = ctx.time;
      scan(ctx, ac, st, sh);
      validateDesignation(ctx, ac, st, sdt);
      autoDesignate(ctx, ac, st);
      updateRwr(ctx, ac, st, sdt);
      updateMaws(ctx, ac, st);
      if (!ac.isPlayer) updateIrSeeker(ctx, ac, st);
    }
    if (ac.isPlayer) updateIrSeeker(ctx, ac, st);
    updateLock(ctx, ac, st, dt);
    if (ac.radar.designatedId !== null) updateGroundPoint(ctx, ac, st);
  }
}
