/**
 * Target camera (PiP) cost on low quality, and the reproducible-perf-read test hooks (#66).
 *
 * The PiP used to render the whole scene a second time with the main camera's far plane (about 2× the
 * draw calls whenever a target is designated). On low quality it now gets a short far plane, hides the
 * aircraft beyond it, and leaves out the static scenery detail (EnvironmentApi.targetCamOmit).
 */
import { describe, expect, it } from 'vitest';
import { Group, PerspectiveCamera, Scene, Vector3, type WebGLRenderer } from 'three';
import { QUALITY_PRESETS } from '../src/core/data';
import type { EntityRendererApi, EnvironmentApi, FrameContext, MissionRunnerApi } from '../src/core/contracts';
import { PIP_GLOW_GAIN, TargetCam, targetCamOmitFor } from '../src/render/TargetCam';
import { glowGain } from '../src/render/effects/GpuParticles';
import { createEntityRenderer } from '../src/render/EntityRenderer';
import { TARGET_CAM_GROUND_K, TARGET_CAM_MIN_FAR, framingDistance, targetCamFar, targetCamGroundDepth } from '../src/render/targetCam/pose';
import { AircraftEntity, SamSiteEntity, type AnyEntity } from '../src/sim/entities';
import type { SimWorld } from '../src/sim/api';
import { autopilotBrainOpts, frameAccumulator, frameTakesControls, testSeed } from '../src/game/testParams';

/** A renderer stand-in that records what the PiP pass would draw with. */
function fakeRenderer(callsPerPass = 40) {
  const seen: { far: number; omitted: boolean[] }[] = [];
  let omit: Group[] = [];
  const r = {
    autoClear: false,
    shadowMap: { autoUpdate: true },
    info: { autoReset: false, render: { calls: 60, triangles: 180_000 } },
    getSize: (v: { x: number; y: number; set: (x: number, y: number) => unknown }) => v.set(844, 390),
    setScissorTest: () => undefined,
    setScissor: () => undefined,
    setViewport: () => undefined,
    render: (_scene: Scene, cam: { far: number }) => {
      seen.push({ far: cam.far, omitted: omit.map((o) => !o.visible) });
      r.info.render.calls += callsPerPass;
      r.info.render.triangles += 90_000;
    },
  };
  return { renderer: r as unknown as WebGLRenderer, seen, watch: (o: Group[]) => (omit = o) };
}

function fakeWorld(target: AnyEntity) {
  return {
    time: 12,
    getEntity: (id: number | null) => (id === target.id ? target : null),
    terrain: { surfaceHeightAt: () => 0, isWater: () => false },
  } as unknown as SimWorld;
}

function fakeEntities() {
  const views: { camPos: Vector3; maxDist: number | undefined }[] = [];
  const api = { prepareView: (camPos: Vector3, maxDist?: number) => views.push({ camPos: camPos.clone(), maxDist }) };
  return { entities: api as unknown as EntityRendererApi, views };
}

const rect = { targetId: 5, vx: 600, vy: 40, vw: 200, vh: 112, h: 112 };
const MAIN_FAR = QUALITY_PRESETS.low.drawDistance;

/** A MiG-29 at `alt` m (low by default: there the far plane is the target range, not the ground's depth). */
function mig(alt = 600): AircraftEntity {
  const a = new AircraftEntity(5, 'mig29', 'red');
  a.position.set(4000, alt, -9000);
  return a;
}

/**
 * View depth (m) at which the bottom-centre ray of the PiP camera meets sea level, worked out from the
 * camera itself (Infinity if it doesn't point below the horizon).
 */
function bottomGroundDepth(cam: PerspectiveCamera): number {
  const dir = new Vector3(0, -Math.tan((cam.fov * Math.PI) / 360), -1).applyQuaternion(cam.quaternion);
  return dir.y < 0 ? cam.position.y / -dir.y : Infinity; // dir has view depth 1 per unit
}

describe('target camera far plane', () => {
  it('low quality stops a few km past the target, well short of the main far plane', () => {
    const range = QUALITY_PRESETS.low.targetCamRange;
    expect(range).toBeGreaterThanOrEqual(2_000);
    expect(range).toBeLessThanOrEqual(8_000);
    const sam = new SamSiteEntity(5, 'sa6', 'red');
    for (const t of [mig(), sam]) {
      const d = framingDistance(t);
      const far = targetCamFar(MAIN_FAR, d, range);
      expect(far).toBeGreaterThan(d); // the target itself is always inside
      expect(far).toBeLessThanOrEqual(Math.max(TARGET_CAM_MIN_FAR, d + range));
      expect(far).toBeLessThan(MAIN_FAR / 3);
    }
  });

  it('medium and high (range 0) keep the main camera far plane', () => {
    for (const q of [QUALITY_PRESETS.medium, QUALITY_PRESETS.high]) {
      expect(q.targetCamRange).toBe(0);
      expect(q.targetCamScenery).toBe(true);
      expect(targetCamFar(q.drawDistance, 30, q.targetCamRange)).toBe(q.drawDistance);
    }
    // never longer than the main camera's far plane (a tactical-view far, a tiny draw distance)
    expect(targetCamFar(1_000, 30, 4_000)).toBe(1_000);
  });

  it('the depth of the nearest ground in the frame grows with height and is infinite at the horizon', () => {
    const half = (16 * Math.PI) / 180;
    expect(targetCamGroundDepth(5500, 0.17, half)).toBeCloseTo((5500 / Math.sin(0.17 + half)) * Math.cos(half), 6);
    expect(targetCamGroundDepth(8000, 0.17, half)).toBeGreaterThan(targetCamGroundDepth(4000, 0.17, half));
    expect(targetCamGroundDepth(3000, -half, half)).toBe(Infinity); // the bottom edge on the horizon
    expect(targetCamGroundDepth(-5, 0.17, half)).toBe(0);
    // the short far plane stretches to keep that ground at half of it, never past the main far plane
    expect(targetCamFar(MAIN_FAR, 30, 8_000, 6_000)).toBe(12_000);
    expect(targetCamFar(MAIN_FAR, 30, 8_000, 1_000)).toBe(8_030);
    expect(targetCamFar(MAIN_FAR, 30, 8_000, Infinity)).toBe(MAIN_FAR);
    expect(targetCamFar(MAIN_FAR, 30, 0, 6_000)).toBe(MAIN_FAR);
  });
});

describe('which objects the PiP leaves out', () => {
  it('low quality leaves out the environment targetCamOmit list; medium and high leave out nothing', () => {
    const omit = [new Group(), new Group()];
    expect(QUALITY_PRESETS.low.targetCamScenery).toBe(false);
    expect(targetCamOmitFor(QUALITY_PRESETS.low, omit)).toBe(omit);
    expect(targetCamOmitFor(QUALITY_PRESETS.low, undefined)).toEqual([]);
    expect(targetCamOmitFor(QUALITY_PRESETS.medium, omit)).toEqual([]);
    expect(targetCamOmitFor(QUALITY_PRESETS.high, omit)).toEqual([]);
  });
});

describe('TargetCam.render cost on low quality', () => {
  it('renders a low target with the short far plane, hides aircraft past it and the omitted scenery, then restores them', () => {
    const { renderer, seen, watch } = fakeRenderer();
    const { entities, views } = fakeEntities();
    const cam = new TargetCam(fakeWorld(mig()), entities);
    const city = new Group();
    const lights = new Group();
    lights.visible = false; // already hidden (e.g. day): must stay hidden afterwards
    watch([city, lights]);
    const q = QUALITY_PRESETS.low;
    expect(cam.render(renderer, {} as Scene, rect, MAIN_FAR, q.targetCamRange, [city, lights])).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].far).toBeCloseTo(framingDistance(mig()) + q.targetCamRange, 0);
    expect(seen[0].omitted).toEqual([true, true]);
    expect(city.visible).toBe(true);
    expect(lights.visible).toBe(false);
    // aircraft beyond the far plane are hidden for this view (their flames aren't frustum-culled)
    expect(views[0].maxDist).toBe(seen[0].far);
    // the pass's own cost is recorded (renderer.info keeps counting the frame: autoReset off in Game)
    expect(cam.lastStats).toEqual({ calls: 40, triangles: 90_000 });
  });

  it('a high target keeps the ground in the frame: the far plane reaches twice its depth, capped at the main far plane', () => {
    for (const alt of [3_000, 4_000, 5_500, 8_000]) {
      const { renderer, seen } = fakeRenderer();
      const { entities, views } = fakeEntities();
      const cam = new TargetCam(fakeWorld(mig(alt)), entities);
      cam.render(renderer, {} as Scene, rect, MAIN_FAR, QUALITY_PRESETS.low.targetCamRange);
      const far = seen[0].far;
      const ground = bottomGroundDepth(cam.camera);
      expect(ground, `${alt} m`).toBeLessThan(far); // some ground is inside the far plane
      expect(far, `${alt} m`).toBeCloseTo(Math.min(MAIN_FAR, TARGET_CAM_GROUND_K * ground), -1);
      expect(far, `${alt} m`).toBeLessThanOrEqual(MAIN_FAR);
      expect(views[0].maxDist).toBe(far);
    }
  });

  it('full quality: the main far plane, nothing hidden, no distance cut', () => {
    const { renderer, seen, watch } = fakeRenderer();
    const { entities, views } = fakeEntities();
    const cam = new TargetCam(fakeWorld(mig()), entities);
    const city = new Group();
    watch([city]);
    const q = QUALITY_PRESETS.high;
    cam.render(renderer, {} as Scene, rect, q.drawDistance, q.targetCamRange);
    expect(seen[0].far).toBe(q.drawDistance);
    expect(seen[0].omitted).toEqual([false]);
    expect(views[0].maxDist).toBeUndefined();
  });

  it('records no cost when nothing is drawn', () => {
    const { renderer, seen } = fakeRenderer();
    const cam = new TargetCam(fakeWorld(mig()), fakeEntities().entities);
    cam.render(renderer, {} as Scene, rect, MAIN_FAR, 4_000);
    expect(cam.render(renderer, {} as Scene, { ...rect, targetId: null }, MAIN_FAR, 4_000)).toBe(false);
    expect(seen).toHaveLength(1);
    expect(cam.lastStats).toEqual({ calls: 0, triangles: 0 });
    expect(cam.lastTargetId).toBeNull();
  });
});

describe('TargetCam pass: the additive glow (#282 R31-10)', () => {
  it('draws fire and glow sprites dimmed in the PiP, and restores the main view brightness after', () => {
    const { renderer } = fakeRenderer();
    const gains: number[] = [];
    const draw = renderer.render.bind(renderer);
    renderer.render = (scene, cam) => {
      gains.push(glowGain.value);
      draw(scene, cam);
    };
    const cam = new TargetCam(fakeWorld(mig()), fakeEntities().entities);
    expect(PIP_GLOW_GAIN).toBeGreaterThan(0.2);
    expect(PIP_GLOW_GAIN).toBeLessThan(0.6);
    expect(cam.render(renderer, {} as Scene, rect, MAIN_FAR)).toBe(true);
    expect(gains).toEqual([PIP_GLOW_GAIN]);
    expect(glowGain.value).toBe(1);
    // restored even when the draw throws
    renderer.render = () => {
      throw new Error('lost context');
    };
    expect(() => cam.render(renderer, {} as Scene, rect, MAIN_FAR)).toThrow('lost context');
    expect(glowGain.value).toBe(1);
  });
});

describe('test hook ?seed=', () => {
  const p = (q: string) => new URLSearchParams(q);
  it('reads an unsigned integer seed, only with the test hooks on', () => {
    expect(testSeed(p('mission=c04&seed=7'), true)).toBe(7);
    expect(testSeed(p('seed=0'), true)).toBe(0);
    expect(testSeed(p('seed=4294967295'), true)).toBe(4294967295);
    expect(testSeed(p('mission=c04&seed=7'), false)).toBeNull();
  });

  it('ignores a missing or malformed seed (the sortie rolls its own)', () => {
    for (const q of ['', 'seed=', 'seed=abc', 'seed=-3', 'seed=1.5', 'seed=4294967296', 'seed=99999999999']) {
      expect(testSeed(p(q), true), q).toBeNull();
    }
  });
});

describe('test hooks: autopilot seed and the held clock', () => {
  it('the autopilot brain takes the ?seed= seed, so a mission reruns the same after other missions in the page', () => {
    expect(autopilotBrainOpts(7)).toEqual({ skill: 0.9, seed: 7 });
    expect(autopilotBrainOpts(0)).toEqual({ skill: 0.9, seed: 0 });
    expect(autopilotBrainOpts(null)).toEqual({ skill: 0.9 });
  });

  it('a held clock never accumulates sim time and the frame loop leaves the controls alone', () => {
    expect(frameAccumulator(0.01, 0.02, false)).toBeCloseTo(0.03, 9);
    expect(frameAccumulator(0.01, 0.02, true)).toBe(0);
    expect(frameTakesControls(false, false)).toBe(true);
    expect(frameTakesControls(true, false)).toBe(false);
    expect(frameTakesControls(false, true)).toBe(false);
  });
});

/* ───────────── EntityRenderer.prepareView: aircraft past the PiP far plane are hidden for that view ───────────── */

describe('EntityRenderer.prepareView distance cut', () => {
  function setup() {
    const scene = new Scene();
    const near = new AircraftEntity(1, 'mig29', 'red');
    near.position.set(0, 3000, -3000);
    const edge = new AircraftEntity(2, 'su27', 'red');
    edge.position.set(0, 3000, -5150); // inside the +200 m margin past a 5 km far plane
    const far = new AircraftEntity(3, 'mig29', 'red');
    far.position.set(0, 3000, -7_500); // past it, but inside the low preset's 9 km aircraft range
    const aircraft = [near, edge, far];
    const world = { aircraft, missiles: [], sams: [], ground: [], getEntity: (id: number) => aircraft.find((a) => a.id === id) ?? null } as unknown as SimWorld;
    const env = { isNight: false } as unknown as EnvironmentApi;
    const q = QUALITY_PRESETS.low;
    const r = createEntityRenderer(scene, world, env, q);
    const camera = new PerspectiveCamera(60, 2, 1, 50_000);
    camera.position.set(0, 3000, 0);
    camera.lookAt(0, 3000, -1);
    camera.updateMatrixWorld();
    const ctx = {
      dt: 1 / 60,
      time: 10,
      world,
      player: null,
      camera,
      viewMode: 'chase',
      focusId: null,
      mission: { def: { theater: 'auckland' } } as unknown as MissionRunnerApi,
      settings: {},
      quality: q,
      paused: false,
      screen: { width: 844, height: 390, dpr: 2, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
    } as unknown as FrameContext;
    return { r, ctx, ids: aircraft.map((a) => a.id) };
  }

  it('hides aircraft past maxDist (+200 m) for the PiP view, and update() shows them again', () => {
    const { r, ctx, ids } = setup();
    const visible = () => ids.map((id) => r.getObject(id)!.visible);
    r.update(ctx);
    expect(visible()).toEqual([true, true, true]);
    const pipCam = new Vector3(0, 3000, 0);
    r.prepareView!(pipCam, 5_000);
    expect(visible()).toEqual([true, true, false]);
    // no maxDist (medium / high): nothing is cut by distance
    r.prepareView!(pipCam);
    expect(visible()).toEqual([true, true, true]);
    r.prepareView!(pipCam, 5_000);
    r.update(ctx); // the next frame's main view
    expect(visible()).toEqual([true, true, true]);
    r.dispose();
  });
});
