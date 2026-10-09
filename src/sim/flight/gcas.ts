/**
 * F35-A — Automatic Ground Collision Avoidance System (Auto-GCAS), as fitted to the real
 * F-35 / F-16.
 *
 * Every 0.1 s the system predicts the trajectory of an automatic recovery — system latency at
 * the current load factor, roll-out to wings level (unloaded while inverted), then a 5 g pull
 * with a realistic g onset — against the terrain. When that recovery would only just clear the
 * ground it takes the controls: rolls wings level and pulls until the jet is climbing with a
 * clear predicted path, then hands control back. If 5 g is no longer enough it escalates to
 * the full g limit. If the pilot is already pulling harder than the recovery would, the
 * prediction uses the pilot's g and the system stays out of the way.
 *
 * On for friendly AI F-35s, and for the player's F-35 on Recruit only (DifficultyParams.autoGcas):
 * from Pilot up the player can fly into the ground.
 */
import { G } from '../../core/math';
import { AB_DETENT } from '../../core/types';
import type { TerrainQuery } from '../api';
import type { AircraftEntity } from '../entities';
import type { FlightEnv } from './env';
import type { AircraftSimState } from './state';
import { alphaLimits, type StickInput } from './controlLaws';
import { liftCoefficient } from './aero';

const DEG = Math.PI / 180;
const CHECK_INTERVAL = 0.1;
const MESSAGE_INTERVAL = 5;
/** Max prediction horizon (s) — long enough for a recovery from a vertical dive. */
const HORIZON = 20;
/** System latency before the fly-up starts (s). */
const LATENCY = 0.2;
/** g onset rate of the automatic pull (g/s). */
const ONSET = 10;
/** The fly-up captures (and the prediction assumes) this climb angle, steepened if needed. */
const CLIMB_ANGLE = 15 * DEG;
const MAX_CLIMB_ANGLE = 60 * DEG;
/** Always look at least this far ahead, even once the predicted path is climbing (s). */
const MIN_LOOKAHEAD = 6;

/** Is Auto-GCAS available on this aircraft right now? */
export function gcasAvailable(ac: AircraftEntity, env: FlightEnv): boolean {
  if (!ac.alive || ac.crashed || ac.damage.avionics >= 0.7 || ac.type !== 'f35a') return false;
  return ac.isPlayer ? env.difficulty.autoGcas : ac.team === 'blue';
}

/** Nominal recovery g. */
function recoveryG(st: AircraftSimState): number {
  return Math.min(5, st.perf.maxG * 0.6);
}

const _al = { max: 0.5, min: -0.2 };
/** Load factor the wing can deliver right now at the assisted AoA limit (g). */
function availableG(ac: AircraftEntity, st: AircraftSimState): number {
  const f = ac.flight;
  const qbar = 0.5 * 1.225 * f.ias * f.ias;
  const al = alphaLimits(st.perf, _al);
  const W = Math.max(1, f.mass) * G;
  return (qbar * st.perf.wingArea * liftCoefficient(st.perf, al.max, f.mach)) / W;
}

/** Time to roll close to wings level from the current bank (s), incl. latency. */
function rollTimeFor(ac: AircraftEntity, st: AircraftSimState): number {
  const roll = Math.abs(ac.flight.roll);
  const rate = st.perf.rollRateMax * 0.7;
  return LATENCY + (roll > 30 * DEG ? (roll - 20 * DEG) / rate : 0);
}

/**
 * Predicted minimum terrain clearance (m) of an automatic recovery flown from the current
 * state (point mass in the vertical plane, allocation free). Stops early once the clearance
 * drops below `stopBelow` or the flight path is recovered and well clear.
 */
export function predictRecoveryClearance(
  ac: AircraftEntity,
  terrain: TerrainQuery,
  nPull: number,
  tRoll: number,
  stopBelow = -Infinity,
  climbAngle = CLIMB_ANGLE,
): number {
  const vel = ac.velocity;
  let V = vel.length();
  if (V < 1) return ac.position.y - terrain.surfaceHeightAt(ac.position.x, ac.position.z);
  const V0 = V;
  let gamma = Math.asin(Math.max(-1, Math.min(1, vel.y / V)));
  let hx = vel.x;
  let hz = vel.z;
  let hl = Math.hypot(hx, hz);
  if (hl < 1e-3) {
    // Vertical: the pull carries the jet towards its canopy (body +Y).
    const q = ac.quaternion;
    hx = 2 * (q.x * q.y - q.w * q.z);
    hz = 2 * (q.y * q.z + q.w * q.x);
    hl = Math.hypot(hx, hz) || 1;
  }
  hx /= hl;
  hz /= hl;
  const roll0 = ac.flight.roll;
  const nNow = Math.max(-3, Math.min(9, ac.flight.gLoad));
  let x = ac.position.x;
  let y = ac.position.y;
  let z = ac.position.z;
  let minClr = y - terrain.surfaceHeightAt(x, z);
  let nPullStart = 1;
  const gammaCap = Math.max(climbAngle, gamma);
  let t = 0;
  while (t < HORIZON) {
    const dt = t < 4 ? 0.1 : 0.2;
    const cg = Math.cos(gamma);
    let gd: number;
    if (t < LATENCY) {
      // system latency: the jet keeps doing what the pilot is doing
      gd = (G / V) * (nNow * Math.cos(roll0) - cg);
    } else if (t < tRoll) {
      // rolling out: unloaded while inverted, light pull once near wings level
      const f = (t - LATENCY) / Math.max(1e-3, tRoll - LATENCY);
      const phi = roll0 * (1 - f);
      const n = Math.abs(phi) > 100 * DEG ? 0.3 : 1.5;
      gd = (G / V) * (n * Math.cos(phi) - cg);
      nPullStart = n;
    } else {
      const n = Math.min(nPull, nPullStart + ONSET * (t - tRoll));
      gd = (G / V) * (n - cg);
    }
    gamma += gd * dt;
    if (gamma > gammaCap) gamma = gammaCap;
    // gravity along the path (≈70 % net of drag) changes the speed → bigger radius in a dive
    V = Math.max(0.6 * V0, Math.min(1.35 * V0, V - 0.7 * G * Math.sin(gamma) * dt));
    const c = Math.cos(gamma);
    x += V * c * hx * dt;
    z += V * c * hz * dt;
    y += V * Math.sin(gamma) * dt;
    t += dt;
    const clr = y - terrain.surfaceHeightAt(x, z);
    if (clr < minClr) minClr = clr;
    if (minClr < stopBelow) break;
    if (t > MIN_LOOKAHEAD && t > tRoll && gamma > 3 * DEG && clr > 200) break;
  }
  return minClr;
}

/**
 * Engage / disengage the system (called once per world step before the flight sub-steps).
 * Uses `ac.flight` from the previous step (roll, gLoad, agl).
 */
export function updateGcas(ac: AircraftEntity, st: AircraftSimState, env: FlightEnv, dt: number): void {
  st.gcasEnabled = gcasAvailable(ac, env);
  if (!st.gcasEnabled) {
    st.gcasActive = false;
    ac.gcasActive = false;
    return;
  }
  ac.gcasActive = st.gcasActive;
  if (st.gcasActive) st.gcasTime += dt;
  st.gcasCheckTimer -= dt;
  if (st.gcasCheckTimer > 0) return;
  st.gcasCheckTimer = CHECK_INTERVAL;

  const V = ac.velocity.length();
  const nAvail = availableG(ac, st);
  const nRec = Math.max(1.2, Math.min(recoveryG(st), nAvail));
  const buffer = 15 + 0.05 * V;
  if (st.gcasActive) {
    // Escalate to a max-performance pull / steeper fly-up if the recovery no longer clears.
    const clr5 = predictRecoveryClearance(ac, env.terrain, nRec, rollTimeFor(ac, st), 0, st.gcasClimb);
    if (clr5 < buffer * 0.5) st.gcasG = st.perf.maxG; // max-performance recovery (latched)
    // (a steeper fly-up only helps once the flight path is already above the horizon)
    if (clr5 < buffer && ac.velocity.y > 0) st.gcasClimb = Math.min(MAX_CLIMB_ANGLE, st.gcasClimb + 5 * DEG);
    const climbing = ac.velocity.y > Math.sin(2 * DEG) * V;
    // Release only once established (not still pulling hard) and if simply holding the current
    // flight path — what the assisted law will do after hand-back — clears the terrain.
    const settled = ac.flight.gLoad < 3.5 && Math.abs(ac.flight.roll) < 20 * DEG;
    const clrHold = climbing && settled && st.gcasTime > 1.2 ? predictRecoveryClearance(ac, env.terrain, 1, 0, 0, 0) : 0;
    if ((clrHold > 100 && clr5 > 100) || st.gcasTime > 15 || V < 40) {
      st.gcasActive = false;
      ac.gcasActive = false;
      // Hand back in a steady climb: the assisted law holds the current flight path.
      st.gammaHold = true;
      st.gammaRef = Math.asin(Math.max(-1, Math.min(1, ac.velocity.y / Math.max(1, V))));
      st.neutralTime = 1;
    }
    return;
  }

  if (V < 60) return;
  const agl = ac.flight.agl;
  if (agl > 1500 + Math.max(0, -ac.velocity.y) * 12) return; // nothing to hit any time soon
  // "Already recovering": if the pilot pulls harder than the system would, predict with that.
  const wingsLevel = Math.abs(ac.flight.roll) < 30 * DEG;
  const nPull = wingsLevel ? Math.max(nRec, Math.min(nAvail, ac.flight.gLoad)) : nRec;
  const clr = predictRecoveryClearance(ac, env.terrain, nPull, rollTimeFor(ac, st), buffer - 1);
  if (clr < buffer) {
    st.gcasActive = true;
    st.gcasTime = 0;
    st.gcasG = clr < 0 ? st.perf.maxG : recoveryG(st);
    st.gcasClimb = CLIMB_ANGLE;
    ac.gcasActive = true;
    if (ac.isPlayer && env.events && env.time - st.gcasLastMessage > MESSAGE_INTERVAL) {
      st.gcasLastMessage = env.time;
      env.events.emit('hud:message', { text: 'AUTO GCAS', duration: 2, tone: 'warn' });
    }
  }
}

/**
 * Replace the pilot's stick with the recovery commands while the system is active.
 * Returns the throttle to use.
 */
export function applyGcasOverride(ac: AircraftEntity, st: AircraftSimState, stick: StickInput, throttle: number, roll: number): number {
  const r = -roll * 2.5;
  stick.roll = r > 1 ? 1 : r < -1 ? -1 : r;
  stick.yaw = 0;
  stick.pitch = 0;
  const absRoll = Math.abs(roll);
  const V = ac.velocity.length();
  const gamma = V > 1 ? Math.asin(Math.max(-1, Math.min(1, ac.velocity.y / V))) : 0;
  let nz = absRoll < 60 * DEG ? st.gcasG : absRoll > 100 * DEG ? 0.3 : 1.5;
  const climb = st.gcasClimb;
  if (absRoll < 60 * DEG && gamma > climb - 8 * DEG) {
    // capture the fly-up climb angle instead of looping
    const f = Math.min(1, (gamma - (climb - 8 * DEG)) / (8 * DEG));
    nz = nz + (Math.cos(gamma) - 0.3 * (gamma - climb) * (V / G) - nz) * f;
  }
  stick.nzOverride = nz;
  return V < 170 ? Math.max(throttle, AB_DETENT) : throttle;
}
