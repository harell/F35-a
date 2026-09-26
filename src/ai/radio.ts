/**
 * F35-A — rate-limited AI radio calls (friendly wingmen only; the player never hears enemy
 * chatter). Two limits: per aircraft and call type (e.g. one "Defending!" per 8 s) and a
 * per-team gap so several wingmen don't talk over each other.
 */
import type { SimWorld } from '../sim/api';
import type { AircraftEntity } from '../sim/entities';
import type { VoiceId } from '../core/types';

/** Minimum gap between any two AI radio calls of one team (s). */
const TEAM_GAP = 2.5;

const teamLast = new WeakMap<SimWorld, { blue: number; red: number }>();

export class RadioOperator {
  private readonly last = new Map<string, number>();

  /** Would a call of this `key` be allowed now (per-aircraft limit only)? Cheap pre-check. */
  ready(world: SimWorld, ac: AircraftEntity, key: string, minGap: number): boolean {
    if (ac.team !== 'blue' || ac.isPlayer || !ac.alive) return false;
    const prev = this.last.get(key);
    return prev === undefined || world.time - prev >= minGap;
  }

  /**
   * Emit a radio call if allowed. `key` groups calls for rate limiting (defaults to the voice).
   * Returns true when the call went out.
   */
  call(world: SimWorld, ac: AircraftEntity, text: string, voice: VoiceId | undefined, minGap = 8, key: string = voice ?? text, priority = 1): boolean {
    if (ac.team !== 'blue' || ac.isPlayer || !ac.alive) return false;
    const now = world.time;
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < minGap) return false;
    let t = teamLast.get(world);
    if (!t) {
      t = { blue: -999, red: -999 };
      teamLast.set(world, t);
    }
    if (now - t[ac.team] < TEAM_GAP && priority < 2) return false;
    t[ac.team] = now;
    this.last.set(key, now);
    world.events.emit('radio', { from: ac.callsign || ac.name, text, voice, priority, team: ac.team });
    return true;
  }
}
