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
  sa6: { radius: 35, health: 120, missiles: 6, explosion: 'huge' }, // Straight Flush + 3 launchers
  sa15: { radius: 10, health: 90, missiles: 8, explosion: 'large' },
  zsu23: { radius: 8, health: 60, missiles: 4, explosion: 'large' }, // "missiles" = ammo bursts
  ad_boat: { radius: 11, health: 50, missiles: 4, explosion: 'large' }, // ~22 m fast boat, a few gun hits
};

export interface GroundTargetData {
  radius: number;
  health: number;
  explosion: ExplosionSize;
  /** Sails on the sea surface. */
  naval: boolean;
}

export const GROUND_TARGET_DATA: Record<GroundTargetType, GroundTargetData> = {
  bunker: { radius: 22, health: 260, explosion: 'huge', naval: false },
  fuel: { radius: 18, health: 60, explosion: 'huge', naval: false },
  hangar: { radius: 25, health: 200, explosion: 'huge', naval: false },
  parked_jet: { radius: 9, health: 40, explosion: 'large', naval: false },
  ship: { radius: 60, health: 400, explosion: 'huge', naval: true },
  // Rat navy fast boats (sim/boats.ts): small, unarmoured, a short gun burst sinks one
  suicide_boat: { radius: 8, health: 40, explosion: 'huge', naval: true }, // ~16 m, packed with explosive
  missile_boat: { radius: 9, health: 50, explosion: 'large', naval: true }, // Peykaap II, ~17 m
  stoat: { radius: 0.2, health: 1, explosion: 'tiny', naval: false }, // g03: 0.38 m nose to tail tip, 0.3 kg
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

/**
 * A mission-flagged civil ship that takes more than one hit (GroundTargetEntity.hitsToSink > 1, the
 * escorted tanker) keeps sailing after a bomb / missile hit, burning and this much slower per hit.
 */
export const VESSEL_HIT_SPEED_FACTOR = 0.8;

/** Civil merchant ships (neutral 'ship' entities with a VesselClass). */
export const VESSEL_DATA: Record<VesselClass, VesselData> = {
  container: { length: 270, beam: 34, height: 40, health: 2_800 },
  cruise: { length: 290, beam: 36, height: 52, health: 3_200 },
  // Aframax-size crude carrier: low freeboard when laden, accommodation block and funnel aft
  tanker: { length: 250, beam: 44, height: 40, health: 3_000 },
};

/** Hit points of aircraft types that are not the default 100 (AircraftEntity.maxHealth). */
export const AIRCRAFT_HEALTH: Partial<Record<AircraftType, number>> = {
  // Shahed-136: two or three GAU-22 hits (~16–20 each) bring it down, any missile warhead kills it
  shahed136: 30,
};

/**
 * Warhead of a one-way attack drone: wherever it is destroyed (shot down, crashed or on its
 * target) it detonates, damaging every other live aircraft within `radius` (full `damage` inside
 * `fullRadius`, linear falloff to 0 at `radius`). Other drones are spared, so one missile can't
 * clear a whole formation by chain reaction. Applied by the world as 'flak' (not a missile hit).
 */
export interface WarheadData {
  damage: number;
  fullRadius: number;
  radius: number;
}

export const AIRCRAFT_WARHEAD: Partial<Record<AircraftType, WarheadData>> = {
  // ~50 kg warhead: a point-blank gun kill costs the player a real chunk of health
  shahed136: { damage: 40, fullRadius: 30, radius: 150 },
};

/** Explosion for an aircraft blowing up (in the air or on impact). */
export function aircraftExplosion(type: AircraftType): ExplosionSize {
  return type === 'a320' ? 'huge' : 'large';
}
