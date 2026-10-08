/**
 * F35-A — vertical manoeuvre detector (training drills): recognises the player flying a full
 * loop or an Immelmann (half loop up, half roll to upright at the top) from the flight path
 * and the jet's up vector, sampled at the runner's evaluation rate.
 *
 *  level  flight path within 30° of the horizon: the entry direction (horizontal) is latched
 *  up     the path has gone past 60° nose-up
 *  over   the jet came over the top: the horizontal path points back against the entry (dot < −0.5)
 *         while it is on its back (up vector pointing down). A steep climbing turn or a hammerhead
 *         never gets here inverted.
 *         → IMMELMANN once it is back within 30° of the horizon, upright (rolled out) and heading
 *           within ~37° of the reverse of the entry
 *  down   past 45° nose-down on the back side of the loop
 *         → LOOP once it pulls out within 20° of the horizon, upright, heading within ~45° of the entry
 *
 * Anything else (a stall over the top, a split-S exit, a roll out the wrong way) drops back to
 * `level` without counting; each phase also times out.
 */
import type { Vector3 } from 'three';

export type ManeuverId = 'loop' | 'immelmann';

const DEG = Math.PI / 180;
/** A phase is abandoned after this long (s): a loop takes ~20–30 s, a half loop ~10–18 s. */
const PHASE_TIMEOUT = 45;

export interface ManeuverTracker {
  phase: 'level' | 'up' | 'over' | 'down';
  /** Unit horizontal direction of flight on entry (x, z). */
  entryX: number;
  entryZ: number;
  hasEntry: boolean;
  since: number;
  /** Manoeuvres completed since the start of the mission. */
  readonly counts: Record<ManeuverId, number>;
}

export function createManeuverTracker(): ManeuverTracker {
  return { phase: 'level', entryX: 0, entryZ: -1, hasEntry: false, since: 0, counts: { loop: 0, immelmann: 0 } };
}

/**
 * Feed one sample: the player's velocity (world), the jet's up vector (world, unit) and the time (s).
 * Returns the manoeuvre completed on this sample (and counts it), or null.
 */
export function updateManeuvers(t: ManeuverTracker, vel: Vector3, up: Vector3, time: number): ManeuverId | null {
  const v = vel.length();
  if (v < 1) return null;
  const gamma = Math.asin(Math.max(-1, Math.min(1, vel.y / v)));
  const h = Math.hypot(vel.x, vel.z);
  // horizontal direction is meaningless near the vertical
  const dot = h > 0.17 * v ? (vel.x * t.entryX + vel.z * t.entryZ) / h : 0;
  const upright = up.y;
  if (t.phase !== 'level' && time - t.since > PHASE_TIMEOUT) t.phase = 'level';

  switch (t.phase) {
    case 'level':
      if (Math.abs(gamma) < 30 * DEG && h > 0) {
        t.entryX = vel.x / h;
        t.entryZ = vel.z / h;
        t.hasEntry = true;
      } else if (gamma > 60 * DEG && t.hasEntry) {
        t.phase = 'up';
        t.since = time;
      }
      return null;
    case 'up':
      if (dot < -0.5 && upright < -0.3) {
        t.phase = 'over';
        t.since = time;
      } else if (gamma < 30 * DEG) t.phase = 'level'; // zoomed and pushed over, or turned out: no reversal
      return null;
    case 'over':
      if (Math.abs(gamma) < 30 * DEG && upright > 0.8 && dot < -0.8) {
        t.phase = 'level';
        t.counts.immelmann++;
        return 'immelmann';
      }
      if (gamma < -45 * DEG) {
        t.phase = 'down';
        t.since = time;
      }
      return null;
    case 'down':
      if (gamma > -20 * DEG) {
        t.phase = 'level';
        if (upright > 0.5 && dot > 0.7) {
          t.counts.loop++;
          return 'loop';
        }
      }
      return null;
  }
}
