/**
 * F35-A — engine model (SIM-CORE): spool dynamics, afterburner light-off, thrust lapse,
 * fuel flow (TSFC), flameout. Allocation free.
 */
import { AB_DETENT } from '../../core/types';
import type { AircraftEntity } from '../entities';
import type { AircraftSimState } from './state';
import { IDLE_THRUST_FRACTION, thrustMax, thrustMil } from './aero';

/** Fuel lost per second by a fully leaking tank (kg/s). */
const MAX_LEAK_RATE = 4;
/** AI jets never burn below this fraction of internal fuel (they are not fuel-managed). */
const AI_FUEL_FLOOR = 0.05;
/** AI fuel burn multiplier. */
const AI_FUEL_SCALE = 0.6;

export interface EngineOutput {
  /** Net thrust along the body axis (N). */
  thrust: number;
  /** Actual fuel flow (kg/s, incl. leaks, after difficulty scaling). */
  fuelFlow: number;
}

const out: EngineOutput = { thrust: 0, fuelFlow: 0 };

/**
 * Advance the engine by h seconds and burn fuel.
 * @param throttle lever 0..1 (see AB_DETENT)
 * @param fuelScale difficulty fuel burn multiplier (player) — AI uses its own
 */
export function updateEngine(
  ac: AircraftEntity,
  st: AircraftSimState,
  h: number,
  throttle: number,
  altitude: number,
  sigma: number,
  mach: number,
  tas: number,
  fuelScale: number,
): EngineOutput {
  const perf = st.perf;
  const f = ac.flight;
  const engDmg = ac.damage.engine;

  if (f.fuel <= 0) {
    f.fuel = 0;
    st.fuelExhausted = true;
    st.flamedOut = true;
  }
  if (engDmg >= 0.9 || !ac.alive) st.flamedOut = true;

  const thr = throttle < 0 ? 0 : throttle > 1 ? 1 : throttle;
  const powerCmd = st.flamedOut ? 0 : Math.min(thr, AB_DETENT) / AB_DETENT;
  const abAllowed = !st.flamedOut && perf.hasAfterburner && engDmg < 0.5;
  const abCmd = abAllowed && thr > AB_DETENT + 0.002 ? (thr - AB_DETENT) / (1 - AB_DETENT) : 0;

  // Spool: slow at low power (idle → MIL ≈ perf.spoolUpTime), exponential tail near the target.
  const timeScale = 3.5 / perf.spoolUpTime;
  const e = powerCmd - st.power;
  if (e > 0) {
    const rate = (0.18 + 0.3 * st.power) * timeScale * (1 - 0.5 * engDmg);
    st.power += Math.min(e * 4, rate) * h;
  } else if (e < 0) {
    const rate = 0.55 * timeScale;
    st.power -= Math.min(-e * 4, rate) * h;
  }
  if (st.power < 0) st.power = 0;
  if (st.power > 1) st.power = 1;

  // Afterburner: needs the core at MIL, then lights after abLightTime.
  if (abCmd > 0 && st.power > 0.95) {
    st.abTimer += h;
    if (st.abTimer >= perf.abLightTime) st.abLit = true;
  } else {
    st.abTimer = 0;
    st.abLit = false;
  }
  const abTarget = st.abLit ? abCmd : 0;
  if (st.abLevel < abTarget) st.abLevel = Math.min(abTarget, st.abLevel + 2.5 * h);
  else st.abLevel = Math.max(abTarget, st.abLevel - 5 * h);

  // Thrust
  const tMil = thrustMil(perf, altitude, sigma, mach);
  const tMax = thrustMax(perf, altitude, sigma, mach);
  let tDry = tMil * (IDLE_THRUST_FRACTION + (1 - IDLE_THRUST_FRACTION) * st.power);
  let tAb = (tMax - tMil) * st.abLevel;
  if (st.flamedOut) {
    tDry = 0;
    tAb = 0;
  }
  const health = 1 - 0.8 * Math.min(1, engDmg);
  out.thrust = (tDry + tAb) * health;

  // Core rpm (display): flamed-out cores wind-mill down.
  if (st.flamedOut) {
    const windmill = 0.08 + 0.22 * Math.min(1, tas / 300);
    st.rpm += (windmill - st.rpm) * Math.min(1, 0.35 * h);
  } else {
    const target = 0.63 + 0.37 * Math.pow(st.power, 0.7) + 0.02 * st.abLevel;
    st.rpm += (target - st.rpm) * Math.min(1, 6 * h);
  }

  // Fuel flow (TSFC rises with Mach); the AB part uses its (much worse) incremental TSFC.
  let ff = 0;
  if (!st.flamedOut) ff = tDry * perf.tsfcDry * (1 + 0.25 * mach) + tAb * perf.tsfcAbIncrement;
  ff += Math.min(1, ac.damage.fuelLeak) * MAX_LEAK_RATE;
  const scale = ac.isPlayer ? fuelScale : AI_FUEL_SCALE;
  ff *= scale;
  if (ac.alive) {
    f.fuel -= ff * h;
    if (!ac.isPlayer) f.fuel = Math.max(f.fuel, AI_FUEL_FLOOR * perf.internalFuel);
    if (f.fuel <= 0) {
      f.fuel = 0;
      st.fuelExhausted = true;
      st.flamedOut = true;
    }
  }
  out.fuelFlow = ff;
  return out;
}

/** Throttle lever position that gives `thrust` in dry power (≥ AB_DETENT means AB needed). */
export function throttleForThrust(st: AircraftSimState, thrust: number, altitude: number, sigma: number, mach: number): number {
  const perf = st.perf;
  const tMil = thrustMil(perf, altitude, sigma, mach);
  if (tMil <= 0) return 1;
  const p = (thrust / tMil - IDLE_THRUST_FRACTION) / (1 - IDLE_THRUST_FRACTION);
  if (p <= 1) return Math.max(0, p) * AB_DETENT;
  const tMax = thrustMax(perf, altitude, sigma, mach);
  if (tMax <= tMil) return AB_DETENT;
  const ab = (thrust - tMil) / (tMax - tMil);
  return AB_DETENT + (1 - AB_DETENT) * Math.min(1, Math.max(0.02, ab));
}
