/**
 * Playtest r2 F10: explosions on the sea drew a flat translucent disc (the foam ring, and an AD boat's
 * kill laid the land's dust shockwave ring) that read as a sticker on the water. On the water a burst
 * now throws a ring of white spray particles instead: no flat ring pulse; on land the dust ring stays.
 */
import { describe, expect, it } from 'vitest';
import { type Mesh, type Object3D, PerspectiveCamera, Scene, Vector3 } from 'three';
import { EventBus } from '../src/core/events';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../src/core/data';
import type { EnvironmentApi, FrameContext } from '../src/core/contracts';
import type { SimWorld, TerrainQuery } from '../src/sim/api';
import { createEffects } from '../src/render/effects/Effects';
import { SamSiteEntity } from '../src/sim/entities';
import { v3 } from './combat-helpers';
import { makeWorld } from './sim-fakes';

/** Sea west of x = 0, land east of it. */
const terrain: TerrainQuery = {
  size: 80_000,
  heightAt: () => 0,
  surfaceHeightAt: () => 0,
  isWater: (x: number) => x < 0,
  lineOfSight: () => true,
  raycast: () => -1,
};

function rig() {
  const events = new EventBus();
  const world = {
    events,
    terrain,
    time: 0,
    aircraft: [],
    missiles: [],
    sams: [],
    ground: [],
    decoys: [],
    landmarks: [],
    projectiles: [],
    player: null,
    getEntity: () => null,
  } as unknown as SimWorld & { time: number };
  const scene = new Scene();
  const env = { terrain, sunDirection: new Vector3(0, 1, 0), isNight: false, fogColor: 0 } as unknown as EnvironmentApi;
  const fx = createEffects(scene, world, events, env, { ...QUALITY_PRESETS.medium });
  const camera = new PerspectiveCamera(60, 2, 0.5, 60_000);
  camera.position.set(0, 300, 2000);
  camera.updateMatrixWorld();
  const ctx = {
    dt: 1 / 30,
    time: 0,
    world,
    player: null,
    camera,
    viewMode: 'chase',
    focusId: null,
    mission: null,
    settings: { ...DEFAULT_SETTINGS },
    quality: { ...QUALITY_PRESETS.medium },
    paused: false,
    screen: { width: 844, height: 390, dpr: 1, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
  } as unknown as FrameContext;
  const pulses = scene.getObjectByName('pulses') as Object3D;
  /** Flat ring pulses showing now. */
  const rings = () => pulses.children.filter((m) => m.visible && (m as Mesh).geometry.type === 'RingGeometry').length;
  const step = (seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / 30) {
      world.time += 1 / 30;
      ctx.time = world.time;
      fx.update(ctx);
    }
  };
  return { events, world, rings, step };
}

describe('explosions on the sea (r2 F10)', () => {
  it('a burst on the water lays no flat ring; one on land keeps its dust ring', () => {
    const r = rig();
    r.events.emit('explosion', { position: v3(-500, 1, 0), size: 'large', surface: 'water' });
    expect(r.rings()).toBe(0);
    r.events.emit('explosion', { position: v3(500, 1, 0), size: 'large', surface: 'ground' });
    expect(r.rings()).toBe(1);
  });

  it('a boat killed on the water: its secondary blasts go off in the water, no dust ring', () => {
    const r = rig();
    const boat = new SamSiteEntity(7, 'ad_boat', 'red', { name: 'AD boat' });
    boat.position.set(-800, 0, 0);
    boat.alive = false;
    r.events.emit('destroyed', { entity: boat, attackerId: 1, weapon: 'gbu53' });
    let most = 0;
    for (let i = 0; i < 12; i++) {
      r.step(0.5);
      most = Math.max(most, r.rings());
    }
    expect(most).toBe(0);
  });

  it('the sim blows an AD boat up on the water (spray), not on the ground (dust ring)', () => {
    const tw = makeWorld('pilot', terrain);
    const blasts: { surface: string }[] = [];
    tw.events.on('explosion', (e) => blasts.push({ surface: e.surface }));
    const boat = tw.world.spawnSam({ type: 'ad_boat', team: 'red', position: new Vector3(-2000, 0, -5000) });
    const site = tw.world.spawnSam({ type: 'sa6', team: 'red', position: new Vector3(2000, 0, -5000) });
    tw.world.applyDamage(boat, 1000, null, 'gbu53');
    tw.world.applyDamage(site, 1000, null, 'gbu53');
    expect(boat.alive || site.alive).toBe(false);
    expect(blasts.map((b) => b.surface)).toEqual(['water', 'ground']);
  });
});
