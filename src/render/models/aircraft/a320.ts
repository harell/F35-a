/**
 * Airbus A320neo airliner (neutral civil traffic around Auckland Airport): round fuselage with a
 * blunt nose, low swept wing with dihedral and sharklets, two big-fan underwing nacelles (LEAP-1A),
 * conventional tail, and retractable landing gear (driven by AircraftEntity.gear).
 * Livery: see registerAirlinerMaterials (white fuselage, black tail and rear sweep, koru fern mark).
 */
import { Vector3 } from 'three';
import { ModelBuilder } from '../ModelBuilder';
import { cylinderX, ellipsoid, merge, mirrorX, place, setColor } from '../geom/core';
import { liftingSurface, prismX } from '../geom/loft';
import type { AtlasBounds } from '../geom/atlas';
import type { AircraftPrototype, DriveDef } from './types';
import { registerAirlinerMaterials } from './liveries';
import { A320_GEAR_HEIGHT } from '../../../sim/civil/route';
import { DEG, allMoving, finTransform, fuselageLoft, linearSections, nozzle, wingSet } from './parts';

/** Nose station (model z of the nose tip). */
export const A320_Z0 = -18.8;

const Z0 = A320_Z0;
const ATLAS: AtlasBounds = { xMax: 18.2, zMin: -19.0, zMax: 19.0, yMin: -4.3, yMax: 8.4 };

export function buildA320(): AircraftPrototype {
  registerAirlinerMaterials('a320.skin', ATLAS, Z0);
  const b = new ModelBuilder(
    (m) => (({ skin: 'a320.skin', dark: 'darkStd', metal: 'metal', tyre: 'dark' }) as Record<string, string>)[m] ?? m,
    ATLAS,
  );
  const drives: DriveDef[] = [];

  // fuselage: [s, halfWidth, top, bottom, yCentre, n]
  b.add(
    fuselageLoft(
      [
        [0, 0.05, 0.05, 0.05, -0.35, 2],
        [0.6, 0.85, 0.75, 0.8, -0.35, 2],
        [2.0, 1.55, 1.45, 1.55, -0.15, 2],
        [4.5, 1.97, 1.95, 2.05, 0, 2],
        [26.5, 1.97, 1.95, 2.05, 0, 2],
        [30.5, 1.6, 1.75, 1.25, 0.35, 2],
        [34.5, 0.95, 1.15, 0.55, 0.85, 2],
        [37.6, 0.25, 0.3, 0.2, 1.25, 2],
      ],
      Z0,
      { count: 26, points: 18, capEnd: true },
    ),
    'skin',
  );
  // wing-to-body fairing (belly)
  b.add(place(setColor(ellipsoid(2.0, 0.75, 5.2, 14, 6), 0xffffff), [0, -1.75, Z0 + 16.6]), 'skin');

  // low swept wing with dihedral; flaps + ailerons (no spoiler animation)
  const sec = linearSections({ x: 1.8, y: -1.15, zLE: Z0 + 12.8, zTE: Z0 + 19.8, t: 0.75 }, { x: 17.3, y: 0.25, zLE: Z0 + 20.6, zTE: Z0 + 22.1, t: 0.16 });
  wingSet(b, drives, {
    sectionAt: sec,
    x0: 1.8,
    x1: 17.3,
    profile: 'biconvex',
    controls: [
      { name: 'flap', kind: 'flaperon', x0: 2.2, x1: 11.5, c: 0.74, max: 0, extra: 30 * DEG },
      { name: 'ail', kind: 'aileron', x0: 12.0, x1: 16.2, c: 0.76, max: 18 * DEG },
    ],
  });
  // sharklets
  const tip = sec(17.3);
  const shark = finTransform(new Vector3(17.25, tip.y, 0), -8 * DEG);
  const sharklet = shark.xf(
    liftingSurface(
      [
        { x: 0, y: 0, zLE: tip.zLE + 0.05, zTE: tip.zTE, t: 0.12 },
        { x: 2.3, y: 0, zLE: tip.zTE - 0.7, zTE: tip.zTE + 0.15, t: 0.05 },
      ],
      { profile: 'biconvex' },
    ),
  );
  // untextured (the side atlas would paint the cabin window row onto them)
  setColor(sharklet, 0xd2d6da);
  b.add(sharklet, 'dark');
  b.add(mirrorX(sharklet), 'dark');

  // two big-fan nacelles on short pylons
  {
    const x = 5.75;
    const s = sec(x);
    const zf = Z0 + 11.2;
    const y = s.y - 1.45;
    const pod = fuselageLoft(
      [
        [0, 1.05, 1.05, 1.05, y, 2, x],
        [0.5, 1.15, 1.15, 1.15, y, 2, x],
        [3.2, 1.08, 1.08, 1.08, y, 2, x],
        [4.4, 0.62, 0.62, 0.62, y, 2, x],
      ],
      zf,
      { count: 6, points: 16 },
    );
    setColor(pod, 0x17191b);
    const fan = place(setColor(ellipsoid(0.95, 0.95, 0.06, 14, 4), 0x2a2c2f), [x, y, zf + 0.12]);
    const spinner = place(setColor(ellipsoid(0.22, 0.22, 0.4, 8, 4), 0x9a9c9e), [x, y, zf + 0.12]);
    const [nzO, nzI] = nozzle(x, y, zf + 4.3, zf + 5.2, 0.6, 0.42, 12);
    const pylon = prismX(
      [
        [zf + 1.0, y + 0.9],
        [zf + 4.6, y + 0.75],
        [s.zTE - 0.6, s.y],
        [s.zLE + 0.2, s.y],
      ],
      0.32,
      0xffffff,
      x - 0.16,
    );
    for (const [g, m] of [
      [pod, 'dark'],
      [fan, 'dark'],
      [spinner, 'metal'],
      [nzO, 'metal'],
      [nzI, 'dark'],
      [pylon, 'skin'],
    ] as const) {
      b.add(g, m);
      b.add(mirrorX(g), m);
    }
  }

  // fin + rudder
  const fin = finTransform(new Vector3(0, 1.55, 0), 0);
  wingSet(b, drives, {
    sectionAt: linearSections({ x: -0.2, y: 0, zLE: Z0 + 28.6, zTE: Z0 + 36.4, t: 0.55 }, { x: 6.3, y: 0, zLE: Z0 + 34.6, zTE: Z0 + 37.4, t: 0.22 }),
    x0: -0.2,
    x1: 6.3,
    mirror: false,
    profile: 'biconvex',
    controls: [{ name: 'rudder', kind: 'rudder', x0: 0.4, x1: 6.0, c: 0.7, max: 20 * DEG }],
    xf: fin.xf,
    xp: fin.xp,
  });
  // tailplane (trimmable stabiliser — animated as all-moving for simplicity)
  const stab = liftingSurface(
    [
      { x: 0.5, y: 0.75, zLE: Z0 + 31.6, zTE: Z0 + 35.9, t: 0.3 },
      { x: 6.2, y: 1.25, zLE: Z0 + 34.9, zTE: Z0 + 36.8, t: 0.1 },
    ],
    { profile: 'biconvex', capRoot: false },
  );
  allMoving(b, drives, 'stab', 'stab', stab, new Vector3(0.5, 0.8, Z0 + 34.2), new Vector3(1, 0, 0), 8 * DEG, 0);

  // landing gear (struts fold forward into the wing / nose bay when gear → 0)
  const gearBottom = -A320_GEAR_HEIGHT;
  const mainR = 0.57;
  const mainZ = Z0 + 20.3;
  for (const side of [1, -1] as const) {
    const x = 3.75 * side;
    const top = new Vector3(x, -1.3, mainZ);
    const wy = gearBottom + mainR;
    const strut = place(setColor(cylinderX(0.13, top.y - wy, 8), 0xb9bcbf), [x, (top.y + wy) / 2, mainZ], [0, 0, Math.PI / 2]);
    const axle = place(setColor(cylinderX(0.08, 1.3, 6), 0x8a8d90), [x, wy, mainZ]);
    const wheels = merge([
      place(setColor(cylinderX(mainR, 0.38, 14), 0x1c1d1e), [x - 0.48, wy, mainZ]),
      place(setColor(cylinderX(mainR, 0.38, 14), 0x1c1d1e), [x + 0.48, wy, mainZ]),
    ])!;
    const name = side > 0 ? 'gearR' : 'gearL';
    b.addPart(name, strut, 'metal', top, new Vector3(1, 0, 0));
    b.addPart(name, axle, 'metal', top, new Vector3(1, 0, 0));
    b.addPart(name, wheels, 'tyre', top, new Vector3(1, 0, 0));
    drives.push({ part: name, kind: 'gear', side, max: 85 * DEG });
  }
  {
    const z = Z0 + 5.0;
    const r = 0.38;
    const top = new Vector3(0, -1.6, z);
    const wy = gearBottom + r;
    const strut = place(setColor(cylinderX(0.1, top.y - wy, 8), 0xb9bcbf), [0, (top.y + wy) / 2, z], [0, 0, Math.PI / 2]);
    const wheels = merge([
      place(setColor(cylinderX(r, 0.26, 12), 0x1c1d1e), [-0.24, wy, z]),
      place(setColor(cylinderX(r, 0.26, 12), 0x1c1d1e), [0.24, wy, z]),
    ])!;
    b.addPart('gearN', strut, 'metal', top, new Vector3(1, 0, 0));
    b.addPart('gearN', wheels, 'tyre', top, new Vector3(1, 0, 0));
    drives.push({ part: 'gearN', kind: 'gear', side: 0, max: 95 * DEG });
  }

  const built = b.build();
  return { type: 'a320', lod0: built.lod0, lod1: built.lod1, drives, slots: [], fixedStores: [], triangles: built.triangles };
}
