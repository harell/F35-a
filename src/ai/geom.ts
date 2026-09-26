/**
 * F35-A — AI geometry helpers (allocation free).
 *
 * All functions write into caller-supplied vectors or return scalars. Conventions follow
 * core/types.ts: world +Y up, −Z north, body nose = local −Z.
 *
 * Vocabulary used throughout the AI (standard fighter-pilot terms):
 *  ATA  antenna train angle — angle between OUR nose/velocity and the line of sight to the bandit
 *  AA   aspect angle — angle between the bandit's velocity and the LOS from us to it
 *       (0 = we sit at its six o'clock, π = it points at us)
 *  HCA  heading crossing angle — angle between both velocity vectors
 */
import { Vector3 } from 'three';

const _a = new Vector3();
const _b = new Vector3();

export const UP = Object.freeze(new Vector3(0, 1, 0)) as Vector3;

/** Clamp to [lo, hi]. */
export function clampN(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Angle (rad) between two vectors (need not be normalised). */
export function angleBetween(a: Vector3, b: Vector3): number {
  const la = a.length();
  const lb = b.length();
  if (la < 1e-9 || lb < 1e-9) return 0;
  const c = a.dot(b) / (la * lb);
  return Math.acos(c > 1 ? 1 : c < -1 ? -1 : c);
}

/** Unit direction from `from` to `to`, written into `out`. Returns the distance. */
export function dirTo(from: Vector3, to: Vector3, out: Vector3): number {
  out.subVectors(to, from);
  const d = out.length();
  if (d > 1e-6) out.multiplyScalar(1 / d);
  else out.set(0, 0, -1);
  return d;
}

/** Unit horizontal direction for a heading (0 = north, clockwise). */
export function headingDir(heading: number, out: Vector3): Vector3 {
  return out.set(Math.sin(heading), 0, -Math.cos(heading));
}

/** Heading (0..2π, 0 = north, clockwise) of a world vector's horizontal part. */
export function headingOfVec(v: Vector3): number {
  const h = Math.atan2(v.x, -v.z);
  return h < 0 ? h + Math.PI * 2 : h;
}

/**
 * Direction with the horizontal heading of `horiz` and a flight-path (elevation) angle `gamma`.
 * `horiz` may have any vertical component (ignored). Written into `out`.
 */
export function dirWithElevation(horiz: Vector3, gamma: number, out: Vector3): Vector3 {
  let hx = horiz.x;
  let hz = horiz.z;
  const hl = Math.hypot(hx, hz);
  if (hl < 1e-6) {
    hx = 0;
    hz = -1;
  } else {
    hx /= hl;
    hz /= hl;
  }
  const c = Math.cos(gamma);
  return out.set(hx * c, Math.sin(gamma), hz * c);
}

/** Elevation angle (rad, + up) of a direction vector. */
export function elevationOfVec(v: Vector3): number {
  return Math.atan2(v.y, Math.hypot(v.x, v.z));
}

/**
 * Aspect angle of a target as seen from `from` (0 = we are at its six, π = it faces us).
 * Returns 0 for a (near) stationary target.
 */
export function aspectOf(targetPos: Vector3, targetVel: Vector3, from: Vector3): number {
  _a.subVectors(targetPos, from); // LOS from us to target
  const sp = targetVel.length();
  const d = _a.length();
  if (sp < 1 || d < 1) return 0;
  const c = _a.dot(targetVel) / (d * sp);
  return Math.acos(c > 1 ? 1 : c < -1 ? -1 : c);
}

/** Closure rate (m/s, + = closing) between two moving points. */
export function closureRate(pA: Vector3, vA: Vector3, pB: Vector3, vB: Vector3): number {
  _a.subVectors(pB, pA);
  const d = _a.length();
  if (d < 1e-6) return 0;
  _b.subVectors(vA, vB);
  return _b.dot(_a) / d;
}

/**
 * Lead-collision intercept: time t at which a shooter flying straight at `speed` from `p`
 * meets a target at `tp` moving with `tv`. Returns -1 when no intercept exists (target too fast
 * and opening). Writes the intercept point into `out` (pure-pursuit point when no solution).
 */
export function interceptPoint(p: Vector3, speed: number, tp: Vector3, tv: Vector3, out: Vector3, maxTime = 180): number {
  _a.subVectors(tp, p);
  const a = tv.lengthSq() - speed * speed;
  const b = 2 * _a.dot(tv);
  const c = _a.lengthSq();
  let t = -1;
  if (Math.abs(a) < 1e-6) {
    if (Math.abs(b) > 1e-6) t = -c / b;
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      const t1 = (-b - s) / (2 * a);
      const t2 = (-b + s) / (2 * a);
      const lo = Math.min(t1, t2);
      const hi = Math.max(t1, t2);
      t = lo > 0 ? lo : hi > 0 ? hi : -1;
    }
  }
  if (t < 0 || t > maxTime) {
    out.copy(tp);
    return -1;
  }
  out.copy(tp).addScaledVector(tv, t);
  return t;
}

/**
 * Closest point of approach between two constant-velocity bodies.
 * Returns time to CPA (≥ 0) and writes the relative position at CPA (B − A) into `outRel`.
 */
export function cpa(pA: Vector3, vA: Vector3, pB: Vector3, vB: Vector3, outRel: Vector3): number {
  outRel.subVectors(pB, pA);
  _b.subVectors(vB, vA);
  const vv = _b.lengthSq();
  let t = vv > 1e-6 ? -outRel.dot(_b) / vv : 0;
  if (t < 0) t = 0;
  outRel.addScaledVector(_b, t);
  return t;
}

/**
 * Rotate the horizontal part of `v` by `angle` (rad, + = clockwise seen from above / to the right).
 * Written into `out` (vertical component copied).
 */
export function rotateHorizontal(v: Vector3, angle: number, out: Vector3): Vector3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  // heading h: x = sin h, z = -cos h. Adding `angle` to h:
  const x = v.x * c - v.z * s;
  const z = v.z * c + v.x * s;
  return out.set(x, v.y, z);
}

/** Signed horizontal angle (rad) from direction `a` to direction `b` (+ = b is to the right of a). */
export function signedHorizAngle(a: Vector3, b: Vector3): number {
  const ha = Math.atan2(a.x, -a.z);
  const hb = Math.atan2(b.x, -b.z);
  let d = hb - ha;
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Wrap an angle to −π..π. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}
