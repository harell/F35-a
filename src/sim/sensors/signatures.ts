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
  tu22m: 40,
  a50: 60,
};

/** Default IR signature scale by type (1 = typical fighter at MIL power). */
export const TYPE_IR: Record<AircraftType, number> = {
  f35a: 0.75,
  mig29: 1.1,
  su27: 1.2,
  su35: 1.2,
  su57: 0.9,
  tu22m: 2.5,
  a50: 2,
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
}

const DEG = Math.PI / 180;

/** Fire-control radars. APG-81 reference 60 km; the enemy's are weaker. */
export const FIGHTER_RADAR: Record<AircraftType, FighterRadarSpec> = {
  f35a: { range: 60_000, gimbal: 60 * DEG, lpi: true, irst: 0 },
  mig29: { range: 35_000, gimbal: 60 * DEG, lpi: false, irst: 15_000 },
  su27: { range: 45_000, gimbal: 60 * DEG, lpi: false, irst: 16_000 },
  su35: { range: 55_000, gimbal: 60 * DEG, lpi: false, irst: 20_000 },
  su57: { range: 55_000, gimbal: 60 * DEG, lpi: true, irst: 20_000 },
  tu22m: { range: 0, gimbal: 0, lpi: false, irst: 0 },
  // A-50 AEW&C: 360° rotodome, strong look-down radar (feeds the red datalink)
  a50: { range: 110_000, gimbal: Math.PI, lpi: false, irst: 0 },
};

/** Early-warning radar (ground, VHF): long range and better against stealth shaping. */
export const EWR_RANGE = 90_000;
/** VHF radars see stealth jets much better than X-band fire-control radars. */
export const EWR_STEALTH_BONUS = 25;

export function isStealthy(ac: AircraftEntity): boolean {
  return ac.rcsBase < 0.5;
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
