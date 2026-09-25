/**
 * F35-A — math helpers shared by all modules.
 * OWNERSHIP: orchestrator. Module agents may use but not edit (put private helpers in your own module).
 */
import { MathUtils, Quaternion, Vector3 } from 'three';

export const G = 9.80665;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const KNOTS_PER_MS = 1.943844;
export const FEET_PER_M = 3.280839;
export const FPM_PER_MS = 196.8504;
export const NM = 1852; // metres per nautical mile

export const clamp = MathUtils.clamp;
export const lerp = MathUtils.lerp;
export const smoothstep = (x: number, a: number, b: number) => MathUtils.smoothstep(x, a, b);

/** Wrap an angle to -π..π. */
export function wrapPi(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/** Wrap an angle to 0..2π. */
export function wrap2Pi(a: number): number {
  a %= Math.PI * 2;
  return a < 0 ? a + Math.PI * 2 : a;
}

/** Exponential smoothing factor for frame-rate independent damping. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** Move `current` towards `target` by at most `maxDelta`. */
export function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(current + maxDelta, target);
  return Math.max(current - maxDelta, target);
}

const _v = new Vector3();

/** Body forward (nose) direction in world space. */
export function forwardOf(q: Quaternion, out = new Vector3()): Vector3 {
  return out.set(0, 0, -1).applyQuaternion(q);
}
/** Body up direction in world space. */
export function upOf(q: Quaternion, out = new Vector3()): Vector3 {
  return out.set(0, 1, 0).applyQuaternion(q);
}
/** Body right-wing direction in world space. */
export function rightOf(q: Quaternion, out = new Vector3()): Vector3 {
  return out.set(1, 0, 0).applyQuaternion(q);
}

/** Heading (0 = north/-Z, clockwise, 0..2π) of a world direction. */
export function headingOf(dir: Vector3): number {
  return wrap2Pi(Math.atan2(dir.x, -dir.z));
}

/** Elevation angle of a world direction (rad, + = up). */
export function elevationOf(dir: Vector3): number {
  const h = Math.hypot(dir.x, dir.z);
  return Math.atan2(dir.y, h);
}

/** World direction from heading/pitch. */
export function dirFromHeadingPitch(heading: number, pitch: number, out = new Vector3()): Vector3 {
  const c = Math.cos(pitch);
  return out.set(Math.sin(heading) * c, Math.sin(pitch), -Math.cos(heading) * c);
}

/**
 * Quaternion for an aircraft with given heading, pitch and roll (rad), using this
 * project's conventions (nose = local -Z).
 */
export function quatFromHPR(heading: number, pitch: number, roll: number, out = new Quaternion()): Quaternion {
  // three.js rotation: yaw about +Y is nose-LEFT, so heading (clockwise) = -yaw.
  const qy = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -heading);
  const qx = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), pitch);
  const qz = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -roll);
  return out.copy(qy).multiply(qx).multiply(qz);
}

/** Extract heading/pitch/roll (rad) from an aircraft quaternion. */
export function hprFromQuat(q: Quaternion): { heading: number; pitch: number; roll: number } {
  const f = forwardOf(q, new Vector3());
  const u = upOf(q, new Vector3());
  const heading = headingOf(f);
  const pitch = Math.asin(clamp(f.y, -1, 1));
  // roll: angle between body up and the vertical plane containing forward
  const right = new Vector3().crossVectors(f, new Vector3(0, 1, 0));
  if (right.lengthSq() < 1e-8) return { heading, pitch, roll: 0 };
  right.normalize();
  const levelUp = new Vector3().crossVectors(right, f).normalize();
  let roll = Math.atan2(-u.dot(right), u.dot(levelUp));
  roll = wrapPi(roll);
  return { heading, pitch, roll };
}

/** Convert aerospace body rates (p,q,r) to a local three.js angular velocity vector. */
export function bodyRatesToLocal(p: number, q: number, r: number, out = new Vector3()): Vector3 {
  return out.set(q, -r, -p);
}

/**
 * Relative bearing/elevation of a world point as seen from an observer (rad).
 * bearing + = right of nose, elevation + = above the wing plane.
 */
export function relativeAngles(
  observerPos: Vector3,
  observerQuat: Quaternion,
  point: Vector3,
): { bearing: number; elevation: number; distance: number; offBoresight: number } {
  _v.copy(point).sub(observerPos);
  const distance = _v.length();
  const inv = observerQuat.clone().invert();
  const local = _v.clone().applyQuaternion(inv); // nose = -Z
  const bearing = Math.atan2(local.x, -local.z);
  const elevation = Math.atan2(local.y, Math.hypot(local.x, local.z));
  const offBoresight = distance > 1e-6 ? Math.acos(clamp(-local.z / distance, -1, 1)) : 0;
  return { bearing, elevation, distance, offBoresight };
}

/** Aspect angle: 0 = we look at the target's tail, π = its nose points at us. */
export function aspectAngle(targetPos: Vector3, targetVel: Vector3, fromPos: Vector3): number {
  const los = new Vector3().subVectors(targetPos, fromPos).normalize();
  const tv = targetVel.clone();
  if (tv.lengthSq() < 1e-6) return 0;
  tv.normalize();
  return Math.acos(clamp(los.dot(tv), -1, 1));
}

/** Seeded PRNG (mulberry32) for deterministic worlds. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const toKnots = (ms: number) => ms * KNOTS_PER_MS;
export const toFeet = (m: number) => m * FEET_PER_M;
export const toFpm = (ms: number) => ms * FPM_PER_MS;
export const toNm = (m: number) => m / NM;
