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
 * Also: designation (cycle / nearest-to / direct / auto / shoot list), radar lock, ground designation point.
 */
import { Vector3 } from 'three';
import { isHostile, type Team } from '../../core/types';
import { forwardOf } from '../../core/math';
import type { AircraftEntity, AnyEntity, GroundTargetEntity, SamSiteEntity } from '../entities';
import type { AcCombatState, CombatCtx, TrackContact } from '../weapons/context';
import { acState, CONTACT_MEMORY, playerTeam, SENSOR_DIV } from '../weapons/context';
import { cmFactor, notchDepth, rollNotchNeed, stepNotch } from '../weapons/ew';
import { aircraftRcs, EWR_RANGE, EWR_STEALTH_BONUS, fcrStealthFactor, FIGHTER_RADAR, irIntensity, isStealthy, rcsRangeFactor } from './signatures';
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

const TEAMS: readonly Team[] = ['blue', 'red', 'neutral'];
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
  return { pictures: { blue: new Map(), red: new Map(), neutral: new Map() }, pool: [] };
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
      // civil traffic stays off the datalink: only the human player's own sensors show it
      if (c.team === ac.team || c.team === 'neutral' || c.ownTime < now - 0.35) continue;
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
      if (!t.alive || !isHostile(g.team, t.team)) continue;
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
      notchAccum: 0,
      notchNeed: -1,
    };
    c.id = e.id;
    c.lastSeen = -1;
    c.radarTime = -999;
    c.ownTime = -999;
    c.inGimbal = false;
    c.notchAccum = 0;
    c.notchNeed = -1;
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

/**
 * Doppler notch vs a fighter radar: a target that is not yet tracked can't be picked up while it
 * sits in the notch (depth ≥ 0.5); an existing track survives short notches and is lost only once
 * the notch has been held long enough (sustained-notch accumulator, ew.ts).
 */
function radarHolds(ctx: CombatCtx, ac: AircraftEntity, st: AcCombatState, t: AircraftEntity, now: number, sdt: number, resistance: number): boolean {
  const c = st.contacts.get(t.id);
  if (c && c.notchNeed === Infinity) return true; // this radar/track isn't fooled by the notch
  if (t.team === 'neutral') return true; // airliners fly straight and level: never notch
  const depth = notchDepth(ctx, ac.position, t);
  if (!c || c.radarTime < now - 1) return depth < 0.5;
  if (c.notchNeed < 0) c.notchNeed = rollNotchNeed(ctx, resistance, cmFactor(ctx, ac.team, t));
  if (c.notchNeed === Infinity) return true;
  c.notchAccum = stepNotch(c.notchAccum, depth, sdt);
  if (c.notchAccum < c.notchNeed) return true;
  c.notchAccum = 0;
  c.radarTime = -999; // track lost: must be re-acquired outside the notch
  return false;
}

/** Full sensor sweep of one aircraft. */
function scan(ctx: CombatCtx, ac: AircraftEntity, st: AcCombatState, sh: SensorShared, sdt: number): void {
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
    // civil traffic only matters to the human player (AI crews and their datalink ignore it)
    if (t.team === 'neutral' && !ac.isPlayer) continue;
    _rel.subVectors(t.position, ac.position);
    const d = _rel.length();
    if (d < 1) continue;
    const cosOff = _fwd.dot(_rel) / d;
    let los = -1; // lazy terrain check: -1 unknown, 0 blocked, 1 clear
    let inGimbal = false;
    if (radarOn && cosOff >= cosGimbal) {
      inGimbal = true;
      let R = spec.range * rcsRangeFactor(aircraftRcs(t, ac.position));
      // X-band fighter radar vs LO shaping (hostile crews: better trained on harder difficulties)
      if (ac.type !== 'a50') R *= fcrStealthFactor(t, ac.team === playerTeam(world) ? 0.2 : world.difficulty.aiSkill);
      if (ac.radar.mode === 'acm') R = Math.min(R, ACM_RANGE);
      else if (ac.radar.mode === 'ground') R *= 0.6; // interleaved A/A while mapping
      if (_rel.y < -0.03 * d) R *= 0.85; // look-down clutter
      if (d <= R && radarHolds(ctx, ac, st, t, now, sdt, spec.notchResistance)) {
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
    // civil ships only matter to the human player (AI crews never track or attack them)
    if (g.team === 'neutral' && !ac.isPlayer) continue;
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

/**
 * Move the TD box. `commanded` = the human player asked for a lock on it (tap / TGT / look);
 * auto-designation only builds a TWS track (no STT, no RWR spike).
 */
export function setDesignation(ctx: CombatCtx, ac: AircraftEntity, id: number | null, commanded = false): void {
  const r = ac.radar;
  const st = acState(ac);
  if (r.designatedId === id) {
    if (commanded && id !== null) st.lockCommanded = true;
    return;
  }
  r.designatedId = id;
  r.lockProgress = 0;
  st.lockCommanded = commanded && id !== null;
  st.designationStale = 0;
  if (r.lockedId !== null && r.lockedId !== id) dropLock(ctx, ac, st);
  updateGroundPoint(ctx, ac, st);
  ctx.world.events.emit('designate', { ownerId: ac.id, targetId: id });
}

/** Break the STT lock (emits 'lock'). */
function dropLock(ctx: CombatCtx, ac: AircraftEntity, st: AcCombatState): void {
  const r = ac.radar;
  const old = r.lockedId;
  r.lockedId = null;
  r.lockProgress = 0;
  st.lockLostTimer = 0;
  if (old !== null) ctx.world.events.emit('lock', { ownerId: ac.id, targetId: old, locked: false });
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
 * A/A: threat to us › in front (±60°) › range. A/G: (emitting, with AARGM) › in front › target of an
 * active primary objective (`objective`, set by the mission runner: the c06 corvettes before the
 * Shilka on the way, the c03 SA-6) › range. Requires _fwd = nose of `ac`.
 */
const NEUTRAL_RANK_PENALTY = 1e12;

function candidateKey(ctx: CombatCtx, ac: AircraftEntity, c: TrackContact): number {
  if (c.team === ac.team) return NaN;
  const air = isAirMode(ac);
  if (air !== (c.entityKind === 'aircraft')) return NaN;
  _rel.subVectors(c.position, ac.position);
  const d = Math.max(1, _rel.length());
  const inFront = _fwd.dot(_rel) / d >= (air ? 0.5 : 0.7) ? 1 : 0;
  // civil traffic (airliners, merchant ships) can be designated (tap or TGT cycling) but always
  // ranks behind every hostile
  const neutral = c.team === 'neutral' ? NEUTRAL_RANK_PENALTY : 0;
  if (air) return threatRank(ctx, ac, c.id) * 1e9 + inFront * 1e7 - d - neutral;
  const e = ctx.world.getEntity(c.id);
  const emitting = e && ((e.kind === 'sam' && e.radarOn) || (e.kind === 'ground' && e.emitter)) ? 1 : 0;
  const objective = e && (e.kind === 'sam' || e.kind === 'ground') && e.objective ? 1 : 0;
  return (ac.selectedWeapon === 'aargm' ? emitting * 1e9 : 0) + inFront * 1e7 + objective * 1e6 - d - neutral;
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

/** A missile `ac` launched is still flying at contact `id` (the contact is already engaged). */
export function engagedBy(ctx: CombatCtx, ac: AircraftEntity, id: number): boolean {
  for (const m of ctx.world.missiles) if (m.alive && m.shooterId === ac.id && m.targetId === id) return true;
  return false;
}

/**
 * Shoot list (human player) against a swarm: after an air-to-air launch at a one-way drone the TD box
 * steps to the highest-priority fresh hostile air track with none of our missiles in flight at it,
 * so the next FIRE goes at a new drone (an AMRAAM leaves off the TWS track, no lock needed). The box
 * is commanded, as a tap would be, so TGT steps on from it. Nothing left unengaged: the box stays.
 * Only for drones: in a fighter fight the step dropped the lock the player had just fired on (the
 * playtest bot lost c12 Pilot 4/6 → 2/6 and c01 Pilot 6/6 → 5/6 with it everywhere).
 */
export function shootListStep(ctx: CombatCtx, ac: AircraftEntity, firedAt: number | null): void {
  if (!ac.isPlayer || !isAirMode(ac)) return;
  const fired = ctx.world.getEntity(firedAt);
  if (!fired || fired.kind !== 'aircraft' || !fired.oneWay) return;
  const st = acState(ac);
  for (const c of candidates(ctx, ac, st)) {
    if (c.id === firedAt || c.team === 'neutral' || c.entityKind !== 'aircraft' || c.lastSeen < ctx.time - 1.5) continue;
    if (engagedBy(ctx, ac, c.id)) continue;
    setDesignation(ctx, ac, c.id, true);
    return;
  }
}

/**
 * TGT button (LOCK / NEXT): with an unlocked, un-commanded TD box (the auto-designated primary
 * threat) the press commands the lock on THAT contact. A press while locking / locked moves the
 * designation to the next candidate (dropping the lock) and commands a lock on it. With a single
 * candidate it toggles: locked / locking → break lock (back to a silent TWS track). NEXT skips
 * contacts our missiles are already flying at, unless nothing else is left to step to.
 */
export function cycleTarget(ctx: CombatCtx, ac: AircraftEntity): void {
  const st = acState(ac);
  const des = ac.radar.designatedId;
  // with hostiles about, NEXT doesn't stop on an airliner or a civil ship (g01: the A320 sat in the
  // swarm's cycle, playtest r2 2.1-f); with only civil traffic (free flight) it still steps through it
  const every = candidates(ctx, ac, st);
  const all = every.some((c) => c.team !== 'neutral') ? every.filter((c) => c.team !== 'neutral' || c.id === des) : every;
  if (all.length === 0) return;
  const free = all.filter((c) => c.id === des || !engagedBy(ctx, ac, c.id));
  const list = free.some((c) => c.id !== des) ? free : all;
  const idx = list.findIndex((c) => c.id === ac.radar.designatedId);
  // TGT state machine: the first press with an un-commanded TD box (auto-designated primary)
  // LOCKS the boxed contact; only a press while locking / locked advances to the next one.
  if (idx >= 0 && ac.radar.lockedId === null && !st.lockCommanded) {
    st.lockCommanded = true;
    return;
  }
  const next = list[(idx + 1) % list.length];
  if (next.id === ac.radar.designatedId) {
    if (ac.radar.lockedId !== null || st.lockCommanded) {
      st.lockCommanded = false;
      if (ac.radar.lockedId !== null) dropLock(ctx, ac, st);
      ac.radar.lockProgress = 0;
    } else st.lockCommanded = true;
    return;
  }
  setDesignation(ctx, ac, next.id, true);
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
  if (best) setDesignation(ctx, ac, best.id, true);
}

/** Tap on a HUD box / PCD symbol: designate it and command a lock (builds while inside the lock cone). */
export function designate(ctx: CombatCtx, ac: AircraftEntity, id: number | null): void {
  if (id === null) return setDesignation(ctx, ac, null);
  const st = acState(ac);
  const c = st.contacts.get(id);
  if (!c || c.team === ac.team) return;
  setDesignation(ctx, ac, id, true);
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
    if (k.team === 'neutral') continue; // never box an airliner / civil ship on our own
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

/** Human player's lock cone: a commanded lock builds only while the target is within ±30° of the nose. */
export const PLAYER_LOCK_CONE = (30 * Math.PI) / 180;
const COS_LOCK_CONE = Math.cos(PLAYER_LOCK_CONE);

/**
 * Radar STT lock progression (every step).
 *
 * Human player: auto-designation only gives a TWS track. A lock must be commanded (tap on the
 * TD box / TGT); it builds over difficulty.playerLockTime while the target is painted by the
 * radar inside the ±30° lock cone (progress decays outside it), and once established it holds
 * anywhere in the ±60° gimbal — lost outside it or when not painted for > 2 s.
 * AI (and the autopilot): designation + radar track inside the gimbal locks over its skill time.
 */
function updateLock(ctx: CombatCtx, ac: AircraftEntity, st: AcCombatState, dt: number): void {
  const r = ac.radar;
  const des = r.designatedId;
  const c = des !== null ? st.contacts.get(des) : undefined;
  const painted = !!c && c.entityKind === 'aircraft' && r.emitting && c.radarTime >= ctx.time - 0.35;
  if (ac.isPlayer && !ac.ai) {
    if (r.lockedId !== null) {
      if (r.lockedId === des && painted && c!.inGimbal) st.lockLostTimer = 0;
      else {
        st.lockLostTimer += dt;
        if (st.lockLostTimer > 2 || !r.emitting || r.lockedId !== des) {
          dropLock(ctx, ac, st);
          st.lockCommanded = false;
        }
      }
      return;
    }
    let inCone = false;
    if (painted) {
      forwardOf(ac.quaternion, _fwd);
      _rel.subVectors(c!.position, ac.position);
      const d = _rel.length();
      inCone = d > 1 && _fwd.dot(_rel) / d >= COS_LOCK_CONE;
    }
    if (st.lockCommanded && inCone) {
      r.lockProgress = Math.min(1, r.lockProgress + dt / Math.max(0.05, ctx.world.difficulty.playerLockTime));
      if (r.lockProgress >= 1) {
        r.lockedId = des;
        st.lockLostTimer = 0;
        ctx.world.events.emit('lock', { ownerId: ac.id, targetId: des, locked: true });
      }
    } else {
      r.lockProgress = Math.max(0, r.lockProgress - dt * 0.5);
    }
    return;
  }
  const canLock = painted && c!.inGimbal;
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
    if (st.lockLostTimer > 2 || !r.emitting) dropLock(ctx, ac, st);
  } else {
    r.lockProgress = Math.max(0, r.lockProgress - dt * 0.5);
  }
}

/** Radar emission on/off (EMCON). Silent: radar tracks and the STT lock drop. */
export function setRadarEmitting(ctx: CombatCtx, ac: AircraftEntity, emitting: boolean): void {
  ac.radar.emitting = emitting;
  if (!emitting) {
    const st = acState(ac);
    st.lockCommanded = false;
    if (ac.radar.lockedId !== null) dropLock(ctx, ac, st);
    ac.radar.lockProgress = 0;
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
      scan(ctx, ac, st, sh, sdt);
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
