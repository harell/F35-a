/**
 * Training lesson 7, "Small Targets" (t07, missions/content/trainingSmallTargets.ts), g03's second lesson: sewer rats in
 * Herne Bay, flushed out by the combined sewers' overflow. Two loop round the blocks off Wallace Street and Hamilton Road
 * with a stop at each drain, and one sits on the roof of the Shangri-La; StormBreakers only (#309), and the one that kills
 * the roof rat brings the tower down. Also the parts it added to the game: the rat (the stoat's runner: looping, sitting
 * still, swimming over water), a building a weapon brings down, a small target's bomb going off in the water and the
 * craters every ground impact digs.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus, type GameEventMap } from '../src/core/events';
import { DIFFICULTIES, LOADOUTS } from '../src/core/data';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createAiBrain } from '../src/ai';
import type { SimWorld, TerrainQuery } from '../src/sim/api';
import type { GroundTargetEntity, MissileEntity } from '../src/sim/entities';
import { type RunnerSpawn } from '../src/sim/runner';
import { BuildingIndex, buildingGeometry } from '../src/sim/buildings';
import { isSmallGround } from '../src/sim/weapons/small';
import { TRAINING, createMissionRunner, fixedDifficulty, lessonsFor, missionById, nextMissionAfter, terrainPadsFor, validateMission } from '../src/missions';
import type { CampaignProgress } from '../src/core/contracts';
import { T07_GROUP, T07_RAT, T07_ROOF_GROUP, T07_ROUTES, T07_SMALL, T07_TOWER, type T07Route } from '../src/missions/content/trainingSmallTargets';
import { aucklandRoads } from '../src/world/scenery/aucklandRoads';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { getGroundPrototype } from '../src/render/models/ground';
import { GroundVisual } from '../src/render/visuals/SiteVisuals';
import { RAT_SWIM_Y, SIT_PITCH, ratNodes } from '../src/render/visuals/ratPose';
import { CRATER_DIG, Craters, craterOpening } from '../src/render/effects/Craters';
import { craterRadius, splashHeight } from '../src/render/effects/Effects';
import { podClass, podReadout } from '../src/hud/hmd/pip';
import { groundHudName } from '../src/missions/runtime/names';
import { FlatTerrain } from './combat-helpers';
import type { XZ } from '../src/missions/schema';

const DT = 1 / 60;
/** A swimming rat's speed in these tests (m/s). */
const SWIM = 1.5;

/** Land west of x = 500 (5 m up), sea east of it. */
class ShoreTerrain extends FlatTerrain {
  override heightAt(x: number): number {
    return x < 500 ? 5 : -5;
  }
  override isWater(...[x]: number[]): boolean {
    return x >= 500;
  }
}

function shoreWorld(seed = 1): SimWorld {
  return createSimWorld({ terrain: new ShoreTerrain(), difficulty: DIFFICULTIES.pilot, events: new EventBus(), combat: createCombatSystemSeeded(seed) });
}

function run(w: SimWorld, seconds: number, each?: () => boolean | void): void {
  for (let i = 0; i < seconds * 60; i++) {
    w.step(DT);
    if (each?.()) return;
  }
}

/** A rat running east: drains at 100 and 200 m, the shore at 500 m, a goal 1 km out to sea. */
const SHORE_ROUTE = (): RunnerSpawn => ({
  route: [0, 100, 200, 400, 1_500].map((x) => new Vector3(x, 0, 0)),
  stations: [1, 2],
  speed: T07_RAT.speed,
  stopTime: 10,
  swimSpeed: SWIM,
});

function rat(w: SimWorld, spec: RunnerSpawn): GroundTargetEntity {
  return w.spawnGround({ type: 'rat', team: 'red', position: spec.route[0].clone(), name: 'Rat', runner: spec });
}

const terrains = new Map<number, TerrainQuery>();
function realTerrain(res = 512): TerrainQuery {
  let t = terrains.get(res);
  if (!t) {
    t = new TerrainQueryImpl(runSync(generateTerrain({ theater: T07_SMALL.theater, seed: T07_SMALL.seed, resolution: res, features: allFeatures(T07_SMALL.theater, T07_SMALL.features), pads: terrainPadsFor(T07_SMALL) })));
    terrains.set(res, t);
  }
  return t;
}

const land = (t: TerrainQuery, p: XZ) => !t.isWater(p.x, p.z);
/** A circuit's points in order, back to its start. */
const circuit = (r: T07Route): XZ[] => [r.start, ...r.route, r.start];

/** Distance (m) from (x, z) to the nearest LINZ road centreline. */
function roadDistance(x: number, z: number): number {
  let best = Infinity;
  for (const l of aucklandRoads()!.lines) {
    const p = l.pts;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i], az = p[i + 1], dx = p[i + 2] - ax, dz = p[i + 3] - az;
      const l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
    }
  }
  return best;
}

describe('t07 Small Targets: content', () => {
  it("is lesson 7, g03's second lesson after T06 Live SAMs: reachable by id, valid, at Pilot, leading into g03", () => {
    expect(missionById('t07')).toBe(T07_SMALL);
    expect(TRAINING.map((m) => m.id)).toEqual(['t01', 't02', 't03', 't04', 't05', 't06', 't07']);
    expect(TRAINING[6]).toBe(T07_SMALL);
    expect(T07_SMALL.index).toBe(7);
    expect(T07_SMALL.kind).toBe('training');
    expect(validateMission(T07_SMALL)).toEqual([]);
    expect(fixedDifficulty(T07_SMALL)).toBe('pilot');
    expect(missionById('g03')?.lessons).toEqual(['t06', 't07']);
    expect(lessonsFor('g03').map((m) => m.id).slice(-2)).toEqual(['t06', 't07']);
    // with g01 and g02 won and the earlier lessons flown: T06 → T07 → g03
    const won = { score: 1, grade: 'A' as const, time: 1, difficulty: 'pilot' as const };
    const best = Object.fromEntries(['t01', 't02', 't03', 't04', 't05', 't06', 'g01', 'g02'].map((id) => [id, won]));
    const p = { unlocked: ['g01', 'g02', 'g03'], best, totals: { missions: 0, airKills: 0, groundKills: 0, deaths: 0 } } as unknown as CampaignProgress;
    expect(nextMissionAfter('t06', p)?.id).toBe('t07');
    expect(nextMissionAfter('t07', { ...p, best: { ...best, t07: won } } as CampaignProgress)?.id).toBe('g03');
    expect(T07_SMALL.timeOfDay).toBe('day');
  });

  it("flies g03's StormBreaker and nothing else: no JDAM, no AARGM-ER (a rat has no radar)", () => {
    expect(T07_SMALL.recommendedLoadout).toBe('strike_precision');
    expect(T07_SMALL.allowedLoadouts).toEqual(['strike_precision']);
    const l = LOADOUTS.strike_precision;
    expect(l.stores).toEqual([{ weapon: 'gbu53', count: 8, internal: true }]);
    expect(l.rcsMultiplier).toBe(1);
    expect(l.role).toBe('ag');
    expect(LOADOUTS.sead_precision.stores.some((st) => st.weapon === 'gbu53')).toBe(true);
    expect(missionById('g03')?.allowedLoadouts).toContain('sead_precision');
  });

  it('a short briefing and radio with no JDAM, island or swimming in them', () => {
    expect(T07_SMALL.briefing.length).toBeLessThanOrEqual(3);
    const sc = T07_SMALL.script;
    const radio = [...sc.triggers.flatMap((t) => t.actions), ...(sc.opening ?? [])].flatMap((a) => (a.kind === 'radio' ? [a.text] : []));
    const words = [...T07_SMALL.briefing, ...radio, ...(sc.hints ?? []).map((h) => h.text), sc.successText ?? '', ...sc.objectives.map((o) => o.label)].join(' ');
    expect(words).not.toMatch(/JDAM|GBU-31|island|swim/i);
    expect(words).toMatch(/Shangri-La/);
  });

  it('three rats: two street rats looping their blocks, one on the roof; no end action, no time limit', () => {
    const ground = T07_SMALL.script.ground;
    expect(ground).toHaveLength(3);
    expect(ground.every((g) => g.type === 'rat' && !g.spawn)).toBe(true);
    const street = ground.filter((g) => g.group === T07_GROUP);
    expect(street).toHaveLength(2);
    expect(street.every((g) => g.runner?.loop === true && g.runner.clock === 'spawn' && !g.onRoof)).toBe(true);
    const roof = ground.filter((g) => g.group === T07_ROOF_GROUP);
    expect(roof).toHaveLength(1);
    expect(roof[0].onRoof).toBe(true);
    expect(roof[0].runner?.route).toEqual([]);
    expect({ x: roof[0].x, z: roof[0].z }).toEqual(T07_TOWER);
    expect(T07_SMALL.script.objectives.map((o) => [o.id, o.kind === 'destroy' ? o.groups : []])).toEqual([['o_rats', [T07_GROUP, T07_ROOF_GROUP]]]);
    expect(T07_SMALL.script.triggers.flatMap((t) => t.actions).some((a) => a.kind === 'end')).toBe(false);
    expect(T07_SMALL.timeLimit).toBeUndefined();
    expect(T07_SMALL.script.costSummary?.removed.groups).toEqual([T07_GROUP, T07_ROOF_GROUP]);
  });
});

describe('t07: the circuits on the real streets', () => {
  it('every point is on a road centreline, and every leg runs along a road', () => {
    expect(aucklandRoads()).not.toBeNull();
    const routes: Record<string, T07Route> = T07_ROUTES;
    for (const [name, r] of Object.entries(routes)) {
      const pts = circuit(r);
      for (const p of pts) expect(roadDistance(p.x, p.z), `${name} ${p.x},${p.z}`).toBeLessThan(4);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 5);
        for (let k = 1; k < n; k++) {
          const x = a.x + ((b.x - a.x) * k) / n, z = a.z + ((b.z - a.z) * k) / n;
          expect(roadDistance(x, z), `${name} leg ${i}`).toBeLessThan(4);
        }
      }
      for (const k of r.drains) expect(k >= 0 && k < r.route.length, `${name} drain ${k}`).toBe(true);
    }
  });

  it.each([512, 1024])('the whole circuit is on land (terrain %i)', { timeout: 60_000 }, (res) => {
    const t = realTerrain(res);
    const routes: Record<string, T07Route> = T07_ROUTES;
    for (const [name, r] of Object.entries(routes)) {
      const pts = circuit(r);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 10);
        for (let k = 0; k <= n; k++) expect(land(t, { x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n }), `${name} leg ${i}`).toBe(true);
      }
    }
    expect(land(t, T07_TOWER)).toBe(true);
  });

  it("the roof rat's spot is on the Shangri-La's roof, more than 40 m up", () => {
    const t = realTerrain();
    const idx = new BuildingIndex(buildingGeometry(t)!);
    const roof = idx.roofAt(T07_TOWER.x, T07_TOWER.z);
    expect(roof).not.toBeNull();
    const b = idx.geo.buildings[roof!.index];
    expect(b.name).toBe('Shangri-La');
    expect(roof!.y - b.ground).toBeGreaterThan(40);
    // nothing tall next door: just off the footprint there is no roof
    expect(idx.roofAt(T07_TOWER.x, T07_TOWER.z + 60)).toBeNull();
  });
});

describe('the rat: loops, sits still', () => {
  /** A square circuit on flat land: start at the origin, drains at its first and third corners. */
  const LOOP = (): RunnerSpawn => ({
    route: [new Vector3(0, 0, 0), new Vector3(100, 0, 0), new Vector3(100, 0, 100), new Vector3(0, 0, 100)],
    stations: [1, 3],
    speed: T07_RAT.speed,
    stopTime: 5,
    loop: true,
  });

  it('a loop never arrives, goes back to its start after the last point, and stops at every drain each lap', { timeout: 30_000 }, () => {
    const w = shoreWorld();
    const r = rat(w, LOOP());
    const st = r.runner!;
    const stops: number[] = [];
    let backAtStart = 0;
    let prevLeg = st.leg;
    run(w, 600, () => {
      if (st.phase === 'stop' && stops.at(-1) !== st.leg) stops.push(st.leg);
      if (prevLeg === 3 && st.leg === 0) backAtStart++;
      prevLeg = st.leg;
      expect(st.arrived).toBe(false);
      expect(st.phase).not.toBe('nest');
    });
    // 400 m a lap at 2.5 m/s and two 5 s stops: about 170 s a lap
    expect(backAtStart).toBeGreaterThanOrEqual(3);
    expect(stops.length).toBeGreaterThanOrEqual(6);
    for (let i = 0; i < stops.length; i++) expect(stops[i]).toBe(i % 2 === 0 ? 1 : 3);
    expect(r.alive).toBe(true);
  });

  it('with no route after its start it sits for good, never moves, and sits up when designated', () => {
    const w = shoreWorld();
    const at = new Vector3(50, 0, 50);
    const r = rat(w, { route: [at], stations: [] });
    const st = r.runner!;
    expect(st.phase).toBe('stop');
    run(w, 300);
    expect(st.phase).toBe('stop');
    expect(Math.hypot(r.position.x - at.x, r.position.z - at.z)).toBe(0);
    expect(st.alert).toBe(0);
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(-3_000, 1_200, 50), heading: Math.PI / 2, speed: 230, loadout: 'strike_precision' });
    w.combat.designate(p, r.id, w);
    run(w, 2, () => {
      p.position.set(-3_000, 1_200, 50);
    });
    expect(st.targeted).toBe(true);
    expect(st.alert).toBeGreaterThan(0.9);
    expect(st.phase).toBe('stop');
  });

  it('on a roof it stands on the roof, and killing it brings the building down (no aircraft in the event)', () => {
    const w = createSimWorld({ terrain: realTerrain(), difficulty: DIFFICULTIES.pilot, events: new EventBus(), combat: createCombatSystemSeeded(1) });
    const at = new Vector3(T07_TOWER.x, 0, T07_TOWER.z);
    const r = w.spawnGround({ type: 'rat', team: 'red', position: at.clone(), name: 'Rat', runner: { route: [at], stations: [] }, onRoof: true });
    const roof = w.buildings!.roofAt(T07_TOWER.x, T07_TOWER.z)!;
    expect(r.roofOf).toBe(roof.index);
    expect(r.position.y).toBeCloseTo(roof.y, 6);
    run(w, 5);
    expect(r.position.y).toBeCloseTo(roof.y, 6);
    const down: GameEventMap['building:collapsed'][] = [];
    w.events.on('building:collapsed', (e) => down.push(e));
    w.applyDamage(r, 10, null, 'gbu53');
    expect(r.alive).toBe(false);
    expect(w.buildings!.collapsed.has(roof.index)).toBe(true);
    expect(down).toHaveLength(1);
    expect(down[0]).toMatchObject({ aircraftId: null, isPlayer: false, name: 'Shangri-La' });
    // the roof is gone with it: nothing to stand on there now
    expect(w.buildings!.roofAt(T07_TOWER.x, T07_TOWER.z)).toBeNull();
  });
});

describe('the rat: runs, stops at the drains, swims', () => {
  it('is a 0.3 kg small target, named RAT, classified by the pod as a Norway rat', () => {
    const w = shoreWorld();
    const r = rat(w, SHORE_ROUTE());
    expect(r.maxHealth).toBe(1);
    expect(isSmallGround(r)).toBe(true);
    expect(groundHudName('rat')).toBe('RAT');
    expect(podReadout(r, false)).toBe('TGT RAT');
    expect(podClass(r)?.[0]).toBe('HOSTILE · RATTUS NORVEGICUS · 0.3 KG');
  });

  it('stops at each drain on land; over the water it swims at its steady speed without stopping, to the island', { timeout: 30_000 }, () => {
    const w = shoreWorld();
    const r = rat(w, SHORE_ROUTE());
    const st = r.runner!;
    const stops: number[] = [];
    const swimSpeeds: number[] = [];
    run(w, 1_200, () => {
      if (st.phase === 'stop' && stops.at(-1) !== st.leg) stops.push(st.leg);
      if (r.position.x > 520 && r.position.x < 1_400) {
        expect(st.swimming).toBe(true);
        expect(st.phase).toBe('run');
        swimSpeeds.push(Math.hypot(r.velocity.x, r.velocity.z));
        expect(r.position.y).toBe(0); // on the surface
      } else if (r.position.x < 480) expect(st.swimming).toBe(false);
      return st.arrived;
    });
    expect(stops).toEqual([1, 2]);
    expect(st.arrived).toBe(true);
    expect(Math.min(...swimSpeeds)).toBeCloseTo(SWIM, 3);
    expect(Math.max(...swimSpeeds)).toBeCloseTo(SWIM, 3);
  });

  it('the model: true scale, a few hundred triangles; sits up when alert, sinks to the waterline swimming; a killed one is gone', () => {
    const proto = getGroundPrototype('rat');
    let tris = 0;
    proto.root.traverse((o) => {
      const g = (o as { geometry?: { attributes: { position: { count: number } } } }).geometry;
      if (g) tris += g.attributes.position.count / 3;
    });
    expect(tris).toBeGreaterThan(50);
    expect(tris).toBeLessThan(800);
    const v = new GroundVisual(proto);
    const nodes = ratNodes(v.root)!;
    expect(nodes).not.toBeNull();
    const w = shoreWorld();
    const r = rat(w, SHORE_ROUTE());
    const cam = new Vector3(0, 2, 5);
    r.runner!.phase = 'stop';
    r.runner!.alert = 1;
    v.update(r, 1, DT, cam, 20_000);
    expect(nodes.hips.rotation.x).toBeCloseTo(SIT_PITCH, 5);
    r.runner!.swimming = true;
    v.update(r, 2, DT, cam, 20_000);
    expect(nodes.hips.position.y).toBeLessThan(RAT_SWIM_Y + 0.005);
    r.alive = false;
    expect(v.update(r, 3, DT, cam, 20_000)).toBe(false);
  });
});

// a swimming runner is still in the sim (g03's stoat can reach the water): the bombs against one
describe('bombs against a swimming rat', { timeout: 120_000 }, () => {
  /** One `weapon` at a rat 300 m out to sea, released `range` m short of it, 1,200 m up; who died and where it went off. */
  function drop(weapon: 'gbu53' | 'gbu31', seed: number, still = false, range = 3_000) {
    const w = shoreWorld(seed);
    const from = new Vector3(800, 0, 0);
    const spec: RunnerSpawn = still ? { route: [from, from.clone()], stations: [] } : { route: [from, new Vector3(3_000, 0, 0)], stations: [], swimSpeed: SWIM };
    const r = rat(w, spec);
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(from.x - range, 1_200, 0), heading: Math.PI / 2, speed: 230, loadout: weapon === 'gbu53' ? 'strike_precision' : 'strike_stealth' });
    w.combat.selectWeapon(p, weapon, w);
    const bursts: string[] = [];
    w.events.on('explosion', (e) => bursts.push(e.surface));
    const denials: string[] = [];
    w.events.on('weapon:denied', (e) => denials.push(e.reason));
    run(w, 1);
    p.position.set(r.position.x - range, 1_200, 0);
    p.velocity.set(230, 0, 0);
    w.combat.designate(p, r.id, w);
    run(w, 0.3);
    const launches: MissileEntity[] = [];
    w.events.on('munition:launch', (e) => {
      if (e.shooter === p) launches.push(e.missile);
    });
    w.combat.fire(p, w, weapon, r.id);
    run(w, 3, () => launches.length > 0);
    expect(launches, denials.join(', ')).toHaveLength(1);
    run(w, 120, () => !launches[0].alive);
    return { killed: !r.alive, bursts };
  }

  it('a StormBreaker can\'t track it swimming: it misses', () => {
    let kills = 0;
    for (const seed of [1, 2, 3]) if (drop('gbu53', seed).killed) kills++;
    expect(kills).toBe(0);
  });

  it('a JDAM released low and close kills it, and goes off in the water', () => {
    let kills = 0;
    for (const seed of [1, 2, 3]) {
      // a JDAM from 1,200 m reaches about 1.6 km (dlz.ts gpsMaxRange)
      const r = drop('gbu31', seed, false, 1_400);
      if (r.killed) kills++;
      expect(r.bursts).toContain('water');
    }
    expect(kills).toBe(3);
  });

  it('a StormBreaker that hits a small target in the water goes off as a water burst, not a fireball', () => {
    const r = drop('gbu53', 1, true);
    expect(r.killed).toBe(true);
    // the bomb and the rat's death: both in the water
    expect(r.bursts.length).toBeGreaterThan(0);
    expect(r.bursts.every((b) => b === 'water')).toBe(true);
  });
});

describe('t07 in the mission runner (real terrain)', { timeout: 240_000 }, () => {
  function setup() {
    const events = new EventBus();
    const world = createSimWorld({ terrain: realTerrain(), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(5) });
    const runner = createMissionRunner(T07_SMALL, { createAi: createAiBrain, difficulty: DIFFICULTIES.pilot, events });
    runner.setup(world, 'strike_precision');
    const p = world.player!;
    const radio: { from: string; text: string }[] = [];
    events.on('radio', (e) => radio.push({ from: e.from, text: e.text }));
    const collapses: GameEventMap['building:collapsed'][] = [];
    events.on('building:collapsed', (e) => collapses.push(e));
    const step = (seconds: number, each?: () => boolean | void) => {
      for (let i = 0; i < seconds * 60 && runner.state === 'running'; i++) {
        p.health = p.maxHealth;
        world.step(DT);
        runner.update(world, DT);
        if (each?.()) return;
      }
    };
    /** Steps on after the sortie ended (the radio queue still plays). */
    const after = (seconds: number) => {
      for (let i = 0; i < seconds * 60; i++) {
        world.step(DT);
        runner.update(world, DT);
      }
    };
    const street = () => world.ground.filter((g) => g.groupId === T07_GROUP);
    const roofRat = () => world.ground.find((g) => g.groupId === T07_ROOF_GROUP)!;
    return { world, runner, p, step, after, street, roofRat, radio, collapses };
  }

  /** Pin the jet `back` m south of the rat, 1,200 m up, heading north at it, and release a StormBreaker at it. */
  function release(ctx: ReturnType<typeof setup>, target: GroundTargetEntity, back = 3_000) {
    const { world, p, step } = ctx;
    world.combat.selectWeapon(p, 'gbu53', world);
    p.position.set(target.position.x, 1_200, target.position.z + back);
    p.velocity.set(0, 0, -230);
    p.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 0);
    world.combat.designate(p, target.id, world);
    step(0.3);
    const launches: MissileEntity[] = [];
    const off = world.events.on('munition:launch', (e) => {
      if (e.shooter === p) launches.push(e.missile);
    });
    world.combat.fire(p, world, 'gbu53', target.id);
    step(3, () => launches.length > 0);
    off();
    expect(launches).toHaveLength(1);
    step(90, () => !launches[0].alive);
  }

  it('a StormBreaker on the roof rat brings the Shangri-La down: one weapon collapse, the trappers\' call, no check fire', () => {
    const ctx = setup();
    const { world, roofRat, step, radio, collapses, runner } = ctx;
    const r = roofRat();
    expect(r.roofOf).toBeGreaterThanOrEqual(0);
    const k = r.roofOf;
    release(ctx, r);
    expect(r.alive).toBe(false);
    expect(world.buildings!.collapsed.has(k)).toBe(true);
    expect(collapses).toHaveLength(1);
    expect(collapses[0]).toMatchObject({ aircraftId: null, isPlayer: false, name: 'Shangri-La' });
    step(5);
    expect(runner.state).toBe('running');
    expect(radio.some((m) => m.text === 'Well. That rat is off the roof.')).toBe(true);
    expect(radio.some((m) => /check fire|barrister|house/i.test(m.text))).toBe(false);
  });

  it('StormBreakers on all three rats, the street ones at their drains: the lesson is won, and the debrief counts three', () => {
    const ctx = setup();
    const { runner, street, roofRat, step, after, radio } = ctx;
    for (const r of street()) {
      step(200, () => r.runner!.phase === 'stop');
      expect(r.runner!.phase).toBe('stop');
      release(ctx, r);
      expect(r.alive).toBe(false);
    }
    release(ctx, roofRat());
    step(3);
    expect(runner.state).toBe('success');
    after(20);
    expect(radio.some((m) => m.text === 'That is all three. Herne Bay is rat-free.')).toBe(true);
    const res = runner.result(ctx.world) as { grade: string; costSummary?: { removed: { count: number }; weapons: { weapon: string }[] } };
    expect(res.costSummary?.removed.count).toBe(3);
    expect(res.costSummary?.weapons.map((x) => x.weapon)).toEqual(['gbu53']);
    expect(res.grade).not.toBe('F');
  });

  it('flown straight in from the start, each street rat stops as the jet comes into range: a StormBreaker on the first pass kills it from far out', () => {
    for (const k of [0, 1]) {
      const ctx = setup();
      const { world, p, step, street } = ctx;
      const r = street()[k];
      const { altitude, speed } = T07_SMALL.player;
      world.combat.selectWeapon(p, 'gbu53', world);
      // level at the start's height and speed, heading at the rat; TGT on it from the first hint (t = 5 s)
      let fired: MissileEntity | null = null;
      let firedAt = { t: 0, horiz: 0 };
      step(120, () => {
        const dx = r.position.x - p.position.x;
        const dz = r.position.z - p.position.z;
        const horiz = Math.hypot(dx, dz);
        p.position.y = altitude;
        p.velocity.set((speed * dx) / horiz, 0, (speed * dz) / horiz);
        p.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.atan2(-dx, -dz));
        if (world.time >= 5 && p.radar.designatedId !== r.id) world.combat.designate(p, r.id, world);
        if (fired || p.radar.designatedId !== r.id) return;
        const cue = world.combat.bombImpactPoint(p, world);
        if (cue?.inRange && r.runner!.phase === 'stop') {
          fired = world.combat.fire(p, world, 'gbu53', r.id);
          firedAt = { t: world.time, horiz };
        }
        return fired !== null && !fired.alive;
      });
      expect(fired, `rat ${k}`).not.toBeNull();
      // the cue's first IN RANGE (~5.8 km at the start's height), not a last-second drop
      expect(firedAt.horiz, `rat ${k}`).toBeGreaterThan(5_000);
      expect(firedAt.t, `rat ${k}`).toBeLessThan(25);
      expect(r.alive, `rat ${k}`).toBe(false);
    }
  });

  it('left alone, the rats keep going round: after 900 s the sortie is still running', () => {
    const { runner, street, step, p } = setup();
    // the jet holds over Herne Bay (it would fly straight out of the area of operations)
    step(900, () => {
      p.position.set(-2_300, 1_500, -560);
    });
    expect(runner.state).toBe('running');
    expect(street().every((r) => r.alive && !r.runner!.arrived)).toBe(true);
  });
});

describe('craters and splashes for every bomb', () => {
  it('a crater opens from a third of its size to full in CRATER_DIG s', () => {
    expect(craterOpening(0)).toBeCloseTo(0.35, 6);
    expect(craterOpening(CRATER_DIG / 2)).toBeGreaterThan(0.35);
    expect(craterOpening(CRATER_DIG)).toBe(1);
    expect(craterOpening(10)).toBe(1);
    const c = new Craters(4);
    const ground = () => 0;
    c.update(100);
    const m = c.add(0, 0, 3, ground);
    expect(m.scale.x).toBeCloseTo(0.35, 6);
    c.update(100 + CRATER_DIG);
    expect(m.scale.x).toBe(1);
  });

  it('the kill and the bomb that made it share one crater, grown to the bigger', () => {
    const c = new Craters(4);
    const ground = () => 0;
    const a = c.add(10, 10, 3, ground);
    const b = c.add(11, 10, 6.5, ground);
    expect(b).toBe(a);
    expect(c.count).toBe(1);
    const pos = a.geometry.getAttribute('position');
    let far = 0;
    for (let i = 0; i < pos.count; i++) far = Math.max(far, Math.hypot(pos.getX(i), pos.getZ(i)));
    expect(far).toBeGreaterThan(6.5);
    c.add(100, 100, 3, ground);
    expect(c.count).toBe(2);
  });

  it('craters and splash columns are sized by the weapon: a JDAM\'s are the biggest', () => {
    expect(craterRadius('gbu31', 'bomb')).toBeGreaterThan(craterRadius('gbu53', 'bomb'));
    expect(craterRadius('gbu53', 'bomb')).toBeGreaterThan(craterRadius('aargm', 'agm'));
    expect(craterRadius('aim120', 'aam')).toBeGreaterThan(0);
    expect(splashHeight('gbu31')).toBeGreaterThan(splashHeight('gbu53'));
  });
});
