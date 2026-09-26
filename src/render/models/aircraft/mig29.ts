/**
 * MiG-29 "Fulcrum": drooped ogive nose with pitot, bubble canopy + dorsal hump, large curved LERX
 * blended into a flat centre body, two widely spaced engine nacelles with angled rectangular
 * intakes and a tunnel between them, twin slightly canted fins, stabilators on tail booms.
 * Two-tone grey camouflage, red stars. ~3.5k triangles.
 */
import { Vector3 } from 'three';
import { ModelBuilder } from '../ModelBuilder';
import { cylinderZ, merge, mirrorX, place } from '../geom/core';
import { liftingSurface, loftRings, prismX } from '../geom/loft';
import type { AtlasBounds } from '../geom/atlas';
import type { AircraftPrototype, DriveDef } from './types';
import { registerCamoMaterial } from './liveries';
import { DEG, allMoving, bubbleCanopy, capsuleRing, finTransform, flatBody, fuselageLoft, linearSections, nozzle, wingSet } from './parts';

const Z0 = -8.6;
const ATLAS: AtlasBounds = { xMax: 5.9, zMin: -9.9, zMax: 8.5, yMin: -1.3, yMax: 3.1 };

export function buildMig29(): AircraftPrototype {
  registerCamoMaterial('mig29.skin', ATLAS, {
    base: '#b3b9b7',
    colors: ['#8a9692', '#99a29e', '#7f8b88'],
    blobs: 46,
    blobSize: 0.85,
    belly: '#c9cecc',
    radome: '#4f5456',
    radomeZ: Z0 + 2.35,
    star: [{ z: Z0 + 14.1, y: 1.35, r: 0.36 }],
    number: { text: '21', z: Z0 + 3.4, y: -0.12, h: 0.36, color: '#b8231d' },
  });
  const b = new ModelBuilder(
    (m) => (({ skin: 'mig29.skin', glass: 'glass.clear', dark: 'darkStd', metal: 'metal' }) as Record<string, string>)[m] ?? m,
    ATLAS,
  );
  const drives: DriveDef[] = [];

  // forward fuselage + dorsal spine: [s, halfW, top, bottom, yc, n]
  const fus = fuselageLoft(
    [
      [0, 0.02, 0.02, 0.02, -0.14, 2],
      [0.7, 0.21, 0.2, 0.2, -0.11, 2],
      [1.7, 0.37, 0.36, 0.35, -0.06, 2],
      [2.7, 0.47, 0.47, 0.45, -0.01, 2.1],
      [3.8, 0.55, 0.57, 0.5, 0.03, 2.25],
      [5.0, 0.6, 0.66, 0.5, 0.05, 2.4],
      [6.3, 0.6, 0.78, 0.45, 0.06, 2.5],
      [8.0, 0.52, 0.74, 0.32, 0.06, 2.5],
      [11.5, 0.45, 0.58, 0.26, 0.05, 2.3],
      [14.5, 0.36, 0.38, 0.22, 0.02, 2.1],
      [16.2, 0.26, 0.24, 0.18, 0.0, 2],
    ],
    Z0,
    { count: 26, points: 14, capEnd: true },
  );
  b.add(fus, 'skin');
  const topAt = (s: number, x: number) => {
    // approximate fuselage top for the canopy base
    const hw = s < 5 ? 0.55 : 0.6;
    const top = s < 3.8 ? 0.57 : s < 5 ? 0.62 : 0.72;
    const k = Math.min(1, Math.abs(x) / hw);
    return 0.04 + top * Math.sqrt(Math.max(0, 1 - k * k));
  };
  b.add(
    bubbleCanopy(
      [
        [3.0, 0.2, 0.6],
        [3.5, 0.36, 0.92],
        [4.2, 0.43, 1.13],
        [5.0, 0.44, 1.2],
        [5.8, 0.4, 1.14],
        [6.5, 0.3, 0.92],
      ],
      Z0,
      topAt,
    ),
    'glass',
  );
  // canopy frame arch
  b.add(place(loftRings([{ z: 0, ring: capsuleRing(0.45, 0.46, 0.05, 2, 12, 0.72) }, { z: 0.07, ring: capsuleRing(0.45, 0.46, 0.05, 2, 12, 0.72) }], { capStart: true, capEnd: true, color: 0x3a3d3f }), [0, 0, Z0 + 3.7]), 'dark');
  // pitot
  b.add(cylinderZ(0.022, 0.012, Z0 - 1.15, Z0 + 0.05, 6, 0x6a6e70), 'dark');

  // LERX + flat centre body: [s, halfW, yTop, yBot, yEdge]
  b.add(
    flatBody(
      [
        [4.6, 0.5, 0.25, -0.35, 0.02],
        [6.0, 0.95, 0.3, -0.3, 0.05],
        [7.6, 1.5, 0.32, -0.25, 0.06],
        [9.2, 2.0, 0.32, -0.22, 0.05],
        [12.8, 2.05, 0.3, -0.2, 0.04],
        [15.0, 1.85, 0.22, -0.18, 0.02],
        [16.4, 1.45, 0.14, -0.14, 0.0],
      ],
      Z0,
      16,
    ),
    'skin',
  );

  // engine nacelles (right, mirrored) — boxy intakes converging to round nozzles
  const nac = fuselageLoft(
    [
      [6.6, 0.4, 0.42, 0.42, -0.66, 5, 1.05],
      [7.8, 0.44, 0.45, 0.45, -0.6, 4, 1.02],
      [10.5, 0.48, 0.45, 0.45, -0.46, 2.8, 0.95],
      [14.0, 0.47, 0.45, 0.45, -0.28, 2.2, 0.85],
      [15.9, 0.45, 0.43, 0.43, -0.14, 2, 0.78],
    ],
    Z0,
    { count: 12, points: 14 },
  );
  // intake mouth: slanted dark duct
  const duct = loftRings(
    [
      { z: Z0 + 6.62, ring: capsuleRing(0.36, 0.38, 0.38, 5, 14, -0.66).map((v, i) => (i % 2 === 0 ? v + 1.05 : v)) },
      { z: Z0 + 7.8, ring: capsuleRing(0.3, 0.32, 0.32, 4, 14, -0.62).map((v, i) => (i % 2 === 0 ? v + 1.03 : v)) },
    ],
    { inward: true, capEnd: true, color: 0x1a1b1c },
  );
  const [nzO, nzI] = nozzle(0.78, -0.14, Z0 + 15.85, Z0 + 16.55, 0.45, 0.42);
  for (const [g, m] of [
    [nac, 'skin'],
    [duct, 'dark'],
    [nzO, 'metal'],
    [nzI, 'dark'],
  ] as const) {
    b.add(g, m);
    b.add(mirrorX(g), m);
  }
  // intake lip ramp (angled upper lip)
  const ramp = prismX(
    [
      [Z0 + 6.3, -0.24],
      [Z0 + 6.62, -0.26],
      [Z0 + 6.62, -0.2],
    ],
    0.8,
    0xffffff,
    0.65,
  );
  b.add(ramp, 'skin');
  b.add(mirrorX(ramp), 'skin');

  // wings
  wingSet(b, drives, {
    sectionAt: linearSections(
      { x: 1.8, y: -0.02, zLE: Z0 + 8.8, zTE: Z0 + 12.7, t: 0.22 },
      { x: 5.68, y: -0.16, zLE: Z0 + 12.3, zTE: Z0 + 13.55, t: 0.05 },
    ),
    x0: 1.8,
    x1: 5.68,
    controls: [
      { name: 'flap', kind: 'flaperon', x0: 2.0, x1: 3.75, c: 0.72, max: 0, extra: 25 * DEG },
      { name: 'ail', kind: 'aileron', x0: 3.85, x1: 5.5, c: 0.75, max: 20 * DEG },
      { name: 'lef', kind: 'lef', x0: 2.4, x1: 5.6, c: 0.13, max: 20 * DEG, le: true },
    ],
  });

  // twin fins, canted 6° outward, with rudders
  const fin = finTransform(new Vector3(1.5, 0.12, 0), 6 * DEG);
  wingSet(b, drives, {
    sectionAt: linearSections({ x: -0.25, y: 0, zLE: Z0 + 11.2, zTE: Z0 + 14.75, t: 0.14 }, { x: 2.45, y: 0, zLE: Z0 + 14.1, zTE: Z0 + 15.15, t: 0.04 }),
    x0: -0.25,
    x1: 2.45,
    controls: [{ name: 'rudder', kind: 'rudder', x0: 0.3, x1: 2.15, c: 0.74, max: 25 * DEG }],
    xf: fin.xf,
    xp: fin.xp,
  });

  // tail booms + all-moving stabilators
  const boom = fuselageLoft(
    [
      [11.5, 0.12, 0.1, 0.1, -0.12, 2, 1.72],
      [13.2, 0.2, 0.18, 0.18, -0.14, 2, 1.72],
      [16.2, 0.2, 0.18, 0.18, -0.16, 2, 1.72],
      [16.9, 0.06, 0.06, 0.06, -0.16, 2, 1.72],
    ],
    Z0,
    { count: 6, points: 8, capEnd: true },
  );
  b.add(boom, 'skin');
  b.add(mirrorX(boom), 'skin');
  const stab = liftingSurface(
    [
      { x: 1.7, y: -0.18, zLE: Z0 + 13.7, zTE: Z0 + 16.35, t: 0.12 },
      { x: 3.95, y: -0.2, zLE: Z0 + 15.9, zTE: Z0 + 16.7, t: 0.04 },
    ],
    { profile: 'biconvex', capRoot: false },
  );
  allMoving(b, drives, 'stab', 'stab', stab, new Vector3(1.8, -0.18, Z0 + 15.2), new Vector3(1, 0, 0), 20 * DEG, 6 * DEG);

  // pylons (static) for 2× R-27 + 4× R-73
  const pylons: [number, number][] = [
    [2.6, 0.45],
    [3.45, 0.5],
    [4.3, 0.5],
  ];
  const pyl = merge(
    pylons.map(([x]) => {
      const t = (x - 1.8) / 3.88;
      const zc = Z0 + 8.8 + t * 3.5 + (3.9 - t * 2.65) * 0.35;
      return prismX(
        [
          [zc - 0.5, -0.06 - t * 0.14],
          [zc - 0.3, -0.3 - t * 0.14],
          [zc + 0.5, -0.3 - t * 0.14],
          [zc + 0.6, -0.06 - t * 0.14],
        ],
        0.08,
        0xffffff,
        x - 0.04,
      );
    }),
  )!;
  b.add(pyl, 'skin');
  b.add(mirrorX(pyl), 'skin');
  const built = b.build();
  const storeAt = (x: number) => {
    const t = (x - 1.8) / 3.88;
    const zc = Z0 + 8.8 + t * 3.5 + (3.9 - t * 2.65) * 0.35 + 0.25;
    return [x, -0.32 - t * 0.14, zc] as [number, number, number];
  };
  const fixed: AircraftPrototype['fixedStores'] = [];
  for (const side of [1, -1]) {
    const [x0, y0, z0] = storeAt(2.6);
    fixed.push({ munition: 'r27', pos: [x0 * side, y0, z0 + 0.2] });
  }
  for (const x of [3.45, 4.3])
    for (const side of [1, -1]) {
      const [x0, y0, z0] = storeAt(x);
      fixed.push({ munition: 'r73', pos: [x0 * side, y0, z0] });
    }
  return { type: 'mig29', lod0: built.lod0, lod1: built.lod1, drives, slots: [], fixedStores: fixed, triangles: built.triangles };
}
