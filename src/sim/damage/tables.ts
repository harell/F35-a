/**
 * F35-A — static per-type data for ground entities (SIM-CORE): bounding radius, hit points,
 * missiles carried and the explosion played when destroyed.
 */
import type { AircraftType, ExplosionSize, GroundTargetType, SamType, VesselClass } from '../../core/types';

export interface SamSiteData {
  radius: number;
  health: number;
  /** Ready rounds (the COMBAT module may override). */
  missiles: number;
  explosion: ExplosionSize;
}

export const SAM_SITE_DATA: Record<SamType, SamSiteData> = {
  sa10: { radius: 45, health: 160, missiles: 8, explosion: 'huge' }, // Flap Lid + TELs spread out
  sa6: { radius: 35, health: 120, missiles: 6, explosion: 'huge' }, // Straight Flush + 3 launchers
  sa8: { radius: 10, health: 80, missiles: 6, explosion: 'large' },
  sa15: { radius: 10, health: 90, missiles: 8, explosion: 'large' },
  sa18: { radius: 6, health: 30, missiles: 4, explosion: 'large' },
  zsu23: { radius: 8, health: 60, missiles: 4, explosion: 'large' }, // "missiles" = ammo bursts
};

export interface GroundTargetData {
  radius: number;
  health: number;
  explosion: ExplosionSize;
  /** Radar emitter (shows on RWR / AARGM target). */
  emitter: boolean;
  /** Sails on the sea surface. */
  naval: boolean;
}

export const GROUND_TARGET_DATA: Record<GroundTargetType, GroundTargetData> = {
  ewr: { radius: 15, health: 80, explosion: 'large', emitter: true, naval: false },
  bunker: { radius: 22, health: 260, explosion: 'huge', emitter: false, naval: false },
  fuel: { radius: 18, health: 60, explosion: 'huge', emitter: false, naval: false },
  hangar: { radius: 25, health: 200, explosion: 'huge', emitter: false, naval: false },
  parked_jet: { radius: 9, health: 40, explosion: 'large', emitter: false, naval: false },
  truck: { radius: 5, health: 30, explosion: 'large', emitter: false, naval: false },
  tank: { radius: 5, health: 70, explosion: 'large', emitter: false, naval: false },
  ship: { radius: 60, health: 400, explosion: 'huge', emitter: false, naval: true },
  factory: { radius: 40, health: 300, explosion: 'huge', emitter: false, naval: false },
  bridge: { radius: 40, health: 300, explosion: 'huge', emitter: false, naval: false },
};

export interface VesselData {
  /** Overall length (m); the entity's bounding radius is half of it. */
  length: number;
  /** Beam (m). */
  beam: number;
  /** Height of the hull + superstructure above the waterline (m), for hit tests and framing. */
  height: number;
  /**
   * Hit points. Any bomb / missile hit sinks a civil ship outright (Damage.damageStructure); this
   * only paces the gun: a full 1.5 s GAU-22 pass with the pipper held on the hull does ~1,300, so
   * it takes 2–3 passes (tests/civil-shipping.test.ts measures it).
   */
  health: number;
}

/** Civil merchant ships (neutral 'ship' entities with a VesselClass). */
export const VESSEL_DATA: Record<VesselClass, VesselData> = {
  container: { length: 270, beam: 34, height: 40, health: 2_800 },
  cruise: { length: 290, beam: 36, height: 52, health: 3_200 },
};

/** Explosion for an aircraft blowing up (in the air or on impact). */
export function aircraftExplosion(type: AircraftType): ExplosionSize {
  return type === 'tu22m' || type === 'a50' || type === 'a320' ? 'huge' : 'large';
}
