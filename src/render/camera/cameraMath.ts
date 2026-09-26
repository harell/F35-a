/**
 * Pure camera helpers (no DOM / WebGL) — unit tested in tests/render-camera.test.ts.
 */
import { Quaternion, Vector3 } from 'three';

export const DEG = Math.PI / 180;

/** Head look limits (cockpit/hud): ±160° yaw, -40°..+90° pitch. */
export const LOOK_LIMITS = { yaw: 160 * DEG, pitchMin: -40 * DEG, pitchMax: 90 * DEG };

export function clampLook(yaw: number, pitch: number, out: { yaw: number; pitch: number }): { yaw: number; pitch: number } {
  out.yaw = Math.max(-LOOK_LIMITS.yaw, Math.min(LOOK_LIMITS.yaw, yaw));
  out.pitch = Math.max(LOOK_LIMITS.pitchMin, Math.min(LOOK_LIMITS.pitchMax, pitch));
  return out;
}

const _qy = new Quaternion();
const _qx = new Quaternion();
const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);

/** Head rotation relative to the body: yaw + = look right, pitch + = look up (nose = -Z). */
export function headQuaternion(yaw: number, pitch: number, out: Quaternion): Quaternion {
  _qy.setFromAxisAngle(Y, -yaw);
  _qx.setFromAxisAngle(X, pitch);
  return out.copy(_qy).multiply(_qx);
}

/** Frame-rate independent exponential smoothing factor. */
export function smoothK(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

/**
 * Chase camera position: behind (+Z local) and above (+Y local) the aircraft, expressed in the
 * (smoothed) aircraft frame `q`. Returns world position in `out`.
 */
export function chasePosition(target: Vector3, q: Quaternion, dist: number, height: number, out: Vector3): Vector3 {
  return out.set(0, height, dist).applyQuaternion(q).add(target);
}

/** Keep a camera above the surface; returns true when it had to be lifted. */
export function clampAboveGround(pos: Vector3, groundY: number, clearance: number): boolean {
  const min = groundY + clearance;
  if (pos.y < min) {
    pos.y = min;
    return true;
  }
  return false;
}

/**
 * Fly-by anchor: ahead along the (horizontal) flight path, offset to the side and slightly up.
 * `vel` may be zero (then the aircraft's forward direction `fwd` is used).
 */
export function flybyAnchor(pos: Vector3, vel: Vector3, fwd: Vector3, lead: number, side: number, up: number, out: Vector3): Vector3 {
  let dx = vel.x;
  let dz = vel.z;
  let l = Math.hypot(dx, dz);
  if (l < 1) {
    dx = fwd.x;
    dz = fwd.z;
    l = Math.hypot(dx, dz) || 1;
  }
  dx /= l;
  dz /= l;
  // right-hand side of the horizontal track (−Z forward → right = (−dz, dx)·−1)
  const rx = -dz;
  const rz = dx;
  return out.set(pos.x + dx * lead + rx * side, pos.y + up + (vel.y / Math.max(1, vel.length())) * lead, pos.z + dz * lead + rz * side);
}

/** Has the jet passed the fly-by anchor (along its track) by more than `margin` metres? */
export function passedAnchor(anchor: Vector3, pos: Vector3, vel: Vector3, margin: number): boolean {
  const l = Math.hypot(vel.x, vel.y, vel.z) || 1;
  const along = ((pos.x - anchor.x) * vel.x + (pos.y - anchor.y) * vel.y + (pos.z - anchor.z) * vel.z) / l;
  return along > margin;
}

/** Orbit camera offset from yaw (around +Y, 0 = behind/south of target) and pitch (+ = above). */
export function orbitOffset(yaw: number, pitch: number, dist: number, out: Vector3): Vector3 {
  const c = Math.cos(pitch);
  return out.set(Math.sin(yaw) * c * dist, Math.sin(pitch) * dist, Math.cos(yaw) * c * dist);
}

/** Smooth pseudo-random shake signal in [-1, 1] (sum of incommensurate sines). */
export function shakeNoise(t: number, seed: number): number {
  return (Math.sin(t * 17.3 + seed) * 0.5 + Math.sin(t * 23.9 + seed * 2.1) * 0.3 + Math.sin(t * 41.7 + seed * 3.7) * 0.2);
}

/** Vertical FOV (deg) that keeps an object of `size` metres at `dist` metres at ~`frac` of the screen height. */
export function fovToFrame(size: number, dist: number, frac: number, minDeg: number, maxDeg: number): number {
  const f = (2 * Math.atan(size / (2 * Math.max(1, dist) * frac))) / DEG;
  return Math.max(minDeg, Math.min(maxDeg, f));
}

const _s1 = new Vector3();
const _s2 = new Vector3();

/**
 * Right-hand side vector of a direction, horizontal when possible (dir × worldUp). Falls back to
 * `fallback` when `dir` is (near) vertical. Returns a unit vector in `out`.
 */
export function sideOf(dir: Vector3, fallback: Vector3, out: Vector3): Vector3 {
  out.set(-dir.z, 0, dir.x); // dir × (0,1,0)
  if (out.lengthSq() < 1e-4) out.copy(fallback);
  return out.normalize();
}

/** Padlock framing constants (reviewer: ~20 m up, ~15 m to the side, back distance capped ~35 m). */
export const PADLOCK = { up: 20, side: 15, backMin: 22, backMax: 35 };

/**
 * Over-the-shoulder padlock pose: the camera sits behind the jet on the (smoothed) jet→target line,
 * lifted `PADLOCK.up` and offset `PADLOCK.side` to the right, so the jet sits low-left and the target
 * upper-right. The look direction bisects the directions to the jet and the target, which keeps both
 * in frame for any range. `back` grows slightly with the jet's chase distance but is capped at 35 m.
 */
export function padlockPose(jet: Vector3, tgt: Vector3, tgtDir: Vector3, chaseDist: number, outPos: Vector3, outLook: Vector3): void {
  const back = Math.max(PADLOCK.backMin, Math.min(PADLOCK.backMax, chaseDist * 1.2));
  // offsets in the plane perpendicular to the line of sight (so steep LOS still frames both)
  sideOf(tgtDir, X, _s1);
  _s2.crossVectors(_s1, tgtDir).normalize(); // 'up' perpendicular to the LOS
  if (_s2.y < 0) _s2.negate();
  outPos.copy(jet).addScaledVector(tgtDir, -back).addScaledVector(_s1, PADLOCK.side).addScaledVector(_s2, PADLOCK.up);
  // bisector of the unit directions camera→jet and camera→target
  _s1.copy(jet).sub(outPos).normalize();
  _s2.copy(tgt).sub(outPos);
  if (_s2.lengthSq() < 1) _s2.copy(tgtDir);
  _s2.normalize();
  outLook.copy(_s1).add(_s2);
  if (outLook.lengthSq() < 1e-6) outLook.copy(tgtDir);
  outLook.normalize();
}

/** Missile camera framing: rigid along-track behind the missile, lifted and to the right. */
export const MISSILE_CAM = { back: 3.5, up: 1.3, side: 2.0, aheadLook: 60 };

/**
 * Missile camera pose (rigid along-track: no lag, so the missile body, motor flame and trail stay
 * large in the lower-left of the frame at any speed). `side` is the (smoothed) lateral unit vector.
 * The look point is ahead along the track; when a target is known it is pulled toward the target
 * (up to 25% of the view) so the target is in frame too.
 */
export function missileCamPose(
  mPos: Vector3,
  fwd: Vector3,
  side: Vector3,
  length: number,
  tgt: Vector3 | null,
  outPos: Vector3,
  outAim: Vector3,
): void {
  outPos
    .copy(mPos)
    .addScaledVector(fwd, -(MISSILE_CAM.back + length))
    .addScaledVector(side, MISSILE_CAM.side);
  outPos.y += MISSILE_CAM.up;
  outAim.copy(mPos).addScaledVector(fwd, MISSILE_CAM.aheadLook);
  if (tgt) {
    _s1.copy(tgt).sub(outPos);
    const r = _s1.length();
    if (r > 1) {
      _s1.divideScalar(r);
      _s2.copy(outAim).sub(outPos).normalize();
      // only bias toward targets that are roughly ahead (inside ±50°)
      if (_s1.dot(_s2) > 0.64) {
        _s2.lerp(_s1, 0.3).normalize();
        outAim.copy(outPos).addScaledVector(_s2, MISSILE_CAM.aheadLook);
      }
    }
  }
}

/**
 * Impact-linger pose: after the missile ends the camera freezes a spot behind/above/right of the
 * impact (along the final track) far enough to frame the fireball and falling wreck.
 */
export function impactPose(impact: Vector3, fwd: Vector3, side: Vector3, outPos: Vector3): Vector3 {
  return outPos.copy(impact).addScaledVector(fwd, -90).addScaledVector(side, 45).add(_s1.set(0, 28, 0));
}

/**
 * Tactical (MAP) camera: north-up top-down, centred on the player. Returns the camera height for a
 * wanted half-height ground coverage (metres, along the screen's short/vertical axis) at vertical
 * FOV `fovDeg`: halfHeight = height · tan(fov/2).
 */
export function tacticalHeight(halfCoverage: number, fovDeg: number): number {
  return halfCoverage / Math.tan((fovDeg * DEG) / 2);
}
export function tacticalCoverage(height: number, fovDeg: number): number {
  return height * Math.tan((fovDeg * DEG) / 2);
}
