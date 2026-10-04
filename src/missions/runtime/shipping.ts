/**
 * Civil shipping around Auckland (Auckland theatre only, gated with the airliners by
 * deps.civilTraffic): neutral container ships and cruise liners of the fictional Kōtuku Line.
 *
 * Wartime, port closed: the ships alongside at the Ports of Auckland and Princes Wharf stay moored,
 * 2–4 more swing at anchor in the outer Hauraki Gulf, and 1–2 steam slow loops in the deep-water
 * channel north of Rangitoto, well clear of the enemy-held islands. At most 8 ships per sortie.
 * A Stroll in the Park is peacetime: two more sail the harbour lane past the city (HARBOUR_LANE).
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
 * Ships alongside in port, on the real berth faces: the Ports of Auckland outline from OpenStreetMap
 * (aucklandOsm.ts OSM_PORT, which also has the new Fergusson reclamation the LINZ coastline lacks) and
 * the Princes Wharf cruise terminal. Each hull lies along its face, fully on the LINZ water and clear
 * of the port outline (tests/civil-shipping.test.ts, tests/world-sites.test.ts).
 */
export const PORT_BERTHS: readonly ShipBerth[] = [
  { x: 2017, z: -971, heading: 276, vessel: 'container' }, // Fergusson North
  { x: 1849, z: -799, heading: 348, vessel: 'container' }, // Fergusson West, bow out of the basin
  { x: 361, z: -923, heading: 18, vessel: 'cruise' }, // Princes Wharf, east side
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

/**
 * A Stroll in the Park is peacetime (#113: "Everyone's friendly"): the port is open, so two more ships
 * sail the Waitematā past the tour, from off Devonport round North Head and up the Rangitoto Channel to
 * the Gulf and back. Control points of the closed lane (world XZ), keeping to starboard: northbound on
 * the east side of the channel, southbound on the west. The smoothed loop (lanePoints) stays on the
 * LINZ water with the whole hull, in more than 5 m (tests/civil-shipping.test.ts), and east of every
 * ferry route (they all run west of x = 3,000).
 */
export const HARBOUR_LANE: readonly [number, number][] = [
  // northbound: off Devonport, round North Head, up the channel
  [4300, -1150],
  [5200, -1300],
  [6150, -1900],
  [6450, -2800],
  [6150, -3900],
  [5300, -5000],
  [4800, -6200],
  [4600, -7500],
  [4800, -9000],
  [5100, -10500],
  [4900, -11800],
  // the turn in the Gulf
  [4300, -12250],
  [3700, -11800],
  // southbound
  [3750, -10500],
  [3900, -9000],
  [3900, -7500],
  [4000, -6200],
  [4500, -5000],
  [5450, -3900],
  [5800, -2800],
  [5600, -2050],
  [4900, -1600],
  [4000, -1350],
  [3350, -1100],
  [3500, -900],
];
/** Peacetime harbour traffic (A Stroll in the Park only): who sails the lane, half a loop apart. */
const LANE_VESSELS: readonly VesselClass[] = ['cruise', 'container'];
/** Speed on the lane (m/s, ≈ 12 kn): both the same, so they never close on each other. */
export const LANE_SPEED = 6;

/**
 * The harbour lane as a closed waypoint loop (centripetal Catmull-Rom through the control points),
 * about `step` m between waypoints, so the heading snaps by a degree or two at each.
 */
export function lanePoints(ctrl: readonly [number, number][] = HARBOUR_LANE, step = 25): Vector3[] {
  const n = ctrl.length;
  const pts: Vector3[] = [];
  const P = (i: number) => ctrl[((i % n) + n) % n];
  for (let i = 0; i < n; i++) {
    const p0 = P(i - 1);
    const p1 = P(i);
    const p2 = P(i + 1);
    const p3 = P(i + 2);
    // centripetal knots (no cusps or overshoot on uneven spacing)
    const kt = (a: readonly number[], b: readonly number[]) => Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1]));
    const t1 = kt(p0, p1);
    const t2 = t1 + kt(p1, p2);
    const t3 = t2 + kt(p2, p3);
    const segs = Math.max(1, Math.round(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 0; k < segs; k++) {
      const t = t1 + ((t2 - t1) * k) / segs;
      const xz = [0, 1].map((c) => {
        const a1 = ((t1 - t) / t1) * p0[c] + (t / t1) * p1[c];
        const a2 = ((t2 - t) / (t2 - t1)) * p1[c] + ((t - t1) / (t2 - t1)) * p2[c];
        const a3 = ((t3 - t) / (t3 - t2)) * p2[c] + ((t - t2) / (t3 - t2)) * p3[c];
        const b1 = ((t2 - t) / t2) * a1 + (t / t2) * a2;
        const b2 = ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3;
        return ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2;
      });
      pts.push(new Vector3(xz[0], 0, xz[1]));
    }
  }
  return pts;
}

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
/** Crude carriers (the random traffic has none; a mission's escorted tanker may take one of these). */
export const TANKER_NAMES = ['MT Marsden Point', 'MT Tasman Spirit', 'MT Pacific Kauri'];
const NAMES: Record<VesselClass, readonly string[]> = { container: CONTAINER_NAMES, cruise: CRUISE_NAMES, tanker: TANKER_NAMES };

export class CivilShipping {
  private readonly rng: () => number;
  /** Every civil ship spawned this sortie. */
  readonly ships: GroundTargetEntity[] = [];
  private nameIdx: Record<VesselClass, number> = { container: 0, cruise: 0, tanker: 0 };

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
    if (this.s.script.freeFlight) this.spawnHarbourLane();
  }

  /** Peacetime (free flight): a cruise liner and a container ship sail the harbour lane, half a loop apart. */
  private spawnHarbourLane(): void {
    const pts = lanePoints();
    const k0 = Math.floor(this.rng() * pts.length);
    LANE_VESSELS.forEach((vessel, i) => {
      const k = (k0 + Math.round((i * pts.length) / LANE_VESSELS.length)) % pts.length;
      this.spawnOnPath(vessel, pts, k, LANE_SPEED);
    });
  }

  private nextName(v: VesselClass): string {
    const list = NAMES[v];
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
    return this.spawnOnPath(r.vessel, pts, Math.floor(this.rng() * pts.length), r.speed);
  }

  /** A ship on point k of a closed loop, sailing from k+1 round to k. */
  private spawnOnPath(vessel: VesselClass, pts: Vector3[], k: number, speed: number): GroundTargetEntity {
    const path = [...pts.slice(k + 1), ...pts.slice(0, k + 1)];
    const e = this.s.world.spawnGround({
      type: 'ship',
      team: 'neutral',
      vessel,
      position: pts[k].clone(),
      path,
      loopPath: true,
      speed,
      name: this.nextName(vessel),
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
