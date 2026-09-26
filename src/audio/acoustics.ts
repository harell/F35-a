/**
 * F35-A audio — pure acoustics helpers (no Web Audio, unit-tested in node).
 *
 *  - distance attenuation (inverse-distance law with a soft far fade)
 *  - air absorption as a low-pass cutoff
 *  - speed-of-sound propagation delay ("you see the flash, then hear the boom")
 *  - retarded-time propagation for moving sources: where the source WAS when it emitted
 *    the sound that reaches the listener now. This one function yields the flyby lag,
 *    correct Doppler geometry and the supersonic Mach cone (no solution ⇒ not heard yet).
 *  - Doppler factor, stereo pan, explosion audible ranges
 */
import type { ExplosionSize } from '../core/types';

/** Speed of sound at ~15 °C (m/s). */
export const SPEED_OF_SOUND = 343;

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

/**
 * Gain for a source at distance `d` (m).
 * @param ref       full volume inside this radius
 * @param maxDist   silent beyond this distance (smooth fade over the last 30 %)
 * @param exponent  1 = physical inverse-distance (−6 dB per doubling); < 1 = "gamey" softer fall-off
 */
export function distanceGain(d: number, ref: number, maxDist: number, exponent = 1): number {
  if (!(d >= 0)) return 0;
  if (d >= maxDist) return 0;
  const base = d <= ref ? 1 : Math.pow(ref / d, exponent);
  const fadeStart = maxDist * 0.7;
  if (d <= fadeStart) return base;
  const t = (d - fadeStart) / (maxDist - fadeStart);
  return base * (1 - t * t * (3 - 2 * t));
}

/**
 * Air absorption / distance "darkening" expressed as a low-pass cutoff (Hz).
 * ~9 kHz at 300 m, ~4 kHz at 1 km, ~1.6 kHz at 3 km, ~500 Hz at 10 km.
 */
export function airAbsorptionCutoff(d: number): number {
  return clamp(18000 / (1 + Math.max(0, d) / 300), 180, 18000);
}

/** Seconds for sound to travel `d` metres. */
export function soundDelay(d: number, c = SPEED_OF_SOUND): number {
  return Math.max(0, d) / c;
}

/** Has a sound front emitted `elapsed` seconds ago reached a listener `distance` away? */
export function soundArrived(elapsed: number, distance: number, c = SPEED_OF_SOUND): boolean {
  return elapsed * c >= distance;
}

/**
 * Retarded time τ ≥ 0 for a source moving with constant velocity V: the sound reaching the
 * listener now was emitted τ seconds ago at S − V·τ. Solves |D + V·τ| = c·τ with
 * D = listener − source (current positions).
 *
 * Returns −1 when no emission can have reached the listener yet — a supersonic source
 * approaching the listener from outside its Mach cone ("you don't hear it coming").
 * For supersonic sources inside the cone the most recent emission (smallest τ) is returned.
 */
export function retardedTime(dx: number, dy: number, dz: number, vx: number, vy: number, vz: number, c = SPEED_OF_SOUND): number {
  const dd = dx * dx + dy * dy + dz * dz;
  if (dd < 1e-6) return 0;
  const a = vx * vx + vy * vy + vz * vz - c * c;
  const b = 2 * (dx * vx + dy * vy + dz * vz);
  if (Math.abs(a) < 1e-6) {
    // exactly sonic: linear equation b·τ + dd = 0
    return b < 0 ? -dd / b : -1;
  }
  const disc = b * b - 4 * a * dd;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  if (a < 0) {
    // subsonic: exactly one positive root
    return (b + s) / (-2 * a);
  }
  // supersonic: both roots positive iff b < 0 (source heading towards the listener side)
  if (b >= 0) return -1;
  return (-b - s) / (2 * a);
}

/** True when the listener is inside (behind) the Mach cone of a supersonic source, or the source is subsonic. */
export function insideMachCone(dx: number, dy: number, dz: number, vx: number, vy: number, vz: number, c = SPEED_OF_SOUND): boolean {
  return retardedTime(dx, dy, dz, vx, vy, vz, c) >= 0;
}

/** Mach cone half-angle (rad) for speed V (π/2 when subsonic). */
export function machAngle(speed: number, c = SPEED_OF_SOUND): number {
  return speed <= c ? Math.PI / 2 : Math.asin(c / speed);
}

/**
 * Doppler frequency ratio f'/f.
 * (ux,uy,uz) = unit vector from the (emission) source position to the listener.
 * Source approaching (V_s·u > 0) or listener approaching (V_l·u < 0) raise the pitch.
 */
export function dopplerFactor(
  ux: number,
  uy: number,
  uz: number,
  svx: number,
  svy: number,
  svz: number,
  lvx: number,
  lvy: number,
  lvz: number,
  min = 0.55,
  max = 1.8,
  c = SPEED_OF_SOUND,
): number {
  const vs = svx * ux + svy * uy + svz * uz; // source speed towards listener
  const vl = -(lvx * ux + lvy * uy + lvz * uz); // listener speed towards source
  const den = c - vs;
  if (den <= 1) return max;
  return clamp((c + vl) / den, min, max);
}

/**
 * Stereo pan (−1..1) from the dot product of the source direction with the listener's right
 * vector; narrowed a little (never fully one-sided) and centred for very close sources.
 */
export function stereoPan(dirDotRight: number, distance: number): number {
  const width = distance < 4 ? distance / 4 : 1;
  return clamp(dirDotRight, -1, 1) * 0.8 * width;
}

/** Audible range (m) of an explosion by size. */
export function explosionRange(size: ExplosionSize): number {
  switch (size) {
    case 'tiny':
      return 2500;
    case 'small':
      return 6000;
    case 'medium':
      return 11000;
    case 'large':
      return 16000;
    case 'huge':
      return 24000;
  }
}

/** Relative loudness (linear) of an explosion by size, at its reference distance. */
export function explosionLoudness(size: ExplosionSize): number {
  switch (size) {
    case 'tiny':
      return 0.35;
    case 'small':
      return 0.6;
    case 'medium':
      return 0.8;
    case 'large':
      return 0.95;
    case 'huge':
      return 1;
  }
}

/** Reference distance (m) inside which an explosion plays at full level. */
export function explosionRefDistance(size: ExplosionSize): number {
  switch (size) {
    case 'tiny':
      return 25;
    case 'small':
      return 60;
    case 'medium':
      return 120;
    case 'large':
      return 200;
    case 'huge':
      return 320;
  }
}
