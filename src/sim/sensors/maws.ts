/**
 * F35-A — missile approach warning (F-35 DAS) → AircraftEntity.incoming.
 *
 * The F-35's DAS sees every hostile missile homing on it within 15 km, IR or radar, motor
 * burning or not. Other aircraft (AI) only know about missiles their RWR reports (SARH/command
 * illumination, active seekers after pitbull) or that they can see (skill-dependent visual range).
 * An AMRAAM / R-77 in midcourse is silent: an STT lock spikes the target's RWR ("track") but the
 * launch itself is not detected until the missile's seeker goes active.
 *
 * Only missiles that still THREATEN the aircraft are listed (CombatMissile.threat, updated every
 * step by flight.ts): a missile that lost guidance, went for a decoy, ran out of energy or passed
 * drops off the list at the next 10 Hz sensor update — so the MISSILE warning / Betty clear at once.
 */
import { Quaternion, Vector3 } from 'three';
import type { AircraftEntity, IncomingMissile } from '../entities';
import type { AcCombatState, CombatCtx } from '../weapons/context';
import { isCombatMissile } from '../weapons/missile';

export const MAWS_RANGE = 15_000;

const _rel = new Vector3();
const _vrel = new Vector3();
const _local = new Vector3();
const _qi = new Quaternion();

export function updateMaws(ctx: CombatCtx, ac: AircraftEntity, st: AcCombatState): void {
  const world = ctx.world;
  const inc = ac.incoming;
  inc.length = 0;
  const das = ac.type === 'f35a';
  const visual = 2_000 + 4_000 * world.difficulty.aiSkill;
  _qi.copy(ac.quaternion).invert();
  let n = 0;
  for (const m of world.missiles) {
    if (!m.alive || m.team === ac.team || !isCombatMissile(m) || m.ended || !m.threat) continue;
    if (m.targetId !== ac.id && m.originalTargetId !== ac.id) continue;
    _rel.subVectors(m.position, ac.position);
    const d = _rel.length();
    if (d > MAWS_RANGE) continue;
    const g = m.cdef.guidance;
    if (!das) {
      const rwrKnows = ((g === 'semi_active' || g === 'command') && !m.trackBroken) || (g === 'active_radar' && m.seekerLocked);
      if (!rwrKnows && d > visual) continue;
    }
    _vrel.subVectors(m.velocity, ac.velocity);
    const closure = d > 1 ? -_rel.dot(_vrel) / d : 0;
    const e: IncomingMissile = st.incomingPool[n] ?? (st.incomingPool[n] = { missileId: 0, bearing: 0, elevation: 0, distance: 0, timeToImpact: 0, guidance: 'radar' });
    n++;
    _local.copy(_rel).applyQuaternion(_qi);
    e.missileId = m.id;
    e.bearing = Math.atan2(_local.x, -_local.z);
    e.elevation = Math.atan2(_local.y, Math.hypot(_local.x, _local.z));
    e.distance = d;
    e.timeToImpact = closure > 1 ? d / closure : d / Math.max(50, m.speed);
    e.guidance = g === 'ir' ? 'ir' : 'radar';
    // insertion sort by time to impact (few entries)
    let i = inc.length;
    inc.push(e);
    while (i > 0 && inc[i - 1].timeToImpact > e.timeToImpact) {
      inc[i] = inc[i - 1];
      i--;
    }
    inc[i] = e;
  }
}
