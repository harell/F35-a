/**
 * F35-A — which targets a weapon can engage: A/A missiles aircraft, bombs surface targets, the AARGM
 * radars (SAM sites) only, the gun everything. One rule for the release denial (release.ts) and the
 * HUD's standing warning (weapon block and target camera), so what the HUD warns of is what FIRE refuses
 * (or, a JDAM with an aircraft boxed, drops on the CCIP point, nowhere near it).
 */
import { AARGM_CLOSE_RANGE } from '../../core/data';
import type { WeaponId } from '../../core/types';
import type { LaunchZone } from '../api';
import type { AircraftEntity, AnyEntity } from '../entities';

type TargetKind = 'aircraft' | 'ground' | 'sam';

/** Why `weapon` can't engage a `kind` target ('AIR TGT: GUN OR A-A'…), or null when it can. */
export function weaponMismatch(weapon: WeaponId, kind: TargetKind): string | null {
  switch (weapon) {
    case 'gun':
      return null;
    case 'aim120':
    case 'aim9x':
      return kind === 'aircraft' ? null : 'GND TGT: GUN OR A-G';
    case 'aargm':
      if (kind === 'aircraft') return 'AIR TGT: GUN OR A-A';
      return kind === 'sam' ? null : 'AARGM: RADARS ONLY';
    default:
      return kind === 'aircraft' ? 'AIR TGT: GUN OR A-A' : null;
  }
}

/**
 * The AARGM's cue, one rule for the HUD and the hints (playtest r2 2.1-a): SHOOT only inside
 * AARGM_CLOSE_RANGE (ground range) of a radar that is on, as AARGM_RULE says; the launch zone alone
 * read SHOOT from 18 km. 'close': in the zone but farther out (CLOSE IN); 'quiet': close enough but the
 * radar is off. null: not in the zone (or not an AARGM shot). The AI and the release itself still read
 * the launch zone.
 */
export function aargmCue(p: AircraftEntity, target: AnyEntity | null, z: Pick<LaunchZone, 'shoot' | 'weapon'> | null): 'shoot' | 'close' | 'quiet' | null {
  if (!z || !z.shoot || z.weapon !== 'aargm' || !target || target.kind !== 'sam') return null;
  if (Math.hypot(target.position.x - p.position.x, target.position.z - p.position.z) > AARGM_CLOSE_RANGE) return 'close';
  return target.radarOn ? 'shoot' : 'quiet';
}
