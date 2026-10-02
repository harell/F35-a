/**
 * F35-A — the `window.__f35.destroy()` test hook's kill (TEST_HOOKS only; see Game.debugApi).
 *
 * One overwhelming AIM-120 hit kills anything except a civil ship that takes several hits (the
 * escorted tanker, GroundTargetEntity.hitsToSink): Damage counts it as one of her hits. So the hook
 * repeats the hit, up to hitsToSink times, until she is gone ('vessel:hit' fires for each).
 */
import type { SimWorld } from '../sim/api';
import type { AircraftEntity, GroundTargetEntity, SamSiteEntity } from '../sim/entities';

export function forceDestroy(world: SimWorld, e: AircraftEntity | SamSiteEntity | GroundTargetEntity, attackerId: number | null): void {
  const hits = e.kind === 'ground' ? e.hitsToSink : 1;
  for (let i = 0; i < hits && e.alive; i++) world.applyDamage(e, e.maxHealth * 10 + 500, attackerId, 'aim120');
}
