/**
 * STUB CombatSystem — to be replaced by the COMBAT agent.
 * Keeps the exported factory name `createCombatSystem`.
 */
import type { CombatSystemApi, CreateCombatSystem, LaunchZone } from '../api';
import type { MunitionDef } from '../entities';
import type { MunitionId } from '../../core/types';

export const createCombatSystem: CreateCombatSystem = () => {
  const api: CombatSystemApi = {
    munitions: {} as Record<MunitionId, MunitionDef>,
    update() {},
    applyLoadout(ac) { ac.gunAmmo = 180; },
    applyDefaultLoadout(ac) { ac.gunAmmo = 150; },
    cycleWeapon() {},
    selectWeapon() {},
    cycleTarget() {},
    designateNearestTo() {},
    designate() {},
    setRadarEmitting(ac, e) { ac.radar.emitting = e; },
    remaining(ac, w) { return w === 'gun' ? ac.gunAmmo : 0; },
    launchZone() { return null; },
    launchZoneFor(_ac, weapon, target): LaunchZone {
      return { weapon, targetId: target.id, range: 0, rMin: 0, rNe: 0, rMax: 0, shoot: false, closure: 0, timeOfFlight: 0 };
    },
    fire() { return null; },
    irSeekerState() { return { state: 'off', targetId: null, direction: null }; },
    gunLeadPoint() { return null; },
    bombImpactPoint() { return null; },
  };
  return api;
};
