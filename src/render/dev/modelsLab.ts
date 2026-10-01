/**
 * DEV ONLY — models lab (labs/models-lab.html). Turntable/inspection view for every procedural model.
 *
 *   /labs/models-lab.html?model=f35a&view=34&ab=1&bay=1&loadout=a2a_beast
 *   model = <aircraft type> | m:<munition id> | sam:<sam type> | gt:<ground target type> | all
 *   view  = front | side | top | bottom | rear | 34 | 34b | 34l | low
 *   flight: ab, rpm, bay, elev, ail, rud, flaps, brake, alpha, mach   dead=1   night=1   spin=1   zoom=1
 */
import {
  ACESFilmicToneMapping,
  Box3,
  CanvasTexture,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  MeshLambertMaterial,
  Object3D,
  PerspectiveCamera,
  PlaneGeometry,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { AircraftEntity } from '../../sim/entities';
import { LOADOUTS } from '../../core/data';
import type { AircraftType, GroundTargetType, LoadoutId, MunitionId, SamType } from '../../core/types';
import { getAircraftPrototype } from '../models/aircraft';
import { AIRCRAFT_SPECS } from '../models/specs';
import { AircraftVisual } from '../visuals/AircraftVisual';
import { munitionMesh } from '../models/munitions';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const modelId = q.get('model') ?? 'f35a';
const view = q.get('view') ?? '34';
/** Grid mode: views=front,top,rear,bottom renders a 2×2 (or 1×N) grid in one frame. */
const views = (q.get('views') ?? '').split(',').filter(Boolean);
const night = q.get('night') === '1';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.toneMapping = ACESFilmicToneMapping;
renderer.outputColorSpace = SRGBColorSpace;
renderer.shadowMap.enabled = true;

const scene = new Scene();
const skyCol = night ? 0x0a0f18 : 0x8fb3d9;
scene.background = new Color(skyCol);
scene.fog = new Fog(skyCol, 400, 3000);
scene.add(new HemisphereLight(night ? 0x334466 : 0xffffff, night ? 0x111111 : 0x886644, night ? 0.25 : 1.2));
const sun = new DirectionalLight(0xffffff, night ? 0.15 : 2.2);
sun.position.set(40, 80, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 300 });
scene.add(sun);

// ground with a subtle grid
const gc = document.createElement('canvas');
gc.width = gc.height = 256;
const g2 = gc.getContext('2d')!;
g2.fillStyle = '#7d7a70';
g2.fillRect(0, 0, 256, 256);
g2.strokeStyle = 'rgba(0,0,0,0.25)';
g2.lineWidth = 2;
g2.strokeRect(0, 0, 256, 256);
const gt = new CanvasTexture(gc);
gt.wrapS = gt.wrapT = RepeatWrapping;
gt.repeat.set(200, 200);
gt.colorSpace = SRGBColorSpace;
const ground = new Mesh(new PlaneGeometry(2000, 2000), new MeshLambertMaterial({ map: gt }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const camera = new PerspectiveCamera(35, 1, 0.1, 5000);
const holder = new Group();
scene.add(holder);

let update: (t: number, dt: number) => void = () => {};
let focusRadius = 8;
let groundY = -3;

function flightFromParams(ac: AircraftEntity): void {
  const f = ac.flight;
  f.afterburner = num('ab', 0);
  f.engineRpm = num('rpm', f.afterburner > 0 ? 1 : 0.85);
  f.alpha = (num('alpha', 0) * Math.PI) / 180;
  f.mach = num('mach', 0.8);
  f.surfaces.elevator = num('elev', 0);
  f.surfaces.aileron = num('ail', 0);
  f.surfaces.rudder = num('rud', 0);
  f.surfaces.flaps = num('flaps', 0);
  f.surfaces.airbrake = num('brake', 0);
  ac.bayDoors = num('bay', 0);
  ac.alive = q.get('dead') !== '1';
  ac.gear = num('gear', 1);
}

function addAircraft(type: AircraftType, pos = new Vector3()): AircraftVisual {
  const ac = new AircraftEntity(1, type, type === 'f35a' ? 'blue' : type === 'a320' ? 'neutral' : 'red');
  const lo = (q.get('loadout') ?? 'a2a_stealth') as LoadoutId;
  if (type === 'f35a') ac.stores = LOADOUTS[lo].stores.map((s) => ({ ...s }));
  flightFromParams(ac);
  const vis = new AircraftVisual(getAircraftPrototype(type), AIRCRAFT_SPECS[type], true, true);
  ac.position.copy(pos);
  holder.add(vis.root);
  const lodCfg = { lod0: 1e9, far: 1e9 };
  const prev = update;
  const forceLod1 = q.get('lod') === '1';
  update = (t, dt) => {
    prev(t, dt);
    vis.update(ac, t, dt, camera.position, forceLod1 ? { lod0: 0, far: 1e9 } : lodCfg, night);
    if (forceLod1) {
      (vis.root.children[0] as Object3D).visible = false;
      (vis.root.children[1] as Object3D).visible = true;
    }
  };
  return vis;
}

function build(): void {
  if (modelId === 'all') {
    const types: AircraftType[] = ['f35a', 'mig29', 'su27', 'su35', 'su57', 'tu22m', 'a50', 'a320'];
    let x = -60;
    for (const t of types) {
      const s = AIRCRAFT_SPECS[t];
      x += s.span / 2 + 4;
      addAircraft(t, new Vector3(x, 0, 0));
      x += s.span / 2 + 4;
    }
    holder.position.x = -x / 2 + 30;
    focusRadius = 70;
    groundY = -6;
    return;
  }
  if (modelId.startsWith('m:')) {
    const id = modelId.slice(2) as MunitionId;
    const m = munitionMesh(id);
    m.castShadow = true;
    holder.add(m);
    const bb = new Box3().setFromObject(m);
    focusRadius = bb.getSize(new Vector3()).length() * 0.6;
    groundY = bb.min.y - 0.4;
    return;
  }
  if (modelId.startsWith('sam:') || modelId.startsWith('gt:')) {
    void import('./labGround').then((mod) => {
      const obj = mod.buildLabGround(modelId, scene, (fn) => {
        const prev = update;
        update = (t, dt) => {
          prev(t, dt);
          fn(t, dt);
        };
      });
      holder.add(obj.object);
      focusRadius = obj.radius;
      groundY = 0;
      ground.position.y = -0.02;
      place();
    });
    return;
  }
  const type = modelId as AircraftType;
  addAircraft(type);
  const s = AIRCRAFT_SPECS[type] ?? AIRCRAFT_SPECS.f35a;
  focusRadius = Math.max(s.length, s.span) * 0.62;
  groundY = -s.height * 0.75;
}

const VIEWS: Record<string, [number, number, number]> = {
  front: [0, 0.12, -1],
  side: [1, 0.06, 0],
  top: [0.0001, 1, 0.02],
  bottom: [0.0001, -1, 0.02],
  rear: [0, 0.15, 1],
  '34': [0.85, 0.42, -0.95],
  '34b': [0.85, 0.45, 0.9],
  '34l': [-0.85, 0.3, -0.95],
  low: [0.6, -0.35, -0.9],
};

function place(v: string = view): void {
  const dir = new Vector3(...(VIEWS[v] ?? VIEWS['34'])).normalize();
  const fovR = (camera.fov * Math.PI) / 180;
  const d = (focusRadius / Math.sin(fovR / 2)) * 0.62 / num('zoom', 1);
  camera.position.copy(dir.multiplyScalar(d));
  camera.lookAt(0, 0, 0);
  if (!modelId.startsWith('sam:') && !modelId.startsWith('gt:')) ground.position.y = v === 'bottom' ? -1e4 : groundY;
}

function resize(): void {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}

build();
resize();
place();
addEventListener('resize', resize);

const info = document.getElementById('info')!;
let last = performance.now();
let t = 0;
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  t += dt;
  if (q.get('spin') === '1') holder.rotation.y += dt * 0.4;
  update(t, dt);
  if (views.length) {
    const cols = views.length > 2 ? 2 : views.length;
    const rows = Math.ceil(views.length / cols);
    const w = innerWidth / cols;
    const h = innerHeight / rows;
    renderer.setScissorTest(true);
    views.forEach((v, i) => {
      const x = (i % cols) * w;
      const y = innerHeight - (Math.floor(i / cols) + 1) * h;
      renderer.setViewport(x, y, w, h);
      renderer.setScissor(x, y, w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      place(v);
      renderer.render(scene, camera);
    });
    renderer.setScissorTest(false);
  } else renderer.render(scene, camera);
  const r = renderer.info.render;
  info.textContent = `${modelId}  view=${view}  tris=${r.triangles}  calls=${r.calls}`;
});

(window as unknown as { __lab: unknown }).__lab = {
  scene,
  camera,
  info: () => ({ triangles: renderer.info.render.triangles, calls: renderer.info.render.calls }),
};
