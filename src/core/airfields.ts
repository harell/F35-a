/**
 * F35-A — the Auckland theatre's real airfields: runway thresholds for gameplay and the scenery fallback.
 * OWNERSHIP: orchestrator. Used by WORLD (airfield scenery, terrain flattening), MISSIONS (home base,
 * civil traffic on 05R/23L) and the sim, synchronously, whether or not the OSM layer file has loaded.
 *
 * Threshold positions are the runway centrelines' end vertices in OpenStreetMap (© OpenStreetMap
 * contributors, ODbL 1.0; extract of 2026-09-25, see tools/osm/README.md). tests/world-osm.test.ts checks
 * them against the baked file, so a re-bake that moves a runway fails until this table follows it. Widths
 * and surfaces are the published (AIP) values where OSM has none or tags the runway strip instead.
 * Taxiways, aprons, hangars and the levelled outline come from the baked layer (src/world/scenery/aucklandOsm.ts).
 *
 * `a` is the threshold of the first designator (an aircraft landing on "03" crosses `a` first and rolls
 * towards `b`), so the true heading a → b is the designator × 10° plus the ≈ 20° east magnetic variation.
 */
import { geoToWorld } from './auckland';
import type { SceneryFeature } from './contracts';

export type AirfieldId = 'whenuapai' | 'akl_airport' | 'ardmore' | 'dairy_flat';

export interface RunwayDef {
  /** Designators "03/21": first = threshold `a`. */
  ref: string;
  /** Threshold `a` / `b` (lat, lon WGS84). */
  a: [number, number];
  b: [number, number];
  /** Paved width (m). */
  width: number;
  /** Sealed (asphalt / concrete) or grass. */
  paved: boolean;
}

export interface AirfieldDef {
  id: AirfieldId;
  name: string;
  icao: string;
  /** Scenery style of the template fallback: military (RNZAF) or civil. */
  style: 'military' | 'civil';
  /** Main runway first. */
  runways: RunwayDef[];
  /** Side of the main runway (seen from `a` looking at `b`) with the aprons and buildings. */
  apronSide: 'left' | 'right';
  /** World XZ (m): centre of the main runway. */
  x: number;
  z: number;
}

/** A runway in world space. */
export interface Runway {
  ref: string;
  /** Designators [threshold a, threshold b], e.g. ['03', '21']. */
  names: [string, string];
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Centre (m). */
  x: number;
  z: number;
  /** True heading a → b (rad, 0 = north, clockwise). */
  heading: number;
  length: number;
  width: number;
  paved: boolean;
}

const defs: Omit<AirfieldDef, 'x' | 'z'>[] = [
  {
    id: 'whenuapai',
    name: 'RNZAF Base Auckland (Whenuapai)',
    icao: 'NZWP',
    style: 'military',
    runways: [
      { ref: '03/21', a: [-36.79613, 174.620952], b: [-36.785111, 174.639059], width: 45, paved: true },
      { ref: '08/26', a: [-36.783782, 174.623506], b: [-36.785715, 174.640973], width: 45, paved: true },
    ],
    apronSide: 'left',
  },
  {
    id: 'akl_airport',
    name: 'Auckland Airport',
    icao: 'NZAA',
    style: 'civil',
    runways: [{ ref: '05R/23L', a: [-37.017468, 174.766651], b: [-37.006657, 174.805767], width: 45, paved: true }],
    apronSide: 'left',
  },
  {
    id: 'ardmore',
    name: 'Ardmore Airport',
    icao: 'NZAR',
    style: 'civil',
    // OSM tags the 110 m runway strip; the sealed runway is 30 m wide (AIP NZ)
    runways: [{ ref: '03/21', a: [-37.035224, 174.968933], b: [-37.026499, 174.980047], width: 30, paved: true }],
    apronSide: 'right',
  },
  {
    id: 'dairy_flat',
    name: 'North Shore Aerodrome (Dairy Flat)',
    icao: 'NZNE',
    style: 'civil',
    runways: [
      { ref: '03/21', a: [-36.658788, 174.652261], b: [-36.654286, 174.658261], width: 18, paved: true },
      { ref: '09/27', a: [-36.655747, 174.65354], b: [-36.657031, 174.659507], width: 30, paved: false },
    ],
    apronSide: 'left',
  },
];

function toRunway(r: RunwayDef): Runway {
  const a = geoToWorld(r.a[0], r.a[1]);
  const b = geoToWorld(r.b[0], r.b[1]);
  const [na, nb] = r.ref.split('/') as [string, string];
  return {
    ref: r.ref,
    names: [na, nb],
    ax: a.x,
    az: a.z,
    bx: b.x,
    bz: b.z,
    x: (a.x + b.x) / 2,
    z: (a.z + b.z) / 2,
    heading: Math.atan2(b.x - a.x, -(b.z - a.z)),
    length: Math.hypot(b.x - a.x, b.z - a.z),
    width: r.width,
    paved: r.paved,
  };
}

const runwayCache = new Map<AirfieldId, Runway[]>();

export const AIRFIELDS: Record<AirfieldId, AirfieldDef> = Object.fromEntries(
  defs.map((d) => {
    const main = toRunway(d.runways[0]);
    return [d.id, { ...d, x: main.x, z: main.z }];
  }),
) as Record<AirfieldId, AirfieldDef>;

export const AIRFIELD_IDS = defs.map((d) => d.id);

/** The airfield's runways in world space (main first). */
export function runwaysOf(id: AirfieldId): Runway[] {
  let r = runwayCache.get(id);
  if (!r) runwayCache.set(id, (r = AIRFIELDS[id].runways.map(toRunway)));
  return r;
}

export function mainRunway(id: AirfieldId): Runway {
  return runwaysOf(id)[0];
}

/** The real airfield within `radius` m of (x, z) (its main runway centre), or null. */
export function airfieldNear(x: number, z: number, radius = 2500): AirfieldDef | null {
  let best: AirfieldDef | null = null;
  let bd = radius;
  for (const id of AIRFIELD_IDS) {
    const f = AIRFIELDS[id];
    const d = Math.hypot(x - f.x, z - f.z);
    if (d < bd) {
      bd = d;
      best = f;
    }
  }
  return best;
}

/**
 * Yaw (deg) of the airfield's airbase feature: its main runway, pointed so the template layout's apron
 * side (the right of the feature heading, airbase.ts) is the real one.
 */
export function airfieldRotation(id: AirfieldId): number {
  const rw = mainRunway(id);
  const deg = (rw.heading * 180) / Math.PI + (AIRFIELDS[id].apronSide === 'left' ? 180 : 0);
  return Math.round((((deg % 360) + 360) % 360) * 100) / 100;
}

/** The airfield as a scenery feature (terrain flattening, scenery): centred on its main runway. */
export function airfieldFeature(id: AirfieldId): SceneryFeature {
  const f = AIRFIELDS[id];
  return { type: 'airbase', x: f.x, z: f.z, rotation: airfieldRotation(id), size: 1, airfield: id };
}
