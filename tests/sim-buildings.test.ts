/**
 * CBD skyscrapers as obstacles (#128): the segment-vs-prism test, the collision (the jet is destroyed,
 * the building collapses, the player's down reason), the reset in a new world, and g01's swarm
 * clearing every roof on its way to the Sky Tower.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { DIFFICULTIES } from '../src/core/data';
import { EventBus, type GameEventMap } from '../src/core/events';
import type { Difficulty } from '../src/core/types';
import { G01, G01_SWARM } from '../src/missions/content/irgc';
import { REASONS } from '../src/missions/runtime/reasons';
import { BuildingIndex, buildBuildingGeometry, buildingGeometry, prismSegmentHit, SKYSCRAPER_MIN_HEIGHT, type SolidPrism } from '../src/sim/buildings';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import type { AircraftEntity as AircraftEntityT } from '../src/sim/entities';
import { aucklandBuildings } from '../src/world/scenery/aucklandBuildings';
import { flatLand, harness } from './missions-helpers';

const flat = flatLand(0);

/** A 10 m square tower, 100 m tall, centred on (0, 0). */
const TOWER: SolidPrism = { ring: new Float32Array([-5, -5, 5, -5, 5, 5, -5, 5]), y0: 0, y1: 100, minX: -5, maxX: 5, minZ: -5, maxZ: 5 };

describe('prismSegmentHit', () => {
  it('hits a segment that crosses the footprint below the roof, at the wall', () => {
    const s = prismSegmentHit(TOWER, new Vector3(-20, 50, 0), new Vector3(20, 50, 0));
    expect(s).toBeCloseTo(15 / 40, 5);
  });
  it('misses above the roof and beside the footprint', () => {
    expect(prismSegmentHit(TOWER, new Vector3(-20, 101, 0), new Vector3(20, 101, 0))).toBe(-1);
    expect(prismSegmentHit(TOWER, new Vector3(-20, 50, 6), new Vector3(20, 50, 6))).toBe(-1);
  });
  it('a fast jet does not tunnel through a thin tower in one step (both ends outside)', () => {
    // 600 m/s at 60 Hz is 10 m a step; a 1 m/s-wide check would miss, the edge test can't
    const s = prismSegmentHit(TOWER, new Vector3(-6, 50, 0.2), new Vector3(6, 50, 0.2));
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(0.1);
  });
  it('a dive into the roof hits at the roof height', () => {
    const s = prismSegmentHit(TOWER, new Vector3(0, 120, 0), new Vector3(0, 80, 0));
    expect(s).toBeCloseTo(0.5, 5);
  });
  it('starts inside → 0', () => {
    expect(prismSegmentHit(TOWER, new Vector3(0, 50, 0), new Vector3(1, 50, 0))).toBe(0);
  });
});

/** The tallest CBD building and a point on its tallest prism's footprint. */
function tallest() {
  const geo = buildingGeometry(flat)!;
  let best = geo.buildings[0];
  for (const b of geo.buildings) if (b.top > best.top) best = b;
  const p = best.prisms.reduce((a, b) => (b.y1 > a.y1 ? b : a));
  return { geo, b: best, p };
}

/** A jet flying east at 250 m/s from `at`. */
function spawnJet(world: ReturnType<typeof createSimWorld>, isPlayer: boolean, at: Vector3): AircraftEntityT {
  return world.spawnAircraft({ type: 'f35a', team: 'blue', position: at, heading: Math.PI / 2, speed: 250, isPlayer, fuel: 0.8 });
}

describe('the CBD skyscraper index', () => {
  it(`holds the CBD buildings ${SKYSCRAPER_MIN_HEIGHT} m and taller, and the tallest roofs are about 180 m`, () => {
    const all = aucklandBuildings()!;
    const geo = buildBuildingGeometry(() => 0)!;
    expect(geo.buildings.length).toBeGreaterThan(20);
    expect(geo.buildings.length).toBeLessThan(all.length);
    expect(geo.maxTop).toBeGreaterThan(150);
    expect(geo.maxTop).toBeLessThan(260);
  });

  it('flying into a tower destroys the jet, collapses the building, and the down reason is building', () => {
    const events = new EventBus();
    const world = createSimWorld({ terrain: flat, difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(1) });
    const { b, p } = tallest();
    const cx = (p.minX + p.maxX) / 2;
    const cz = (p.minZ + p.maxZ) / 2;
    // just under the tallest roof (clear of the lower neighbours), 250 m/s east at the tower from 40 m west of its wall
    const y = b.top - 5;
    const jet = spawnJet(world, true, new Vector3(p.minX - 40, y, cz));
    const downs: GameEventMap['player:down'][] = [];
    const falls: GameEventMap['building:collapsed'][] = [];
    events.on('player:down', (e) => downs.push(e));
    events.on('building:collapsed', (e) => falls.push(e));
    for (let i = 0; i < 120 && jet.alive; i++) world.step(1 / 60);
    expect(jet.alive).toBe(false);
    expect(downs.map((d) => d.reason)).toEqual(['building']);
    expect(falls).toHaveLength(1);
    expect(falls[0].isPlayer).toBe(true);
    expect(falls[0].building).toBe(b.id);
    expect(world.buildings!.collapsed.size).toBe(1);
    // the wreck stops at the wall, not inside or past the tower
    expect(jet.position.x).toBeLessThan(cx);
    expect(REASONS.building).toBe('Crashed into a building');

    // a second jet down the same line now flies through the collapsed building's air
    const jet2 = spawnJet(world, false, new Vector3(p.minX - 40, y, cz));
    for (let i = 0; i < 60; i++) world.step(1 / 60);
    // (it may meet another tower further on; it must not meet this one)
    expect(falls.filter((f) => f.building === b.id)).toHaveLength(1);
    void jet2;

    // reset: standing again
    world.dispose();
    expect(world.buildings!.collapsed.size).toBe(0);
  });

  it('a new mission world starts with every building standing', () => {
    const w1 = createSimWorld({ terrain: flat, difficulty: DIFFICULTIES.pilot, events: new EventBus(), combat: createCombatSystemSeeded(1) });
    w1.buildings!.collapsed.add(0);
    const w2 = createSimWorld({ terrain: flat, difficulty: DIFFICULTIES.pilot, events: new EventBus(), combat: createCombatSystemSeeded(1) });
    expect(w2.buildings!.collapsed.size).toBe(0);
  });

  it('the mission fails with "Crashed into a building" when the player flies into one', () => {
    const h = harness(G01, 'pilot');
    const { b, p } = tallest();
    const cx = (p.minX + p.maxX) / 2;
    const cz = (p.minZ + p.maxZ) / 2;
    const player = h.world.player!;
    player.position.set(cx - 200, b.top / 2, cz);
    player.velocity.set(250, 0, 0);
    h.run(3, () => h.runner.state !== 'running');
    expect(h.runner.state).toBe('failed');
    expect(h.of('mission:end')[0]?.reason).toBe(REASONS.building);
  });
});

describe('g01: the Shaheds only ever hit the Sky Tower (#128)', () => {
  const DIFFS: Difficulty[] = ['recruit', 'pilot', 'veteran'];
  for (const d of DIFFS) {
    it(`${d}: an untouched swarm collapses no CBD building and still hits the tower`, () => {
      const h = harness(G01, d);
      const index = h.world.buildings as BuildingIndex;
      expect(index).toBeTruthy();
      const impacts: GameEventMap['drone:impact'][] = [];
      h.events.on('drone:impact', (e) => impacts.push(e));
      // the player's jet sits far out of the way (it would otherwise be free to hit something)
      const player = h.world.player!;
      player.position.set(-30000, 3000, -30000);
      h.run(600, () => h.runner.state !== 'running' && impacts.length > 0);
      expect(h.of('building:collapsed')).toHaveLength(0);
      expect(index.collapsed.size).toBe(0);
      expect(impacts.length).toBeGreaterThan(0);
    });
  }

  it(`every drone's path clears every CBD roof by ${G01_SWARM.altitude - 180 > 0 ? 'a margin' : '—'}`, () => {
    // sample each live drone every step: its height above the tallest roof under it (or within 15 m)
    const h = harness(G01, 'recruit');
    const geo = h.world.buildings!.geo;
    const player = h.world.player!;
    player.position.set(-30000, 3000, -30000);
    let minClear = Infinity;
    const tmpA = new Vector3();
    const tmpB = new Vector3();
    h.run(600, () => {
      for (const ac of h.world.aircraft) {
        if (!ac.oneWay || !ac.alive) continue;
        tmpA.set(ac.position.x, ac.position.y, ac.position.z);
        for (const bld of geo.buildings) {
          for (const p of bld.prisms) {
            if (tmpA.x < p.minX - 15 || tmpA.x > p.maxX + 15 || tmpA.z < p.minZ - 15 || tmpA.z > p.maxZ + 15) continue;
            minClear = Math.min(minClear, tmpA.y - p.y1);
          }
        }
      }
      tmpB.copy(tmpA);
      return h.runner.state !== 'running';
    });
    expect(minClear).toBeGreaterThan(10);
  });
});

describe('the collapse in the merged CBD mesh (#128)', () => {
  it('comes down over time: it stands while the charges go off, then the top falls at about free fall onto the heap', async () => {
    const { BufferAttribute, BufferGeometry, Object3D } = await import('three');
    const { CbdCollapseVisual, RUBBLE_HEIGHT, collapsedY } = await import('../src/world/scenery/cbdCollapse');
    const { COLLAPSE_DELAY, MUSEUM_ID, buildingCollapseTime } = await import('../src/sim/buildings');
    // the pure fall
    expect(collapsedY(100, 0, 0)).toBe(100);
    expect(collapsedY(100, 0, COLLAPSE_DELAY)).toBe(100);
    expect(collapsedY(100, 0, COLLAPSE_DELAY + 1)).toBeCloseTo(100 - 4.9, 6);
    expect(collapsedY(100, 0, buildingCollapseTime(100))).toBeCloseTo(RUBBLE_HEIGHT, 6);
    expect(collapsedY(5, 0, 99)).toBe(5); // below the heap: untouched
    expect(buildingCollapseTime(42)).toBeGreaterThan(3);
    expect(buildingCollapseTime(42)).toBeLessThan(4);
    // a hero (the museum, id −10) in a fake mesh: vertices 0..3, its light and a separate mesh go out
    const world = createSimWorld({ terrain: flat, difficulty: DIFFICULTIES.pilot, events: new EventBus(), combat: createCombatSystemSeeded(1) });
    const idx = world.buildings!;
    const k = idx.heroIndex('museum');
    expect(idx.geo.buildings[k].id).toBe(MUSEUM_ID);
    // the mesh as tall as the measured museum (a float32, as the position buffer stores it)
    const h = Math.fround(idx.geo.buildings[k].top - idx.geo.buildings[k].ground);
    const pos = new Float32Array(4 * 3);
    for (let v = 0; v < 4; v++) pos[v * 3 + 1] = v % 2 ? h : 0;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    const lights = new BufferGeometry();
    lights.setAttribute('aColor', new BufferAttribute(new Float32Array([1, 1, 1, 0.5, 0.5, 0.5]), 3));
    const sign = new Object3D();
    const vis = new CbdCollapseVisual(geo, new Int32Array(0), new Float32Array(0), [{ id: MUSEUM_ID, v0: 0, v1: 4, ground: 0, l0: 1, l1: 2, objects: [sign] }], lights);
    idx.collapse(k, world.time);
    vis.update(world);
    expect(vis.collapsed).toEqual([MUSEUM_ID]);
    expect(vis.animating).toBe(true);
    expect(pos[1 * 3 + 1]).toBe(h); // still standing at t = 0
    expect(sign.visible).toBe(false);
    expect(Array.from(lights.getAttribute('aColor').array)).toEqual([1, 1, 1, 0, 0, 0]);
    let lastY = h;
    for (let i = 0; i < 60 * (buildingCollapseTime(h) + 0.5); i++) {
      world.step(1 / 60);
      vis.update(world);
      const y = pos[1 * 3 + 1];
      expect(y).toBeLessThanOrEqual(lastY);
      lastY = y;
    }
    expect(lastY).toBe(RUBBLE_HEIGHT);
    expect(vis.animating).toBe(false);
    // the next mission stands it up, lights and sign back
    const next = createSimWorld({ terrain: flat, difficulty: DIFFICULTIES.pilot, events: new EventBus(), combat: createCombatSystemSeeded(1) });
    vis.update(next);
    expect(pos[1 * 3 + 1]).toBe(h);
    expect(sign.visible).toBe(true);
    expect(Array.from(lights.getAttribute('aColor').array)).toEqual([1, 1, 1, 0.5, 0.5, 0.5]);
  });

  it('flattens a collapsed building to a rubble heap and stands it up again in a new world', async () => {
    const { BufferAttribute, BufferGeometry } = await import('three');
    const { CbdCollapseVisual, RUBBLE_HEIGHT } = await import('../src/world/scenery/cbdCollapse');
    const world = createSimWorld({ terrain: flat, difficulty: DIFFICULTIES.pilot, events: new EventBus(), combat: createCombatSystemSeeded(1) });
    const idx = world.buildings!;
    const k = 0;
    const id = idx.geo.buildings[k].id;
    // a fake merged mesh: building `id` owns vertices 2..5 (two at 0 m, two at 120 m)
    const pos = new Float32Array(8 * 3);
    for (let v = 0; v < 8; v++) pos[v * 3 + 1] = v % 2 ? 120 : 0;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    const verts = new Int32Array((id + 1) * 2).fill(0);
    verts[id * 2] = 2;
    verts[id * 2 + 1] = 6;
    const ground = new Float32Array(id + 1);
    const vis = new CbdCollapseVisual(geo, verts, ground);
    vis.update(world);
    expect(vis.collapsed).toEqual([]);
    // it came down long ago: a rubble heap
    idx.collapse(k, world.time - 60);
    vis.update(world);
    expect(vis.collapsed).toEqual([id]);
    expect(vis.animating).toBe(false);
    const ys = () => Array.from({ length: 8 }, (_, v) => pos[v * 3 + 1]);
    expect(ys()).toEqual([0, 120, 0, RUBBLE_HEIGHT, 0, RUBBLE_HEIGHT, 0, 120]);
    // the next mission: a fresh world, every building standing
    const next = createSimWorld({ terrain: flat, difficulty: DIFFICULTIES.pilot, events: new EventBus(), combat: createCombatSystemSeeded(1) });
    vis.update(next);
    expect(vis.collapsed).toEqual([]);
    expect(ys()).toEqual([0, 120, 0, 120, 0, 120, 0, 120]);
  });
});
