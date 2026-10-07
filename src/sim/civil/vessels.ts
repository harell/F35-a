/**
 * F35-A — civil merchant ships (neutral container ships and cruise liners): hull hit volume.
 *
 * A 270–290 m hull is far from the bounding sphere every other ground target uses, so blast and
 * gun hits on a civil ship are measured against its real footprint: a stadium (the keel segment
 * widened by half the beam) from the waterline up to the top of the superstructure.
 *
 * A civil train (#146) is longer still and bends with the track: its hull is its cars, each a box on the
 * rails (CarPose from sim/civil/rail.ts), and a car in a tunnel can't be hit.
 */
import { Vector3 } from 'three';
import { forwardOf } from '../../core/math';
import type { VesselClass } from '../../core/types';
import type { AnyEntity, GroundTargetEntity, TrainBody } from '../entities';
import { CAR_HEIGHT, CAR_LENGTH, CAR_WIDTH } from './rail';
import { VESSEL_DATA } from '../damage/tables';
import { isSuperyachtId } from '../../core/superyachts';

const _fwd = new Vector3();
const _p = new Vector3();

/** What the radio and the HUD call a ship of this class ("tanker"; the HUD upper-cases it). */
export function vesselNoun(v: VesselClass | null | undefined): string {
  return v === 'tanker' ? 'tanker' : v === 'cruise' ? 'cruise ship' : isSuperyachtId(v) ? 'yacht' : 'ship';
}

/** A named superyacht (#145: a neutral ship whose class is one of core/superyachts.ts). */
export function isSuperyacht(e: AnyEntity | null | undefined): e is GroundTargetEntity {
  return isCivilVessel(e) && isSuperyachtId(e.vessel);
}

/** A neutral merchant ship (has a vessel class). */
export function isCivilVessel(e: AnyEntity | null | undefined): e is GroundTargetEntity {
  return !!e && e.kind === 'ground' && e.vessel !== null && e.team === 'neutral';
}

/** A ground entity whose hit volume is its real long shape (a merchant ship's hull, a train's cars), not a sphere. */
export function hasLongHull(g: AnyEntity | null | undefined): g is GroundTargetEntity {
  return !!g && g.kind === 'ground' && (g.vessel !== null || !!g.train);
}

/** Distance (m) from `point` to a train's cars (0 inside one; Infinity while every car is underground). */
export function trainHullDistance(t: TrainBody, point: Vector3): number {
  let best = Infinity;
  for (const c of t.cars) {
    if (c.hidden) continue;
    const dx = point.x - c.x;
    const dz = point.z - c.z;
    const half = CAR_LENGTH[c.kind] / 2;
    if (Math.abs(dx) > half + best + 2 && Math.abs(dz) > half + best + 2) continue;
    const fx = Math.sin(c.heading);
    const fz = -Math.cos(c.heading);
    const along = Math.max(0, Math.abs(dx * fx + dz * fz) - half);
    const across = Math.max(0, Math.abs(dx * -fz + dz * fx) - CAR_WIDTH[c.kind] / 2);
    const y = point.y - c.y;
    const H = CAR_HEIGHT[c.kind];
    const vert = y > H ? y - H : y < 0 ? -y : 0;
    const d = Math.hypot(along, across, vert);
    if (d < best) best = d;
  }
  return best;
}

/** Distance (m) from `point` to the hull volume of a civil ship (0 inside it), or to a train's cars. */
export function vesselHullDistance(g: GroundTargetEntity, point: Vector3): number {
  if (g.train) return trainHullDistance(g.train, point);
  const v = VESSEL_DATA[g.vessel ?? 'container'];
  forwardOf(g.quaternion, _fwd);
  _fwd.y = 0;
  if (_fwd.lengthSq() < 1e-9) _fwd.set(0, 0, -1);
  else _fwd.normalize();
  const half = Math.max(0, (v.length - v.beam) / 2);
  const dx = point.x - g.position.x;
  const dz = point.z - g.position.z;
  const along = Math.max(-half, Math.min(half, dx * _fwd.x + dz * _fwd.z));
  const horiz = Math.max(0, Math.hypot(dx - _fwd.x * along, dz - _fwd.z * along) - v.beam / 2);
  const y = point.y - g.position.y;
  const vert = y > v.height ? y - v.height : y < -v.height * 0.25 ? -v.height * 0.25 - y : 0;
  return Math.hypot(horiz, vert);
}

/**
 * Does the segment a→b (a gun round's step) pass through the hull? Returns the fraction along the
 * segment of the first point inside, or -1. Sampled every ~4 m (rounds move ~17 m per step; the
 * narrowest hull dimension is the ~34 m beam), every 1.25 m along a train.
 */
export function vesselSegmentHit(g: GroundTargetEntity, a: Vector3, b: Vector3): number {
  const len = a.distanceTo(b);
  // a train car is 2.8 m wide: sample every 1.25 m along a round's step
  const n = Math.max(1, Math.ceil(len / (g.train ? 1.25 : 4)));
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    _p.lerpVectors(a, b, s);
    if (vesselHullDistance(g, _p) <= 0) return s;
  }
  return -1;
}
