/**
 * F35-A — the Auckland Sky Tower: shape data and the scripted collapse, shared by the sim (hit
 * and collision tests, collapse explosions) and the renderer (mesh, topple animation).
 *
 * Shape: OpenStreetMap Simple-3D-Buildings parts of relation 19745928 (© OpenStreetMap
 * contributors, ODbL), radii measured about the shaft axis, cross-checked against the LINZ 2024
 * 1 m DSM (top ≈ 324.5 m above ground; the mast tip is undersampled, the official height is
 * 328 m). Heights are metres above the tower's base, radii metres from the axis.
 *
 * Collapse: the shaft breaks low, the upper section (shaft, pod and mast) topples about the break
 * with a constant (gravity-like) angular acceleration while its foot slides off the stump, the
 * mast snaps part-way, the pod hits the ground, and the stump and rubble stay. Everything is a
 * pure function of the time since the break and the fall heading, so the sim and the renderer
 * agree without sharing state.
 */

/** Total height (m), base to mast tip. */
export const SKY_TOWER_HEIGHT = 328;

export type TowerMaterial = 'concrete' | 'metal' | 'refuge' | 'glass' | 'mast';

/** One vertical band of the profile: a (tapered) cylinder from y0 to y1, radius r0 → r1. */
export interface TowerBand {
  name: string;
  y0: number;
  y1: number;
  r0: number;
  r1: number;
  material: TowerMaterial;
}

/** The OSM building parts, bottom to top (the 8 buttress legs are in SKY_TOWER_LEGS). */
export const SKY_TOWER_BANDS: readonly TowerBand[] = [
  { name: 'shaft', y0: 0, y1: 182, r0: 6.1, r1: 6.1, material: 'concrete' },
  { name: 'collar', y0: 35, y1: 45, r0: 7.7, r1: 7.7, material: 'concrete' },
  { name: 'service level', y0: 154, y1: 159, r0: 9.5, r1: 9.5, material: 'metal' },
  { name: 'metal levels', y0: 159, y1: 165, r0: 10.4, r1: 10.4, material: 'metal' },
  { name: 'fire refuge', y0: 165, y1: 172, r0: 10.6, r1: 10.6, material: 'refuge' },
  { name: 'metal levels', y0: 172, y1: 179, r0: 10.4, r1: 10.4, material: 'metal' },
  { name: 'SkyBar', y0: 179, y1: 183, r0: 11.7, r1: 11.7, material: 'glass' },
  { name: 'Main Observation Level', y0: 183, y1: 187, r0: 13.6, r1: 13.6, material: 'glass' },
  { name: 'Orbit 360° Dining', y0: 187, y1: 194, r0: 16.6, r1: 16.6, material: 'glass' },
  { name: 'SkyWalk', y0: 194, y1: 195, r0: 20.1, r1: 20.1, material: 'metal' },
  { name: 'The Sugar Club', y0: 194, y1: 198, r0: 15.8, r1: 15.8, material: 'glass' },
  { name: 'upper pod', y0: 198, y1: 242, r0: 10.8, r1: 0, material: 'metal' },
  { name: 'Sky Deck', y0: 220, y1: 224, r0: 6.5, r1: 6.5, material: 'glass' },
  { name: 'ring', y0: 224, y1: 225, r0: 8.0, r1: 8.0, material: 'concrete' },
  { name: 'ring', y0: 235, y1: 236, r0: 5.3, r1: 5.3, material: 'concrete' },
  { name: 'mast', y0: 182, y1: 290, r0: 2.1, r1: 2.1, material: 'mast' },
  { name: 'mast', y0: 290, y1: 310, r0: 1.3, r1: 1.3, material: 'mast' },
  { name: 'mast tip', y0: 310, y1: 328, r0: 0.6, r1: 0.6, material: 'mast' },
];

/**
 * The 8 concrete buttress legs (OSM `roof:shape=skillion`, roof directions 0/45/…/315°): thin
 * wedges from the shaft face (r 6.0, 80 m high) sloping down to the ground at r 7.8.
 */
export const SKY_TOWER_LEGS = { count: 8, rIn: 6.0, rOut: 7.8, width: 1.3, height: 80 } as const;

/** OSM colours: concrete and glass / mast. */
export const SKY_TOWER_COLOURS = { concrete: 0xaab0ac, glass: 0x9ba9a9 } as const;

/**
 * Hit / collision volume: vertical cylinders (rounded at the ends by the distance test), a
 * slightly generous envelope of the bands (the pod's tiers merged, the upper cone stepped).
 */
export interface TowerHitPart {
  y0: number;
  y1: number;
  r: number;
}

export const SKY_TOWER_HIT_PARTS: readonly TowerHitPart[] = [
  { y0: 0, y1: 80, r: 7.8 }, // shaft + legs + collar
  { y0: 80, y1: 154, r: 6.1 }, // shaft
  { y0: 154, y1: 179, r: 10.6 }, // metal levels
  { y0: 179, y1: 187, r: 13.6 }, // SkyBar, observation level
  { y0: 187, y1: 198, r: 16.6 }, // Orbit, Sugar Club
  { y0: 194, y1: 195, r: 20.1 }, // SkyWalk ring
  { y0: 198, y1: 220, r: 10.8 }, // upper pod (lower half of the cone)
  { y0: 220, y1: 242, r: 8.0 }, // upper pod top, Sky Deck, rings
  { y0: 242, y1: 290, r: 2.1 }, // mast
  { y0: 290, y1: 310, r: 1.3 },
  { y0: 310, y1: 328, r: 0.6 },
];

/* ───────────────────────────── Collapse ───────────────────────────── */

/** Collapse timeline (s after the break) and geometry (m above the base). */
export const COLLAPSE = {
  /** The shaft breaks here (stump = legs, collar and the bottom of the shaft). */
  breakHeight: 62,
  /** The mast snaps here, this long after the break. */
  mastSnapHeight: 262,
  mastSnapAt: 3.6,
  /** The pod hits the ground. */
  impactAt: 6.4,
  /** Tilt of the upper section at impact (rad, from vertical). */
  tiltAtImpact: (86 * Math.PI) / 180,
  /** Extra tilt of the snapped mast at impact (rad). */
  mastExtraAtImpact: (8 * Math.PI) / 180,
  /** The foot of the upper section slides off the stump: drop (m) and slide (m) at impact. */
  footDrop: 56,
  footSlide: 18,
  /** The foot starts sliding this long after the break. */
  footSlideFrom: 2.2,
  /** The falling sections are swapped for the rubble field (hidden in the impact dust). */
  ruinsAt: 7.4,
} as const;

/** Upper-section pose at `t` s after the break (t < 0 = standing). */
export interface CollapsePose {
  /** Tilt of the upper section from vertical, toward the fall heading (rad). */
  tilt: number;
  /** Extra tilt of the snapped mast relative to the upper section (rad). */
  mastTilt: number;
  /** Foot of the upper section (the break point): metres along the fall heading / above the base. */
  footAlong: number;
  footUp: number;
}

export function collapsePose(t: number, out: CollapsePose = { tilt: 0, mastTilt: 0, footAlong: 0, footUp: COLLAPSE.breakHeight }): CollapsePose {
  const C = COLLAPSE;
  if (!(t > 0)) {
    out.tilt = 0;
    out.mastTilt = 0;
    out.footAlong = 0;
    out.footUp = C.breakHeight;
    return out;
  }
  const u = Math.min(1, t / C.impactAt);
  out.tilt = C.tiltAtImpact * u * u; // constant angular acceleration from rest
  const m = t <= C.mastSnapAt ? 0 : Math.min(1, (t - C.mastSnapAt) / (C.impactAt - C.mastSnapAt));
  out.mastTilt = C.mastExtraAtImpact * m * m;
  const f = t <= C.footSlideFrom ? 0 : Math.min(1, (t - C.footSlideFrom) / (C.impactAt - C.footSlideFrom));
  out.footAlong = C.footSlide * f * f;
  out.footUp = C.breakHeight - C.footDrop * f * f;
  return out;
}

const _pose: CollapsePose = { tilt: 0, mastTilt: 0, footAlong: 0, footUp: 0 };

/**
 * Where a point of the tower axis that stood `h` m above the base is at `t` s after the break:
 * writes metres along the fall heading and above the base into `out` ([along, up]).
 */
export function towerAxisPoint(h: number, t: number, out: [number, number] = [0, 0]): [number, number] {
  const C = COLLAPSE;
  if (!(t > 0) || h <= C.breakHeight) {
    out[0] = 0;
    out[1] = h;
    return out;
  }
  const p = collapsePose(t, _pose);
  const l = Math.min(h, C.mastSnapHeight) - C.breakHeight;
  let along = p.footAlong + l * Math.sin(p.tilt);
  let up = p.footUp + l * Math.cos(p.tilt);
  if (h > C.mastSnapHeight) {
    const lm = h - C.mastSnapHeight;
    const a = p.tilt + p.mastTilt;
    along += lm * Math.sin(a);
    up += lm * Math.cos(a);
  }
  out[0] = along;
  out[1] = up;
  return out;
}

/** Height of the pod's centre (Orbit / Sugar Club) — where the big impact explosion goes. */
export const POD_HEIGHT = 192;

/** Unit vector (x, z) of a fall heading (rad, 0 = north, clockwise). */
export function headingDir(heading: number): [number, number] {
  return [Math.sin(heading), -Math.cos(heading)];
}

/**
 * Deterministic fall heading: away from the side the blast came from (a hit dead on the axis falls
 * away from the attacker; with neither, north-east).
 */
export function fallHeading(towerX: number, towerZ: number, blastX: number, blastZ: number, attackerX?: number, attackerZ?: number): number {
  let dx = towerX - blastX;
  let dz = towerZ - blastZ;
  if (dx * dx + dz * dz < 0.25 && attackerX !== undefined && attackerZ !== undefined) {
    dx = towerX - attackerX;
    dz = towerZ - attackerZ;
  }
  if (dx * dx + dz * dz < 0.25) return Math.PI / 4;
  const h = Math.atan2(dx, -dz);
  return h < 0 ? h + Math.PI * 2 : h;
}
