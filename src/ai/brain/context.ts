/**
 * F35-A — per-tick context handed to the AI tactical helpers (defense, weapons, BFM).
 * One instance per brain, refreshed every tick (no allocation).
 */
import type { SimWorld } from '../../sim/api';
import type { AircraftEntity, MissileEntity } from '../../sim/entities';
import type { FlightIntent } from '../pilot/Autopilot';
import type { PilotSkill } from '../skill';

export interface TickCtx {
  ac: AircraftEntity;
  world: SimWorld;
  it: FlightIntent;
  skill: PilotSkill;
  now: number;
  dt: number;
  rng: () => number;
  /** Request a flare salvo if `interval` s passed since the last one. */
  flares(interval: number): void;
  /** Request a chaff salvo if `interval` s passed since the last one. */
  chaff(interval: number): void;
}

/** Public extras of the combat module's missiles we read (see COMBAT integration notes). */
export interface MissileExtras {
  guiderId?: number;
  tgo?: number;
  trackBroken?: boolean;
  cdef?: { guidance: string };
}

export type AnyMissile = MissileEntity & MissileExtras;
