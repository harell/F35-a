/**
 * Target camera (PiP) — pure framing maths.
 *
 * The target camera is a cinematic "beauty" view of the player's designated / locked target, rendered
 * into a small window (see TargetCam.ts and hud/hmd/pip.ts). It sits NEAR THE TARGET, not on the
 * player's jet:
 *
 *  - aircraft: rigidly attached to the target's body frame, ahead of the nose, slightly to one side and
 *    above, looking back at it. The target stays still in frame while the horizon, terrain and sky swing
 *    behind it as it manoeuvres.
 *  - SAM sites / ground targets: a slow orbit at low elevation around the site (radars spin, launchers
 *    slew — SiteVisuals animates them in the shared scene), never below the terrain.
 *
 * Everything here is allocation-free and three.js-math only so it can be unit tested without WebGL.
 */
import { Quaternion, Vector3 } from 'three';
import type { AircraftType, GroundTargetType, SamType } from '../../core/types';

/** Vertical field of view of the target camera (deg). */
export const TARGET_CAM_FOV = 32;
/** How much the aircraft shot rolls with the target (0 = level horizon, 1 = locked to its wings). */
export const AIR_ROLL_FOLLOW = 0.15;
/** Never closer to the ground than this (m above the surface). */
export const TARGET_CAM_MIN_AGL = 4;

/** Wingspans (m) — mirrors render/models/specs.ts (kept local: the pose maths must not pull in models). */
const AIRCRAFT_SPAN: Record<AircraftType, number> = {
  f35a: 10.7,
  mig29: 11.4,
  su27: 14.7,
  su35: 14.7,
  su57: 14.1,
  tu22m: 34.3,
  a50: 50.5,
};

/**
 * SAM framing: camera distance (m) and look-at height (m above the site origin). The orbit is centred
 * on the site origin, where the search radar vehicle sits (SA-6 Straight Flush, SA-8/SA-15 TELARs,
 * SA-10 Flap Lid with the Clam Shell mast and TELs around it).
 */
const SAM_FRAMING: Record<SamType, { dist: number; lookY: number }> = {
  sa6: { dist: 19, lookY: 2.6 },
  sa8: { dist: 17, lookY: 2.6 },
  sa10: { dist: 44, lookY: 6 },
  sa15: { dist: 17, lookY: 2.8 },
  sa18: { dist: 13, lookY: 1.2 },
  zsu23: { dist: 14, lookY: 1.8 },
};

/** Ground target framing scale (× entity radius) and limits. */
const GROUND_SCALE: Partial<Record<GroundTargetType, number>> = { ship: 2.6, bridge: 1.6, factory: 1.9, hangar: 2.2 };

/** Minimal entity shape the pose needs (aircraft / SAM / ground). */
export interface CamTarget {
  readonly kind: 'aircraft' | 'sam' | 'ground' | 'missile' | 'decoy';
  readonly type: string;
  readonly id: number;
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  readonly radius: number;
}

export interface CamPose {
  position: Vector3;
  /** Point the camera looks at. */
  look: Vector3;
  /** Camera up vector (unit). */
  up: Vector3;
}

export function makePose(): CamPose {
  return { position: new Vector3(), look: new Vector3(), up: new Vector3(0, 1, 0) };
}

/** Camera distance (m) used to frame a target. */
export function framingDistance(t: CamTarget): number {
  if (t.kind === 'aircraft') {
    const span = AIRCRAFT_SPAN[t.type as AircraftType] ?? Math.max(8, t.radius * 2);
    return span * 1.7;
  }
  if (t.kind === 'sam') return SAM_FRAMING[t.type as SamType]?.dist ?? 30;
  const k = GROUND_SCALE[t.type as GroundTargetType] ?? 2.2;
  return Math.max(16, Math.min(260, t.radius * k));
}

const _off = new Vector3();
const _bodyUp = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();

/**
 * Compute the camera pose for `t` at time `time` (s).
 * @param surfaceAt  ground / sea surface height (m) at (x, z) — keeps the camera above the terrain
 */
export function targetCamPose(t: CamTarget, time: number, out: CamPose, surfaceAt?: (x: number, z: number) => number): CamPose {
  const d = framingDistance(t);
  if (t.kind === 'aircraft') {
    // In front of the nose, measured in a LEVEL frame: horizontally ~13° off the nose heading, ~10°
    // above the horizon (so the camera looks slightly down and terrain / sea fill the background
    // whatever the jet's pitch), with a slow swing so the shot breathes.
    const yaw = 0.22 + 0.08 * Math.sin(time * 0.23);
    const el = 0.17 + 0.04 * Math.sin(time * 0.17 + 1.3);
    _fwd.set(0, 0, -1).applyQuaternion(t.quaternion);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 0.04) {
      // vertical climb / dive: the nose heading is undefined — any level direction will do, use the
      // one the canopy faces
      _fwd.set(0, 1, 0).applyQuaternion(t.quaternion);
      _fwd.y = 0;
      if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    }
    _fwd.normalize();
    _right.set(-_fwd.z, 0, _fwd.x);
    const ch = Math.cos(el) * d;
    _off.copy(_fwd).multiplyScalar(Math.cos(yaw) * ch).addScaledVector(_right, Math.sin(yaw) * ch);
    _off.y = Math.sin(el) * d;
    out.position.copy(t.position).add(_off);
    out.look.copy(t.position);
    // the horizon stays (nearly) level: the jet visibly banks and pulls against the scenery
    _bodyUp.set(0, 1, 0).applyQuaternion(t.quaternion);
    out.up.set(0, 1, 0).lerp(_bodyUp, AIR_ROLL_FOLLOW);
    if (out.up.lengthSq() < 1e-6) out.up.set(0, 1, 0);
    out.up.normalize();
  } else {
    // slow orbit (one lap ≈ 70 s), phase from the id so two sites never look identical
    const lookY = t.kind === 'sam' ? (SAM_FRAMING[t.type as SamType]?.lookY ?? 2.5) : Math.min(12, Math.max(1.5, t.radius * 0.18));
    const ang = time * 0.09 + t.id * 1.7;
    const el = 0.2;
    out.look.set(t.position.x, t.position.y + lookY, t.position.z);
    out.position.set(t.position.x + Math.sin(ang) * Math.cos(el) * d, t.position.y + lookY + Math.sin(el) * d, t.position.z + Math.cos(ang) * Math.cos(el) * d);
    out.up.set(0, 1, 0);
  }
  if (surfaceAt) {
    const floor = surfaceAt(out.position.x, out.position.z) + TARGET_CAM_MIN_AGL;
    if (out.position.y < floor) out.position.y = floor;
  }
  // degenerate up (looking straight along it): fall back to world up / body forward
  _fwd.copy(out.look).sub(out.position).normalize();
  _right.crossVectors(_fwd, out.up);
  if (_right.lengthSq() < 1e-6) out.up.set(0, 0, -1);
  return out;
}
