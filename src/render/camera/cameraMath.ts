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
