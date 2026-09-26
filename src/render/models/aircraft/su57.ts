/**
 * Su-57 "Felon": flat, blended low-observable body with a chined nose, LEVCON root extensions,
 * widely spaced nacelles with trapezoid intakes, all-moving canted fins, pointed all-moving
 * tailerons extending aft of the nozzles, short central stinger. Dark grey splinter camouflage.
 */
import { Vector3 } from 'three';
import { ModelBuilder } from '../ModelBuilder';
import { mirrorX, place } from '../geom/core';
import { liftingSurface, loftRings } from '../geom/loft';
import type { AtlasBounds } from '../geom/atlas';
import type { AircraftPrototype, DriveDef } from './types';
import { registerCamoMaterial } from './liveries';
import { DEG, allMoving, bubbleCanopy, capsuleRing, finTransform, flatBody, fuselageLoft, linearSections, nozzle, wingSet } from './parts';

const Z0 = -10.0;
const ATLAS: AtlasBounds = { xMax: 7.3, zMin: -10.2, zMax: 10.6, yMin: -1.4, yMax: 3.0 };

export function buildSu57(): AircraftPrototype {
  registerCamoMaterial('su57.skin', ATLAS, {
    base: '#5d6671',
    colors: ['#48515c', '#78838f', '#3c444e', '#6a7581'],
    blobs: 70,
    blobSize: 1.1,
    belly: '#7b8691',
    radome: '#3d4248',
    radomeZ: Z0 + 2.2,
    star: [{ z: Z0 + 16.6, y: 1.35, r: 0.32 }],
    number: { text: '52', z: Z0 + 5.6, y: -0.2, h: 0.36, color: '#2b3f7a' },
    splinter: true,
    roughness: 0.55,
    metalness: 0.2,
  });
  const b = new ModelBuilder(
    (m) => (({ skin: 'su57.skin', glass: 'glass.gold', dark: 'darkStd', metal: 'metal' }) as Record<string, string>)[m] ?? m,
    ATLAS,
  );
  b.glassTint = 0x2e2616;
  const drives: DriveDef[] = [];

  // chined, boxy forward fuselage + spine
  b.add(
    fuselageLoft(
      [
        [0, 0.02, 0.02, 0.02, -0.08, 2],
        [1.2, 0.36, 0.24, 0.22, -0.05, 2.8],
        [2.6, 0.6, 0.42, 0.38, 0.0, 3.0],
        [4.2, 0.74, 0.55, 0.46, 0.03, 3.2],
        [6.0, 0.8, 0.64, 0.46, 0.05, 3.2],
        [8.2, 0.74, 0.7, 0.4, 0.05, 3.0],
        [12.0, 0.6, 0.56, 0.28, 0.05, 2.8],
        [16.0, 0.46, 0.4, 0.24, 0.0, 2.6],
        [18.8, 0.3, 0.24, 0.18, 0.0, 2.4],
      ],
      Z0,
      { count: 24, points: 14, capEnd: true },
    ),
    'skin',
  );
  const topAt = (s: number, x: number) => {
    const hw = 0.75;
    const k = Math.min(1, Math.abs(x) / hw);
    return 0.04 + (s < 5 ? 0.56 : 0.66) * Math.pow(Math.max(0, 1 - Math.pow(k, 3.2)), 1 / 3.2);
  };
  b.add(
    bubbleCanopy(
      [
        [3.9, 0.22, 0.62],
        [4.5, 0.42, 0.95],
        [5.4, 0.48, 1.15],
        [6.4, 0.46, 1.19],
        [7.3, 0.36, 1.02],
        [7.9, 0.18, 0.78],
      ],
      Z0,
      topAt,
    ),
    'glass',
  );
  b.add(place(loftRings([{ z: 0, ring: capsuleRing(0.47, 0.48, 0.05, 2, 12, 0.7) }, { z: 0.06, ring: capsuleRing(0.47, 0.48, 0.05, 2, 12, 0.7) }], { capStart: true, capEnd: true, color: 0x33373b }), [0, 0, Z0 + 4.55]), 'dark');

  // blended body with LEVCONs
  b.add(
    flatBody(
      [
        [4.8, 0.7, 0.3, -0.35, 0.0],
        [6.6, 1.35, 0.34, -0.32, 0.02],
        [8.4, 1.95, 0.36, -0.3, 0.03],
        [9.6, 2.45, 0.36, -0.28, 0.02],
        [15.8, 2.5, 0.32, -0.26, 0.02],
        [18.0, 2.25, 0.24, -0.22, 0.0],
        [19.4, 1.4, 0.16, -0.16, 0.0],
      ],
      Z0,
      16,
    ),
    'skin',
  );

  // nacelles with trapezoid intakes, converging to the nozzles
  const nac = fuselageLoft(
    [
      [7.3, 0.46, 0.44, 0.44, -0.68, 6, 1.35],
      [9.0, 0.52, 0.46, 0.46, -0.6, 4, 1.32],
      [13.0, 0.55, 0.46, 0.46, -0.42, 3, 1.26],
      [16.5, 0.55, 0.45, 0.45, -0.22, 2.4, 1.22],
      [18.2, 0.53, 0.44, 0.44, -0.1, 2, 1.2],
    ],
    Z0,
    { count: 12, points: 12 },
  );
  const duct = loftRings(
    [
      { z: Z0 + 7.32, ring: capsuleRing(0.42, 0.4, 0.4, 6, 12, -0.68).map((v, i) => (i % 2 === 0 ? v + 1.35 : v)) },
      { z: Z0 + 8.6, ring: capsuleRing(0.34, 0.33, 0.33, 4, 12, -0.64).map((v, i) => (i % 2 === 0 ? v + 1.33 : v)) },
    ],
    { inward: true, capEnd: true, color: 0x191a1b },
  );
  const [nzO, nzI] = nozzle(1.2, -0.1, Z0 + 18.15, Z0 + 18.85, 0.53, 0.5, 16);
  for (const [g, m] of [
    [nac, 'skin'],
    [duct, 'dark'],
    [nzO, 'metal'],
    [nzI, 'dark'],
  ] as const) {
    b.add(g, m);
    b.add(mirrorX(g), m);
  }
  // central stinger
  b.add(
    fuselageLoft(
      [
        [16.5, 0.45, 0.2, 0.2, 0.0, 3],
        [19.2, 0.3, 0.14, 0.14, 0.0, 2.6],
        [20.1, 0.04, 0.04, 0.04, 0.0, 2],
      ],
      Z0,
      { count: 5, points: 10 },
    ),
    'skin',
  );

  // wings: large LE sweep, flaperons + ailerons + LE flaps
  const WR = 2.4;
  const WT = 7.02;
  wingSet(b, drives, {
    sectionAt: linearSections({ x: WR, y: -0.02, zLE: Z0 + 9.3, zTE: Z0 + 15.4, t: 0.26 }, { x: WT, y: -0.08, zLE: Z0 + 14.45, zTE: Z0 + 15.85, t: 0.05 }),
    x0: WR,
    x1: WT,
    profile: 'diamond',
    controls: [
      { name: 'flap', kind: 'flaperon', x0: 2.6, x1: 5.0, c: 0.78, max: 12 * DEG, extra: 25 * DEG },
      { name: 'ail', kind: 'aileron', x0: 5.0, x1: 6.8, c: 0.78, max: 20 * DEG },
      { name: 'lef', kind: 'lef', x0: 2.9, x1: 6.9, c: 0.13, max: 25 * DEG, le: true },
    ],
  });

  // all-moving canted fins (pivot about their span axis)
  const cant = 26 * DEG;
  const finRoot = new Vector3(1.8, 0.18, 0);
  const ft = finTransform(finRoot, cant);
  const finGeo = ft.xf(
    liftingSurface(
      [
        { x: -0.15, y: 0, zLE: Z0 + 14.9, zTE: Z0 + 17.9, t: 0.12 },
        { x: 2.3, y: 0, zLE: Z0 + 17.2, zTE: Z0 + 18.4, t: 0.04 },
      ],
      { profile: 'diamond', capRoot: false },
    ),
  );
  const finPivot = ft.xp(new Vector3(0, 0, Z0 + 16.6));
  const finAxis = ft.xp(new Vector3(1, 0, Z0 + 16.6)).sub(finPivot);
  allMoving(b, drives, 'fin', 'rudder', finGeo, finPivot, finAxis, 20 * DEG, 18 * DEG);

  // pointed all-moving tailerons
  const stab = liftingSurface(
    [
      { x: 2.0, y: -0.12, zLE: Z0 + 16.0, zTE: Z0 + 19.6, t: 0.12 },
      { x: 4.95, y: -0.14, zLE: Z0 + 18.4, zTE: Z0 + 20.35, t: 0.03 },
    ],
    { profile: 'diamond', capRoot: false },
  );
  allMoving(b, drives, 'stab', 'stab', stab, new Vector3(2.1, -0.12, Z0 + 17.8), new Vector3(1, 0, 0), 20 * DEG, 10 * DEG);

  const built = b.build();
  return { type: 'su57', lod0: built.lod0, lod1: built.lod1, drives, slots: [], fixedStores: [], triangles: built.triangles };
}
