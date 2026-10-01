/**
 * Label tables and allocation-light number formatting for the HMD / PCD.
 *
 * `NumText` keeps the last value → string so a readout that does not change does not allocate a new
 * string every frame (most readouts change a few times per second at most).
 */
import type { AircraftType, GroundTargetType, SamType, WarningId, WeaponId } from '../../core/types';
import type { AnyEntity } from '../../sim/entities';

export const AIRCRAFT_LABEL: Record<AircraftType, string> = {
  f35a: 'F-35A',
  mig29: 'MIG-29',
  su27: 'SU-27',
  su35: 'SU-35',
  su57: 'SU-57',
  tu22m: 'TU-22M',
  a50: 'A-50',
  a320: 'A320',
};

/** Short type codes for crowded places (TSD, RWR). */
export const AIRCRAFT_SHORT: Record<AircraftType, string> = {
  f35a: 'F35',
  mig29: '29',
  su27: '27',
  su35: '35',
  su57: '57',
  tu22m: '22M',
  a50: 'A50',
  a320: 'CIV',
};

export const SAM_LABEL: Record<SamType, string> = {
  sa6: 'SA-6',
  sa8: 'SA-8',
  sa10: 'SA-10',
  sa15: 'SA-15',
  sa18: 'SA-18',
  zsu23: 'ZSU-23',
};

export const GROUND_LABEL: Record<GroundTargetType, string> = {
  ewr: 'EWR',
  bunker: 'BUNKER',
  fuel: 'FUEL DEPOT',
  hangar: 'HAS',
  parked_jet: 'JET',
  truck: 'TRUCK',
  tank: 'ARMOR',
  ship: 'SHIP',
  factory: 'FACTORY',
  bridge: 'BRIDGE',
};

/** HMD weapon names ("AMRAAM 4", "9X 2", "GUN 180", "JDAM 2"). */
export const WEAPON_HUD: Record<WeaponId, string> = {
  gun: 'GUN',
  aim120: 'AMRAAM',
  aim9x: '9X',
  gbu31: 'JDAM',
  gbu39: 'SDB',
  aargm: 'AARGM',
};

export const WEAPON_IS_AG: Record<WeaponId, boolean> = {
  gun: false,
  aim120: false,
  aim9x: false,
  gbu31: true,
  gbu39: true,
  aargm: true,
};

/** Brevity call shown briefly when the player releases a weapon. */
export const WEAPON_BREVITY: Record<WeaponId, string> = {
  gun: 'GUNS',
  aim120: 'FOX 3',
  aim9x: 'FOX 2',
  gbu31: 'RIFLE',
  gbu39: 'RIFLE',
  aargm: 'MAGNUM',
};

export interface WarningInfo {
  label: string;
  /** 2 = warning (red), 1 = caution (amber), 0 = advisory. */
  level: 0 | 1 | 2;
  /** Sort priority (lower = more important). */
  order: number;
  /** Long description for the PCD ICAWS page. */
  detail: string;
}

export const WARNING_INFO: Record<WarningId, WarningInfo> = {
  pull_up: { label: 'PULL UP', level: 2, order: 0, detail: 'Ground collision predicted' },
  missile: { label: 'MISSILE', level: 2, order: 1, detail: 'Missile approach (DAS)' },
  engine_fire: { label: 'ENGINE FIRE', level: 2, order: 2, detail: 'Engine fire detected' },
  stall: { label: 'STALL', level: 2, order: 3, detail: 'AOA limit / departure' },
  over_g: { label: 'OVER-G', level: 2, order: 4, detail: 'Load factor exceeded' },
  altitude: { label: 'ALTITUDE', level: 2, order: 5, detail: 'Low altitude, descending' },
  engine_fail: { label: 'ENGINE FAIL', level: 2, order: 6, detail: 'Engine thrust loss' },
  hydraulics: { label: 'HYDRAULICS', level: 1, order: 7, detail: 'Hydraulic pressure low' },
  bingo: { label: 'BINGO', level: 1, order: 8, detail: 'Bingo fuel — RTB' },
  fuel_low: { label: 'FUEL LOW', level: 1, order: 9, detail: 'Fuel quantity low' },
  damage: { label: 'DAMAGE', level: 1, order: 10, detail: 'Airframe damaged' },
  speed_low: { label: 'SPEED', level: 1, order: 11, detail: 'Airspeed low' },
  spike: { label: 'SPIKE', level: 1, order: 12, detail: 'Fire-control radar lock' },
  flares_low: { label: 'FLARES LOW', level: 0, order: 13, detail: 'Flares low' },
  chaff_low: { label: 'CHAFF LOW', level: 0, order: 14, detail: 'Chaff low' },
};

/** Short HMD label of an entity ("MIG-29", "SA-6", "SHIP"). */
export function entityLabel(e: AnyEntity | null | undefined): string {
  if (!e) return '';
  switch (e.kind) {
    case 'aircraft':
      return AIRCRAFT_LABEL[e.type] ?? e.type.toUpperCase();
    case 'sam':
      return SAM_LABEL[e.type] ?? e.type.toUpperCase();
    case 'ground':
      return GROUND_LABEL[e.type] ?? e.type.toUpperCase();
    case 'missile':
      return e.def.short;
    default:
      return '';
  }
}

/** Kill-feed line for a destroyed entity. */
export function killText(e: AnyEntity): string {
  if (e.kind === 'aircraft') return 'SPLASH ' + entityLabel(e);
  if (e.kind === 'sam') return entityLabel(e) + ' DESTROYED';
  if (e.kind === 'ground') return entityLabel(e) + ' DESTROYED';
  return '';
}

/** Cached integer / fixed-point formatter for one readout. */
export class NumText {
  private v = NaN;
  private s = '';
  constructor(
    private readonly digits = 0,
    private readonly prefix = '',
    private readonly suffix = '',
    private readonly grouping = false,
    private readonly pad = 0,
  ) {}

  get(value: number): string {
    const k = this.digits > 0 ? Math.round(value * 10 ** this.digits) : Math.round(value);
    if (k === this.v) return this.s;
    this.v = k;
    let body: string;
    if (this.digits > 0) body = (k / 10 ** this.digits).toFixed(this.digits);
    else if (this.grouping) body = groupThousands(k);
    else body = String(k);
    if (this.pad > 0) {
      const neg = body.startsWith('-');
      let d = neg ? body.slice(1) : body;
      while (d.length < this.pad) d = '0' + d;
      body = neg ? '-' + d : d;
    }
    this.s = this.prefix + body + this.suffix;
    return this.s;
  }
}

export function groupThousands(n: number): string {
  const neg = n < 0;
  let s = String(Math.abs(Math.round(n)));
  let out = '';
  while (s.length > 3) {
    out = ',' + s.slice(-3) + out;
    s = s.slice(0, -3);
  }
  return (neg ? '-' : '') + s + out;
}

/** "1:35" style time. */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ':' + (r < 10 ? '0' : '') + r;
}

/** "1:05" style hours:minutes (endurance). */
export function hmm(seconds: number): string {
  const m = Math.max(0, Math.round(seconds / 60));
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h + ':' + (r < 10 ? '0' : '') + r;
}

/** Pre-built strings for small integers (ladder / tape labels, counts). */
export const INT_STR: string[] = Array.from({ length: 400 }, (_, i) => String(i));
/** Two-digit heading tape labels "00".."35". */
export const HDG_STR: string[] = Array.from({ length: 36 }, (_, i) => (i < 10 ? '0' : '') + i);
/** Three-digit headings "000".."359". */
export const HDG3_STR: string[] = Array.from({ length: 360 }, (_, i) => String(i).padStart(3, '0'));
