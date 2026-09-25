/**
 * Scenery feature footprints: how much ground each feature flattens and keeps dry, plus the
 * shared airbase layout (used by the terrain flattener, the colour baker and the scenery builder,
 * so runways always sit on the flattened strip).
 */
import type { SceneryFeature } from '../../core/contracts';
import type { Anchor, Footprint } from './types';

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
      // Runway frame: along = (sin h, -cos h), right = (cos h, sin h).
      const cu = AIRBASE.flatCenterU;
      base.kind = 'rect';
      base.x = f.x + Math.cos(heading) * cu;
      base.z = f.z + Math.sin(heading) * cu;
      base.halfW = AIRBASE.flatHalfW;
      base.halfL = AIRBASE.flatHalfL;
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

/** Areas that must be dry land for the given features / pads. */
export function anchorsFor(features: SceneryFeature[], pads: { x: number; z: number; radius: number }[]): Anchor[] {
  const out: Anchor[] = [];
  for (const f of features) {
    const fp = footprintOf(f);
    const r = f.type === 'forest' || f.type === 'farmland' ? fp.radius * 0.6 : fp.radius;
    out.push({ x: fp.x, z: fp.z, r: f.type === 'port' ? r * 0.55 : r, port: f.type === 'port' });
  }
  for (const p of pads) out.push({ x: p.x, z: p.z, r: Math.max(80, p.radius) + 120, port: false });
  return out;
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
  } else {
    d = Math.hypot(x - fp.x, z - fp.z) - fp.radius;
  }
  if (d <= 0) return fp.strength;
  if (d >= fp.blend) return 0;
  const t = 1 - d / fp.blend;
  return fp.strength * t * t * (3 - 2 * t);
}

/** Conservative bounding radius of a footprint including its blend. */
export function footprintReach(fp: Footprint): number {
  return (fp.kind === 'rect' ? Math.hypot(fp.halfW, fp.halfL) : fp.radius) + fp.blend;
}
