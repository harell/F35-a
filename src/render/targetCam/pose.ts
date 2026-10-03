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
 *  - ships: a wide, slow orbit (~1.65× the hull length, 8–15° up) looking at mid-superstructure, so
 *    the whole 270–290 m hull, its smoke and the swell read in the small window. Where land (or the
 *    wharf a ship is moored at) blocks part of the circle, the camera swings to and fro over the
 *    widest stretch of open water instead of flying through the city.
 *
 * Everything here is allocation-free and three.js-math only so it can be unit tested without WebGL.
 */
import { Quaternion, Vector3 } from 'three';
import { COLLAPSE, headingDir } from '../../core/skyTower';
import type { AircraftType, GroundTargetType, SamType, VesselClass } from '../../core/types';
import { shipDims } from '../visuals/shipMotion';

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
  a320: 35.8,
  shahed136: 2.5,
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
  ad_boat: { dist: 30, lookY: 1.6 }, // a ~20 m fast boat, framed whole
};

/** Ground target framing scale (× entity radius) and limits. */
const GROUND_SCALE: Partial<Record<GroundTargetType, number>> = { bridge: 1.6, factory: 1.9, hangar: 2.2, suicide_boat: 3.2, missile_boat: 3.2 };

/**
 * Ship framing: orbit distance (× hull length), look-at height (fraction of the way from the
 * waterline up to the top of the superstructure), elevation band (rad) and orbit rate (rad/s).
 */
export const SHIP_FRAMING = {
  distK: 1.65,
  lookK: 0.55,
  elMin: (8 * Math.PI) / 180,
  elMax: (15 * Math.PI) / 180,
  rate: (2 * Math.PI) / 150,
};
/** Directions sampled around a ship to find open water for the orbit. */
const SHIP_RING = 32;

/** Never shorter than this far plane (m), however close the framing (a SAM site is framed from ~15 m). */
export const TARGET_CAM_MIN_FAR = 1_500;

/**
 * The short far plane reaches at least this many times the depth of the nearest ground in the frame
 * (targetCamGroundDepth): that ground then sits at half the far plane, where the atmosphere's haze
 * (smoothstep from 0.36 to 0.985 of the far plane) is still light, about 13 %.
 */
export const TARGET_CAM_GROUND_K = 2;

/**
 * Depth along the view axis (m) at which the bottom edge of the frame meets sea level: the nearest
 * ground the target camera can show. Infinity when the bottom edge points at or above the horizon.
 * @param height     camera height above sea level (m)
 * @param pitchDown  how far the view axis points below the horizon (rad)
 * @param halfFov    half the vertical field of view (rad)
 */
export function targetCamGroundDepth(height: number, pitchDown: number, halfFov: number): number {
  const down = pitchDown + halfFov; // the bottom edge's angle below the horizon
  if (down <= 0.01) return Infinity;
  return (Math.max(0, height) / Math.sin(down)) * Math.cos(halfFov);
}

/**
 * Far plane of the target camera (m). With a `range` (QualitySettings.targetCamRange, low quality) the
 * pass stops `range` metres past the target, so the distant terrain, the city and scenery beyond it are
 * frustum-culled instead of being drawn a second time; the fog reaches the horizon colour at the far
 * plane, so the cut reads as haze. A high target would then sit on blank haze (above about 4 km the
 * ground in the frame is all deeper than 8 km), so the plane also reaches TARGET_CAM_GROUND_K × the
 * nearest ground's depth. Never longer than the main camera's far plane.
 * @param mainFar      far plane of the main camera
 * @param distance     camera-to-target distance (the framing distance)
 * @param range        metres drawn past the target; 0 (or less) = the main camera's far plane
 * @param groundDepth  depth of the nearest ground in the frame (targetCamGroundDepth); 0 = ignore
 */
export function targetCamFar(mainFar: number, distance: number, range: number, groundDepth = 0): number {
  if (!(range > 0)) return mainFar;
  return Math.min(mainFar, Math.max(TARGET_CAM_MIN_FAR, distance + range, TARGET_CAM_GROUND_K * groundDepth));
}

/** Minimal entity shape the pose needs (aircraft / SAM / ground). */
export interface CamTarget {
  readonly kind: 'aircraft' | 'sam' | 'ground' | 'missile' | 'decoy';
  readonly type: string;
  readonly id: number;
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  readonly radius: number;
  /** Civil merchant ship class (ground 'ship'); null / absent for the corvette and everything else. */
  readonly vessel?: VesselClass | null;
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
  if (isShip(t)) return shipDims(t.vessel).length * SHIP_FRAMING.distK;
  const k = GROUND_SCALE[t.type as GroundTargetType] ?? 2.2;
  return Math.max(16, Math.min(260, t.radius * k));
}

function isShip(t: CamTarget): boolean {
  return t.kind === 'ground' && t.type === 'ship';
}

/** Look-at height (m above the waterline) for a ship: mid-superstructure. */
export function shipLookY(t: CamTarget): number {
  const d = shipDims(t.vessel);
  return d.deck + (d.height - d.deck) * SHIP_FRAMING.lookK;
}

/**
 * Orbit azimuth around a ship at `time`. With no water test (or water all round) it is a plain slow
 * orbit; otherwise the camera ping-pongs across the widest arc of the ring that is over water.
 */
export function shipOrbitAngle(t: CamTarget, time: number, d: number, waterAt?: (x: number, z: number) => boolean): number {
  const phase = time * SHIP_FRAMING.rate + t.id * 1.7;
  if (!waterAt) return phase;
  const step = (Math.PI * 2) / SHIP_RING;
  const px = t.position.x;
  const pz = t.position.z;
  // longest run of water samples around the (circular) ring: walk it twice so a run across the
  // start is seen whole
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  let runLen = 0;
  for (let i = 0; i < SHIP_RING * 2; i++) {
    const k = i % SHIP_RING;
    const a = k * step;
    if (waterAt(px + Math.sin(a) * d, pz + Math.cos(a) * d)) {
      if (runLen === 0) runStart = i;
      runLen++;
      if (runLen >= SHIP_RING) return phase; // open water all round: full orbit
      if (runLen > bestLen) {
        bestLen = runLen;
        bestStart = runStart;
      }
    } else runLen = 0;
  }
  if (bestLen === 0) return phase; // no water anywhere at this range (should not happen for a ship)
  // swing to and fro (eased ends) over the arc, a margin inside its edges
  const a0 = bestStart * step;
  const span = Math.max(0, (bestLen - 1) * step);
  const margin = Math.min(span * 0.15, step);
  const s = 0.5 - 0.5 * Math.cos(phase);
  return a0 + margin + (span - 2 * margin) * s;
}

const _off = new Vector3();
const _bodyUp = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();

/**
 * Compute the camera pose for `t` at time `time` (s).
 * @param surfaceAt  ground / sea surface height (m) at (x, z) — keeps the camera above the terrain
 * @param waterAt    is (x, z) open water? — keeps a ship's orbit off the land
 */
export function targetCamPose(
  t: CamTarget,
  time: number,
  out: CamPose,
  surfaceAt?: (x: number, z: number) => number,
  waterAt?: (x: number, z: number) => boolean,
): CamPose {
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
  } else if (isShip(t)) {
    const lookY = shipLookY(t);
    const ang = shipOrbitAngle(t, time, d, waterAt);
    const mid = (SHIP_FRAMING.elMin + SHIP_FRAMING.elMax) / 2;
    const el = mid + ((SHIP_FRAMING.elMax - SHIP_FRAMING.elMin) / 2) * Math.sin(time * 0.071 + t.id);
    out.look.set(t.position.x, t.position.y + lookY, t.position.z);
    out.position.set(t.position.x + Math.sin(ang) * Math.cos(el) * d, t.position.y + lookY + Math.sin(el) * d, t.position.z + Math.cos(ang) * Math.cos(el) * d);
    out.up.set(0, 1, 0);
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

/** Minimal landmark shape the tower shot needs (sim/landmarks.ts LandmarkEntity). */
export interface CamLandmark {
  /** Base of the axis (y = ground). */
  readonly base: Vector3;
  readonly height: number;
  readonly alive: boolean;
  /** Fall heading (rad, 0 = north, clockwise). */
  readonly fallHeading: number;
  /** Where the first enemy hit burns. */
  readonly damagePoint: Vector3;
}

/**
 * Sky Tower shot. The shaft is only ~12 m wide, so the camera comes as close as the shot allows: a hit
 * is framed from `hitDist` on the upper tower (the pod, the mast and the burning face: look-at
 * `hitLook` m up, or 50 m over a lower hit); the fall from `fallDist`, where the whole 328 m tower and
 * the ~330 m it falls out along the ground fit the 32° frame (look-at `fallK` of its height). The
 * camera sits `el` (`fallEl`) up, above the CBD roofs (≤ ~190 m), swung `side` off the hit / off square to the fall.
 */
export const LANDMARK_FRAMING = { hitDist: 500, hitLook: 205, fallDist: 680, fallK: 0.48, el: (9 * Math.PI) / 180, fallEl: (5 * Math.PI) / 180, side: (25 * Math.PI) / 180 };

/**
 * Camera pose for a landmark the PiP cuts to (the Sky Tower hit or collapsing). Standing (hit): the
 * whole tower from the side the hit came from, a little off it, so the blast and the fire on its face
 * show. Falling: side-on to the fall heading (a little behind square), looking at a point out along
 * the fall, so the upper section's whole arc down to the ground stays in the frame.
 */
export function landmarkCamPose(lm: CamLandmark, time: number, out: CamPose, surfaceAt?: (x: number, z: number) => number): CamPose {
  const F = LANDMARK_FRAMING;
  const d = lm.alive ? F.hitDist : F.fallDist;
  const lookY = lm.base.y + (lm.alive ? Math.max(120, Math.min(F.hitLook, lm.damagePoint.y - lm.base.y + 50)) : lm.height * F.fallK);
  let ax: number;
  let az: number;
  if (!lm.alive) {
    // side-on to the fall: the fall direction turned 90° (and F.side back towards the stump)
    const [fx, fz] = headingDir(lm.fallHeading);
    const reach = (COLLAPSE.breakHeight + lm.height) * 0.33; // about the middle of the fall's footprint
    out.look.set(lm.base.x + fx * reach, lookY, lm.base.z + fz * reach);
    const a = Math.PI / 2 + F.side;
    ax = fx * Math.cos(a) - fz * Math.sin(a);
    az = fx * Math.sin(a) + fz * Math.cos(a);
  } else {
    // from the hit's side (east face by default), swung F.side off it, drifting slowly
    let hx = lm.damagePoint.x - lm.base.x;
    let hz = lm.damagePoint.z - lm.base.z;
    const r = Math.hypot(hx, hz);
    if (r < 1e-3) {
      hx = 1;
      hz = 0;
    } else {
      hx /= r;
      hz /= r;
    }
    const a = F.side + 0.06 * Math.sin(time * 0.2);
    ax = hx * Math.cos(a) - hz * Math.sin(a);
    az = hx * Math.sin(a) + hz * Math.cos(a);
    out.look.set(lm.base.x, lookY, lm.base.z);
  }
  const el = lm.alive ? F.el : F.fallEl;
  const ch = Math.cos(el) * d;
  out.position.set(out.look.x + ax * ch, lookY + Math.sin(el) * d, out.look.z + az * ch);
  out.up.set(0, 1, 0);
  if (surfaceAt) {
    const floor = surfaceAt(out.position.x, out.position.z) + TARGET_CAM_MIN_AGL;
    if (out.position.y < floor) out.position.y = floor;
  }
  return out;
}

/* ───────────────────────── Weapon window (the player's missile / bomb) ───────────────────────── */

/** Vertical field of view of the weapon window's chase shot (deg): wider than the target shot. */
export const WEAPON_CAM_FOV = 46;

const _wf = new Vector3();
const _wu = new Vector3();
const _ws = new Vector3();

/**
 * Weapon window chase shot (hud/hmd/wpnCam.ts): behind the weapon along its flight path, a little above
 * and to one side, looking down the path turned part of the way to the target, so the weapon sits low
 * in the frame and the target comes into it as the weapon closes.
 * @param len  weapon length (m): the camera sits ~2.5 lengths back
 */
export function weaponCamPose(
  pos: { x: number; y: number; z: number },
  vel: { x: number; y: number; z: number },
  target: { x: number; y: number; z: number },
  len: number,
  out: CamPose,
): CamPose {
  _wf.set(vel.x, vel.y, vel.z);
  if (_wf.lengthSq() < 1) _wf.set(target.x - pos.x, target.y - pos.y, target.z - pos.z);
  if (_wf.lengthSq() < 1e-6) _wf.set(0, 0, -1);
  _wf.normalize();
  _wu.set(target.x - pos.x, target.y - pos.y, target.z - pos.z);
  const dist = _wu.length();
  if (dist > 1e-3) _wu.multiplyScalar(1 / dist);
  else _wu.copy(_wf);
  // side: horizontal, right of the flight path
  _ws.set(-_wf.z, 0, _wf.x);
  if (_ws.lengthSq() < 1e-6) _ws.set(1, 0, 0);
  _ws.normalize();
  const back = Math.max(6, len * 2.5);
  out.position.set(pos.x, pos.y, pos.z).addScaledVector(_wf, -back).addScaledVector(_ws, Math.max(1, len * 0.45));
  out.position.y += Math.max(1.2, len * 0.5);
  const ahead = Math.max(60, Math.min(250, dist));
  out.look.copy(_wf).multiplyScalar(0.65).addScaledVector(_wu, 0.35).normalize().multiplyScalar(ahead).add(pos as Vector3);
  out.up.set(0, 1, 0);
  return out;
}
