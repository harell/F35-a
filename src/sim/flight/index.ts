/**
 * F35-A — flight module public surface (SIM-CORE).
 * Other modules should import from here (or from ./aircraftData / ./performance directly).
 */
export { AIRCRAFT_PERF, STORE_DATA, type AircraftPerf } from './aircraftData';
export { FM_RATE_HZ, type FlightEnv } from './env';
export { initFlight, stepFlight, ensureSimState, isAssisted, massOf, makeWreck, type FlightInitOptions } from './FlightModel';
export { neutralStickG, gLimits, alphaLimits } from './controlLaws';
export { predictRecoveryClearance } from './gcas';
export { setQuatFromHPR, hprFromQuaternion, hprFromAxes } from './attitude';
export * from './performance';
