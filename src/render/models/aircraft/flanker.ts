/**
 * Su-27 "Flanker" / Su-35 "Flanker-E": long drooped nose, big bubble canopy and raised spine, ogival
 * LERX blending into the wings, widely spaced nacelles with large intakes, twin vertical fins on
 * booms with ventral fins, tail "stinger", wingtip launch rails. Su-27: dorsal airbrake, light radome,
 * three-tone blue camo. Su-35: no dorsal airbrake, bigger stinger, TVC nozzles, darker two-tone grey.
 */
import { Vector3 } from 'three';
import { ModelBuilder } from '../ModelBuilder';
import { box, cylinderZ, merge, mirrorX, place } from '../geom/core';
import { liftingSurface, loftRings, prismX } from '../geom/loft';
import type { AtlasBounds } from '../geom/atlas';
import type { AircraftPrototype, DriveDef } from './types';
import { registerCamoMaterial } from './liveries';
import { DEG, allMoving, bubbleCanopy, capsuleRing, finTransform, flatBody, fuselageLoft, linearSections, nozzle, wingSet } from './parts';

const Z0 = -11.0;
const ATLAS: AtlasBounds = { xMax: 7.6, zMin: -11.2, zMax: 11.4, yMin: -1.6, yMax: 4.0 };

export function buildFlanker(variant: 'su27' | 'su35'): AircraftPrototype {
  const su35 = variant === 'su35';
  const key = `${variant}.skin`;
  registerCamoMaterial(
    key,
    ATLAS,
    su35
      ? {
          base: '#7f8d99',
          colors: ['#5e6c79', '#6c7a87'],
          blobs: 40,
          blobSize: 1.4,
          belly: '#a7b2bb',
          radome: '#3d4246',
          radomeZ: Z0 + 2.9,
          star: [{ z: Z0 + 18.2, y: 2.3, r: 0.42 }],
          number: { text: '05', z: Z0 + 4.2, y: -0.1, h: 0.42, color: '#c42a22' },
          splinter: true,
        }
      : {
          base: '#b3c4d0',
          colors: ['#8ca3b6', '#6f889d', '#98afc0'],
          blobs: 60,
          blobSize: 1.2,
          belly: '#cfdae1',
          radome: '#e1e4df',
          radomeZ: Z0 + 2.9,
          star: [{ z: Z0 + 18.2, y: 2.3, r: 0.42 }],
          number: { text: '36', z: Z0 + 4.2, y: -0.1, h: 0.42, color: '#2f55a8' },
        },
  );
  const b = new ModelBuilder(
    (m) => (({ skin: key, glass: 'glass.clear', dark: 'darkStd', metal: 'metal' }) as Record<string, string>)[m] ?? m,
    ATLAS,
  );
  const drives: DriveDef[] = [];

  // forward fuselage + raised spine: [s, halfW, top, bottom, yc, n]
  b.add(
    fuselageLoft(
      [
        [0, 0.02, 0.02, 0.02, -0.25, 2],
        [0.9, 0.26, 0.25, 0.25, -0.2, 2],
        [2.2, 0.46, 0.44, 0.45, -0.1, 2],
        [3.6, 0.6, 0.6, 0.58, -0.02, 2.1],
        [5.2, 0.68, 0.72, 0.62, 0.03, 2.3],
        [6.8, 0.72, 0.86, 0.6, 0.05, 2.4],
        [8.6, 0.68, 1.0, 0.5, 0.05, 2.5],
        [11.5, 0.6, 0.86, 0.36, 0.05, 2.4],
        [15.0, 0.52, 0.6, 0.3, 0.02, 2.2],
        [17.5, 0.42, 0.36, 0.28, 0.0, 2.1],
      ],
      Z0,
      { count: 28, points: 14, capEnd: true },
    ),
    'skin',
  );
  const topAt = (s: number, x: number) => {
    const hw = s < 5 ? 0.62 : 0.7;
    const top = s < 5 ? 0.7 : 0.82;
    const k = Math.min(1, Math.abs(x) / hw);
    return 0.03 + top * Math.sqrt(Math.max(0, 1 - k * k));
  };
  b.add(
    bubbleCanopy(
      [
        [4.0, 0.22, 0.72],
        [4.6, 0.42, 1.1],
        [5.5, 0.5, 1.4],
        [6.6, 0.52, 1.5],
        [7.6, 0.47, 1.42],
        [8.4, 0.36, 1.12],
      ],
      Z0,
      topAt,
    ),
    'glass',
  );
  b.add(
    place(
      loftRings(
        [
          { z: 0, ring: capsuleRing(0.5, 0.52, 0.05, 2, 12, 0.88) },
          { z: 0.08, ring: capsuleRing(0.5, 0.52, 0.05, 2, 12, 0.88) },
        ],
        { capStart: true, capEnd: true, color: 0x3a3d3f },
      ),
      [0, 0, Z0 + 4.75],
    ),
    'dark',
  );
  // IRST ball ahead of the windscreen + pitot
  b.add(place(loftRings([{ z: -0.2, ring: capsuleRing(0.12, 0.14, 0.02, 2, 8, 0.66) }, { z: 0.2, ring: capsuleRing(0.14, 0.16, 0.02, 2, 8, 0.66) }], { capStart: true, capEnd: true, color: 0x2a2d30 }), [0.25, 0, Z0 + 3.6]), 'dark');
  b.add(cylinderZ(0.02, 0.012, Z0 - 0.7, Z0 + 0.1, 6, 0x6a6e70), 'dark');

  // LERX + wide centre body
  b.add(
    flatBody(
      [
        [5.8, 0.6, 0.3, -0.45, -0.02],
        [7.5, 1.1, 0.36, -0.38, 0.02],
        [9.4, 1.75, 0.38, -0.32, 0.04],
        [11.2, 2.35, 0.38, -0.3, 0.04],
        [16.4, 2.45, 0.34, -0.28, 0.03],
        [18.6, 2.3, 0.26, -0.24, 0.02],
        [20.0, 1.7, 0.18, -0.2, 0.0],
      ],
      Z0,
      18,
    ),
    'skin',
  );

  // nacelles (right, mirrored): big rectangular intakes under the LERX → round nozzles
  const nac = fuselageLoft(
    [
      [7.8, 0.5, 0.52, 0.52, -0.95, 5, 1.2],
      [9.2, 0.55, 0.55, 0.55, -0.85, 4, 1.18],
      [12.5, 0.6, 0.55, 0.55, -0.6, 3, 1.1],
      [16.5, 0.58, 0.55, 0.55, -0.35, 2.3, 1.0],
      [19.9, 0.53, 0.5, 0.5, -0.18, 2, 0.95],
    ],
    Z0,
    { count: 12, points: 14 },
  );
  const duct = loftRings(
    [
      { z: Z0 + 7.82, ring: capsuleRing(0.46, 0.48, 0.48, 5, 14, -0.95).map((v, i) => (i % 2 === 0 ? v + 1.2 : v)) },
      { z: Z0 + 9.2, ring: capsuleRing(0.38, 0.4, 0.4, 4, 14, -0.88).map((v, i) => (i % 2 === 0 ? v + 1.18 : v)) },
    ],
    { inward: true, capEnd: true, color: 0x1a1b1c },
  );
  const nzLen = su35 ? 1.2 : 0.8;
  const [nzO, nzI] = nozzle(0.95, -0.18, Z0 + 19.85, Z0 + 19.85 + nzLen, 0.53, su35 ? 0.5 : 0.47, 16);
  const pieces = [
    [nac, 'skin'],
    [duct, 'dark'],
    [nzO, 'metal'],
    [nzI, 'dark'],
  ] as const;
  for (const [g, m] of pieces) {
    b.add(g, m);
    b.add(mirrorX(g), m);
  }
  // intake splitter lip
  const lip = prismX(
    [
      [Z0 + 7.3, -0.4],
      [Z0 + 7.82, -0.43],
      [Z0 + 7.82, -0.36],
    ],
    1.0,
    0xffffff,
    0.7,
  );
  b.add(lip, 'skin');
  b.add(mirrorX(lip), 'skin');

  // tail stinger
  b.add(
    fuselageLoft(
      [
        [17.0, 0.4, 0.3, 0.26, 0.02, 2],
        [20.0, 0.34, 0.26, 0.22, 0.02, 2],
        [su35 ? 22.2 : 21.6, 0.18, 0.12, 0.12, 0.02, 2],
        [su35 ? 22.6 : 22.0, 0.02, 0.02, 0.02, 0.02, 2],
      ],
      Z0,
      { count: 6, points: 10 },
    ),
    'skin',
  );

  // wings with flaperons, ailerons and LE flaps
  const WR = 2.2;
  const WT = 7.35;
  wingSet(b, drives, {
    sectionAt: linearSections({ x: WR, y: -0.02, zLE: Z0 + 11.2, zTE: Z0 + 15.6, t: 0.26 }, { x: WT, y: -0.12, zLE: Z0 + 15.75, zTE: Z0 + 16.95, t: 0.05 }),
    x0: WR,
    x1: WT - 0.12,
    controls: [
      { name: 'flap', kind: 'flaperon', x0: 2.4, x1: 5.2, c: 0.72, max: 12 * DEG, extra: 25 * DEG },
      { name: 'ail', kind: 'aileron', x0: 5.2, x1: 6.9, c: 0.74, max: 20 * DEG },
      { name: 'lef', kind: 'lef', x0: 2.8, x1: 7.1, c: 0.14, max: 25 * DEG, le: true },
    ],
  });
  // wingtip launch rails
  const rail = place(box(0.1, 0.12, 2.6, 0xd0d0d0), [WT - 0.05, -0.1, Z0 + 16.1]);
  b.add(rail, 'skin');
  b.add(mirrorX(rail), 'skin');

  // tail booms, vertical fins (no cant) + rudders, ventral fins
  const boom = fuselageLoft(
    [
      [14.0, 0.14, 0.12, 0.12, -0.1, 2, 2.05],
      [15.6, 0.24, 0.24, 0.22, -0.12, 2, 2.05],
      [20.6, 0.24, 0.22, 0.22, -0.16, 2, 2.05],
      [21.3, 0.05, 0.05, 0.05, -0.16, 2, 2.05],
    ],
    Z0,
    { count: 6, points: 8, capEnd: true },
  );
  b.add(boom, 'skin');
  b.add(mirrorX(boom), 'skin');
  const fin = finTransform(new Vector3(2.05, 0.08, 0), 0);
  wingSet(b, drives, {
    sectionAt: linearSections({ x: -0.2, y: 0, zLE: Z0 + 15.1, zTE: Z0 + 19.1, t: 0.16 }, { x: 3.3, y: 0, zLE: Z0 + 18.0, zTE: Z0 + 19.35, t: 0.04 }),
    x0: -0.2,
    x1: 3.3,
    controls: [{ name: 'rudder', kind: 'rudder', x0: 0.4, x1: 2.9, c: 0.72, max: 25 * DEG }],
    xf: fin.xf,
    xp: fin.xp,
  });
  const ventral = finTransform(new Vector3(2.05, -0.3, 0), Math.PI - 15 * DEG);
  const vGeo = ventral.xf(
    liftingSurface(
      [
        { x: 0, y: 0, zLE: Z0 + 16.2, zTE: Z0 + 18.2, t: 0.08 },
        { x: 0.9, y: 0, zLE: Z0 + 17.1, zTE: Z0 + 18.3, t: 0.03 },
      ],
      { profile: 'biconvex', capRoot: false },
    ),
  );
  b.add(vGeo, 'skin');
  b.add(mirrorX(vGeo), 'skin');
  const stab = liftingSurface(
    [
      { x: 2.0, y: -0.15, zLE: Z0 + 18.3, zTE: Z0 + 21.0, t: 0.14 },
      { x: 4.45, y: -0.18, zLE: Z0 + 20.5, zTE: Z0 + 21.35, t: 0.04 },
    ],
    { profile: 'biconvex', capRoot: false },
  );
  allMoving(b, drives, 'stab', 'stab', stab, new Vector3(2.1, -0.15, Z0 + 19.7), new Vector3(1, 0, 0), 20 * DEG, 8 * DEG);

  // Su-27 dorsal airbrake
  if (!su35) {
    const brake = place(box(0.9, 0.04, 1.7, 0xffffff), [0, 1.0, Z0 + 10.5], [0.06, 0, 0]);
    b.addPart('brake', brake, 'skin', new Vector3(0, 1.02, Z0 + 9.65), new Vector3(1, 0, 0));
    drives.push({ part: 'brake', kind: 'airbrake', side: 0, max: 50 * DEG });
  }

  // under-wing pylons
  const pylonXs = [3.2, 4.3, 5.4];
  const secAt = linearSections({ x: WR, y: -0.02, zLE: Z0 + 11.2, zTE: Z0 + 15.6, t: 0.26 }, { x: WT, y: -0.12, zLE: Z0 + 15.75, zTE: Z0 + 16.95, t: 0.05 });
  const pyl = merge(
    pylonXs.map((x) => {
      const s = secAt(x);
      const zc = s.zLE + (s.zTE - s.zLE) * 0.4;
      return prismX(
        [
          [zc - 0.6, s.y - s.t * 0.3],
          [zc - 0.4, s.y - 0.35],
          [zc + 0.6, s.y - 0.35],
          [zc + 0.7, s.y - s.t * 0.3],
        ],
        0.09,
        0xffffff,
        x - 0.045,
      );
    }),
  )!;
  b.add(pyl, 'skin');
  b.add(mirrorX(pyl), 'skin');
  const built = b.build();

  const fixed: AircraftPrototype['fixedStores'] = [];
  const mid = su35 ? 'r77' : 'r27';
  for (const side of [1, -1]) {
    fixed.push({ munition: 'r73', pos: [(WT - 0.05) * side, -0.16, Z0 + 16.1] });
    pylonXs.forEach((x, i) => {
      const s = secAt(x);
      fixed.push({ munition: i === 2 ? 'r73' : mid, pos: [x * side, s.y - 0.36, s.zLE + (s.zTE - s.zLE) * 0.4 + 0.3] });
    });
  }
  return { type: variant, lod0: built.lod0, lod1: built.lod1, drives, slots: [], fixedStores: fixed, triangles: built.triangles };
}
