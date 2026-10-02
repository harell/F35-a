/**
 * Shahed-136 one-way attack drone (issue #76): the dumb route flight and its dive into the target,
 * kills by AIM-120, AIM-9X and a gun burst, AIM-9X / AIM-120 locks at route height over the city,
 * the warhead blast that punishes point-blank kills, the formation spawn, and red AI / SAMs
 * ignoring it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus, type GameEventMap } from '../src/core/events';
import { AKL } from '../src/core/auckland';
import { DIFFICULTIES } from '../src/core/data';
import type { MissionDef } from '../src/core/contracts';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import type { SimWorld, TerrainQuery } from '../src/sim/api';
import type { AircraftEntity } from '../src/sim/entities';
import { createOneWay, diveStartDistance, IMPACT_RADIUS, placeOneWay, SHAHED_SPEED } from '../src/sim/drone/oneWay';
import { createSkyTower } from '../src/sim/landmarks';
import { AIRCRAFT_HEALTH, AIRCRAFT_WARHEAD } from '../src/sim/damage/tables';
import { createAiBrain } from '../src/ai';
import { missionById, terrainPadsFor, validateMission } from '../src/missions';
import { emptyScript, type AircraftGroupDef } from '../src/missions/schema';
import { formationOffset } from '../src/missions/runtime/spawner';
import { aircraftNoun, killHudText } from '../src/missions/runtime/names';
import { killerText } from '../src/missions/runtime/debrief';
import { pipName } from '../src/hud/hmd/pip';
import { AIRCRAFT_LABEL } from '../src/hud/hmd/format';
import { getAircraftPrototype } from '../src/render/models/aircraft';
import { AIRCRAFT_SPECS } from '../src/render/models/specs';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { FlatTerrain } from './combat-helpers';
import { harness } from './missions-helpers';

const DT = 1 / 60;
const ROUTE_ALT = 300;

function makeWorld(terrain: TerrainQuery = new FlatTerrain(10), seed = 3): SimWorld {
  return createSimWorld({ terrain, difficulty: DIFFICULTIES.pilot, events: new EventBus(), combat: createCombatSystemSeeded(seed) });
}

function run(world: SimWorld, seconds: number, each?: () => boolean | void): void {
  for (let i = 0; i < seconds * 60; i++) {
    world.step(DT);
    if (each?.()) return;
  }
}

function spawnDrone(world: SimWorld, from: Vector3, target: Vector3, route: Vector3[] = [], altitude = ROUTE_ALT): AircraftEntity {
  const ac = world.spawnAircraft({ type: 'shahed136', team: 'red', position: from, heading: 0, speed: SHAHED_SPEED, ai: null, groupId: 'shaheds' });
  placeOneWay(ac, createOneWay({ target, altitude, route }), from);
  return ac;
}

/** The player's F-35A in beast mode: AIM-120Ds and AIM-9Xs. */
function spawnPlayer(world: SimWorld, position: Vector3, heading: number, speed = 200): AircraftEntity {
  return world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position, heading, speed, loadout: 'a2a_beast' });
}

/** Release `weapon` at `target` and wait for it to leave the jet (internal bays open first). */
function launch(world: SimWorld, p: AircraftEntity, weapon: 'aim120' | 'aim9x', targetId: number): boolean {
  const launches = record(world, 'munition:launch');
  world.combat.fire(p, world, weapon, targetId);
  run(world, 1, () => launches.length > 0);
  return launches.some((l) => l.shooter === p && l.targetId === targetId);
}

function record<K extends keyof GameEventMap>(world: SimWorld, name: K): GameEventMap[K][] {
  const out: GameEventMap[K][] = [];
  world.events.on(name, (p) => out.push({ ...p }));
  return out;
}

describe('Shahed-136: the aircraft type', () => {
  it('is a small, low-health red aircraft named Shahed-136 in the HUD, PiP and kill callouts', () => {
    const w = makeWorld();
    const d = spawnDrone(w, new Vector3(0, ROUTE_ALT, 0), new Vector3(0, 10, -5000));
    expect(d.maxHealth).toBe(AIRCRAFT_HEALTH.shahed136);
    expect(d.maxHealth).toBeLessThan(50);
    expect(d.radius).toBeLessThan(3);
    expect(d.rcsBase).toBeLessThan(0.5);
    expect(d.irBase).toBeGreaterThan(0);
    expect(d.irBase).toBeLessThan(0.5);
    expect(d.name).toBe('Shahed-136');
    expect(AIRCRAFT_LABEL.shahed136).toBe('SHAHED-136');
    expect(pipName(d)).toBe('SHAHED-136 DRONE');
    expect(pipName(d, true)).toBe('SHAHED-136');
    expect(killHudText(d)).toBe('SPLASH SHAHED-136');
    expect(aircraftNoun('shahed136', 3)).toBe('drones');
    // debrief: killed by the warhead of one shot down too close
    expect(killerText({ stats: { lastHitWeapon: 'flak', lastHitBy: 'aircraft', lastHitType: 'shahed136' } } as never)).toBe("a Shahed-136's warhead");
    // it carries nothing: no stores, gun, flares or radar
    expect(d.stores.every((s) => s.count === 0)).toBe(true);
    expect(d.gunAmmo).toBe(0);
    expect(d.flares).toBe(0);
    expect(d.radar.emitting).toBe(false);
  });

  it('has a low-poly model with a spinning propeller', () => {
    const p = getAircraftPrototype('shahed136');
    expect(p.drives.find((d) => d.part === 'prop')?.kind).toBe('radome');
    expect(p.lod0.getObjectByName('part:prop')).toBeTruthy();
    expect(p.triangles).toBeLessThan(2000);
    expect(AIRCRAFT_SPECS.shahed136.span).toBeCloseTo(2.5);
  });
});

describe('Shahed-136: dumb route flight', () => {
  it('flies its route at a fixed height and speed, then dives into the target point and reports the hit', () => {
    const w = makeWorld();
    const target = new Vector3(0, 10, 0);
    const route = [new Vector3(0, 0, 6000), new Vector3(3000, 0, 3000)];
    const d = spawnDrone(w, new Vector3(-4000, 0, 9000), target, route);
    const impacts = record(w, 'drone:impact');
    const destroyed = record(w, 'destroyed');
    let closestWp = [Infinity, Infinity];
    let cruiseAltErr = 0;
    let cruiseSpeedErr = 0;
    run(w, 400, () => {
      if (!d.alive) return true;
      route.forEach((p, i) => (closestWp[i] = Math.min(closestWp[i], Math.hypot(d.position.x - p.x, d.position.z - p.z))));
      if (d.oneWay!.phase === 'cruise') {
        cruiseAltErr = Math.max(cruiseAltErr, Math.abs(d.position.y - ROUTE_ALT));
        cruiseSpeedErr = Math.max(cruiseSpeedErr, Math.abs(d.velocity.length() - SHAHED_SPEED));
      }
    });
    expect(closestWp[0]).toBeLessThan(150);
    expect(closestWp[1]).toBeLessThan(150);
    expect(cruiseAltErr).toBeLessThan(1e-6);
    expect(cruiseSpeedErr).toBeLessThan(0.5);
    expect(impacts).toHaveLength(1);
    expect(impacts[0].drone).toBe(d);
    expect(impacts[0].landmark).toBeNull();
    expect(impacts[0].position.distanceTo(target)).toBeLessThanOrEqual(IMPACT_RADIUS + 1e-6);
    expect(d.oneWay!.impacted).toBe(true);
    // the warhead goes off: destroyed, no kill credit, and the drone is gone from the world
    expect(d.alive).toBe(false);
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0].attackerId).toBeNull();
    expect(w.aircraft).not.toContain(d);
  });

  it('still reaches a waypoint that sits inside its gentle turn circle, and the target after it', () => {
    const w = makeWorld();
    const target = new Vector3(4000, 10, -4000);
    // fly north 3 km, then a waypoint 250 m back behind the turn
    const route = [new Vector3(0, 0, -3000), new Vector3(250, 0, -2800)];
    const d = spawnDrone(w, new Vector3(0, 0, 0), target, route);
    let closest = Infinity;
    run(w, 400, () => {
      closest = Math.min(closest, Math.hypot(d.position.x - 250, d.position.z + 2800));
      return !d.alive;
    });
    expect(closest).toBeLessThan(150);
    expect(d.oneWay!.impacted).toBe(true);
  });

  it('starts its dive at the dive distance and keeps a straight line down to the target', () => {
    const w = makeWorld();
    const target = new Vector3(0, 10, 0);
    const d = spawnDrone(w, new Vector3(0, 0, 4000), target);
    const startAt = diveStartDistance(d.oneWay!);
    let diveFrom = -1;
    run(w, 200, () => {
      if (!d.alive) return true;
      if (diveFrom < 0 && d.oneWay!.phase === 'dive') diveFrom = Math.hypot(d.position.x, d.position.z);
    });
    expect(diveFrom).toBeGreaterThan(startAt - SHAHED_SPEED * DT * 2);
    expect(diveFrom).toBeLessThan(startAt + SHAHED_SPEED * DT * 2);
  });

  it('never snap-turns onto a target just behind its last waypoint: it goes round and dives at 35°', () => {
    const w = makeWorld();
    // the target sits 300 m before the last waypoint, inside the dive distance (about 414 m)
    const target = new Vector3(0, 10, -2700);
    const d = spawnDrone(w, new Vector3(0, 0, 0), target, [new Vector3(0, 0, -3000)]);
    let prevHeading = d.oneWay!.heading;
    let maxTurn = 0;
    let steepest = 0;
    run(w, 400, () => {
      if (!d.alive) return true;
      const f = d.oneWay!;
      maxTurn = Math.max(maxTurn, Math.abs(Math.atan2(Math.sin(f.heading - prevHeading), Math.cos(f.heading - prevHeading))));
      prevHeading = f.heading;
      steepest = Math.min(steepest, f.pitch);
    });
    expect(d.oneWay!.impacted).toBe(true);
    expect(d.oneWay!.impactPoint.distanceTo(target)).toBeLessThanOrEqual(IMPACT_RADIUS + 1e-6);
    expect(maxTurn / (Math.PI / 180)).toBeLessThan(6); // was a 180° flip in one frame
    expect(-steepest / (Math.PI / 180)).toBeLessThan(37); // was a 58° dive
  });

  it('blows up once on a target on the ground (no second crash explosion from the wreck)', () => {
    const w = makeWorld(new FlatTerrain(10));
    const target = new Vector3(0, 10, 0);
    const d = spawnDrone(w, new Vector3(0, 0, 3000), target);
    const booms = record(w, 'explosion');
    const impacts = record(w, 'drone:impact');
    run(w, 120, () => !d.alive);
    run(w, 2);
    expect(impacts).toHaveLength(1);
    expect(booms).toHaveLength(1);
    expect(booms[0].surface).toBe('ground');
  });

  it('a drone aimed at the Sky Tower blows up against it and says so', () => {
    const w = makeWorld(new FlatTerrain(0));
    const tower = createSkyTower(0);
    w.landmarks.push(tower);
    const target = new Vector3(tower.base.x, 150, tower.base.z);
    const d = spawnDrone(w, new Vector3(tower.base.x, 0, tower.base.z + 3000), target);
    const impacts = record(w, 'drone:impact');
    run(w, 120, () => !d.alive);
    expect(impacts).toHaveLength(1);
    expect(impacts[0].landmark).toBe(tower);
    expect(tower.alive).toBe(true); // what a hit does to the tower is the mission's business (#75, #78)
  });

  it('never reacts to a missile: same path with and without an AIM-120 chasing it, no flares', () => {
    const path = (shoot: boolean): Vector3[] => {
      const w = makeWorld();
      const d = spawnDrone(w, new Vector3(0, 0, 0), new Vector3(0, 10, -30000));
      const p = spawnPlayer(w, new Vector3(0, 1500, 9000), 0, 220);
      run(w, 1);
      if (shoot) {
        w.combat.designate(p, d.id, w);
        w.combat.fire(p, w, 'aim120', d.id);
        expect(w.missiles.length + (p.bayDoors > 0 ? 1 : 0)).toBeGreaterThan(0);
      }
      const out: Vector3[] = [];
      run(w, 8, () => {
        out.push(d.position.clone());
        return !d.alive;
      });
      expect(d.flares).toBe(0);
      return out;
    };
    const calm = path(false);
    const chased = path(true);
    const n = Math.min(calm.length, chased.length) - 1;
    expect(n).toBeGreaterThan(60);
    for (let i = 0; i < n; i++) expect(chased[i].distanceTo(calm[i])).toBeLessThan(1e-6);
  });
});

describe('Shahed-136: kills', () => {
  for (const weapon of ['aim120', 'aim9x'] as const) {
    it(`one ${weapon.toUpperCase()} destroys it`, () => {
      const w = makeWorld();
      const d = spawnDrone(w, new Vector3(0, 0, 0), new Vector3(0, 10, -30000));
      // AIM-120 from 7 km head-on and above; AIM-9X from 2 km behind it
      const p = weapon === 'aim120' ? spawnPlayer(w, new Vector3(0, 1200, -7000), Math.PI, 220) : spawnPlayer(w, new Vector3(0, 600, 2000), 0, 150);
      w.combat.selectWeapon(p, weapon, w);
      run(w, 1);
      w.combat.designate(p, d.id, w);
      run(w, 2.5);
      const destroyed = record(w, 'destroyed');
      expect(launch(w, p, weapon, d.id), `${weapon} launched`).toBe(true);
      run(w, 40, () => !d.alive);
      expect(d.alive).toBe(false);
      expect(destroyed[0]).toMatchObject({ attackerId: p.id, weapon });
      expect(p.kills).toBe(1);
    });
  }

  it('one short gun burst on target destroys it', () => {
    const w = makeWorld();
    const d = spawnDrone(w, new Vector3(0, 0, 0), new Vector3(0, 10, -30000));
    const p = spawnPlayer(w, new Vector3(0, ROUTE_ALT, 450), 0, 140);
    run(w, 0.3);
    p.radar.designatedId = d.id;
    // put the drone on the pipper (the pipper depends on the range: iterate to a fixed point)
    for (let i = 0; i < 6; i++) {
      const lead = w.combat.gunLeadPoint(p, w)!;
      d.position.copy(lead);
      d.oneWay!.altitude = lead.y;
    }
    w.combat.selectWeapon(p, 'gun', w);
    const ammo = p.gunAmmo;
    p.input.fireGun = true;
    run(w, 0.4);
    p.input.fireGun = false;
    const fired = ammo - p.gunAmmo;
    expect(fired).toBeLessThanOrEqual(25); // ~0.4 s of a 3,300 rpm gun
    run(w, 1.5, () => !d.alive);
    expect(d.alive).toBe(false);
    expect(p.kills).toBe(1);
  });
});

describe('Shahed-136: the warhead', () => {
  const blast = (distance: number) => {
    const w = makeWorld();
    const d = spawnDrone(w, new Vector3(0, 0, 0), new Vector3(0, 10, -30000));
    const other = spawnDrone(w, new Vector3(60, 0, 0), new Vector3(60, 10, -30000));
    const p = spawnPlayer(w, new Vector3(distance, ROUTE_ALT, 0), 0, 200);
    run(w, 0.1);
    const before = p.health;
    w.applyDamage(d, 1000, p.id, 'gun', d.position);
    return { lost: before - p.health, d, other, p };
  };

  it('a drone killed within 150 m damages the player', () => {
    const near = blast(100);
    expect(near.d.alive).toBe(false);
    expect(near.lost).toBeGreaterThan(0);
    expect(near.p.alive).toBe(true);
    // the blast falls off with distance
    expect(blast(40).lost).toBeGreaterThan(near.lost);
    expect(AIRCRAFT_WARHEAD.shahed136!.radius).toBe(150);
  });

  it("one killed at 500 m doesn't, and drones never set each other off", () => {
    const far = blast(500);
    expect(far.lost).toBe(0);
    expect(far.other.alive).toBe(true);
    expect(far.other.health).toBe(far.other.maxHealth);
  });

  it('a drone that dives into its target next to the player damages the player too', () => {
    const w = makeWorld();
    const target = new Vector3(0, 10, 0);
    const d = spawnDrone(w, new Vector3(0, 0, 1500), target);
    const p = spawnPlayer(w, new Vector3(80, 120, 0), 0, 200);
    p.health = p.maxHealth;
    let hurt = 0;
    w.events.on('player:hit', (e) => (hurt += e.amount));
    run(w, 60, () => {
      // pin the player near the target (a parked observer)
      p.position.set(80, 120, 0);
      return !d.alive;
    });
    expect(d.oneWay!.impacted).toBe(true);
    expect(hurt).toBeGreaterThan(0);
  });
});

describe('Shahed-136: formation spawn', () => {
  it("'triangle' lays out rows of 1, 2, 3, 4 behind the lead, centred on its track", () => {
    const o = { right: 0, aft: 0 };
    const rows: number[][] = [];
    for (let i = 0; i < 10; i++) {
      formationOffset('triangle', i, 10, 100, o);
      const r = Math.round(o.aft / 100);
      (rows[r] ??= []).push(o.right);
    }
    expect(rows.map((r) => r.length)).toEqual([1, 2, 3, 4]);
    for (const r of rows) expect(r.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 6);
    expect(rows[3]).toEqual([-150, -50, 50, 150]);
  });

  it('validateMission accepts a drone group at drone speed and checks its target and route', () => {
    const base = missionById('c01')!;
    const withGroup = (g: AircraftGroupDef): MissionDef => ({ ...base, script: { ...base.script!, groups: [...base.script!.groups, g] } });
    const g: AircraftGroupDef = {
      id: 'shaheds',
      type: 'shahed136',
      team: 'red',
      count: 10,
      formation: 'triangle',
      x: 4000,
      z: 6000,
      altitude: ROUTE_ALT,
      heading: 0,
      speed: SHAHED_SPEED,
      role: 'bomber',
      oneWay: { targetX: 1000, targetZ: 1000, route: [{ x: 2500, z: 3500 }] },
    };
    expect(validateMission(base)).toEqual([]);
    expect(validateMission(withGroup(g))).toEqual([]);
    expect(validateMission(withGroup({ ...g, speed: 10 }))).toEqual(['c01: group shaheds drone speed below 30 m/s']);
    const far = withGroup({ ...g, oneWay: { targetX: 1e7, targetZ: 1000, route: [{ x: 2500, z: -1e7 }] } });
    expect(validateMission(far).filter((e) => /drone target|drone route 0/.test(e))).toHaveLength(2);
    // ordinary flights keep the 100 m/s floor
    expect(validateMission(withGroup({ ...g, oneWay: undefined, speed: SHAHED_SPEED }))).toContain('c01: group shaheds speed below 100 m/s');
  });

  it('a mission group of 10 drones spawns in the triangle, nose toward the target, and every drone dives into it', { timeout: 30_000 }, () => {
    // well clear of the Sky Tower the mission puts at the origin (a drone would blow up on it)
    const target = { x: 1000, z: 1000 };
    const group: AircraftGroupDef = {
      id: 'shaheds',
      type: 'shahed136',
      team: 'red',
      count: 10,
      fixedCount: true,
      formation: 'triangle',
      spacing: 80,
      x: 4000,
      z: 6000,
      altitude: ROUTE_ALT,
      heading: 0,
      speed: SHAHED_SPEED,
      role: 'bomber',
      announce: false,
      oneWay: { targetX: target.x, targetZ: target.z, targetY: 60, route: [{ x: 2500, z: 3500 }] },
    };
    const base = missionById('c01')!;
    const def: MissionDef = {
      ...base,
      script: {
        ...emptyScript(),
        groups: [group],
        objectives: [{ id: 'hold', label: 'Hold', primary: true, kind: { kind: 'survive', seconds: 900 } } as never],
      },
    };
    const h = harness(def);
    const drones = h.world.aircraft.filter((a) => a.groupId === 'shaheds');
    expect(drones).toHaveLength(10);
    // nose toward the first waypoint, every drone at the route height
    const heading = Math.atan2(2500 - 4000, -(3500 - 6000));
    const fwd = new Vector3(Math.sin(heading), 0, -Math.cos(heading));
    const right = new Vector3(Math.cos(heading), 0, Math.sin(heading));
    const lead = drones[0];
    const rows = new Map<number, number[]>();
    for (const d of drones) {
      expect(d.ai).toBeNull();
      expect(d.position.y).toBeCloseTo(ROUTE_ALT, 6);
      expect(Math.abs(Math.atan2(Math.sin(d.flight.heading - heading), Math.cos(d.flight.heading - heading)))).toBeLessThan(1e-6);
      const rel = d.position.clone().sub(lead.position);
      const row = Math.round(-rel.dot(fwd) / 80);
      rows.set(row, [...(rows.get(row) ?? []), rel.dot(right)]);
    }
    expect([...rows.keys()].sort()).toEqual([0, 1, 2, 3]);
    expect([0, 1, 2, 3].map((r) => rows.get(r)!.length)).toEqual([1, 2, 3, 4]);

    const impacts: GameEventMap['drone:impact'][] = [];
    h.events.on('drone:impact', (e) => impacts.push({ ...e, position: e.position.clone() }));
    h.run(400, () => drones.every((d) => !d.alive));
    expect(impacts).toHaveLength(10);
    // a drone that reached its target got through: no "SHAHED-136 DOWN", no kill
    expect(h.of('hud:message').filter((m) => /SHAHED/.test(m.text))).toEqual([]);
    expect(h.world.player!.kills).toBe(0);
    for (const e of impacts) expect(Math.hypot(e.position.x - target.x, e.position.y - 60, e.position.z - target.z)).toBeLessThanOrEqual(IMPACT_RADIUS + 1e-6);
  });
});

describe('Shahed-136: red AI and SAMs ignore it', () => {
  it('a red fighter and a red SAM site next to its route never track or chase it, and it puts nothing on the RWR', () => {
    const w = makeWorld();
    const d = spawnDrone(w, new Vector3(0, 0, 0), new Vector3(0, 10, -30000));
    const mig = w.spawnAircraft({
      type: 'mig29',
      team: 'red',
      position: new Vector3(2000, 3000, -2000),
      heading: Math.PI / 2,
      speed: 220,
      ai: createAiBrain('fighter', { skill: 0.6, task: { kind: 'patrol', center: new Vector3(2000, 3000, -2000), radius: 4000, altitude: 3000 } }),
    });
    const sam = w.spawnSam({ type: 'sa15', team: 'red', position: new Vector3(1500, 0, -3000) });
    const p = spawnPlayer(w, new Vector3(-6000, 2000, -3000), Math.PI / 2, 220);
    let samTracked = false;
    let migDesignated = false;
    run(w, 30, () => {
      if (sam.trackedTargetId === d.id) samTracked = true;
      if (mig.radar.designatedId === d.id || mig.radar.lockedId === d.id) migDesignated = true;
      expect(p.rwr.some((c) => c.sourceId === d.id)).toBe(false);
    });
    expect(samTracked).toBe(false);
    expect(migDesignated).toBe(false);
    expect(d.alive).toBe(true);
  });
});

/* ───────────── locks at route height over the city (real Auckland terrain) ───────────── */

describe('Shahed-136: AIM-9X and AIM-120 lock it at its route height over the city', () => {
  let terrain: TerrainQuery;
  beforeAll(() => {
    const def = missionById('c01')!;
    terrain = new TerrainQueryImpl(runSync(generateTerrain({ theater: 'auckland', seed: def.seed, resolution: 512, features: allFeatures('auckland', []), pads: terrainPadsFor(def) })));
  }, 60_000);

  // a drone over the suburbs south of the CBD (Newmarket → the Sky Tower), 300 m MSL
  const from = () => new Vector3(AKL.newmarket.x, 0, AKL.newmarket.z);
  const towards = () => new Vector3(AKL.skytower.x, 60, AKL.skytower.z);

  it('the route really is over the city at route height', () => {
    const f = from();
    expect(Math.hypot(f.x, f.z)).toBeGreaterThan(2000);
    expect(Math.hypot(f.x, f.z)).toBeLessThan(6000);
    expect(ROUTE_ALT - terrain.surfaceHeightAt(f.x, f.z)).toBeGreaterThan(150);
  });

  it('AIM-9X: the seeker locks it from behind and from the beam', () => {
    for (const geometry of ['tail', 'beam'] as const) {
      const w = makeWorld(terrain);
      const d = spawnDrone(w, from(), towards());
      run(w, 0.5);
      const hdg = d.oneWay!.heading;
      const back = new Vector3(-Math.sin(hdg), 0, Math.cos(hdg));
      const side = new Vector3(Math.cos(hdg), 0, Math.sin(hdg));
      const off = geometry === 'tail' ? back.multiplyScalar(2500) : side.multiplyScalar(2000);
      const pos = d.position.clone().add(off).setY(800);
      const p = spawnPlayer(w, pos, Math.atan2(d.position.x - pos.x, -(d.position.z - pos.z)), 180);
      w.combat.selectWeapon(p, 'aim9x', w);
      run(w, 1);
      w.combat.designate(p, d.id, w);
      run(w, 0.5);
      const ir = w.combat.irSeekerState(p);
      expect(ir.state, geometry).toBe('locked');
      expect(ir.targetId, geometry).toBe(d.id);
    }
  });

  it('AIM-120: the radar sees it head-on from 15 km, locks it and the missile tracks it to a kill', () => {
    const w = makeWorld(terrain);
    const d = spawnDrone(w, from(), towards());
    run(w, 0.5);
    const hdg = d.oneWay!.heading;
    const ahead = new Vector3(Math.sin(hdg), 0, -Math.cos(hdg));
    const pos = d.position.clone().addScaledVector(ahead, 9000).setY(1500);
    const p = spawnPlayer(w, pos, Math.atan2(d.position.x - pos.x, -(d.position.z - pos.z)), 220);
    w.combat.selectWeapon(p, 'aim120', w);
    run(w, 1.5);
    expect(p.radar.contacts.some((c) => c.id === d.id)).toBe(true);
    w.combat.designate(p, d.id, w);
    run(w, 4, () => p.radar.lockedId === d.id);
    expect(p.radar.lockedId).toBe(d.id);
    const destroyed = record(w, 'destroyed');
    expect(launch(w, p, 'aim120', d.id)).toBe(true);
    run(w, 40, () => !d.alive);
    expect(d.alive).toBe(false);
    expect(destroyed[0]).toMatchObject({ attackerId: p.id, weapon: 'aim120' });
    expect(d.oneWay!.impacted).toBe(false);
  });
});
