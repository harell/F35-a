/**
 * F35-A input — pure shaping functions (no DOM). Unit-tested in tests/ui-curves.test.ts.
 *
 *  - stick shaping: radial deadzone → circle-to-square stretch → per-axis expo
 *  - throttle lever ↔ throttle mapping with a MIL detent gate before the afterburner zone
 *  - generic helpers: expo, clamp, frame-rate independent low-pass
 */
import { AB_DETENT } from '../core/types';

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Classic RC "expo": blends linear and cubic response. e = 0 → linear, e = 1 → pure cubic. */
export function expo(x: number, e: number): number {
  const a = Math.abs(x);
  const y = (1 - e) * a + e * a * a * a;
  return x < 0 ? -y : y;
}

/** Frame-rate independent exponential smoothing towards `target` with time constant `tau` (s). */
export function lowPass(prev: number, target: number, dt: number, tau: number): number {
  if (tau <= 0) return target;
  const k = 1 - Math.exp(-dt / tau);
  return prev + (target - prev) * k;
}

/** Shaping parameters derived from the player's stick sensitivity setting (0.25..2). */
export interface StickShape {
  /** Knob travel radius (CSS px) for full deflection. */
  radius: number;
  /** Radial deadzone as a fraction of the radius. */
  deadzone: number;
  /** Expo blend 0..1. */
  expo: number;
}

/** Nominal knob radius (CSS px) at sensitivity 1 on a 390 px tall phone. */
export const STICK_RADIUS = 65;

/**
 * Higher sensitivity → shorter throw and a more linear centre; lower sensitivity → longer throw
 * and more expo (finer control around the centre). Full deflection is always reachable.
 */
export function stickShapeFor(sensitivity: number, scale = 1): StickShape {
  const s = clamp(sensitivity, 0.25, 2);
  return {
    radius: (STICK_RADIUS * scale) / (0.75 + 0.25 * s),
    deadzone: 0.06,
    expo: clamp(0.45 - 0.3 * (s - 1), 0.08, 0.7),
  };
}

export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Clamp a knob offset (px) to the travel circle. Returns the clamped offset in `out` (px) —
 * used for drawing the knob.
 */
export function clampToCircle(dx: number, dy: number, radius: number, out: Vec2): Vec2 {
  const m = Math.hypot(dx, dy);
  if (m > radius && m > 0) {
    out.x = (dx / m) * radius;
    out.y = (dy / m) * radius;
  } else {
    out.x = dx;
    out.y = dy;
  }
  return out;
}

/**
 * Knob offset (px, screen axes: +x right, +y down) → stick axes (-1..1).
 *   roll  = +1 full right
 *   pitch = +1 full aft (thumb pulled DOWN towards the pilot = nose up), unless `invertPitch`.
 * Steps: normalise + clamp to the unit circle → radial deadzone (rescaled so output is continuous)
 * → circle-to-square radial stretch (so diagonals reach full roll AND full pitch) → per-axis expo.
 */
export function shapeStick(dx: number, dy: number, shape: StickShape, invertPitch: boolean, out: { roll: number; pitch: number }): { roll: number; pitch: number } {
  let x = dx / shape.radius;
  let y = dy / shape.radius;
  let m = Math.hypot(x, y);
  if (m > 1) {
    x /= m;
    y /= m;
    m = 1;
  }
  if (m <= shape.deadzone || m === 0) {
    out.roll = 0;
    out.pitch = 0;
    return out;
  }
  // radial deadzone, rescaled to start from 0 at the deadzone edge
  const m2 = (m - shape.deadzone) / (1 - shape.deadzone);
  x = (x / m) * m2;
  y = (y / m) * m2;
  // circle → square stretch: along direction θ the magnitude m2 maps to max(|x|,|y|) = m2
  const mx = Math.max(Math.abs(x), Math.abs(y));
  if (mx > 0) {
    const k = m2 / mx;
    x *= k;
    y *= k;
  }
  out.roll = clamp(expo(x, shape.expo), -1, 1);
  const p = clamp(expo(y, shape.expo), -1, 1);
  out.pitch = invertPitch ? -p : p;
  // normalise -0
  if (out.roll === 0) out.roll = 0;
  if (out.pitch === 0) out.pitch = 0;
  return out;
}

/* ───────────────────────── Throttle lever with MIL detent ───────────────────────── */

/**
 * Lever travel (0 = bottom/IDLE, 1 = top/MAX AB) is split into:
 *   [0, LEVER_MIL]          IDLE … MIL (throttle 0 … AB_DETENT, linear)
 *   (LEVER_MIL, LEVER_AB)   detent gate: throttle stays at MIL — the thumb has to push through
 *   [LEVER_AB, 1]           afterburner zone (throttle AB_MIN … 1)
 * The AB zone gets ~22 % of the travel although it is only 10 % of the throttle axis, so the
 * afterburner stages are easy to modulate on a short phone slider.
 */
export const LEVER_MIL = 0.7;
export const LEVER_AB = 0.78;
/** Throttle value at the bottom of the AB zone (just past the detent = min AB). */
export const AB_MIN = AB_DETENT + 0.005;

export function leverToThrottle(lever: number): number {
  const l = clamp(lever, 0, 1);
  if (l <= LEVER_MIL) return (l / LEVER_MIL) * AB_DETENT;
  if (l < LEVER_AB) return AB_DETENT;
  return AB_MIN + ((l - LEVER_AB) / (1 - LEVER_AB)) * (1 - AB_MIN);
}

/** Inverse of leverToThrottle (throttle at exactly MIL maps to the detent line LEVER_MIL). */
export function throttleToLever(throttle: number): number {
  const t = clamp(throttle, 0, 1);
  if (t <= AB_DETENT) return (t / AB_DETENT) * LEVER_MIL;
  if (t < AB_MIN) return LEVER_AB;
  return LEVER_AB + ((t - AB_MIN) / (1 - AB_MIN)) * (1 - LEVER_AB);
}

/** Throttle zone for labels / haptic ticks. */
export type ThrottleZone = 'idle' | 'dry' | 'mil' | 'ab';

export function throttleZone(throttle: number): ThrottleZone {
  if (throttle <= 0.02) return 'idle';
  if (throttle > AB_DETENT + 1e-4) return 'ab';
  if (throttle >= AB_DETENT - 1e-4) return 'mil';
  return 'dry';
}

/** Double-tap on the lever: in AB → back to MIL; otherwise → max AB. */
export function throttleToggle(throttle: number): number {
  return throttle > AB_DETENT + 1e-4 ? AB_DETENT : 1;
}
