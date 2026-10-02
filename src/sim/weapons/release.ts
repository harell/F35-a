/**
 * F35-A — weapon release: per-weapon release rules, internal-bay door sequencing, station
 * selection, brevity calls and auto-reselect.
 *
 * Rules ('weapon:denied' reasons for the player):
 *  AIM-120 / R-77 / R-27  need an air track (lock preferred, required for semi-active R-27);
 *                         denied beyond 1.3 × rMax ('OUT OF RANGE') or inside rMin ('MIN RANGE')
 *  AIM-9X / R-73          IR seeker must have a target within the HMD off-boresight limit
 *  JDAM / SDB             GPS attack on the designated ground point (envelope-checked), else CCIP drop
 *  SDB II (GBU-53)        needs a designated surface target inside the glide envelope; no CCIP
 *                         (GPS / SDB II: the range only, not the HUD cue's cone or turn circle; a
 *                         player JDAM may go 1.1 × past it on Recruit / Pilot, see gpsReleasePad)
 *  AARGM-ER               needs an emitting radar in its seeker field (or a designated known SAM)
 * Internal stores: bay doors open first (0 → 1 over ~0.35 s, release at > 0.9, close ~1.5 s
 * after) — the authentic F-35 release delay. External pylons release immediately.
 */
import { Vector3 } from 'three';
import type { MunitionId, VoiceId, WeaponId } from '../../core/types';
import { forwardOf } from '../../core/math';
import type { LaunchZone } from '../api';
import type { AircraftEntity, AnyEntity, MissileEntity } from '../entities';
import type { AcCombatState, CombatCtx } from './context';
import { acState, radio } from './context';
import { ccipPoint, gpsMaxRange, launchZoneFor, munitionForRelease, type ZoneHooks } from './dlz';
import type { CombatMunitionDef } from './defs';
import { autoReselect, pickStation, stationMunition, totalStores } from './loadouts';
import { launchMunition, type CombatMissile } from './missile';
import { irSeekerSees } from '../sensors/irSeeker';
import { dasLaunchCue } from '../sensors/Sensors';

type StoreWeapon = Exclude<WeaponId, 'gun'>;

/** Bay door opening / closing times (s). */
export const BAY_OPEN_TIME = 0.35;
export const BAY_CLOSE_TIME = 0.5;
export const BAY_HOLD = 1.5;

const CALLS: Record<StoreWeapon, { text: string; voice: VoiceId }> = {
  aim120: { text: 'Fox Three', voice: 'p_fox3' },
  aim9x: { text: 'Fox Two', voice: 'p_fox2' },
  gbu31: { text: 'Rifle', voice: 'p_rifle' },
  gbu39: { text: 'Rifle', voice: 'p_rifle' },
  gbu53: { text: 'Rifle', voice: 'p_rifle' },
  aargm: { text: 'Magnum', voice: 'p_magnum' },
};

const _zone: LaunchZone = { weapon: 'aim120', targetId: null, range: 0, rMin: 0, rNe: 0, rMax: 0, shoot: false, closure: 0, timeOfFlight: 0, rShoot: 0 } as LaunchZone;
const _fwd = new Vector3();
const _rel = new Vector3();
const _pt = new Vector3();

function deny(ctx: CombatCtx, ac: AircraftEntity, weapon: WeaponId, reason: string): null {
  if (ac.isPlayer) ctx.world.events.emit('weapon:denied', { ownerId: ac.id, weapon, reason });
  return null;
}

/**
 * How far past the cue's range (gpsMaxRange) a GPS / glide bomb release is still allowed. The release
 * reads the range only, for the player as for the AI: it doesn't follow the HUD cue's cone or turn
 * circle, since from altitude the bombs turn onto targets well off the cone and inside that circle
 * (issue #65, measured). On the generous-cue difficulties (Recruit, Pilot) a player JDAM may go 1.1 ×
 * past the cue, where it still reaches; a winged glide bomb (SDB, StormBreaker) gets no pad, since
 * from 7,000 m it falls short there (dead ahead at 1.09 ×, 45° off the nose at 1.05 ×).
 */
function gpsReleasePad(ctx: CombatCtx, ac: AircraftEntity, def: CombatMunitionDef): number {
  return ac.isPlayer && ctx.world.difficulty.generousShootCues && def.glideRatio < 3 ? 1.1 : 1;
}

function hostileAircraft(e: AnyEntity | null, ac: AircraftEntity): e is AircraftEntity {
  return !!e && e.alive && e.kind === 'aircraft' && e.team !== ac.team;
}

/** Best emitter for the AARGM seeker: designated site first, else emitting radars within ±45° of the nose. */
function armTarget(ctx: CombatCtx, ac: AircraftEntity, def: { seekerFov: number; maxRange: number }, requested: number | null): AnyEntity | null {
  const world = ctx.world;
  const pick = world.getEntity(requested ?? ac.radar.designatedId);
  if (pick && pick.alive && pick.team !== ac.team && pick.team !== 'neutral') {
    if (pick.kind === 'sam' && (pick.radarOn || pick.known)) return pick;
    if (pick.kind === 'ground' && pick.emitter) return pick;
  }
  forwardOf(ac.quaternion, _fwd);
  const cosFov = Math.cos(def.seekerFov);
  let best: AnyEntity | null = null;
  let bestCos = cosFov;
  const consider = (e: AnyEntity, emitting: boolean): void => {
    if (!e.alive || e.team === ac.team || e.team === 'neutral' || !emitting) return; // emitters only, never civil traffic
    _rel.subVectors(e.position, ac.position);
    const d = _rel.length();
    if (d > def.maxRange * 1.3 || d < 1) return;
    const c = _fwd.dot(_rel) / d;
    if (c > bestCos) {
      bestCos = c;
      best = e;
    }
  };
  for (const s of world.sams) consider(s, s.radarOn);
  for (const g of world.ground) consider(g, g.emitter);
  return best;
}

/**
 * Try to release `weapon` (default: selected) at `targetId` (default: lock / designation).
 * Returns the launched munition, or null (denied, or queued behind the bay doors).
 */
export function fire(ctx: CombatCtx, ac: AircraftEntity, hooks: ZoneHooks, weaponArg?: WeaponId, targetArg?: number | null): MissileEntity | null {
  const world = ctx.world;
  const weapon = weaponArg ?? ac.selectedWeapon;
  if (!ac.alive || weapon === 'gun') return null;
  const st = acState(ac);
  if (st.pending) return null; // a release is already sequencing through the bay
  const requested = targetArg === undefined ? null : targetArg;
  const lockedTarget = ac.radar.lockedId;
  const wantTargetId = requested ?? lockedTarget ?? ac.radar.designatedId;
  const mun = munitionForRelease(ac, weapon, wantTargetId !== null && wantTargetId === lockedTarget);
  const station = pickStation(ac, weapon, (m) => (m === mun ? 1 : 0));
  if (station < 0) return deny(ctx, ac, weapon, 'WINCHESTER');
  const def = ctx.defs[mun];

  let target: AnyEntity | null = null;
  let groundPoint: Vector3 | null = null;
  let guided = true;

  switch (def.guidance) {
    case 'active_radar':
    case 'semi_active': {
      const t = world.getEntity(wantTargetId);
      if (!hostileAircraft(t, ac)) return deny(ctx, ac, weapon, 'NO TARGET');
      const c = st.contacts.get(t.id);
      const fresh = !!c && c.lastSeen >= ctx.time - 1.5;
      if (def.guidance === 'semi_active' ? lockedTarget !== t.id : !fresh) return deny(ctx, ac, weapon, 'NO LOCK');
      launchZoneFor(ctx, ac, weapon, t, hooks, _zone);
      if (_zone.range > _zone.rMax * 1.3) return deny(ctx, ac, weapon, 'OUT OF RANGE');
      if (_zone.range < _zone.rMin) return deny(ctx, ac, weapon, 'MIN RANGE');
      target = t;
      break;
    }
    case 'ir': {
      const gimbalCos = Math.cos(def.gimbalLimit);
      let t: AnyEntity | null = null;
      if (requested !== null) {
        const r = world.getEntity(requested);
        if (hostileAircraft(r, ac) && irSeekerSees(ctx, def, ac, r, gimbalCos) > -2) t = r;
      } else {
        const sid = st.ir.state === 'locked' ? st.ir.targetId : null;
        const r = world.getEntity(sid);
        if (hostileAircraft(r, ac) && irSeekerSees(ctx, def, ac, r, gimbalCos) > -2) t = r;
        if (!t) {
          const d = world.getEntity(ac.radar.designatedId);
          if (hostileAircraft(d, ac) && irSeekerSees(ctx, def, ac, d, gimbalCos) > -2) t = d;
        }
      }
      if (!t) {
        const any = world.getEntity(requested ?? ac.radar.designatedId);
        return deny(ctx, ac, weapon, hostileAircraft(any, ac) ? 'NO SEEKER' : 'NO TARGET');
      }
      const range = t.position.distanceTo(ac.position);
      if (range < def.minRange) return deny(ctx, ac, weapon, 'MIN RANGE');
      // the seeker may see a hot tail-on target further than the missile can fly
      launchZoneFor(ctx, ac, weapon, t, hooks, _zone);
      if (range > _zone.rMax * 1.3) return deny(ctx, ac, weapon, 'OUT OF RANGE');
      target = t;
      break;
    }
    case 'anti_radiation': {
      const t = armTarget(ctx, ac, def, requested);
      if (!t) return deny(ctx, ac, weapon, 'NO TARGET');
      const range = t.position.distanceTo(ac.position);
      launchZoneFor(ctx, ac, weapon, t, hooks, _zone);
      if (range > Math.max(_zone.rMax, def.maxRange * 0.5) * 1.3) return deny(ctx, ac, weapon, 'OUT OF RANGE');
      if (range < def.minRange) return deny(ctx, ac, weapon, 'MIN RANGE');
      target = t;
      groundPoint = t.position;
      break;
    }
    case 'gps': {
      const t = world.getEntity(requested ?? ac.radar.designatedId);
      const designated = t && t.alive && (t.kind === 'ground' || t.kind === 'sam') && t.team !== ac.team;
      if (designated && ac.radar.groundPoint) {
        const gp = ac.radar.groundPoint;
        const horiz = Math.hypot(gp.x - ac.position.x, gp.z - ac.position.z);
        const rMax = gpsMaxRange(def, ac.position.y - gp.y, ac.velocity.length(), gp.y);
        if (horiz > rMax * gpsReleasePad(ctx, ac, def)) return deny(ctx, ac, weapon, 'OUT OF RANGE');
        target = t;
        groundPoint = gp;
      } else if (designated && t) {
        target = t;
        groundPoint = t.position;
      } else {
        // CCIP: unguided drop onto the predicted impact point
        guided = false;
        if (ccipPoint(world, ac, def, _pt)) groundPoint = _pt;
      }
      break;
    }
    case 'tri_mode': {
      // datalinked stand-off bomb: needs a designated live surface target (civil ships too, as for
      // the GPS bombs); no CCIP mode
      const t = world.getEntity(requested ?? ac.radar.designatedId);
      if (!t || !t.alive || (t.kind !== 'ground' && t.kind !== 'sam') || t.team === ac.team) return deny(ctx, ac, weapon, 'NO TARGET');
      const horiz = Math.hypot(t.position.x - ac.position.x, t.position.z - ac.position.z);
      const rMax = gpsMaxRange(def, ac.position.y - t.position.y, ac.velocity.length(), t.position.y);
      if (horiz > rMax * gpsReleasePad(ctx, ac, def)) return deny(ctx, ac, weapon, 'OUT OF RANGE');
      target = t;
      // launch estimate comes from the launcher's track (position + velocity), see launchMunition;
      // the point is only kept for a release that sequences through the bay doors
      groundPoint = t.position;
      break;
    }
    default:
      return null;
  }

  const st2 = ac.stores[station];
  if (st2.internal && ac.isPlayer && ac.bayDoors < 0.9) {
    st.pending = {
      weapon,
      munition: mun,
      station,
      targetId: target ? target.id : null,
      groundPoint: groundPoint ? groundPoint.clone() : null,
      guided,
      timer: 0,
    };
    return null;
  }
  return release(ctx, ac, st, station, mun, target, groundPoint, guided);
}

/** Actually launch from a station: decrement, stats, callouts, bay hold, auto-reselect. */
function release(
  ctx: CombatCtx,
  ac: AircraftEntity,
  st: AcCombatState,
  station: number,
  mun: MunitionId,
  target: AnyEntity | null,
  groundPoint: Vector3 | null,
  guided: boolean,
): CombatMissile {
  const s = ac.stores[station];
  // a tri-mode bomb with a live target starts from the launcher's track (it has a velocity)
  const point = ctx.defs[mun].guidance === 'tri_mode' && target ? null : groundPoint;
  const m = launchMunition(ctx, ac, mun, target, { internal: s.internal, targetPoint: point, guided });
  // active radar missile fired off a TWS track (no STT): silent, but coarser midcourse updates
  if (m.cdef.guidance === 'active_radar' && target && !(ac.radar.lockedId === target.id && ac.radar.emitting)) m.tws = true;
  if (m.def.category === 'aam') dasLaunchCue(ctx, ac);
  s.count--;
  ac.shotsFired++;
  if (s.internal) {
    st.bayHold = BAY_HOLD;
    if (!ac.isPlayer) ac.bayDoors = Math.max(ac.bayDoors, 0.6); // AI: doors pop for the visuals + RCS spike
  }
  // brevity call
  if (ac.team === 'blue') {
    const call = CALLS[s.weapon];
    if (ac.isPlayer) radio(ctx, ac.callsign, call.text, call.voice, ac.team, 2);
    else if (ctx.time - ctx.chatter.friendly > 3) {
      ctx.chatter.friendly = ctx.time;
      radio(ctx, ac.callsign, call.text, call.voice, ac.team, 1);
    }
  }
  if (ac.selectedWeapon === s.weapon && s.count <= 0) autoReselect(ac, ctx.world);
  if (ac.isPlayer && !st.winchester && totalStores(ac) === 0) {
    st.winchester = true;
    radio(ctx, ac.callsign, 'Winchester', 'p_winchester', ac.team, 1);
  }
  return m;
}

/** Bay door animation + queued internal releases (every step). */
export function updateBay(ctx: CombatCtx, ac: AircraftEntity, st: AcCombatState, dt: number): void {
  const p = st.pending;
  if (p) {
    p.timer += dt;
    ac.bayDoors = Math.min(1, ac.bayDoors + dt / BAY_OPEN_TIME);
    if (ac.bayDoors > 0.9) {
      st.pending = null;
      const s = ac.stores[p.station];
      if (s && s.count > 0 && ac.alive) {
        let target = ctx.world.getEntity(p.targetId);
        if (target && !target.alive) target = null;
        if (!target && ac.stores[p.station].weapon === 'aim120') {
          const alt = ctx.world.getEntity(ac.radar.lockedId ?? ac.radar.designatedId);
          if (alt && alt.alive && alt.kind === 'aircraft' && alt.team !== ac.team) target = alt;
        }
        release(ctx, ac, st, p.station, stationMunition(ac, p.station) ?? p.munition, target, p.groundPoint, p.guided);
      }
    } else if (p.timer > 2) {
      st.pending = null; // safety
    }
    return;
  }
  if (st.bayHold > 0) {
    st.bayHold -= dt;
    ac.bayDoors = Math.min(1, ac.bayDoors + dt / BAY_OPEN_TIME);
  } else if (ac.bayDoors > 0) {
    ac.bayDoors = Math.max(0, ac.bayDoors - dt / BAY_CLOSE_TIME);
  }
}

/** Rising edge of the pickle button. */
export function handleReleaseInput(ctx: CombatCtx, ac: AircraftEntity, st: AcCombatState, hooks: ZoneHooks): void {
  const pressed = ac.input.fireWeapon && !st.prevFireWeapon;
  st.prevFireWeapon = ac.input.fireWeapon;
  if (pressed && ac.alive) fire(ctx, ac, hooks);
}
