/**
 * F35-A — International Standard Atmosphere (ISA), valid 0–32 km (clamped beyond).
 * OWNERSHIP: orchestrator. Shared by flight model, missiles and sensors.
 */

const T0 = 288.15; // K
const P0 = 101_325; // Pa
const RHO0 = 1.225; // kg/m³
const L = 0.0065; // K/m troposphere lapse rate
const R = 287.05287; // J/(kg·K)
const GAMMA = 1.4;
const G0 = 9.80665;
const H_TROPO = 11_000;
const T_TROPO = T0 - L * H_TROPO; // 216.65 K
const P_TROPO = P0 * Math.pow(T_TROPO / T0, G0 / (L * R));

export interface AtmosphereSample {
  /** Temperature (K). */
  temperature: number;
  /** Static pressure (Pa). */
  pressure: number;
  /** Density (kg/m³). */
  density: number;
  /** Speed of sound (m/s). */
  speedOfSound: number;
  /** density / sea-level density. */
  sigma: number;
}

/** Sample the ISA at geometric altitude h (m MSL). Writes into `out` to avoid allocations. */
export function atmosphere(h: number, out: AtmosphereSample = { temperature: 0, pressure: 0, density: 0, speedOfSound: 0, sigma: 0 }): AtmosphereSample {
  const alt = Math.max(-500, Math.min(32_000, h));
  let T: number;
  let P: number;
  if (alt <= H_TROPO) {
    T = T0 - L * alt;
    P = P0 * Math.pow(T / T0, G0 / (L * R));
  } else {
    T = T_TROPO;
    P = P_TROPO * Math.exp((-G0 * (alt - H_TROPO)) / (R * T_TROPO));
  }
  const rho = P / (R * T);
  out.temperature = T;
  out.pressure = P;
  out.density = rho;
  out.speedOfSound = Math.sqrt(GAMMA * R * T);
  out.sigma = rho / RHO0;
  return out;
}

/** Air density only (kg/m³). */
export function airDensity(h: number): number {
  return atmosphere(h, _scratch).density;
}

/** Speed of sound only (m/s). */
export function speedOfSound(h: number): number {
  return atmosphere(h, _scratch).speedOfSound;
}

/** Equivalent/indicated airspeed from true airspeed (m/s). */
export function tasToIas(tas: number, h: number): number {
  return tas * Math.sqrt(atmosphere(h, _scratch).sigma);
}

export const SEA_LEVEL_DENSITY = RHO0;

const _scratch: AtmosphereSample = { temperature: 0, pressure: 0, density: 0, speedOfSound: 0, sigma: 0 };
