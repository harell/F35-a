/**
 * F35-A — terrain pads: flat circles the WORLD terrain generator levels (and keeps dry) under
 * SAM sites and static ground-target compounds, so launchers, radars and buildings sit on
 * level ground. Ships and moving vehicles never get a pad (a pad at sea would raise an island).
 */
import type { MissionDef } from '../core/contracts';
import type { GroundTargetType, SamType } from '../core/types';
import type { GroundTargetDef, SamSiteDef } from './schema';

export interface Pad {
  x: number;
  z: number;
  radius: number;
}

export const SAM_PAD_RADIUS: Record<SamType, number> = {
  sa6: 130,
  sa15: 60,
  zsu23: 45,
  ad_boat: 0, // a boat: no pad
};

export const GROUND_PAD_RADIUS: Record<GroundTargetType, number> = {
  bunker: 70,
  fuel: 60,
  hangar: 80,
  parked_jet: 35,
  ship: 0,
  suicide_boat: 0,
  missile_boat: 0,
  stoat: 0,
};

/** Pad radius for a SAM site. */
export function samPadRadius(def: SamSiteDef): number {
  return def.pad ?? SAM_PAD_RADIUS[def.type];
}

/** Pad radius for a ground target (0 = no pad: ships, bridges, movers). */
export function groundPadRadius(def: GroundTargetDef): number {
  if (def.type === 'ship' || def.scenery || (def.path && def.path.length > 0)) return 0;
  return def.pad ?? GROUND_PAD_RADIUS[def.type];
}

/** Largest merged pad (m). */
const MAX_MERGED = 420;

/**
 * Merge overlapping pads into bounding circles (fewer, larger flat areas — a compound of
 * hangars and parked jets becomes one levelled apron).
 */
export function mergePads(pads: Pad[]): Pad[] {
  const out: Pad[] = pads.map((p) => ({ ...p }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i];
        const b = out[j];
        const d = Math.hypot(a.x - b.x, a.z - b.z);
        if (d > (a.radius + b.radius) * 0.9) continue;
        // bounding circle of both
        let c: Pad;
        if (d + b.radius <= a.radius) c = a;
        else if (d + a.radius <= b.radius) c = b;
        else {
          const r = (d + a.radius + b.radius) / 2;
          const t = d > 1e-6 ? (r - a.radius) / d : 0;
          c = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, radius: r };
        }
        if (c.radius > MAX_MERGED) continue;
        out[i] = { x: c.x, z: c.z, radius: c.radius };
        out.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }
  return out;
}

/** Flat terrain pads (SAM sites, ground target compounds) the terrain generator must flatten. */
export function terrainPadsFor(def: MissionDef): Pad[] {
  const pads: Pad[] = [];
  for (const s of def.script.sams) {
    const r = samPadRadius(s);
    if (r > 0) pads.push({ x: s.x, z: s.z, radius: r });
  }
  for (const g of def.script.ground) {
    const r = groundPadRadius(g);
    if (r > 0) pads.push({ x: g.x, z: g.z, radius: r });
  }
  return mergePads(pads);
}
