/**
 * Scenery feature footprints: how much ground each feature flattens and keeps dry, plus the
 * shared airbase layout (used by the terrain flattener, the colour baker and the scenery builder,
 * so runways always sit on the flattened strip).
 */
import type { SceneryFeature } from '../../core/contracts';
import { AIRFIELDS, airfieldNear, mainRunway, type AirfieldId } from '../../core/airfields';
import type { Footprint } from './types';

/* ───────────── Airbase layout (local frame: v along the runway heading, u to its right) ───────────── */
export const AIRBASE = {
  runwayLength: 3000,
  runwayWidth: 45,
  /** Lateral offset of the parallel taxiway centre line (m, to the right of the runway). */
  taxiOffset: 190,
  taxiWidth: 23,
  /** Apron: lateral range and length. */
  apronU0: 250,
  apronU1: 420,
  apronHalfLen: 420,
  /** Buildings strip (shelters, tower, hangars) lateral range. */
  buildU0: 430,
  buildU1: 700,
  /** Flatten rectangle (lateral centre offset + half extents). */
  flatCenterU: 240,
  flatHalfW: 560,
  flatHalfL: 1950,
  flatBlend: 1500,
} as const;

const DEG = Math.PI / 180;

/** The real airfield (src/core/airfields.ts) an airbase feature stands for, if any. */
export function airfieldOf(f: SceneryFeature): AirfieldId | null {
  if (f.type !== 'airbase') return null;
  if (f.airfield && f.airfield in AIRFIELDS) return f.airfield as AirfieldId;
  return airfieldNear(f.x, f.z, 800)?.id ?? null;
}

/**
 * Runway length (m) of an airbase feature: the real main runway of one of Auckland's airfields
 * (Auckland Airport's 05R/23L, RNZAF Whenuapai's 2,020 m 03/21, …), 3 km elsewhere.
 */
export function runwayLengthFor(f: SceneryFeature): number {
  const id = airfieldOf(f);
  return id ? Math.round(mainRunway(id).length) : AIRBASE.runwayLength;
}

/** Polygon footprint over a ring (flat XZ): bounding box in the `heading` frame, core grown by `grow` m. */
export function polyFootprint(ring: ArrayLike<number>, heading: number, grow: number, blend: number, minLevel: number): Footprint {
  const sh = Math.sin(heading);
  const ch = Math.cos(heading);
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    // along = (sin h, -cos h), right = (cos h, sin h)
    const u = ring[i] * ch + ring[i + 1] * sh;
    const v = ring[i] * sh - ring[i + 1] * ch;
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  const uc = (u0 + u1) / 2;
  const vc = (v0 + v1) / 2;
  return {
    kind: 'poly',
    x: uc * ch + vc * sh,
    z: uc * sh - vc * ch,
    halfW: (u1 - u0) / 2,
    halfL: (v1 - v0) / 2,
    radius: grow,
    heading,
    blend,
    strength: 1,
    minLevel,
    flatten: true,
    poly: ring,
  };
}

/** Default flatten footprint for a feature. */
export function footprintOf(f: SceneryFeature): Footprint {
  const s = f.size ?? 1;
  const heading = (f.rotation ?? 0) * DEG;
  const base: Footprint = {
    kind: 'circle',
    x: f.x,
    z: f.z,
    halfW: 0,
    halfL: 0,
    radius: 500 * s,
    heading,
    blend: 600,
    strength: 1,
    minLevel: 4,
    flatten: true,
  };
  switch (f.type) {
    case 'airbase': {
      if (f.outline && f.outline.length >= 6) {
        // the real airfield: its runway strips, taxiways and aprons (OpenStreetMap, aucklandOsm.ts)
        const fp = polyFootprint(f.outline, heading, 0, AIRBASE.flatBlend, 5);
        if (f.flatten !== undefined) fp.flatten = f.flatten;
        return fp;
      }
      // Runway frame: along = (sin h, -cos h), right = (cos h, sin h).
      const cu = AIRBASE.flatCenterU;
      base.kind = 'rect';
      base.x = f.x + Math.cos(heading) * cu;
      base.z = f.z + Math.sin(heading) * cu;
      base.halfW = AIRBASE.flatHalfW;
      base.halfL = AIRBASE.flatHalfL + (runwayLengthFor(f) - AIRBASE.runwayLength) / 2;
      base.radius = Math.hypot(base.halfW, base.halfL);
      base.blend = AIRBASE.flatBlend;
      base.minLevel = 5;
      break;
    }
    case 'city':
      base.radius = 1500 * s;
      base.blend = 1300;
      base.strength = 0.95;
      break;
    case 'town':
      base.radius = 650 * s;
      base.blend = 750;
      base.strength = 0.95;
      break;
    case 'industrial':
      base.radius = 560 * s;
      base.blend = 650;
      break;
    case 'port':
      base.radius = 620 * s;
      base.blend = 450;
      base.minLevel = 2.5;
      break;
    case 'village':
      base.radius = 300 * s;
      base.blend = 380;
      base.strength = 0.8;
      break;
    case 'forest':
      base.radius = 1500 * s;
      base.flatten = false;
      break;
    case 'farmland':
      base.radius = 2600 * s;
      base.flatten = false;
      base.strength = 0.35;
      break;
  }
  if (f.flatten !== undefined) base.flatten = f.flatten;
  return base;
}

/**
 * Flatten weight (0..1) of a footprint at world (x, z): 1 inside the core, smooth falloff
 * over `blend`, 0 outside.
 */
export function footprintWeight(fp: Footprint, x: number, z: number): number {
  let d: number;
  if (fp.kind === 'rect') {
    const dx = x - fp.x;
    const dz = z - fp.z;
    const sh = Math.sin(fp.heading);
    const ch = Math.cos(fp.heading);
    // along = (sin h, -cos h), right = (cos h, sin h)
    const v = dx * sh - dz * ch;
    const u = dx * ch + dz * sh;
    const qu = Math.abs(u) - fp.halfW;
    const qv = Math.abs(v) - fp.halfL;
    const ou = Math.max(qu, 0);
    const ov = Math.max(qv, 0);
    d = Math.sqrt(ou * ou + ov * ov) + Math.min(Math.max(qu, qv), 0);
  } else if (fp.kind === 'poly' && fp.poly) {
    // cheap reject outside the grown bounding box
    const dx = x - fp.x;
    const dz = z - fp.z;
    const sh = Math.sin(fp.heading);
    const ch = Math.cos(fp.heading);
    const out = Math.max(Math.abs(dx * ch + dz * sh) - fp.halfW, Math.abs(dx * sh - dz * ch) - fp.halfL);
    if (out >= fp.radius + fp.blend) return 0;
    const e = ringDistance(fp.poly, x, z);
    d = (e.inside ? -e.dist : e.dist) - fp.radius;
  } else {
    d = Math.hypot(x - fp.x, z - fp.z) - fp.radius;
  }
  if (d <= 0) return fp.strength;
  if (d >= fp.blend) return 0;
  const t = 1 - d / fp.blend;
  return fp.strength * t * t * (3 - 2 * t);
}

/** Bounding radius of a footprint's core (from its centre), without the blend. */
export function footprintCoreRadius(fp: Footprint): number {
  if (fp.kind === 'rect') return Math.hypot(fp.halfW, fp.halfL);
  if (fp.kind === 'poly') return Math.hypot(fp.halfW, fp.halfL) + fp.radius;
  return fp.radius;
}

/** Conservative bounding radius of a footprint including its blend. */
export function footprintReach(fp: Footprint): number {
  return footprintCoreRadius(fp) + fp.blend;
}

const ringScratch = { inside: false, dist: 0 };

/** Even–odd inside test and distance (m) to the nearest edge of a flat XZ ring (shared result object). */
export function ringDistance(ring: ArrayLike<number>, x: number, z: number): { inside: boolean; dist: number } {
  let inside = false;
  let best = Infinity;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const zi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const zj = ring[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    const dx = xi - xj;
    const dz = zi - zj;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - xj) * dx + (z - zj) * dz) / l2)) : 0;
    const ex = x - xj - dx * t;
    const ez = z - zj - dz * t;
    const d2 = ex * ex + ez * ez;
    if (d2 < best) best = d2;
  }
  ringScratch.inside = inside;
  ringScratch.dist = Math.sqrt(best);
  return ringScratch;
}
