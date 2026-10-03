/**
 * F35-A — what a sightseer did in free flight (A Stroll in the Park, issue #113): the tour stops
 * visited, the distance flown and the highest and lowest pass above the ground. The debrief shows
 * these in place of the combat stats (playtest 2.2-5).
 *
 * A pass only counts once the jet has flown on from it: AGL samples wait PASS_SETTLE seconds before
 * they are kept, so the last metres of a crash are never the "lowest pass".
 */
import type { MissionState } from './state';

/** Seconds a low (or high) point must be survived before it counts as a pass. */
export const PASS_SETTLE = 2;

export interface SightseeingStats {
  /** Tour stops flown past. */
  stops: number;
  /** Stops on the tour. */
  totalStops: number;
  /** Distance flown (m, along the flight path). */
  distance: number;
  /** Highest height above the ground or sea (m), null before any pass counts. */
  highestAgl: number | null;
  /** Lowest height above the ground or sea (m), null before any pass counts. */
  lowestAgl: number | null;
}

export class SightseeingLog {
  private distance = 0;
  private hi = -Infinity;
  private lo = Infinity;
  /** AGL samples not yet survived for PASS_SETTLE seconds: [time, agl]. */
  private readonly pending: [number, number][] = [];

  constructor(private readonly s: MissionState) {}

  /** Called at the runner's 10 Hz with the elapsed time. */
  update(dt: number): void {
    const p = this.s.player;
    if (!p) return;
    if (!p.alive) {
      // a crash isn't a pass
      this.pending.length = 0;
      return;
    }
    this.distance += p.velocity.length() * dt;
    const now = this.s.time;
    this.pending.push([now, p.flight.agl]);
    while (this.pending.length && now - this.pending[0][0] >= PASS_SETTLE) this.keep(this.pending.shift()![1]);
  }

  private keep(agl: number): void {
    if (agl > this.hi) this.hi = agl;
    if (agl < this.lo) this.lo = agl;
  }

  result(): SightseeingStats {
    // quitting in flight: the last few seconds were survived too
    if (this.s.player?.alive) {
      for (const [, agl] of this.pending) this.keep(agl);
      this.pending.length = 0;
    }
    const ids = new Set(this.s.waypoints.map((w) => w.def.id));
    let stops = 0;
    for (const id of this.s.waypointsReached) if (ids.has(id)) stops++;
    return {
      stops,
      totalStops: this.s.waypoints.length,
      distance: this.distance,
      highestAgl: Number.isFinite(this.hi) ? this.hi : null,
      lowestAgl: Number.isFinite(this.lo) ? this.lo : null,
    };
  }
}
