/**
 * HarbourFerries: the visual-only Auckland harbour ferries (issue #30) in one InstancedMesh. Each frame
 * every ferry is placed by its timetable (ferryRoutes.ts, a pure function of mission time), bobs a little,
 * leaves a wake in the shared WakeBatch and, at night, shows its nav and cabin lights through the entity
 * renderer's sprite batch. Not sim entities: not on radar, not targetable (strafing a ferry does nothing).
 */
import { BufferGeometry, Euler, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import { box, boxUV, merge, place } from '../models/geom/core';
import { getMaterial } from '../models/materials';
import type { ShipLight } from '../models/ground';
import type { SpriteBatch } from '../effects/SpriteBatch';
import type { WakeBatch } from '../effects/Wakes';
import { FERRY_BEAM, FERRY_FLEET, FERRY_LENGTH, ferryAt, ferryRoutes, type FerryRoute, type FerryState } from './ferryRoutes';

/** Lights are drawn out to this range (m); cabin windows closer in. */
const LIGHTS_FAR = 12_000;
const CABIN_LIGHTS_FAR = 5_000;

const WHITE = 0xf1f2ee;
const DARK = 0x26323c;
const LIVERY = 0x17708c;

/** A 34 m harbour catamaran, waterline at y = 0, bow at -Z (≈ 130 triangles). */
export function ferryGeometry(): BufferGeometry {
  const L = FERRY_LENGTH;
  const B = FERRY_BEAM;
  const g: BufferGeometry[] = [];
  for (const s of [-1, 1]) {
    g.push(place(box(2.6, 2.6, L - 3, WHITE), [s * (B / 2 - 1.3), 0.5, 1.5]));
    // raked bows
    g.push(place(box(2.4, 2.0, 4, WHITE), [s * (B / 2 - 1.3), 0.9, -L / 2 + 1.2], [-0.35, 0, 0]));
  }
  g.push(place(box(B, 2.7, L - 7, WHITE), [0, 3.15, 2.5])); // main cabin
  g.push(place(box(B + 0.1, 0.45, L - 5, LIVERY), [0, 2.0, 1.5])); // livery band
  g.push(place(box(B + 0.1, 1.0, L - 10, DARK), [0, 3.55, 2.5])); // windows
  g.push(place(box(B - 1.6, 2.3, 15, WHITE), [0, 5.65, 3])); // upper cabin
  g.push(place(box(B - 1.5, 0.8, 13.5, DARK), [0, 5.9, 3]));
  g.push(place(box(6, 1.8, 4.5, WHITE), [0, 7.7, -2.2])); // wheelhouse
  g.push(place(box(6.1, 0.7, 4.6, DARK), [0, 7.9, -2.2]));
  g.push(place(box(0.3, 3, 0.3, 0x9a9c9e), [0, 10.1, -1.2])); // mast
  const geo = merge(g)!;
  boxUV(geo, 0.08);
  geo.computeBoundingSphere();
  return geo;
}

/** Nav lights (lit under way, mast and stern alongside too) and cabin windows (always at night). */
export const FERRY_LIGHTS: readonly ShipLight[] = [
  { pos: new Vector3(0, 11.6, -1.2), color: 0xffffff, kind: 'way', size: 3 },
  { pos: new Vector3(-3.1, 8.2, -4.3), color: 0xff2a1a, kind: 'way', size: 2.6 },
  { pos: new Vector3(3.1, 8.2, -4.3), color: 0x2aff5a, kind: 'way', size: 2.6 },
  { pos: new Vector3(0, 4.7, 16.2), color: 0xffffff, kind: 'stern', size: 2.4 },
  ...[-11, -5, 1, 7, 13].flatMap((z) => [
    { pos: new Vector3(-5.1, 3.6, z), color: 0xffd9a0, kind: 'deck' as const, size: 1.8 },
    { pos: new Vector3(5.1, 3.6, z), color: 0xffd9a0, kind: 'deck' as const, size: 1.8 },
  ]),
];

const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler(0, 0, 0, 'YXZ');
const _p = new Vector3();
const _s = new Vector3();
const _l = new Vector3();

export class HarbourFerries {
  readonly mesh: InstancedMesh;
  private readonly routes: FerryRoute[];
  private readonly fleet: readonly { route: number; k: number }[];
  private readonly st: FerryState[];
  private readonly mats: Matrix4[];

  constructor(count: number) {
    this.routes = ferryRoutes();
    this.fleet = FERRY_FLEET.slice(0, Math.max(0, Math.min(count, FERRY_FLEET.length)));
    this.st = this.fleet.map(() => ({ x: 0, z: 0, heading: 0, speed: 0, dock: -1 }));
    this.mats = this.fleet.map(() => new Matrix4());
    this.mesh = new InstancedMesh(ferryGeometry(), getMaterial('building'), Math.max(1, this.fleet.length));
    this.mesh.count = this.fleet.length;
    this.mesh.name = 'ferries';
    // the instances span the whole harbour; they are few and small, so skip culling
    this.mesh.frustumCulled = false;
  }

  get count(): number {
    return this.fleet.length;
  }

  /** Places every ferry at mission time `time` and adds the wakes of those under way. */
  update(time: number, wakes: WakeBatch | null): void {
    for (let i = 0; i < this.fleet.length; i++) {
      const f = this.fleet[i];
      const r = this.routes[f.route];
      const s = ferryAt(r, f.k, time, this.st[i]);
      const sc = r.def.scale;
      // a gentle bob and roll; squat by the stern at speed
      const ph = i * 1.7;
      _e.set(0.004 * Math.sin(time * 0.9 + ph) + Math.max(0, s.speed) * 0.0012, -s.heading, 0.012 * Math.sin(time * 0.7 + ph * 1.3));
      _q.setFromEuler(_e);
      _p.set(s.x, 0.12 * Math.sin(time * 1.1 + ph), s.z);
      _s.set(sc, sc, sc);
      this.mats[i].compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, this.mats[i]);
      if (wakes && s.speed > 0) wakes.addHull(s.x, s.z, s.heading, FERRY_LENGTH * sc, FERRY_BEAM * sc, s.speed);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Night lights of the ferries near the camera into `lights`. Call after update(). */
  addLights(lights: SpriteBatch, cam: Vector3): void {
    for (let i = 0; i < this.fleet.length; i++) {
      const s = this.st[i];
      const d2 = (s.x - cam.x) ** 2 + (s.z - cam.z) ** 2;
      if (d2 > LIGHTS_FAR * LIGHTS_FAR) continue;
      const cabins = d2 < CABIN_LIGHTS_FAR * CABIN_LIGHTS_FAR;
      const m = this.mats[i];
      for (const l of FERRY_LIGHTS) {
        // sidelights only under way; masthead, stern and cabins always
        if (l.kind === 'deck' ? !cabins : l.kind === 'way' && l.color !== 0xffffff && s.dock >= 0) continue;
        _l.copy(l.pos).applyMatrix4(m);
        const c = l.color;
        const k = l.kind === 'deck' ? 1.2 : 2.2;
        if (!lights.add(_l.x, _l.y, _l.z, (((c >> 16) & 255) / 255) * k, (((c >> 8) & 255) / 255) * k, ((c & 255) / 255) * k, 1, l.size, l.kind === 'deck' ? 1.1 : 2.2)) return;
      }
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}
