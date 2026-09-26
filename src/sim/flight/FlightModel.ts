/**
 * F35-A — 6-DOF-style flight model (SIM-CORE).
 *
 * Translational dynamics are fully force based (lift, drag, side force, thrust, gravity) in
 * world space; rotation is driven by the fly-by-wire control laws (./controlLaws.ts), which
 * command body rates that the airframe follows through first-order lags. α and β therefore
 * emerge from the kinematics, so energy bleed, stalls, zoom climbs and departures fall out of
 * the physics. Sub-stepped at FM_RATE_HZ (120 Hz); every aircraft (player, AI, wrecks) uses it.
 *
 * Conventions (core/types.ts): world +Y up, −Z north; body nose −Z, right wing +X;
 * rates (x=p roll, y=q pitch, z=r yaw) → local angular velocity (q, −r, −p).
 */
import { Quaternion, Vector3 } from 'three';
import { atmosphere, tasToIas, type AtmosphereSample } from '../../core/atmosphere';
import { G } from '../../core/math';
import { AB_DETENT } from '../../core/types';
import type { AircraftEntity } from '../entities';
import { createAirData } from './airdata';
import { PYLON_DRAG, STORE_DATA, GUN_ROUND_MASS } from './aircraftData';
import { alphaForLift, dragCoefficient, liftCoefficient, sstep, thrustMax, thrustMil, IDLE_THRUST_FRACTION } from './aero';
import { alphaLimits, gLimits, updateControlLaws, updateWreckRates, type ControlLaw, type StickInput } from './controlLaws';
import { throttleForThrust, updateEngine } from './engine';
import { FM_RATE_HZ, type FlightEnv } from './env';
import { applyGcasOverride, updateGcas } from './gcas';
import { updateGloc } from './gloc';
import { createSimState, type AircraftSimState } from './state';
import { hprFromAxes, setQuatFromHPR, type Hpr } from './attitude';

export type { FlightEnv } from './env';
export { FM_RATE_HZ } from './env';

/* ───────────── module scratch (no per-step allocations) ───────────── */
const ATM: AtmosphereSample = { temperature: 288, pressure: 101325, density: 1.225, speedOfSound: 340, sigma: 1 };
const AD = createAirData();
const _fwd = new Vector3();
const _up = new Vector3();
const _right = new Vector3();
const _vHat = new Vector3();
const _lift = new Vector3();
const _side = new Vector3();
const _sf = new Vector3();
const _omega = new Vector3();
const _dq = new Quaternion();
const _hpr: Hpr = { heading: 0, pitch: 0, roll: 0 };
const _stick: StickInput = { pitch: 0, roll: 0, yaw: 0, nzOverride: null };
const _lim = { max: 9, min: -3 };
const _stores = { mass: 0, cd: 0, ext: 0, heavy: 0 };

/** Get (or lazily create) the private sim state of an aircraft. */
export function ensureSimState(ac: AircraftEntity): AircraftSimState {
  let st = ac.sim;
  if (!st) {
    st = createSimState(ac.type, ac.id);
    ac.sim = st;
  }
  return st;
}

/**
 * Does the pilot fly with the convenience assists (neutral-stick flight-path hold, gentle buffet,
 * no G-LOC)? False only for the human player on the no-assist difficulty (Ace). The FBW g/AoA
 * limiters and Auto-GCAS are part of the F-35 and stay on regardless.
 */
export function isAssisted(ac: AircraftEntity, env: FlightEnv): boolean {
  return ac.isPlayer ? env.difficulty.flightAssist : true;
}

const LAW_ASSISTED: ControlLaw = { pathHold: true, buffetGain: 1 };
const LAW_NO_ASSIST: ControlLaw = { pathHold: false, buffetGain: 1.6 };
/** Control-law options for this aircraft. */
export function controlLawFor(ac: AircraftEntity, env: FlightEnv): ControlLaw {
  return isAssisted(ac, env) ? LAW_ASSISTED : LAW_NO_ASSIST;
}

/** Stores mass (kg) and drag increment for the current loadout. */
function storesOf(ac: AircraftEntity, st: AircraftSimState): typeof _stores {
  const perf = st.perf;
  let mass = 0;
  let cd = 0;
  let ext = 0;
  let heavy = 0;
  const stores = ac.stores;
  if (stores.length === 0) {
    mass = perf.baseStoresMass;
    cd = perf.baseStoresCd;
  }
  for (let i = 0; i < stores.length; i++) {
    const s = stores[i];
    const d = STORE_DATA[s.weapon];
    const m = d ? d.mass : 150;
    const drag = d ? d.dragExt : 0.001;
    mass += m * s.count;
    if (!s.internal) {
      ext++;
      cd += PYLON_DRAG + drag * s.count;
      if (s.weapon === 'gbu31') heavy += s.count;
    }
  }
  _stores.mass = mass + ac.gunAmmo * GUN_ROUND_MASS;
  _stores.cd = cd;
  _stores.ext = ext;
  _stores.heavy = heavy;
  return _stores;
}

/** Total mass (kg) incl. fuel and stores. */
export function massOf(ac: AircraftEntity): number {
  const st = ensureSimState(ac);
  return st.perf.emptyMass + Math.max(0, ac.flight.fuel) + storesOf(ac, st).mass;
}

/* ───────────────────────────── Trim / init ───────────────────────────── */

export interface FlightInitOptions {
  /** Heading (rad, 0 = north, clockwise). */
  heading: number;
  /** True airspeed (m/s). */
  speed: number;
  /** Fuel fraction of internal capacity (default: keep current fuel). */
  fuelFraction?: number;
  /** Flight path angle (rad, default 0 = level). */
  climb?: number;
}

/**
 * Initialise an aircraft in trimmed 1 g flight: attitude (pitch = flight path + trim AoA),
 * velocity, engine spooled to the trim thrust (afterburner lit if needed), FBW flight-path
 * hold engaged, and `input.throttle` set to the trim lever position.
 */
export function initFlight(ac: AircraftEntity, opts: FlightInitOptions, env: FlightEnv | null = null): void {
  const st = ensureSimState(ac);
  const perf = st.perf;
  const f = ac.flight;
  if (opts.fuelFraction !== undefined) f.fuel = perf.internalFuel * Math.max(0, Math.min(1, opts.fuelFraction));
  const speed = Math.max(0, opts.speed);
  const climb = opts.climb ?? 0;
  const alt = ac.position.y;
  atmosphere(alt, ATM);
  const mach = speed / ATM.speedOfSound;
  const stores = storesOf(ac, st);
  const mass = perf.emptyMass + f.fuel + stores.mass;
  const qS = Math.max(1, 0.5 * ATM.density * speed * speed * perf.wingArea);
  const W = mass * G;
  const al = alphaLimits(perf, { max: 0, min: 0 });
  let alpha = 0;
  let thrust = 0;
  for (let i = 0; i < 6; i++) {
    const cl = (W * Math.cos(climb) - thrust * Math.sin(alpha)) / qS;
    alpha = alphaForLift(perf, cl, mach, al.max, al.min);
    const cd = dragCoefficient(perf, alpha, 0, liftCoefficient(perf, alpha, mach), mach, stores.cd);
    thrust = (cd * qS + W * Math.sin(climb)) / Math.max(0.2, Math.cos(alpha));
  }
  setQuatFromHPR(ac.quaternion, opts.heading, climb + alpha, 0);
  const c = Math.cos(climb);
  ac.velocity.set(Math.sin(opts.heading) * c * speed, Math.sin(climb) * speed, -Math.cos(opts.heading) * c * speed);
  ac.rates.set(0, 0, 0);

  // Engine at trim thrust
  const throttle = throttleForThrust(st, thrust, alt, ATM.sigma, mach);
  ac.input.throttle = throttle;
  ac.prevInput.throttle = throttle;
  st.flamedOut = f.fuel <= 0;
  st.fuelExhausted = f.fuel <= 0;
  if (throttle > AB_DETENT) {
    st.power = 1;
    st.abLit = true;
    st.abTimer = perf.abLightTime;
    st.abLevel = (throttle - AB_DETENT) / (1 - AB_DETENT);
  } else {
    st.power = throttle / AB_DETENT;
    st.abLit = false;
    st.abLevel = 0;
  }
  st.rpm = 0.63 + 0.37 * Math.pow(st.power, 0.7);
  st.nzCmd = 1;
  st.gammaHold = true;
  st.gammaRef = climb;
  st.neutralTime = 1;
  st.departure = 0;
  st.departDir = 0;
  st.gcasActive = false;
  ac.gcasActive = false;
  st.specificForce.set(0, 1, 0).applyQuaternion(ac.quaternion).multiplyScalar(G);
  st.gBuckets.fill(1);

  // Publish a consistent flight state immediately (HUD / AI may read it before the first step).
  AD.V = speed;
  AD.alpha = alpha;
  AD.beta = 0;
  AD.mach = mach;
  AD.mass = mass;
  const tMil = thrustMil(perf, alt, ATM.sigma, mach);
  const tMax = thrustMax(perf, alt, ATM.sigma, mach);
  AD.thrust = st.flamedOut ? 0 : (IDLE_THRUST_FRACTION + (1 - IDLE_THRUST_FRACTION) * st.power) * tMil + st.abLevel * (tMax - tMil);
  f.gLoad = 1;
  f.gPeak = 1;
  f.fuelFlow = 0;
  writeOutputs(ac, st, env);
}

/* ───────────────────────────── Step ───────────────────────────── */

/**
 * Advance one aircraft by dt (sub-stepped at FM_RATE_HZ). Handles live jets (FBW, engine,
 * fuel, Auto-GCAS) and wrecks (tumbling ballistic fall). Crashed aircraft are frozen.
 */
export function stepFlight(ac: AircraftEntity, dt: number, env: FlightEnv): void {
  const st = ensureSimState(ac);
  if (ac.crashed || dt <= 0) {
    ac.gcasActive = false;
    return;
  }
  updateGloc(ac, st, env, dt);
  updateGcas(ac, st, env, dt);
  const n = Math.max(1, Math.ceil(dt * FM_RATE_HZ - 1e-6));
  const h = dt / n;
  const law = controlLawFor(ac, env);
  let gAbsMax = 0;
  for (let i = 0; i < n; i++) {
    const g = substep(ac, st, h, env, law);
    const ag = Math.abs(g);
    if (ag > gAbsMax) gAbsMax = ag;
  }
  // g peak over the last second (10 × 0.1 s buckets)
  const b = st.gBuckets;
  if (gAbsMax > b[st.gBucketIdx]) b[st.gBucketIdx] = gAbsMax;
  st.gBucketTime += dt;
  if (st.gBucketTime >= 0.1) {
    st.gBucketTime = 0;
    st.gBucketIdx = (st.gBucketIdx + 1) % b.length;
    b[st.gBucketIdx] = gAbsMax;
  }
  writeOutputs(ac, st, env);
}

/** One integration sub-step. Returns the pilot-felt normal load factor (g). */
function substep(ac: AircraftEntity, st: AircraftSimState, h: number, env: FlightEnv, law: ControlLaw): number {
  const perf = st.perf;
  const f = ac.flight;
  const pos = ac.position;
  const vel = ac.velocity;
  const q = ac.quaternion;
  const ad = AD;
  const alive = ac.alive;

  /* ── Air data ── */
  atmosphere(pos.y, ATM);
  const V = vel.length();
  _fwd.set(0, 0, -1).applyQuaternion(q);
  _up.set(0, 1, 0).applyQuaternion(q);
  _right.set(1, 0, 0).applyQuaternion(q);
  let alpha = 0;
  let beta = 0;
  if (V > 0.5) {
    const u = vel.dot(_fwd);
    const vu = vel.dot(_up);
    const vr = vel.dot(_right);
    alpha = Math.atan2(-vu, u);
    const sb = vr / V;
    beta = Math.asin(sb > 1 ? 1 : sb < -1 ? -1 : sb);
    _vHat.copy(vel).multiplyScalar(1 / V);
  } else {
    _vHat.copy(_fwd);
  }
  ad.V = V;
  ad.Vc = V > 25 ? V : 25;
  ad.alpha = alpha;
  ad.beta = beta;
  ad.mach = V / ATM.speedOfSound;
  ad.rho = ATM.density;
  ad.sigma = ATM.sigma;
  ad.qbar = 0.5 * ATM.density * V * V;
  ad.qS = ad.qbar * perf.wingArea;

  // Wind axes: lift ⟂ V in the body symmetry plane, side force completes the triad.
  _lift.crossVectors(_right, _vHat);
  const ll = _lift.length();
  if (ll < 1e-3) _lift.copy(_up);
  else _lift.multiplyScalar(1 / ll);
  _side.crossVectors(_vHat, _lift);

  // Flight path angle and bank of the lift vector about the velocity vector.
  const vy = _vHat.y > 1 ? 1 : _vHat.y < -1 ? -1 : _vHat.y;
  ad.gamma = Math.asin(vy);
  ad.cosGamma = Math.cos(ad.gamma);
  ad.liftUp = _lift.y;
  const hx = -_vHat.z;
  const hz = _vHat.x;
  const hl = Math.hypot(hx, hz);
  if (hl > 0.05) {
    const rx = hx / hl;
    const rz = hz / hl;
    const sinB = _lift.x * rx + _lift.z * rz;
    // vertical-plane up ⟂ V: (hR × vHat)
    const ux = -rz * _vHat.y;
    const uy = rz * _vHat.x - rx * _vHat.z;
    const uz = rx * _vHat.y;
    const cosB = _lift.x * ux + _lift.y * uy + _lift.z * uz;
    ad.bankW = Math.atan2(sinB, cosB);
  } else ad.bankW = 0;
  ad.cosBankW = Math.cos(ad.bankW);
  ad.gRight = -G * _right.y;

  /* ── Mass & stores ── */
  const stores = storesOf(ac, st);
  ad.mass = perf.emptyMass + Math.max(0, f.fuel) + stores.mass;
  ad.extStations = stores.ext;
  ad.heavyExternal = stores.heavy;

  /* ── Pilot / GCAS inputs ── */
  const inp = ac.input;
  let throttle = inp.throttle;
  // a G-LOC'd pilot's hand is off the stick (pilotAuthority ramps back after waking up)
  const pa = alive ? st.pilotAuthority : 0;
  _stick.pitch = clamp1(inp.pitch) * pa;
  _stick.roll = clamp1(inp.roll) * pa;
  _stick.yaw = clamp1(inp.yaw) * pa;
  _stick.nzOverride = null;
  if (alive && st.gcasActive) {
    hprFromAxes(_fwd, _up, _hpr);
    throttle = applyGcasOverride(ac, st, _stick, throttle, _hpr.roll);
  }
  if (!alive) throttle = 0;

  /* ── Engine ── */
  const eng = updateEngine(ac, st, h, throttle, pos.y, ATM.sigma, ad.mach, V, env.difficulty.fuelBurnScale);
  ad.thrust = eng.thrust;
  f.fuelFlow = eng.fuelFlow;

  /* ── Control authority (q̄; thrust vectoring keeps some at low speed) ── */
  let auth = ad.qbar / perf.qFull;
  if (perf.tvc && !st.flamedOut) auth = Math.max(auth, 0.55 * Math.min(1, ad.thrust / perf.thrustDry));
  ad.authority = auth > 1 ? 1 : auth < 0.06 ? 0.06 : auth;

  /* ── Rates ── */
  if (alive) updateControlLaws(ac, st, ad, h, law, _stick);
  else updateWreckRates(ac, st, h);

  const brakeTarget = alive && inp.airbrake ? 1 : 0;
  st.airbrake += Math.max(-1.5 * h, Math.min(1.2 * h, brakeTarget - st.airbrake));

  /* ── Aerodynamic forces ── */
  let cl = liftCoefficient(perf, alpha, ad.mach);
  if (!alive) cl *= 0.3; // broken airframe
  const cy = perf.cyBeta * Math.sin(beta);
  const cd = dragCoefficient(perf, alpha, beta, cl, ad.mach, stores.cd + st.airbrake * perf.airbrakeCd + (alive ? 0 : 0.3));
  const invM = 1 / ad.mass;
  _sf.copy(_lift).multiplyScalar(ad.qS * cl);
  _sf.addScaledVector(_vHat, -ad.qS * cd);
  _sf.addScaledVector(_side, ad.qS * cy);
  _sf.addScaledVector(_fwd, ad.thrust);
  _sf.multiplyScalar(invM);
  st.specificForce.copy(_sf);
  const gLoad = _sf.dot(_up) / G;

  /* ── Integrate translation (semi-implicit Euler) ── */
  vel.addScaledVector(_sf, h);
  vel.y -= G * h;
  pos.addScaledVector(vel, h);

  /* ── Integrate rotation: q ← q ⊗ exp(ω_local·h) ── */
  const r = ac.rates;
  _omega.set(r.y, -r.z, -r.x);
  const w = _omega.length();
  if (w > 1e-9) {
    _omega.multiplyScalar(1 / w);
    _dq.setFromAxisAngle(_omega, w * h);
    q.multiply(_dq);
    q.normalize();
  }

  /* ── Structural loads (only reachable when a damaged FCS lets the load overshoot) ── */
  if (alive) {
    gLimits(perf, stores.heavy, 0, _lim);
    const hi = _lim.max + 0.4;
    const lo = _lim.min - 0.4;
    const excess = gLoad > hi ? gLoad - hi : gLoad < lo ? lo - gLoad : 0;
    if (excess > 0) {
      f.overstress += excess * 0.3 * h;
      if (gLoad > _lim.max * 1.6) st.pendingStructuralDamage += 1000;
      if (f.overstress >= 1) {
        st.pendingStructuralDamage += 30;
        f.overstress = 0.6;
      }
    }
  }
  return gLoad;
}

function clamp1(x: number): number {
  return x > 1 ? 1 : x < -1 ? -1 : x !== x ? 0 : x;
}

/** Publish every FlightState field from the latest sub-step. */
function writeOutputs(ac: AircraftEntity, st: AircraftSimState, env: FlightEnv | null): void {
  const f = ac.flight;
  const perf = st.perf;
  const pos = ac.position;
  const V = ac.velocity.length();
  f.alpha = AD.alpha;
  f.beta = AD.beta;
  f.tas = V;
  f.ias = tasToIas(V, pos.y);
  f.mach = AD.mach;
  _up.set(0, 1, 0).applyQuaternion(ac.quaternion);
  _fwd.set(0, 0, -1).applyQuaternion(ac.quaternion);
  f.gLoad = st.specificForce.dot(_up) / G;
  let peak = 0;
  for (let i = 0; i < st.gBuckets.length; i++) if (st.gBuckets[i] > peak) peak = st.gBuckets[i];
  f.gPeak = Math.max(peak, Math.abs(f.gLoad));
  f.altitude = pos.y;
  f.agl = env ? pos.y - env.terrain.surfaceHeightAt(pos.x, pos.z) : pos.y;
  f.verticalSpeed = ac.velocity.y;
  hprFromAxes(_fwd, _up, _hpr);
  f.heading = _hpr.heading;
  f.pitch = _hpr.pitch;
  f.roll = _hpr.roll;
  f.thrust = AD.thrust;
  f.engineRpm = st.rpm;
  f.afterburner = st.abLit ? Math.max(0.08, st.abLevel) : st.abLevel;
  f.mass = AD.mass;
  const over = f.alpha >= 0 ? f.alpha - perf.alphaStall : -f.alpha - perf.alphaStallNeg;
  f.stalled = ac.alive && (st.departure > 0.25 || over > 1 * (Math.PI / 180));
  ac.buffet = ac.alive ? st.buffet : 0;
  const s = f.surfaces;
  s.airbrake = st.airbrake;
  // Leading/trailing-edge flaps are scheduled with AoA at low speed.
  s.flaps = ac.alive ? Math.min(1, Math.max(0, f.alpha / (20 * (Math.PI / 180)))) * (1 - sstep(f.ias, 150, 220)) : 0;

  // Mach 1 crossings (vapor cone / sonic boom)
  if (!f.supersonic && f.mach >= 1.0) {
    f.supersonic = true;
    env?.events?.emit('transonic', { aircraft: ac, supersonic: true });
  } else if (f.supersonic && f.mach < 0.97) {
    f.supersonic = false;
    env?.events?.emit('transonic', { aircraft: ac, supersonic: false });
  }
}

/**
 * Turn a destroyed aircraft into a tumbling wreck: engine dead, random spin, burning.
 * The flight model keeps integrating it ballistically until ground impact.
 */
export function makeWreck(ac: AircraftEntity): void {
  const st = ensureSimState(ac);
  const rnd = st.rng;
  const sgn = () => (rnd() < 0.5 ? -1 : 1);
  st.wreckSpin.set(sgn() * (1.2 + rnd() * 2.5), sgn() * (0.3 + rnd() * 0.9), sgn() * (0.2 + rnd() * 0.6));
  st.flamedOut = true;
  st.abLit = false;
  st.gcasActive = false;
  ac.gcasActive = false;
  ac.damage.fire = true;
  const inp = ac.input;
  inp.fireGun = inp.fireWeapon = inp.flare = inp.chaff = false;
  inp.pitch = inp.roll = inp.yaw = 0;
  inp.throttle = 0;
  ac.gunFiring = false;
}

