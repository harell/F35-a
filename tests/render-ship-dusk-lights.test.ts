/**
 * #276 item 2 (R11-8): a cruise liner at its berth was dark at dusk while the CBD around it was lit,
 * because ship lights read EnvironmentApi.isNight. They now come on with the city's lamps
 * (EnvironmentApi.lights): dusk and night, not day or dawn.
 */
import { describe, expect, it } from 'vitest';
import { Mesh, PerspectiveCamera, Scene, Vector3, type InstancedBufferGeometry } from 'three';
import { QUALITY_PRESETS } from '../src/core/data';
import type { EnvironmentApi, FrameContext, MissionRunnerApi } from '../src/core/contracts';
import type { TimeOfDay } from '../src/core/types';
import type { SimWorld } from '../src/sim/api';
import { GroundTargetEntity } from '../src/sim/entities';
import { createEntityRenderer } from '../src/render/EntityRenderer';
import { SHIP_DIMS } from '../src/render/visuals/shipMotion';
import { skyPreset } from '../src/world/sky/presets';

const DEG = Math.PI / 180;

/** A cruise liner moored at a berth (not under way, not at anchor: its cabin and deck lights only). */
function liner(): GroundTargetEntity {
  const e = new GroundTargetEntity(1, 'ship', 'neutral', { name: 'Southern Barnacle', radius: SHIP_DIMS.cruise.length / 2 });
  e.vessel = 'cruise';
  e.position.set(400, 0, -1700);
  e.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), -90 * DEG);
  return e;
}

/** Light sprites drawn in one frame over Auckland at `tod` (the harbour ferries' included). */
function spritesAt(tod: TimeOfDay, ships: GroundTargetEntity[]): number {
  const q = QUALITY_PRESETS.medium;
  const preset = skyPreset('auckland', tod, 'clear', q.drawDistance);
  const scene = new Scene();
  const world = { aircraft: [], missiles: [], sams: [], ground: ships, getEntity: () => null } as unknown as SimWorld;
  const env = { isNight: preset.isNight, lights: preset.lights } as unknown as EnvironmentApi;
  const r = createEntityRenderer(scene, world, env, q);
  const camera = new PerspectiveCamera(60, 2, 1, 50_000);
  camera.position.set(400, 420, -700);
  camera.lookAt(400, 0, -1700);
  camera.updateMatrixWorld();
  r.update({
    dt: 1 / 60,
    time: 100,
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
  } as unknown as FrameContext);
  const sprites = scene.getObjectByName('sprites') as Mesh;
  return (sprites.geometry as InstancedBufferGeometry).instanceCount;
}

describe('ship and ferry lights come on with the city lamps (#276 R11-8)', () => {
  it('the city lamps are off by day and at dawn, on at dusk and night', () => {
    const lights = (tod: TimeOfDay) => skyPreset('auckland', tod, 'clear', 12_000).lights;
    expect(lights('day')).toBe(0);
    expect(lights('dawn')).toBe(0);
    expect(lights('dusk')).toBeGreaterThan(0.01);
    expect(lights('night')).toBe(1);
  });

  it('a moored cruise liner shows its cabin and deck lights at dusk and night, none by day or at dawn', () => {
    const lit = (tod: TimeOfDay) => spritesAt(tod, [liner()]) - spritesAt(tod, []);
    expect(lit('day')).toBe(0);
    expect(lit('dawn')).toBe(0);
    // the liner's deck lights: rows of cabins on both sides and the lido floodlights (over 60, see render-ships)
    expect(lit('dusk')).toBeGreaterThan(60);
    expect(lit('dusk')).toBe(lit('night'));
  });
});
