/**
 * DEV ONLY — render integration sandbox (sandbox.html): the REAL Environment, SimWorld, CombatSystem
 * and AI with this module's EntityRenderer + Effects + CameraRig, without the missions module.
 *
 *   /sandbox.html?view=chase|cockpit|orbit|target|missile|flyby|tactical&theater=desert&tod=day&q=medium&loadout=a2a_beast
 */
import { ACESFilmicToneMapping, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from 'three';
import { EventBus } from '../../core/events';
import { DEFAULT_SETTINGS, DIFFICULTIES, QUALITY_PRESETS } from '../../core/data';
import type { FrameContext } from '../../core/contracts';
import type { CameraMode, LoadoutId, QualityLevel, TheaterId, TimeOfDay } from '../../core/types';
import { createEnvironment } from '../../world/Environment';
import { createSimWorld } from '../../sim/World';
import { createCombatSystem } from '../../sim/weapons/CombatSystem';
import { createAiBrain } from '../../ai';
import { createEntityRenderer } from '../EntityRenderer';
import { createEffects } from '../effects/Effects';
import { createCameraRig } from '../CameraRig';

const q = new URLSearchParams(location.search);
const quality = { ...QUALITY_PRESETS[(q.get('q') ?? 'medium') as QualityLevel] };
const view = (q.get('view') ?? 'chase') as CameraMode;

async function main(): Promise<void> {
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const renderer = new WebGLRenderer({ canvas, antialias: quality.antialias });
  renderer.setPixelRatio(Math.min(quality.pixelRatio, devicePixelRatio));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.shadowMap.enabled = quality.shadows;
  renderer.setSize(innerWidth, innerHeight, false);
  const scene = new Scene();
  const env = await createEnvironment(scene, renderer, {
    theater: (q.get('theater') ?? 'desert') as TheaterId,
    timeOfDay: (q.get('tod') ?? 'day') as TimeOfDay,
    weather: 'scattered',
    seed: 1234,
    features: [],
    pads: [],
    quality,
  });
  const events = new EventBus();
  const combat = createCombatSystem();
  const world = createSimWorld({ terrain: env.terrain, difficulty: DIFFICULTIES.pilot, events, combat });
  const h = (x: number, z: number) => env.terrain.surfaceHeightAt(x, z);
  const player = world.spawnAircraft({ type: 'f35a', team: 'blue', position: new Vector3(0, h(0, 12000) + 1500, 12000), heading: 0, speed: 240, isPlayer: true, loadout: (q.get('loadout') ?? 'a2a_beast') as LoadoutId });
  world.spawnAircraft({ type: 'f35a', team: 'blue', position: new Vector3(60, h(60, 12060) + 1520, 12060), heading: 0, speed: 240, ai: createAiBrain('wingman', { skill: 0.5 }) });
  world.spawnAircraft({ type: 'mig29', team: 'red', position: new Vector3(400, h(400, 3000) + 1600, 3000), heading: Math.PI, speed: 230, ai: createAiBrain('fighter', { skill: 0.5 }) });
  world.spawnAircraft({ type: 'su27', team: 'red', position: new Vector3(-900, h(-900, 2000) + 1700, 2000), heading: Math.PI, speed: 230, ai: createAiBrain('fighter', { skill: 0.5 }) });
  world.spawnSam({ type: 'sa6', team: 'red', position: new Vector3(1800, 0, 6500) });
  world.spawnSam({ type: 'zsu23', team: 'red', position: new Vector3(-600, 0, 8000) });
  world.spawnGround({ type: 'fuel', team: 'red', position: new Vector3(900, 0, 8500) });
  world.spawnGround({ type: 'truck', team: 'red', position: new Vector3(-300, 0, 9000) });

  const entities = createEntityRenderer(scene, world, env, quality);
  const effects = createEffects(scene, world, events, env, quality);
  const rig = createCameraRig(world, entities, { ...DEFAULT_SETTINGS });
  scene.add(rig.camera);
  rig.setMode(view);
  entities.setPlayerVisible(view !== 'cockpit' && view !== 'hud');
  rig.resize(innerWidth, innerHeight);

  const ctx = (dt: number): FrameContext => ({
    dt,
    time: world.time,
    world,
    player: world.player,
    camera: rig.camera,
    viewMode: rig.mode,
    focusId: rig.focusId,
    mission: null,
    settings: DEFAULT_SETTINGS,
    quality,
    paused: false,
    screen: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
  });
  let nextShot = 3;
  const info = document.getElementById('info')!;
  const autopilot = () => {
    // simple autopilot: hold altitude & wings level, fire at the designated target every few seconds
    const p = world.player;
    if (p && q.get('god') === '1') p.health = p.maxHealth = 1e6;
    if (p?.alive) {
      const f = p.flight;
      p.input.throttle = 0.85;
      p.input.pitch = Math.max(-0.4, Math.min(0.4, -f.verticalSpeed * 0.01 + (h(p.position.x, p.position.z) + 1500 - f.altitude) * 0.0008));
      p.input.roll = Math.max(-1, Math.min(1, -f.roll * 1.2));
      if (world.time > nextShot) {
        nextShot = world.time + 4;
        if (p.radar.designatedId == null) combat.cycleTarget(p, world);
        combat.fire(p, world);
        p.input.flare = !p.input.flare;
      }
    }
  };
  // fast-forward: simulate `ff` seconds before the first rendered frame
  const ff = Number(q.get('ff') ?? 0);
  for (let s = 0; s < ff * 60; s++) {
    autopilot();
    world.step(1 / 60);
    if (s % 6 === 5) {
      const c = ctx(0.1);
      entities.update(c);
      rig.update(c);
      effects.update(c);
    }
  }
  const steps = Number(q.get('steps') ?? 2);
  renderer.setAnimationLoop(() => {
    autopilot();
    for (let i = 0; i < steps; i++) world.step(1 / 60);
    const c = ctx(steps / 60);
    env.update(c);
    entities.update(c);
    rig.update(c);
    effects.update(c);
    renderer.render(scene, rig.camera);
    const r = renderer.info.render;
    const st = (effects as unknown as { stats?: () => string }).stats?.() ?? '';
    info.textContent = `view=${rig.mode} t=${world.time.toFixed(1)} calls=${r.calls} tris=${r.triangles} ac=${world.aircraft.length} ms=${world.missiles.length} ${st}`;
  });
  (window as unknown as { __sb: unknown }).__sb = { world, rig, events };
}
void main();
