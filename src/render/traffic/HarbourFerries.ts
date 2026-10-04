/**
 * HarbourFerries: the visual-only Auckland harbour ferries (issue #30) in one InstancedMesh. Each frame
 * every ferry is placed by its timetable (ferryRoutes.ts, a pure function of mission time), bobs a little,
 * leaves a wake in the shared WakeBatch and, at night, shows its nav and cabin lights through the entity
 * renderer's sprite batch. In wartime they are scenery only: not on radar, not targetable. In A Stroll in the Park the
 * sim sails each one as a neutral ship (vessel 'ferry', GroundTargetEntity.ferrySlot: missions/runtime/shipping.ts), so
 * the player can box and shoot it; a ferry with a sim entity is drawn where the entity is, and once it is sunk it lists
 * and goes down like any civil ship (shipMatrix) and its lights and wake go out.
 *
 * At night (#61) the cabin windows glow (a second InstancedMesh of window bands sharing the hulls'
 * instance matrices, unlit, drawn only at night) and the nav lights keep a few pixels wide, so a ferry
 * reads from a kilometre up instead of vanishing into the dark water.
 */
import { BufferGeometry, Euler, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import { box, boxUV, merge, place } from '../models/geom/core';
import { getMaterial } from '../models/materials';
import type { ShipLight } from '../models/ground';
import type { SpriteBatch } from '../effects/SpriteBatch';
import type { WakeBatch } from '../effects/Wakes';
import { FERRY_BEAM, FERRY_FLEET, FERRY_LENGTH, ferryAt, ferryRoutes, type FerryRoute, type FerryState } from './ferryRoutes';
import type { GroundTargetEntity } from '../../sim/entities';
import { shipMatrix } from '../visuals/shipMotion';

/** Lights are drawn out to this range (m); cabin windows closer in. */
const LIGHTS_FAR = 12_000;
const CABIN_LIGHTS_FAR = 5_000;

const WHITE = 0xf1f2ee;
const DARK = 0x26323c;
const LIVERY = 0x17708c;
/** Warm cabin lighting seen through the windows at night. */
const WINDOW_GLOW = 0xffc98a;
/** Minimum on-screen width (CSS px) of the nav lights and the cabin lights, so they read from ~1 km. */
const NAV_MIN_PX = 3.4;
const CABIN_MIN_PX = 1.8;

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

/** The lit cabin windows at night: bands just proud of the dark window boxes of ferryGeometry(). */
export function ferryWindowGeometry(): BufferGeometry {
  const L = FERRY_LENGTH;
  const B = FERRY_BEAM;
  const geo = merge([
    place(box(B + 0.3, 0.7, L - 10.4, WINDOW_GLOW), [0, 3.55, 2.5]),
    place(box(B - 1.3, 0.55, 13.2, WINDOW_GLOW), [0, 5.9, 3]),
    place(box(6.3, 0.5, 4.8, WINDOW_GLOW), [0, 7.9, -2.2]),
  ])!;
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
  /** The lit windows (visible at night only, see setNight()). */
  readonly windows: InstancedMesh;
  private readonly routes: FerryRoute[];
  private readonly fleet: readonly { route: number; k: number }[];
  private readonly st: FerryState[];
  private readonly mats: Matrix4[];
  /** The sim's ferry by fleet slot (free flight), else null: drawn where it is, sinking once dead. */
  private readonly sim: (GroundTargetEntity | null)[];
  /** The ferry is sunk (hidden: no lights). */
  private readonly sunk: boolean[];

  constructor(count: number) {
    this.routes = ferryRoutes();
    this.fleet = FERRY_FLEET.slice(0, Math.max(0, Math.min(count, FERRY_FLEET.length)));
    this.st = this.fleet.map(() => ({ x: 0, z: 0, heading: 0, speed: 0, dock: -1 }));
    this.mats = this.fleet.map(() => new Matrix4());
    this.sim = this.fleet.map(() => null);
    this.sunk = this.fleet.map(() => false);
    this.mesh = new InstancedMesh(ferryGeometry(), getMaterial('building'), Math.max(1, this.fleet.length));
    this.mesh.count = this.fleet.length;
    this.mesh.name = 'ferries';
    // the instances span the whole harbour; they are few and small, so skip culling
    this.mesh.frustumCulled = false;
    // unlit, fogged, vertex colours carry the glow; same instances as the hulls
    this.windows = new InstancedMesh(ferryWindowGeometry(), new MeshBasicMaterial({ vertexColors: true }), Math.max(1, this.fleet.length));
    this.windows.instanceMatrix = this.mesh.instanceMatrix;
    this.windows.count = this.fleet.length;
    this.windows.name = 'ferry-windows';
    this.windows.frustumCulled = false;
    this.windows.visible = false;
  }

  /** Lit windows at night only (by day the hull's dark window boxes show). */
  setNight(night: boolean): void {
    this.windows.visible = night && this.fleet.length > 0;
  }

  get count(): number {
    return this.fleet.length;
  }

  /** The sim's ferries (free flight: GroundTargetEntity.ferrySlot), or none: the timetable places every ferry. */
  bindSim(ground: readonly GroundTargetEntity[]): void {
    this.sim.fill(null);
    for (const g of ground) if (g.ferrySlot >= 0 && g.ferrySlot < this.sim.length) this.sim[g.ferrySlot] = g;
  }

  /** Places every ferry at mission time `time` and adds the wakes of those under way. */
  update(time: number, wakes: WakeBatch | null): void {
    for (let i = 0; i < this.fleet.length; i++) {
      const f = this.fleet[i];
      const r = this.routes[f.route];
      const s = ferryAt(r, f.k, time, this.st[i]);
      const sc = r.def.scale;
      const e = this.sim[i];
      this.sunk[i] = false;
      if (e) {
        // the sim's ferry: where it is (its timetable while afloat), listing and going down once it is sunk
        s.x = e.position.x;
        s.z = e.position.z;
        const sink = shipMatrix(e, time, this.mats[i]);
        if (!e.alive) s.speed = 0;
        this.sunk[i] = sink.progress >= 1;
        if (this.sunk[i]) this.mats[i].makeScale(0, 0, 0);
        else this.mats[i].scale(_s.set(sc, sc, sc));
        this.mesh.setMatrixAt(i, this.mats[i]);
        if (wakes && e.alive && s.speed > 0) wakes.addHull(s.x, s.z, s.heading, FERRY_LENGTH * sc, FERRY_BEAM * sc, s.speed);
        continue;
      }
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
      const e = this.sim[i];
      if (this.sunk[i] || (e && !e.alive)) continue; // a sunk ferry is dark
      const d2 = (s.x - cam.x) ** 2 + (s.z - cam.z) ** 2;
      if (d2 > LIGHTS_FAR * LIGHTS_FAR) continue;
      const cabins = d2 < CABIN_LIGHTS_FAR * CABIN_LIGHTS_FAR;
      const m = this.mats[i];
      for (const l of FERRY_LIGHTS) {
        // sidelights only under way; masthead, stern and cabins always
        if (l.kind === 'deck' ? !cabins : l.kind === 'way' && l.color !== 0xffffff && s.dock >= 0) continue;
        _l.copy(l.pos).applyMatrix4(m);
        const c = l.color;
        const k = l.kind === 'deck' ? 1.3 : 2.6;
        if (!lights.add(_l.x, _l.y, _l.z, (((c >> 16) & 255) / 255) * k, (((c >> 8) & 255) / 255) * k, ((c & 255) / 255) * k, 1, l.size, l.kind === 'deck' ? CABIN_MIN_PX : NAV_MIN_PX)) return;
      }
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.dispose();
    this.windows.removeFromParent();
    this.windows.geometry.dispose();
    (this.windows.material as MeshBasicMaterial).dispose();
  }
}
