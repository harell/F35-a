/**
 * F35-A — flight-performance helpers for AI pilots, HUD cues and missions (SIM-CORE).
 *
 * All functions read the aircraft's current state (mass, speed, altitude, stores, damage) and
 * are allocation free unless an `out` object is omitted.
 *
 * Stick → g mapping of the (assisted) FBW, used by every AI jet:
 *   pitch ≥ 0 : g = n0 + pitch·(gMax − n0)      pitch < 0 : g = n0 − pitch·(gMin − n0)
 *   n0 (neutral stick) = cosγ / cos(bank) for bank ≤ 60° (level turn / flight-path hold) in
 *   near-level flight, 1/cos(bank) in steep climbs/dives, fading to 1 g beyond ~100° of bank.
 *   AoA limiting caps what is achievable at low speed.
 * Roll stick is a roll-rate command (full stick ≈ perf.rollRateMax at q̄ ≥ perf.qFull).
 */
import { atmosphere, type AtmosphereSample } from '../../core/atmosphere';
import { G } from '../../core/math';
import type { AircraftEntity } from '../entities';
import { AIRCRAFT_PERF, type AircraftPerf } from './aircraftData';
import { dragCoefficient, liftCoefficient, thrustMax, thrustMil } from './aero';
import { alphaLimits, gLimits, neutralStickG } from './controlLaws';
import { massOf } from './FlightModel';

const ATM: AtmosphereSample = { temperature: 288, pressure: 101325, density: 1.225, speedOfSound: 340, sigma: 1 };
const _gl = { max: 9, min: -3 };
const _al = { max: 0.5, min: -0.2 };

/** Performance record of an aircraft. */
export function perfOf(ac: AircraftEntity): AircraftPerf {
  return ac.sim?.perf ?? AIRCRAFT_PERF[ac.type];
}

function heavyExternal(ac: AircraftEntity): number {
  let n = 0;
  for (let i = 0; i < ac.stores.length; i++) {
    const s = ac.stores[i];
    if (!s.internal && s.weapon === 'gbu31') n += s.count;
  }
  return n;
}

/** FBW g limits (assisted law) for this jet right now (stores, hydraulic damage). */
export function gLimitsOf(ac: AircraftEntity, out = { max: 9, min: -3 }): { max: number; min: number } {
  return gLimits(perfOf(ac), heavyExternal(ac), ac.damage.hydraulics, true, out);
}

/** Load factor commanded by a neutral stick in the current attitude (assisted law). */
export function neutralG(ac: AircraftEntity): number {
  const V = ac.velocity.length();
  const gamma = V > 1 ? Math.asin(Math.max(-1, Math.min(1, ac.velocity.y / V))) : 0;
  const bank = ac.flight.roll;
  return neutralStickG(gamma, Math.cos(bank), bank, true);
}

/** Stick deflection (−1..1) that commands load factor `g` (assisted law). */
export function stickForG(ac: AircraftEntity, g: number): number {
  const n0 = neutralG(ac);
  const lim = gLimitsOf(ac, _gl);
  let s: number;
  if (g >= n0) s = (g - n0) / Math.max(1e-3, lim.max - n0);
  else s = (n0 - g) / Math.min(-1e-3, lim.min - n0);
  return s > 1 ? 1 : s < -1 ? -1 : s;
}

/** Max instantaneous load factor available now: AoA-limited lift, capped by the g limit. */
export function availableG(ac: AircraftEntity): number {
  const perf = perfOf(ac);
  const f = ac.flight;
  const qbar = 0.5 * 1.225 * f.ias * f.ias;
  const al = alphaLimits(perf, true, _al);
  const n = (qbar * perf.wingArea * liftCoefficient(perf, al.max, f.mach)) / (massOf(ac) * G);
  return Math.min(n, gLimitsOf(ac, _gl).max);
}

/** 1 g stall (AoA-limit) speed, IAS m/s, at the current mass. */
export function stallSpeedIas(ac: AircraftEntity, g = 1): number {
  const perf = perfOf(ac);
  const al = alphaLimits(perf, true, _al);
  const cl = liftCoefficient(perf, al.max, Math.min(0.5, ac.flight.mach));
  return Math.sqrt((2 * g * massOf(ac) * G) / (1.225 * perf.wingArea * cl));
}

/** Corner speed (IAS, m/s): slowest speed at which the full g limit is available. */
export function cornerSpeedIas(ac: AircraftEntity): number {
  return stallSpeedIas(ac, gLimitsOf(ac, _gl).max);
}

/**
 * Specific excess power Ps (m/s) at load factor n, current speed/altitude, with MIL or max
 * afterburner thrust. Ps > 0: the jet can gain energy (climb/accelerate) while pulling n.
 */
export function specificExcessPower(ac: AircraftEntity, n: number, afterburner: boolean): number {
  const perf = perfOf(ac);
  const V = ac.velocity.length();
  if (V < 1) return 0;
  atmosphere(ac.position.y, ATM);
  const mach = V / ATM.speedOfSound;
  const W = massOf(ac) * G;
  const qS = 0.5 * ATM.density * V * V * perf.wingArea;
  const cl = (n * W) / Math.max(1, qS);
  const cd = dragCoefficient(perf, 0.1, 0, cl, mach, perf.baseStoresCd);
  const T = afterburner ? thrustMax(perf, ac.position.y, ATM.sigma, mach) : thrustMil(perf, ac.position.y, ATM.sigma, mach);
  return (V * (T - cd * qS)) / W;
}

/** Level-turn rate (rad/s) at load factor n and the current true airspeed. */
export function turnRate(ac: AircraftEntity, n: number): number {
  const V = Math.max(30, ac.velocity.length());
  return n > 1 ? (G * Math.sqrt(n * n - 1)) / V : 0;
}

/** Level-turn radius (m) at load factor n and the current true airspeed. */
export function turnRadius(ac: AircraftEntity, n: number): number {
  const V = ac.velocity.length();
  return n > 1 ? (V * V) / (G * Math.sqrt(n * n - 1)) : Infinity;
}
