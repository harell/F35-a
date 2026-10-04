/**
 * F35-A — how long a mission keeps running after it ends, before the debrief (the outro): the jet's
 * last seconds, a wingman's last call, a building coming down.
 */
import { COLLAPSE } from '../core/skyTower';
import type { SimWorld } from '../sim/api';

/** Seconds the mission keeps running after success/failure before the debrief. */
export const END_DELAY_SUCCESS = 6;
export const END_DELAY_FAILED = 5;
/** …or until the Sky Tower's collapse has played out (it fails the mission the moment it is hit). */
export const END_DELAY_COLLAPSE = COLLAPSE.ruinsAt + 2.6;
/**
 * After the player's jet brought a structure down (SimWorld.structureStrike), the debrief waits until it
 * lies in rubble and the dust has had this long to roll out, so the whole collapse plays in the death cam.
 */
export const END_SETTLE_AFTER_STRIKE = 5;

/** Seconds from the end of a mission to the debrief: longer while a collapse is still playing out. */
export function endDelay(state: 'running' | 'success' | 'failed', world: Pick<SimWorld, 'landmarks' | 'structureStrike' | 'time'>): number {
  if (state === 'success') return END_DELAY_SUCCESS;
  let d = world.landmarks.some((l) => !l.alive) ? END_DELAY_COLLAPSE : END_DELAY_FAILED;
  const strike = world.structureStrike;
  if (strike) d = Math.max(d, strike.time + strike.duration + END_SETTLE_AFTER_STRIKE - world.time);
  return d;
}
