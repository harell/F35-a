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
  /**
   * Shoulder-launched IR missiles carried besides the main weapon (the Rat navy AD boat's SA-18s):
   * fired at a hostile aircraft inside `range`, one every `refire` s, `rounds` in all. Null = none.
   */
  manpads: { missile: MunitionId; minRange: number; range: number; refire: number; rounds: number } | null;
  /**
   * Point defence against incoming munitions (anti-radiation missiles, JDAM/SDB) aimed within
   * `protect` m of the site: engagement range, and kill probability per interceptor that fuzes.
   */
  pointDefense: { range: number; minRange: number; protect: number; pkAgm: number; pkBomb: number } | null;
  /**
   * Close-in acquisition that stealth shaping doesn't beat (the Rat navy AD boat's electro-optical
   * tracker and lookouts, #115): any hostile aircraft inside `range` m with line of sight is
   * detected, and one with its weapon bay open inside `bayRange` m (the doors' radar flash and the
   * bomb leaving). A track found this way is held out to `bayRange`. Both scale with the difficulty's
   * samRangeScale, like the engagement range. Null = the radar equation alone.
   */
  closeCue: { range: number; bayRange: number } | null;
  /**
   * The AD boat's nuisance fire (DifficultyParams.adBoatHarass): a jet with its bay open inside
   * `cueRange` m (the release it is about to make, seen by the boat's ESM and the mother ship's picture)
   * is detected and held out to there, and the boat fires at anything inside `reach` m with the radar SAM
   * whatever its missile's real envelope. Both scale with the difficulty's samRangeScale. Null = none.
   */
  harass: { cueRange: number; reach: number } | null;
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
  manpads: null,
  pointDefense: null,
  closeCue: null,
  harass: null,
};

export const SAM_DATA: Record<SamType, SamTypeData> = {
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
    // Tor: designed to kill precision munitions — protects itself and co-located sites
    pointDefense: { range: 9_000, minRange: 1_000, protect: 3_000, pkAgm: 0.35, pkBomb: 0.45 },
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
  // Rat navy air-defence fast boat: a MOVING SAM (sim/boats.ts sails it). The radar SAM behaves
  // like the SA-15 (same missile and envelope, so the AGM-88G homes on its radar) from a low mast
  // on a small hull with fewer rounds, and without the Tor's point defence (a fast boat has no
  // munition-killing fire control); a crew with SA-18s fires at anything inside 5 km.
  ad_boat: {
    ...D,
    type: 'ad_boat',
    missile: 'm_9m330',
    gun: null,
    detectRange: 25_000,
    engageMin: 1_000,
    engageMax: 12_000,
    altMin: 10,
    altMax: 6_000,
    reaction: 0.7,
    salvo: 2,
    salvoInterval: 1.5,
    missiles: 4,
    reloadTime: 90,
    refireDelay: 4,
    channels: 2,
    radarSpin: 6.3,
    vertical: true,
    lowAltFactor: 0.9,
    armDiscipline: 0.4,
    mastHeight: 4,
    manpads: { missile: 'm_igla', minRange: 500, range: 5_000, refire: 12, rounds: 4 },
    // a stand-off release (13 km and out) stays safe; a closer pass costs something (#115): the crew
    // picks the jet up inside 9 km whatever its shaping, and inside 12 km the moment its bay opens
    closeCue: { range: 9_000, bayRange: 12_000 },
    // a stand-off release is not free for the player: the boat fires at it from 24 km out, past its missile's 12 km
    harass: { cueRange: 24_000, reach: 20_000 },
  },
};

/** Optical/visual acquisition range used by every site as a backup (AAA gunners, MANPADS), m. */
export const VISUAL_RANGE = 3_000;
