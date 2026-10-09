/**
 * F35-A — fly-by-wire control laws (SIM-CORE), in the style of the F-35's nonlinear
 * dynamic-inversion CLAW:
 *
 *  PITCH  stick → commanded normal load (g). Neutral stick = 1 g corrected for flight-path
 *         angle and bank (in near-level flight it latches and holds the flight-path angle). The g command is
 *         inverted through the lift curve to a required AoA, which the pitch rate loop tracks:
 *              q_cmd = (g/V)(n_achievable − n_gravity) + Kα (α_req − α)
 *         α_req is clamped by the AoA limiter, n by the g limiter. At low dynamic pressure the
 *         stick blends into a pitch-rate command (C* style) — still AoA limited.
 *  ROLL   stick → stability-axis roll-rate command, scheduled with equivalent airspeed (steady
 *         roll rate ∝ V below ~0.85 × corner speed, peak around corner, high-q̄ limit above
 *         ~440 KEAS), load factor (rolling-pull limit), AoA and external stores — see rollRateLimit.
 *  YAW    automatic turn coordination (β → 0, gravity feed-forward), rudder = sideslip command.
 *
 *  The g / AoA limiters ("carefree handling") are ALWAYS on — like the real F-35 CLAW — for every
 *  aircraft. The departure model (wing drop + nose slice past the stall AoA) stays for
 *  transients the limiter cannot catch (damaged hydraulics, tail slides) but a full stick
 *  deflection alone can no longer depart the jet.
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
 *  - near-level flight: bank-compensated flight-path hold  n = cosγ / cosφ
 *  - steep climbs/dives (|γ| 30°→60°): blends to a 1 g-per-cosφ law, so a released
 *    stick gently rounds out dives instead of holding them
 *  - beyond ~60–100° of bank the compensation fades to a plain 1 g (F-16 / F-35 style)
 * (the flight-path latch on top of it is in updateControlLaws)
 */
export function neutralStickG(gamma: number, cosBank: number, bank: number): number {
  const cb = Math.max(cosBank, 0.5);
  const steep = sstep(Math.abs(gamma), 30 * DEG, 60 * DEG);
  const comp = (Math.cos(gamma) * (1 - steep) + steep) / cb;
  const w = sstep(Math.abs(bank), 60 * DEG, 100 * DEG);
  return comp + (1 - comp) * w;
}

/**
 * FBW g limits for an aircraft (stores & hydraulics). Written into `out`. The limiter is part of
 * the jet's control laws and is active on every difficulty.
 */
export function gLimits(perf: AircraftPerf, heavyExternal: number, hydraulics: number, out: { max: number; min: number }): { max: number; min: number } {
  const storesF = heavyExternal > 0 ? Math.max(0.75, 1 - 0.045 * heavyExternal) : 1;
  const nMax = perf.maxG * storesF;
  const nMin = perf.minG;
  const hyd = Math.min(1, hydraulics);
  out.max = 1 + (nMax - 1) * (1 - 0.5 * hyd);
  out.min = 1 + (nMin - 1) * (1 - 0.5 * hyd);
  return out;
}

/** FBW AoA limiter (rad): always a margin below the stall AoA, so full stick never departs the jet. */
export function alphaLimits(perf: AircraftPerf, out: { max: number; min: number }): { max: number; min: number } {
  out.max = Math.min(perf.aoaLimit, perf.alphaStall - 1.5 * DEG);
  out.min = -Math.min(0.45 * perf.aoaLimit, perf.alphaStallNeg - 1 * DEG);
  return out;
}

/**
 * Roll-rate limit of the FCS (rad/s) for the current flight condition:
 *  - equivalent airspeed: a fixed aileron/flaperon deflection gives a steady roll rate ∝ V, so
 *    below ~0.85 × corner speed the available rate falls linearly (≈ 45 % at 150 KEAS for the
 *    F-35A); full rate around corner speed; above ~1.1 × corner the FCS trims it back (high-q̄
 *    structural / roll-coupling limit, −25 % by ~1.5 × corner)
 *  - load factor: rolling-pull limit, −30 % at 9 g
 *  - AoA: stability-axis roll at high AoA is slow, −55 % at 32°
 *  - external stores (roll inertia, pylon loads): −4 % per station, −4.5 % per heavy bomb
 * `hydF` is the hydraulic-damage authority factor (1 = healthy).
 */
export function rollRateLimit(perf: AircraftPerf, qbar: number, alpha: number, nz: number, extStations: number, heavyExternal: number, hydF = 1): number {
  const eas = Math.sqrt((2 * Math.max(0, qbar)) / 1.225);
  const vFull = 0.85 * perf.cornerSpeed;
  const low = Math.min(1, Math.max(perf.tvc ? 0.3 : 0.15, eas / vFull));
  const high = 1 - 0.25 * sstep(eas, 1.1 * perf.cornerSpeed, 1.5 * perf.cornerSpeed);
  const gF = 1 - 0.3 * sstep(Math.abs(nz), 4, 9);
  const aFade = 1 - 0.55 * sstep(Math.abs(alpha), 12 * DEG, 32 * DEG);
  const stores = Math.max(0.6, 1 - 0.04 * extStations - 0.045 * heavyExternal);
  return perf.rollRateMax * low * high * gF * aFade * stores * hydF;
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

/**
 * Dynamic inversion: pitch rate command for a normal-load command `nz`. When the AoA limiter is
 * the active constraint the α error is taken on α predicted one pitch time-constant ahead
 * (α + α̇·τ): the limiter captures its AoA without overshoot or bobbing ("crisp" at full stick).
 */
function pitchRateForG(perf: AircraftPerf, ad: AirData, nz: number, aMax: number, aMin: number, kA: number, alphaDotLead: number): number {
  const qS = Math.max(ad.qS, 1);
  const clReq = (nz * ad.mass * G - ad.thrust * Math.sin(ad.alpha)) / qS;
  const aReq = alphaForLift(perf, clReq, ad.mach, aMax, aMin);
  if (alphaDotLead !== 0 && (aReq >= aMax - 1e-4 || aReq <= aMin + 1e-4)) {
    const W = ad.mass * G;
    const nAch = (ad.qS * liftCoefficient(perf, aReq, ad.mach) + ad.thrust * Math.sin(aReq)) / W;
    return (G / ad.Vc) * (nAch - ad.liftUp) + kA * wrapPi(aReq - ad.alpha - alphaDotLead);
  }
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
  const lim = gLimits(perf, ad.heavyExternal, hyd, _gl);
  let n0 = neutralStickG(ad.gamma, ad.cosBankW, ad.bankW);
  if (input.nzOverride === null) {
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

  const al = alphaLimits(perf, _al);
  const kA = Math.min(6, 0.6 / tauQ);
  // α̇ ≈ body pitch rate − flight-path rotation rate at the current α (limiter lead term)
  const qss = pitchRateFor(perf, ad, ad.alpha, 0);
  const alphaDotLead = (rates.y - qss) * tauQ;
  let qCmd = pitchRateForG(perf, ad, st.nzCmd, al.max, al.min, kA, alphaDotLead);

  // C*-style blend: at low q̄ the stick becomes a pitch-rate command (still AoA limited).
  const wG = sstep(ad.qbar, 3500, 10_000);
  if (wG < 1 && input.nzOverride === null) {
    // Neutral stick: flight-path hold (DI at n0). Deflected stick: pitch-rate command on top of
    // the current flight-path rotation (so α changes at the commanded rate).
    const hold = pitchRateForG(perf, ad, n0, al.max, al.min, kA, alphaDotLead);
    const w = Math.min(1, Math.abs(sp) * 3);
    let qR = hold * (1 - w) + (qss + sp * perf.pitchRateMax) * w;
    const qHi = pitchRateFor(perf, ad, al.max, kA) - kA * alphaDotLead;
    const qLo = pitchRateFor(perf, ad, al.min, kA) - kA * alphaDotLead;
    qR = qR > qHi ? qHi : qR < qLo ? qLo : qR;
    qCmd = qR + (qCmd - qR) * wG;
  }
  const qLimit = Math.max(perf.pitchRateMax * 1.6, 0.7);
  qCmd = qCmd > qLimit ? qLimit : qCmd < -qLimit ? -qLimit : qCmd;

  /* ───────── ROLL / YAW ───────── */
  const rollAuth = Math.min(1, Math.max(perf.tvc ? 0.3 : 0.15, ad.qbar / (perf.qFull * 1.1)));
  const pMax = rollRateLimit(perf, ad.qbar, ad.alpha, st.nzCmd, ad.extStations, ad.heavyExternal, hydF);
  const ps = sr * pMax;
  const cosA = Math.cos(ad.alpha);
  const sinA = Math.sin(ad.alpha);
  const cosAc = cosA > 0.3 ? cosA : 0.3;
  const gTurn = ad.gRight / (ad.Vc * cosAc); // yaw rate that cancels gravity-induced sideslip
  const kB = 3 * Math.max(auth, 0.2);
  // stability-axis roll (about the velocity vector) with automatic turn coordination
  let pCmd = ps * cosA;
  const betaCmd = -sy * 8 * DEG * (0.5 + 0.5 * rollAuth);
  let rCmd = ps * sinA + gTurn + kB * (ad.beta - betaCmd);
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
  // Airframe buffet (felt through the camera / haptics via st.buffet) from high AoA, departure and
  // transonic high-g. Its effect on the body rates is small — a light wing rock — so the limiter
  // stays crisp.
  const aAbs = Math.abs(ad.alpha);
  const transonic = ad.mach > 0.92 && ad.mach < 1.05 && st.nzCmd > 4 ? 0.15 : 0;
  const buf = 0.35 * sstep(aAbs, 0.7 * perf.alphaStall, perf.alphaStall) + transonic + 0.65 * D;
  st.buffet = buf > 1 ? 1 : buf;
  if (buf > 0.01) {
    const k = Math.min(1, 25 * h);
    st.noiseP += (st.rng() * 2 - 1 - st.noiseP) * k;
    st.noiseQ += (st.rng() * 2 - 1 - st.noiseQ) * k;
    st.noiseR += (st.rng() * 2 - 1 - st.noiseR) * k;
    const rock = D > 0.05 ? 1 : 0.35;
    pCmd += st.noiseP * buf * 0.35 * rock;
    qCmd += st.noiseQ * buf * 0.12 * rock;
    rCmd += st.noiseR * buf * 0.1 * rock;
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
