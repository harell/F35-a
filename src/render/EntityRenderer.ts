/**
 * EntityRenderer — creates, animates and removes the visuals of every world entity:
 * aircraft (procedural models with animated surfaces, bays, stores, AB flames, LOD, wrecks),
 * missiles/bombs (with motor flames), SAM sites (radars/launchers/ready rounds), ground targets
 * (spinning radars, ship wakes, wreck variants) and aircraft nav lights / strobes (one sprite batch).
 * Decoys are drawn by Effects.
 */
import { Group, Vector3 } from 'three';
import type { CreateEntityRenderer, EntityRendererApi, FrameContext } from '../core/contracts';
import type { AircraftType, MunitionId, TheaterId } from '../core/types';
import { getAircraftPrototype } from './models/aircraft';
import { AIRCRAFT_SPECS, eyeOffsetOf } from './models/specs';
import { allMaterials, getEnvCube, modelQuality, setEnvironment } from './models/materials';
import { getSamPrototype } from './models/sams';
import { munitionGeometry } from './models/munitions';
import { getGroundPrototype } from './models/ground';
import type { PaletteId } from './models/vehicles';
import { AircraftVisual } from './visuals/AircraftVisual';
import { MissileVisual } from './visuals/MissileVisual';
import { GroundVisual, SamVisual } from './visuals/SiteVisuals';
import { SpriteBatch, pixelScale } from './effects/SpriteBatch';

const _p = new Vector3();
const eyeCache = new Map<AircraftType, Vector3>();

function paletteFor(theater: TheaterId | undefined): PaletteId {
  if (theater === 'desert') return 'desert';
  if (theater === 'arctic') return 'grey';
  return 'green';
}

interface Tracked<T> {
  v: T;
  seen: number;
}

export const createEntityRenderer: CreateEntityRenderer = (scene, world, env, quality) => {
  modelQuality.textureSize = quality.level === 'high' ? 2048 : quality.level === 'medium' ? 1024 : 512;
  modelQuality.anisotropy = quality.level === 'low' ? 1 : 4;

  const group = new Group();
  group.name = 'entities';
  scene.add(group);

  // Pre-build prototypes for everything already spawned (missions spawn before this factory runs),
  // so the geometry/texture work happens behind the loading screen instead of on the first frame.
  for (const ac of world.aircraft) getAircraftPrototype(ac.type);
  for (const id of ['aim120', 'aim9x', 'r73', 'r77', 'r27', 'gbu31', 'gbu39', 'aargm'] as MunitionId[]) munitionGeometry(id);

  // reflections: prefer the environment module's env map, else our procedural sky cube
  const envMap = scene.environment ?? getEnvCube();
  let lastNight: boolean | null = null;

  const aircraft = new Map<number, Tracked<AircraftVisual>>();
  const missiles = new Map<number, Tracked<MissileVisual>>();
  const missilePool = new Map<MunitionId, MissileVisual[]>();
  const sams = new Map<number, Tracked<SamVisual>>();
  const grounds = new Map<number, Tracked<GroundVisual>>();
  const lights = new SpriteBatch(256);
  group.add(lights.mesh);

  let playerVisible = true;
  let frame = 0;
  let palette: PaletteId | null = null;

  const q = quality;
  const lodCfg = {
    lod0: q.level === 'low' ? 350 : q.level === 'medium' ? 600 : 900,
    far: Math.min(q.drawDistance, q.level === 'low' ? 9000 : 14000),
  };
  const groundFar = q.level === 'low' ? 6000 : q.level === 'medium' ? 9000 : 13000;

  // Per-frame callbacks are created once (no closures/iterators allocated per frame).
  let fctx: FrameContext | null = null;
  const lightFor = (tr: Tracked<AircraftVisual>, id: number): void => {
    const ctx = fctx!;
    const v = tr.v;
    if (!v.root.visible) return;
    const ac = world.getEntity(id);
    if (!ac || !ac.alive) return;
    const night = env.isNight;
    const k = night ? 1 : 0.4;
    const m = v.root.matrixWorld;
    const d2 = v.root.position.distanceToSquared(ctx.camera.position);
    if (d2 > 25_000_000 && !night) return; // > 5 km by day: invisible anyway
    const t = ctx.time;
    const L = v.lightLocal;
    for (let i = 0; i < L.length; i++) {
      const l = L[i];
      _p.copy(l.pos).applyMatrix4(m);
      const c = l.color;
      const r = ((c >> 16) & 255) / 255;
      const g = ((c >> 8) & 255) / 255;
      const b = (c & 255) / 255;
      if (l.kind === 'strobe') {
        const ph = (t * 0.9 + id * 0.37 + i * 0.5) % 1.2;
        if (ph > 0.07) continue;
        lights.add(_p.x, _p.y, _p.z, r * 3 * k, g * 3 * k, b * 3 * k, 1, 1.4, night ? 7 : 4);
      } else lights.add(_p.x, _p.y, _p.z, r * 1.6 * k, g * 1.6 * k, b * 1.6 * k, 1, 0.6, night ? 3.5 : 2);
    }
  };
  const sweepAircraft = (tr: Tracked<AircraftVisual>, id: number): void => {
    if (tr.seen !== frame) {
      tr.v.dispose();
      aircraft.delete(id);
    }
  };
  const sweepMissile = (tr: Tracked<MissileVisual>, id: number): void => {
    if (tr.seen === frame) return;
    tr.v.root.removeFromParent();
    let pool = missilePool.get(tr.v.id);
    if (!pool) missilePool.set(tr.v.id, (pool = []));
    if (pool.length < 12) pool.push(tr.v);
    else tr.v.dispose();
    missiles.delete(id);
  };
  const sweepSam = (tr: Tracked<SamVisual>, id: number): void => {
    if (tr.seen !== frame) {
      tr.v.dispose();
      sams.delete(id);
    }
  };
  const sweepGround = (tr: Tracked<GroundVisual>, id: number): void => {
    if (tr.seen !== frame) {
      tr.v.dispose();
      grounds.delete(id);
    }
  };

  function updateLights(ctx: FrameContext): void {
    fctx = ctx;
    lights.begin(pixelScale(ctx.camera.fov, ctx.screen.height));
    // tactical view: the HUD draws its own north-up 2D map (contacts, SAM rings, route) over the
    // faint 3D background, so no 3D markers are drawn there (they would not match the map scale)
    if (ctx.viewMode !== 'tactical') aircraft.forEach(lightFor);
    lights.end();
  }

  const api: EntityRendererApi = {
    update(ctx: FrameContext) {
      frame++;
      fctx = ctx;
      const cam = ctx.camera.position;
      const t = ctx.time;
      const dt = ctx.paused ? 0 : ctx.dt;
      if (palette === null) palette = paletteFor(ctx.mission?.def.theater);
      if (lastNight !== env.isNight) {
        lastNight = env.isNight;
        setEnvironment(envMap, env.isNight ? 0.12 : 1);
      }

      // aircraft
      for (const ac of world.aircraft) {
        let tr = aircraft.get(ac.id);
        if (!tr) {
          const v = new AircraftVisual(getAircraftPrototype(ac.type), AIRCRAFT_SPECS[ac.type] ?? AIRCRAFT_SPECS.f35a, ac.isPlayer, q.shadows);
          group.add(v.root);
          tr = { v, seen: frame };
          aircraft.set(ac.id, tr);
          // materials created lazily by this visual must get the env map too
          setEnvironment(envMap, env.isNight ? 0.12 : 1);
        }
        tr.seen = frame;
        const vis = tr.v.update(ac, t, dt, cam, lodCfg, env.isNight);
        tr.v.root.visible = vis && (!ac.isPlayer || playerVisible || !ac.alive);
      }
      aircraft.forEach(sweepAircraft);

      // missiles & bombs (pooled)
      for (const m of world.missiles) {
        let tr = missiles.get(m.id);
        if (!tr) {
          if (!m.alive) continue;
          const pool = missilePool.get(m.def.id);
          const v = pool?.pop() ?? new MissileVisual(m.def.id);
          v.bind(m);
          group.add(v.root);
          tr = { v, seen: frame };
          missiles.set(m.id, tr);
        }
        tr.seen = frame;
        tr.v.update(m, t, cam);
      }
      missiles.forEach(sweepMissile);

      // SAM sites
      for (const s of world.sams) {
        let tr = sams.get(s.id);
        if (!tr) {
          const v = new SamVisual(getSamPrototype(s.type, palette));
          group.add(v.root);
          tr = { v, seen: frame };
          sams.set(s.id, tr);
        }
        tr.seen = frame;
        tr.v.update(s, t, dt, cam, s.type === 'sa10' ? groundFar * 1.4 : groundFar);
      }
      sams.forEach(sweepSam);

      // ground targets
      for (const g of world.ground) {
        let tr = grounds.get(g.id);
        if (!tr) {
          const v = new GroundVisual(getGroundPrototype(g.type, palette));
          group.add(v.root);
          tr = { v, seen: frame };
          grounds.set(g.id, tr);
        }
        tr.seen = frame;
        tr.v.update(g, t, dt, cam, groundFar);
      }
      grounds.forEach(sweepGround);

      updateLights(ctx);
    },

    /** Returns a cached (shared, read-only) vector per type. */
    getEyeOffset(type: AircraftType): Vector3 {
      let v = eyeCache.get(type);
      if (!v) {
        const e = eyeOffsetOf(type);
        eyeCache.set(type, (v = new Vector3(e[0], e[1], e[2])));
      }
      return v;
    },

    getObject(entityId: number) {
      return aircraft.get(entityId)?.v.root ?? missiles.get(entityId)?.v.root ?? sams.get(entityId)?.v.root ?? grounds.get(entityId)?.v.root ?? null;
    },

    setPlayerVisible(visible: boolean) {
      playerVisible = visible;
    },

    prepareView(camPos: Vector3) {
      const ctx = fctx;
      if (!ctx) return;
      const t = ctx.time;
      for (const ac of world.aircraft) {
        const tr = aircraft.get(ac.id);
        if (tr) tr.v.root.visible = tr.v.update(ac, t, 0, camPos, lodCfg, env.isNight);
      }
      for (const m of world.missiles) missiles.get(m.id)?.v.update(m, t, camPos);
      for (const s of world.sams) sams.get(s.id)?.v.update(s, t, 0, camPos, s.type === 'sa10' ? groundFar * 1.4 : groundFar);
      for (const g of world.ground) grounds.get(g.id)?.v.update(g, t, 0, camPos, groundFar);
    },

    dispose() {
      aircraft.forEach((tr) => tr.v.dispose());
      missiles.forEach((tr) => tr.v.dispose());
      missilePool.forEach((p) => p.forEach((v) => v.dispose()));
      sams.forEach((tr) => tr.v.dispose());
      grounds.forEach((tr) => tr.v.dispose());
      aircraft.clear();
      missiles.clear();
      missilePool.clear();
      sams.clear();
      grounds.clear();
      lights.dispose();
      group.removeFromParent();
      // Free GPU copies of shared materials/textures; CPU-side prototypes stay cached so the next
      // mission starts fast (three.js re-uploads on next use).
      for (const m of allMaterials()) m.dispose();
    },
  };
  return api;
};
