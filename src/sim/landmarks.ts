/**
 * F35-A — protected landmarks (SIM-CORE): the Sky Tower.
 *
 * A landmark is not an Entity: it is never in `aircraft` / `sams` / `ground`, so sensors, target
 * cycling, AI, objectives and scoring never see it. It is a static structure with a vertical
 * cylinder-stack hit volume (core/skyTower.ts) that
 *  - the player's bombs, AGMs and AAMs destroy with one hit whose blast reaches it (the gun and
 *    everybody else's munitions do not),
 *  - stops munitions and gun rounds that fly into it,
 *  - crashes aircraft that fly into it (without hurting it).
 * Once destroyed it plays the scripted collapse (explosions on the timeline in core/skyTower.ts)
 * and emits 'landmark:destroyed' (the mission fails) and 'landmark:impact' (the pod hits the ground).
 */
import { Vector3 } from 'three';
import type { EventBus } from '../core/events';
import type { MunitionId } from '../core/types';
import { COLLAPSE, POD_HEIGHT, SKY_TOWER_HIT_PARTS, fallHeading, headingDir, towerAxisPoint, type TowerHitPart } from '../core/skyTower';
import { AKL } from '../core/auckland';

export type LandmarkId = 'skytower';

/** A blast reaches the structure (and destroys it) inside this fraction of the warhead's blast radius. */
export const STRUCTURAL_BLAST_FRACTION = 0.3;

export class LandmarkEntity {
  readonly kind = 'landmark' as const;
  alive = true;
  /** Sim time of destruction (-1 = standing). */
  destroyedAt = -1;
  /** Fall heading (rad, 0 = north, clockwise). */
  fallHeading = 0;
  attackerId: number | null = null;
  weapon: MunitionId | null = null;
  readonly hitPoint = new Vector3();
  /** Index of the next collapse event to emit. */
  collapseStep = 0;
  /** Horizontal bounding radius (m) of the hit volume. */
  readonly reach: number;
  readonly height: number;

  constructor(
    readonly id: LandmarkId,
    readonly name: string,
    /** Base of the axis (y = ground). */
    readonly base: Vector3,
    readonly parts: readonly TowerHitPart[],
  ) {
    let r = 0;
    let h = 0;
    for (const p of parts) {
      r = Math.max(r, p.r);
      h = Math.max(h, p.y1);
    }
    this.reach = r;
    this.height = h;
  }
}

/** The Sky Tower standing on the terrain at its OSM axis. */
export function createSkyTower(groundY: number): LandmarkEntity {
  const { x, z } = AKL.skytower;
  return new LandmarkEntity('skytower', 'Sky Tower', new Vector3(x, groundY, z), SKY_TOWER_HIT_PARTS);
}

/** Distance from a point to the surface of the hit volume (≤ 0 inside). */
export function landmarkDistance(lm: LandmarkEntity, p: Vector3): number {
  const dx = p.x - lm.base.x;
  const dz = p.z - lm.base.z;
  const rho = Math.sqrt(dx * dx + dz * dz);
  const y = p.y - lm.base.y;
  let best = Infinity;
  for (const part of lm.parts) {
    const dy = y < part.y0 ? part.y0 - y : y > part.y1 ? y - part.y1 : 0;
    const dr = rho - part.r;
    const d = dy === 0 ? dr : Math.sqrt(Math.max(0, dr) ** 2 + dy * dy);
    if (d < best) best = d;
  }
  return best;
}

/**
 * First contact of the segment a→b with the hit volume grown by `pad` metres: the fraction along
 * the segment (0..1), or -1. Exact for the cylinder stack (a quadratic per part).
 */
export function landmarkSegmentHit(lm: LandmarkEntity, a: Vector3, b: Vector3, pad = 0): number {
  const ax = a.x - lm.base.x;
  const az = a.z - lm.base.z;
  const ay = a.y - lm.base.y;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const dy = b.y - a.y;
  // quick reject: both ends above / beside the whole volume
  const R = lm.reach + pad;
  if (Math.min(ay, ay + dy) > lm.height + pad) return -1;
  const ex = ax + dx;
  const ez = az + dz;
  const minX = Math.min(ax, ex);
  const maxX = Math.max(ax, ex);
  const minZ = Math.min(az, ez);
  const maxZ = Math.max(az, ez);
  if (minX > R || maxX < -R || minZ > R || maxZ < -R) return -1;
  let first = -1;
  const A = dx * dx + dz * dz;
  const B = 2 * (ax * dx + az * dz);
  const C0 = ax * ax + az * az;
  for (const part of lm.parts) {
    const r = part.r + pad;
    // interval of s where the horizontal distance to the axis ≤ r
    let s0: number;
    let s1: number;
    const C = C0 - r * r;
    if (A < 1e-9) {
      if (C > 0) continue;
      s0 = 0;
      s1 = 1;
    } else {
      const disc = B * B - 4 * A * C;
      if (disc < 0) continue;
      const q = Math.sqrt(disc);
      s0 = (-B - q) / (2 * A);
      s1 = (-B + q) / (2 * A);
    }
    // interval where the height is inside the part
    const y0 = part.y0 - pad;
    const y1 = part.y1 + pad;
    let t0: number;
    let t1: number;
    if (Math.abs(dy) < 1e-9) {
      if (ay < y0 || ay > y1) continue;
      t0 = 0;
      t1 = 1;
    } else {
      const u = (y0 - ay) / dy;
      const v = (y1 - ay) / dy;
      t0 = Math.min(u, v);
      t1 = Math.max(u, v);
    }
    const lo = Math.max(0, s0, t0);
    const hi = Math.min(1, s1, t1);
    if (lo > hi) continue;
    if (first < 0 || lo < first) first = lo;
  }
  return first;
}

/** Live landmark whose volume the segment a→b enters (and the contact fraction), or null. */
export function firstLandmarkHit(list: readonly LandmarkEntity[] | undefined, a: Vector3, b: Vector3, pad = 0): { landmark: LandmarkEntity; s: number } | null {
  if (!list) return null;
  let best: { landmark: LandmarkEntity; s: number } | null = null;
  for (const lm of list) {
    if (!lm.alive) continue;
    const s = landmarkSegmentHit(lm, a, b, pad);
    if (s >= 0 && (!best || s < best.s)) best = { landmark: lm, s };
  }
  return best;
}

/** Destroy a landmark (one hit kills): records who did it and the fall heading; emits 'landmark:destroyed'. */
export function destroyLandmark(
  lm: LandmarkEntity,
  events: EventBus,
  time: number,
  point: Vector3,
  attackerId: number | null,
  weapon: MunitionId | null,
  attackerPos?: Vector3,
): void {
  if (!lm.alive) return;
  lm.alive = false;
  lm.destroyedAt = time;
  lm.attackerId = attackerId;
  lm.weapon = weapon;
  lm.hitPoint.copy(point);
  lm.fallHeading = fallHeading(lm.base.x, lm.base.z, point.x, point.z, attackerPos?.x, attackerPos?.z);
  lm.collapseStep = 0;
  events.emit('landmark:destroyed', { landmark: lm, attackerId, weapon, position: lm.hitPoint });
}

const _ev = new Vector3();
const _ax: [number, number] = [0, 0];

/** World position of the tower axis point that stood `h` m up, `t` s into the collapse. */
export function landmarkAxisPoint(lm: LandmarkEntity, h: number, t: number, out: Vector3): Vector3 {
  towerAxisPoint(h, t, _ax);
  const [ux, uz] = headingDir(lm.fallHeading);
  return out.set(lm.base.x + ux * _ax[0], lm.base.y + _ax[1], lm.base.z + uz * _ax[0]);
}

/** Collapse events: [time after the break, what]. */
const COLLAPSE_EVENTS: readonly { t: number; kind: 'break' | 'break2' | 'mast' | 'impact' | 'rubble1' | 'rubble2' }[] = [
  { t: 0, kind: 'break' },
  { t: 0.5, kind: 'break2' },
  { t: COLLAPSE.mastSnapAt, kind: 'mast' },
  { t: COLLAPSE.impactAt, kind: 'impact' },
  { t: COLLAPSE.impactAt + 0.35, kind: 'rubble1' },
  { t: COLLAPSE.impactAt + 0.8, kind: 'rubble2' },
];

/** Emit the collapse's explosions on their timeline (called every sim step). */
export function stepLandmarks(list: readonly LandmarkEntity[], time: number, events: EventBus, groundAt: (x: number, z: number) => number): void {
  for (const lm of list) {
    if (lm.alive || lm.collapseStep >= COLLAPSE_EVENTS.length) continue;
    const t = time - lm.destroyedAt;
    while (lm.collapseStep < COLLAPSE_EVENTS.length && t >= COLLAPSE_EVENTS[lm.collapseStep].t) {
      const e = COLLAPSE_EVENTS[lm.collapseStep++];
      const at = e.t + 1e-3;
      switch (e.kind) {
        case 'break':
          events.emit('explosion', { position: landmarkAxisPoint(lm, COLLAPSE.breakHeight, 0, _ev), size: 'huge', surface: 'air' });
          break;
        case 'break2':
          events.emit('explosion', { position: landmarkAxisPoint(lm, COLLAPSE.breakHeight - 6, 0, _ev), size: 'large', surface: 'air' });
          break;
        case 'mast':
          events.emit('explosion', { position: landmarkAxisPoint(lm, COLLAPSE.mastSnapHeight, at, _ev), size: 'medium', surface: 'air' });
          break;
        case 'impact': {
          const pod = landmarkAxisPoint(lm, POD_HEIGHT, at, _ev);
          pod.y = groundAt(pod.x, pod.z);
          events.emit('explosion', { position: pod, size: 'huge', surface: 'ground' });
          events.emit('landmark:impact', { landmark: lm, position: pod, heading: lm.fallHeading });
          break;
        }
        case 'rubble1':
        case 'rubble2': {
          const h = e.kind === 'rubble1' ? 120 : 290;
          const p = landmarkAxisPoint(lm, h, at, _ev);
          p.y = groundAt(p.x, p.z);
          events.emit('explosion', { position: p, size: 'large', surface: 'ground' });
          break;
        }
      }
    }
  }
}
