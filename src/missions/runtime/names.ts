/**
 * F35-A — display names used by kill callouts, AWACS calls and HUD messages.
 */
import { AIRCRAFT_INFO, SAM_INFO } from '../../core/data';
import type { AircraftType, GroundTargetType, SamType } from '../../core/types';
import type { AnyEntity } from '../../sim/entities';

/** Short HUD name of an aircraft type ("MIG-29", "SU-35", "SHAHED"). */
export function aircraftHudName(type: AircraftType): string {
  return AIRCRAFT_INFO[type].name.split(' ')[0].toUpperCase();
}

const SAM_HUD: Record<SamType, string> = {
  sa6: 'SA-6 SITE',
  sa15: 'SA-15',
  zsu23: 'SHILKA',
  ad_boat: 'AD BOAT',
};

const GROUND_HUD: Record<GroundTargetType, string> = {
  bunker: 'BUNKER',
  fuel: 'FUEL DEPOT',
  hangar: 'HANGAR',
  parked_jet: 'PARKED JET',
  ship: 'SHIP',
  suicide_boat: 'SUICIDE BOAT',
  missile_boat: 'MISSILE BOAT',
  stoat: 'STOAT',
};

export function samHudName(type: SamType): string {
  return SAM_HUD[type];
}

export function groundHudName(type: GroundTargetType): string {
  return GROUND_HUD[type];
}

/** "SPLASH MIG-29" / "SA-6 SITE DESTROYED" / "SHIP DESTROYED". */
export function killHudText(e: AnyEntity): string {
  switch (e.kind) {
    case 'aircraft':
      return `SPLASH ${aircraftHudName(e.type)}`;
    case 'sam':
      return `${SAM_HUD[e.type]} DESTROYED`;
    case 'ground':
      return `${(e.name || GROUND_HUD[e.type]).toUpperCase()} DESTROYED`;
    default:
      return 'TARGET DESTROYED';
  }
}

/** NATO-ish plural noun for AWACS calls. */
export function aircraftNoun(type: AircraftType, count: number): string {
  const one = count === 1;
  switch (type) {
    case 'shahed136':
      return one ? 'drone' : 'drones';
    default:
      return one ? 'bandit' : 'bandits';
  }
}

/** A group's plural AWACS noun for `count` jets: "single striker", not "single strikers". */
export function groupNoun(noun: string, count: number): string {
  return count === 1 && noun.endsWith('s') ? noun.slice(0, -1) : noun;
}

export function samLongName(type: SamType): string {
  return SAM_INFO[type].nato;
}

const WORDS = ['zero', 'single', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
/** Brevity count: "single", "two", … "heavy". */
export function countWord(n: number): string {
  if (n >= 9) return 'heavy';
  return WORDS[Math.max(0, n)];
}
