/**
 * DEV ONLY — effects lab (labs/fx-lab.html). Runs the real EntityRenderer + Effects + CameraRig against a
 * small mock SimWorld with scripted scenarios, so every effect can be screenshotted deterministically:
 *
 *   /labs/fx-lab.html?fx=sam|aam|boom|wreck|flares|guns|contrail|cone|all&cam=chase|fixed|orbit|flyby|missile|target|cockpit|tactical
 *   &night=1  &t=<seconds to fast-forward>  &q=low|medium|high
 */
import {
  ACESFilmicToneMapping,
  CanvasTexture,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  PlaneGeometry,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { EventBus } from '../../core/events';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../../core/data';
import { quatFromHPR, forwardOf } from '../../core/math';
import type { EnvironmentApi, FrameContext } from '../../core/contracts';
import type { CameraMode, MunitionId, QualityLevel } from '../../core/types';
import type { SimWorld, TerrainQuery } from '../../sim/api';
import { AircraftEntity, DecoyEntity, GroundTargetEntity, MissileEntity, SamSiteEntity, type AnyEntity, type MunitionDef, type Projectile } from '../../sim/entities';
import { createEntityRenderer } from '../EntityRenderer';
import { createEffects } from '../effects/Effects';
import { createCameraRig } from '../CameraRig';
import { LOADOUTS } from '../../core/data';

const q = new URLSearchParams(location.search);
const fx = q.get('fx') ?? 'all';
const camMode = (q.get('cam') ?? 'chase') as CameraMode | 'fixed';
const night = q.get('night') === '1';
const quality = { ...QUALITY_PRESETS[(q.get('q') ?? 'medium') as QualityLevel] };
const skip = Number(q.get('t') ?? 0);

/* ───────────── renderer / scene ───────────── */
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.toneMapping = ACESFilmicToneMapping;
renderer.outputColorSpace = SRGBColorSpace;
const scene = new Scene();
const sky = night ? 0x0b1220 : 0x9cbad8;
scene.background = new Color(sky);
scene.fog = new Fog(sky, 2000, 30000);
scene.add(new HemisphereLight(night ? 0x334466 : 0xffffff, night ? 0x111111 : 0x7a6a50, night ? 0.25 : 1.2));
const sun = new DirectionalLight(0xffffff, night ? 0.1 : 2.2);
sun.position.set(0.5, 1, 0.3);
scene.add(sun);
const gc = document.createElement('canvas');
gc.width = gc.height = 256;
const g2 = gc.getContext('2d')!;
g2.fillStyle = '#a89872';
g2.fillRect(0, 0, 256, 256);
for (let i = 0; i < 400; i++) {
  g2.fillStyle = `rgba(${Math.random() > 0.5 ? '255,255,255' : '60,50,30'},0.08)`;
  g2.fillRect(Math.random() * 256, Math.random() * 256, 10 + Math.random() * 30, 10 + Math.random() * 30);
}
const gt = new CanvasTexture(gc);
gt.wrapS = gt.wrapT = RepeatWrapping;
gt.repeat.set(400, 400);
gt.colorSpace = SRGBColorSpace;
const ground = new Mesh(new PlaneGeometry(80000, 80000), new MeshLambertMaterial({ map: gt }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
const sea = new Mesh(new PlaneGeometry(40000, 80000), new MeshLambertMaterial({ color: 0x2c5a78 }));
sea.rotation.x = -Math.PI / 2;
sea.position.set(23000, 0.05, 0);
scene.add(sea);

/* ───────────── mock world ───────────── */
const terrain: TerrainQuery = {
  size: 80000,
  heightAt: () => 0,
  surfaceHeightAt: () => 0,
  isWater: (x) => x > 3000,
  lineOfSight: () => true,
  raycast: (o, d, max) => (d.y < 0 ? Math.min(max, o.y / -d.y) : -1),
};
const events = new EventBus();
let idSeq = 1;
const world = {
  events,
  terrain,
  time: 0,
  aircraft: [] as AircraftEntity[],
  missiles: [] as MissileEntity[],
  sams: [] as SamSiteEntity[],
  ground: [] as GroundTargetEntity[],
  decoys: [] as DecoyEntity[],
  projectiles: [] as Projectile[],
  player: null as AircraftEntity | null,
  nextId: () => idSeq++,
  getEntity(id: number | null | undefined): AnyEntity | null {
    if (id == null) return null;
    const w = world as unknown as { aircraft: AnyEntity[]; missiles: AnyEntity[]; sams: AnyEntity[]; ground: AnyEntity[]; decoys: AnyEntity[] };
    for (const l of [w.aircraft, w.missiles, w.sams, w.ground, w.decoys]) for (const e of l) if (e.id === id) return e;
    return null;
  },
} as unknown as SimWorld & { time: number; player: AircraftEntity | null };
const env: EnvironmentApi = { terrain, sunDirection: new Vector3(0.5, night ? -0.3 : 0.8, 0.3).normalize(), isNight: night, fogColor: sky, update() {}, dispose() {} };

function def(id: MunitionId, cat: MunitionDef['category'], guidance: MunitionDef['guidance'], smoke: number, length: number, diameter: number, boost: number): MunitionDef {
  return { id, name: id, short: id, category: cat, guidance, launch: 'rail', mass: 100, boostTime: boost, boostAccel: 200, sustainTime: 0, sustainAccel: 0, drag: 0, glideRatio: 0, maxG: 30, seekerFov: 1, gimbalLimit: 1, seekerRange: 1, navConstant: 4, minRange: 0, maxRange: 1, fuseRadius: 10, damage: 50, blastRadius: 10, maxFlightTime: 30, flareResistance: 0, chaffResistance: 0, notchResistance: 0, smoke, length, diameter } as MunitionDef;
}
const DEFS = {
  aim120: def('aim120', 'aam', 'active_radar', 0.35, 3.66, 0.178, 6),
  aim9x: def('aim9x', 'aam', 'ir', 0.5, 3.02, 0.127, 4),
  m_3m9: def('m_3m9', 'sam', 'semi_active', 0.9, 5.8, 0.335, 7),
  m_48n6: def('m_48n6', 'sam', 'command', 1, 7.5, 0.515, 9),
  gbu31: def('gbu31', 'bomb', 'gps', 0, 3.88, 0.46, 0),
};

function spawnAircraft(type: AircraftEntity['type'], team: 'blue' | 'red', pos: Vector3, heading: number, speed: number, isPlayer = false): AircraftEntity {
  const ac = new AircraftEntity(world.nextId(), type, team);
  ac.position.copy(pos);
  quatFromHPR(heading, 0, 0, ac.quaternion);
  forwardOf(ac.quaternion, ac.velocity).multiplyScalar(speed);
  ac.flight.tas = ac.flight.ias = speed;
  ac.flight.mach = speed / 330;
  ac.flight.engineRpm = 0.9;
  ac.isPlayer = isPlayer;
  if (isPlayer) {
    ac.stores = LOADOUTS.a2a_stealth.stores.map((s) => ({ ...s }));
    (world as { player: AircraftEntity | null }).player = ac;
  }
  world.aircraft.push(ac);
  return ac;
}

interface Flight {
  m: MissileEntity;
  end: number;
  steer: (m: MissileEntity, dt: number) => void;
}
const flights: Flight[] = [];

function launch(d: MunitionDef, from: Vector3, vel: Vector3, shooter: AnyEntity, life: number, steer: Flight['steer']): MissileEntity {
  const m = new MissileEntity(world.nextId(), d, shooter.team, shooter.id, null);
  m.position.copy(from);
  m.velocity.copy(vel);
  m.motorBurning = d.boostTime > 0;
  world.missiles.push(m);
  flights.push({ m, end: world.time + life, steer });
  events.emit('munition:launch', { missile: m, shooter, targetId: null });
  return m;
}

/* ───────────── scenarios ───────────── */
const player = spawnAircraft('f35a', 'blue', new Vector3(0, fx === 'contrail' ? 9200 : 900, 3000), 0, fx === 'cone' ? 335 : 230, true);
const actions: { t: number; fn: () => void; done?: boolean }[] = [];
const every = (start: number, period: number, count: number, fn: (i: number) => void) => {
  for (let i = 0; i < count; i++) actions.push({ t: start + i * period, fn: () => fn(i) });
};
let wreck: AircraftEntity | null = null;

if (fx === 'sam' || fx === 'all') {
  const site = new SamSiteEntity(world.nextId(), 'sa6', 'red', { missiles: 9 });
  site.position.set(-600, 0, -1500);
  world.sams.push(site);
  every(1, 3.5, 6, () => {
    const from = site.position.clone().add(new Vector3(0, 4, 0));
    const tgt = player.position;
    const vel = new Vector3().subVectors(tgt, from).normalize().multiplyScalar(80).add(new Vector3(0, 60, 0));
    launch(DEFS.m_3m9, from, vel, site, 9, (m, dt) => {
      const d = new Vector3().subVectors(player.position, m.position).normalize();
      m.velocity.lerp(d.multiplyScalar(Math.min(900, m.velocity.length() + 250 * dt)), 0.04);
      if (m.age > 6) m.motorBurning = false;
    });
    site.missilesReady = Math.max(0, site.missilesReady - 1);
  });
}
if (fx === 'aam' || fx === 'all') {
  const bandit = spawnAircraft('su27', 'red', new Vector3(300, 1100, -3500), Math.PI, 220);
  player.radar.lockedId = bandit.id;
  every(1.5, 3, 5, (i) => {
    const d = i % 2 ? DEFS.aim9x : DEFS.aim120;
    const from = player.position.clone().add(new Vector3(i % 2 ? 4.7 : 0.8, -0.8, 0).applyQuaternion(player.quaternion));
    player.bayDoors = 1;
    launch(d, from, player.velocity.clone(), player, 7, (m, dt) => {
      const dir = new Vector3().subVectors(bandit.position, m.position).normalize();
      const spd = Math.min(1100, m.velocity.length() + 300 * dt);
      m.velocity.lerp(dir.multiplyScalar(spd), 0.05);
    });
  });
}
if (fx === 'boom' || fx === 'all') {
  const seq: [ExplosionArgs, number][] = [
    [{ size: 'tiny', surface: 'air', p: [0, 900, 1500] }, 0.5],
    [{ size: 'small', surface: 'air', p: [80, 950, 1400] }, 1.5],
    [{ size: 'medium', surface: 'air', p: [-80, 1000, 1300] }, 2.5],
    [{ size: 'large', surface: 'ground', p: [-300, 0, 1000] }, 3.5],
    [{ size: 'huge', surface: 'ground', p: [300, 0, 800] }, 4.5],
    [{ size: 'medium', surface: 'water', p: [3300, 0, 1500] }, 5.5],
  ];
  for (const [a, t] of seq) actions.push({ t, fn: () => events.emit('explosion', { position: new Vector3(...a.p), size: a.size, surface: a.surface }) });
  // destroyed ground target → burning fuel farm
  const fuel = new GroundTargetEntity(world.nextId(), 'fuel', 'red');
  fuel.position.set(400, 0, 400);
  world.ground.push(fuel);
  actions.push({
    t: 2,
    fn: () => {
      fuel.alive = false;
      events.emit('explosion', { position: fuel.position.clone(), size: 'huge', surface: 'ground' });
      events.emit('destroyed', { entity: fuel, attackerId: player.id, weapon: 'gbu31' });
    },
  });
}
interface ExplosionArgs {
  size: 'tiny' | 'small' | 'medium' | 'large' | 'huge';
  surface: 'air' | 'ground' | 'water';
  p: [number, number, number];
}
if (fx === 'wreck' || fx === 'all') {
  wreck = spawnAircraft('mig29', 'red', new Vector3(-200, 1400, 1200), 0.5, 200);
  actions.push({
    t: 1,
    fn: () => {
      wreck!.alive = false;
      wreck!.health = 0;
      events.emit('explosion', { position: wreck!.position.clone(), size: 'medium', surface: 'air' });
      events.emit('destroyed', { entity: wreck!, attackerId: player.id, weapon: 'aim120' });
    },
  });
}
if (fx === 'flares' || fx === 'all') {
  every(1, 0.25, 16, (i) => {
    const type = i % 4 === 3 ? 'chaff' : 'flare';
    const d = new DecoyEntity(world.nextId(), type, 'blue', player.id, type === 'flare' ? 3.5 : 5, 1);
    d.position.copy(player.position).add(new Vector3(0, -1, 3).applyQuaternion(player.quaternion));
    d.velocity.copy(player.velocity).multiplyScalar(0.6).add(new Vector3((i % 2 ? 1 : -1) * 25, -12, 0).applyQuaternion(player.quaternion));
    world.decoys.push(d);
    events.emit('countermeasure', { decoy: d, ownerId: player.id });
  });
}
if (fx === 'guns' || fx === 'all') {
  for (let i = 0; i < 200; i++)
    world.projectiles.push({ active: false, position: new Vector3(), velocity: new Vector3(), prevPosition: new Vector3(), age: 0, life: 2, team: 'blue', shooterId: player.id, damage: 1, tracer: i % 3 === 0, flak: false, calibre: 0.025 });
}
if (fx === 'contrail') player.flight.gLoad = 1;
if (fx === 'cone') player.flight.mach = 1.0;

/* ───────────── modules under test ───────────── */
const entities = createEntityRenderer(scene, world, env, quality);
const effects = createEffects(scene, world, events, env, quality);
const rig = createCameraRig(world, entities, { ...DEFAULT_SETTINGS });
scene.add(rig.camera);
if (camMode !== 'fixed' && camMode !== 'missile') rig.setMode(camMode);
if (camMode === 'missile') actions.push({ t: 1.7, fn: () => rig.setMode('missile') });
entities.setPlayerVisible(camMode !== 'cockpit' && camMode !== 'hud');

let gunCursor = 0;
function simStep(dt: number): void {
  const t = (world.time += dt);
  for (const a of actions) if (!a.done && t >= a.t) {
    a.done = true;
    a.fn();
  }
  // player: gentle turn in 'vortex' style scenarios
  const turning = fx === 'aam' || fx === 'all' ? 0.08 : fx === 'contrail' ? 0 : 0.02;
  player.flight.gLoad = fx === 'all' || fx === 'aam' ? 6.5 : player.flight.gLoad;
  player.flight.alpha = fx === 'all' ? 0.3 : 0.05;
  player.flight.afterburner = fx === 'cone' || fx === 'all' ? 1 : 0;
  quatFromHPR(-t * turning, 0, turning * 6, player.quaternion);
  forwardOf(player.quaternion, player.velocity).multiplyScalar(player.flight.tas);
  player.position.addScaledVector(player.velocity, dt);
  player.bayDoors = Math.max(0, player.bayDoors - dt * 0.8);
  // other aircraft fly straight; the wreck spirals down
  for (const ac of world.aircraft) {
    if (ac === player) continue;
    if (!ac.alive && !ac.crashed) {
      ac.velocity.y -= 25 * dt;
      ac.quaternion.multiply(new (ac.quaternion.constructor as typeof import('three').Quaternion)().setFromAxisAngle(new Vector3(0, 0, 1), dt * 2.5));
      if (ac.position.y <= 0) {
        ac.position.y = 0;
        ac.crashed = true;
        ac.velocity.set(0, 0, 0);
        events.emit('explosion', { position: ac.position.clone(), size: 'large', surface: 'ground' });
      }
    }
    ac.position.addScaledVector(ac.velocity, dt);
  }
  for (const f of flights) {
    const m = f.m;
    if (!m.alive) continue;
    m.age += dt;
    f.steer(m, dt);
    m.position.addScaledVector(m.velocity, dt);
    m.quaternion.setFromUnitVectors(new Vector3(0, 0, -1), m.velocity.clone().normalize());
    if (t > f.end) {
      m.alive = false;
      events.emit('munition:end', { missile: m, position: m.position.clone(), reason: 'proximity', targetId: null });
    }
  }
  const keep = world.missiles.filter((m) => m.alive || flights.some((f) => f.m === m && t - f.end < 0.1));
  world.missiles.length = 0;
  world.missiles.push(...keep);
  for (const d of world.decoys) {
    if (!d.alive) continue;
    d.age += dt;
    d.velocity.y -= (d.type === 'flare' ? 9.8 : 1) * dt;
    d.velocity.multiplyScalar(Math.exp(-(d.type === 'flare' ? 0.6 : 2.5) * dt));
    d.position.addScaledVector(d.velocity, dt);
    if (d.age > d.life) d.alive = false;
  }
  // guns
  if (fx === 'guns' || fx === 'all') {
    player.gunFiring = Math.floor(t / 2) % 2 === 0;
    if (player.gunFiring) {
      for (let k = 0; k < 2; k++) {
        const pr = world.projectiles[gunCursor++ % world.projectiles.length];
        pr.active = true;
        pr.age = 0;
        pr.position.copy(player.position).add(new Vector3(-1.1, 0.3, -2).applyQuaternion(player.quaternion));
        pr.velocity.set((Math.random() - 0.5) * 8, -60 + (Math.random() - 0.5) * 8, -1000).applyQuaternion(player.quaternion).add(player.velocity);
      }
    }
    for (const pr of world.projectiles) {
      if (!pr.active) continue;
      pr.age += dt;
      pr.prevPosition.copy(pr.position);
      pr.velocity.y -= 9.8 * dt;
      pr.position.addScaledVector(pr.velocity, dt);
      if (pr.position.y <= 0) {
        pr.active = false;
        events.emit('gun:impact', { position: pr.position.clone().setY(0), surface: terrain.isWater(pr.position.x, pr.position.z) ? 'water' : 'ground', targetId: null });
      } else if (pr.age > pr.life) pr.active = false;
    }
  }
}

function resize(): void {
  renderer.setSize(innerWidth, innerHeight, false);
  rig.resize(innerWidth, innerHeight);
}
resize();
addEventListener('resize', resize);

const info = document.getElementById('info')!;
const ctxOf = (dt: number): FrameContext => ({
  dt,
  time: world.time,
  world,
  player,
  camera: rig.camera,
  viewMode: camMode === 'fixed' ? 'chase' : rig.mode,
  focusId: rig.focusId,
  mission: null,
  settings: DEFAULT_SETTINGS,
  quality,
  paused: false,
  screen: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
});

// fast-forward (deterministic look at a later moment)
for (let s = 0; s < skip * 60; s++) {
  simStep(1 / 60);
  if (s % 6 === 0) {
    const c = ctxOf(0.1);
    entities.update(c);
    rig.update(c);
    effects.update(c);
  }
}

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  // fixed sim rate regardless of the (slow, software-GL) frame rate
  const real = Math.min(0.1, (now - last) / 1000);
  last = now;
  const dt = 1 / 30;
  simStep(dt);
  const c = ctxOf(dt);
  entities.update(c);
  if (camMode === 'fixed') {
    const f = (q.get('fixed') ?? '600,400,1200,-300,300,-400').split(',').map(Number);
    rig.camera.position.set(f[0], f[1], f[2]);
    rig.camera.up.set(0, 1, 0);
    rig.camera.lookAt(f[3], f[4], f[5]);
    rig.camera.updateMatrixWorld();
  } else rig.update(c);
  effects.update(c);
  renderer.render(scene, rig.camera);
  const r = renderer.info.render;
  const st = (effects as unknown as { stats?: () => string }).stats?.() ?? '';
  info.textContent = `fx=${fx} cam=${camMode === 'fixed' ? 'fixed' : rig.mode} t=${world.time.toFixed(1)} calls=${r.calls} tris=${r.triangles} frame=${(real * 1000).toFixed(0)}ms ${st}`;
});

(window as unknown as { __fx: unknown }).__fx = { world, events, rig, player };
