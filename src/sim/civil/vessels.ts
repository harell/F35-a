/**
 * F35-A — civil merchant ships (neutral container ships and cruise liners): hull hit volume.
 *
 * A 270–290 m hull is far from the bounding sphere every other ground target uses, so blast and
 * gun hits on a civil ship are measured against its real footprint: a stadium (the keel segment
 * widened by half the beam) from the waterline up to the top of the superstructure.
 */
import { Vector3 } from 'three';
import { forwardOf } from '../../core/math';
import type { VesselClass } from '../../core/types';
import type { AnyEntity, GroundTargetEntity } from '../entities';
import { VESSEL_DATA } from '../damage/tables';

const _fwd = new Vector3();
const _p = new Vector3();

/** What the radio and the HUD call a ship of this class ("tanker"; the HUD upper-cases it). */
export function vesselNoun(v: VesselClass | null | undefined): string {
  return v === 'tanker' ? 'tanker' : v === 'cruise' ? 'cruise ship' : 'ship';
}

/** A neutral merchant ship (has a vessel class). */
export function isCivilVessel(e: AnyEntity | null | undefined): e is GroundTargetEntity {
  return !!e && e.kind === 'ground' && e.vessel !== null && e.team === 'neutral';
}

/** Distance (m) from `point` to the hull volume of a civil ship (0 inside it). */
export function vesselHullDistance(g: GroundTargetEntity, point: Vector3): number {
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
 * narrowest hull dimension is the ~34 m beam).
 */
export function vesselSegmentHit(g: GroundTargetEntity, a: Vector3, b: Vector3): number {
  const len = a.distanceTo(b);
  const n = Math.max(1, Math.ceil(len / 4));
  for (let i = 0; i <= n; i++) {
    const s = i / n;
    _p.lerpVectors(a, b, s);
    if (vesselHullDistance(g, _p) <= 0) return s;
  }
  return -1;
}
