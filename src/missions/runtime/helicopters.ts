/**
 * Civil helicopters over Auckland (#144), neutral traffic like the airliners (civil.ts): spawned once at the start
 * of every Auckland sortie, seeded per sortie, flying for the whole of it (they never despawn):
 *  - the Westpac Rescue AW169 between Auckland City Hospital's rooftop pad and Waiheke (the Onetangi Sports Park
 *    pad, where ≈ 70 % of the island's rescues land), now and then North Shore or Middlemore hospital instead. It
 *    starts part-way out to the island, so it lands there, waits and is back on the hospital roof within a sortie;
 *  - the NZ Police "Eagle" (Bell 429) orbiting a slowly drifting point over the CBD, the motorways and the suburbs
 *    at 1,000–1,500 ft, day and night (its searchlight on at night);
 *  - a sightseeing H130 between the Mechanics Bay heliport and a Waiheke vineyard pad (high tier: a second one).
 * At most QualitySettings.helicopters at once (1 low: the rescue helicopter only; 3 medium; 4 high).
 *
 * The pads come from the helipad table (core/sites.ts HELIPADS, #125). `team: 'neutral'` makes them civilian
 * everywhere (off the datalink, CIV boxes, ranked last for designation); the player can still lock and shoot them,
 * with the airliners' consequences (callouts.ts: CIVILIAN HELICOPTER DOWN, −500, −0.15 rating, a debrief row), and
 * the sortie goes on.
 */
import { Vector3 } from 'three';
import { mulberry32 } from '../../core/math';
import { geoToWorld } from '../../core/auckland';
import { HELIPADS, helipad, type Helipad } from '../../core/sites';
import type { AircraftType } from '../../core/types';
import type { AircraftEntity } from '../../sim/entities';
import type { TerrainQuery } from '../../sim/api';
import { HELI_GEAR_HEIGHT as HELI_GEAR, createOrbit, createShuttle, placeHeli, type HeliFlight, type HeliPad } from '../../sim/civil/heli';
import type { MissionState } from './state';

const KT = 0.514444;
const FT = 0.3048;
/** A drawn rooftop pad stands this far above its LiDAR roof, a ground pad's decal this far above the ground (scenery/helipads.ts). */
const ROOF_LIFT = 0.25;
const GROUND_LIFT = 0.3;

/** The pads the traffic flies between (positions from the #144 issue, matched to the helipad table). */
export const HELI_SITES = {
  hospital: { id: 'auckland_city_hospital' },
  onetangi: { lat: -36.80548, lon: 175.06987 },
  northShore: { id: 'north_shore_hospital' },
  middlemore: { site: 'Middlemore Hospital' },
  mechanicsBay: { id: 'mechanics_bay_heliport' },
  vineyard: { id: 'cable_bay_vineyards' },
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
  type: 'aw169' | 'bell429' | 'h130';
  name: string;
  callsign: string;
  flight: HeliFlight;
  startFraction: number;
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
      placeHeli(ac, h.flight, terrain, h.startFraction);
      this.fleet.push(ac);
    }
  }

  /** The sortie's helicopters, the rescue helicopter first (low tier: only it). */
  plan(terrain: TerrainQuery): HeliSpec[] {
    const rng = this.rng;
    const pad = (p: Helipad | undefined) => (p ? heliPad(p, terrain) : null);
    const hospital = pad(helipad(HELI_SITES.hospital.id));
    const onetangi = pad(padNear(HELI_SITES.onetangi.lat, HELI_SITES.onetangi.lon));
    const out: HeliSpec[] = [];
    if (hospital && onetangi) {
      // mostly the island run; sometimes a transfer to North Shore or Middlemore
      const r = rng();
      const other = r < 0.7 ? onetangi : pad(r < 0.85 ? helipad(HELI_SITES.northShore.id) : HELIPADS.find((h) => h.site === HELI_SITES.middlemore.site)) ?? onetangi;
      out.push({
        type: 'aw169',
        name: 'AW169',
        callsign: `Westpac Rescue ${rng() < 0.5 ? 1 : 2}`,
        flight: createShuttle({ role: 'rescue', pads: [hospital, other], cruiseAlt: 1500 * FT, cruiseSpeed: 135 * KT, dwell: 75 + 30 * rng(), gearHeight: HELI_GEAR.aw169, startLeg: 1, startFraction: 0.5 }),
        startFraction: other === onetangi ? 0.85 + 0.05 * rng() : 0.5,
      });
    }
    out.push({
      type: 'bell429',
      name: 'Bell 429',
      callsign: 'Eagle',
      flight: createOrbit(POLICE_ROUTE, (1000 + 500 * rng()) * FT, 600 + 300 * rng(), 70 * KT, HELI_GEAR.bell429, rng() * Math.PI * 2),
      startFraction: 0,
    });
    const bay = pad(helipad(HELI_SITES.mechanicsBay.id));
    const vineyard = pad(helipad(HELI_SITES.vineyard.id));
    if (bay && vineyard) {
      out.push({
        type: 'h130',
        name: 'H130',
        callsign: 'Heli Tours 1',
        flight: createShuttle({ role: 'tour', pads: [bay, vineyard], cruiseAlt: 1000 * FT, cruiseSpeed: 110 * KT, dwell: 150 + 90 * rng(), gearHeight: HELI_GEAR.h130, startLeg: 1, startFraction: 0 }),
        startFraction: 0,
      });
      // the high tier's second sightseeing flight, the other way round: on its way back from the island
      out.push({
        type: 'h130',
        name: 'H130',
        callsign: 'Heli Tours 2',
        flight: createShuttle({ role: 'tour', pads: [vineyard, bay], cruiseAlt: 1200 * FT, cruiseSpeed: 110 * KT, dwell: 150 + 90 * rng(), gearHeight: HELI_GEAR.h130, startLeg: 1, startFraction: 0.3 }),
        startFraction: 0.3 + 0.4 * rng(),
      });
    }
    return out;
  }
}
