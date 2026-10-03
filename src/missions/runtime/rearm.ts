/**
 * F35-A — Winchester / bingo handling and the Whenuapai rearm point.
 *
 *  - When the player runs out of missiles and bombs (the gun doesn't count) while the mission is
 *    still running, DARKSTAR calls "Winchester — RTB to Whenuapai to rearm" and the steering cue
 *    (MissionRunnerApi.currentWaypoint) switches to the rearm point. Same for bingo fuel.
 *  - Flying within REARM_RADIUS of the home airbase below REARM_MAX_AGL for REARM_HOLD continuous
 *    seconds re-applies the mission loadout (combat.applyLoadout) and tops the tanks up to the
 *    mission start fuel: HUD "REARMED" + a radio call. Wingmen keep fighting meanwhile.
 *
 * Home is RNZAF Base Auckland (Whenuapai) in the Auckland theatre, otherwise the first airbase
 * of the mission's scenery (Instant Action in the procedural theatres), else the player start.
 */
import { Vector3 } from 'three';
import { AKL } from '../../core/auckland';
import { LOADOUTS } from '../../core/data';
import type { MissionDef, Waypoint } from '../../core/contracts';
import type { LoadoutId } from '../../core/types';
import { AIRCRAFT_PERF } from '../../sim/flight/aircraftData';
import type { AircraftEntity } from '../../sim/entities';
import type { MissionState } from './state';

/** Rearm gate: horizontal distance from the field (m), max height above ground (m), hold time (s). */
export const REARM_RADIUS = 2_500;
export const REARM_MAX_AGL = 1_500;
export const REARM_HOLD = 5;
/** Bingo: fuel below this fraction of the internal capacity. */
export const BINGO_FRACTION = 0.15;

export type RearmNeed = 'winchester' | 'bingo' | null;

/** Missiles + bombs left (the gun doesn't count). */
export function storesLeft(p: AircraftEntity): number {
  let n = 0;
  for (const st of p.stores) n += st.count;
  return n;
}

/**
 * Where the player rearms in a mission (x, z m): Whenuapai in the Auckland theatre, otherwise the
 * first airbase of the mission's scenery, else the player start. The scripted test pilot
 * (tests/missions-bot.ts) flies to the same point.
 */
export function rearmHome(def: MissionDef): { x: number; z: number; name: string } {
  if (def.theater === 'auckland') return { x: AKL.whenuapai.x, z: AKL.whenuapai.z, name: 'Whenuapai' };
  const base = def.features.find((f) => f.type === 'airbase');
  if (base) return { x: base.x, z: base.z, name: 'home base' };
  return { x: def.player.x, z: def.player.z, name: 'home plate' };
}

export class RearmController {
  /** Steering cue while Winchester / bingo. */
  readonly waypoint: Waypoint;
  readonly homeName: string;
  private loadout: LoadoutId | null = null;
  private startFuel = 0;
  private need: RearmNeed = null;
  private inGate = 0;
  private gateAnnounced = false;
  private gunsCalled = false;
  private enabled = false;

  constructor(private readonly s: MissionState) {
    const { x, z, name } = rearmHome(s.def);
    this.homeName = name;
    this.waypoint = { id: 'rearm', label: `${name === 'Whenuapai' ? 'Whenuapai' : 'Home'} — REARM`, kind: 'rtb', radius: REARM_RADIUS, position: new Vector3(x, 900, z) };
  }

  /** Call after the player spawned (records the loadout and start fuel). */
  init(p: AircraftEntity, loadout: LoadoutId): void {
    this.loadout = loadout;
    this.startFuel = p.flight.fuel;
    // survival mode rearms between waves on its own
    this.enabled = !this.s.script.survival;
    this.waypoint.position.y = Math.max(600, this.s.world.terrain.surfaceHeightAt(this.waypoint.position.x, this.waypoint.position.z) + 700);
  }

  /** Why the player should go home now (null = no need). */
  get current(): RearmNeed {
    return this.need;
  }

  /** Horizontal distance (m) from the rearm point. */
  distance(p: AircraftEntity): number {
    return Math.hypot(p.position.x - this.waypoint.position.x, p.position.z - this.waypoint.position.z);
  }

  /** Something to replace: stores, a real amount of fuel, most of the gun or countermeasures. */
  private expended(p: AircraftEntity): boolean {
    const def = this.loadout ? LOADOUTS[this.loadout] : null;
    if (!def) return false;
    let full = 0;
    for (const st of def.stores) full += st.count;
    if (storesLeft(p) < full) return true;
    if (p.gunAmmo < def.gunAmmo * 0.5) return true;
    if (p.flares < def.flares * 0.5 || p.chaff < def.chaff * 0.5) return true;
    return p.flight.fuel < this.startFuel - AIRCRAFT_PERF[p.type].internalFuel * 0.1;
  }

  /** In the rearm gate over the field right now (for hints). */
  inGateNow(p: AircraftEntity): boolean {
    return this.distance(p) <= REARM_RADIUS && p.flight.agl <= REARM_MAX_AGL;
  }

  /** Seconds held in the gate so far (for the HUD countdown). */
  get holdTime(): number {
    return this.inGate;
  }

  update(dt: number): void {
    const s = this.s;
    const p = s.player;
    if (!this.enabled || !p || !p.alive || s.state !== 'running' || !this.loadout) {
      this.inGate = 0;
      return;
    }
    // Winchester / bingo calls (edge-triggered)
    const bingoFuel = AIRCRAFT_PERF[p.type].internalFuel * BINGO_FRACTION;
    // (a clean jet took off with nothing to run out of)
    const winchester = storesLeft(p) === 0 && LOADOUTS[this.loadout].stores.length > 0;
    // no rearm point (a sortie against the clock): Winchester means the gun, not a trip home
    if (winchester && s.script.noRearm) {
      if (!this.gunsCalled) this.callGuns(p);
    }
    const need: RearmNeed = winchester && !s.script.noRearm ? 'winchester' : p.flight.fuel < bingoFuel ? 'bingo' : null;
    if (need && need !== this.need) this.announce(need, p);
    this.need = need;

    // rearm gate (free flight: only when Winchester or bingo, so a pass over Whenuapai isn't a pit stop;
    // none in a mission with no rearm point)
    if (!s.script.noRearm && this.inGateNow(p) && this.expended(p) && (!s.script.freeFlight || this.need !== null)) {
      if (!this.gateAnnounced) {
        this.gateAnnounced = true;
        s.hud(`REARMING — HOLD OVER ${this.homeName.toUpperCase()}`, 'info', REARM_HOLD);
      }
      this.inGate += dt;
      if (this.inGate >= REARM_HOLD) this.rearm(p);
    } else {
      this.inGate = 0;
      this.gateAnnounced = false;
    }
  }

  /** Winchester with no rearm point: the missiles are gone, the gun finishes the job. */
  private callGuns(p: AircraftEntity): void {
    const s = this.s;
    this.gunsCalled = true;
    s.stats.winchester++;
    const rounds = p.gunAmmo > 0;
    s.hud(rounds ? 'WINCHESTER MISSILES — GUNS' : 'WINCHESTER', 'warn', 4);
    s.radio.push({ from: s.awacsCallsign, text: `${s.callsign}, ${s.awacsSpoken}. ${rounds ? 'Missiles gone: finish them with the gun.' : 'Winchester.'}`, priority: 3 });
  }

  private announce(need: Exclude<RearmNeed, null>, p: AircraftEntity): void {
    const s = this.s;
    const wing = this.wingmenAlive(p);
    const home = this.homeName === 'Whenuapai' ? 'Whenuapai' : 'base';
    if (need === 'winchester') {
      s.stats.winchester++;
      s.hud(`WINCHESTER — RTB ${home.toUpperCase()} TO REARM`, 'warn', 4);
      s.radio.push({
        from: s.awacsCallsign,
        text: `${s.callsign}, ${s.awacsSpoken}. Winchester — RTB to ${home} to rearm.${wing ? ` ${wing} has the fight.` : ''}`,
        priority: 3,
      });
    } else {
      s.hud(`BINGO FUEL — RTB ${home.toUpperCase()}`, 'warn', 4);
      s.radio.push({ from: s.awacsCallsign, text: `${s.callsign}, ${s.awacsSpoken}. You're bingo fuel — RTB to ${home} to refuel.`, priority: 3 });
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

  private rearm(p: AircraftEntity): void {
    const s = this.s;
    this.inGate = 0;
    this.gateAnnounced = false;
    this.need = null;
    s.world.combat.applyLoadout(p, this.loadout!);
    p.flight.fuel = Math.max(p.flight.fuel, this.startFuel);
    s.stats.rearms++;
    s.hud('REARMED', 'good', 3);
    const onward = s.script.freeFlight ? 'Enjoy the rest of your flight.' : 'Cleared back into the fight.';
    s.radio.push({ from: `${this.homeName === 'Whenuapai' ? 'Whenuapai' : 'Base'} Ground`, text: `${s.callsign}, rearmed and refuelled. ${onward}`, priority: 2 });
  }
}
