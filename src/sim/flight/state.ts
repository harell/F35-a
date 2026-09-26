/**
 * F35-A — per-aircraft private simulation state (SIM-CORE).
 * Attached to `AircraftEntity.sim` (extension field). Other modules must treat it as opaque;
 * everything they need is published in `AircraftEntity.flight`, `.rates`, `.gcasActive`.
 */
import { Vector3 } from 'three';
import type { AircraftType } from '../../core/types';
import { mulberry32 } from '../../core/math';
import { AIRCRAFT_PERF, type AircraftPerf } from './aircraftData';

export interface AircraftSimState {
  perf: AircraftPerf;

  /* ── Engine ── */
  /** Spooled dry power 0 (idle) .. 1 (MIL) — proportional to dry thrust. */
  power: number;
  /** Displayed core rpm 0..1.05. */
  rpm: number;
  /** Time the afterburner has been requested with the core at MIL (light-off delay). */
  abTimer: number;
  abLit: boolean;
  /** Afterburner stage 0..1. */
  abLevel: number;
  /** Engine not producing thrust (fuel exhausted / destroyed). */
  flamedOut: boolean;
  /** Ran out of fuel (player:down reason 'fuel' on the subsequent crash). */
  fuelExhausted: boolean;

  /* ── Fly-by-wire ── */
  /** Rate-limited normal load command (g). */
  nzCmd: number;
  /** Flight-path-angle hold (assisted neutral stick). */
  gammaHold: boolean;
  gammaRef: number;
  neutralTime: number;
  /** Departure intensity 0..1 and its direction (−1 left, +1 right, 0 none). */
  departure: number;
  departDir: number;
  /** Smoothed buffet noise channels (p, q, r). */
  noiseP: number;
  noiseQ: number;
  noiseR: number;
  /** Buffet intensity 0..1 (cameras may shake with it). */
  buffet: number;
  /** Speed brake extension 0..1. */
  airbrake: number;

  /* ── Loads ── */
  /** Max |g| per 0.1 s bucket over the last second. */
  gBuckets: Float32Array;
  gBucketIdx: number;
  gBucketTime: number;
  /** Non-gravitational acceleration last sub-step (world, m/s²) — what an accelerometer feels. */
  specificForce: Vector3;
  /** Structural damage to be applied by the world (overstress), hit points. */
  pendingStructuralDamage: number;

  /* ── Auto-GCAS ── */
  gcasEnabled: boolean;
  gcasActive: boolean;
  gcasTime: number;
  gcasCheckTimer: number;
  gcasLastMessage: number;
  /** g the recovery is currently commanding (5 g, escalated to max g when 5 g won't clear). */
  gcasG: number;
  /** Climb angle the fly-up captures (rad) — steepened while the predicted path doesn't clear. */
  gcasClimb: number;

  /* ── Pilot physiology (G-LOC, see gloc.ts) ── */
  /** Accumulated g stress 0..1 (1 = G-LOC). */
  gStress: number;
  /** Unconscious (and then regaining control) after a G-LOC. */
  glocActive: boolean;
  /** Seconds of incapacitation left (runs below zero through the recovery ramp). */
  glocTimer: number;
  /** 0..1 multiplier on the pilot's stick (0 while unconscious). */
  pilotAuthority: number;

  /* ── World bookkeeping ── */
  /** AI brain accumulator (20 Hz, staggered). */
  aiTimer: number;
  /** Sim time of ground impact, -1 while flying. */
  crashTime: number;
  /** Tumble rates of a wreck (p, q, r). */
  wreckSpin: Vector3;
  /** Fire duration left before it may burn out (s). */
  fireTimer: number;
  /** Weapon that last damaged this aircraft (fire kills are credited to it). */
  lastWeapon: string | null;
  /** Deterministic per-aircraft random source. */
  rng: () => number;
}

export function createSimState(type: AircraftType, seed: number): AircraftSimState {
  return {
    perf: AIRCRAFT_PERF[type],
    power: 0.5,
    rpm: 0.8,
    abTimer: 0,
    abLit: false,
    abLevel: 0,
    flamedOut: false,
    fuelExhausted: false,
    nzCmd: 1,
    gammaHold: false,
    gammaRef: 0,
    neutralTime: 0,
    departure: 0,
    departDir: 0,
    noiseP: 0,
    noiseQ: 0,
    noiseR: 0,
    buffet: 0,
    airbrake: 0,
    gBuckets: new Float32Array(10).fill(1),
    gBucketIdx: 0,
    gBucketTime: 0,
    specificForce: new Vector3(0, 9.80665, 0),
    pendingStructuralDamage: 0,
    gcasEnabled: false,
    gcasActive: false,
    gcasTime: 0,
    gcasCheckTimer: 0,
    gcasLastMessage: -999,
    gcasG: 5,
    gcasClimb: 0.26,
    gStress: 0,
    glocActive: false,
    glocTimer: 0,
    pilotAuthority: 1,
    aiTimer: 0,
    crashTime: -1,
    wreckSpin: new Vector3(),
    fireTimer: 0,
    lastWeapon: null,
    rng: mulberry32(seed * 2654435761 + 12345),
  };
}
