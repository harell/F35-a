/**
 * F35-A — munition + gun database (COMBAT module).
 *
 * Numbers are aerospace-plausible but gameplay-compressed (see docs/ARCHITECTURE.md "Scale"):
 * real speeds, ~40–50 % of real ranges. Kinematics use a boost/sustain motor, drag
 * `deceleration = drag * rho * v²`, a dynamic-pressure-limited g capability (sluggish when slow
 * or high) and induced drag when manoeuvring. The DLZ (dlz.ts) integrates the same model.
 *
 * Reference max ranges (co-altitude 6 km, both jets 280 m/s, head-on):
 *   AIM-120D ≈ 30 km (NEZ ≈ 10 km) · R-77 ≈ 25 km · R-27ER ≈ 21 km · AIM-9X ≈ 8 km · R-73 ≈ 6 km
 *   SA-6 20 km · SA-15 12 km · SA-18 (the AD boat's) 5 km
 */
import type { ExplosionSize, MunitionId } from '../../core/types';
import type { MunitionDef } from '../entities';

const DEG = Math.PI / 180;

/** Munition definition with the extra tuning fields the combat module needs. */
export interface CombatMunitionDef extends MunitionDef {
  /** Active-radar seeker switch-on range-to-go ("pitbull"), m. 0 = n/a. */
  activeRange: number;
  /** Receives midcourse target updates from the launcher's sensors. */
  datalink: boolean;
  /** Flies a lofted trajectory on long shots. */
  loft: boolean;
  /** Dynamic pressure (Pa) at which the full maxG is available (less when slow/high). */
  fullGQ: number;
  /** Extra g from thrust-vector control / gas vanes while the motor burns (independent of q). */
  tvcG: number;
  /**
   * Induced-drag area factor: induced decel = aAero² / (q · liftArea). Derived at module load from
   * `ldMax` so that a max-g aerodynamic pull at any q ≤ fullGQ costs aeroMax / ldMax (a missile
   * body's lift-to-drag ratio at max AoA). Thrust-vectoring g is NOT charged here (see flight.ts).
   */
  liftArea: number;
  /** Lift-to-drag ratio of the airframe at max aerodynamic g (≈ 3 for a missile body). */
  ldMax: number;
  /** Vertical launch only: pitch-over rate after ignition (rad/s, gas-dynamic / TVC turnover). */
  turnRate: number;
  /** Motor ignition delay after release (bay ejection / cold vertical launch), s. */
  igniteDelay: number;
  /** Separation speed from the launcher (m/s): ejector push, rail exit, cold-launch gas. */
  ejectSpeed: number;
  /** Explosion visual size. */
  blast: ExplosionSize;
  /** Autopilot first-order lag (s). */
  autopilotTau: number;
  /** Warhead/fuze arming time after release (s). */
  armTime: number;
  /** Minimum speed (m/s) the missile needs at intercept to count as "in zone" (DLZ + kinematic defeat). */
  minKillSpeed: number;
  /** Efficiency factor between the 1-D DLZ energy model and the full 3-D flight (calibrated in tests). */
  dlzEfficiency: number;
}

type Def = CombatMunitionDef;

const BASE = {
  glideRatio: 0,
  ldMax: 3,
  turnRate: 0,
  activeRange: 0,
  datalink: false,
  loft: false,
  tvcG: 0,
  igniteDelay: 0,
  ejectSpeed: 20,
  autopilotTau: 0.12,
  armTime: 0.5,
  minKillSpeed: 260,
  dlzEfficiency: 1,
  flareResistance: 1,
  chaffResistance: 1,
  notchResistance: 1,
};

export const MUNITIONS: Record<MunitionId, Def> = {
  /* ───────────── Player (F-35A) weapons ───────────── */
  aim120: {
    ...BASE,
    id: 'aim120',
    name: 'AIM-120D AMRAAM',
    short: 'AMRAAM',
    category: 'aam',
    guidance: 'active_radar',
    launch: 'eject',
    mass: 161,
    boostTime: 3,
    boostAccel: 340,
    sustainTime: 4,
    sustainAccel: 60,
    drag: 1.75e-4,
    maxG: 40,
    seekerFov: 20 * DEG,
    gimbalLimit: 55 * DEG,
    seekerRange: 14_000,
    navConstant: 4,
    minRange: 1_200,
    maxRange: 30_000,
    fuseRadius: 12,
    damage: 160,
    blastRadius: 30,
    maxFlightTime: 65,
    chaffResistance: 0.75,
    notchResistance: 0.65,
    smoke: 0.35,
    length: 3.65,
    diameter: 0.178,
    activeRange: 9_000,
    datalink: true,
    loft: true,
    fullGQ: 45_000,
    liftArea: 0.012,
    igniteDelay: 0.3,
    ejectSpeed: 8,
    blast: 'medium',
    armTime: 0.8,
  },
  aim9x: {
    ...BASE,
    id: 'aim9x',
    name: 'AIM-9X Sidewinder',
    short: '9X',
    category: 'aam',
    guidance: 'ir',
    launch: 'rail',
    mass: 85,
    // i2: longer-burning Mk 139-class motor + lower parasite drag — the tail-chase reach at
    // medium altitude (250 m/s shooter and target, 5 km) is now rMax ≈ 5–6 km / rNe ≈ 2.5 km
    boostTime: 2,
    boostAccel: 330,
    sustainTime: 3,
    sustainAccel: 50,
    drag: 1.9e-4,
    maxG: 50,
    seekerFov: 4 * DEG,
    gimbalLimit: 90 * DEG,
    seekerRange: 10_000,
    navConstant: 4,
    minRange: 300,
    maxRange: 8_000,
    fuseRadius: 8,
    damage: 115,
    blastRadius: 16,
    maxFlightTime: 25,
    flareResistance: 0.86, // imaging IR seeker: rejects most flares (i2: 0.9 → 0.86, a flaring + breaking ace defeats ~40-50%)
    smoke: 0.25,
    length: 3.02,
    diameter: 0.127,
    fullGQ: 40_000,
    tvcG: 60,
    liftArea: 0.009,
    blast: 'medium',
    autopilotTau: 0.07,
    armTime: 0.35,
    minKillSpeed: 280,
  },
  gbu31: {
    ...BASE,
    id: 'gbu31',
    name: 'GBU-31 JDAM',
    short: 'JDAM',
    category: 'bomb',
    guidance: 'gps',
    launch: 'drop',
    mass: 934,
    boostTime: 0,
    boostAccel: 0,
    sustainTime: 0,
    sustainAccel: 0,
    drag: 6.0e-5,
    glideRatio: 1.6,
    maxG: 4,
    seekerFov: Math.PI,
    gimbalLimit: Math.PI,
    seekerRange: 0,
    navConstant: 3,
    minRange: 0,
    maxRange: 12_000,
    fuseRadius: 0,
    damage: 900,
    blastRadius: 60,
    maxFlightTime: 150,
    smoke: 0,
    length: 3.9,
    diameter: 0.46,
    fullGQ: 25_000,
    liftArea: 0.02,
    ejectSpeed: 3,
    blast: 'huge',
    autopilotTau: 0.3,
    armTime: 1.5,
    minKillSpeed: 0,
  },
  /* KAB-500S-E: the enemy's satellite-guided 500 kg bomb (Flanker strike loadout, 'gbu31' slot) */
  kab500: {
    ...BASE,
    id: 'kab500',
    name: 'KAB-500S',
    short: 'KAB',
    category: 'bomb',
    guidance: 'gps',
    launch: 'drop',
    mass: 560,
    boostTime: 0,
    boostAccel: 0,
    sustainTime: 0,
    sustainAccel: 0,
    drag: 6.0e-5,
    glideRatio: 1.6,
    maxG: 4,
    seekerFov: Math.PI,
    gimbalLimit: Math.PI,
    seekerRange: 0,
    navConstant: 3,
    minRange: 0,
    maxRange: 9_000,
    fuseRadius: 0,
    damage: 600,
    blastRadius: 40,
    maxFlightTime: 120,
    smoke: 0,
    length: 3.05,
    diameter: 0.35,
    fullGQ: 25_000,
    liftArea: 0.02,
    ejectSpeed: 3,
    blast: 'large',
    autopilotTau: 0.3,
    armTime: 1.5,
    minKillSpeed: 0,
  },
  gbu53: {
    ...BASE,
    id: 'gbu53',
    name: 'GBU-53/B StormBreaker',
    short: 'SDB II',
    category: 'bomb',
    guidance: 'tri_mode',
    launch: 'drop',
    // SDB-class glide airframe with a smaller multi-effect warhead than the JDAM
    mass: 93,
    boostTime: 0,
    boostAccel: 0,
    sustainTime: 0,
    sustainAccel: 0,
    drag: 6.5e-5,
    glideRatio: 5.5,
    // enough terminal authority to follow a ship at 5–6 m/s or a truck at ~15 m/s
    maxG: 5,
    // tri-mode seeker (MMW radar + imaging IR + SAL): 20° field of view, searched from 3 km to go
    seekerFov: 10 * DEG,
    gimbalLimit: 45 * DEG,
    seekerRange: 3_000,
    navConstant: 3.5,
    minRange: 0,
    maxRange: 30_000,
    fuseRadius: 3,
    damage: 250,
    blastRadius: 14,
    maxFlightTime: 200,
    smoke: 0,
    length: 1.76,
    diameter: 0.18,
    datalink: true,
    fullGQ: 18_000,
    liftArea: 0.05,
    ejectSpeed: 3,
    blast: 'medium',
    autopilotTau: 0.3,
    armTime: 1.5,
    minKillSpeed: 0,
  },
  aargm: {
    ...BASE,
    id: 'aargm',
    name: 'AGM-88G AARGM-ER',
    short: 'AARGM',
    category: 'agm',
    guidance: 'anti_radiation',
    launch: 'eject',
    mass: 300,
    boostTime: 4,
    boostAccel: 250,
    sustainTime: 10,
    sustainAccel: 55,
    drag: 1.1e-4,
    maxG: 25,
    seekerFov: 45 * DEG,
    gimbalLimit: 60 * DEG,
    seekerRange: 80_000,
    navConstant: 4,
    minRange: 3_000,
    maxRange: 50_000,
    fuseRadius: 10,
    damage: 240,
    blastRadius: 22,
    maxFlightTime: 90,
    smoke: 0.4,
    length: 4.1,
    diameter: 0.25,
    loft: true,
    fullGQ: 40_000,
    liftArea: 0.012,
    igniteDelay: 0.35,
    ejectSpeed: 8,
    blast: 'large',
    armTime: 1.5,
    minKillSpeed: 0,
  },

  /* ───────────── Enemy air-to-air missiles ───────────── */
  r73: {
    ...BASE,
    id: 'r73',
    name: 'R-73 (AA-11 Archer)',
    short: 'R-73',
    category: 'aam',
    guidance: 'ir',
    launch: 'rail',
    mass: 105,
    boostTime: 2,
    boostAccel: 300,
    sustainTime: 0,
    sustainAccel: 0,
    drag: 4.0e-4,
    maxG: 40,
    seekerFov: 4 * DEG,
    gimbalLimit: 60 * DEG,
    seekerRange: 7_000,
    navConstant: 3.5,
    minRange: 300,
    maxRange: 6_000,
    fuseRadius: 6,
    damage: 100,
    blastRadius: 14,
    maxFlightTime: 22,
    flareResistance: 0.56, // i2: 0.45 → 0.56 (R-73 vs a flaring player on Pilot: Pk ≈ 25-35 %, not ≈ 0)
    smoke: 0.6,
    length: 2.9,
    diameter: 0.17,
    fullGQ: 45_000,
    tvcG: 40,
    liftArea: 0.008,
    blast: 'medium',
    autopilotTau: 0.09,
    armTime: 0.35,
    minKillSpeed: 280,
  },
  r27: {
    ...BASE,
    id: 'r27',
    name: 'R-27ER (AA-10 Alamo)',
    short: 'R-27',
    category: 'aam',
    guidance: 'semi_active',
    launch: 'rail',
    mass: 350,
    boostTime: 3,
    boostAccel: 250,
    sustainTime: 5,
    sustainAccel: 45,
    drag: 1.9e-4,
    maxG: 30,
    seekerFov: 15 * DEG,
    gimbalLimit: 50 * DEG,
    seekerRange: 30_000,
    navConstant: 3.5,
    minRange: 1_500,
    maxRange: 20_000,
    fuseRadius: 14,
    damage: 170,
    blastRadius: 32,
    maxFlightTime: 50,
    chaffResistance: 0.45,
    notchResistance: 0.35,
    smoke: 0.7,
    length: 4.8,
    diameter: 0.26,
    fullGQ: 50_000,
    liftArea: 0.012,
    blast: 'medium',
    armTime: 0.8,
  },
  r77: {
    ...BASE,
    id: 'r77',
    name: 'R-77 (AA-12 Adder)',
    short: 'R-77',
    category: 'aam',
    guidance: 'active_radar',
    launch: 'rail',
    mass: 175,
    boostTime: 3,
    boostAccel: 320,
    sustainTime: 3,
    sustainAccel: 55,
    drag: 1.9e-4,
    maxG: 38,
    seekerFov: 20 * DEG,
    gimbalLimit: 55 * DEG,
    seekerRange: 11_000,
    navConstant: 4,
    minRange: 1_000,
    maxRange: 25_000,
    fuseRadius: 12,
    damage: 150,
    blastRadius: 28,
    maxFlightTime: 60,
    chaffResistance: 0.55,
    notchResistance: 0.45,
    smoke: 0.4,
    length: 3.6,
    diameter: 0.2,
    activeRange: 8_000,
    datalink: true,
    loft: true,
    fullGQ: 45_000,
    liftArea: 0.012,
    blast: 'medium',
    armTime: 0.8,
  },

  /* ───────────── SAM missiles ───────────── */
  m_3m9: {
    ...BASE,
    id: 'm_3m9',
    name: '3M9 (SA-6 Gainful)',
    short: 'SA-6',
    category: 'sam',
    guidance: 'semi_active',
    launch: 'canted',
    mass: 600,
    boostTime: 3,
    boostAccel: 230,
    sustainTime: 16,
    sustainAccel: 55,
    drag: 1.3e-4,
    maxG: 20,
    seekerFov: 15 * DEG,
    gimbalLimit: 50 * DEG,
    seekerRange: 30_000,
    navConstant: 3.5,
    minRange: 3_000,
    maxRange: 20_000,
    fuseRadius: 17,
    damage: 170,
    blastRadius: 38,
    maxFlightTime: 45,
    chaffResistance: 0.3,
    notchResistance: 0.3,
    smoke: 0.9,
    length: 5.8,
    diameter: 0.33,
    fullGQ: 50_000,
    liftArea: 0.01,
    ejectSpeed: 25,
    blast: 'large',
    autopilotTau: 0.15,
    armTime: 1.2,
    minKillSpeed: 300,
  },
  m_9m330: {
    ...BASE,
    id: 'm_9m330',
    name: '9M330 (SA-15 Gauntlet)',
    short: 'SA-15',
    category: 'sam',
    guidance: 'command',
    launch: 'vertical',
    mass: 165,
    boostTime: 3,
    boostAccel: 320,
    sustainTime: 4,
    sustainAccel: 50,
    drag: 1.6e-4,
    maxG: 30,
    seekerFov: Math.PI,
    gimbalLimit: Math.PI,
    seekerRange: 0,
    navConstant: 4,
    minRange: 1_000,
    maxRange: 12_000,
    fuseRadius: 12,
    damage: 100,
    blastRadius: 20,
    maxFlightTime: 30,
    chaffResistance: 0.6,
    notchResistance: 0.6,
    smoke: 0.5,
    length: 2.9,
    diameter: 0.235,
    fullGQ: 40_000,
    tvcG: 30,
    liftArea: 0.01,
    turnRate: 1.75, // ~100°/s gas-dynamic turnover (Tor)
    igniteDelay: 0.4,
    ejectSpeed: 25,
    blast: 'medium',
    armTime: 0.8,
    minKillSpeed: 300,
  },
  m_igla: {
    ...BASE,
    id: 'm_igla',
    name: '9M39 Igla (SA-18 Grouse)',
    short: 'SA-18',
    category: 'sam',
    guidance: 'ir',
    launch: 'rail',
    mass: 10.8,
    boostTime: 1.6,
    boostAccel: 380,
    sustainTime: 5,
    sustainAccel: 25,
    drag: 4.0e-4,
    maxG: 20,
    seekerFov: 3 * DEG,
    gimbalLimit: 40 * DEG,
    seekerRange: 5_500,
    navConstant: 3.5,
    minRange: 500,
    maxRange: 5_200,
    fuseRadius: 4,
    damage: 70,
    blastRadius: 8,
    maxFlightTime: 17,
    flareResistance: 0.4,
    smoke: 0.35,
    length: 1.57,
    diameter: 0.072,
    fullGQ: 30_000,
    liftArea: 0.008,
    ejectSpeed: 30,
    blast: 'small',
    autopilotTau: 0.1,
    armTime: 0.5,
    minKillSpeed: 250,
  },
  // Kowsar (C-704 family) short-range anti-ship missile of the IRGC Navy missile boat. VISUAL ONLY:
  // sim/boats.ts flies it (a sea-skimming pursuit that always reaches its ship and scores one hit);
  // the CombatSystem never steps it, and missiles are never sensor contacts, so it can't be shot down.
  kowsar: {
    ...BASE,
    id: 'kowsar',
    name: 'Kowsar',
    short: 'KOWSAR',
    category: 'agm',
    guidance: 'active_radar',
    launch: 'canted',
    mass: 100,
    boostTime: 1,
    boostAccel: 150,
    sustainTime: 40,
    sustainAccel: 0,
    drag: 0,
    maxG: 15,
    seekerFov: 20 * DEG,
    gimbalLimit: 40 * DEG,
    seekerRange: 8_000,
    navConstant: 3,
    minRange: 1_000,
    maxRange: 15_000,
    fuseRadius: 10,
    damage: 300,
    blastRadius: 20,
    maxFlightTime: 90,
    smoke: 0.6,
    length: 3.5,
    diameter: 0.3,
    fullGQ: 30_000,
    liftArea: 0.01,
    ejectSpeed: 40,
    blast: 'large',
  },
};

// Induced drag consistent with the airframe L/D at max g (see CombatMunitionDef.liftArea).
for (const d of Object.values(MUNITIONS)) {
  if (d.category !== 'bomb') d.liftArea = (d.maxG * 9.80665 * d.ldMax) / d.fullGQ;
}

/* ───────────────────────── Guns ───────────────────────── */

export type GunId = 'gau22' | 'gsh301' | 'zsu23';

export interface GunDef {
  id: GunId;
  /** Rounds per second. */
  rate: number;
  /** Muzzle velocity (m/s). */
  muzzle: number;
  /** Dispersion (rad, 1-sigma per axis). */
  dispersion: number;
  /** Damage per round at muzzle energy (scaled by the round's remaining energy at impact, see gun.ts). */
  damage: number;
  /** Round lifetime / self-destruct (s). */
  life: number;
  calibre: number;
  /** Every Nth round is a tracer. */
  tracerEvery: number;
  /** Sea-level drag constant: decel = k * sigma * v². */
  dragK: number;
  /** Rounds self-destruct at end of life with a small flak puff. */
  flak: boolean;
}

export const GUNS: Record<GunId, GunDef> = {
  // GAU-22/A Equalizer, 25 mm PGU-47 APEX (armour-piercing HEI), 4 barrels, 3,300 rpm, 180 rounds
  // (~3.3 s of fire): ~18 damage per hit at ≤ 800 m ⇒ a fighter (100 HP) falls to 5–7 hits
  gau22: { id: 'gau22', rate: 55, muzzle: 1040, dispersion: 0.0032, damage: 20, life: 3, calibre: 0.025, tracerEvery: 4, dragK: 1.8e-4, flak: false },
  // GSh-30-1, 30 mm, 1,800 rpm
  gsh301: { id: 'gsh301', rate: 30, muzzle: 860, dispersion: 0.003, damage: 12.5, life: 3, calibre: 0.03, tracerEvery: 3, dragK: 2.0e-4, flak: false },
  // ZSU-23-4 Shilka: 4 × 2A7 23 mm, ~3,400 rpm combined; rounds self-destruct at ~5 s
  zsu23: { id: 'zsu23', rate: 57, muzzle: 970, dispersion: 0.008, damage: 3.4, life: 3.5, calibre: 0.023, tracerEvery: 3, dragK: 2.2e-4, flak: true },
};
