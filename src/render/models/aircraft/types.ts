/**
 * Aircraft prototype metadata: what the per-instance AircraftVisual needs to animate a model.
 */
import type { Group } from 'three';
import type { AircraftType, MunitionId, WeaponId } from '../../../core/types';
import type { V3 } from '../specs';

/**
 * How an animated part is driven (angles in radians about the pivot's local X axis):
 *  stab      all-moving tailplane: elevator·max − side·aileron·extra
 *  flaperon  flaps·extra − side·aileron·max
 *  aileron   −side·aileron·max
 *  lef       leading-edge flap: −clamp(alpha·1.2, 0, max)
 *  rudder    rudder·max + side·airbrake·extra (split-rudder speed brake)
 *  airbrake  −airbrake·max (panel lifts)
 *  door      bayDoors·max (signed open angle)
 *  radome    continuous rotation at `max` rad/s
 *  canard    −elevator·max (foreplane, opposite sense)
 *  gear      landing gear leg: (1 − gear)·max (folded = retracted; hidden once fully up)
 *  nozzle    variable-area exhaust nozzle: not a rotation — morph target 0 (closed → open) is set
 *            to nozzleOpening(rpm, ab); flames scale their exit radius from `extra` (closed) to
 *            `max` (open), both relative to the spec engine radius
 */
export type DriveKind =
  | 'stab'
  | 'flaperon'
  | 'aileron'
  | 'lef'
  | 'rudder'
  | 'airbrake'
  | 'door'
  | 'radome'
  | 'canard'
  | 'gear'
  | 'nozzle';

export interface DriveDef {
  part: string;
  kind: DriveKind;
  side: -1 | 0 | 1;
  max: number;
  extra?: number;
}

/** Nozzle opening at ground/flight idle (petals partly open to dump idle thrust). */
export const NOZZLE_IDLE_OPEN = 0.65;
const RPM_IDLE = 0.63;
const RPM_MIL = 1.0;

/**
 * Variable-area nozzle schedule (F119/F135 style): open at idle, closing to the minimum exit area
 * at MIL, then opening again with afterburner. 0 = closed (MIL), 1 = fully open (max AB).
 */
export function nozzleOpening(rpm: number, ab: number): number {
  const t = Math.min(1, Math.max(0, (rpm - RPM_IDLE) / (RPM_MIL - RPM_IDLE)));
  const dry = NOZZLE_IDLE_OPEN * (1 - t * t * (3 - 2 * t));
  const a = Math.min(1, Math.max(0, ab));
  return dry + (1 - dry) * a;
}

/** A position where a store can be displayed. */
export interface StoreSlot {
  pos: V3;
  internal: boolean;
  /** Weapons that may sit here, in preference order of assignment. */
  accepts: WeaponId[];
  /** Side for alternating assignment (-1 left, 1 right). */
  side: -1 | 1;
  /** Name of the pylon mesh to show when this slot is loaded (external). */
  pylon?: string;
}

export interface AircraftPrototype {
  type: AircraftType;
  lod0: Group;
  lod1: Group;
  drives: DriveDef[];
  slots: StoreSlot[];
  /** Fixed visual missiles for AI aircraft (hidden progressively as stores deplete). */
  fixedStores: { munition: MunitionId; pos: V3 }[];
  triangles: number;
  /**
   * Drawn instanced (the civil helicopters: visuals/HeliBatch.ts, one draw call per type): the AircraftVisual keeps
   * no meshes of its own, only the pose, LOD distance and light anchors.
   */
  instanced?: boolean;
}
