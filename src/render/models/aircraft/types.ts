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
 *  sweep     variable-geometry wing: −side·sweepFromSpeed (max = full sweep delta)
 *  radome    continuous rotation at `max` rad/s
 *  canard    −elevator·max (foreplane, opposite sense)
 *  gear      landing gear leg: (1 − gear)·max (folded = retracted; hidden once fully up)
 */
export type DriveKind = 'stab' | 'flaperon' | 'aileron' | 'lef' | 'rudder' | 'airbrake' | 'door' | 'sweep' | 'radome' | 'canard' | 'gear';

export interface DriveDef {
  part: string;
  kind: DriveKind;
  side: -1 | 0 | 1;
  max: number;
  extra?: number;
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
}
