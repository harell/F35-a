/**
 * F35-A — target signatures (radar cross-section, infra-red) and radar performance tables.
 *
 * Radar equation: detection range R ∝ σ^¼. For gameplay the exponent is softened to
 * RCS_EXPONENT (0.16) so stealth is decisive but not absolute: a clean F-35 (0.001 m² frontal)
 * is detected at ~25 % of the range of a 5 m² fighter, beast mode (×40 stores) at ~45 %.
 */
import { Vector3 } from 'three';
import type { AircraftType } from '../../core/types';
import { clamp, smoothstep } from '../../core/math';
import type { AircraftEntity } from '../entities';

/** Reference target RCS for all quoted radar ranges (m²). */
export const REF_RCS = 5;
/** Softened radar-equation exponent (true physics: 0.25). */
export const RCS_EXPONENT = 0.16;

/** Default frontal RCS (m²) by type — used when the spawner left AircraftEntity.rcsBase at its default. */
export const TYPE_RCS: Record<AircraftType, number> = {
  f35a: 0.001,
  mig29: 5,
  su27: 10,
  su35: 6,
  su57: 0.1,
  a320: 40,
  // Shahed-136: 2.5 m composite delta wing; small, but not LO-shaped (see isStealthy)
  shahed136: 0.1,
  // civil helicopters: metal fuselage and a big rotor head (≈ 3–8 m²)
  aw169: 8,
  bell429: 5,
  h130: 3,
};

/** Default IR signature scale by type (1 = typical fighter at MIL power). */
export const TYPE_IR: Record<AircraftType, number> = {
  f35a: 0.75,
  mig29: 1.1,
  su27: 1.2,
  su35: 1.2,
  su57: 0.9,
  a320: 1.8,
  // a ~50 hp pusher piston engine: small, but enough for an AIM-9X inside a few km
  shahed136: 0.2,
  // turboshafts with exhaust shrouds: a fraction of a jet's plume
  aw169: 0.35,
  bell429: 0.3,
  h130: 0.2,
};

export interface FighterRadarSpec {
  /** Detection range vs 5 m² (m). 0 = no fire-control radar. */
  range: number;
  /** Half-angle of the scan/gimbal cone (rad). */
  gimbal: number;
  /** Low-probability-of-intercept waveform: enemy RWRs only hear the search mode close in. */
  lpi: boolean;
  /** Infra-red search & track range vs IR intensity 1 (m); 0 = none. */
  irst: number;
  /** 0..1 resistance of the radar's tracker to a sustained Doppler notch (see weapons/ew.ts). */
  notchResistance: number;
}

const DEG = Math.PI / 180;

/**
 * Fire-control radars. APG-81 reference 60 km; the enemy's are weaker. IRST ranges are the
 * gameplay-compressed (~45 %) OLS figures vs a fighter's tail at MIL (irIntensity 1): a clean
 * F-35 at MIL is seen by a MiG-29 IRST only inside ~7 km head-on, but ~13 km in afterburner.
 */
export const FIGHTER_RADAR: Record<AircraftType, FighterRadarSpec> = {
  f35a: { range: 60_000, gimbal: 60 * DEG, lpi: true, irst: 0, notchResistance: 0.7 },
  mig29: { range: 35_000, gimbal: 60 * DEG, lpi: false, irst: 12_000, notchResistance: 0.3 },
  su27: { range: 45_000, gimbal: 60 * DEG, lpi: false, irst: 13_000, notchResistance: 0.4 },
  su35: { range: 55_000, gimbal: 60 * DEG, lpi: false, irst: 16_000, notchResistance: 0.55 },
  su57: { range: 55_000, gimbal: 60 * DEG, lpi: true, irst: 16_000, notchResistance: 0.6 },
  // airliner: weather radar only, no fire control
  a320: { range: 0, gimbal: 0, lpi: false, irst: 0, notchResistance: 0 },
  // one-way attack drone: no radar at all (nothing on the RWR)
  shahed136: { range: 0, gimbal: 0, lpi: false, irst: 0, notchResistance: 0 },
  // civil helicopters: weather radar at most
  aw169: { range: 0, gimbal: 0, lpi: false, irst: 0, notchResistance: 0 },
  bell429: { range: 0, gimbal: 0, lpi: false, irst: 0, notchResistance: 0 },
  h130: { range: 0, gimbal: 0, lpi: false, irst: 0, notchResistance: 0 },
};

export function isStealthy(ac: AircraftEntity): boolean {
  // the Shahed-136 is small, not low-observable: no LO shaping (beam/rear multipliers, FCR factor)
  return ac.rcsBase < 0.5 && ac.type !== 'shahed136';
}

/**
 * Airborne X-band fire-control radars vs low-observable shaping: a CLEAN stealth jet (internal
 * stores only, bay doors shut) is detected at a fraction of the radar-equation range — the
 * softened RCS exponent under-rates how hard a fighter radar's scan finds a 0.001 m² target.
 * How much of the radar's potential the crew gets out of it grows with the enemy's training
 * (difficulty.aiSkill): LO_FCR_FACTOR + LO_FCR_SKILL × aiSkill ≈ 0.76 (Recruit) … 0.84 (Veteran).
 * Clean F-35A head-on vs a MiG-29: ≈ 6.9 km (Recruit) … 7.6 km (Veteran); Su-35 / Su-57 ≈ 10.8 … 11.9 km
 * — inside the F-35's SHOOT range, so a disciplined (STT / TWS / EMCON, no afterburner) F-35
 * typically gets the first shot. Beast mode (external pylons) and an open weapon bay lose the
 * bonus: MiG-29 ≈ 16 km, Su-35 ≈ 25 km. Ground radars (SAM / EWR, VHF) are not affected; the
 * F-35's own radar vs a Su-57 uses the base factor.
 */
export const LO_FCR_FACTOR = 0.72;
export const LO_FCR_SKILL = 0.16;
export function fcrStealthFactor(ac: AircraftEntity, observerSkill = 0.2): number {
  if (!isStealthy(ac) || (ac.rcsMultiplier ?? 1) > 1.5 || ac.bayDoors > 0.05) return 1;
  return LO_FCR_FACTOR + LO_FCR_SKILL * Math.max(0, Math.min(1, observerSkill));
}

/** Radar-equation range factor for an RCS (1 at 5 m²). */
export function rcsRangeFactor(sigma: number): number {
  return Math.pow(Math.max(sigma, 1e-6) / REF_RCS, RCS_EXPONENT);
}

const _f = new Vector3();
const _u = new Vector3();
const _d = new Vector3();

/**
 * Aspect-dependent RCS of an aircraft as seen from `from` (m²), including external stores
 * (rcsMultiplier) and open weapon-bay doors (×10).
 * Stealth shaping: front sector lowest, beam ×14, rear ×5. Conventional jets: beam ×3.5, rear ×1.6.
 */
export function aircraftRcs(ac: AircraftEntity, from: Vector3): number {
  _d.subVectors(from, ac.position);
  const len = _d.length();
  if (len < 1e-3) return ac.rcsBase;
  _d.divideScalar(len);
  _f.set(0, 0, -1).applyQuaternion(ac.quaternion);
  _u.set(0, 1, 0).applyQuaternion(ac.quaternion);
  const c = _f.dot(_d); // +1 observer ahead, -1 observer behind
  const front = smoothstep(c, 0.55, 0.85);
  const rear = smoothstep(-c, 0.6, 0.92);
  const stealth = isStealthy(ac);
  const side = stealth ? 14 : 3.5;
  const back = stealth ? 5 : 1.6;
  let mult = side + (back - side) * rear;
  mult = mult + (1 - mult) * front;
  // planform (seen from directly above/below) is larger
  mult *= 1 + 1.5 * Math.abs(_u.dot(_d)) * (stealth ? 2 : 1);
  const stores = ac.rcsMultiplier ?? 1;
  const bay = ac.bayDoors > 0.05 ? 1 + 9 * clamp(ac.bayDoors, 0, 1) : 1;
  return ac.rcsBase * mult * stores * bay;
}

/**
 * Infra-red intensity of an aircraft as seen from `from` (1 = fighter at MIL power, tail aspect).
 * Afterburner multiplies it ×3.5; the hot nozzle is hardest to see from the front.
 */
export function irIntensity(ac: AircraftEntity, from: Vector3): number {
  _d.subVectors(from, ac.position);
  const len = _d.length();
  _f.set(0, 0, -1).applyQuaternion(ac.quaternion);
  const c = len > 1e-3 ? _f.dot(_d) / len : 0; // +1 = seen from the front
  // tail 1.0 → beam 0.6 → front 0.3
  const aspect = c < 0 ? 0.6 + 0.4 * -c : 0.6 - 0.3 * c;
  const rpm = clamp(ac.flight.engineRpm || 0.8, 0.4, 1.05);
  const engine = 0.3 + 0.7 * rpm;
  const ab = 1 + 2.5 * clamp(ac.flight.afterburner, 0, 1);
  const skin = ac.flight.mach > 1.2 ? 1 + 0.3 * (ac.flight.mach - 1.2) : 1;
  return ac.irBase * aspect * engine * ab * skin;
}

/** Radial velocity (m/s) of a target relative to the ground clutter, along the observer→target LOS. */
export function radialVelocity(observer: Vector3, target: Vector3, targetVel: Vector3): number {
  _d.subVectors(target, observer);
  const len = _d.length();
  if (len < 1e-3) return 0;
  return targetVel.dot(_d) / len;
}
