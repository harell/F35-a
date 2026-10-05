/**
 * SAM site prototypes: SA-6 (Straight Flush + 3 TELs), SA-15 (Tor), ZSU-23-4 (Shilka), and the
 * Rat navy air-defence fast boat (a moving SAM: hull from models/boats.ts, radar, SAM turret).
 *
 * Every animated node is a DIRECT child of the site root (so yaw angles are site-relative):
 *  - 'yaw:i'   launcher turret, rotates with launcherAzimuth; its children 'pitch:i:j' elevate
 *  - 'radar:i' rotating search antenna (radarAzimuth) or tracking antenna facing the launcher azimuth
 * Ready missiles are drawn by the SamVisual with one InstancedMesh from the listed slot matrices.
 */
import { Group, Matrix4, Object3D, Quaternion, Vector3, type BufferGeometry } from 'three';
import type { MunitionId, SamType } from '../../core/types';
import { box, cylinder, merge, place } from './geom/core';
import { PALETTES, dish, meshFrom, nodeFrom, panel, soldier, trackedChassis, type Palette, type PaletteId } from './vehicles';
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
    case 'ad_boat': {
      // Rat navy air-defence fast boat: hull + cabin, a rotating search radar on the cabin roof, an
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
