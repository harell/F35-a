/**
 * F35-A — aircraft performance database (SIM-CORE).
 *
 * One `AircraftPerf` record per AircraftType. All values are SI (kg, m, m², N, rad, rad/s, s).
 * Numbers are public-domain estimates, tuned so the flight model reproduces the headline
 * performance of each type (top speed, corner speed, sustained / instantaneous turn, climb).
 *
 * The AI module may import `AIRCRAFT_PERF` (or the helpers in ./performance.ts) for energy
 * management decisions: corner speed, g limits, max Mach, stall speed...
 */
import type { AircraftType, WeaponId } from '../../core/types';
import { DEG } from '../../core/math';

export interface AircraftPerf {
  readonly type: AircraftType;
  readonly name: string;

  /* ── Mass & geometry ── */
  /** Operating empty mass incl. pilot, gun, pylons that are always fitted (kg). */
  readonly emptyMass: number;
  /** Internal fuel capacity (kg). */
  readonly internalFuel: number;
  /** Reference wing area (m²). */
  readonly wingArea: number;
  /** Wing span (m). */
  readonly span: number;
  /** Overall length (m). */
  readonly length: number;
  /** Bounding radius for hits / collisions (m). */
  readonly radius: number;
  /** Typical external/internal stores carried by AI jets that are not modelled in `ac.stores` (kg). */
  readonly baseStoresMass: number;
  /** Drag increment of those typical stores + pylons. */
  readonly baseStoresCd: number;

  /* ── Propulsion (totals for all engines) ── */
  readonly engines: number;
  /** Sea-level static military (dry) thrust (N). */
  readonly thrustDry: number;
  /** Sea-level static max afterburner thrust (N). Equal to thrustDry when no afterburner. */
  readonly thrustAB: number;
  readonly hasAfterburner: boolean;
  /** Thrust ∝ σ^lapse · (1 + ram·M), capped at cap × static. */
  readonly dryLapse: number;
  readonly dryRam: number;
  readonly dryCap: number;
  readonly abLapse: number;
  readonly abRam: number;
  readonly abCap: number;
  /** Seconds from idle to military power. */
  readonly spoolUpTime: number;
  /** Afterburner light-off delay (s). */
  readonly abLightTime: number;
  /** Thrust specific fuel consumption, dry and at full AB (kg / (N·s)). */
  readonly tsfcDry: number;
  readonly tsfcAB: number;

  /* ── Aerodynamics ── */
  /** Lift curve slope at low Mach (per rad). */
  readonly clAlpha: number;
  /** AoA of maximum lift (rad). */
  readonly alphaStall: number;
  /** Maximum lift coefficient (low Mach). */
  readonly clMax: number;
  /** Zero-lift drag coefficient (clean, subsonic). */
  readonly cd0: number;
  /** Induced drag factor k (CDi = k·CL²). */
  readonly kInduced: number;
  /** Extra drag above clHigh: kHigh·(CL − clHigh)² (loss of leading-edge suction at high lift). */
  readonly kHigh: number;
  readonly clHigh: number;
  /** Transonic wave drag: starts at mCrit, peaks at mWavePeak with +cdWave. */
  readonly mCrit: number;
  readonly mWavePeak: number;
  readonly cdWave: number;
  /** Side force slope (per rad, negative). */
  readonly cyBeta: number;
  /** Speed brake / split-rudder drag increment. */
  readonly airbrakeCd: number;

  /* ── Structural & flight-control limits ── */
  readonly maxG: number;
  readonly minG: number;
  /** FBW AoA limiter (rad) — active on every difficulty (carefree handling). */
  readonly aoaLimit: number;
  /** Max roll rate at full authority (rad/s). */
  readonly rollRateMax: number;
  /** Pitch-rate command gain used at low dynamic pressure (rad/s at full stick). */
  readonly pitchRateMax: number;
  /** Max yaw rate from rudder (rad/s). */
  readonly yawRateMax: number;
  /** First-order rate response time constants at full authority (s). */
  readonly rollTau: number;
  readonly pitchTau: number;
  readonly yawTau: number;
  /** Dynamic pressure for full control authority (Pa). */
  readonly qFull: number;
  /** Thrust vectoring: keeps pitch/yaw authority at low speed. */
  readonly tvc: boolean;
  /** Departure violence past the stall AoA (wing-drop roll and nose-slice yaw rates, rad/s). */
  readonly departRoll: number;
  readonly departYaw: number;

  /* ── Headline performance (for AI / HUD / docs) ── */
  readonly maxMach: number;
  /** Top speed at sea level (Mach). */
  readonly maxMachSL: number;
  /** Service ceiling (m). */
  readonly ceiling: number;
  /** Corner speed (m/s IAS) — minimum speed for max instantaneous g. */
  readonly cornerSpeed: number;
  /** Best sustained turn at low altitude with max power (g). */
  readonly sustainedG: number;

  /* ── Signatures ── */
  /** Frontal RCS (m²). */
  readonly rcs: number;
  /** IR signature scale (1 = normal fighter at MIL). */
  readonly ir: number;

  /* ── Derived (computed at module load, see derive()) ── */
  /** Linear-lift knee AoA (rad) and quadratic coefficient of the CL rounding to clMax. */
  a1: number;
  cQuad: number;
  /** Effective positive max CL consistent with the curve. */
  clMaxEff: number;
  /** Negative-AoA stall parameters. */
  alphaStallNeg: number;
  a1Neg: number;
  cQuadNeg: number;
  clMaxNeg: number;
  /** Wing aspect ratio. */
  aspect: number;
  /** Incremental TSFC of the afterburner part of the thrust. */
  tsfcAbIncrement: number;
}

/** Per-weapon mass (kg) and external carriage drag increment (ΔCD per round, pylons separate). */
export const STORE_DATA: Record<Exclude<WeaponId, 'gun'>, { mass: number; dragExt: number }> = {
  aim120: { mass: 161, dragExt: 0.0011 },
  aim9x: { mass: 85, dragExt: 0.0008 },
  gbu31: { mass: 934, dragExt: 0.0036 },
  gbu53: { mass: 93, dragExt: 0.0009 },
  aargm: { mass: 360, dragExt: 0.0022 },
};
/** Drag increment of one external pylon station (stays after its stores are released). */
export const PYLON_DRAG = 0.0012;
/** Mass of one round of gun ammunition incl. links (kg). */
export const GUN_ROUND_MASS = 0.45;

type PerfInput = Omit<
  AircraftPerf,
  'a1' | 'cQuad' | 'clMaxEff' | 'alphaStallNeg' | 'a1Neg' | 'cQuadNeg' | 'clMaxNeg' | 'aspect' | 'tsfcAbIncrement'
>;

/** Engine lapse presets. */
const AB_TURBOFAN = { dryLapse: 0.85, dryRam: 0.2, dryCap: 1.05, abLapse: 0.75, abRam: 0.5, abCap: 1.12 };

/**
 * A civil helicopter (sim/civil/heli.ts): scripted kinematic flight while alive; these numbers only fly the falling
 * wreck once it is shot down (a draggy, wingless body: no lift to speak of), and give its size, RCS and IR.
 */
function helicopter(type: AircraftType, name: string, mass: number, length: number, rotor: number, rcs: number, ir: number): PerfInput {
  return {
    type,
    name,
    emptyMass: mass,
    internalFuel: mass * 0.15,
    wingArea: 6,
    span: rotor,
    length,
    radius: rotor / 2,
    baseStoresMass: 0,
    baseStoresCd: 0,
    engines: 1,
    thrustDry: 0,
    thrustAB: 0,
    hasAfterburner: false,
    dryLapse: 0.8,
    dryRam: 0,
    dryCap: 1,
    abLapse: 0.8,
    abRam: 0,
    abCap: 1,
    spoolUpTime: 1,
    abLightTime: 1,
    tsfcDry: 2e-5,
    tsfcAB: 2e-5,
    clAlpha: 1.0,
    alphaStall: 20 * DEG,
    clMax: 0.3,
    cd0: 0.25,
    kInduced: 0.3,
    kHigh: 0.3,
    clHigh: 0.2,
    mCrit: 0.5,
    mWavePeak: 0.8,
    cdWave: 0.05,
    cyBeta: -1.0,
    airbrakeCd: 0.05,
    maxG: 2.5,
    minG: -0.5,
    aoaLimit: 20 * DEG,
    rollRateMax: 30 * DEG,
    pitchRateMax: 15 * DEG,
    yawRateMax: 20 * DEG,
    rollTau: 0.6,
    pitchTau: 0.6,
    yawTau: 0.8,
    qFull: 2_000,
    tvc: false,
    departRoll: 0.6,
    departYaw: 0.4,
    maxMach: 0.3,
    maxMachSL: 0.25,
    ceiling: 6_000,
    cornerSpeed: 60,
    sustainedG: 1.5,
    rcs,
    ir,
  };
}

const RAW: Record<AircraftType, PerfInput> = {
  f35a: {
    type: 'f35a',
    name: 'F-35A Lightning II',
    emptyMass: 13_290,
    internalFuel: 8_278,
    wingArea: 42.7,
    span: 10.7,
    length: 15.7,
    radius: 8,
    baseStoresMass: 0,
    baseStoresCd: 0,
    engines: 1,
    thrustDry: 125_000, // F135-PW-100 MIL
    thrustAB: 191_000, // F135 max AB
    hasAfterburner: true,
    ...AB_TURBOFAN,
    // F135 dry thrust barely grows with ram (high-pressure-ratio core) and lapses a bit faster with
    // altitude: with the steep transonic drag rise below, MIL tops out at ≈ M0.92 low / M0.95 high
    // — the F-35A does not supercruise.
    dryLapse: 0.9,
    dryRam: 0,
    abCap: 1.08,
    spoolUpTime: 3.5,
    abLightTime: 0.4,
    tsfcDry: 2.5e-5, // ≈ 0.886 lb/lbf/h
    tsfcAB: 5.4e-5, // ≈ 1.9 lb/lbf/h
    clAlpha: 3.5,
    alphaStall: 35 * DEG,
    clMax: 1.6,
    cd0: 0.021,
    kInduced: 0.15,
    kHigh: 0.25,
    clHigh: 0.6,
    mCrit: 0.8,
    mWavePeak: 1.0,
    cdWave: 0.04, // big body, internal bays, not area-ruled: steep transonic drag rise
    cyBeta: -0.9,
    airbrakeCd: 0.05,
    maxG: 9,
    minG: -3,
    aoaLimit: 28 * DEG,
    rollRateMax: 210 * DEG,
    pitchRateMax: 28 * DEG,
    yawRateMax: 25 * DEG,
    rollTau: 0.13,
    pitchTau: 0.09,
    yawTau: 0.22,
    qFull: 9_000,
    tvc: false,
    departRoll: 1.4,
    departYaw: 0.6,
    maxMach: 1.6,
    maxMachSL: 1.1,
    ceiling: 15_240,
    cornerSpeed: 206, // ≈ 400 KIAS
    sustainedG: 7.2,
    rcs: 0.001,
    ir: 1.1,
  },
  mig29: {
    type: 'mig29',
    name: 'MiG-29 Fulcrum',
    emptyMass: 11_000,
    internalFuel: 3_500,
    wingArea: 38,
    span: 11.36,
    length: 17.3,
    radius: 9,
    baseStoresMass: 900, // 2× R-27 + 4× R-73 + pylons
    baseStoresCd: 0.004,
    engines: 2,
    thrustDry: 98_800, // 2× RD-33
    thrustAB: 162_800,
    hasAfterburner: true,
    ...AB_TURBOFAN,
    spoolUpTime: 4,
    abLightTime: 0.5,
    tsfcDry: 2.2e-5,
    tsfcAB: 5.8e-5,
    clAlpha: 3.6,
    alphaStall: 30 * DEG,
    clMax: 1.55,
    cd0: 0.02,
    kInduced: 0.13,
    kHigh: 0.22,
    clHigh: 0.6,
    mCrit: 0.88,
    mWavePeak: 1.1,
    cdWave: 0.026,
    cyBeta: -1.0,
    airbrakeCd: 0.05,
    maxG: 9,
    minG: -3,
    aoaLimit: 26 * DEG,
    rollRateMax: 240 * DEG,
    pitchRateMax: 25 * DEG,
    yawRateMax: 25 * DEG,
    rollTau: 0.12,
    pitchTau: 0.1,
    yawTau: 0.25,
    qFull: 8_500,
    tvc: false,
    departRoll: 2.0,
    departYaw: 0.9,
    maxMach: 2.25,
    maxMachSL: 1.25,
    ceiling: 18_000,
    cornerSpeed: 180,
    sustainedG: 7.5,
    rcs: 5,
    ir: 1.2,
  },
  su27: {
    type: 'su27',
    name: 'Su-27 Flanker',
    emptyMass: 16_380,
    internalFuel: 9_400,
    wingArea: 62,
    span: 14.7,
    length: 21.9,
    radius: 11,
    baseStoresMass: 1_300,
    baseStoresCd: 0.004,
    engines: 2,
    thrustDry: 149_000, // 2× AL-31F
    thrustAB: 245_000,
    hasAfterburner: true,
    ...AB_TURBOFAN,
    spoolUpTime: 4,
    abLightTime: 0.5,
    tsfcDry: 2.2e-5,
    tsfcAB: 5.4e-5,
    clAlpha: 3.8,
    alphaStall: 32 * DEG,
    clMax: 1.7,
    cd0: 0.02,
    kInduced: 0.12,
    kHigh: 0.2,
    clHigh: 0.65,
    mCrit: 0.88,
    mWavePeak: 1.1,
    cdWave: 0.024,
    cyBeta: -1.0,
    airbrakeCd: 0.06,
    maxG: 9,
    minG: -3,
    aoaLimit: 26 * DEG,
    rollRateMax: 250 * DEG,
    pitchRateMax: 25 * DEG,
    yawRateMax: 25 * DEG,
    rollTau: 0.13,
    pitchTau: 0.1,
    yawTau: 0.25,
    qFull: 8_500,
    tvc: false,
    departRoll: 1.6,
    departYaw: 0.7,
    maxMach: 2.35,
    maxMachSL: 1.2,
    ceiling: 19_000,
    cornerSpeed: 200,
    sustainedG: 7.8,
    rcs: 15,
    ir: 1.4,
  },
  su35: {
    type: 'su35',
    name: 'Su-35 Flanker-E',
    emptyMass: 18_400,
    internalFuel: 11_500,
    wingArea: 62,
    span: 14.75,
    length: 21.9,
    radius: 11,
    baseStoresMass: 1_300,
    baseStoresCd: 0.004,
    engines: 2,
    thrustDry: 172_600, // 2× AL-41F1S
    thrustAB: 284_400,
    hasAfterburner: true,
    ...AB_TURBOFAN,
    spoolUpTime: 3.8,
    abLightTime: 0.5,
    tsfcDry: 2.1e-5,
    tsfcAB: 5.3e-5,
    clAlpha: 3.8,
    alphaStall: 34 * DEG,
    clMax: 1.75,
    cd0: 0.02,
    kInduced: 0.12,
    kHigh: 0.2,
    clHigh: 0.65,
    mCrit: 0.88,
    mWavePeak: 1.1,
    cdWave: 0.024,
    cyBeta: -1.0,
    airbrakeCd: 0.06,
    maxG: 9,
    minG: -3,
    aoaLimit: 32 * DEG, // thrust vectoring
    rollRateMax: 270 * DEG,
    pitchRateMax: 45 * DEG,
    yawRateMax: 35 * DEG,
    rollTau: 0.12,
    pitchTau: 0.08,
    yawTau: 0.2,
    qFull: 8_500,
    tvc: true,
    departRoll: 1.2,
    departYaw: 0.5,
    maxMach: 2.25,
    maxMachSL: 1.2,
    ceiling: 18_000,
    cornerSpeed: 190,
    sustainedG: 8,
    rcs: 3,
    ir: 1.4,
  },
  su57: {
    type: 'su57',
    name: 'Su-57 Felon',
    emptyMass: 18_000,
    internalFuel: 10_300,
    wingArea: 78.8,
    span: 14.1,
    length: 20.1,
    radius: 11,
    baseStoresMass: 700, // internal bays
    baseStoresCd: 0,
    engines: 2,
    thrustDry: 176_600, // 2× AL-41F1
    thrustAB: 284_000,
    hasAfterburner: true,
    ...AB_TURBOFAN,
    spoolUpTime: 3.6,
    abLightTime: 0.45,
    tsfcDry: 2.0e-5,
    tsfcAB: 5.2e-5,
    clAlpha: 3.9,
    alphaStall: 36 * DEG,
    clMax: 1.8,
    cd0: 0.019,
    kInduced: 0.13,
    kHigh: 0.2,
    clHigh: 0.65,
    mCrit: 0.9,
    mWavePeak: 1.1,
    cdWave: 0.02, // supercruise capable
    cyBeta: -0.9,
    airbrakeCd: 0.05,
    maxG: 9,
    minG: -3.5,
    aoaLimit: 35 * DEG,
    rollRateMax: 270 * DEG,
    pitchRateMax: 50 * DEG,
    yawRateMax: 35 * DEG,
    rollTau: 0.12,
    pitchTau: 0.08,
    yawTau: 0.2,
    qFull: 8_000,
    tvc: true,
    departRoll: 1.0,
    departYaw: 0.45,
    maxMach: 2.0,
    maxMachSL: 1.2,
    ceiling: 20_000,
    cornerSpeed: 185,
    sustainedG: 8,
    rcs: 0.1,
    ir: 1.2,
  },
  a320: {
    type: 'a320',
    name: 'Airbus A320neo',
    emptyMass: 44_300,
    internalFuel: 19_000,
    wingArea: 122.6,
    span: 35.8,
    length: 37.6,
    radius: 19,
    baseStoresMass: 0,
    baseStoresCd: 0,
    engines: 2,
    thrustDry: 240_000, // 2× CFM LEAP-1A
    thrustAB: 240_000,
    hasAfterburner: false,
    dryLapse: 0.8,
    dryRam: -0.1,
    dryCap: 1.0,
    abLapse: 0.8,
    abRam: -0.1,
    abCap: 1.0,
    spoolUpTime: 6,
    abLightTime: 1,
    tsfcDry: 1.4e-5,
    tsfcAB: 1.4e-5,
    clAlpha: 5.0,
    alphaStall: 16 * DEG,
    clMax: 1.3,
    cd0: 0.022,
    kInduced: 0.04,
    kHigh: 0.1,
    clHigh: 0.9,
    mCrit: 0.76,
    mWavePeak: 0.95,
    cdWave: 0.06,
    cyBeta: -0.7,
    airbrakeCd: 0.03,
    maxG: 2.5,
    minG: -0.5,
    aoaLimit: 12 * DEG,
    rollRateMax: 30 * DEG,
    pitchRateMax: 5 * DEG,
    yawRateMax: 5 * DEG,
    rollTau: 0.8,
    pitchTau: 0.6,
    yawTau: 1.0,
    qFull: 10_000,
    tvc: false,
    departRoll: 0.5,
    departYaw: 0.25,
    maxMach: 0.82,
    maxMachSL: 0.65,
    ceiling: 12_000,
    cornerSpeed: 200,
    sustainedG: 1.8,
    rcs: 40,
    ir: 1.8,
  },
  // HESA Shahed-136: scripted one-way flight while alive (sim/drone/oneWay.ts); these numbers only
  // fly the falling wreck once it is shot down, and give its size, RCS and IR signature.
  shahed136: {
    type: 'shahed136',
    name: 'HESA Shahed-136',
    emptyMass: 160,
    internalFuel: 40,
    wingArea: 3.0,
    span: 2.5,
    length: 3.5,
    radius: 2.2,
    baseStoresMass: 0,
    baseStoresCd: 0,
    engines: 1,
    thrustDry: 900, // MD-550 pusher piston engine + propeller (~50 hp)
    thrustAB: 900,
    hasAfterburner: false,
    dryLapse: 0.8,
    dryRam: -0.3,
    dryCap: 1.0,
    abLapse: 0.8,
    abRam: -0.3,
    abCap: 1.0,
    spoolUpTime: 1,
    abLightTime: 1,
    tsfcDry: 2.0e-5,
    tsfcAB: 2.0e-5,
    clAlpha: 3.5,
    alphaStall: 20 * DEG,
    clMax: 1.0,
    cd0: 0.03,
    kInduced: 0.12,
    kHigh: 0.15,
    clHigh: 0.8,
    mCrit: 0.5,
    mWavePeak: 0.8,
    cdWave: 0.05,
    cyBeta: -0.5,
    airbrakeCd: 0.02,
    maxG: 3,
    minG: -1,
    aoaLimit: 15 * DEG,
    rollRateMax: 40 * DEG,
    pitchRateMax: 10 * DEG,
    yawRateMax: 10 * DEG,
    rollTau: 0.5,
    pitchTau: 0.5,
    yawTau: 0.8,
    qFull: 1_500,
    tvc: false,
    departRoll: 0.5,
    departYaw: 0.25,
    maxMach: 0.25,
    maxMachSL: 0.2,
    ceiling: 4_000,
    cornerSpeed: 50,
    sustainedG: 1.5,
    rcs: 0.1,
    ir: 0.2,
  },
  aw169: helicopter('aw169', 'Leonardo AW169', 3_000, 14.6, 12.1, 8, 0.35),
  bell429: helicopter('bell429', 'Bell 429 GlobalRanger', 2_000, 13.1, 11.0, 5, 0.3),
  h130: helicopter('h130', 'Airbus H130', 1_450, 12.6, 10.7, 3, 0.2),
};

/** Compute the derived lift-curve and fuel constants. */
function derive(p: PerfInput): AircraftPerf {
  const as = p.alphaStall;
  // Lift curve: linear to a1, then a quadratic rounding that peaks at (alphaStall, clMax)
  // with matching slope at a1  =>  clMax = clα·(as + a1)/2.
  let a1 = (2 * p.clMax) / p.clAlpha - as;
  a1 = Math.min(0.92 * as, Math.max(0.3 * as, a1));
  const clMaxEff = (p.clAlpha * (as + a1)) / 2;
  const cQuad = p.clAlpha / (2 * (as - a1));
  const asN = 0.55 * as;
  const a1N = 0.6 * asN;
  const clMaxNeg = (p.clAlpha * (asN + a1N)) / 2;
  const cQuadNeg = p.clAlpha / (2 * (asN - a1N));
  const tsfcAbIncrement = p.hasAfterburner
    ? (p.thrustAB * p.tsfcAB - p.thrustDry * p.tsfcDry) / Math.max(1, p.thrustAB - p.thrustDry)
    : p.tsfcDry;
  return {
    ...p,
    a1,
    cQuad,
    clMaxEff,
    alphaStallNeg: asN,
    a1Neg: a1N,
    cQuadNeg,
    clMaxNeg,
    aspect: (p.span * p.span) / p.wingArea,
    tsfcAbIncrement,
  };
}

/** Performance data for every aircraft type (read-only for other modules). */
export const AIRCRAFT_PERF: Readonly<Record<AircraftType, AircraftPerf>> = {
  f35a: derive(RAW.f35a),
  mig29: derive(RAW.mig29),
  su27: derive(RAW.su27),
  su35: derive(RAW.su35),
  su57: derive(RAW.su57),
  a320: derive(RAW.a320),
  shahed136: derive(RAW.shahed136),
  aw169: derive(RAW.aw169),
  bell429: derive(RAW.bell429),
  h130: derive(RAW.h130),
};
