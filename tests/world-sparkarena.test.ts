/**
 * Spark Arena (core/sparkArena.ts, world/scenery/sparkArena.ts): its place, the two lens roofs and the
 * walkway against the LINZ 2024 LiDAR (DSM − DEM, 3 × 3 m medians at points measured in the NZTM crop
 * and converted to game coordinates), the footprint, the solid volume the sim flies into, the
 * scatter keeping off it, and the merged mesh sitting on the ground.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { AKL, AKL_LANDMARKS } from '../src/core/auckland';
import { DIFFICULTIES } from '../src/core/data';
import { EventBus, type GameEventMap } from '../src/core/events';
import { ARENA_LENSES, SPARK_ARENA, ringArea, runsToRing, sparkArenaCovers, sparkArenaRoofAt, sparkArenaRuns } from '../src/core/sparkArena';
import { BuildingIndex, HERO_BUILDINGS, SPARK_ARENA_ID, buildBuildingGeometry } from '../src/sim/buildings';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';
import { LightList } from '../src/world/scenery/builders';
import { siteBlocker } from '../src/world/scenery/aucklandSites';
import { buildSparkArena, buildSparkArenaSignGeometry } from '../src/world/scenery/sparkArena';
import { flatLand } from './missions-helpers';

/** LiDAR roof heights above the ground (m) at game points: [x, z, height, where]. */
const LIDAR: [number, number, number, string][] = [
  [1296.0, -178.7, 25.9, 'north lens, west'],
  [1326.2, -167.2, 23.9, 'north lens, middle'],
  [1361.3, -158.9, 20.4, 'north lens, east'],
  [1282.0, -125.4, 23.9, 'south lens, west'],
  [1317.0, -120.1, 22.9, 'south lens, middle'],
  [1347.2, -111.6, 21.1, 'south lens, east'],
  [1326.6, -144.2, 28.8, 'walkway between the lenses'],
  [1371.8, -130.1, 19.2, 'walkway, east'],
  [1266.3, -163.1, 29.4, 'walkway over the foyer'],
];

describe('Spark Arena', () => {
  it('is a place east of the CBD, on its real position', () => {
    const place = AKL_LANDMARKS.find((l) => l.id === 'spark_arena')!;
    expect(place.kind).toBe(AKL_LANDMARKS.find((l) => l.id === 'eden_park')!.kind);
    expect(Math.hypot(AKL.spark_arena.x - SPARK_ARENA.x, AKL.spark_arena.z - SPARK_ARENA.z)).toBeLessThan(1);
    // ≈ 1.3 km east of the Sky Tower, past the LINZ CBD building box (x ≤ 1102)
    expect(SPARK_ARENA.x).toBeGreaterThan(1250);
    expect(SPARK_ARENA.x).toBeLessThan(1400);
    expect(Math.abs(SPARK_ARENA.z + 147)).toBeLessThan(10);
  });

  for (const [x, z, h, where] of LIDAR) {
    it(`roof over the ${where} is within 2 m of the LiDAR (${h} m)`, () => {
      expect(Math.abs(sparkArenaRoofAt(x, z) - h)).toBeLessThan(2);
    });
  }

  it('the highest roof is ≈ 31 m (the LiDAR max is 31.1 m) and the lens planes rise toward each other', () => {
    let top = 0;
    for (let x = -90; x <= 90; x += 1) for (let z = -70; z <= 70; z += 1) top = Math.max(top, sparkArenaRoofAt(SPARK_ARENA.x + x, SPARK_ARENA.z + z));
    expect(top).toBeGreaterThan(29.5);
    expect(top).toBeLessThan(32.5);
    const [N, S] = ARENA_LENSES;
    expect(N.def.plane[1]).toBeGreaterThan(0); // north lens: higher to the south
    expect(S.def.plane[1]).toBeLessThan(0); // south lens: higher to the north
  });

  it('the footprint is ≈ 120–135 m long and its area plausible', () => {
    const ring = runsToRing(sparkArenaRuns());
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < ring.length; i += 2) {
      x0 = Math.min(x0, ring[i]);
      x1 = Math.max(x1, ring[i]);
      z0 = Math.min(z0, ring[i + 1]);
      z1 = Math.max(z1, ring[i + 1]);
    }
    expect(x1 - x0).toBeGreaterThan(120);
    expect(x1 - x0).toBeLessThan(135);
    expect(z1 - z0).toBeGreaterThan(80);
    expect(z1 - z0).toBeLessThan(105);
    const area = Math.abs(ringArea(ring));
    expect(area).toBeGreaterThan(8000);
    expect(area).toBeLessThan(12000);
  });

  it('is solid: the building index has it as a hero landmark, as high as its roof', () => {
    const geo = buildBuildingGeometry(() => 4.8)!;
    const k = geo.buildings.findIndex((b) => b.hero?.id === 'spark_arena');
    const arena = geo.buildings[k];
    expect(arena.fixed).toBeUndefined();
    expect(arena.hero).toEqual(HERO_BUILDINGS.spark_arena);
    expect(arena.id).toBe(SPARK_ARENA_ID);
    const idx = new BuildingIndex(geo);
    expect(idx.heroIndex('spark_arena')).toBe(k);
    // the roof at the centre (walkway between the lenses) is the collision height there
    const roof = 4.8 + sparkArenaRoofAt(SPARK_ARENA.x, SPARK_ARENA.z);
    const near = idx.roofNear(SPARK_ARENA.x, SPARK_ARENA.z, 1);
    expect(near).toBeGreaterThanOrEqual(roof - 0.5);
    expect(near).toBeLessThan(roof + 2.5);
    const dive = idx.firstHit(new Vector3(SPARK_ARENA.x, 80, SPARK_ARENA.z), new Vector3(SPARK_ARENA.x, 0, SPARK_ARENA.z));
    expect(dive?.building).toBe(arena);
    const hitY = 80 - 80 * dive!.s;
    expect(hitY).toBeGreaterThanOrEqual(roof - 0.5);
    expect(hitY).toBeLessThan(roof + 2.5);
    expect(idx.firstHit(new Vector3(SPARK_ARENA.x - 200, 45, SPARK_ARENA.z), new Vector3(SPARK_ARENA.x + 200, 45, SPARK_ARENA.z))).toBeNull();
  });

  function flyInto(isPlayer: boolean) {
    const events = new EventBus();
    const world = createSimWorld({ terrain: flatLand(0), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(1) });
    const jet = world.spawnAircraft({ type: 'f35a', team: isPlayer ? 'blue' : 'red', position: new Vector3(SPARK_ARENA.x - 300, 15, SPARK_ARENA.z), heading: Math.PI / 2, speed: 250, isPlayer, fuel: 0.8 });
    jet.position.y = 15; // (spawning lifts a jet clear of the ground)
    const downs: GameEventMap['player:down'][] = [];
    const falls: GameEventMap['building:collapsed'][] = [];
    events.on('player:down', (e) => downs.push(e));
    events.on('building:collapsed', (e) => falls.push(e));
    for (let i = 0; i < 180 && jet.alive; i++) world.step(1 / 60);
    return { world, jet, downs, falls };
  }

  it("the player's jet flown into it crashes (down reason \"building\") and brings the arena down, named", () => {
    const { world, jet, downs, falls } = flyInto(true);
    expect(jet.alive).toBe(false);
    expect(downs.map((d) => d.reason)).toEqual(['building']);
    // stopped at the drum's west face, not inside
    expect(jet.position.x).toBeLessThan(SPARK_ARENA.x - 55);
    expect(falls).toHaveLength(1);
    expect(falls[0]).toMatchObject({ building: SPARK_ARENA_ID, isPlayer: true, hero: HERO_BUILDINGS.spark_arena });
    const idx = world.buildings!;
    expect([...idx.collapsed]).toEqual([idx.heroIndex('spark_arena')]);
    expect(world.structureStrike).toMatchObject({ name: 'Spark Arena', label: 'SPARK ARENA' });
    expect(world.structureStrike!.duration).toBeGreaterThan(2);
    expect(world.structureStrike!.duration).toBeLessThan(5);
  });

  it("anybody else's aircraft crashes on it and the arena stands", () => {
    const { world, jet, downs, falls } = flyInto(false);
    expect(jet.alive).toBe(false);
    expect(downs).toEqual([]);
    expect(falls).toHaveLength(0);
    expect(world.buildings!.collapsed.size).toBe(0);
    expect(world.structureStrike).toBeNull();
  });

  it('houses, trees and suburb centres keep off it', () => {
    const blocked = siteBlocker();
    expect(blocked(SPARK_ARENA.x, SPARK_ARENA.z, 0)).toBe(true);
    expect(blocked(SPARK_ARENA.x - 60, SPARK_ARENA.z + 45, 0)).toBe(true); // the south-west wing
    expect(sparkArenaCovers(SPARK_ARENA.x + 140, SPARK_ARENA.z)).toBe(false);
    expect(sparkArenaCovers(SPARK_ARENA.x, SPARK_ARENA.z - 62, 15)).toBe(true);
  });

  it('the mesh stands on the ground, inside its footprint, on a mobile budget', () => {
    const ground = (x: number, _z: number) => 4 + 0.01 * (x - SPARK_ARENA.x);
    for (const detail of [0.35, 1]) {
      const B = new GeometryBuilder();
      const lights = new LightList();
      buildSparkArena(B, lights, ground, detail);
      expect(B.triangleCount).toBeLessThan(detail < 0.5 ? 2500 : 5000);
      expect(lights.count).toBeGreaterThan(5);
      const g = B.build()!;
      g.computeBoundingBox();
      const bb = g.boundingBox!;
      expect(bb.min.y).toBeLessThan(ground(bb.min.x, 0) - 0.5); // walls go into the ground
      expect(bb.max.y - 4).toBeGreaterThan(30);
      expect(bb.max.y - 4).toBeLessThan(33.5);
      expect(bb.min.x).toBeGreaterThan(SPARK_ARENA.x - 85);
      expect(bb.max.x).toBeLessThan(SPARK_ARENA.x + 85);
    }
    // three signs (11 columns each): over the foyer glass facing west, on the north wall facing north,
    // on the north-west wall; all on the drum, under the roof, each quad facing its outward normal
    const sign = buildSparkArenaSignGeometry(ground);
    const pos = sign.getAttribute('position');
    const n = sign.getAttribute('normal');
    expect(pos.count).toBe(3 * 22);
    const mid = (k: number) => k * 22 + 10;
    expect(n.getX(mid(0))).toBeLessThan(-0.5);
    expect(pos.getX(mid(0))).toBeLessThan(SPARK_ARENA.x - 55);
    expect(pos.getY(mid(0)) - 4).toBeGreaterThan(16);
    expect(n.getZ(mid(1))).toBeLessThan(-0.8);
    expect(pos.getZ(mid(1))).toBeLessThan(SPARK_ARENA.z - 40);
    expect(n.getZ(mid(2))).toBeLessThan(-0.3);
    expect(n.getX(mid(2))).toBeLessThan(-0.3);
    const idx = sign.getIndex()!;
    for (let t = 0; t < idx.count; t += 3) {
      const [a, b, c] = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
      const ux = pos.getX(b) - pos.getX(a), uy = pos.getY(b) - pos.getY(a), uz = pos.getZ(b) - pos.getZ(a);
      const vx = pos.getX(c) - pos.getX(a), vy = pos.getY(c) - pos.getY(a), vz = pos.getZ(c) - pos.getZ(a);
      expect((uy * vz - uz * vy) * n.getX(a) + (ux * vy - uy * vx) * n.getZ(a)).toBeGreaterThan(0);
    }
    for (let v = 0; v < pos.count; v++) expect(pos.getY(v) - 4).toBeLessThan(sparkArenaRoofAt(pos.getX(v), pos.getZ(v)) || 31);
  });
});
