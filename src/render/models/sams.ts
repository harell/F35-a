/**
 * SAM site prototypes: SA-6 (Straight Flush + 3 TELs), SA-8 (TELAR), SA-10 (Flap Lid + Clam Shell mast
 * + 4 vertical-launch TELs), SA-15 (Tor), SA-18 (MANPADS team + jeep), ZSU-23-4 (Shilka), and the
 * IRGC Navy air-defence fast boat (a moving SAM: hull from models/boats.ts, radar, SAM turret).
 *
 * Every animated node is a DIRECT child of the site root (so yaw angles are site-relative):
 *  - 'yaw:i'   launcher turret, rotates with launcherAzimuth; its children 'pitch:i:j' elevate
 *  - 'radar:i' rotating search antenna (radarAzimuth) or tracking antenna facing the launcher azimuth
 * Ready missiles are drawn by the SamVisual with one InstancedMesh from the listed slot matrices.
 */
import { Group, Matrix4, Object3D, Quaternion, Vector3, type BufferGeometry } from 'three';
import type { MunitionId, SamType } from '../../core/types';
import { box, cylinder, merge, place } from './geom/core';
import { prismX } from './geom/loft';
import { PALETTES, dish, mast, meshFrom, nodeFrom, panel, soldier, trackedChassis, wheeledChassis, type Palette, type PaletteId } from './vehicles';
import { adBoat } from './boats';

export interface PitchDef {
  name: string;
  /** Missile slot transforms in the pitch node's local frame (missile nose = -Z). */
  slots: Matrix4[];
}

export interface SamPrototype {
  type: SamType;
  root: Group;
  launchers: { yaw: string; pitches: PitchDef[] }[];
  radars: { name: string; mode: 'search' | 'track' }[];
  /** What to draw for ready rounds: a munition model, white tube caps, or nothing (guns/internal). */
  ready: { kind: 'missile'; munition: MunitionId } | { kind: 'cap' } | { kind: 'none' };
  radius: number;
}

const cache = new Map<string, SamPrototype>();

const slot = (x: number, y: number, z: number, pitch = 0, yaw = 0) =>
  new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), pitch).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw)), new Vector3(1, 1, 1));

/** Place geometry for a vehicle positioned at (x,z) with heading (rad, clockwise from -Z). */
function atVehicle(geos: BufferGeometry[], x: number, z: number, heading: number): BufferGeometry[] {
  return geos.map((g) => place(g, [x, 0, z], [0, -heading, 0]));
}

function build(type: SamType, pal: Palette): SamPrototype {
  const root = new Group();
  root.name = `sam:${type}`;
  const statics: BufferGeometry[] = [];
  const launchers: SamPrototype['launchers'] = [];
  const radars: SamPrototype['radars'] = [];
  let ready: SamPrototype['ready'] = { kind: 'none' };
  let radius = 45;

  const addTurret = (i: number, x: number, y: number, z: number, geos: BufferGeometry[]): Object3D => {
    const n = nodeFrom(`yaw:${i}`, geos, [x, y, z]);
    root.add(n);
    return n;
  };

  switch (type) {
    case 'sa6': {
      // 1S91 Straight Flush at the centre
      statics.push(...trackedChassis(7.4, 3.1, 1.2, pal));
      const radar = new Object3D();
      radar.name = 'radar:0';
      radar.position.set(0, 1.65, 1.2);
      radar.add(
        meshFrom([
          cylinder(0.9, 1.0, 0.5, 10, pal.dark),
          ...dish(1.6, 0.45, pal.body).map((g) => place(g, [0, 2.0, -0.2], [-0.25, 0, 0])),
          ...dish(1.0, 0.3, pal.body).map((g) => place(g, [0, 0.8, -0.3], [-0.1, 0, 0])),
          place(box(0.3, 1.8, 0.3, pal.dark), [0, 1.0, 0.3]),
        ]),
      );
      root.add(radar);
      radars.push({ name: 'radar:0', mode: 'search' });
      // three 2P25 TELs, facing outward
      const tels: [number, number, number][] = [
        [0, -34, 0],
        [30, 17, (120 * Math.PI) / 180],
        [-30, 17, (-120 * Math.PI) / 180],
      ];
      tels.forEach(([x, z, h], i) => {
        statics.push(...atVehicle(trackedChassis(7.2, 3.1, 1.05, pal), x, z, h));
        const t = addTurret(i, x + Math.sin(h) * -0.6, 1.5, z - Math.cos(h) * -0.6, [cylinder(1.2, 1.3, 0.35, 10, pal.dark), place(box(2.4, 0.9, 0.5, pal.body), [0, 0.5, 0.9])]);
        const p = nodeFrom(`pitch:${i}:0`, [place(box(2.3, 0.2, 3.2, pal.dark), [0, 0.1, -0.6])], [0, 0.95, 0.9]);
        t.add(p);
        launchers.push({ yaw: `yaw:${i}`, pitches: [{ name: `pitch:${i}:0`, slots: [-0.75, 0, 0.75].map((sx) => slot(sx, 0.45, -1.5)) }] });
      });
      ready = { kind: 'missile', munition: 'm_3m9' };
      break;
    }
    case 'sa8': {
      // 9A33 TELAR: boat hull on 6 wheels
      statics.push(...wheeledChassis(9.1, 2.8, [-2.6, 0, 2.6], 0.62, pal, 0.1, 0.1));
      statics.push(
        prismX(
          [
            [-4.6, 1.3],
            [-3.6, 0.7],
            [4.5, 0.7],
            [4.5, 2.2],
            [-3.2, 2.2],
          ],
          2.8,
          pal.body,
        ),
      );
      const t = addTurret(0, 0, 2.2, 0.6, [
        place(box(2.1, 1.1, 2.6, pal.body), [0, 0.55, 0]),
        ...dish(0.75, 0.25, pal.body).map((g) => place(g, [0, 0.8, -1.35])),
      ]);
      const pl = nodeFrom('pitch:0:0', [place(box(0.25, 0.7, 2.6, pal.dark), [0, 0.35, -0.3])], [1.25, 0.6, 0.2]);
      const pr = nodeFrom('pitch:0:1', [place(box(0.25, 0.7, 2.6, pal.dark), [0, 0.35, -0.3])], [-1.25, 0.6, 0.2]);
      t.add(pl, pr);
      const tri = (s: number) => [slot(0.2 * s, 0.25, -0.6), slot(0.2 * s, 0.7, -0.6), slot(0.42 * s, 0.47, -0.6)];
      launchers.push({
        yaw: 'yaw:0',
        pitches: [
          { name: 'pitch:0:0', slots: tri(1) },
          { name: 'pitch:0:1', slots: tri(-1) },
        ],
      });
      const radar = new Object3D();
      radar.name = 'radar:0';
      radar.position.set(0, 4.0, 0.9);
      radar.add(meshFrom([place(box(0.25, 0.9, 0.25, pal.dark), [0, -0.3, 0]), ...panel(2.3, 0.7, 0.18, pal.body).map((g) => place(g, [0, 0.35, 0], [-0.2, 0, 0]))]));
      root.add(radar);
      radars.push({ name: 'radar:0', mode: 'search' });
      ready = { kind: 'missile', munition: 'm_9m33' };
      radius = 20;
      break;
    }
    case 'sa10': {
      // 30N6 Flap Lid truck at the centre (tracking radar faces the launcher azimuth)
      statics.push(...wheeledChassis(12.5, 3.05, [-4.2, -2.6, 2.6, 4.2], 0.78, pal, 3.0, 2.2));
      const fl = new Object3D();
      fl.name = 'radar:0';
      fl.position.set(0, 2.2, 2.5);
      fl.add(meshFrom([cylinder(1.1, 1.2, 0.5, 10, pal.dark), place(box(0.5, 3.4, 0.5, pal.dark), [0, 1.9, 0.6]), ...panel(4.2, 4.0, 0.35, pal.body).map((g) => place(g, [0, 4.6, 0], [-0.35, 0, 0]))]));
      root.add(fl);
      radars.push({ name: 'radar:0', mode: 'track' });
      // 76N6 Clam Shell on its tall mast
      statics.push(...mast(22, 3.2, pal.metal).map((g) => place(g, [-34, 0, 26])));
      const cs = new Object3D();
      cs.name = 'radar:1';
      cs.position.set(-34, 22.3, 26);
      cs.add(meshFrom([cylinder(0.7, 0.8, 0.6, 8, pal.dark), ...panel(6.5, 2.4, 0.4, pal.body).map((g) => place(g, [0, 1.6, -0.3], [-0.15, 0, 0]))]));
      root.add(cs);
      radars.push({ name: 'radar:1', mode: 'search' });
      // four 5P85 TELs with four raised vertical tubes each
      const tels: [number, number, number][] = [
        [38, -30, 0.6],
        [-38, -30, -0.6],
        [44, 22, 2.4],
        [-10, 44, 3.3],
      ];
      const caps: Matrix4[] = [];
      tels.forEach(([x, z, h], i) => {
        const truck = wheeledChassis(12.5, 3.05, [-4.2, -2.6, 2.6, 4.2], 0.78, pal, 3.0, 2.2);
        const tubes: BufferGeometry[] = [place(box(2.9, 0.5, 1.2, pal.dark), [0, 1.9, 4.8])];
        for (const tx of [-1.05, -0.35, 0.35, 1.05]) tubes.push(place(cylinder(0.36, 0.36, 7.6, 8, pal.body), [tx, 5.8, 5.2]));
        statics.push(...atVehicle([...truck, ...tubes], x, z, h));
        for (const tx of [-1.05, -0.35, 0.35, 1.05]) {
          const lx = tx;
          const lz = 5.2;
          const wx = x + lx * Math.cos(-h) + lz * Math.sin(-h);
          const wz = z - lx * Math.sin(-h) + lz * Math.cos(-h);
          caps.push(slot(wx, 9.62, wz));
        }
        void i;
      });
      launchers.push({ yaw: '', pitches: [{ name: '', slots: caps }] });
      ready = { kind: 'cap' };
      radius = 60;
      break;
    }
    case 'sa15': {
      statics.push(...trackedChassis(7.5, 3.3, 1.35, pal));
      const t = addTurret(0, 0, 1.8, 0.4, [
        place(box(3.1, 2.1, 3.3, pal.body), [0, 1.05, 0]),
        ...panel(1.7, 1.35, 0.25, pal.dark).map((g) => place(g, [0, 1.25, -1.72], [0.1, 0, 0])),
        place(box(2.2, 0.12, 1.6, pal.dark), [0, 2.12, 0.6]),
      ]);
      void t;
      const radar = new Object3D();
      radar.name = 'radar:0';
      radar.position.set(0, 4.2, 1.2);
      radar.add(meshFrom([cylinder(0.25, 0.3, 0.5, 8, pal.dark), ...panel(2.6, 0.9, 0.2, pal.body).map((g) => place(g, [0, 0.55, 0], [-0.3, 0, 0]))]));
      root.add(radar);
      radars.push({ name: 'radar:0', mode: 'search' });
      launchers.push({ yaw: 'yaw:0', pitches: [] });
      radius = 18;
      break;
    }
    case 'sa18': {
      // MANPADS team: two riflemen + kneeling gunner, UAZ jeep with spare tubes
      statics.push(...soldier(pal).map((g) => place(g, [3, 0, 2], [0, 0.6, 0])));
      statics.push(...soldier(pal).map((g) => place(g, [-2.5, 0, 3], [0, -0.4, 0])));
      const truck = wheeledChassis(4.0, 1.8, [-1.2, 1.2], 0.42, pal, 1.8, 1.4);
      truck.push(place(box(1.7, 0.4, 1.8, pal.dark), [0, 1.05, 1.0]));
      statics.push(...atVehicle(truck, -4, -5, 0.7));
      const gunner = addTurret(0, 0.5, 0, 0, soldier(pal, true));
      const tube = nodeFrom('pitch:0:0', [place(cylinder(0.055, 0.055, 1.7, 8, pal.dark), [0.22, 0, -0.25], [Math.PI / 2, 0, 0])], [0, 1.15, 0]);
      gunner.add(tube);
      const spares: Matrix4[] = [];
      for (let k = 0; k < 4; k++) {
        const lx = -0.5 + k * 0.33;
        spares.push(new Matrix4().compose(new Vector3(-4 + lx * Math.cos(-0.7) + 1.0 * Math.sin(-0.7), 1.33, -5 - lx * Math.sin(-0.7) + 1.0 * Math.cos(-0.7)), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -0.7), new Vector3(1, 1, 1)));
      }
      launchers.push({ yaw: 'yaw:0', pitches: [{ name: '', slots: spares }] });
      ready = { kind: 'missile', munition: 'm_igla' };
      radius = 12;
      break;
    }
    case 'ad_boat': {
      // IRGC Navy air-defence fast boat: hull + cabin, a rotating search radar on the cabin roof, an
      // aft turret of four SAM canisters and a MANPADS gunner on the foredeck
      statics.push(...adBoat());
      const t = addTurret(0, 0, 1.1, 5.2, [place(cylinder(0.9, 1.0, 0.5, 10, pal.dark), [0, 0.25, 0])]);
      const pod: BufferGeometry[] = [];
      for (const [x, y] of [
        [-0.45, 0.35],
        [0.45, 0.35],
        [-0.45, 0.95],
        [0.45, 0.95],
      ])
        pod.push(place(box(0.5, 0.5, 2.6, 0x7d8589), [x, y, 0]));
      t.add(nodeFrom('pitch:0:0', pod, [0, 0.5, 0]));
      launchers.push({ yaw: 'yaw:0', pitches: [{ name: 'pitch:0:0', slots: [] }] });
      const radar = new Object3D();
      radar.name = 'radar:0';
      radar.position.set(0, 3.8, -2.6);
      radar.add(meshFrom([cylinder(0.15, 0.2, 0.4, 8, pal.dark), ...panel(1.8, 0.5, 0.15, pal.body).map((g) => place(g, [0, 0.4, 0], [-0.2, 0, 0]))]));
      root.add(radar);
      radars.push({ name: 'radar:0', mode: 'search' });
      statics.push(...soldier(pal, true).map((g) => place(g, [0.6, 1.1, -7.2])));
      radius = 11;
      break;
    }
    case 'zsu23': {
      statics.push(...trackedChassis(6.5, 3.1, 1.05, pal));
      const t = addTurret(0, 0, 1.5, 0.2, [place(box(2.9, 1.0, 3.4, pal.body), [0, 0.5, 0]), place(box(2.4, 0.3, 1.2, pal.dark), [0, 1.1, 0.8])]);
      const guns: BufferGeometry[] = [];
      for (const [gx, gy] of [
        [-0.3, 0.12],
        [0.3, 0.12],
        [-0.3, -0.12],
        [0.3, -0.12],
      ])
        guns.push(place(cylinder(0.045, 0.06, 2.6, 6, 0x2a2b2a), [gx, gy, -1.3], [Math.PI / 2, 0, 0]));
      guns.push(place(box(0.9, 0.45, 0.8, pal.dark), [0, 0, 0]));
      const g = nodeFrom('pitch:0:0', guns, [0, 0.7, -1.6]);
      t.add(g);
      launchers.push({ yaw: 'yaw:0', pitches: [{ name: 'pitch:0:0', slots: [] }] });
      const radar = new Object3D();
      radar.name = 'radar:0';
      radar.position.set(0, 3.0, 1.5);
      radar.add(meshFrom([place(box(0.2, 0.6, 0.2, pal.dark), [0, -0.3, 0]), ...dish(0.7, 0.2, pal.body)]));
      root.add(radar);
      radars.push({ name: 'radar:0', mode: 'search' });
      radius = 12;
      break;
    }
  }
  const body = meshFrom(statics);
  body.name = 'static';
  root.add(body);
  return { type, root, launchers, radars, ready, radius };
}

export function getSamPrototype(type: SamType, palette: PaletteId = 'green'): SamPrototype {
  const key = `${type}:${palette}`;
  let p = cache.get(key);
  if (!p) {
    p = build(type, PALETTES[palette]);
    cache.set(key, p);
  }
  return p;
}

/** Cap geometry for vertical-launch tubes with a ready round. */
let capGeo: BufferGeometry | null = null;
export function tubeCapGeometry(): BufferGeometry {
  if (!capGeo) capGeo = merge([cylinder(0.38, 0.38, 0.14, 8, 0xe8e6de)])!;
  return capGeo;
}

export function disposeSamPrototypes(): void {
  cache.forEach((p) =>
    p.root.traverse((o) => {
      const m = o as { geometry?: { dispose(): void } };
      m.geometry?.dispose();
    }),
  );
}
