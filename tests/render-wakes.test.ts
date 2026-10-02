/**
 * Shared wakes and the harbour ferries' visual (issue #30): every wake in one draw call, length and
 * brightness growing with speed, none on 'low' quality; ferries in one InstancedMesh over Auckland only;
 * no per-ship wake meshes left in the models. Scene-graph checks: no WebGL.
 */
import { describe, expect, it } from 'vitest';
import { InstancedMesh, Matrix4, Mesh, PerspectiveCamera, Scene, Vector3, type InstancedBufferGeometry, type Object3D } from 'three';
import { QUALITY_PRESETS } from '../src/core/data';
import type { EnvironmentApi, FrameContext, MissionRunnerApi } from '../src/core/contracts';
import type { QualitySettings, TheaterId, VesselClass } from '../src/core/types';
import type { SimWorld } from '../src/sim/api';
import { GroundTargetEntity } from '../src/sim/entities';
import { createEntityRenderer } from '../src/render/EntityRenderer';
import { getGroundPrototype } from '../src/render/models/ground';
import { WakeBatch, wakeIntensity, wakeLength } from '../src/render/effects/Wakes';
import { SHIP_DIMS } from '../src/render/visuals/shipMotion';
import { FERRY_FLEET, ferryAt, ferryRoutes } from '../src/render/traffic/ferryRoutes';
import { HarbourFerries, ferryGeometry } from '../src/render/traffic/HarbourFerries';

const DEG = Math.PI / 180;

describe('wake shape', () => {
  it('grows longer and brighter with speed; a hull at rest leaves none', () => {
    expect(wakeLength(0, 270)).toBe(0);
    expect(wakeIntensity(0)).toBe(0);
    expect(wakeIntensity(0.4)).toBe(0);
    let lastL = 0;
    let lastK = 0;
    for (let v = 1; v <= 12; v++) {
      const L = wakeLength(v, 34);
      const k = wakeIntensity(v);
      expect(L).toBeGreaterThan(lastL);
      expect(k).toBeGreaterThanOrEqual(lastK);
      lastL = L;
      lastK = k;
    }
    expect(wakeIntensity(5)).toBe(1);
    // a container ship at 11 kn and a ferry at 20 kn both trail ~250 m: what reads from 1 km up
    expect(wakeLength(5.5, SHIP_DIMS.container.length)).toBeGreaterThan(200);
    expect(wakeLength(10, 34)).toBeGreaterThan(200);
    // capped for very fast hulls
    expect(wakeLength(40, 34)).toBeLessThanOrEqual(4 * 34 + 150);
  });

  it('puts every wake in one instanced mesh, starting at the stern and pointing aft', () => {
    const b = new WakeBatch(8);
    b.begin(1, 0);
    // heading east (90°): the stern is to the west
    expect(b.addHull(1000, -500, 90 * DEG, 100, 16, 6)).toBe(true);
    expect(b.addHull(0, 0, 0, 34, 10, 0.2)).toBe(false); // too slow: no wake
    for (let i = 0; i < 10; i++) b.addHull(i * 100, 0, 0, 34, 10, 8);
    b.end();
    expect(b.count).toBe(8); // capped at capacity
    const g = b.mesh.geometry as InstancedBufferGeometry;
    expect(g.instanceCount).toBe(8);
    const pose = g.getAttribute('iPose');
    expect(pose.getX(0)).toBeLessThan(1000 - 40); // stern well aft of the centre
    expect(pose.getX(0)).toBeGreaterThan(1000 - 50);
    expect(pose.getY(0)).toBeCloseTo(-500, 3);
    expect(g.getAttribute('iShape').getY(0)).toBeCloseTo(wakeLength(6, 100), 3);
    b.dispose();
  });

  it('no ship model carries its own wake mesh any more', () => {
    for (const v of ['container', 'cruise', null] as (VesselClass | null)[]) {
      const p = getGroundPrototype('ship', 'grey', v);
      expect(p.root.getObjectByName('wake')).toBeUndefined();
    }
  });
});

/* ───────────── EntityRenderer: wakes behind moving ships and ferries, ferries over Auckland ───────────── */

function ship(id: number, vessel: VesselClass | null, x: number, z: number, speed: number): GroundTargetEntity {
  const e = new GroundTargetEntity(id, 'ship', vessel ? 'neutral' : 'red', { name: 'MV Test', radius: 100 });
  e.vessel = vessel;
  e.position.set(x, 0, z);
  e.velocity.set(speed, 0, 0);
  e.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), -90 * DEG); // bow east
  return e;
}

function setup(theater: TheaterId, quality: QualitySettings, ground: GroundTargetEntity[]) {
  const scene = new Scene();
  const world = { aircraft: [], missiles: [], sams: [], ground, getEntity: () => null } as unknown as SimWorld;
  const env = { isNight: false } as unknown as EnvironmentApi;
  const r = createEntityRenderer(scene, world, env, quality);
  const camera = new PerspectiveCamera(60, 2, 1, 50_000);
  camera.position.set(2000, 1000, -1500);
  const ctx = (time: number) =>
    ({
      dt: 1 / 60,
      time,
      world,
      player: null,
      camera,
      viewMode: 'chase',
      focusId: null,
      mission: { def: { theater } } as unknown as MissionRunnerApi,
      settings: {},
      quality,
      paused: false,
      screen: { width: 844, height: 390, dpr: 2, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
    }) as unknown as FrameContext;
  return { scene, r, ctx };
}

const find = (scene: Scene, name: string): Object3D[] => {
  const out: Object3D[] = [];
  scene.traverse((o) => o.name === name && out.push(o));
  return out;
};

describe('entity renderer: wakes and ferries', () => {
  it('Auckland, medium: one wake mesh for every moving ship and ferry under way, one ferry InstancedMesh', () => {
    const q = QUALITY_PRESETS.medium;
    const ships = [ship(1, 'container', 3000, -13000, 5.5), ship(2, 'cruise', 6000, -12500, 0), ship(3, null, 9000, -15000, 9)];
    const { scene, r, ctx } = setup('auckland', q, ships);
    const t = 1234;
    r.update(ctx(t));
    const wakes = find(scene, 'wakes');
    expect(wakes).toHaveLength(1);
    const ferries = find(scene, 'ferries');
    expect(ferries).toHaveLength(1);
    expect((ferries[0] as InstancedMesh).count).toBe(q.ferries);
    // the moving container ship and corvette, plus every ferry under way at this moment
    const routes = ferryRoutes();
    const underWay = FERRY_FLEET.slice(0, q.ferries).filter((f) => wakeIntensity(ferryAt(routes[f.route], f.k, t, { x: 0, z: 0, heading: 0, speed: 0, dock: -1 }).speed) > 0.01).length;
    expect(underWay).toBeGreaterThan(0);
    expect(((wakes[0] as Mesh).geometry as InstancedBufferGeometry).instanceCount).toBe(2 + underWay);
    // ≤ 2 draw calls for the whole feature: the wake mesh and the ferry mesh, nothing per ship
    for (const s of ships) {
      const o = r.getObject(s.id)!;
      o.traverse((c) => expect(c.name).not.toBe('wake'));
    }
    r.dispose();
  });

  it("'low' quality: no wakes, fewer ferries; other theatres: no ferries", () => {
    const low = setup('auckland', QUALITY_PRESETS.low, [ship(1, 'container', 3000, -13000, 5.5)]);
    low.r.update(low.ctx(10));
    expect(find(low.scene, 'wakes')).toHaveLength(0);
    expect((find(low.scene, 'ferries')[0] as InstancedMesh).count).toBe(QUALITY_PRESETS.low.ferries);
    low.r.dispose();
    const desert = setup('desert', QUALITY_PRESETS.high, [ship(1, null, 0, 0, 8)]);
    desert.r.update(desert.ctx(10));
    expect(find(desert.scene, 'ferries')).toHaveLength(0);
    expect(find(desert.scene, 'wakes')).toHaveLength(1);
    desert.r.dispose();
  });

  it('places each ferry instance where its timetable says, with a small model', () => {
    const f = new HarbourFerries(16);
    f.update(500, null);
    const routes = ferryRoutes();
    const m = new Matrix4();
    const p = new Vector3();
    for (const i of [0, 3, 9]) {
      const s = ferryAt(routes[FERRY_FLEET[i].route], FERRY_FLEET[i].k, 500, { x: 0, z: 0, heading: 0, speed: 0, dock: -1 });
      f.mesh.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      expect(p.x).toBeCloseTo(s.x, 3);
      expect(p.z).toBeCloseTo(s.z, 3);
      expect(Math.abs(p.y)).toBeLessThan(0.2);
    }
    expect(ferryGeometry().attributes.position.count / 3).toBeLessThan(300);
    f.dispose();
  });
});
