/**
 * Neutral civil shipping (issue #28): container ships and cruise liners as sim entities. Routes and
 * anchorages on the real LINZ water, the spawn mix per sortie, sensors (radar ground map / EOTS,
 * never A/A, ranked behind every hostile), AI never engaging them, one bomb / missile hit sinking
 * one while the gun only accumulates damage, and the civilian-loss callouts, score and debrief.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus, type GameEventMap } from '../src/core/events';
import { AKL } from '../src/core/auckland';
import { DIFFICULTIES } from '../src/core/data';
import type { MissionDef } from '../src/core/contracts';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createAiBrain } from '../src/ai';
import { VESSEL_DATA } from '../src/sim/damage/tables';
import { isCivilVessel, vesselHullDistance, vesselSegmentHit } from '../src/sim/civil/vessels';
import type { SimWorld } from '../src/sim/api';
import type { GroundTargetEntity } from '../src/sim/entities';
import type { VesselClass } from '../src/core/types';
import { ANCHORAGES, HARBOUR_LANE, LANE_SPEED, PORT_BERTHS, SHIP_ROUTES, lanePoints, routePoints } from '../src/missions/runtime/shipping';
import { FERRY_ROUTES } from '../src/render/traffic/ferryRoutes';
import { buildInstantMissionSeeded, createMissionRunner, missionById } from '../src/missions';
import type { MissionResultExt } from '../src/missions/runtime/resultExt';
import { computeScore, POINTS } from '../src/missions/runtime/scoring';
import { civilLossRows } from '../src/ui/screens/debrief';
import { entityLabel } from '../src/hud/hmd/format';
import { pipName, pipStatus } from '../src/hud/hmd/pip';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { FlatTerrain } from './combat-helpers';

const DEG = Math.PI / 180;
const DT = 1 / 60;

/** Open sea: the surface is the water at y = 0 everywhere. */
function seaWorld(seed = 1): SimWorld {
  return createSimWorld({ terrain: new FlatTerrain(-20), difficulty: DIFFICULTIES.pilot, events: new EventBus(), combat: createCombatSystemSeeded(seed) });
}

function run(world: SimWorld, seconds: number, each?: () => boolean | void): void {
  for (let i = 0; i < seconds * 60; i++) {
    world.step(DT);
    if (each?.()) return;
  }
}

function spawnShip(w: SimWorld, vessel: VesselClass, x: number, z: number, headingDeg = 0, name = 'MV Kōtuku Trader'): GroundTargetEntity {
  const e = w.spawnGround({ type: 'ship', team: 'neutral', vessel, position: new Vector3(x, 0, z), heading: headingDeg * DEG, name, groupId: 'civil-ship' });
  e.known = false;
  return e;
}

/* ───────────────────────── geography (real LINZ terrain) ───────────────────────── */

describe('civil shipping geography', () => {
  const hf = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 1024, features: allFeatures('auckland', []), pads: [] }));
  const q = new TerrainQueryImpl(hf);
  // enemy-held in the campaign fiction (ending.ts), plus the SAM / AAA islands of the missions
  const ENEMY = ['rangitoto', 'motutapu', 'waiheke_w', 'waiheke', 'waiheke_e', 'motuihe', 'browns_is'];

  /** Bow, stern and both sides at midships of a hull lying along `heading` (rad). */
  function hullPoints(x: number, z: number, heading: number, v: VesselClass): [number, number][] {
    const { length: L, beam: B } = VESSEL_DATA[v];
    const fx = Math.sin(heading);
    const fz = -Math.cos(heading);
    return [
      [x + (fx * L) / 2, z + (fz * L) / 2],
      [x - (fx * L) / 2, z - (fz * L) / 2],
      [x - (fz * B) / 2, z + (fx * B) / 2],
      [x + (fz * B) / 2, z - (fx * B) / 2],
    ];
  }

  it('every route stays in deep water (sampled every 50 m, the whole hull on water)', () => {
    for (const r of SHIP_ROUTES) {
      const pts = routePoints(r);
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        const heading = Math.atan2(b.x - a.x, -(b.z - a.z));
        const n = Math.ceil(a.distanceTo(b) / 50);
        for (let k = 0; k < n; k++) {
          const x = a.x + ((b.x - a.x) * k) / n;
          const z = a.z + ((b.z - a.z) * k) / n;
          expect(q.isWater(x, z), `route ${r.vessel} @ ${x.toFixed(0)},${z.toFixed(0)}`).toBe(true);
          expect(q.heightAt(x, z), `depth @ ${x.toFixed(0)},${z.toFixed(0)}`).toBeLessThan(-10);
          for (const [hx, hz] of hullPoints(x, z, heading, r.vessel)) expect(q.isWater(hx, hz)).toBe(true);
        }
      }
    }
  });

  it('anchorages leave swinging room on water; port berths have the whole hull on water', () => {
    for (const b of ANCHORAGES) {
      expect(q.heightAt(b.x, b.z)).toBeLessThan(-5);
      const R = VESSEL_DATA[b.vessel].length / 2 + 150;
      for (let k = 0; k < 16; k++) expect(q.isWater(b.x + Math.sin((k / 16) * Math.PI * 2) * R, b.z + Math.cos((k / 16) * Math.PI * 2) * R)).toBe(true);
    }
    for (const b of PORT_BERTHS) for (const [x, z] of hullPoints(b.x, b.z, b.heading * DEG, b.vessel)) expect(q.isWater(x, z), `berth ${b.x},${b.z}: ${x},${z}`).toBe(true);
  });

  it('peacetime harbour lane: the whole hull on water in more than 5 m, all the way round', () => {
    const pts = lanePoints();
    expect(pts.length).toBeGreaterThan(500);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      // smooth: no waypoint more than 60 m from the next, the heading snaps by a few degrees at most
      expect(a.distanceTo(b)).toBeLessThan(60);
      const heading = Math.atan2(b.x - a.x, -(b.z - a.z));
      expect(q.heightAt(a.x, a.z), `depth @ ${a.x.toFixed(0)},${a.z.toFixed(0)}`).toBeLessThan(-5);
      for (const v of ['cruise', 'container'] as const)
        for (const [hx, hz] of hullPoints(a.x, a.z, heading, v)) expect(q.isWater(hx, hz), `lane hull @ ${hx.toFixed(0)},${hz.toFixed(0)}`).toBe(true);
    }
  });

  it('the harbour lane keeps off Rangitoto and North Head, east of every ferry route, clear of the anchorages', () => {
    const pts = lanePoints();
    for (const p of pts) {
      expect(Math.hypot(p.x - AKL.rangitoto.x, p.z - AKL.rangitoto.z)).toBeGreaterThan(AKL_RADIUS.rangitoto + 500);
      expect(Math.hypot(p.x - AKL.north_head.x, p.z - AKL.north_head.z)).toBeGreaterThan(450 + 300); // ≈ 380 m off the headland at the closest, in deep water
      for (const b of ANCHORAGES) expect(Math.hypot(p.x - b.x, p.z - b.z)).toBeGreaterThan(1_000);
    }
    const minX = Math.min(...pts.map((p) => p.x));
    for (const r of FERRY_ROUTES) {
      for (const d of r.docks) expect(d.x).toBeLessThan(minX - 300);
      for (const leg of r.via) for (const [x] of leg) expect(x).toBeLessThan(minX - 300);
    }
    expect(HARBOUR_LANE.length).toBeGreaterThan(10);
  });

  it('keeps clear of the enemy-held islands and of each other', () => {
    const spots = [...ANCHORAGES.map((b) => new Vector3(b.x, 0, b.z)), ...SHIP_ROUTES.flatMap((r) => routePoints(r))];
    for (const id of ENEMY) {
      const L = AKL[id];
      const keep = (AKL_RADIUS[id] ?? 1000) + 2_000;
      for (const p of spots) expect(Math.hypot(p.x - L.x, p.z - L.z), `${id} vs ${p.x.toFixed(0)},${p.z.toFixed(0)}`).toBeGreaterThan(keep);
    }
    // anchored ships never sit on a moving ship's loop
    for (const b of ANCHORAGES) for (const r of SHIP_ROUTES) for (const p of routePoints(r)) expect(Math.hypot(p.x - b.x, p.z - b.z)).toBeGreaterThan(1_000);
    for (let i = 0; i < ANCHORAGES.length; i++)
      for (let j = i + 1; j < ANCHORAGES.length; j++) expect(Math.hypot(ANCHORAGES[i].x - ANCHORAGES[j].x, ANCHORAGES[i].z - ANCHORAGES[j].z)).toBeGreaterThan(2_000);
  });
});

/** Island radii from the landmark table (AKL holds only world XZ). */
const AKL_RADIUS: Record<string, number> = { rangitoto: 2800, motutapu: 2600, waiheke: 9000, motuihe: 1100, browns_is: 600 };

/* ───────────────────────── spawning per sortie ───────────────────────── */

describe('civil shipping in missions', () => {
  function setup(def: MissionDef, civilTraffic?: boolean) {
    const events = new EventBus();
    const world = createSimWorld({ terrain: new FlatTerrain(-20), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(1) });
    // RunnerDeps.civilTraffic (not in the public CreateMissionRunner contract)
    const deps = { createAi: createAiBrain, difficulty: DIFFICULTIES.pilot, events, civilTraffic };
    const runner = createMissionRunner(def, deps);
    runner.setup(world, def.recommendedLoadout);
    const radio: string[] = [];
    const hud: string[] = [];
    events.on('radio', (e) => radio.push(e.text));
    events.on('hud:message', (e) => hud.push(e.text));
    const tick = (seconds: number) => {
      for (let i = 0; i < seconds * 60 && runner.state === 'running'; i++) {
        world.step(DT);
        runner.update(world, DT);
      }
    };
    const ships = () => world.ground.filter((g) => g.team === 'neutral');
    return { world, runner, radio, hud, tick, ships };
  }

  it('Auckland sorties get 3 moored, 2–4 anchored and 1–2 moving civil ships (≤ 8)', () => {
    const m = setup(missionById('c01')!);
    const ships = m.ships();
    expect(ships.length).toBeGreaterThanOrEqual(3 + 2 + 1);
    expect(ships.length).toBeLessThanOrEqual(8);
    for (const s of ships) {
      expect(s.type).toBe('ship');
      expect(isCivilVessel(s)).toBe(true);
      expect(s.known).toBe(false);
      expect(s.health).toBe(VESSEL_DATA[s.vessel!].health);
      expect(s.radius).toBe(VESSEL_DATA[s.vessel!].length / 2);
    }
    expect(new Set(ships.map((s) => s.name)).size).toBe(ships.length);
    for (const b of PORT_BERTHS) {
      const s = ships.find((e) => e.position.x === b.x && e.position.z === b.z)!;
      expect(s).toBeDefined();
      expect(s.vessel).toBe(b.vessel);
      expect(s.speed).toBe(0);
      expect(s.anchored).toBe(false); // moored alongside: no swinging (render/visuals/shipMotion.ts)
    }
    const moving = ships.filter((s) => s.path);
    for (const s of moving) expect(s.anchored).toBe(false);
    // everything else rides at anchor in the outer Gulf
    const anchored = ships.filter((s) => s.anchored);
    expect(anchored.length).toBe(ships.length - PORT_BERTHS.length - moving.length);
    for (const s of anchored) expect(ANCHORAGES.some((a) => a.x === s.position.x && a.z === s.position.z)).toBe(true);
    expect(moving.length).toBeGreaterThanOrEqual(1);
    expect(moving.length).toBeLessThanOrEqual(2);
    expect(ships.some((s) => s.vessel === 'cruise')).toBe(true);
    expect(ships.some((s) => s.vessel === 'container')).toBe(true);
    // not hostile to anyone: never in either side's target list, never counted as an enemy
    for (const s of ships) {
      expect(m.world.hostilesOf('blue')).not.toContain(s);
      expect(m.world.hostilesOf('red')).not.toContain(s);
    }
    m.runner.dispose?.();
  });

  it('the mix varies with the mission seed within the limits', () => {
    const anchored = new Set<number>();
    const moving = new Set<number>();
    for (let seed = 1; seed <= 24; seed++) {
      const m = setup({ ...missionById('c01')!, seed });
      const ships = m.ships();
      const nMoving = ships.filter((s) => s.path).length;
      const nAnchored = ships.length - PORT_BERTHS.length - nMoving;
      expect(nAnchored).toBeGreaterThanOrEqual(2);
      expect(nAnchored).toBeLessThanOrEqual(4);
      expect(ships.length).toBeLessThanOrEqual(8);
      anchored.add(nAnchored);
      moving.add(nMoving);
      m.runner.dispose?.();
    }
    expect([...anchored].sort()).toEqual([2, 3, 4]);
    expect([...moving].sort()).toEqual([1, 2]);
  });

  it('a moving ship steams round its loop at its route speed', () => {
    const m = setup(missionById('c01')!);
    const s = m.ships().find((e) => e.path)!;
    const route = SHIP_ROUTES.find((r) => r.vessel === s.vessel)!;
    const p0 = s.position.clone();
    m.tick(60);
    expect(s.alive).toBe(true);
    expect(s.position.distanceTo(p0)).toBeGreaterThan(route.speed * 60 * 0.9);
    expect(s.position.distanceTo(p0)).toBeLessThan(route.speed * 60 * 1.01);
    expect(Math.hypot(s.position.x - route.x, s.position.z - route.z)).toBeLessThanOrEqual(route.a + 1);
    expect(s.velocity.length()).toBeCloseTo(route.speed, 3);
    m.runner.dispose?.();
  });

  it('A Stroll in the Park (peacetime): a cruise liner and a container ship sail the harbour lane, half a loop apart', () => {
    const stroll = (seed: number) => buildInstantMissionSeeded({ mode: 'stroll', theater: 'auckland', timeOfDay: 'night', weather: 'overcast', enemyType: 'mixed', enemyCount: 1 }, seed);
    const pts = lanePoints();
    const onLane = (s: GroundTargetEntity) => pts.some((p) => p.distanceTo(s.position) < 1);
    for (const seed of [1, 2, 3]) {
      const m = setup(stroll(seed));
      const lane = m.ships().filter((s) => s.path && s.speed === LANE_SPEED);
      expect(lane.map((s) => s.vessel).sort()).toEqual(['container', 'cruise']);
      for (const s of lane) expect(onLane(s)).toBe(true);
      const [a, b] = lane.map((s) => pts.findIndex((p) => p.distanceTo(s.position) < 1));
      const apart = Math.abs(a - b);
      expect(Math.min(apart, pts.length - apart)).toBeGreaterThan(pts.length * 0.45);
      // the wartime traffic is still there too, all of it named apart
      expect(m.ships().length).toBeGreaterThanOrEqual(3 + 2 + 1 + 2);
      expect(new Set(m.ships().map((s) => s.name)).size).toBe(m.ships().length);
      m.tick(60);
      for (const s of lane) {
        expect(s.alive).toBe(true);
        expect(s.velocity.length()).toBeCloseTo(LANE_SPEED, 3);
      }
      m.runner.dispose?.();
    }
    // a wartime sortie has nobody on the lane
    const war = setup(missionById('c01')!);
    expect(war.ships().filter((s) => s.speed === LANE_SPEED)).toHaveLength(0);
    war.runner.dispose?.();
  });

  it('no ships with civil traffic switched off', () => {
    const off = setup(missionById('c01')!, false);
    expect(off.ships()).toHaveLength(0);
    off.runner.dispose?.();
  });

  it('player sinks one: CIVILIAN SHIP DESTROYED, AWACS check-fire naming the vessel, no kill, penalty, debrief row', () => {
    const m = setup(missionById('c01')!);
    m.tick(1);
    const p = m.world.player!;
    const ship = m.ships().find((s) => s.vessel === 'cruise')!;
    m.world.applyDamage(ship, 1, p.id, 'gbu39'); // a near miss's worth of blast still sinks it
    m.tick(6);
    expect(ship.alive).toBe(false);
    expect(m.hud).toContain('CIVILIAN SHIP DESTROYED');
    expect(m.radio.some((t) => /check fire/i.test(t) && t.includes(`civilian vessel ${ship.name}`))).toBe(true);
    expect(m.radio.some((t) => /airliner|shot down civilian/i.test(t))).toBe(false);
    expect(p.kills).toBe(0);
    const r = m.runner.result(m.world) as MissionResultExt;
    expect(r.kills.ground).toBe(0);
    expect(r.civilianKills).toBe(1);
    expect(r.civilianShipKills).toBe(1);
    expect(civilLossRows(r)).toEqual([['skull', 'Civil ships destroyed', '1']]);
    m.runner.dispose?.();
  });

  it('an airliner and a ship: both counted as civilian losses, shown on separate debrief rows', () => {
    const m = setup(missionById('c01')!);
    m.tick(1);
    const p = m.world.player!;
    const civ = m.world.aircraft.find((a) => a.civil)!;
    m.world.applyDamage(civ, 10_000, p.id, 'gun');
    m.world.applyDamage(m.ships()[0], 50, p.id, 'gbu31');
    m.tick(6);
    const r = m.runner.result(m.world) as MissionResultExt;
    expect(r.civilianKills).toBe(2);
    expect(r.civilianShipKills).toBe(1);
    expect(civilLossRows(r)).toEqual([
      ['skull', 'Civil airliners downed', '1'],
      ['skull', 'Civil ships destroyed', '1'],
    ]);
    expect(m.hud).toContain('CIVILIAN AIRLINER DOWN');
    expect(m.hud).toContain('CIVILIAN SHIP DESTROYED');
    m.runner.dispose?.();
  });

  it('a ship lost to somebody else is reported, but is not the player’s civilian loss', () => {
    const m = setup(missionById('c01')!);
    m.tick(1);
    const ship = m.ships()[0];
    m.world.applyDamage(ship, 50, null, 'gbu31');
    m.tick(2);
    expect(ship.alive).toBe(false);
    expect(m.radio.some((t) => /check fire/i.test(t))).toBe(false);
    const r = m.runner.result(m.world) as MissionResultExt;
    expect(r.civilianKills ?? 0).toBe(0);
    expect(r.civilianShipKills ?? 0).toBe(0);
    m.runner.dispose?.();
  });
});

describe('scoring', () => {
  it('a civil ship costs the same as an airliner (POINTS.civilian) and lowers the rating', () => {
    const base = {
      success: true, time: 300, parTime: 480, kills: { air: 0, sam: 0, ground: 2 }, enemiesSpawned: 2, objectiveBonus: 500,
      primaryDone: 1, primaryTotal: 1, secondaryDone: 0, secondaryTotal: 0, shotsFired: 2, hits: 2, damageTaken: 0,
      friendlyLosses: 0, bonus: 0, scoreMultiplier: 1,
    };
    const clean = computeScore(base);
    const dirty = computeScore({ ...base, civilianKills: 1 });
    expect(clean.score - dirty.score).toBe(POINTS.civilian);
    expect(dirty.rating).toBeLessThan(clean.rating);
  });
});

/* ───────────────────────── hull hit volume ───────────────────────── */

describe('civil ship hull', () => {
  it('distance is measured to the long hull, not a bounding sphere', () => {
    const w = seaWorld();
    const s = spawnShip(w, 'container', 0, 0, 90); // bow east
    const { length: L, beam: B, height: H } = VESSEL_DATA.container;
    expect(vesselHullDistance(s, new Vector3(0, 5, 0))).toBe(0);
    expect(vesselHullDistance(s, new Vector3(L / 2 - 2, 5, 0))).toBe(0); // at the bow
    expect(vesselHullDistance(s, new Vector3(L / 2 + 20, 5, 0))).toBeCloseTo(20, 0);
    expect(vesselHullDistance(s, new Vector3(0, 5, -(B / 2 + 30)))).toBeCloseTo(30, 5); // abeam
    expect(vesselHullDistance(s, new Vector3(0, H + 25, 0))).toBeCloseTo(25, 5); // above the bridge
    // a gun round crossing amidships hits; one passing 25 m abeam or above the superstructure misses
    expect(vesselSegmentHit(s, new Vector3(0, 10, -60), new Vector3(0, 10, -10))).toBeGreaterThan(0);
    expect(vesselSegmentHit(s, new Vector3(-50, 10, -B / 2 - 25), new Vector3(50, 10, -B / 2 - 25))).toBe(-1);
    expect(vesselSegmentHit(s, new Vector3(-50, H + 10, 0), new Vector3(50, H + 10, 0))).toBe(-1);
  });
});

/* ───────────────────────── damage: one hit sinks, the gun accumulates ───────────────────────── */

describe('civil ship damage', () => {
  it('any bomb / missile damage sinks it; gun damage accumulates over ~2–3 passes', () => {
    const w = seaWorld();
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 3000, 10_000), heading: 0, speed: 230, loadout: 'strike_stealth' });
    const a = spawnShip(w, 'container', 0, -2000);
    expect(a.destroyedAt).toBe(-1);
    run(w, 1);
    w.applyDamage(a, 3, p.id, 'gbu39');
    expect(a.alive).toBe(false);
    expect(a.destroyedAt).toBeCloseTo(w.time, 6); // paces the sinking animation
    const b = spawnShip(w, 'cruise', 2000, -2000, 0, 'Southern Barnacle');
    w.applyDamage(b, 5, p.id, 'aargm');
    expect(b.alive).toBe(false);

    const c = spawnShip(w, 'cruise', 4000, -2000, 0, 'Pacific Interislander');
    // one full GAU-22 pass: ~1.5 s at 55 rds/s, ~1,300–1,400 damage on the hull (measured below)
    const pass = () => {
      for (let i = 0; i < 70; i++) w.applyDamage(c, 20, p.id, 'gun');
    };
    pass();
    expect(c.alive).toBe(true);
    expect(c.health).toBeLessThan(c.maxHealth);
    pass();
    expect(c.alive).toBe(true);
    pass();
    expect(c.alive).toBe(false); // the third pass sinks it
  });

  it('a real JDAM released on a designated ship sinks it with one hit', () => {
    const w = seaWorld(4);
    const ship = spawnShip(w, 'container', 0, -8_000, 90);
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 6_000, 0), heading: 0, speed: 250, loadout: 'strike_stealth' });
    expect(p.selectedWeapon).toBe('gbu31');
    expect(p.radar.mode).toBe('ground');
    run(w, 1);
    expect(p.radar.contacts.some((c) => c.id === ship.id && c.team === 'neutral')).toBe(true);
    expect(p.radar.designatedId).not.toBe(ship.id); // never auto-designated
    w.combat.designate(p, ship.id, w);
    const destroyed: GameEventMap['destroyed'][] = [];
    w.events.on('destroyed', (e) => destroyed.push(e));
    const launches: GameEventMap['munition:launch'][] = [];
    w.events.on('munition:launch', (e) => launches.push(e));
    w.combat.fire(p, w, 'gbu31', ship.id); // released once the bay doors are open
    run(w, 90, () => !ship.alive);
    expect(launches).toHaveLength(1);
    expect(launches[0].targetId).toBe(ship.id);
    expect(ship.alive).toBe(false);
    const d = destroyed.find((e) => e.entity === ship)!;
    expect(d.attackerId).toBe(p.id);
    expect(d.weapon).toBe('gbu31');
    expect(p.kills).toBe(0); // never a kill
    expect(p.hits).toBe(0); // nor a hit for the accuracy stat
  });

  it('real strafing passes: the gun only wears a cruise liner down, ~2–3 full passes to sink it', () => {
    const w = seaWorld(2);
    const ship = spawnShip(w, 'cruise', 0, -1_500, 0, 'Southern Barnacle');
    const target = new Vector3(0, 15, -1_500);
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 200, 0), heading: 0, speed: 200, loadout: 'a2a_stealth' });
    p.gunAmmo = 10_000; // ammo is not what this measures
    let dmg = 0;
    w.events.on('damage', (e) => {
      if (e.target === ship && e.weapon === 'gun') dmg += e.amount;
    });
    const _d = new Vector3();
    // the pilot holds the pipper on the ship's waterline amidships for a 1.5 s burst from ~1.5 km
    const pass = (): number => {
      const before = dmg;
      p.position.set(0, 200, 0);
      p.input.fireGun = true;
      run(w, 1.5, () => {
        _d.subVectors(target, p.position).normalize();
        p.quaternion.setFromUnitVectors(new Vector3(0, 0, -1), _d);
        p.velocity.copy(_d).multiplyScalar(200);
      });
      p.input.fireGun = false;
      run(w, 2);
      return dmg - before;
    };
    const first = pass();
    expect(first).toBeGreaterThan(ship.maxHealth / 3);
    expect(first).toBeLessThan(ship.maxHealth / 2);
    expect(ship.alive).toBe(true);
    pass();
    expect(ship.alive).toBe(true);
    pass();
    expect(ship.alive).toBe(false);
  });
});

/* ───────────────────────── sensors and targeting ───────────────────────── */

describe('sensors: ground mode / EOTS only, always ranked last', () => {
  it('TGT cycling and auto-designation go through every hostile before the (closer) civil ship', () => {
    const w = seaWorld(6);
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 5_000, 0), heading: 0, speed: 240, loadout: 'strike_stealth' });
    // range order: corvette 531, the civil ship, corvette 532
    const cv1 = w.spawnGround({ type: 'ship', team: 'red', position: new Vector3(-400, 0, -6_000), heading: 0, name: 'Corvette 531' });
    const ship = spawnShip(w, 'container', 300, -10_000, 90);
    const cv2 = w.spawnGround({ type: 'ship', team: 'red', position: new Vector3(200, 0, -16_000), heading: 0, name: 'Corvette 532' });
    expect(p.radar.mode).toBe('ground');
    run(w, 1);
    const ids = p.radar.contacts.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([cv1.id, ship.id, cv2.id]));
    expect(p.radar.designatedId).toBe(cv1.id); // auto-designation: a hostile, never the ship
    // TGT: lock the boxed corvette, then step on — the far corvette comes before the nearer ship
    const order: (number | null)[] = [];
    for (let i = 0; i < 4; i++) {
      w.combat.cycleTarget(p, w);
      order.push(p.radar.designatedId);
    }
    expect(order).toEqual([cv1.id, cv2.id, ship.id, cv1.id]);
  });

  it('with the corvette dead the ship can still be cycled to, but is never auto-designated', () => {
    const w = seaWorld(7);
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 5_000, 0), heading: 0, speed: 240, loadout: 'strike_stealth' });
    const ship = spawnShip(w, 'cruise', 0, -9_000, 90, 'Southern Barnacle');
    run(w, 2);
    expect(p.radar.contacts.some((c) => c.id === ship.id)).toBe(true);
    expect(p.radar.designatedId).toBeNull();
    w.combat.cycleTarget(p, w);
    expect(p.radar.designatedId).toBe(ship.id);
  });

  it('never an A/A candidate: in air mode TGT ignores it even though EOTS sees it', () => {
    const w = seaWorld(8);
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 5_000, 0), heading: 0, speed: 240, loadout: 'a2a_stealth' });
    const ship = spawnShip(w, 'container', 0, -9_000, 90);
    expect(p.radar.mode).not.toBe('ground');
    run(w, 1);
    expect(p.radar.contacts.some((c) => c.id === ship.id && c.source === 'eots')).toBe(true);
    w.combat.cycleTarget(p, w);
    run(w, 0.5);
    expect(p.radar.designatedId).toBeNull();
  });

  it('HUD labels: CIV on the HMD, the ship name and status in the PiP', () => {
    const w = seaWorld();
    const ship = spawnShip(w, 'cruise', 0, -9_000, 90, 'Southern Barnacle');
    const corvette = w.spawnGround({ type: 'ship', team: 'red', position: new Vector3(0, 0, -16_000) });
    expect(entityLabel(ship)).toBe('CIV');
    expect(entityLabel(corvette)).toBe('SHIP');
    expect(pipName(ship)).toBe('SOUTHERN BARNACLE');
    expect(pipStatus(ship, new Vector3()).text).toBe('MOORED');
    ship.anchored = true;
    expect(pipStatus(ship, new Vector3()).text).toBe('ANCHORED');
    ship.anchored = false;
    expect(pipStatus(ship, new Vector3(), true).text).toBe('CHECK FIRE');
  });
});

/* ───────────────────────── nobody else engages them ───────────────────────── */

describe('AI never targets civil ships', () => {
  it('AI crews (blue wingman, red fighter) never track one; nothing is launched at it', () => {
    const w = seaWorld(9);
    const ship = spawnShip(w, 'container', 0, -6_000, 90);
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 5_000, 4_000), heading: 0, speed: 240, loadout: 'strike_stealth' });
    const wing = w.spawnAircraft({ type: 'f35a', team: 'blue', position: new Vector3(300, 5_000, 4_200), heading: 0, speed: 240, callsign: 'Viper 2', leaderId: p.id, loadout: 'strike_stealth', ai: createAiBrain('wingman', { skill: 0.9, seed: 3 }) });
    const striker = w.spawnAircraft({ type: 'f35a', team: 'blue', position: new Vector3(-2_000, 5_000, 3_000), heading: 0, speed: 240, callsign: 'Hammer 1', loadout: 'sead_stealth', ai: createAiBrain('fighter', { skill: 0.9, seed: 4 }) });
    const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: new Vector3(0, 3_000, -9_000), heading: 0, speed: 230, ai: createAiBrain('fighter', { skill: 0.9, seed: 5 }) });
    w.spawnSam({ type: 'sa6', team: 'red', position: new Vector3(3_000, 0, -7_000), known: true });
    let launchesAtShip = 0;
    w.events.on('munition:launch', (e) => {
      if (e.targetId === ship.id) launchesAtShip++;
    });
    let tracked = false;
    let playerSaw = false;
    run(w, 60, () => {
      for (const ac of [wing, striker, mig]) if (ac.radar.contacts.some((c) => c.id === ship.id) || ac.radar.designatedId === ship.id) tracked = true;
      if (p.radar.contacts.some((c) => c.id === ship.id)) playerSaw = true;
    });
    expect(tracked).toBe(false);
    expect(launchesAtShip).toBe(0);
    expect(ship.alive).toBe(true);
    expect(ship.health).toBe(ship.maxHealth);
    // the player's own sensors had it, but the datalink never passed it on to the AI crews
    expect(playerSaw).toBe(true);
  });

  it('an AARGM never homes on a civil ship, designated or not', () => {
    const w = seaWorld(10);
    const ship = spawnShip(w, 'container', 0, -12_000, 90);
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 6_000, 0), heading: 0, speed: 250, loadout: 'sead_stealth' });
    expect(p.selectedWeapon).toBe('aargm');
    run(w, 1);
    const launches: GameEventMap['munition:launch'][] = [];
    w.events.on('munition:launch', (e) => launches.push(e));
    const denied: string[] = [];
    w.events.on('weapon:denied', (e) => denied.push(e.reason));
    w.combat.designate(p, ship.id, w);
    w.combat.fire(p, w, 'aargm', ship.id);
    run(w, 3);
    w.combat.designate(p, null, w);
    w.combat.fire(p, w, 'aargm');
    run(w, 3);
    expect(launches.filter((l) => l.targetId === ship.id)).toHaveLength(0);
    expect(denied.length).toBeGreaterThan(0); // no emitter to home on: the release is denied
  });
});
