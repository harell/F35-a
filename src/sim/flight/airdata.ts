/**
 * F35-A — per-sub-step air data shared between the flight model and the control laws.
 * A single module-level instance is reused (no allocations in the hot loop).
 */
export interface AirData {
  /** True airspeed (m/s) and a floored copy for divisions. */
  V: number;
  Vc: number;
  alpha: number;
  beta: number;
  mach: number;
  /** Dynamic pressure (Pa) and q̄·S (N per unit coefficient). */
  qbar: number;
  qS: number;
  rho: number;
  sigma: number;
  /** Total mass (kg). */
  mass: number;
  /** Net thrust along the body axis (N). */
  thrust: number;
  /** Flight path angle (rad) and its cosine. */
  gamma: number;
  cosGamma: number;
  /** Bank of the lift vector about the velocity vector (rad, + right). */
  bankW: number;
  cosBankW: number;
  /** Vertical component of the unit lift direction (= cosγ·cosφw). */
  liftUp: number;
  /** Gravity acceleration component along the body right axis (m/s²). */
  gRight: number;
  /** Number of external store stations (drag + g/roll penalties). */
  extStations: number;
  /** Heavy external bombs carried (FBW g-limit reduction). */
  heavyExternal: number;
  /** 0..1 pitch/roll control authority from q̄ (and TVC). */
  authority: number;
}

export function createAirData(): AirData {
  return {
    V: 0,
    Vc: 25,
    alpha: 0,
    beta: 0,
    mach: 0,
    qbar: 0,
    qS: 0,
    rho: 1.225,
    sigma: 1,
    mass: 1,
    thrust: 0,
    gamma: 0,
    cosGamma: 1,
    bankW: 0,
    cosBankW: 1,
    liftUp: 1,
    gRight: 0,
    extStations: 0,
    heavyExternal: 0,
    authority: 1,
  };
}
