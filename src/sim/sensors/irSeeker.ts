/**
 * F35-A — AIM-9X / R-73 IR seeker state (HMD seeker circle, growl / lock tone).
 *
 * With an IR missile selected the seeker is slaved to the designated target (HMD cue, up to the
 * missile's off-boresight gimbal: 90° AIM-9X, 60° R-73) and locks when the target's IR
 * signature is strong enough at that range (tail aspect / afterburner easier). With no usable
 * designation it searches a ±25° boresight cone for the hottest-in-range hostile.
 */
import { Vector3 } from 'three';
import { forwardOf } from '../../core/math';
import type { AircraftEntity } from '../entities';
import type { AcCombatState, CombatCtx } from '../weapons/context';
import type { CombatMunitionDef } from '../weapons/defs';
import { munitionForRelease } from '../weapons/dlz';
import { remaining } from '../weapons/loadouts';
import { irIntensity } from './signatures';
import { lineOfSight } from './los';
import { isHostile } from '../../core/types';

const _fwd = new Vector3();
const _rel = new Vector3();
const BORESIGHT_COS = Math.cos((25 * Math.PI) / 180);

/** Can the IR seeker of `def`, carried by `ac`, see `t`? Returns the cosine off-boresight or -2. */
export function irSeekerSees(ctx: CombatCtx, def: CombatMunitionDef, ac: AircraftEntity, t: AircraftEntity, minCos: number): number {
  // the human player may shoot anything that isn't on their side; AI seekers ignore civil traffic
  if (!t.alive || t.team === ac.team || (!ac.isPlayer && !isHostile(ac.team, t.team))) return -2;
  _rel.subVectors(t.position, ac.position);
  const d = _rel.length();
  if (d < 150) return -2;
  forwardOf(ac.quaternion, _fwd);
  const cos = _fwd.dot(_rel) / d;
  if (cos < minCos) return -2;
  if (d > def.seekerRange * Math.sqrt(irIntensity(t, ac.position))) return -2;
  if (!lineOfSight(ctx.world.terrain, ac.position, t.position)) return -2;
  return cos;
}

export function updateIrSeeker(ctx: CombatCtx, ac: AircraftEntity, st: AcCombatState): void {
  const info = st.ir;
  if (ac.selectedWeapon !== 'aim9x' || remaining(ac, 'aim9x') <= 0 || !ac.alive) {
    info.state = 'off';
    info.targetId = null;
    info.direction = null;
    return;
  }
  const def = ctx.defs[munitionForRelease(ac, 'aim9x', false)];
  const gimbalCos = Math.cos(def.gimbalLimit);
  let targetId: number | null = null;
  const des = ctx.world.getEntity(ac.radar.designatedId);
  if (des && des.kind === 'aircraft' && irSeekerSees(ctx, def, ac, des, gimbalCos) > -2) targetId = des.id;
  if (targetId === null) {
    let best = -2;
    for (const t of ctx.world.aircraft) {
      if (t === ac) continue;
      const c = irSeekerSees(ctx, def, ac, t, BORESIGHT_COS);
      if (c > best) {
        best = c;
        targetId = t.id;
      }
    }
  }
  if (targetId !== null) {
    const t = ctx.world.getEntity(targetId)!;
    st.irDir.subVectors(t.position, ac.position).normalize();
    info.state = 'locked';
    info.targetId = targetId;
  } else {
    forwardOf(ac.quaternion, st.irDir);
    info.state = 'search';
    info.targetId = null;
  }
  info.direction = st.irDir;
}
