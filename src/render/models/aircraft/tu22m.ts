/**
 * Tu-22M3 "Backfire": long fuselage with pointed radome and stepped cockpit, huge side intakes,
 * fixed wing gloves with variable-sweep outer wings (animated with Mach), tall fin with dorsal
 * extension, stabilators at the fin base, twin nozzles and tail gun turret. Light grey scheme.
 */
import { Vector3 } from 'three';
import { ModelBuilder } from '../ModelBuilder';
import { ellipsoid, mirrorX, place } from '../geom/core';
import { liftingSurface, loftRings } from '../geom/loft';
import type { AtlasBounds } from '../geom/atlas';
import type { AircraftPrototype, DriveDef } from './types';
import { registerCamoMaterial } from './liveries';
import { DEG, allMoving, bubbleCanopy, capsuleRing, finTransform, fuselageLoft, linearSections, nozzle, wingSet } from './parts';

const Z0 = -21.2;
const ATLAS: AtlasBounds = { xMax: 17.5, zMin: -21.4, zMax: 21.6, yMin: -2.2, yMax: 10.8 };

export function buildTu22m(): AircraftPrototype {
  registerCamoMaterial('tu22m.skin', ATLAS, {
    base: '#cfd3d4',
    colors: ['#c3c8ca'],
    blobs: 10,
    blobSize: 3,
    belly: '#dfe2e2',
    radome: '#3b4044',
    radomeZ: Z0 + 3.4,
    star: [{ z: Z0 + 37.2, y: 5.2, r: 0.95 }],
    number: { text: '42', z: Z0 + 6.2, y: 0.1, h: 0.75, color: '#b8231d' },
  });
  const b = new ModelBuilder(
    (m) => (({ skin: 'tu22m.skin', glass: 'glass.clear', dark: 'darkStd', metal: 'metal' }) as Record<string, string>)[m] ?? m,
    ATLAS,
  );
  const drives: DriveDef[] = [];

  b.add(
    fuselageLoft(
      [
        [0, 0.02, 0.02, 0.02, -0.25, 2],
        [2.0, 0.72, 0.68, 0.72, -0.1, 2],
        [5.0, 1.25, 1.2, 1.2, 0.05, 2],
        [8.0, 1.45, 1.55, 1.3, 0.15, 2.1],
        [14.0, 1.5, 1.55, 1.35, 0.1, 2.2],
        [24.0, 1.6, 1.5, 1.42, 0.1, 2.4],
        [34.0, 1.55, 1.4, 1.25, 0.2, 2.4],
        [39.5, 1.35, 1.2, 1.0, 0.3, 2.2],
        [41.0, 1.25, 1.1, 0.9, 0.35, 2.1],
      ],
      Z0,
      { count: 26, points: 16, capEnd: true },
    ),
    'skin',
  );
  const topAt = (s: number, x: number) => {
    const k = Math.min(1, Math.abs(x) / 1.45);
    return 0.15 + 1.5 * Math.sqrt(Math.max(0, 1 - k * k));
  };
  b.add(
    bubbleCanopy(
      [
        [6.0, 0.5, 1.75],
        [7.0, 1.0, 2.15],
        [8.6, 1.12, 2.28],
        [10.0, 0.95, 2.1],
        [11.0, 0.55, 1.8],
      ],
      Z0,
      topAt,
      8,
    ),
    'glass',
  );

  // big side intakes with splitter plates
  const nac = fuselageLoft(
    [
      [12.8, 0.55, 0.95, 0.95, 0.0, 6, 2.15],
      [18.0, 0.62, 1.0, 1.0, 0.05, 4, 2.05],
      [27.0, 0.55, 0.9, 0.9, 0.15, 3, 1.7],
      [33.0, 0.35, 0.7, 0.7, 0.25, 2.5, 1.2],
    ],
    Z0,
    { count: 10, points: 12, capEnd: true },
  );
  const duct = loftRings(
    [
      { z: Z0 + 12.82, ring: capsuleRing(0.48, 0.88, 0.88, 6, 12, 0.0).map((v, i) => (i % 2 === 0 ? v + 2.15 : v)) },
      { z: Z0 + 14.5, ring: capsuleRing(0.4, 0.78, 0.78, 5, 12, 0.02).map((v, i) => (i % 2 === 0 ? v + 2.1 : v)) },
    ],
    { inward: true, capEnd: true, color: 0x1a1b1c },
  );
  const [nzO, nzI] = nozzle(0.95, 0.35, Z0 + 40.6, Z0 + 41.5, 0.78, 0.72, 16);
  for (const [g, m] of [
    [nac, 'skin'],
    [duct, 'dark'],
    [nzO, 'metal'],
    [nzI, 'dark'],
  ] as const) {
    b.add(g, m);
    b.add(mirrorX(g), m);
  }

  // fixed wing gloves
  const glove = liftingSurface(
    [
      { x: 1.2, y: 0.6, zLE: Z0 + 14.5, zTE: Z0 + 28.5, t: 0.7 },
      { x: 4.6, y: 0.6, zLE: Z0 + 20.2, zTE: Z0 + 27.2, t: 0.45 },
    ],
    { profile: 'biconvex', capRoot: false },
  );
  b.add(glove, 'skin');
  b.add(mirrorX(glove), 'skin');

  // variable-sweep outer wings (spread 20° as modelled; swept back with Mach)
  const pivot = new Vector3(4.2, 0.6, Z0 + 22.6);
  const outer = liftingSurface(
    [
      { x: 4.3, y: 0.6, zLE: Z0 + 21.0, zTE: Z0 + 26.0, t: 0.45 },
      { x: 16.9, y: 0.35, zLE: Z0 + 25.6, zTE: Z0 + 27.5, t: 0.14 },
    ],
    { profile: 'biconvex' },
  );
  b.addPart('wingR', outer, 'skin', pivot, new Vector3(0, 1, 0));
  b.addPart('wingL', mirrorX(outer), 'skin', pivot.clone().setX(-pivot.x), new Vector3(0, 1, 0));
  drives.push({ part: 'wingR', kind: 'sweep', side: 1, max: 42 * DEG }, { part: 'wingL', kind: 'sweep', side: -1, max: 42 * DEG });

  // fin (with dorsal fillet) + rudder
  const fin = finTransform(new Vector3(0, 1.2, 0), 0);
  wingSet(b, drives, {
    sectionAt: linearSections({ x: -0.3, y: 0, zLE: Z0 + 26.0, zTE: Z0 + 40.6, t: 0.5 }, { x: 8.9, y: 0, zLE: Z0 + 37.3, zTE: Z0 + 41.3, t: 0.14 }),
    x0: -0.3,
    x1: 8.9,
    mirror: false,
    controls: [{ name: 'rudder', kind: 'rudder', x0: 2.0, x1: 8.4, c: 0.78, max: 20 * DEG }],
    xf: fin.xf,
    xp: fin.xp,
  });
  // stabilators at the fin base
  const stab = liftingSurface(
    [
      { x: 1.2, y: 1.0, zLE: Z0 + 33.6, zTE: Z0 + 40.6, t: 0.3 },
      { x: 7.4, y: 0.95, zLE: Z0 + 38.4, zTE: Z0 + 41.3, t: 0.1 },
    ],
    { profile: 'biconvex', capRoot: false },
  );
  allMoving(b, drives, 'stab', 'stab', stab, new Vector3(1.3, 1.0, Z0 + 37.5), new Vector3(1, 0, 0), 15 * DEG, 5 * DEG);
  // tail gun turret
  b.add(place(ellipsoid(0.5, 0.55, 0.9, 10, 6), [0, -0.2, Z0 + 41.6]), 'skin');

  const built = b.build();
  return { type: 'tu22m', lod0: built.lod0, lod1: built.lod1, drives, slots: [], fixedStores: [], triangles: built.triangles };
}
