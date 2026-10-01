/**
 * Civil shipping around Auckland (Auckland theatre only, gated with the airliners by
 * deps.civilTraffic): neutral container ships and cruise liners of the fictional Kōtuku Line.
 *
 * Wartime, port closed: the ships alongside at the Ports of Auckland and Princes Wharf stay moored,
 * 2–4 more swing at anchor in the outer Hauraki Gulf, and 1–2 steam slow loops in the deep-water
 * channel north of Rangitoto, well clear of the enemy-held islands. At most 8 ships per sortie.
 *
 * They are ordinary sim ground entities (type 'ship', team 'neutral', a VesselClass): the player's
 * EOTS and radar ground map see them, AI crews and SAMs never do, and TGT cycling ranks them behind
 * every hostile. A bomb or missile hit sinks one; the Callouts module handles the consequences.
 */
import { Vector3 } from 'three';
import { mulberry32 } from '../../core/math';
import type { VesselClass } from '../../core/types';
import type { GroundTargetEntity } from '../../sim/entities';
import type { MissionState } from './state';

const DEG = Math.PI / 180;

export interface ShipBerth {
  x: number;
  z: number;
  /** Bow heading (deg, clockwise from north). */
  heading: number;
  vessel: VesselClass;
}

/**
 * Ships alongside in port, on the real berths (OpenStreetMap seamark berths and wharf outlines, tools/osm): each hull
 * lies parallel to its wharf face, clear of both the OSM wharf and the LINZ coastline, which predates the Fergusson
 * reclamations. Checked by tests/world-waterfront.test.ts and tests/civil-shipping.test.ts.
 */
export const PORT_BERTHS: readonly ShipBerth[] = [
  { x: 2018, z: -974, heading: 96, vessel: 'container' }, // Fergusson North (FN), under the quay cranes A–C
  { x: 1843, z: -810, heading: 348, vessel: 'container' }, // Fergusson Z (FZ), west face, under cranes H and I
  { x: 386, z: -915, heading: 0, vessel: 'cruise' }, // Princes Wharf east (Princes E / F)
];

/**
 * Outer-Gulf anchorages (10–20 m of water off the North Shore, ≥ 6 km from Rangitoto). Bows point
 * into the prevailing south-westerly.
 */
export const ANCHORAGES: readonly ShipBerth[] = [
  { x: 3000, z: -13000, heading: 205, vessel: 'container' },
  { x: 6000, z: -12500, heading: 215, vessel: 'cruise' },
  { x: 2500, z: -18000, heading: 200, vessel: 'container' },
  { x: 10500, z: -24000, heading: 220, vessel: 'container' },
  { x: 17000, z: -23000, heading: 210, vessel: 'container' },
];

export interface ShipRoute {
  /** Loop centre (world XZ). */
  x: number;
  z: number;
  /** Bearing of the long axis (deg). */
  axis: number;
  /** Semi-axes (m). */
  a: number;
  b: number;
  /** Speed (m/s). */
  speed: number;
  vessel: VesselClass;
}

/** Slow loops along the deep-water channel (> 20 m) between the North Shore and Tiritiri Matangi. */
export const SHIP_ROUTES: readonly ShipRoute[] = [
  { x: 7500, z: -17500, axis: 20, a: 4000, b: 1200, speed: 5.5, vessel: 'container' },
  { x: 12500, z: -19000, axis: 70, a: 3500, b: 1000, speed: 5, vessel: 'cruise' },
];

/** Waypoints per loop: a 5° heading change at each (the sim snaps the heading at waypoints). */
const ROUTE_POINTS = 72;

/** Closed waypoint loop of a route (world XZ, y = 0), counter-clockwise seen from above. */
export function routePoints(r: ShipRoute, n = ROUTE_POINTS): Vector3[] {
  const ux = Math.sin(r.axis * DEG);
  const uz = -Math.cos(r.axis * DEG);
  const pts: Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const u = Math.cos(t) * r.a;
    const v = Math.sin(t) * r.b;
    // long axis along (ux, uz), short axis along its left normal (uz, -ux)
    pts.push(new Vector3(r.x + ux * u + uz * v, 0, r.z + uz * u - ux * v));
  }
  return pts;
}

const CONTAINER_NAMES = ['MV Kōtuku Trader', 'MV Tasman Kererū', 'MV Hauraki Pride', 'MV Pacific Tūī', 'MV Aotea Express', 'MV Rangatira Star', 'MV Moana Carrier'];
const CRUISE_NAMES = ['Southern Barnacle', 'Pacific Interislander', 'SuperGold Majesty'];

export class CivilShipping {
  private readonly rng: () => number;
  /** Every civil ship spawned this sortie. */
  readonly ships: GroundTargetEntity[] = [];
  private nameIdx = { container: 0, cruise: 0 };

  constructor(private readonly s: MissionState) {
    this.rng = mulberry32(((s.def.seed ?? 1) * 4099 + 31) >>> 0);
    this.nameIdx.container = Math.floor(this.rng() * CONTAINER_NAMES.length);
    this.nameIdx.cruise = Math.floor(this.rng() * CRUISE_NAMES.length);
  }

  setup(): void {
    for (const b of PORT_BERTHS) this.spawnAt(b, b.heading, false);
    // 2–4 at anchor, 1–2 under way, never more than 8 ships in all
    const anchored = 2 + Math.floor(this.rng() * 3);
    const moving = anchored < 4 && this.rng() < 0.5 ? 2 : 1;
    const slots = ANCHORAGES.slice();
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    for (const b of slots.slice(0, anchored)) this.spawnAt(b, b.heading + (this.rng() - 0.5) * 30, true);
    for (const r of SHIP_ROUTES.slice(0, moving)) this.spawnOnRoute(r);
  }

  private nextName(v: VesselClass): string {
    const list = v === 'cruise' ? CRUISE_NAMES : CONTAINER_NAMES;
    return list[this.nameIdx[v]++ % list.length];
  }

  private spawnAt(b: ShipBerth, headingDeg: number, anchored: boolean): GroundTargetEntity {
    const e = this.s.world.spawnGround({
      type: 'ship',
      team: 'neutral',
      vessel: b.vessel,
      position: new Vector3(b.x, 0, b.z),
      heading: headingDeg * DEG,
      anchored,
      name: this.nextName(b.vessel),
      groupId: 'civil-ship',
    });
    return this.register(e);
  }

  private spawnOnRoute(r: ShipRoute): GroundTargetEntity {
    const pts = routePoints(r);
    const k = Math.floor(this.rng() * pts.length);
    // start on point k, sail the loop from k+1 round to k
    const path = [...pts.slice(k + 1), ...pts.slice(0, k + 1)];
    const e = this.s.world.spawnGround({
      type: 'ship',
      team: 'neutral',
      vessel: r.vessel,
      position: pts[k].clone(),
      path,
      loopPath: true,
      speed: r.speed,
      name: this.nextName(r.vessel),
      groupId: 'civil-ship',
    });
    return this.register(e);
  }

  private register(e: GroundTargetEntity): GroundTargetEntity {
    e.known = false; // no intel picture: only the player's own EOTS / radar ground map show them
    this.ships.push(e);
    return e;
  }
}
