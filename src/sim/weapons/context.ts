/**
 * F35-A — combat module shared context + per-aircraft combat state.
 *
 * The combat system keeps its private per-aircraft bookkeeping (countermeasure programs, bay
 * door sequencing, sensor tracks, RWR pools…) in a WeakMap keyed by the AircraftEntity, so
 * lookups are O(1), nothing leaks when the world drops an aircraft, and the shared entity
 * classes stay lean.
 */
import { Vector3 } from 'three';
import type { MunitionId, Team, VoiceId, WeaponId } from '../../core/types';
import type { SimWorld } from '../api';
import type { AircraftEntity, IncomingMissile, RadarContact, RwrContact, StoreStation } from '../entities';
import type { CombatMunitionDef } from './defs';

/** Sim steps between sensor updates of one aircraft (60 Hz / 6 = 10 Hz, staggered by id). */
export const SENSOR_DIV = 6;
/** Contacts not refreshed for this long are dropped (s). */
export const CONTACT_MEMORY = 4;

export interface CombatCtx {
  world: SimWorld;
  /** Sim time (s) of the current update. */
  time: number;
  /** Step counter (increments every update). */
  tick: number;
  rng: () => number;
  defs: Record<MunitionId, CombatMunitionDef>;
  /** Sim times of the last radio chatter per channel (rate limiting). */
  chatter: { friendly: number; sam: number };
  /** Token bucket for 'gun:impact' events. */
  impactBudget: number;
  /** Token bucket for flak-burst explosion events. */
  flakBudget: number;
}

/** A fused track; extends the public RadarContact with sensor bookkeeping. */
export interface TrackContact extends RadarContact {
  /** Last time our own radar painted it (s). */
  radarTime: number;
  /** Last time any onboard sensor (radar, DAS, EOTS/IRST) saw it (s). */
  ownTime: number;
  /** Inside the radar gimbal at the last scan. */
  inGimbal: boolean;
  /** Entity kind of the contact. */
  entityKind: 'aircraft' | 'sam' | 'ground';
}

export interface PendingRelease {
  weapon: Exclude<WeaponId, 'gun'>;
  munition: MunitionId;
  station: number;
  targetId: number | null;
  /** GPS aim point captured at the pickle (null = unguided CCIP drop). */
  groundPoint: Vector3 | null;
  /** Seconds since the pickle (safety timeout). */
  timer: number;
}

export interface IrSeekerInfo {
  state: 'off' | 'search' | 'locked';
  targetId: number | null;
  direction: Vector3 | null;
}

export interface AcCombatState {
  /* input edge detection */
  prevFireWeapon: boolean;
  prevFlare: boolean;
  prevChaff: boolean;

  /* countermeasure programs */
  flareLeft: number;
  flareTimer: number;
  flareRepeat: number;
  chaffLeft: number;
  chaffTimer: number;
  chaffRepeat: number;

  /* gun */
  gunAccum: number;
  roundCounter: number;
  burstHit: boolean;
  lastGunsCall: number;

  /* weapons bay */
  pending: PendingRelease | null;
  /** Seconds the bay stays open after the last release. */
  bayHold: number;

  /* loadout */
  rcsMultiplier: number;
  /** Munition per store station (parallel to `storesRef`), for enemy slot mapping. */
  stationMunitions: MunitionId[] | null;
  storesRef: StoreStation[] | null;

  /* sensors */
  contacts: Map<number, TrackContact>;
  contactPool: TrackContact[];
  lastSensorTime: number;
  lockLostTimer: number;
  /** Seconds the designated target has been missing from the contact list. */
  designationStale: number;
  /** AI lock time (s), derived from skill. */
  lockTime: number;
  groundPoint: Vector3;
  rwr: Map<number, RwrContact>;
  rwrPool: RwrContact[];
  incomingPool: IncomingMissile[];
  ir: IrSeekerInfo;
  irDir: Vector3;
  /** Sim time of the last radio call made by this aircraft. */
  lastRadio: number;
  /** Winchester call made. */
  winchester: boolean;
}

const states = new WeakMap<AircraftEntity, AcCombatState>();

export function acState(ac: AircraftEntity): AcCombatState {
  let s = states.get(ac);
  if (!s) {
    s = {
      prevFireWeapon: false,
      prevFlare: false,
      prevChaff: false,
      flareLeft: 0,
      flareTimer: 0,
      flareRepeat: 0,
      chaffLeft: 0,
      chaffTimer: 0,
      chaffRepeat: 0,
      gunAccum: 0,
      roundCounter: 0,
      burstHit: false,
      lastGunsCall: -999,
      pending: null,
      bayHold: 0,
      rcsMultiplier: ac.rcsMultiplier ?? 1,
      stationMunitions: null,
      storesRef: null,
      contacts: new Map(),
      contactPool: [],
      lastSensorTime: -1,
      lockLostTimer: 0,
      designationStale: 0,
      lockTime: 1.5,
      groundPoint: new Vector3(),
      rwr: new Map(),
      rwrPool: [],
      incomingPool: [],
      ir: { state: 'off', targetId: null, direction: null },
      irDir: new Vector3(),
      lastRadio: -999,
      winchester: false,
    };
    states.set(ac, s);
  }
  return s;
}

/** Team of the human player (defaults to blue). */
export function playerTeam(world: SimWorld): Team {
  return world.player?.team ?? 'blue';
}

/** Emit a radio call. */
export function radio(ctx: CombatCtx, from: string, text: string, voice: VoiceId | undefined, team: Team, priority = 1): void {
  ctx.world.events.emit('radio', { from, text, voice, team, priority });
}

/** Box–Muller normal sample (mean 0, sd 1) from the context RNG. */
export function gaussian(rng: () => number): number {
  const u = Math.max(1e-9, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
