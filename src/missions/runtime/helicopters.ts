/**
 * Civil helicopters over Auckland (#144), neutral traffic like the airliners (civil.ts): the real rescue and police
 * helicopters on the routes they fly, at most one of each, spawned once at the start of every Auckland sortie
 * (seeded per sortie, salted on a retry) and never respawned: one shot down stays down until the next session.
 * Each starts at a random point of its cycle, so the sortie opens on traffic already under way:
 *  - Westpac Rescue 1 (AW169 ZK-HLH): Ardmore base → Waiheke (the Onetangi Sports Park pad: 22–25 % of all the
 *    service's missions go to the island) → Auckland City Hospital → Ardmore;
 *  - Eagle (NZ Police Bell 429): from its Onehunga base (Auckland Heliport) a 75-minute patrol orbiting a slowly
 *    drifting point over the CBD, the motorways and the suburbs at 1,000–1,500 ft (its searchlight on at night),
 *    then back to base to refuel;
 *  - Northland Rescue (Northern Rescue AW169, ZK-HTQ): Whangārei Hospital, 130 km north and off the map → Starship
 *    at Auckland City Hospital → Whangārei, flown the whole way;
 *  - Westpac Rescue 2 (AW169 ZK-IZB): Ardmore → Great Barrier (Claris, off the map to the north-east) → Auckland
 *    City Hospital → Ardmore.
 * At most QualitySettings.helicopters at once, in that order (1 low: Westpac Rescue 1 only; 3 medium; 4 high).
 *
 * The pads come from the helipad table (core/sites.ts HELIPADS, #125); the two off-map pads are real positions.
 * `team: 'neutral'` makes them civilian everywhere (off the datalink, CIV boxes, ranked last for designation); the
 * player can still lock and shoot them, with the airliners' consequences (callouts.ts: CIVILIAN HELICOPTER DOWN,
 * −500, −0.15 rating, a debrief row), and the sortie goes on.
 */
import { Vector3 } from 'three';
import { mulberry32 } from '../../core/math';
import { geoToWorld } from '../../core/auckland';
import { HELIPADS, helipad, type Helipad } from '../../core/sites';
import type { AircraftType } from '../../core/types';
import type { AircraftEntity } from '../../sim/entities';
import type { TerrainQuery } from '../../sim/api';
import { HELI_GEAR_HEIGHT as HELI_GEAR, createRoute, cycleSeconds, placeHeli, type HeliFlight, type HeliLiveryId, type HeliPad } from '../../sim/civil/heli';
import type { MissionState } from './state';

const KT = 0.514444;
const FT = 0.3048;
/** A drawn rooftop pad stands this far above its LiDAR roof, a ground pad's decal this far above the ground (scenery/helipads.ts). */
const ROOF_LIFT = 0.25;
const GROUND_LIFT = 0.3;

/** The pads the traffic flies between: table pads by id, Onetangi by position, the off-map pads by position. */
export const HELI_SITES = {
  hospital: { id: 'auckland_city_hospital' },
  ardmore: { id: 'ardmore_aerodrome' },
  onehunga: { id: 'auckland_heliport' },
  onetangi: { lat: -36.80548, lon: 175.06987 },
  /** Off the map: Whangārei Hospital (Northland's base hospital) and Great Barrier's Claris aerodrome. */
  whangarei: { lat: -35.7342, lon: 174.3076 },
  greatBarrier: { lat: -36.2425, lon: 175.4719 },
} as const;

/** The table's pad nearest a position (within `within` m), or undefined. */
export function padNear(lat: number, lon: number, within = 150): Helipad | undefined {
  const p = geoToWorld(lat, lon);
  let best: Helipad | undefined;
  let bd = within;
  for (const h of HELIPADS) {
    const d = Math.hypot(h.x - p.x, h.z - p.z);
    if (d < bd) {
      bd = d;
      best = h;
    }
  }
  return best;
}

/** A table pad as the flight needs it: its surface where the scenery draws it. */
export function heliPad(p: Helipad, terrain: TerrainQuery): HeliPad {
  const y = p.roof ? p.height + ROOF_LIFT : terrain.surfaceHeightAt(p.x, p.z) + GROUND_LIFT;
  return { id: p.id, x: p.x, z: p.z, y, heading: p.heading };
}

/** A pad off the map at a real position (beyond the terrain its height is the map edge's, which nobody sees). */
function offMapPad(id: string, lat: number, lon: number, terrain: TerrainQuery): HeliPad {
  const { x, z } = geoToWorld(lat, lon);
  return { id, x, z, y: terrain.surfaceHeightAt(x, z) + GROUND_LIFT, heading: 0 };
}

const MIN = 60;

/** The police orbit's drifting point of interest: CBD → Spaghetti Junction → Newmarket → Ellerslie → Mt Wellington → Ponsonby. */
const POLICE_ROUTE: [number, number][] = [
  [0, 0],
  [-900, 1200],
  [1800, 3200],
  [3600, 6000],
  [6200, 6800],
  [2600, 2600],
  [-2000, 500],
];

interface HeliSpec {
  type: 'aw169' | 'bell429';
  livery: HeliLiveryId;
  name: string;
  callsign: string;
  flight: HeliFlight;
}

export class HelicopterTraffic {
  private readonly rng: () => number;
  /** The helicopters spawned (for tests and the debug API). */
  readonly fleet: AircraftEntity[] = [];

  constructor(
    private readonly s: MissionState,
    private readonly max = 3,
  ) {
    this.rng = mulberry32(((s.def.seed ?? 1) * 4271 + 91) >>> 0);
  }

  /** Spawn the fleet once (nothing respawns a lost one), each fast-forwarded to a random point of its cycle. */
  setup(): void {
    const terrain = this.s.world.terrain;
    for (const h of this.plan(terrain).slice(0, Math.max(0, this.max))) {
      const ac = this.s.world.spawnAircraft({
        type: h.type as AircraftType,
        team: 'neutral',
        position: new Vector3(0, 500, 0),
        heading: 0,
        speed: 0,
        name: h.name,
        callsign: h.callsign,
        ai: null,
        groupId: 'civil-heli',
        fuel: 0.6,
      });
      // peacetime (the stroll): they broadcast ADS-B like the airliners, so the jet can box them
      h.flight.adsb = !!this.s.script.freeFlight;
      placeHeli(ac, h.flight, terrain, this.rng() * cycleSeconds(h.flight));
      this.fleet.push(ac);
    }
  }

  /** The sortie's helicopters in spawn order (low tier: only the first). */
  plan(terrain: TerrainQuery): HeliSpec[] {
    const rng = this.rng;
    const pad = (p: Helipad | undefined) => (p ? heliPad(p, terrain) : null);
    const ach = pad(helipad(HELI_SITES.hospital.id));
    const ardmore = pad(helipad(HELI_SITES.ardmore.id));
    const onehunga = pad(helipad(HELI_SITES.onehunga.id));
    const onetangi = pad(padNear(HELI_SITES.onetangi.lat, HELI_SITES.onetangi.lon));
    const whangarei = offMapPad('whangarei_hospital', HELI_SITES.whangarei.lat, HELI_SITES.whangarei.lon, terrain);
    const barrier = offMapPad('great_barrier_claris', HELI_SITES.greatBarrier.lat, HELI_SITES.greatBarrier.lon, terrain);
    // a few minutes either way on every stand-by and hand-over, so no two sorties run like clockwork
    const dwell = (minutes: number) => (minutes + (rng() - 0.5) * 4) * MIN;
    const rescue = { role: 'rescue' as const, cruiseAlt: 1500 * FT, cruiseSpeed: 135 * KT, gearHeight: HELI_GEAR.aw169 };
    const out: HeliSpec[] = [];
    if (ach && ardmore && onetangi)
      out.push({
        type: 'aw169',
        livery: 'westpac1',
        name: 'AW169',
        callsign: 'Westpac Rescue 1',
        flight: createRoute({ ...rescue, livery: 'westpac1', stops: [{ pad: ardmore, dwell: dwell(10) }, { pad: onetangi, dwell: dwell(8) }, { pad: ach, dwell: dwell(6) }] }),
      });
    if (onehunga)
      out.push({
        type: 'bell429',
        livery: 'eagle',
        name: 'Bell 429',
        callsign: 'Eagle',
        flight: createRoute({
          role: 'police',
          livery: 'eagle',
          cruiseAlt: 1000 * FT,
          cruiseSpeed: 120 * KT,
          gearHeight: HELI_GEAR.bell429,
          stops: [
            { pad: onehunga, dwell: dwell(15) },
            { patrol: { route: POLICE_ROUTE, radius: 600 + 300 * rng(), alt: (1000 + 500 * rng()) * FT, airspeed: 70 * KT, speed: 14, duration: 75 * MIN } },
          ],
          patrolStart: rng() * 20_000,
        }),
      });
    if (ach)
      out.push({
        type: 'aw169',
        livery: 'northland',
        name: 'AW169',
        callsign: 'Northland Rescue',
        flight: createRoute({ ...rescue, livery: 'northland', stops: [{ pad: whangarei, dwell: dwell(15) }, { pad: ach, dwell: dwell(8) }] }),
      });
    if (ach && ardmore)
      out.push({
        type: 'aw169',
        livery: 'westpac2',
        name: 'AW169',
        callsign: 'Westpac Rescue 2',
        flight: createRoute({ ...rescue, livery: 'westpac2', stops: [{ pad: ardmore, dwell: dwell(10) }, { pad: barrier, dwell: dwell(10) }, { pad: ach, dwell: dwell(6) }] }),
      });
    return out;
  }
}
