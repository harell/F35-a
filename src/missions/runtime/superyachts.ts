/**
 * Named superyachts on the Auckland waterfront (#145; Auckland theatre only, gated with the other civil traffic by
 * deps.civilTraffic): Koru on Wynyard Wharf, A at Silo Marina and Aquijo in the Viaduct, at their berths
 * (SUPERYACHT_BERTHS, core/superyachts.ts), and now and then Serene under way on the Waitematā (always in A Stroll in
 * the Park, half the sorties otherwise): east past the port toward North Head and Rangitoto at 10 kn and back.
 *
 * Like the merchant ships (shipping.ts) they are neutral sim ground entities of type 'ship', each yacht her own
 * VesselClass: off the enemy datalink, boxed CIV (named on the designated box and in the pod window), ranked behind
 * every hostile, AI and SAMs never engage them. One bomb or missile sinks one (Damage), the same sinking hull, fires and
 * slick as a merchant ship, and the Callouts module makes it a civilian loss ("CIVILIAN YACHT DESTROYED"), never a kill
 * or a failed sortie.
 */
import { Vector3 } from 'three';
import { mulberry32 } from '../../core/math';
import { SUPERYACHTS, SUPERYACHT_BERTHS, UNDERWAY_YACHT, type SuperyachtId } from '../../core/superyachts';
import type { GroundTargetEntity } from '../../sim/entities';
import { lanePoints } from './shipping';
import type { MissionState } from './state';

const DEG = Math.PI / 180;

/**
 * The yacht's harbour loop (world XZ control points, smoothed by lanePoints): from off Wynyard Point east along the
 * city side of the Waitematā past the port's wharves, a turn off Torpedo Bay under North Head with Rangitoto ahead,
 * and back west off Devonport, keeping to starboard. It stays inside the harbour, west of the merchant ships' lane
 * (HARBOUR_LANE) and the enemy-held island. The whole hull stays on the LINZ water in more than 4 m, clear of the
 * moored ships and the berths (tests/civil-superyachts.test.ts).
 */
export const YACHT_LANE: readonly [number, number][] = [
  // eastbound on the city side of the harbour, past the port's wharves
  [-400, -1450],
  [500, -1400],
  [1500, -1400],
  [2500, -1450],
  [3300, -1500],
  // the turn off Torpedo Bay, under North Head, looking out to Rangitoto
  [3850, -1580],
  [3920, -1680],
  [3550, -1730],
  // westbound off Devonport and Stanley Bay
  [2500, -1690],
  [1500, -1680],
  [500, -1700],
  [-300, -1650],
  // the turn off Wynyard Point
  [-750, -1580],
  [-800, -1480],
];

/** Speed on the loop (m/s): 10 kn, in the issue's 8–12 kn. */
export const YACHT_SPEED = 5.1;

/** Share of the combat sorties with a yacht under way (A Stroll in the Park always has one). */
export const UNDERWAY_CHANCE = 0.5;

export class SuperyachtTraffic {
  private readonly rng: () => number;
  /** Every yacht spawned this sortie. */
  readonly yachts: GroundTargetEntity[] = [];

  constructor(private readonly s: MissionState) {
    this.rng = mulberry32(((s.def.seed ?? 1) * 7919 + 145) >>> 0);
  }

  setup(): void {
    for (const b of SUPERYACHT_BERTHS) {
      const e = this.s.world.spawnGround({
        type: 'ship',
        team: 'neutral',
        vessel: b.yacht,
        position: new Vector3(b.x, 0, b.z),
        heading: b.heading * DEG,
        name: SUPERYACHTS[b.yacht].name,
        groupId: 'civil-yacht',
      });
      this.register(e);
    }
    const roll = this.rng();
    if (this.s.script.freeFlight || roll < UNDERWAY_CHANCE) this.spawnUnderway(UNDERWAY_YACHT);
  }

  private spawnUnderway(id: SuperyachtId): void {
    const pts = lanePoints(YACHT_LANE);
    const k = Math.floor(this.rng() * pts.length);
    const path = [...pts.slice(k + 1), ...pts.slice(0, k + 1)];
    const e = this.s.world.spawnGround({
      type: 'ship',
      team: 'neutral',
      vessel: id,
      position: pts[k].clone(),
      path,
      loopPath: true,
      speed: YACHT_SPEED,
      name: SUPERYACHTS[id].name,
      groupId: 'civil-yacht',
    });
    this.register(e);
  }

  private register(e: GroundTargetEntity): void {
    e.known = false; // no intel picture: only the player's own EOTS / radar ground map show them
    this.yachts.push(e);
  }
}
