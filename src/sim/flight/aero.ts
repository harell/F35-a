/**
 * F35-A — aerodynamic & propulsion coefficient functions (SIM-CORE).
 * Pure functions of (perf, state) — no allocations — shared by the flight model, the FBW
 * inversion and the AI helper functions.
 */
import type { AircraftPerf } from './aircraftData';

const DEG = Math.PI / 180;

function smooth01(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/** Smoothstep of x between edges a < b. */
export function sstep(x: number, a: number, b: number): number {
  return smooth01((x - a) / (b - a));
}

/**
 * Lift-curve-slope multiplier vs Mach (1 at low speed). Subsonic: DATCOM finite-wing
 * compressibility using the aspect ratio; transonic peak; supersonic decay.
 */
export function machLiftFactor(perf: AircraftPerf, mach: number): number {
  const A = perf.aspect;
  const base = datcomLiftSlope(A, 0);
  if (mach <= 0.95) return datcomLiftSlope(A, mach > 0 ? mach : 0) / base;
  const peak = datcomLiftSlope(A, 0.95) / base;
  if (mach <= 1.05) return peak;
  return Math.max(0.65, peak - 0.42 * (mach - 1.05));
}

/** DATCOM subsonic finite-wing lift-curve slope (per rad) for aspect ratio A (unswept). */
function datcomLiftSlope(A: number, m: number): number {
  const b2 = 1 - m * m;
  return (2 * Math.PI * A) / (2 + Math.sqrt(4 + A * A * b2));
}

/** Low-Mach lift coefficient shape vs AoA (any α in −π..π), before the Mach multiplier. */
export function liftShape(perf: AircraftPerf, alpha: number): number {
  const neg = alpha < 0;
  const a = neg ? -alpha : alpha;
  const as = neg ? perf.alphaStallNeg : perf.alphaStall;
  const a1 = neg ? perf.a1Neg : perf.a1;
  const c = neg ? perf.cQuadNeg : perf.cQuad;
  const clMax = neg ? perf.clMaxNeg : perf.clMaxEff;
  let cl: number;
  if (a <= a1) cl = perf.clAlpha * a;
  else if (a <= as) cl = clMax - c * (as - a) * (as - a);
  else {
    // Post stall: lift falls away and blends into flat-plate behaviour (≈1.1·sin 2α).
    const d = a - as;
    const fp = 1.1 * Math.sin(2 * a);
    cl = Math.max(clMax - 2 * c * d * d, fp);
  }
  return neg ? -cl : cl;
}

/** Lift coefficient at (α, Mach). */
export function liftCoefficient(perf: AircraftPerf, alpha: number, mach: number): number {
  return liftShape(perf, alpha) * machLiftFactor(perf, mach);
}

/**
 * Inverse of the (pre-stall, monotonic) lift curve: AoA needed for a lift coefficient.
 * Demands beyond CLmax map progressively past the stall AoA (so an unassisted pilot who
 * over-pulls departs), then everything is clamped to [alphaMin, alphaMax].
 */
export function alphaForLift(perf: AircraftPerf, cl: number, mach: number, alphaMax: number, alphaMin: number): number {
  const c = cl / machLiftFactor(perf, mach);
  let a: number;
  if (c >= 0) {
    if (c <= perf.clAlpha * perf.a1) a = c / perf.clAlpha;
    else if (c < perf.clMaxEff) a = perf.alphaStall - Math.sqrt((perf.clMaxEff - c) / perf.cQuad);
    else a = perf.alphaStall + Math.min(60 * DEG, ((c - perf.clMaxEff) / perf.clMaxEff) * 0.6);
  } else {
    const cn = -c;
    if (cn <= perf.clAlpha * perf.a1Neg) a = -cn / perf.clAlpha;
    else if (cn < perf.clMaxNeg) a = -(perf.alphaStallNeg - Math.sqrt((perf.clMaxNeg - cn) / perf.cQuadNeg));
    else a = -(perf.alphaStallNeg + Math.min(60 * DEG, ((cn - perf.clMaxNeg) / perf.clMaxNeg) * 0.6));
  }
  return a > alphaMax ? alphaMax : a < alphaMin ? alphaMin : a;
}

/** Transonic / supersonic wave drag increment. */
export function waveDrag(perf: AircraftPerf, mach: number): number {
  if (mach <= perf.mCrit) return 0;
  if (mach <= perf.mWavePeak) return perf.cdWave * smooth01((mach - perf.mCrit) / (perf.mWavePeak - perf.mCrit));
  return perf.cdWave * (0.62 + 0.38 * Math.exp(-(mach - perf.mWavePeak) * 2.2));
}

/** Induced drag factor — rises supersonically (loss of leading-edge suction). */
export function inducedK(perf: AircraftPerf, mach: number): number {
  return mach > 0.9 ? perf.kInduced * (1 + 1.1 * (mach - 0.9)) : perf.kInduced;
}

/**
 * Total drag coefficient. `extraCd` = stores + airbrake increments.
 * Attached-flow polar (CD0 + k·CL² + high-lift term + wave) vs separated flat-plate drag
 * (CD0 + 1.3·sin²α) — whichever is larger — plus sideslip drag.
 */
export function dragCoefficient(perf: AircraftPerf, alpha: number, beta: number, cl: number, mach: number, extraCd: number): number {
  const acl = Math.abs(cl);
  const hi = acl > perf.clHigh ? acl - perf.clHigh : 0;
  const base = perf.cd0 + extraCd;
  const attached = base + inducedK(perf, mach) * cl * cl + perf.kHigh * hi * hi + waveDrag(perf, mach);
  const sa = Math.sin(alpha);
  const separated = base + 1.3 * sa * sa + waveDrag(perf, mach) * 0.5;
  const sb = Math.sin(beta);
  return Math.max(attached, separated) + 0.6 * sb * sb;
}

/** Inlet / engine recovery loss beyond the design Mach (sets the top speed). */
export function inletFactor(perf: AircraftPerf, mach: number): number {
  return 1 - 0.85 * sstep(mach, perf.maxMach - 0.15, perf.maxMach + 0.3);
}

/** Thrust drop-off above the service ceiling. */
function ceilingFactor(perf: AircraftPerf, alt: number): number {
  return alt > perf.ceiling ? Math.exp(-(alt - perf.ceiling) / 1500) : 1;
}

/** Available military (100 % dry) thrust at altitude / Mach (N). */
export function thrustMil(perf: AircraftPerf, alt: number, sigma: number, mach: number): number {
  let t = perf.thrustDry * Math.pow(sigma, perf.dryLapse) * (1 + perf.dryRam * mach);
  t = Math.min(t, perf.thrustDry * perf.dryCap);
  return Math.max(0, t * inletFactor(perf, mach) * ceilingFactor(perf, alt));
}

/** Available max afterburner thrust at altitude / Mach (N). */
export function thrustMax(perf: AircraftPerf, alt: number, sigma: number, mach: number): number {
  if (!perf.hasAfterburner) return thrustMil(perf, alt, sigma, mach);
  let t = perf.thrustAB * Math.pow(sigma, perf.abLapse) * (1 + perf.abRam * mach);
  t = Math.min(t, perf.thrustAB * perf.abCap);
  return Math.max(0, t * inletFactor(perf, mach) * ceilingFactor(perf, alt));
}

/** Fraction of MIL thrust at idle. */
export const IDLE_THRUST_FRACTION = 0.06;
