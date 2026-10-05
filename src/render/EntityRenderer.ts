/**
 * EntityRenderer — creates, animates and removes the visuals of every world entity:
 * aircraft (procedural models with animated surfaces, bays, stores, AB flames, LOD, wrecks),
 * missiles/bombs (with motor flames), SAM sites (radars/launchers/ready rounds), ground targets
 * (spinning radars, wreck variants), aircraft nav lights / strobes (one sprite batch), the foam wakes
 * of every moving ship and ferry (one WakeBatch draw call) and, over Auckland, the visual-only harbour
 * ferries (one InstancedMesh). Decoys are drawn by Effects.
 */
import { Group, Vector3 } from 'three';
import type { CreateEntityRenderer, EntityRendererApi, FrameContext } from '../core/contracts';
import type { AircraftType, MunitionId } from '../core/types';
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
import { WakeBatch } from './effects/Wakes';
import { HarbourFerries } from './traffic/HarbourFerries';
import { shipDims } from './visuals/shipMotion';
import { BOAT_DIMS, type BoatKind } from './models/boats';

const _p = new Vector3();
const _fwd = new Vector3();

/** Foam wake of a moving Rat navy fast boat (suicide, missile or air-defence boat). */
function boatWake(wakes: WakeBatch, kind: BoatKind, pos: Vector3, vel: Vector3): void {
  const speed = Math.hypot(vel.x, vel.z);
  if (speed <= 0.5) return;
  const d = BOAT_DIMS[kind];
  wakes.addHull(pos.x, pos.z, Math.atan2(vel.x, -vel.z), d.length, d.beam, speed);
}
/** Ship nav lights are drawn out to this range (m); cabin / deck lights closer in. */
const SHIP_LIGHTS_FAR = 16_000;
const SHIP_DECK_LIGHTS_FAR = 7_000;
/** Wake brightness at night (moonlight on the foam; 1 by day). */
const NIGHT_WAKE = 0.45;
const eyeCache = new Map<AircraftType, Vector3>();

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
  for (const id of ['aim120', 'aim9x', 'r73', 'r77', 'r27', 'gbu31', 'kab500', 'gbu53', 'aargm'] as MunitionId[]) munitionGeometry(id);

  // reflections: prefer the environment module's env map, else our procedural sky cube
  const envMap = scene.environment ?? getEnvCube();
  let lastNight: boolean | null = null;

  const aircraft = new Map<number, Tracked<AircraftVisual>>();
  const missiles = new Map<number, Tracked<MissileVisual>>();
  const missilePool = new Map<MunitionId, MissileVisual[]>();
  const sams = new Map<number, Tracked<SamVisual>>();
  const grounds = new Map<number, Tracked<GroundVisual>>();
  // aircraft nav lights / strobes + civil ships' night lights (a cruise liner has ~100 cabin lights)
  const lights = new SpriteBatch(1024);
  group.add(lights.mesh);
  // foam wakes of every moving ship and ferry: one draw call ('low' quality: none)
  const wakes = quality.wakes ? new WakeBatch(64) : null;
  if (wakes) group.add(wakes.mesh);
  // visual-only harbour ferries (Auckland only; created on the first frame, once the mission is known)
  let ferries: HarbourFerries | null = null;
  let ferriesChecked = false;

  let playerVisible = true;
  let frame = 0;
  const palette: PaletteId = 'green';

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
  /** Civil ships at night: nav lights by COLREGS state, cabin / deck lights up close. */
  const shipLightsFor = (tr: Tracked<GroundVisual>): void => {
    const v = tr.v;
    const mode = v.lightMode;
    if (!mode || !v.root.visible) return;
    const ctx = fctx!;
    const d2 = v.root.position.distanceToSquared(ctx.camera.position);
    if (d2 > SHIP_LIGHTS_FAR * SHIP_LIGHTS_FAR) return;
    const deck = d2 < SHIP_DECK_LIGHTS_FAR * SHIP_DECK_LIGHTS_FAR;
    v.root.updateMatrix();
    const m = v.root.matrix; // the entities group sits at the origin
    const L = v.proto.lights;
    for (let i = 0; i < L.length; i++) {
      const l = L[i];
      if (l.kind === 'deck' ? !deck : l.kind === 'anchor' ? mode !== 2 : mode !== 1) continue;
      _p.copy(l.pos).applyMatrix4(m);
      if (_p.y < 0.3) continue; // flooded (sinking ships are not lit anyway)
      const c = l.color;
      const k = l.kind === 'deck' ? 1.3 : 2.2;
      if (!lights.add(_p.x, _p.y, _p.z, (((c >> 16) & 255) / 255) * k, (((c >> 8) & 255) / 255) * k, ((c & 255) / 255) * k, 1, l.size, l.kind === 'deck' ? 1.2 : 2.5)) return;
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
    if (ctx.viewMode !== 'tactical') {
      aircraft.forEach(lightFor);
      if (env.isNight) {
        // the ferries first: a few dozen lights, which a harbour full of lit liners must not crowd out
        ferries?.addLights(lights, ctx.camera.position);
        grounds.forEach(shipLightsFor);
      }
    }
    lights.end();
  }

  const api: EntityRendererApi = {
    update(ctx: FrameContext) {
      frame++;
      fctx = ctx;
      const cam = ctx.camera.position;
      const t = ctx.time;
      const dt = ctx.paused ? 0 : ctx.dt;
      if (!ferriesChecked && ctx.mission) {
        ferriesChecked = true;
        if (ctx.mission.def.theater === 'auckland' && q.ferries > 0) {
          ferries = new HarbourFerries(q.ferries);
          group.add(ferries.mesh, ferries.windows);
        }
      }
      // (at night a faint, moonlit wake)
      wakes?.begin(env.isNight ? NIGHT_WAKE : 1, t);
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
        const vis = tr.v.update(s, t, dt, cam, groundFar);
        // the air-defence boat (a moving SAM) leaves a wake like any boat
        if (wakes && vis && s.alive && s.boat) boatWake(wakes, 'ad_boat', s.position, s.velocity);
      }
      sams.forEach(sweepSam);

      // ground targets
      for (const g of world.ground) {
        if (g.scenery) continue; // the world scenery draws it (Wiri tanks)
        let tr = grounds.get(g.id);
        if (!tr) {
          const v = new GroundVisual(getGroundPrototype(g.type, palette, g.vessel));
          group.add(v.root);
          tr = { v, seen: frame };
          grounds.set(g.id, tr);
        }
        tr.seen = frame;
        const vis = tr.v.update(g, t, dt, cam, groundFar);
        if (wakes && vis && g.alive && g.boat) boatWake(wakes, g.type === 'missile_boat' ? 'missile_boat' : 'suicide_boat', g.position, g.velocity);
        else if (wakes && vis && g.alive && g.type === 'ship') {
          const speed = Math.max(g.velocity.length(), g.path ? g.speed : 0);
          if (speed > 0.5) {
            _fwd.set(0, 0, -1).applyQuaternion(g.quaternion);
            const d = shipDims(g.vessel);
            wakes.addHull(g.position.x, g.position.z, Math.atan2(_fwd.x, -_fwd.z), d.length, d.beam, speed);
          }
        }
      }
      grounds.forEach(sweepGround);

      // harbour ferries (render-only, placed by their timetable at sim time)
      ferries?.setNight(env.isNight);
      ferries?.update(t, wakes);
      wakes?.end();

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

    prepareView(camPos: Vector3, maxDist?: number) {
      const ctx = fctx;
      if (!ctx) return;
      const t = ctx.time;
      // (+200 m: a big airframe straddling the far plane is clipped by it, not dropped)
      const max2 = maxDist === undefined ? Infinity : (maxDist + 200) ** 2;
      for (const ac of world.aircraft) {
        const tr = aircraft.get(ac.id);
        if (!tr) continue;
        // (update() sets every aircraft's visibility again for the main camera)
        tr.v.root.visible = ac.position.distanceToSquared(camPos) <= max2 && tr.v.update(ac, t, 0, camPos, lodCfg, env.isNight);
      }
      for (const m of world.missiles) missiles.get(m.id)?.v.update(m, t, camPos);
      for (const s of world.sams) sams.get(s.id)?.v.update(s, t, 0, camPos, groundFar);
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
      wakes?.dispose();
      ferries?.dispose();
      ferries = null;
      group.removeFromParent();
      // Free GPU copies of shared materials/textures; CPU-side prototypes stay cached so the next
      // mission starts fast (three.js re-uploads on next use).
      for (const m of allMaterials()) m.dispose();
    },
  };
  return api;
};
