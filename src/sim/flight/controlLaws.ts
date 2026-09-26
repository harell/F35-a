/**
 * F35-A — fly-by-wire control laws (SIM-CORE), in the style of the F-35's nonlinear
 * dynamic-inversion CLAW:
 *
 *  PITCH  stick → commanded normal load (g). Neutral stick = 1 g corrected for flight-path
 *         angle and bank (assisted modes latch and hold the flight-path angle). The g command is
 *         inverted through the lift curve to a required AoA, which the pitch rate loop tracks:
 *              q_cmd = (g/V)(n_achievable − n_gravity) + Kα (α_req − α)
 *         α_req is clamped by the AoA limiter, n by the g limiter. At low dynamic pressure the
 *         stick blends into a pitch-rate command (C* style) — still AoA limited.
 *  ROLL   stick → stability-axis roll-rate command, scaled down at low q̄ / high AoA / stores.
 *  YAW    automatic turn coordination (β → 0, gravity feed-forward), rudder = sideslip command.
 *
 *  Unassisted (difficulty.flightAssist = false): no flight-path hold, 35 % more g / much more
 *  AoA available, body-axis roll, weak yaw damper — over-pulling past the stall AoA departs the
 *  jet (wing drop + nose slice), recoverable by unloading.
 *
 * Body rates follow the commands through first-order lags (actuators + airframe inertia) whose
 * time constants grow as authority (q̄, hydraulics) drops.
 */
import { G } from '../../core/math';
import type { AircraftEntity } from '../entities';
import type { AirData } from './airdata';
import type { AircraftSimState } from './state';
import type { AircraftPerf } from './aircraftData';
import { alphaForLift, liftCoefficient, sstep } from './aero';

const DEG = Math.PI / 180;

/** Pilot / autopilot inputs after overrides (Auto-GCAS). */
export interface StickInput {
  pitch: number;
  roll: number;
  yaw: number;
  /** When set, replaces the pitch stick with a direct g command (Auto-GCAS). */
  nzOverride: number | null;
}

/**
 * Neutral-stick normal-load command (g).
 *  - assisted, near-level flight: bank-compensated flight-path hold  n = cosγ / cosφ
 *  - assisted, steep climbs/dives (|γ| 30°→60°): blends to a 1 g-per-cosφ law, so a released
 *    stick gently rounds out dives instead of holding them
 *  - beyond ~60–100° of bank the compensation fades to a plain 1 g (F-16 / F-35 style)
 *  - unassisted: plain 1 g
 */
export function neutralStickG(gamma: number, cosBank: number, bank: number, assisted: boolean): number {
  if (!assisted) return 1;
  const cb = Math.max(cosBank, 0.5);
  const steep = sstep(Math.abs(gamma), 30 * DEG, 60 * DEG);
  const comp = (Math.cos(gamma) * (1 - steep) + steep) / cb;
  const w = sstep(Math.abs(bank), 60 * DEG, 100 * DEG);
  return comp + (1 - comp) * w;
}

/** Structural / FBW g limits for an aircraft (stores & hydraulics). Written into `out`. */
export function gLimits(
  perf: AircraftPerf,
  heavyExternal: number,
  hydraulics: number,
  assisted: boolean,
  out: { max: number; min: number },
): { max: number; min: number } {
  const storesF = heavyExternal > 0 ? Math.max(0.75, 1 - 0.045 * heavyExternal) : 1;
  let nMax = perf.maxG * storesF;
  let nMin = perf.minG;
  if (!assisted) {
    nMax *= 1.35;
    nMin *= 1.35;
  }
  const hyd = Math.min(1, hydraulics);
  out.max = 1 + (nMax - 1) * (1 - 0.5 * hyd);
  out.min = 1 + (nMin - 1) * (1 - 0.5 * hyd);
  return out;
}

/** AoA limits for the current control law (rad). */
export function alphaLimits(perf: AircraftPerf, assisted: boolean, out: { max: number; min: number }): { max: number; min: number } {
  if (assisted) {
    out.max = Math.min(perf.aoaLimitAssisted, perf.alphaStall - 1.5 * DEG);
    out.min = -Math.min(0.45 * perf.aoaLimitAssisted, perf.alphaStallNeg - 1 * DEG);
  } else {
    out.max = perf.aoaLimitUnassisted;
    out.min = -Math.max(0.6 * perf.aoaLimitUnassisted, perf.alphaStallNeg + 5 * DEG);
  }
  return out;
}

function wrapPi(a: number): number {
  if (a > Math.PI) return a - 2 * Math.PI;
  if (a < -Math.PI) return a + 2 * Math.PI;
  return a;
}

/** Pitch rate that drives α towards `aTarget` while turning the flight path at the load it produces. */
function pitchRateFor(perf: AircraftPerf, ad: AirData, aTarget: number, kA: number): number {
  const W = ad.mass * G;
  const nAch = (ad.qS * liftCoefficient(perf, aTarget, ad.mach) + ad.thrust * Math.sin(aTarget)) / W;
  return (G / ad.Vc) * (nAch - ad.liftUp) + kA * wrapPi(aTarget - ad.alpha);
}

/** Dynamic inversion: pitch rate command for a normal-load command `nz`. */
function pitchRateForG(perf: AircraftPerf, ad: AirData, nz: number, aMax: number, aMin: number, kA: number): number {
  const qS = Math.max(ad.qS, 1);
  const clReq = (nz * ad.mass * G - ad.thrust * Math.sin(ad.alpha)) / qS;
  const aReq = alphaForLift(perf, clReq, ad.mach, aMax, aMin);
  return pitchRateFor(perf, ad, aReq, kA);
}

const _gl = { max: 9, min: -3 };
const _al = { max: 0.5, min: -0.2 };

/**
 * Run the control laws for one sub-step: updates `ac.rates` (p, q, r) and control-surface
 * deflections, departure / buffet state in `st`.
 */
export function updateControlLaws(
  ac: AircraftEntity,
  st: AircraftSimState,
  ad: AirData,
  h: number,
  assisted: boolean,
  input: StickInput,
): void {
  const perf = st.perf;
  const rates = ac.rates;
  const sp = input.pitch;
  const sr = input.roll;
  const sy = input.yaw;
  const hyd = Math.min(1, ac.damage.hydraulics);
  const hydF = hyd > 0.95 ? 0.12 : 1 - 0.65 * hyd;
  const auth = Math.max(0.05, ad.authority * hydF);
  const tauQ = Math.min(1.5, perf.pitchTau / auth);
  const tauP = Math.min(1.5, perf.rollTau / auth);
  const tauR = Math.min(2, perf.yawTau / auth);

  /* ───────── PITCH ───────── */
  const lim = gLimits(perf, ad.heavyExternal, hyd, assisted, _gl);
  let n0 = neutralStickG(ad.gamma, ad.cosBankW, ad.bankW, assisted);
  if (assisted && input.nzOverride === null) {
    // Flight-path-angle hold (near-level flight only): latch γ shortly after the stick
    // returns to neutral; re-latch if the path has been pushed far from the reference.
    if (Math.abs(sp) < 0.05 && Math.abs(ad.bankW) < 65 * DEG && Math.abs(ad.gamma) < 30 * DEG) st.neutralTime += h;
    else {
      st.neutralTime = 0;
      st.gammaHold = false;
    }
    if (!st.gammaHold && st.neutralTime > 0.35) {
      st.gammaHold = true;
      st.gammaRef = ad.gamma;
    }
    if (st.gammaHold && Math.abs(st.gammaRef - ad.gamma) > 12 * DEG) st.gammaRef = ad.gamma;
    if (st.gammaHold) {
      const corr = (0.8 * (st.gammaRef - ad.gamma) * ad.Vc) / G;
      n0 += (corr > 0.6 ? 0.6 : corr < -0.6 ? -0.6 : corr) * ad.cosBankW;
    }
  } else {
    st.gammaHold = false;
    st.neutralTime = 0;
  }
  let nzTarget = sp >= 0 ? n0 + sp * (lim.max - n0) : n0 - sp * (lim.min - n0);
  if (input.nzOverride !== null) nzTarget = input.nzOverride;
  // g onset rate limiting (≈ 14 g/s up, 20 g/s down)
  const dn = nzTarget - st.nzCmd;
  const maxStep = (dn > 0 ? 14 : 20) * h;
  st.nzCmd += dn > maxStep ? maxStep : dn < -maxStep ? -maxStep : dn;

  const al = alphaLimits(perf, assisted, _al);
  const kA = Math.min(6, 0.6 / tauQ);
  let qCmd = pitchRateForG(perf, ad, st.nzCmd, al.max, al.min, kA);

  // C*-style blend: at low q̄ the stick becomes a pitch-rate command (still AoA limited).
  const wG = sstep(ad.qbar, 3500, 10_000);
  if (wG < 1 && input.nzOverride === null) {
    // Neutral stick: flight-path hold (DI at n0). Deflected stick: pitch-rate command on top of
    // the current flight-path rotation (so α changes at the commanded rate).
    const hold = pitchRateForG(perf, ad, n0, al.max, al.min, kA);
    const qss = pitchRateFor(perf, ad, ad.alpha, 0);
    const w = Math.min(1, Math.abs(sp) * 3);
    let qR = hold * (1 - w) + (qss + sp * perf.pitchRateMax) * w;
    const qHi = pitchRateFor(perf, ad, al.max, kA);
    const qLo = pitchRateFor(perf, ad, al.min, kA);
    qR = qR > qHi ? qHi : qR < qLo ? qLo : qR;
    qCmd = qR + (qCmd - qR) * wG;
  }
  const qLimit = Math.max(perf.pitchRateMax * 1.6, 0.7);
  qCmd = qCmd > qLimit ? qLimit : qCmd < -qLimit ? -qLimit : qCmd;

  /* ───────── ROLL / YAW ───────── */
  const rollAuth = Math.min(1, Math.max(perf.tvc ? 0.3 : 0.15, ad.qbar / (perf.qFull * 1.1)));
  const aAbs = Math.abs(ad.alpha);
  const aFade = 1 - 0.55 * sstep(aAbs, 12 * DEG, 32 * DEG);
  const storeRoll = Math.max(0.75, 1 - 0.04 * ad.extStations);
  const highQ = ad.qbar > 55_000 ? Math.max(0.75, 1 - (ad.qbar - 55_000) / 100_000) : 1;
  const pMax = perf.rollRateMax * rollAuth * aFade * storeRoll * highQ * hydF;
  const ps = sr * pMax;
  const cosA = Math.cos(ad.alpha);
  const sinA = Math.sin(ad.alpha);
  const cosAc = cosA > 0.3 ? cosA : 0.3;
  const gTurn = ad.gRight / (ad.Vc * cosAc); // yaw rate that cancels gravity-induced sideslip
  const kB = 3 * Math.max(auth, 0.2);
  let pCmd: number;
  let rCmd: number;
  if (assisted) {
    pCmd = ps * cosA; // roll about the velocity vector
    const betaCmd = -sy * 8 * DEG * (0.5 + 0.5 * rollAuth);
    rCmd = ps * sinA + gTurn + kB * (ad.beta - betaCmd);
  } else {
    pCmd = ps; // body-axis roll: rolling at high AoA creates adverse sideslip
    rCmd = 0.5 * gTurn + 0.5 * kB * ad.beta + sy * perf.yawRateMax * rollAuth;
  }
  const rLimit = perf.yawRateMax + Math.abs(ps * sinA) + Math.abs(gTurn);
  rCmd = rCmd > rLimit ? rLimit : rCmd < -rLimit ? -rLimit : rCmd;

  /* ───────── DEPARTURE (past the stall AoA) ───────── */
  const over = ad.alpha >= 0 ? ad.alpha - perf.alphaStall : -ad.alpha - perf.alphaStallNeg;
  const overB = Math.abs(ad.beta) - 20 * DEG;
  const depTarget = ad.V > 15 ? Math.max(sstep(over, 0, 10 * DEG), 0.5 * sstep(overB, 0, 20 * DEG)) : st.departure;
  const rate = depTarget > st.departure ? 1.5 : 2.5;
  st.departure += (depTarget - st.departure) * Math.min(1, rate * h);
  if (st.departure < 0.01) st.departDir = 0;
  else if (st.departDir === 0) {
    // Wing drop + nose slice away from the relative wind (directional instability at high AoA).
    st.departDir = ad.beta > 0.02 ? -1 : ad.beta < -0.02 ? 1 : rates.x > 0.05 ? 1 : rates.x < -0.05 ? -1 : st.rng() < 0.5 ? -1 : 1;
  }
  const D = st.departure;
  if (D > 0.005) {
    // Wing drop / nose slice while the wing is stalled. They are sustained by back stick:
    // once the pilot unloads (neutral or forward stick) they die away and the jet recovers.
    const stallF = sstep(over, -3 * DEG, 6 * DEG);
    const pulling = sp > 0.5 ? 1 : sp < 0.05 ? 0.15 : 0.15 + ((sp - 0.05) / 0.45) * 0.85;
    const inj = D * stallF * pulling;
    const keep = 1 - 0.8 * D * stallF;
    pCmd = pCmd * keep + inj * st.departDir * perf.departRoll;
    rCmd = rCmd * keep + inj * st.departDir * perf.departYaw;
    if (sp > 0.2) qCmd += inj * 0.3; // pitch-up tendency while still pulling
  }

  /* ───────── BUFFET ───────── */
  const transonic = ad.mach > 0.92 && ad.mach < 1.05 && st.nzCmd > 4 ? 0.15 : 0;
  const buf = 0.35 * sstep(aAbs, 0.7 * perf.alphaStall, perf.alphaStall) + 0.65 * D + transonic;
  st.buffet = buf > 1 ? 1 : buf;
  if (buf > 0.01) {
    const k = Math.min(1, 25 * h);
    st.noiseP += (st.rng() * 2 - 1 - st.noiseP) * k;
    st.noiseQ += (st.rng() * 2 - 1 - st.noiseQ) * k;
    st.noiseR += (st.rng() * 2 - 1 - st.noiseR) * k;
    pCmd += st.noiseP * buf * 0.35;
    qCmd += st.noiseQ * buf * 0.12;
    rCmd += st.noiseR * buf * 0.1;
  }

  /* ───────── RATE RESPONSE (first-order lags) ───────── */
  rates.x += (pCmd - rates.x) * (1 - Math.exp(-h / tauP));
  rates.y += (qCmd - rates.y) * (1 - Math.exp(-h / tauQ));
  rates.z += (rCmd - rates.z) * (1 - Math.exp(-h / tauR));

  /* ───────── SURFACES (visuals) ───────── */
  const s = ac.flight.surfaces;
  const el = -(sp * 0.55 + (qCmd - rates.y) * 1.5);
  s.elevator = el > 1 ? 1 : el < -1 ? -1 : el;
  const ail = pCmd / Math.max(0.2, perf.rollRateMax) * 1.1;
  s.aileron = ail > 1 ? 1 : ail < -1 ? -1 : ail;
  const rud = sy * 0.6 + (rCmd - rates.z) * 1.5;
  s.rudder = rud > 1 ? 1 : rud < -1 ? -1 : rud;
}

/** Wreck: controls are gone, the airframe tumbles towards its (random) spin rates. */
export function updateWreckRates(ac: AircraftEntity, st: AircraftSimState, h: number): void {
  const k = 1 - Math.exp(-h / 0.9);
  ac.rates.x += (st.wreckSpin.x - ac.rates.x) * k;
  ac.rates.y += (st.wreckSpin.y - ac.rates.y) * k;
  ac.rates.z += (st.wreckSpin.z - ac.rates.z) * k;
  const s = ac.flight.surfaces;
  s.elevator = s.aileron = s.rudder = 0;
}
