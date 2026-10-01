/**
 * WORLD lab (dev only, labs/world-lab.html): renders the environment alone with a free-flying camera.
 *
 *   labs/world-lab.html?theater=auckland&tod=day&weather=scattered&quality=medium&seed=1234
 *                 &cam=x,y,z&look=headingDeg,pitchDeg
 *
 * Keys: WASD/QE fly, arrows look, Shift = fast. `window.__lab` exposes setCamera/stats for
 * Playwright screenshots.
 */
import { ACESFilmicToneMapping, PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from 'three';
import { createEnvironment, type EnvironmentInternals } from '../Environment';
import { QUALITY_PRESETS } from '../../core/data';
import type { FrameContext, SceneryFeature } from '../../core/contracts';
import type { QualityLevel, TheaterId, TimeOfDay, Weather } from '../../core/types';
import { airfieldFeature } from '../../core/airfields';
import { dirFromHeadingPitch } from '../../core/math';

const params = new URLSearchParams(location.search);
const theater = (params.get('theater') ?? 'auckland') as TheaterId;
const tod = (params.get('tod') ?? 'day') as TimeOfDay;
const weather = (params.get('weather') ?? 'scattered') as Weather;
const level = (params.get('quality') ?? 'medium') as QualityLevel;
const seed = Number(params.get('seed') ?? 1234);
const quality = { ...QUALITY_PRESETS[level] };

const info = document.getElementById('info')!;
const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: quality.antialias, powerPreference: 'high-performance', stencil: false });
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = quality.shadows;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.pixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new Scene();
const camera = new PerspectiveCamera(Number(params.get('fov') ?? 60), window.innerWidth / window.innerHeight, 1.5, quality.drawDistance);
scene.add(camera);

function features(): { features: SceneryFeature[]; pads: { x: number; z: number; radius: number }[] } {
  if (theater === 'auckland') {
    return {
      features: [
        airfieldFeature('whenuapai'), // FEATURES.whenuapai (the real layout comes from OSM)
        { type: 'airbase', x: 26_900, z: -6600, rotation: 90, size: 0.8 }, // campaign Waiheke strip (FEATURES.waihekeStrip)
        { type: 'industrial', x: 13_300, z: -9800, size: 0.6 },
      ],
      pads: [
        { x: 12_900, z: -8600, radius: 150 },
        { x: 8200, z: -5600, radius: 110 },
        { x: 24_000, z: -5500, radius: 120 },
      ],
    };
  }
  return {
    features: [
      { type: 'airbase', x: -8000, z: 14_000, rotation: 30 },
      { type: 'city', x: 6000, z: -4000 },
      { type: 'town', x: -14_000, z: -12_000 },
      { type: 'village', x: 18_000, z: 16_000 },
      { type: 'industrial', x: 12_000, z: 6000 },
      { type: 'port', x: 22_000, z: -2000 },
      { type: 'forest', x: -20_000, z: 5000 },
      { type: 'farmland', x: -2000, z: 24_000 },
    ],
    pads: [
      { x: 2000, z: -20_000, radius: 120 },
      { x: -16_000, z: -2000, radius: 150 },
    ],
  };
}

const state = {
  pos: new Vector3(0, 900, 9000),
  heading: 0,
  pitch: -8,
  ready: false,
  frames: 0,
};
const cam = params.get('cam')?.split(',').map(Number);
if (cam && cam.length === 3) state.pos.set(cam[0], cam[1], cam[2]);
const look = params.get('look')?.split(',').map(Number);
if (look && look.length === 2) {
  state.heading = look[0];
  state.pitch = look[1];
}

let env: EnvironmentInternals | null = null;
const keys = new Set<string>();
window.addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()));
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

const dir = new Vector3();
function applyCamera(): void {
  const DEG = Math.PI / 180;
  dirFromHeadingPitch(state.heading * DEG, state.pitch * DEG, dir);
  camera.position.copy(state.pos);
  camera.lookAt(dir.add(state.pos));
  camera.updateMatrixWorld();
}

const ctx = (dt: number): FrameContext =>
  ({
    dt,
    time: 0,
    world: null,
    player: null,
    camera,
    viewMode: 'chase',
    focusId: null,
    mission: null,
    settings: {},
    quality,
    paused: false,
    screen: { width: window.innerWidth, height: window.innerHeight, dpr: 1, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
  }) as unknown as FrameContext;

let last = performance.now();
function frame(): void {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const speed = (keys.has('shift') ? 2500 : 300) * dt;
  const DEG = Math.PI / 180;
  if (keys.has('arrowleft')) state.heading -= 60 * dt;
  if (keys.has('arrowright')) state.heading += 60 * dt;
  if (keys.has('arrowup')) state.pitch = Math.min(89, state.pitch + 40 * dt);
  if (keys.has('arrowdown')) state.pitch = Math.max(-89, state.pitch - 40 * dt);
  const fwd = dirFromHeadingPitch(state.heading * DEG, state.pitch * DEG, new Vector3());
  const right = new Vector3(Math.cos(state.heading * DEG), 0, Math.sin(state.heading * DEG));
  if (keys.has('w')) state.pos.addScaledVector(fwd, speed);
  if (keys.has('s')) state.pos.addScaledVector(fwd, -speed);
  if (keys.has('d')) state.pos.addScaledVector(right, speed);
  if (keys.has('a')) state.pos.addScaledVector(right, -speed);
  if (keys.has('e')) state.pos.y += speed;
  if (keys.has('q')) state.pos.y -= speed;
  applyCamera();
  if (env) {
    env.update(ctx(dt));
    renderer.render(scene, camera);
    state.frames++;
    if (state.frames % 20 === 1) {
      const i = renderer.info.render;
      const g = env.terrain.heightAt(state.pos.x, state.pos.z);
      const st = env.stats();
      info.textContent = `${theater} ${tod} ${weather} ${level} | ${i.calls} dc ${(i.triangles / 1000).toFixed(0)}k tri | patches ${st.patches} inst ${st.instances} | gen ${st.genMs.toFixed(0)} ms | pos ${state.pos.x.toFixed(0)},${state.pos.y.toFixed(0)},${state.pos.z.toFixed(0)} agl ${(state.pos.y - g).toFixed(0)}`;
    }
  }
  requestAnimationFrame(frame);
}

const f = features();
const t0 = performance.now();
createEnvironment(scene, renderer, {
  theater,
  timeOfDay: tod,
  weather,
  seed,
  features: f.features,
  pads: f.pads,
  quality,
  onProgress: (p, label) => (info.textContent = `${label} ${(p * 100).toFixed(0)}%`),
}).then((e) => {
  env = e as EnvironmentInternals;
  state.ready = true;
  console.log(`[lab] environment ready in ${(performance.now() - t0).toFixed(0)} ms`);
});
requestAnimationFrame(frame);

(window as unknown as { __lab: unknown }).__lab = {
  scene,
  /** Dispose the environment and report what is left on the GPU (leak check). */
  disposeCheck() {
    const before = { ...renderer.info.memory };
    env?.dispose();
    env = null;
    renderer.render(scene, camera);
    return { before, after: { ...renderer.info.memory }, children: scene.children.map((c) => c.name || c.type) };
  },
  get ready() {
    return state.ready;
  },
  setCamera(x: number, y: number, z: number, heading: number, pitch: number, agl = false) {
    state.pos.set(x, y, z);
    if (agl && env) state.pos.y = y + env.terrain.surfaceHeightAt(x, z);
    state.heading = heading;
    state.pitch = pitch;
  },
  stats() {
    const i = renderer.info.render;
    return { calls: i.calls, triangles: i.triangles, ...(env?.stats() ?? {}), frames: state.frames };
  },
  height(x: number, z: number) {
    return env?.terrain.heightAt(x, z);
  },
};
