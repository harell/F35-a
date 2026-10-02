/**
 * F35-A — per-mission gun ammunition (MissionDef.gunAmmo).
 *
 * Every loadout carries the real F-35A load of 180 rounds (LOADOUTS[*].gunAmmo, about 3.3 s of
 * fire). Missions built around the gun (the IRGC campaign) set their own amount on the mission
 * instead, so the other missions keep their balance. The override replaces the loadout's rounds
 * when the player spawns (spawner.spawnPlayer) and every time combat.applyLoadout re-arms the jet
 * (the Whenuapai rearm, survival's between-wave rearm). The HUD rounds counter and the cockpit
 * stores page read AircraftEntity.gunAmmo, so they show it as is; the briefing's hangar cards
 * read missionGunAmmo().
 */
import type { MissionDef } from '../../core/contracts';
import { LOADOUTS } from '../../core/data';
import type { Difficulty, LoadoutId } from '../../core/types';
import type { AircraftEntity } from '../../sim/entities';
import { DIFF_ORDER } from './state';

/**
 * The mission's gun rounds on a difficulty, or null when the mission doesn't set any (keep the
 * loadout's). Per difficulty, a level left out takes the nearest easier level listed, else the
 * easiest level listed (`{ recruit: 400, ace: 300 }` → 400, 400, 400, 300).
 */
export function gunAmmoOverride(def: Pick<MissionDef, 'gunAmmo'>, difficulty: Difficulty): number | null {
  const g = def.gunAmmo;
  if (g === undefined) return null;
  if (typeof g === 'number') return g;
  const at = DIFF_ORDER.indexOf(difficulty);
  for (let i = at; i >= 0; i--) {
    const n = g[DIFF_ORDER[i]];
    if (n !== undefined) return n;
  }
  for (let i = at + 1; i < DIFF_ORDER.length; i++) {
    const n = g[DIFF_ORDER[i]];
    if (n !== undefined) return n;
  }
  return null;
}

/** Rounds the player's gun carries in this mission with this loadout (briefing, rearm checks). */
export function missionGunAmmo(def: Pick<MissionDef, 'gunAmmo'>, difficulty: Difficulty, loadout: LoadoutId): number {
  return gunAmmoOverride(def, difficulty) ?? (LOADOUTS[loadout] ?? LOADOUTS.a2a_stealth).gunAmmo;
}

/**
 * Load the mission's rounds into the player's gun. Call right after the loadout was applied
 * (spawn, rearm). No-op for missions without an override.
 */
export function armMissionGun(p: AircraftEntity, def: Pick<MissionDef, 'gunAmmo'>, difficulty: Difficulty): void {
  const n = gunAmmoOverride(def, difficulty);
  if (n === null) return;
  p.gunAmmo = p.gunMaxAmmo = n;
}
