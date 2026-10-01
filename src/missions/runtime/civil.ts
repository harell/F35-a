/**
 * Civil air traffic around Auckland Airport (Auckland theatre only): neutral Air New Zealand A320s
 * landing on and departing from runway 05R/23L in a single flow direction per sortie.
 *
 * Neutral traffic is ignored by both sides' AI and SAMs; only the human player can (deliberately)
 * designate and shoot an airliner — the Callouts module handles the consequences.
 */
import { Vector3 } from 'three';
import { AKL } from '../../core/auckland';
import { mulberry32 } from '../../core/math';
import type { AircraftEntity } from '../../sim/entities';
import { A320_GEAR_HEIGHT, createArrival, createDeparture, placeCivil, type CivilFlight, type Runway } from '../../sim/civil/route';
import type { MissionState } from './state';

const DEG = Math.PI / 180;
/** Auckland Airport runway 05R/23L (true heading ≈ 070° / 250°; matches the scenery's airbase feature). */
const RUNWAY_AXIS = 250 * DEG;
const RUNWAY_LENGTH = 3_600;
/** Most airliners in the air / on the runway at once. */
const MAX_CIVIL = 3;
/** Final approach length at spawn (m from the aim point). */
const ARRIVAL_SPAWN = 22_000;
/** First wave: an arrival already on final and a departure lining up shortly after the mission starts. */
const OPENING_ARRIVAL = 12_000;
const OPENING_DEPARTURE_DELAY = 25;
const MIN_GAP = 70;
const MAX_GAP = 140;
/** Departure exit headings (deg): Wellington / Christchurch, Tasman, Northland, Pacific, East Cape. */
const EXITS = [195, 255, 330, 25, 110];
const FLIGHT_NUMBERS = [103, 115, 279, 401, 415, 421, 437, 443, 501, 521, 533, 547, 561, 573, 609, 1257];

export class CivilTraffic {
  private readonly rng: () => number;
  private readonly runway: Runway;
  private nextAt = 0;
  private nextKind: 'arrival' | 'departure' = 'departure';
  private seq = 0;

  constructor(private readonly s: MissionState) {
    this.rng = mulberry32(((s.def.seed ?? 1) * 7919 + 17) >>> 0);
    const heading = this.rng() < 0.5 ? RUNWAY_AXIS : RUNWAY_AXIS - Math.PI; // 23L or 05R flow
    const { x, z } = AKL.akl_airport;
    this.runway = { x, z, heading, length: RUNWAY_LENGTH, elevation: 0 };
  }

  setup(): void {
    const world = this.s.world;
    this.runway.elevation = world.terrain.surfaceHeightAt(this.runway.x, this.runway.z);
    this.spawn(createArrival(this.runway, OPENING_ARRIVAL, A320_GEAR_HEIGHT));
    this.nextKind = 'departure';
    this.nextAt = world.time + OPENING_DEPARTURE_DELAY;
  }

  update(): void {
    const world = this.s.world;
    if (world.time < this.nextAt) return;
    let live = 0;
    for (const a of world.aircraft) if (a.civil && a.alive) live++;
    if (live >= MAX_CIVIL || !this.clear(this.nextKind)) {
      this.nextAt = world.time + 10;
      return;
    }
    if (this.nextKind === 'arrival') this.spawn(createArrival(this.runway, ARRIVAL_SPAWN, A320_GEAR_HEIGHT));
    else {
      const exit = EXITS[Math.floor(this.rng() * EXITS.length)] * DEG;
      const cruise = 6_000 + Math.round(this.rng() * 6) * 500;
      this.spawn(createDeparture(this.runway, exit, cruise, A320_GEAR_HEIGHT));
    }
    this.nextKind = this.nextKind === 'arrival' ? 'departure' : 'arrival';
    this.nextAt = world.time + MIN_GAP + this.rng() * (MAX_GAP - MIN_GAP);
  }

  /** Runway / final approach separation. */
  private clear(kind: 'arrival' | 'departure'): boolean {
    for (const a of this.s.world.aircraft) {
      const f = a.civil;
      if (!f || !a.alive) continue;
      if (kind === 'departure') {
        // no take-off while a jet is on short final, landing or still on the runway
        if (f.kind === 'arrival' && f.s > -5_000) return false;
        if (f.kind === 'departure' && f.phase === 'takeoff') return false;
      } else if (f.kind === 'arrival' && f.s < -ARRIVAL_SPAWN + 8_000) return false;
    }
    return true;
  }

  private spawn(f: CivilFlight): AircraftEntity {
    const n = FLIGHT_NUMBERS[(this.seq++ + Math.floor(this.rng() * FLIGHT_NUMBERS.length)) % FLIGHT_NUMBERS.length];
    const ac = this.s.world.spawnAircraft({
      type: 'a320',
      team: 'neutral',
      position: new Vector3(this.runway.x, 500, this.runway.z),
      heading: f.heading,
      speed: Math.max(60, f.speed),
      name: 'A320neo',
      callsign: `NZ${n}`,
      ai: null,
      groupId: 'civil',
      fuel: 0.6,
    });
    placeCivil(ac, f);
    return ac;
  }
}
