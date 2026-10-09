/**
 * Training lesson 7, "Small Targets" (t07, missions/content/trainingSmallTargets.ts), g03's second lesson: sewer rats in
 * Herne Bay, flushed out by the combined sewers' overflow, running down the streets and swimming for
 * Watchman Island. One wave, StormBreakers at the drains (playtest 2026-10-10, 1.4-b: no JDAM waves,
 * no JDAM loadout). Also the parts it added to the game: the rat (the stoat's runner, swimming over
 * water), a small target's bomb going off in the water and the craters every ground impact digs.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES, LOADOUTS } from '../src/core/data';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createAiBrain } from '../src/ai';
import type { SimWorld, TerrainQuery } from '../src/sim/api';
import type { GroundTargetEntity, MissileEntity } from '../src/sim/entities';
import { type RunnerSpawn } from '../src/sim/runner';
import { isSmallGround } from '../src/sim/weapons/small';
import { TRAINING, createMissionRunner, fixedDifficulty, lessonsFor, missionById, nextMissionAfter, terrainPadsFor, validateMission } from '../src/missions';
import type { CampaignProgress } from '../src/core/contracts';
import { T07_SMALL, T07_GROUP, T07_ISLAND, T07_RAT, T07_ROUTES, type T07Route } from '../src/missions/content/trainingSmallTargets';
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

/** A rat running east: drains at 100 and 200 m, the shore at 500 m, the island 1 km out to sea. */
const SHORE_ROUTE = (): RunnerSpawn => ({
  route: [0, 100, 200, 400, 1_500].map((x) => new Vector3(x, 0, 0)),
  stations: [1, 2],
  speed: T07_RAT.speed,
  stopTime: 10,
  swimSpeed: T07_RAT.swimSpeed,
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

  it("flies a StormBreaker load: g02's (bombs to spare) or g03's own, never a JDAM", () => {
    expect(T07_SMALL.recommendedLoadout).toBe('strike_maritime');
    expect(T07_SMALL.allowedLoadouts).toEqual(['strike_maritime', 'sead_precision']);
    expect(missionById('g03')?.allowedLoadouts).toContain('sead_precision');
    for (const id of T07_SMALL.allowedLoadouts) {
      const l = LOADOUTS[id];
      expect(l.stores.some((st) => st.weapon === 'gbu53'), id).toBe(true);
      expect(l.stores.some((st) => st.weapon === 'gbu31'), id).toBe(false);
    }
    // the old mixed load existed only for this lesson's JDAM waves
    expect(Object.keys(LOADOUTS)).not.toContain('strike_mixed');
  });

  it('one wave of two rats down the streets, every route ending at Watchman Island; a short briefing', () => {
    const ground = T07_SMALL.script.ground;
    expect(ground).toHaveLength(2);
    expect(ground.every((g) => g.type === 'rat' && g.group === T07_GROUP && !g.spawn && g.runner?.clock === 'spawn')).toBe(true);
    expect(T07_SMALL.script.objectives.map((o) => o.id)).toEqual(['o_rats']);
    for (const r of Object.values(T07_ROUTES)) {
      expect(r.route[r.route.length - 1]).toEqual(T07_ISLAND);
      expect(r.drains.length).toBeGreaterThan(0);
    }
    expect(T07_SMALL.briefing.length).toBeLessThanOrEqual(3);
    expect(T07_SMALL.briefing.join(' ')).not.toMatch(/JDAM|GBU-31/);
  });
});

describe('t07: the routes on the real coast', () => {
  it.each([512, 1024])('streets and drains are on land and the island is offshore (terrain %i)', (res) => {
    const t = realTerrain(res);
    expect(t.isWater(T07_ISLAND.x, T07_ISLAND.z)).toBe(true);
    const routes: Record<string, T07Route> = T07_ROUTES;
    for (const [name, r] of Object.entries(routes)) {
      expect(land(t, r.start), `${name} start`).toBe(true);
      // every point before the island: on land for a street rat, with 30 m of land round it
      for (const p of r.route.slice(0, -1) as XZ[]) {
        for (const [dx, dz] of [[0, 0], [30, 0], [-30, 0], [0, 30], [0, -30]]) expect(land(t, { x: p.x + dx, z: p.z + dz }), `${name} ${p.x},${p.z}`).toBe(true);
      }
    }
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

  it('stops at each drain on land; over the water it swims at its steady speed without stopping, to the island', () => {
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
    expect(Math.min(...swimSpeeds)).toBeCloseTo(T07_RAT.swimSpeed, 3);
    expect(Math.max(...swimSpeeds)).toBeCloseTo(T07_RAT.swimSpeed, 3);
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

describe('bombs against a swimming rat', { timeout: 120_000 }, () => {
  /** One `weapon` at a rat 300 m out to sea, released `range` m short of it, 1,200 m up; who died and where it went off. */
  function drop(weapon: 'gbu53', seed: number, still = false, range = 3_000) {
    const w = shoreWorld(seed);
    const from = new Vector3(800, 0, 0);
    const spec: RunnerSpawn = still ? { route: [from, from.clone()], stations: [] } : { route: [from, new Vector3(3_000, 0, 0)], stations: [], swimSpeed: T07_RAT.swimSpeed };
    const r = rat(w, spec);
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(from.x - range, 1_200, 0), heading: Math.PI / 2, speed: 230, loadout: 'strike_maritime' });
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
    runner.setup(world, 'strike_maritime');
    const p = world.player!;
    const radio: string[] = [];
    events.on('radio', (e) => radio.push(e.text));
    const step = (seconds: number, each?: () => boolean | void) => {
      for (let i = 0; i < seconds * 60 && runner.state === 'running'; i++) {
        p.health = p.maxHealth;
        world.step(DT);
        runner.update(world, DT);
        if (each?.()) return;
      }
    };
    const rats = () => world.ground.filter((g) => g.groupId === T07_GROUP);
    return { world, runner, p, step, rats, radio };
  }

  /** Pin the jet `back` m south of the rat, 1,200 m up, heading north at it, and release `weapon` at it. */
  function release(ctx: ReturnType<typeof setup>, target: GroundTargetEntity, weapon: 'gbu53', back = 3_000) {
    const { world, p, step } = ctx;
    world.combat.selectWeapon(p, weapon, world);
    p.position.set(target.position.x, 1_200, target.position.z + back);
    p.velocity.set(0, 0, -230);
    p.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 0);
    world.combat.designate(p, target.id, world);
    step(0.3);
    const launches: MissileEntity[] = [];
    const off = world.events.on('munition:launch', (e) => {
      if (e.shooter === p) launches.push(e.missile);
    });
    world.combat.fire(p, world, weapon, target.id);
    step(3, () => launches.length > 0);
    off();
    expect(launches).toHaveLength(1);
    step(90, () => !launches[0].alive);
  }

  it('StormBreakers on the two rats at their drains: the lesson is won, and the debrief counts both', () => {
    const ctx = setup();
    const { runner, rats, step } = ctx;
    const both = rats();
    expect(both).toHaveLength(2);
    for (const r of both) {
      step(200, () => r.runner!.phase === 'stop');
      expect(r.runner!.phase).toBe('stop');
      release(ctx, r, 'gbu53');
      expect(r.alive).toBe(false);
    }
    step(2);
    expect(runner.state).toBe('success');
    const res = runner.result(ctx.world) as { costSummary?: { removed: { count: number }; weapons: { weapon: string }[] } };
    expect(res.costSummary?.removed.count).toBe(2);
    expect(res.costSummary?.weapons.map((x) => x.weapon)).toEqual(['gbu53']);
  });

  it('a rat that reaches Watchman Island loses the sortie', () => {
    const { runner, rats, step, world } = setup();
    const r = rats()[0];
    r.runner!.leg = r.runner!.route.length - 1;
    r.position.set(T07_ISLAND.x, 0, T07_ISLAND.z + 30);
    step(5);
    expect(runner.state).toBe('failed');
    expect(runner.result(world).reason).toMatch(/Watchman Island/);
    // the debrief's tip: the lesson's rule
    expect(runner.result(world).tips?.some((t) => /drain/.test(t) && /StormBreaker/.test(t) && !/JDAM/.test(t))).toBe(true);
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
