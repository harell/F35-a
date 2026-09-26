/**
 * F35-A — radar warning receiver (computed for every aircraft; the player's is displayed).
 *
 *  fighters  'search' if we're inside their emitting radar's scan volume and within 1.2× its
 *            reference range (LPI radars — APG-81, Su-57 — only 40 % in search), 'track' when
 *            they hold an STT lock on us (a TWS track / designation is silent), 'launch' while
 *            they illuminate a semi-active missile at us (active missiles are silent until pitbull)
 *  SAMs      'search' when radar on and we're within 1.5× their detection range (terrain-masked
 *            for the player), 'track' when tracking us, 'launch' while guiding a missile at us
 *  EWRs      'search' (symbol EW)
 *  missiles  active seekers locked on us ('M', launch) — an AMRAAM/R-77 is silent until pitbull
 *  SA-18 MANPADS are passive: no warning at all.
 */
import { Quaternion, Vector3 } from 'three';
import { AIRCRAFT_INFO, SAM_INFO } from '../../core/data';
import { clamp } from '../../core/math';
import type { AircraftEntity, RwrContact, RwrThreatKind, SamSiteEntity } from '../entities';
import type { AcCombatState, CombatCtx } from '../weapons/context';
import { isCombatMissile } from '../weapons/missile';
import { SAM_DATA } from '../sam/samData';
import { FIGHTER_RADAR } from './signatures';
import { lineOfSight } from './los';

export const EWR_RWR_RANGE = 120_000;

interface RwrEntry extends RwrContact {
  stamp: number;
}

const _rel = new Vector3();
const _fwd = new Vector3();
const _qi = new Quaternion();
const _local = new Vector3();
const _eye = new Vector3();
const guiders = new Set<number>();
const losCache = new WeakMap<SamSiteEntity, { time: number; ok: boolean; target: number }>();

function samLos(ctx: CombatCtx, s: SamSiteEntity, ac: AircraftEntity): boolean {
  let c = losCache.get(s);
  if (!c) {
    c = { time: -999, ok: true, target: -1 };
    losCache.set(s, c);
  }
  if (ctx.time - c.time > 0.5 || c.target !== ac.id) {
    _eye.copy(s.position);
    _eye.y += SAM_DATA[s.type].mastHeight;
    c.ok = lineOfSight(ctx.world.terrain, _eye, ac.position);
    c.time = ctx.time;
    c.target = ac.id;
  }
  return c.ok;
}

/* Per-call state for report() (avoids allocating a closure per RWR update). */
let _ctx: CombatCtx;
let _ac: AircraftEntity;
let _st: AcCombatState;
let _sdt = 0;

function report(sourceId: number, kind: RwrThreatKind, symbol: string, pos: Vector3, frac: number, state: RwrContact['state']): void {
  const st = _st;
  const ac = _ac;
  let e = st.rwr.get(sourceId) as RwrEntry | undefined;
  const isNew = !e;
  if (!e) {
    e = (st.rwrPool.pop() as RwrEntry | undefined) ?? { sourceId: 0, kind, symbol, bearing: 0, strength: 0, state, age: 0, stamp: 0 };
    e.sourceId = sourceId;
    e.age = 0;
    st.rwr.set(sourceId, e);
  } else {
    e.age += _sdt;
  }
  e.kind = kind;
  e.symbol = symbol;
  e.state = state;
  e.stamp = _ctx.time;
  _local.subVectors(pos, ac.position).applyQuaternion(_qi);
  e.bearing = Math.atan2(_local.x, -_local.z);
  const bonus = state === 'launch' ? 0.4 : state === 'track' ? 0.2 : 0;
  e.strength = clamp(1 - frac + bonus, 0.05, 1);
  if (isNew && ac.isPlayer) _ctx.world.events.emit('rwr:new', { contact: e });
}

export function updateRwr(ctx: CombatCtx, ac: AircraftEntity, st: AcCombatState, sdt: number): void {
  const world = ctx.world;
  const now = ctx.time;
  _qi.copy(ac.quaternion).invert();

  // emitters currently guiding (illuminating / commanding) a missile at us
  guiders.clear();
  for (const m of world.missiles) {
    if (!m.alive || m.targetId !== ac.id || m.team === ac.team || !isCombatMissile(m) || !m.threat) continue;
    const g = m.cdef.guidance;
    if ((g === 'semi_active' || g === 'command') && !m.trackBroken) guiders.add(m.guiderId);
  }

  _ctx = ctx;
  _ac = ac;
  _st = st;
  _sdt = sdt;

  // ── fighter / AEW radars ──
  for (const y of world.aircraft) {
    if (!y.alive || y.team === ac.team || !y.radar.emitting) continue;
    const spec = FIGHTER_RADAR[y.type];
    if (spec.range <= 0) continue;
    _rel.subVectors(ac.position, y.position);
    const d = _rel.length();
    if (d < 1) continue;
    _fwd.set(0, 0, -1).applyQuaternion(y.quaternion);
    if (_fwd.dot(_rel) / d < Math.cos(spec.gimbal)) continue;
    let state: RwrContact['state'] = 'search';
    if (guiders.has(y.id)) state = 'launch';
    else if (y.radar.lockedId === ac.id) state = 'track';
    const maxR = spec.range * 1.2 * (spec.lpi && state === 'search' ? 0.4 : 1);
    if (d > maxR) continue;
    report(y.id, y.type === 'a50' ? 'awacs' : 'fighter', AIRCRAFT_INFO[y.type].rwrSymbol, y.position, d / maxR, state);
  }

  // ── SAM / AAA radars ──
  for (const s of world.sams) {
    if (!s.alive || s.team === ac.team || !s.radarOn) continue;
    const data = SAM_DATA[s.type];
    if (!data.radar) continue;
    const maxR = 1.5 * (s.detectRange ?? data.detectRange);
    const d = s.position.distanceTo(ac.position);
    if (d > maxR) continue;
    if (ac.isPlayer && !samLos(ctx, s, ac)) continue;
    let state: RwrContact['state'] = 'search';
    if (guiders.has(s.id) || (s.type === 'zsu23' && s.state === 'launch' && s.trackedTargetId === ac.id)) state = 'launch';
    else if (s.trackedTargetId === ac.id && (s.state === 'track' || s.state === 'launch' || s.state === 'guiding')) state = 'track';
    report(s.id, s.type === 'zsu23' ? 'aaa' : 'sam', SAM_INFO[s.type].rwrSymbol || 'S', s.position, d / maxR, state);
    if (ac.isPlayer) s.known = true; // ESM geolocates the emitter
  }

  // ── early-warning radars ──
  for (const g of world.ground) {
    if (!g.alive || !g.emitter || g.team === ac.team) continue;
    const d = g.position.distanceTo(ac.position);
    if (d > EWR_RWR_RANGE) continue;
    report(g.id, 'ewr', 'EW', g.position, d / EWR_RWR_RANGE, 'search');
  }

  // ── active seekers locked on us ──
  for (const m of world.missiles) {
    if (!m.alive || m.targetId !== ac.id || m.team === ac.team || !m.seekerLocked || m.def.guidance !== 'active_radar') continue;
    const d = m.position.distanceTo(ac.position);
    report(m.id, 'missile', 'M', m.position, d / 15_000, 'launch');
  }

  // ── prune + publish ──
  const arr = ac.rwr;
  arr.length = 0;
  for (const e of st.rwr.values()) {
    const entry = e as RwrEntry;
    if (entry.stamp !== now) {
      st.rwr.delete(entry.sourceId);
      st.rwrPool.push(entry);
    } else arr.push(entry);
  }
}
