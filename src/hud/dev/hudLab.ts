/**
 * DEV ONLY — HUD / HMD / cockpit lab (hud-lab.html).
 *
 *   /hud-lab.html?scene=aa|lock|threat|gun|9x|ag|ccip|damage|pullup|offscreen|nav
 *                &view=cockpit|hud|chase|missile|tactical  &color=green|amber|cyan
 *                &tod=day|dawn|dusk|night  &bg=sky|snow  &q=low|medium|high  &fov=60
 *                &yaw=<deg>&pitch=<deg> (head look)  &t=<s> (pre-roll mock time)
 *                &zoom=0|1|2 (open that PCD portal in the zoom overlay, cockpit view)
 *                &defeat=1 (threat scene: the inbound missiles are defeated at t = 1.5 s)
 *
 * Renders a simple sky/ground scene with placeholder entity meshes so conformal symbols can be checked
 * against where objects really are, then runs the real createHud / createCockpit with a mocked
 * FrameContext. Tap the screen to test pick() → designate, tap the PCD to cycle pages.
 */
import {
  BoxGeometry,
  Color,
  ConeGeometry,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  CanvasTexture,
  Vector3,
  WebGLRenderer,
  ACESFilmicToneMapping,
  BackSide,
  Float32BufferAttribute,
} from 'three';
import type { FrameContext } from '../../core/contracts';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../../core/data';
import type { CameraMode, QualityLevel, Settings, TimeOfDay } from '../../core/types';
import { createHud } from '../Hud';
import { createCockpit } from '../Cockpit';
import { buildMock, type Scenario } from './mockWorld';
import { pcdZoom } from '../cockpit/zoom';

const params = new URLSearchParams(location.search);
const scene = (params.get('scene') ?? 'aa') as Scenario;
const view = (params.get('view') ?? 'cockpit') as CameraMode;
const tod = (params.get('tod') ?? 'day') as TimeOfDay;
const bg = params.get('bg') ?? 'sky';
const qLevel = (params.get('q') ?? 'medium') as QualityLevel;
const quality = { ...QUALITY_PRESETS[qLevel] };
const settings: Settings = { ...DEFAULT_SETTINGS, hudColor: (params.get('color') as Settings['hudColor']) ?? 'green', fov: Number(params.get('fov') ?? 60) };
const lookYaw = (Number(params.get('yaw') ?? 0) * Math.PI) / 180;
const lookPitch = (Number(params.get('pitch') ?? 0) * Math.PI) / 180;

const glCanvas = document.getElementById('gl') as HTMLCanvasElement;
const hudCanvas = document.getElementById('hud') as HTMLCanvasElement;
const info = document.getElementById('info') as HTMLDivElement;

const renderer = new WebGLRenderer({ canvas: glCanvas, antialias: quality.antialias });
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatio));

const mock = buildMock(scene);
(mock.mission.def as { timeOfDay: TimeOfDay }).timeOfDay = tod;
const { world, player, events } = mock;

/* ───────────── scene ───────────── */
const scene3 = new Scene();
const night = tod === 'night';
const skyTop = new Color(night ? 0x02040a : tod === 'day' ? 0x3d7fd0 : 0x4a4f86);
const skyHorizon = new Color(night ? 0x0a1020 : tod === 'day' ? (bg === 'snow' ? 0xf4f8ff : 0xcfe4f7) : 0xf0a070);
const skyGeo = new SphereGeometry(50_000, 32, 16);
const cols: number[] = [];
const pos = skyGeo.getAttribute('position');
for (let i = 0; i < pos.count; i++) {
  const y = pos.getY(i) / 50_000;
  const c = skyHorizon.clone().lerp(skyTop, Math.max(0, Math.min(1, Math.pow(Math.max(0, y), 0.5))));
  cols.push(c.r, c.g, c.b);
}
skyGeo.setAttribute('color', new Float32BufferAttribute(cols, 3));
scene3.add(new Mesh(skyGeo, new MeshBasicMaterial({ vertexColors: true, side: BackSide, depthWrite: false, fog: false })));

const tex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const snow = bg === 'snow';
  g.fillStyle = night ? '#0b120c' : snow ? '#eef3f7' : '#5d7a44';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = night ? '#16261a' : snow ? '#d5dde6' : '#4f6a39';
  g.lineWidth = 3;
  for (let i = 0; i <= 256; i += 32) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, 256);
    g.moveTo(0, i);
    g.lineTo(256, i);
    g.stroke();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(400, 400);
  return t;
})();
const ground = new Mesh(new PlaneGeometry(200_000, 200_000), new MeshBasicMaterial({ map: tex }));
ground.rotation.x = -Math.PI / 2;
scene3.add(ground);

// placeholder visuals for entities
const redMat = new MeshBasicMaterial({ color: 0x552222 });
const blueMat = new MeshBasicMaterial({ color: 0x223355 });
const whiteMat = new MeshBasicMaterial({ color: 0xdddddd });
for (const a of world.aircraft) {
  if (a === player) continue;
  const m = new Mesh(new BoxGeometry(10, 2, 14), a.team === 'red' ? redMat : blueMat);
  m.position.copy(a.position);
  m.quaternion.copy(a.quaternion);
  scene3.add(m);
}
for (const s of world.sams) {
  const m = new Mesh(new ConeGeometry(30, 40, 8), redMat);
  m.position.copy(s.position).setY(20);
  scene3.add(m);
}
for (const gt of world.ground) {
  const m = new Mesh(new BoxGeometry(60, 20, 20), redMat);
  m.position.copy(gt.position).setY(10);
  scene3.add(m);
}
for (const mi of world.missiles) {
  const m = new Mesh(new BoxGeometry(1, 1, 4), whiteMat);
  m.position.copy(mi.position);
  scene3.add(m);
}
let playerMesh: Mesh | null = null;
if (view !== 'cockpit' && view !== 'hud') {
  playerMesh = new Mesh(new BoxGeometry(11, 2.5, 15.7), new MeshBasicMaterial({ color: 0x555a60 }));
  playerMesh.position.copy(player.position);
  playerMesh.quaternion.copy(player.quaternion);
  scene3.add(playerMesh);
}

/* ───────────── camera ───────────── */
const camera = new PerspectiveCamera(settings.fov, 16 / 9, 0.5, 60_000);
scene3.add(camera);
const headLocal = new Quaternion();
headLocal.setFromAxisAngle(new Vector3(0, 1, 0), -lookYaw).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), lookPitch));
const eye = new Vector3(0, 1.02, -3.52);

function placeCamera(): void {
  if (view === 'cockpit' || view === 'hud') {
    camera.position.copy(eye).applyQuaternion(player.quaternion).add(player.position);
    camera.quaternion.copy(player.quaternion).multiply(headLocal);
  } else if (view === 'tactical') {
    camera.position.set(player.position.x, player.position.y + 9000, player.position.z);
    const f = new Vector3(0, 0, -1).applyQuaternion(player.quaternion);
    f.y = 0;
    camera.up.copy(f.normalize());
    camera.lookAt(player.position);
  } else if (view === 'missile') {
    const m = world.missiles.find((x) => x.shooterId === player.id) ?? null;
    const tgt = m ? m.position : player.position;
    const dir = m ? m.velocity.clone().normalize() : new Vector3(0, 0, -1);
    camera.position.copy(tgt).addScaledVector(dir, -14).add(new Vector3(0, 2.5, 0));
    camera.lookAt(tgt.clone().addScaledVector(dir, 50));
  } else {
    const off = new Vector3(0, 4.5, 20).applyQuaternion(player.quaternion);
    camera.position.copy(player.position).add(off);
    camera.up.set(0, 1, 0).applyQuaternion(player.quaternion);
    camera.lookAt(player.position.clone().add(new Vector3(0, 0, -40).applyQuaternion(player.quaternion)));
  }
  camera.updateMatrixWorld();
}

/* ───────────── HUD + cockpit ───────────── */
const hud = createHud(hudCanvas, events);
const cockpit = createCockpit(events, quality);
cockpit.visible = view === 'cockpit';
hud.setVisible(view !== 'tactical');

const screen = { width: 1, height: 1, dpr: 1, safe: { top: 0, right: 0, bottom: 0, left: 0 } };
function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  screen.width = w;
  screen.height = h;
  screen.dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setSize(w, h, true);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  hud.resize(w, h, screen.dpr);
  cockpit.resize(w, h);
}
window.addEventListener('resize', resize);
resize();

const ctx: FrameContext = {
  dt: 1 / 60,
  time: 0,
  world,
  player,
  camera,
  viewMode: view,
  focusId: view === 'missile' ? world.missiles.find((m) => m.shooterId === player.id)?.id ?? null : player.id,
  mission: mock.mission,
  settings,
  quality,
  paused: false,
  screen,
};

// scripted events so every feed shows something
const script: [number, () => void][] = [
  [0.3, () => events.emit('radio', { from: 'DARKSTAR', text: 'Viper, Darkstar. Bandits, bandits. BRAA 045/40, angels 20, hot.', team: 'blue' })],
  [0.4, () => events.emit('hud:message', { text: scene === 'damage' ? 'ENGINE FIRE' : 'FIGHTS ON', tone: scene === 'damage' ? 'bad' : 'info', duration: 30 })],
  [0.5, () => {
    const mig = world.aircraft.find((a) => a.type === 'mig29');
    const su = world.aircraft.find((a) => a.type === 'su35');
    if (su) events.emit('destroyed', { entity: su, attackerId: player.id, weapon: 'aim120' });
    const sam = world.sams[0];
    if (sam && scene !== 'ag') events.emit('destroyed', { entity: { ...sam, id: 999, kind: 'sam' } as typeof sam, attackerId: player.id, weapon: 'gbu31' });
    if (mig && (scene === 'gun' || scene === 'lock')) events.emit('damage', { target: mig, amount: 20, attackerId: player.id, weapon: 'gun' });
  }],
  [0.6, () => (scene === 'lock' ? events.emit('lock', { ownerId: player.id, targetId: player.radar.lockedId, locked: true }) : undefined)],
  [0.7, () => (scene === 'damage' ? events.emit('player:hit', { amount: 30, direction: null }) : undefined)],
  [0.8, () => events.emit('weapon:denied', { ownerId: player.id, weapon: player.selectedWeapon, reason: scene === 'ag' ? 'Out of range' : 'No lock' })],
  [0.9, () => {
    const z = params.get('zoom');
    if (z !== null && view === 'cockpit') {
      // simulate a tap on that portal: the cockpit opens it
      const portal = Number(z);
      const pages = portal === 1 ? ['TSD', 'RDR'] : portal === 0 ? ['SMS', 'FUEL', 'ENG', 'ICAWS'] : ['RWR', 'ICAWS', 'FUEL', 'ENG'];
      pcdZoom.openPortal(portal, pages as never, 0);
    }
  }],
  [1.5, () => {
    if (params.get('defeat') !== '1') return;
    for (const m of world.missiles) {
      if (m.targetId !== player.id) continue;
      m.alive = false;
      events.emit('munition:end', { missile: m, position: m.position, reason: 'decoyed', targetId: player.id });
    }
    player.incoming = [];
    player.warnings.delete('missile');
  }],
];

let last = performance.now();
let t = 0;
// ?bench=1: measure HUD / cockpit CPU cost per frame
const bench = params.get('bench') === '1';
let hudMs = 0;
let ckMs = 0;
let frames = 0;
const preroll = Number(params.get('t') ?? 0);
function frame(): void {
  const now = performance.now();
  let dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (preroll > 0 && t === 0) dt = preroll;
  for (const [at, fn] of script) {
    if (t < at && t + dt >= at) fn();
  }
  t += dt;
  mock.tick(dt);
  ctx.dt = dt;
  ctx.time = t;
  placeCamera();
  const t0 = performance.now();
  cockpit.update(ctx, headLocal);
  const t1 = performance.now();
  renderer.render(scene3, camera);
  if (cockpit.visible) cockpit.render(renderer);
  const dc = renderer.info.render.calls;
  const t2 = performance.now();
  hud.update(ctx);
  const t3 = performance.now();
  frames++;
  ckMs += t1 - t0;
  hudMs += t3 - t2;
  const extra = bench ? ` hud=${(hudMs / frames).toFixed(2)}ms ckpt=${(ckMs / frames).toFixed(2)}ms n=${frames}` : '';
  info.textContent = `scene=${scene} view=${view} dc=${dc} tri=${renderer.info.render.triangles}${extra}`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// taps: PCD first, then HUD pick
window.addEventListener('pointerdown', (e) => {
  if (cockpit.visible && cockpit.handleTap(e.clientX / screen.width, e.clientY / screen.height)) return;
  const id = hud.pick(e.clientX, e.clientY);
  if (id != null) world.combat.designate(player, id, world);
});

(window as unknown as { __hudlab: unknown }).__hudlab = { world, player, hud, cockpit, ctx };
