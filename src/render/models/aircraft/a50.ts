/**
 * A-50 "Mainstay" AEW&C (Il-76 airframe): round fuselage with glazed navigator nose, high swept
 * wing with anhedral, four podded engines on pylons, T-tail, and the big rotodome on struts
 * (continuously rotating, ~6 rpm). Grey/white scheme with red stars.
 */
import { Color, Vector3 } from 'three';
import { ModelBuilder } from '../ModelBuilder';
import { box, ellipsoid, merge, mirrorX, place, setColor } from '../geom/core';
import { liftingSurface, prismX } from '../geom/loft';
import type { AtlasBounds } from '../geom/atlas';
import type { AircraftPrototype, DriveDef } from './types';
import { registerCamoMaterial } from './liveries';
import { DEG, allMoving, bubbleCanopy, finTransform, fuselageLoft, linearSections, nozzle, wingSet } from './parts';

const Z0 = -23.3;
const ATLAS: AtlasBounds = { xMax: 25.6, zMin: -23.5, zMax: 24.0, yMin: -3.0, yMax: 12.8 };

export function buildA50(): AircraftPrototype {
  registerCamoMaterial('a50.skin', ATLAS, {
    base: '#d9dcdd',
    colors: ['#cdd1d3'],
    blobs: 8,
    blobSize: 4,
    belly: '#b9bfc3',
    radome: '#4a4f53',
    radomeZ: Z0 + 1.1,
    star: [{ z: Z0 + 42.8, y: 6.2, r: 1.05 }],
    number: { text: '37', z: Z0 + 7.0, y: 0.6, h: 0.9, color: '#b8231d' },
  });
  const b = new ModelBuilder(
    (m) => (({ skin: 'a50.skin', glass: 'glass.clear', dark: 'darkStd', metal: 'metal' }) as Record<string, string>)[m] ?? m,
    ATLAS,
  );
  const drives: DriveDef[] = [];

  b.add(
    fuselageLoft(
      [
        [0, 0.05, 0.05, 0.05, -0.5, 2],
        [1.5, 1.05, 0.95, 1.05, -0.25, 2],
        [4.0, 1.75, 1.7, 1.75, 0.0, 2],
        [7.0, 2.0, 2.0, 2.0, 0.1, 2],
        [30.0, 2.0, 2.0, 2.0, 0.1, 2],
        [38.0, 1.6, 1.8, 1.3, 0.5, 2],
        [44.0, 0.9, 1.2, 0.6, 1.0, 2],
        [46.6, 0.3, 0.45, 0.3, 1.4, 2],
      ],
      Z0,
      { count: 22, points: 16, capEnd: true },
    ),
    'skin',
  );
  // glazed navigator nose + cockpit windows
  b.add(place(ellipsoid(0.95, 0.75, 1.5, 12, 8, 0xffffff), [0, -0.55, Z0 + 2.0]), 'glass');
  const topAt = (_s: number, x: number) => {
    const k = Math.min(1, Math.abs(x) / 1.9);
    return 0.1 + 1.95 * Math.sqrt(Math.max(0, 1 - k * k));
  };
  b.add(
    bubbleCanopy(
      [
        [3.6, 0.6, 1.85],
        [4.4, 1.15, 2.2],
        [5.6, 1.25, 2.3],
        [6.4, 0.8, 2.2],
      ],
      Z0,
      topAt,
      6,
    ),
    'glass',
  );

  // high swept wing with anhedral, flaps + ailerons
  const sec = linearSections({ x: 1.6, y: 1.9, zLE: Z0 + 17.0, zTE: Z0 + 24.6, t: 1.0 }, { x: 25.2, y: 0.9, zLE: Z0 + 28.0, zTE: Z0 + 30.4, t: 0.25 });
  wingSet(b, drives, {
    sectionAt: sec,
    x0: 1.6,
    x1: 25.2,
    controls: [
      { name: 'flap', kind: 'flaperon', x0: 2.5, x1: 15.5, c: 0.75, max: 0, extra: 20 * DEG },
      { name: 'ail', kind: 'aileron', x0: 16.0, x1: 24.0, c: 0.76, max: 15 * DEG },
    ],
  });

  // four engine pods on pylons
  for (const x of [8.6, 15.0]) {
    const s = sec(x);
    const zf = s.zLE - 2.4;
    const y = s.y - 1.75;
    const pod = fuselageLoft(
      [
        [0, 0.85, 0.85, 0.85, y, 2, x],
        [1.2, 0.95, 0.95, 0.95, y, 2, x],
        [4.2, 0.85, 0.85, 0.85, y, 2, x],
        [5.2, 0.62, 0.62, 0.62, y, 2, x],
      ],
      zf,
      { count: 5, points: 12 },
    );
    const inlet = place(setColor(ellipsoid(0.72, 0.72, 0.05, 12, 4), 0x151617), [x, y, zf + 0.06]);
    const [nzO, nzI] = nozzle(x, y, zf + 5.1, zf + 5.7, 0.6, 0.52, 12);
    const pylon = prismX(
      [
        [zf + 1.0, y + 0.8],
        [zf + 4.8, y + 0.8],
        [s.zTE - 0.5, s.y],
        [s.zLE + 0.4, s.y],
      ],
      0.3,
      0xffffff,
      x - 0.15,
    );
    for (const [g, m] of [
      [pod, 'skin'],
      [inlet, 'dark'],
      [nzO, 'metal'],
      [nzI, 'dark'],
      [pylon, 'skin'],
    ] as const) {
      b.add(g, m);
      b.add(mirrorX(g), m);
    }
  }

  // T-tail: fin + rudder, stabilators on top
  const fin = finTransform(new Vector3(0, 1.8, 0), 0);
  wingSet(b, drives, {
    sectionAt: linearSections({ x: -0.3, y: 0, zLE: Z0 + 35.5, zTE: Z0 + 44.6, t: 0.7 }, { x: 7.0, y: 0, zLE: Z0 + 42.6, zTE: Z0 + 46.3, t: 0.3 }),
    x0: -0.3,
    x1: 7.0,
    mirror: false,
    controls: [{ name: 'rudder', kind: 'rudder', x0: 0.8, x1: 6.6, c: 0.72, max: 20 * DEG }],
    xf: fin.xf,
    xp: fin.xp,
  });
  const stab = liftingSurface(
    [
      { x: 0.2, y: 8.7, zLE: Z0 + 42.4, zTE: Z0 + 46.4, t: 0.35 },
      { x: 8.4, y: 8.3, zLE: Z0 + 45.6, zTE: Z0 + 47.0, t: 0.1 },
    ],
    { profile: 'biconvex', capRoot: false },
  );
  allMoving(b, drives, 'stab', 'stab', stab, new Vector3(0.3, 8.6, Z0 + 44.8), new Vector3(1, 0, 0), 12 * DEG, 0);

  // rotodome struts + rotating radome (Shmel)
  const RZ = Z0 + 29.0;
  const strut = merge([
    place(box(0.35, 3.2, 2.2, 0xffffff), [0.9, 3.6, RZ], [0, 0, -0.18]),
    place(box(0.35, 3.2, 2.2, 0xffffff), [-0.9, 3.6, RZ], [0, 0, 0.18]),
  ])!;
  b.add(strut, 'skin');
  const dome = fuselageLoft(
    [
      [-1.05, 0.25, 0.25, 0.25, 0, 2],
      [-0.9, 3.8, 3.8, 3.8, 0, 2],
      [-0.4, 5.3, 5.3, 5.3, 0, 2],
      [0, 5.4, 5.4, 5.4, 0, 2],
      [0.4, 5.3, 5.3, 5.3, 0, 2],
      [0.9, 3.8, 3.8, 3.8, 0, 2],
      [1.05, 0.25, 0.25, 0.25, 0, 2],
    ],
    0,
    { count: 8, points: 24, capStart: true, capEnd: true },
  );
  // lathe was built along Z: rotate so its axis is vertical, then lift above the fuselage
  place(dome, [0, 6.1, RZ], [-Math.PI / 2, 0, 0]);
  // light dome with a dark dielectric band around the rim (vertex colours, 'dark' material)
  const col = dome.attributes.color.array as Float32Array;
  const pos = dome.attributes.position.array as Float32Array;
  const light = new Color(0xcfd4d7);
  const band = new Color(0x3c4146);
  for (let i = 0; i < pos.length / 3; i++) {
    const r = Math.hypot(pos[i * 3], pos[i * 3 + 2] - RZ);
    const c = r > 4.75 ? band : light;
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  b.addPart('radome', dome, 'dark', new Vector3(0, 6.1, RZ), new Vector3(0, 1, 0));
  drives.push({ part: 'radome', kind: 'radome', side: 0, max: (Math.PI * 2) / 10 });

  const built = b.build();
  return { type: 'a50', lod0: built.lod0, lod1: built.lod1, drives, slots: [], fixedStores: [], triangles: built.triangles };
}
