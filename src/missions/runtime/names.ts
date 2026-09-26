/**
 * F35-A — display names used by kill callouts, AWACS calls and HUD messages.
 */
import { AIRCRAFT_INFO, SAM_INFO } from '../../core/data';
import type { AircraftType, GroundTargetType, SamType } from '../../core/types';
import type { AnyEntity } from '../../sim/entities';

/** Short HUD name of an aircraft type ("MIG-29", "SU-35", "TU-22M3", "A-50"). */
export function aircraftHudName(type: AircraftType): string {
  return AIRCRAFT_INFO[type].name.split(' ')[0].toUpperCase();
}

const SAM_HUD: Record<SamType, string> = {
  sa6: 'SA-6 SITE',
  sa8: 'SA-8',
  sa10: 'SA-10 SITE',
  sa15: 'SA-15',
  sa18: 'MANPADS TEAM',
  zsu23: 'SHILKA',
};

const GROUND_HUD: Record<GroundTargetType, string> = {
  ewr: 'EW RADAR',
  bunker: 'BUNKER',
  fuel: 'FUEL DEPOT',
  hangar: 'HANGAR',
  parked_jet: 'PARKED JET',
  truck: 'TRUCK',
  tank: 'ARMOUR',
  ship: 'SHIP',
  factory: 'DEPOT',
  bridge: 'BRIDGE',
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
    case 'tu22m':
      return one ? 'Backfire' : 'Backfires';
    case 'a50':
      return one ? 'Mainstay' : 'Mainstays';
    default:
      return one ? 'bandit' : 'bandits';
  }
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
