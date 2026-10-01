/**
 * Aircraft prototype registry: builds each type once (lazily) and caches it.
 * Instances clone the prototype groups (geometry + materials are shared).
 */
import type { AircraftType } from '../../../core/types';
import type { AircraftPrototype } from './types';
import { buildF35 } from './f35a';
import { buildMig29 } from './mig29';
import { buildFlanker } from './flanker';
import { buildSu57 } from './su57';
import { buildTu22m } from './tu22m';
import { buildA50 } from './a50';
import { buildA320 } from './a320';

const cache = new Map<AircraftType, AircraftPrototype>();

const BUILDERS: Record<AircraftType, () => AircraftPrototype> = {
  f35a: buildF35,
  mig29: buildMig29,
  su27: () => buildFlanker('su27'),
  su35: () => buildFlanker('su35'),
  su57: buildSu57,
  tu22m: buildTu22m,
  a50: buildA50,
  a320: buildA320,
};

export function getAircraftPrototype(type: AircraftType): AircraftPrototype {
  let p = cache.get(type);
  if (!p) {
    const build = BUILDERS[type] ?? buildF35;
    p = build();
    cache.set(type, p);
  }
  return p;
}

export function disposeAircraftPrototypes(): void {
  for (const p of cache.values()) {
    for (const g of [p.lod0, p.lod1]) {
      g.traverse((o) => {
        const m = o as { geometry?: { dispose(): void } };
        m.geometry?.dispose();
      });
    }
  }
}

export type { AircraftPrototype } from './types';
