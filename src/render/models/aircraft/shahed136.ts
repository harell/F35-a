/**
 * HESA Shahed-136 one-way attack drone: a 2.5 m cropped delta wing blended into a slim fuselage,
 * vertical winglets at the tips and a two-blade pusher propeller behind the piston engine
 * (spinning, driven like the A-50's rotodome). Light grey composite, low poly (a few hundred
 * triangles: a swarm of ten costs little).
 */
import { Vector3 } from 'three';
import { ModelBuilder } from '../ModelBuilder';
import { box, cylinderZ, merge, mirrorX, place } from '../geom/core';
import { latheZ, liftingSurface, prismX } from '../geom/loft';
import type { AircraftPrototype, DriveDef } from './types';

const BODY = 0xb7bab4;
const DARK = 0x1d1f21;
/** Propeller plane (m aft of the CG). */
const PROP_Z = 1.68;
/** Propeller spin rate (rad/s): slow enough to read as a spinning prop at 60 fps. */
const PROP_RATE = Math.PI * 2 * 9;

export function buildShahed136(): AircraftPrototype {
  const b = new ModelBuilder((m) => (({ skin: 'munition', dark: 'dark' }) as Record<string, string>)[m] ?? m);
  const drives: DriveDef[] = [];

  // fuselage: pointed nose (warhead + seeker), slim body, engine fairing at the back
  b.add(
    latheZ(
      [
        [-1.75, 0.01],
        [-1.6, 0.1],
        [-1.35, 0.18],
        [-1.0, 0.21],
        [0.9, 0.2],
        [1.35, 0.15],
        [1.58, 0.08],
      ],
      10,
      { color: BODY, ySquash: 0.85, capEnd: true },
    ),
    'skin',
  );

  // cropped delta wing, blended into the body
  const wing = liftingSurface(
    [
      { x: 0.12, y: -0.02, zLE: -0.95, zTE: 1.42, t: 0.14 },
      { x: 1.22, y: -0.02, zLE: 0.92, zTE: 1.42, t: 0.04 },
    ],
    { profile: 'biconvex', capTip: true, color: BODY },
  );
  // winglets: vertical fins at the tips, above and below the wing
  const winglet = prismX(
    [
      [0.86, -0.22],
      [1.44, -0.22],
      [1.5, 0.42],
      [1.2, 0.42],
    ],
    0.03,
    BODY,
    1.21,
  );
  for (const g of [wing, winglet]) {
    b.add(g, 'skin');
    b.add(mirrorX(g), 'skin');
  }

  // spinning two-blade pusher propeller + hub (static spinner behind it)
  const prop = merge([
    place(box(0.07, 0.92, 0.025, DARK), [0, 0, PROP_Z], [0, 0, 0]),
    cylinderZ(0.05, 0.05, PROP_Z - 0.04, PROP_Z + 0.04, 8, DARK),
  ])!;
  b.addPart('prop', prop, 'dark', new Vector3(0, 0, PROP_Z), new Vector3(0, 0, 1));
  drives.push({ part: 'prop', kind: 'radome', side: 0, max: PROP_RATE });
  b.add(cylinderZ(0.07, 0.02, PROP_Z + 0.03, PROP_Z + 0.16, 8, DARK), 'dark');

  const built = b.build();
  return { type: 'shahed136', lod0: built.lod0, lod1: built.lod1, drives, slots: [], fixedStores: [], triangles: built.triangles };
}
