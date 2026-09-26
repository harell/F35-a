/**
 * F35-A — allocation-free attitude helpers (same conventions as core/math quatFromHPR /
 * hprFromQuat: heading 0 = north (−Z) clockwise, pitch + nose up, roll + right wing down).
 */
import { Quaternion, Vector3 } from 'three';

const AX_X = new Vector3(1, 0, 0);
const AX_Y = new Vector3(0, 1, 0);
const AX_Z = new Vector3(0, 0, 1);
const _qa = new Quaternion();
const _qb = new Quaternion();
const _qc = new Quaternion();
const _f = new Vector3();
const _u = new Vector3();

/** Quaternion from heading / pitch / roll (rad), written into `out`. */
export function setQuatFromHPR(out: Quaternion, heading: number, pitch: number, roll: number): Quaternion {
  _qa.setFromAxisAngle(AX_Y, -heading);
  _qb.setFromAxisAngle(AX_X, pitch);
  _qc.setFromAxisAngle(AX_Z, -roll);
  return out.copy(_qa).multiply(_qb).multiply(_qc);
}

export interface Hpr {
  heading: number;
  pitch: number;
  roll: number;
}

/** Heading / pitch / roll from body forward & up world vectors, written into `out`. */
export function hprFromAxes(fwd: Vector3, up: Vector3, out: Hpr): Hpr {
  let heading = Math.atan2(fwd.x, -fwd.z);
  if (heading < 0) heading += Math.PI * 2;
  const fy = fwd.y > 1 ? 1 : fwd.y < -1 ? -1 : fwd.y;
  out.heading = heading;
  out.pitch = Math.asin(fy);
  // right-level = fwd × worldUp = (−fz, 0, fx)
  const rx = -fwd.z;
  const rz = fwd.x;
  const rl = Math.hypot(rx, rz);
  if (rl < 1e-6) {
    out.roll = 0;
    return out;
  }
  const nrx = rx / rl;
  const nrz = rz / rl;
  // level-up = right × fwd
  const lux = -nrz * fwd.y;
  const luy = nrz * fwd.x - nrx * fwd.z;
  const luz = nrx * fwd.y;
  const ur = up.x * nrx + up.z * nrz;
  const ul = up.x * lux + up.y * luy + up.z * luz;
  out.roll = Math.atan2(ur, ul);
  return out;
}

/** Heading / pitch / roll of a quaternion, written into `out`. */
export function hprFromQuaternion(q: Quaternion, out: Hpr): Hpr {
  _f.set(0, 0, -1).applyQuaternion(q);
  _u.set(0, 1, 0).applyQuaternion(q);
  return hprFromAxes(_f, _u, out);
}
