/**
 * F35-A — which targets a weapon can engage: A/A missiles aircraft, bombs surface targets, the AARGM
 * radars (SAM sites) only, the gun everything. One rule for the release denial (release.ts) and the
 * HUD's standing warning (weapon block and target camera), so what the HUD warns of is what FIRE refuses
 * (or, a JDAM with an aircraft boxed, drops on the CCIP point, nowhere near it).
 */
import type { WeaponId } from '../../core/types';

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
