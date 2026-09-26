/**
 * F35-A — SAM / AAA site data (gameplay-compressed ranges, see docs/ARCHITECTURE.md).
 *
 * detectRange is quoted against a 5 m² fighter; the radar equation (sensors/signatures.ts)
 * shrinks it for stealthy targets — a clean F-35A is picked up at ~25 % of it, beast mode ~45 %.
 */
import type { MunitionId, SamType } from '../../core/types';
import type { GunId } from '../weapons/defs';

export interface SamTypeData {
  type: SamType;
  /** Missile fired (null = guns only). */
  missile: MunitionId | null;
  gun: GunId | null;
  /** Has a search/track radar (false = optical/IR MANPADS team: no RWR warning). */
  radar: boolean;
  /** Radar detection range vs 5 m² (or visual/IR acquisition range for MANPADS), m. */
  detectRange: number;
  engageMin: number;
  engageMax: number;
  /** Minimum target height above ground (radar horizon / clutter floor), m. */
  altMin: number;
  /** Maximum target altitude (m MSL). */
  altMax: number;
  /** Multiplier on DifficultyParams.samReactionTime (track → launch). */
  reaction: number;
  /** Missiles per salvo and spacing (s). */
  salvo: number;
  salvoInterval: number;
  /** Ready rounds and full reload time (s). */
  missiles: number;
  reloadTime: number;
  /** Delay before the next engagement after a salvo resolves (s). */
  refireDelay: number;
  /** Max missiles guided at once (fire channels). */
  channels: number;
  /** Search antenna rotation (rad/s). */
  radarSpin: number;
  /** Launcher/turret slew rate (rad/s). */
  slewRate: number;
  /** Vertical launch (no slew needed). */
  vertical: boolean;
  /** Detection factor against targets below 300 m AGL (clutter). */
  lowAltFactor: number;
  /** Probability the crew shuts the radar down when an anti-radiation missile is inbound. */
  armDiscipline: number;
  /** Antenna height for terrain line-of-sight (m). */
  mastHeight: number;
  /** AAA: burst length / pause (s) and ammunition. */
  burst: number;
  burstPause: number;
  ammo: number;
}

const D: Omit<SamTypeData, 'type' | 'missile' | 'gun' | 'detectRange' | 'engageMin' | 'engageMax' | 'altMin' | 'altMax'> = {
  radar: true,
  reaction: 1,
  salvo: 2,
  salvoInterval: 2,
  missiles: 4,
  reloadTime: 60,
  refireDelay: 4,
  channels: 2,
  radarSpin: 2,
  slewRate: 0.9,
  vertical: false,
  lowAltFactor: 0.7,
  armDiscipline: 0.6,
  mastHeight: 8,
  burst: 0,
  burstPause: 0,
  ammo: 0,
};

export const SAM_DATA: Record<SamType, SamTypeData> = {
  // S-300PS: Clam Shell low-altitude acquisition on a 25 m mast, Flap Lid engagement radar, TVM
  sa10: {
    ...D,
    type: 'sa10',
    missile: 'm_48n6',
    gun: null,
    detectRange: 75_000,
    engageMin: 5_000,
    engageMax: 45_000,
    altMin: 25,
    altMax: 27_000,
    reaction: 1,
    salvo: 2,
    salvoInterval: 3,
    missiles: 8,
    reloadTime: 90,
    refireDelay: 5,
    channels: 4,
    radarSpin: 2.1,
    vertical: true,
    lowAltFactor: 0.85,
    armDiscipline: 0.75,
    mastHeight: 25,
  },
  // 2K12 Kub: Straight Flush radar, CW illuminator, 3M9 semi-active ramjet
  sa6: {
    ...D,
    type: 'sa6',
    missile: 'm_3m9',
    gun: null,
    detectRange: 38_000,
    engageMin: 3_000,
    engageMax: 20_000,
    altMin: 80,
    altMax: 12_000,
    reaction: 1.2,
    salvo: 2,
    salvoInterval: 2,
    missiles: 6,
    reloadTime: 70,
    refireDelay: 5,
    channels: 2,
    radarSpin: 1.6,
    slewRate: 0.7,
    lowAltFactor: 0.6,
    armDiscipline: 0.55,
    mastHeight: 6,
  },
  // 9K33 Osa: single amphibious vehicle, command guidance
  sa8: {
    ...D,
    type: 'sa8',
    missile: 'm_9m33',
    gun: null,
    detectRange: 24_000,
    engageMin: 1_500,
    engageMax: 10_000,
    altMin: 25,
    altMax: 5_000,
    reaction: 0.8,
    salvo: 2,
    salvoInterval: 2.5,
    missiles: 6,
    reloadTime: 50,
    refireDelay: 3,
    channels: 2,
    radarSpin: 3.1,
    slewRate: 1.2,
    lowAltFactor: 0.75,
    armDiscipline: 0.5,
    mastHeight: 5,
  },
  // 9K330 Tor: vertical launch, fast reaction, good against low / small targets
  sa15: {
    ...D,
    type: 'sa15',
    missile: 'm_9m330',
    gun: null,
    detectRange: 25_000,
    engageMin: 1_000,
    engageMax: 12_000,
    altMin: 10,
    altMax: 6_000,
    reaction: 0.6,
    salvo: 2,
    salvoInterval: 1.5,
    missiles: 8,
    reloadTime: 60,
    refireDelay: 3,
    channels: 2,
    radarSpin: 6.3,
    vertical: true,
    lowAltFactor: 0.9,
    armDiscipline: 0.65,
    mastHeight: 5,
  },
  // 9K38 Igla team: visual/IR acquisition, no radar, no RWR warning
  sa18: {
    ...D,
    type: 'sa18',
    missile: 'm_igla',
    gun: null,
    radar: false,
    detectRange: 6_000,
    engageMin: 500,
    engageMax: 5_000,
    altMin: 10,
    altMax: 3_500,
    reaction: 1,
    salvo: 1,
    salvoInterval: 1,
    missiles: 4,
    reloadTime: 45,
    refireDelay: 12,
    channels: 1,
    radarSpin: 0,
    slewRate: 1.5,
    lowAltFactor: 1,
    armDiscipline: 0,
    mastHeight: 2,
  },
  // ZSU-23-4 Shilka: Gun Dish radar + optical backup, 4 × 23 mm
  zsu23: {
    ...D,
    type: 'zsu23',
    missile: null,
    gun: 'zsu23',
    detectRange: 12_000,
    engageMin: 0,
    engageMax: 2_500,
    altMin: 0,
    altMax: 3_000,
    reaction: 0.4,
    salvo: 0,
    salvoInterval: 0,
    missiles: 0,
    reloadTime: 40,
    refireDelay: 0,
    channels: 1,
    radarSpin: 4,
    slewRate: 1.4,
    lowAltFactor: 1,
    armDiscipline: 0.4,
    mastHeight: 4,
    burst: 1.6,
    burstPause: 1.4,
    ammo: 2_000,
  },
};

/** Optical/visual acquisition range used by every site as a backup (AAA gunners, MANPADS), m. */
export const VISUAL_RANGE = 3_000;
