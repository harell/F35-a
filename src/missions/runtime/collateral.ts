/**
 * F35-A — homes hit by the player's bombs (MissionScript.collateral, t04 "Combined Overflow").
 *
 * The houses of the hero neighbourhoods (Herne Bay) and the LINZ buildings are scenery: a bomb falls
 * through a roof to the ground and nothing in the sim takes damage. A mission that asks for it counts
 * the homes inside a bomb's damage ring instead: every building with any part of its footprint within
 * HOME_DAMAGE_FRACTION × the weapon's blast radius of where one of the player's bombs or missiles
 * went off on land. Each impact calls "check fire" on the radio with the count, the HUD flags it,
 * and the debrief lists the total; scoring.ts takes POINTS.home off the score and
 * HOME_RATING_PENALTY off the rating for each one.
 *
 * With the munitions' blast radii (sim/weapons/defs.ts) a 2,000 lb JDAM (60 m blast) reaches homes 30 m out and a StormBreaker (14 m) 7 m:
 * dropped on a street, the JDAM takes out several houses and the StormBreaker the front fence at most.
 * Over the water nothing is counted: that is the point of the lesson.
 *
 * Building data that hasn't loaded (headless tests, a failed fetch) counts nothing.
 */
import type { Vector3 } from 'three';
import { MUNITIONS } from '../../sim/weapons/defs';
import { aucklandBuildings, type Building } from '../../world/scenery/aucklandBuildings';
import type { MissionState } from './state';

/** Share of a weapon's blast radius inside which a house is counted as hit. */
export const HOME_DAMAGE_FRACTION = 0.5;
/** A munition that ends this close to the ground (m) went off on it. */
const SURFACE_BURST = 4;
/** Rough size (m) of the largest footprint, for the cheap first test on its centre. */
const MAX_FOOTPRINT = 60;

/** Distance (m) from (x, z) to a flat footprint ring: 0 inside it. */
export function ringDistance(ring: ArrayLike<number>, x: number, z: number): number {
  const n = ring.length / 2;
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const zi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const zj = ring[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    const dx = xi - xj;
    const dz = zi - zj;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - xj) * dx + (z - zj) * dz) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (xj + t * dx), z - (zj + t * dz)));
  }
  return inside ? 0 : best;
}

/** Buildings with any part of their footprint within `radius` m of (x, z). */
export function homesWithin(buildings: readonly Building[], x: number, z: number, radius: number): number {
  let n = 0;
  for (const b of buildings) {
    const p0 = b.prisms[0];
    if (!p0 || Math.abs(p0.cx - x) > radius + MAX_FOOTPRINT || Math.abs(p0.cz - z) > radius + MAX_FOOTPRINT) continue;
    if (b.prisms.some((p) => ringDistance(p.ring, x, z) <= radius)) n++;
  }
  return n;
}

export class HomesWatch {
  private unsub: (() => void) | null = null;

  constructor(
    private readonly s: MissionState,
    /** The building list (default: the installed LINZ and neighbourhood buildings). */
    private readonly buildings: () => readonly Building[] | null = aucklandBuildings,
  ) {}

  setup(): void {
    const s = this.s;
    this.unsub = s.events.on('munition:end', ({ missile, position, reason }) => {
      if (s.disposed || s.state !== 'running' || reason === 'decoyed' || reason === 'selfdestruct') return;
      const p = s.player;
      const cat = missile.def.category;
      if (!p || missile.shooterId !== p.id || (cat !== 'bomb' && cat !== 'agm')) return;
      this.impact(position, MUNITIONS[missile.def.id]?.blastRadius ?? 0);
    });
  }

  detach(): void {
    this.unsub?.();
    this.unsub = null;
  }

  /** One of the player's munitions went off at `at`: count the homes in its damage ring. */
  impact(at: Vector3, blastRadius: number): number {
    const s = this.s;
    const terrain = s.world.terrain;
    if (at.y - terrain.surfaceHeightAt(at.x, at.z) > SURFACE_BURST || terrain.isWater(at.x, at.z)) return 0;
    const list = this.buildings();
    if (!list || blastRadius <= 0) return 0;
    const n = homesWithin(list, at.x, at.z, blastRadius * HOME_DAMAGE_FRACTION);
    if (n <= 0) return 0;
    s.homesHit += n;
    s.hud(n === 1 ? 'HOME HIT' : `${n} HOMES HIT`, 'bad', 3.5);
    s.radio.push({
      from: s.awacsCallsign,
      text: `Check fire, check fire! ${s.callsign}, that bomb went into ${n === 1 ? 'a house' : `${n} houses`}. Keep the big ones off the street.`,
      priority: 4,
    });
    return n;
  }
}
