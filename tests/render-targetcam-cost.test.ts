/**
 * Target camera (PiP) cost on low quality, and the reproducible-perf-read test hooks (#66).
 *
 * The PiP used to render the whole scene a second time with the main camera's far plane (about 2× the
 * draw calls whenever a target is designated). On low quality it now gets a short far plane, hides the
 * aircraft beyond it, and leaves out the static scenery detail (EnvironmentApi.targetCamOmit).
 */
import { describe, expect, it } from 'vitest';
import { Group, Vector3, type Scene, type WebGLRenderer } from 'three';
import { QUALITY_PRESETS } from '../src/core/data';
import type { EntityRendererApi } from '../src/core/contracts';
import { TargetCam } from '../src/render/TargetCam';
import { TARGET_CAM_MIN_FAR, framingDistance, targetCamFar } from '../src/render/targetCam/pose';
import { AircraftEntity, SamSiteEntity, type AnyEntity } from '../src/sim/entities';
import type { SimWorld } from '../src/sim/api';
import { testSeed } from '../src/game/testParams';

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

function mig(): AircraftEntity {
  const a = new AircraftEntity(5, 'mig29', 'red');
  a.position.set(4000, 5000, -9000);
  return a;
}

describe('target camera far plane', () => {
  it('low quality stops a few km past the target, well short of the main far plane', () => {
    const range = QUALITY_PRESETS.low.targetCamRange;
    expect(range).toBeGreaterThanOrEqual(2_000);
    expect(range).toBeLessThanOrEqual(8_000);
    const sam = new SamSiteEntity(5, 'sa10', 'red');
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

  it('low quality leaves the static scenery detail out of the PiP', () => {
    expect(QUALITY_PRESETS.low.targetCamScenery).toBe(false);
  });
});

describe('TargetCam.render cost on low quality', () => {
  it('renders with the short far plane, hides aircraft past it and the omitted scenery, then restores them', () => {
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
    expect(seen[0].far).toBeLessThan(MAIN_FAR / 3);
    expect(seen[0].omitted).toEqual([true, true]);
    expect(city.visible).toBe(true);
    expect(lights.visible).toBe(false);
    // aircraft beyond the far plane are hidden for this view (their flames aren't frustum-culled)
    expect(views[0].maxDist).toBe(seen[0].far);
    // the pass's own cost is recorded (renderer.info keeps counting the frame: autoReset off in Game)
    expect(cam.lastStats).toEqual({ calls: 40, triangles: 90_000 });
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
