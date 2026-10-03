/**
 * F35-A — Winchester and bingo calls.
 *
 * There is no rearming (issue #63): the player flies the whole sortie on the loadout they took off
 * with, and nothing reloads or refuels the jet in the air.
 *  - Out of missiles and bombs (the gun doesn't count) while the mission is still running: DARKSTAR
 *    calls "Winchester" and says who still has the fight. The steering cue stays on the mission.
 *  - Fuel below BINGO_FRACTION of the internal capacity: DARKSTAR calls bingo.
 */
import { AIRCRAFT_PERF } from '../../sim/flight/aircraftData';
import type { AircraftEntity } from '../../sim/entities';
import type { MissionState } from './state';

/** Bingo: fuel below this fraction of the internal capacity. */
export const BINGO_FRACTION = 0.15;

export type WinchesterState = 'winchester' | 'bingo' | null;

/** Missiles + bombs left (the gun doesn't count). */
export function storesLeft(p: AircraftEntity): number {
  let n = 0;
  for (const st of p.stores) n += st.count;
  return n;
}

export class WinchesterWatch {
  private state: WinchesterState = null;

  constructor(private readonly s: MissionState) {}

  /** Out of weapons or bingo fuel right now (null = neither). */
  get current(): WinchesterState {
    return this.state;
  }

  update(): void {
    const s = this.s;
    const p = s.player;
    if (!p || !p.alive || s.state !== 'running') return;
    // edge-triggered: one call each time the state changes
    const bingoFuel = AIRCRAFT_PERF[p.type].internalFuel * BINGO_FRACTION;
    const next: WinchesterState = storesLeft(p) === 0 ? 'winchester' : p.flight.fuel < bingoFuel ? 'bingo' : null;
    if (next && next !== this.state) this.announce(next, p);
    this.state = next;
  }

  private announce(state: Exclude<WinchesterState, null>, p: AircraftEntity): void {
    const s = this.s;
    if (state === 'winchester') {
      s.stats.winchester++;
      const wing = this.wingmenAlive(p);
      const guns = p.gunAmmo > 0;
      s.hud(guns ? 'WINCHESTER — GUNS ONLY' : 'WINCHESTER', 'warn', 4);
      s.radio.push({
        from: s.awacsCallsign,
        text: `${s.callsign}, ${s.awacsSpoken}. Winchester.${wing ? ` ${wing} has the fight.` : guns ? ' Guns only.' : ''}`,
        priority: 3,
      });
    } else {
      s.hud('BINGO FUEL', 'warn', 4);
      s.radio.push({ from: s.awacsCallsign, text: `${s.callsign}, ${s.awacsSpoken}. You're bingo fuel${s.script.freeFlight ? '.' : ' — make it quick.'}`, priority: 3 });
    }
  }

  /** "Viper 2" / "Viper 2 and Viper 3" (live friendly wingmen), or ''. */
  private wingmenAlive(p: AircraftEntity): string {
    const names: string[] = [];
    for (const a of this.s.world.aircraft) {
      if (a.alive && a !== p && a.team === p.team && a.groupId === 'viper') names.push(a.callsign);
    }
    return names.slice(0, 2).join(' and ');
  }
}
