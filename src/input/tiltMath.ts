/**
 * F35-A input — tilt steering math (pure, unit-tested in tests/ui-tilt.test.ts).
 *
 * DeviceOrientation gives intrinsic Z-X'-Y'' Euler angles (alpha, beta, gamma) of the DEVICE frame
 * (portrait axes: +x right edge, +y top edge, +z out of the screen). Euler angles jump when a
 * landscape phone passes vertical (gamma wraps ±90°, beta flips by 180°), so we never use them
 * directly: we rebuild the world "up" vector in device coordinates (continuous for any pose),
 * rotate it into SCREEN axes using screen.orientation.angle (0/90/180/270), then derive
 *   bank  = how far the screen's vertical axis leans left/right (steering-wheel roll)
 *   tiltBack = how far the screen is tilted back from vertical (0 = upright, 90° = flat on a table)
 */
import { clamp, expo } from './curves';

const D2R = Math.PI / 180;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** World up (opposite of gravity) expressed in device coordinates, from beta/gamma in degrees. */
export function deviceUpVector(betaDeg: number, gammaDeg: number, out: Vec3): Vec3 {
  const b = betaDeg * D2R;
  const g = gammaDeg * D2R;
  const cb = Math.cos(b);
  out.x = -Math.sin(g) * cb;
  out.y = Math.sin(b);
  out.z = Math.cos(g) * cb;
  return out;
}

/**
 * Rotate a device-frame vector into screen axes (+x right on screen, +y up on screen, +z out of screen)
 * for the current screen orientation angle (degrees, counter-clockwise device rotation: 90 = top of
 * the phone to the left, 270 = top of the phone to the right).
 */
export function deviceToScreen(v: Vec3, angleDeg: number, out: Vec3): Vec3 {
  const a = (((angleDeg % 360) + 360) % 360) * D2R;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const x = v.x * c - v.y * s;
  const y = v.x * s + v.y * c;
  out.x = x;
  out.y = y;
  out.z = v.z;
  return out;
}

export interface TiltAngles {
  /** Steering-wheel angle (rad), + = rotated clockwise / right side down (turn right). */
  bank: number;
  /** Tilt back from vertical (rad): 0 = screen upright facing you, π/2 = flat, face up. */
  back: number;
}

/**
 * Below this screen-vertical gravity component the wheel angle is damped, so a phone lying almost
 * flat (where the in-plane gravity direction is mostly sensor noise) doesn't twitch.
 */
export const WHEEL_FLOOR = 0.35;

/**
 * Screen-space up vector → steering angles.
 *  bank: angle of gravity within the screen plane (rotation about the screen normal, like a steering
 *        wheel) — independent of how far back the phone is tilted, damped near flat.
 *  back: elevation of the screen normal (independent of the wheel angle).
 */
export function tiltAnglesFromUp(up: Vec3, out: TiltAngles): TiltAngles {
  // right side down → world up leans towards screen-left → up.x < 0 → positive bank
  out.bank = Math.atan2(-up.x, Math.max(up.y, WHEEL_FLOOR));
  out.back = Math.atan2(up.z, Math.hypot(up.x, up.y));
  return out;
}

const _up: Vec3 = { x: 0, y: 0, z: 0 };
const _scr: Vec3 = { x: 0, y: 0, z: 0 };

/** beta/gamma (deg) + screen angle → steering angles (rad). */
export function tiltAngles(betaDeg: number, gammaDeg: number, screenAngleDeg: number, out: TiltAngles): TiltAngles {
  deviceUpVector(betaDeg, gammaDeg, _up);
  deviceToScreen(_up, screenAngleDeg, _scr);
  return tiltAnglesFromUp(_scr, out);
}

export interface TiltCalibration {
  /** Neutral bank (rad). */
  bank: number;
  /** Neutral tilt-back (rad). */
  back: number;
}

/** Default neutral: level, screen tilted back ~35° (a relaxed two-hand grip). */
export const DEFAULT_TILT_NEUTRAL: TiltCalibration = { bank: 0, back: 35 * D2R };

export interface TiltShape {
  /** Bank (rad) for full roll at sensitivity 1. */
  maxBank: number;
  /** Tilt (rad) for full pitch at sensitivity 1. */
  maxPitch: number;
  /** Deadzone (rad). */
  deadzone: number;
  expo: number;
}

export const TILT_SHAPE: TiltShape = { maxBank: 32 * D2R, maxPitch: 24 * D2R, deadzone: 2.5 * D2R, expo: 0.3 };

/** Signed angle difference wrapped to -π..π. */
export function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function axis(delta: number, max: number, dz: number, e: number): number {
  const a = Math.abs(delta);
  if (a <= dz) return 0;
  const v = clamp((a - dz) / Math.max(1e-3, max - dz), 0, 1);
  return Math.sign(delta) * expo(v, e);
}

/**
 * Steering angles → stick axes (-1..1).
 *   roll  +1 = bank right
 *   pitch +1 = nose up = top edge tilted TOWARDS the pilot (screen more upright than neutral),
 *   unless invertPitch.
 */
export function tiltToAxes(
  angles: TiltAngles,
  neutral: TiltCalibration,
  sensitivity: number,
  invertPitch: boolean,
  out: { roll: number; pitch: number },
  shape: TiltShape = TILT_SHAPE,
): { roll: number; pitch: number } {
  const s = clamp(sensitivity, 0.25, 2);
  out.roll = axis(angleDiff(angles.bank, neutral.bank), shape.maxBank / s, shape.deadzone, shape.expo);
  const p = axis(angleDiff(neutral.back, angles.back), shape.maxPitch / s, shape.deadzone, shape.expo);
  out.pitch = invertPitch ? -p : p;
  if (out.roll === 0) out.roll = 0;
  if (out.pitch === 0) out.pitch = 0;
  return out;
}
