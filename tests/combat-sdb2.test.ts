/**
 * GBU-53/B StormBreaker (SDB II), issue #45: a datalinked glide bomb with a tri-mode terminal seeker.
 * It follows moving ships (civil or hostile), still hits a radar that shuts down, never retargets,
 * has the SDB's glide envelope, a warhead too small for a bunker, and no CCIP mode.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus, type GameEventMap } from '../src/core/events';
import { DIFFICULTIES, LOADOUTS } from '../src/core/data';
import type { LoadoutId, VesselClass } from '../src/core/types';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { MUNITIONS } from '../src/sim/weapons/defs';
import { gpsMaxRange } from '../src/sim/weapons/dlz';
import { createAiBrain } from '../src/ai';
import type { SimWorld } from '../src/sim/api';
import type { AircraftEntity, GroundTargetEntity, MissileEntity } from '../src/sim/entities';
import { SHIP_ROUTES, routePoints } from '../src/missions/runtime/shipping';
import { CAMPAIGN, TRAINING, buildInstantMissionSeeded, createMissionRunner, missionById } from '../src/missions';
import type { MissionResultExt } from '../src/missions/runtime/resultExt';
import { civilLossRows } from '../src/ui/screens/debrief';
import { validateMission } from '../src/missions/validate';
import { FlatTerrain } from './combat-helpers';

const DEG = Math.PI / 180;
const DT = 1 / 60;

/** Open sea (`land` = flat ground at sea level instead). */
function makeWorld(seed = 1, land = false): SimWorld {
  return createSimWorld({ terrain: new FlatTerrain(land ? 0 : -20), difficulty: DIFFICULTIES.pilot, events: new EventBus(), combat: createCombatSystemSeeded(seed) });
}

function run(world: SimWorld, seconds: number, each?: () => boolean | void): void {
  for (let i = 0; i < seconds * 60; i++) {
    world.step(DT);
    if (each?.()) return;
  }
}

/** Player F-35 `range` m south of `at` (horizontally), heading at it. */
function jetToward(w: SimWorld, at: Vector3, range: number, alt: number, loadout: LoadoutId): AircraftEntity {
  return w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(at.x, alt, at.z + range), heading: 0, speed: 250, loadout });
}

function civilShip(w: SimWorld, vessel: VesselClass, pos: Vector3, headingDeg = 90, extra: { path?: Vector3[]; speed?: number } = {}): GroundTargetEntity {
  const e = w.spawnGround({ type: 'ship', team: 'neutral', vessel, position: pos.clone(), heading: headingDeg * DEG, name: 'MV Kōtuku Trader', groupId: 'civil-ship', loopPath: !!extra.path, ...extra });
  e.known = false;
  return e;
}

/** Release `weapon` at `target` (waits for the bay doors) and return the munition. */
function release(w: SimWorld, p: AircraftEntity, weapon: 'gbu53' | 'gbu39', targetId: number): MissileEntity {
  const launches: MissileEntity[] = [];
  const off = w.events.on('munition:launch', (e) => launches.push(e.missile));
  w.combat.fire(p, w, weapon, targetId);
  run(w, 3, () => launches.length > 0);
  off?.();
  expect(launches).toHaveLength(1);
  return launches[0];
}

/** A moving container ship on the first SHIP_ROUTES loop, starting on its long straight leg. */
function routeShip(w: SimWorld): GroundTargetEntity {
  const r = SHIP_ROUTES[0];
  const pts = routePoints(r);
  const k = pts.length / 4; // t = π/2: the end of the minor axis, steaming along the long axis
  const path = [...pts.slice(k), ...pts.slice(0, k)];
  return civilShip(w, r.vessel, path[0], 0, { path, speed: r.speed });
}

describe('GBU-53 StormBreaker: moving and moored civil ships', () => {
  it('sinks a designated civil ship steaming round a SHIP_ROUTES loop from ≥ 20 km; a GBU-39 misses it', () => {
    const outcome = (weapon: 'gbu53' | 'gbu39') => {
      const w = makeWorld(3);
      const ship = routeShip(w);
      run(w, 0.5);
      const p = jetToward(w, ship.position, 22_000, 8_000, weapon === 'gbu53' ? 'strike_sdb2' : 'sead_stealth');
      run(w, 1);
      w.combat.designate(p, ship.id, w);
      run(w, 0.5);
      const range = Math.hypot(ship.position.x - p.position.x, ship.position.z - p.position.z);
      expect(range).toBeGreaterThanOrEqual(20_000);
      const m = release(w, p, weapon, ship.id);
      expect(m.targetId).toBe(ship.id);
      run(w, 200, () => !m.alive);
      expect(m.alive).toBe(false);
      return ship.alive;
    };
    expect(outcome('gbu53')).toBe(false); // sunk
    expect(outcome('gbu39')).toBe(true); // flew to where the ship was at release
  });

  it('sinks a moored civil ship from ≥ 20 km: check-fire naming it, civilian penalty, debrief row', () => {
    const def = missionById('c06')!; // Strait Shooter allows the SDB II
    expect(def.allowedLoadouts).toContain('strike_sdb2');
    const events = new EventBus();
    const world = createSimWorld({ terrain: new FlatTerrain(-20), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(5) });
    const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty: DIFFICULTIES.pilot, events });
    runner.setup(world, 'strike_sdb2');
    const radio: string[] = [];
    const hud: string[] = [];
    events.on('radio', (e) => radio.push(e.text));
    events.on('hud:message', (e) => hud.push(e.text));
    const tick = (seconds: number, until?: () => boolean) => {
      for (let i = 0; i < seconds * 60 && runner.state === 'running'; i++) {
        world.step(DT);
        runner.update(world, DT);
        if (until?.()) return;
      }
    };
    tick(1);
    const ship = world.ground.find((g) => g.team === 'neutral' && g.vessel && !g.path)!;
    expect(ship).toBeDefined();
    // put the player 21 km south of the ship at 8 km, nose on, out of everybody's way
    const p = world.player!;
    p.position.set(ship.position.x, 8_000, ship.position.z + 21_000);
    p.velocity.set(0, 0, -250);
    p.quaternion.identity();
    p.input.throttle = 0.85;
    world.combat.designate(p, ship.id, world);
    const launches: MissileEntity[] = [];
    events.on('munition:launch', (e) => launches.push(e.missile));
    world.combat.fire(p, world, 'gbu53', ship.id);
    tick(3, () => launches.length > 0);
    expect(launches).toHaveLength(1);
    const m = launches[0];
    tick(200, () => !m.alive);
    tick(6);
    expect(ship.alive).toBe(false);
    expect(hud).toContain('CIVILIAN SHIP DESTROYED');
    expect(radio.some((t) => /check fire/i.test(t) && t.includes(`civilian vessel ${ship.name}`))).toBe(true);
    const r = runner.result(world) as MissionResultExt;
    expect(r.civilianShipKills).toBe(1);
    expect(civilLossRows(r)).toEqual([['skull', 'Civil ships destroyed', '1']]);
    runner.dispose?.();
  });
});

describe('GBU-53 StormBreaker: hostile targets', () => {
  it('two GBU-53s sink a moving corvette (Strait Shooter patrol line, 400 HP; one hit is ~250)', () => {
    const w = makeWorld(7);
    const a = new Vector3(17_000, 0, -500);
    const b = new Vector3(24_000, 0, 1_000);
    const cv = w.spawnGround({ type: 'ship', team: 'red', position: b.clone(), name: 'Corvette 531', path: [a, b], loopPath: true, speed: 1 });
    // a faster patrol than the mission's 1 m/s, to make the moving-target part count
    cv.speed = 6;
    run(w, 0.5);
    const p = jetToward(w, cv.position, 20_000, 8_000, 'strike_sdb2');
    run(w, 1);
    w.combat.designate(p, cv.id, w);
    const m1 = release(w, p, 'gbu53', cv.id);
    run(w, 4);
    const m2 = release(w, p, 'gbu53', cv.id);
    run(w, 200, () => !m1.alive && !m2.alive);
    expect(cv.alive).toBe(false);
  });

  it('datalink: follows a corvette that turns back at the end of its patrol line after release', () => {
    const w = makeWorld(9);
    const a = new Vector3(-3_000, 0, 0);
    const b = new Vector3(400, 0, 0);
    // 400 m short of the turn at 8 m/s: it reverses ~50 s into a ~90 s glide, so a bomb flying to
    // the extrapolated launch track would land ~800 m from it
    const cv = w.spawnGround({ type: 'ship', team: 'red', position: new Vector3(0, 0, 0), name: 'Corvette 531', path: [b, a], loopPath: true, speed: 8 });
    run(w, 0.2);
    expect(cv.velocity.x).toBeGreaterThan(7);
    const p = jetToward(w, cv.position, 20_000, 8_000, 'strike_sdb2');
    run(w, 1);
    w.combat.designate(p, cv.id, w);
    const m = release(w, p, 'gbu53', cv.id);
    run(w, 200, () => !m.alive);
    expect(cv.velocity.x).toBeLessThan(0); // it did turn back
    expect(cv.health).toBeLessThan(cv.maxHealth);
  });

  it('terminal seeker: the launcher is shot down after release and the target then stops; the seeker still finds it', () => {
    const w = makeWorld(10);
    const cv = w.spawnGround({ type: 'ship', team: 'red', position: new Vector3(0, 0, 0), name: 'Corvette 531', path: [new Vector3(-5_000, 0, 0)], speed: 7 });
    run(w, 0.2);
    const p = jetToward(w, cv.position, 20_000, 8_000, 'strike_sdb2');
    run(w, 1);
    w.combat.designate(p, cv.id, w);
    const m = release(w, p, 'gbu53', cv.id);
    run(w, 2);
    w.applyDamage(p, 10_000, null, 'gun'); // no more datalink
    run(w, 40);
    cv.speed = 0; // all stop: the extrapolated estimate runs on, ~7 m/s × 50 s ahead of the ship
    run(w, 200, () => !m.alive);
    expect(p.alive).toBe(false);
    expect(cv.health).toBeLessThan(cv.maxHealth);
  });

  it('one GBU-53 never destroys a bunker', () => {
    const w = makeWorld(2, true);
    const bunker = w.spawnGround({ type: 'bunker', team: 'red', position: new Vector3(0, 0, 0), name: 'Bunker' });
    const p = jetToward(w, bunker.position, 15_000, 7_000, 'strike_sdb2');
    run(w, 1);
    w.combat.designate(p, bunker.id, w);
    const m = release(w, p, 'gbu53', bunker.id);
    run(w, 200, () => !m.alive);
    expect(bunker.health).toBeLessThan(bunker.maxHealth); // hit
    expect(bunker.alive).toBe(true);
    expect(MUNITIONS.gbu53.damage).toBeLessThan(bunker.maxHealth);
  });

  it('still hits an EWR that switches its radar off right after release', () => {
    const w = makeWorld(4, true);
    const ewr = w.spawnGround({ type: 'ewr', team: 'red', position: new Vector3(2_000, 0, -3_000), name: 'EWR' });
    const p = jetToward(w, ewr.position, 20_000, 8_000, 'strike_sdb2');
    run(w, 1);
    w.combat.designate(p, ewr.id, w);
    const m = release(w, p, 'gbu53', ewr.id);
    ewr.emitter = false; // EMCON
    run(w, 200, () => !m.alive);
    expect(ewr.alive).toBe(false);
  });
});

describe('GBU-53 StormBreaker: never retargets', () => {
  it('a GBU-53 at a hostile corvette leaves a civil ship near its path untouched', () => {
    const w = makeWorld(6);
    const cv = w.spawnGround({ type: 'ship', team: 'red', position: new Vector3(0, 0, 0), name: 'Corvette 531' });
    // a cruise liner steaming across the bomb's track, 3 km short of the corvette, and a container
    // ship lying 180 m beyond it
    const crosser = civilShip(w, 'cruise', new Vector3(-1_500, 0, 3_000), 90, { path: [new Vector3(-1_500, 0, 3_000), new Vector3(4_000, 0, 3_000)], speed: 5 });
    const beyond = civilShip(w, 'container', new Vector3(0, 0, -200), 90);
    const p = jetToward(w, cv.position, 20_000, 8_000, 'strike_sdb2');
    run(w, 1);
    w.combat.designate(p, cv.id, w);
    const m = release(w, p, 'gbu53', cv.id);
    run(w, 200, () => {
      expect(m.targetId).toBe(cv.id);
      return !m.alive;
    });
    expect(cv.health).toBeLessThan(cv.maxHealth);
    expect(crosser.alive).toBe(true);
    expect(beyond.alive).toBe(true);
    expect(crosser.health).toBe(crosser.maxHealth);
    expect(beyond.health).toBe(beyond.maxHealth);
  });

  it('a GBU-53 whose target is destroyed in flight goes off at the last point, not on the nearby ship', () => {
    const w = makeWorld(8);
    const cv = w.spawnGround({ type: 'ship', team: 'red', position: new Vector3(0, 0, 0), name: 'Corvette 531' });
    const other = w.spawnGround({ type: 'ship', team: 'red', position: new Vector3(400, 0, 0), name: 'Corvette 532' });
    const civ = civilShip(w, 'container', new Vector3(-450, 0, 0), 0);
    const p = jetToward(w, cv.position, 18_000, 8_000, 'strike_sdb2');
    run(w, 1);
    w.combat.designate(p, cv.id, w);
    const m = release(w, p, 'gbu53', cv.id);
    run(w, 20);
    w.applyDamage(cv, 10_000, null, 'gbu31'); // somebody else sinks it first
    const ends: GameEventMap['munition:end'][] = [];
    w.events.on('munition:end', (e) => ends.push(e));
    run(w, 200, () => !m.alive);
    expect(ends).toHaveLength(1);
    expect(m.targetId).toBe(cv.id);
    expect(Math.hypot(ends[0].position.x, ends[0].position.z)).toBeLessThan(60);
    expect(other.health).toBe(other.maxHealth);
    expect(civ.alive).toBe(true);
    expect(civ.health).toBe(civ.maxHealth);
  });
});

describe('GBU-53 StormBreaker: release rules and envelope', () => {
  it('denied with NO TARGET without a designation (no CCIP drop) and OUT OF RANGE beyond the envelope', () => {
    const w = makeWorld(1, true);
    const ewr = w.spawnGround({ type: 'ewr', team: 'red', position: new Vector3(0, 0, 0), name: 'EWR' });
    const p = jetToward(w, ewr.position, 45_000, 6_000, 'strike_sdb2');
    expect(p.selectedWeapon).toBe('gbu53');
    run(w, 1);
    const denied: string[] = [];
    w.events.on('weapon:denied', (e) => denied.push(e.reason));
    w.combat.designate(p, null, w);
    expect(w.combat.fire(p, w, 'gbu53')).toBeNull();
    expect(w.combat.bombImpactPoint(p, w)).toBeNull(); // no CCIP pipper either
    expect(w.combat.fire(p, w, 'gbu53', ewr.id)).toBeNull();
    run(w, 2);
    expect(denied).toEqual(['NO TARGET', 'OUT OF RANGE']);
    expect(w.missiles.filter((m) => m.alive)).toHaveLength(0);
    expect(w.combat.remaining(p, 'gbu53')).toBe(4);
  });

  it('glide envelope at 250 m/s: ≥ 20 km from 6 km, ≥ 28 km from 10 km (about SDB parity)', () => {
    expect(gpsMaxRange(MUNITIONS.gbu53, 6_000, 250, 0)).toBeGreaterThanOrEqual(20_000);
    expect(gpsMaxRange(MUNITIONS.gbu53, 10_000, 250, 0)).toBeGreaterThanOrEqual(28_000);
    expect(gpsMaxRange(MUNITIONS.gbu53, 10_000, 250, 0)).toBeLessThanOrEqual(gpsMaxRange(MUNITIONS.gbu39, 10_000, 250, 0) * 1.05);
  });
});

describe('strike_sdb2 loadout', () => {
  it('4× GBU-53 + 2× AIM-120D internal, offered wherever strike_stealth / sead_stealth are, never in A/A-only missions', () => {
    const l = LOADOUTS.strike_sdb2;
    expect(l.stores).toEqual([
      { weapon: 'gbu53', count: 4, internal: true },
      { weapon: 'aim120', count: 2, internal: true },
    ]);
    expect(l.rcsMultiplier).toBe(1);
    expect(l.role).toBe('ag');
    const instant = (['strike', 'sam_gauntlet', 'dogfight'] as const).map((mode) =>
      buildInstantMissionSeeded({ mode, theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mig29', enemyCount: 2 }, 3),
    );
    let withIt = 0;
    for (const m of [...CAMPAIGN, ...TRAINING, ...instant]) {
      const ag = m.allowedLoadouts.includes('strike_stealth') || m.allowedLoadouts.includes('sead_stealth');
      expect(m.allowedLoadouts.includes('strike_sdb2'), m.id).toBe(ag);
      if (ag) withIt++;
      expect(validateMission(m), m.id).toEqual([]);
    }
    expect(withIt).toBeGreaterThanOrEqual(8);
  });
});

/**
 * Playtest 2.1-a: StormBreakers released on the IN RANGE cue landed ~0.5 km short of a moving ship
 * (c06 Strait Shooter). The cue's reach (gpsMaxRange) must be one the flight law delivers: release on
 * the first IN RANGE frame (and at 80 % of it) from the mission altitudes, against a slow and a 5 m/s
 * ship crossing the bomb's track, and the bomb has to hit it.
 */
describe('GBU-53 StormBreaker: the IN RANGE cue is a range the bomb reaches (playtest 2.1-a)', () => {
  /** Fly a nose-on run at a ship; release on the cue (`frac` = 1) or at `frac` of the cue's range. */
  const shot = (alt: number, shipSpeed: number, frac: number, seed: number) => {
    const w = makeWorld(seed);
    // the ship steams across the bomb's track (east), well clear of the end of its path
    const cv = w.spawnGround({ type: 'ship', team: 'red', position: new Vector3(0, 0, 0), name: 'Corvette 531', path: [new Vector3(60_000, 0, 0)], speed: shipSpeed });
    run(w, 0.2);
    const p = jetToward(w, cv.position, 40_000, alt, 'strike_sdb2');
    p.input.throttle = 0.85;
    run(w, 0.5);
    w.combat.designate(p, cv.id, w);
    let cueRange = 0;
    // fly level at it (straight and level is what the jet already does) until the cue says so
    run(w, 200, () => {
      const b = w.combat.bombImpactPoint(p, w);
      const horiz = Math.hypot(cv.position.x - p.position.x, cv.position.z - p.position.z);
      if (b?.inRange && !cueRange) cueRange = horiz;
      return cueRange > 0 && horiz <= cueRange * frac;
    });
    expect(cueRange).toBeGreaterThan(10_000);
    const m = release(w, p, 'gbu53', cv.id);
    let end: Vector3 | null = null;
    w.events.on('munition:end', (e) => {
      if (e.missile === m) end = e.position.clone();
    });
    run(w, 250, () => !m.alive);
    const miss = end ? Math.hypot((end as Vector3).x - cv.position.x, (end as Vector3).z - cv.position.z) : Infinity;
    return { hit: cv.health < cv.maxHealth, miss: Math.round(miss), cueRange: Math.round(cueRange) };
  };
  it.each([
    [7_600, 1, 1],
    [7_600, 5, 1],
    [7_600, 1, 0.8],
    [7_600, 5, 0.8],
    [4_700, 5, 1],
    [4_700, 5, 0.8],
  ])('from %i m, ship at %i m/s, released at %f × the cue range: hits', (alt, speed, frac) => {
    const r = shot(alt, speed, frac, 11);
    expect(r, JSON.stringify(r)).toMatchObject({ hit: true });
  });
});

/**
 * Playtest 2.1-b: IN RANGE ignored where the target was: the bot tossed a second StormBreaker at a
 * ship 0.9 km behind it on egress and the bomb fell 2.4 km away. The cue now needs the target inside
 * a cone around the ground track that the weapon can turn to (wider for a winged glide bomb than a
 * JDAM) and outside the bomb's turn circle; off the cone it reads STEER, not a REL countdown.
 */
describe('GPS / glide bomb IN RANGE needs the target where the bomb can turn to (playtest 2.1-b)', () => {
  /** Jet flying north (−z) at `alt`; the target `d` m away, `deg` right of the ground track. */
  const cue = (weapon: 'gbu53' | 'gbu39' | 'gbu31', alt: number, d: number, deg: number) => {
    const w = makeWorld(1, true);
    const loadout: LoadoutId = weapon === 'gbu53' ? 'strike_sdb2' : weapon === 'gbu39' ? 'sead_stealth' : 'strike_stealth';
    const tgt = w.spawnGround({ type: 'ewr', team: 'red', position: new Vector3(0, 0, 0), name: 'EWR' });
    const p = jetToward(w, tgt.position, 5_000, alt, loadout);
    run(w, 1);
    w.combat.selectWeapon(p, weapon, w);
    w.combat.designate(p, tgt.id, w);
    run(w, 0.2);
    expect(p.radar.groundPoint).not.toBeNull();
    // then put the jet `d` m from it, the target `deg` right of the ground track (north)
    p.position.set(-Math.sin(deg * DEG) * d, alt, Math.cos(deg * DEG) * d);
    p.velocity.set(0, 0, -250);
    const b = w.combat.bombImpactPoint(p, w);
    expect(b).not.toBeNull();
    return { inRange: b!.inRange, offAxis: b!.offAxis, rel: b!.timeToRelease };
  };

  it('a StormBreaker / SDB: in range ahead and 45° off, not abeam, behind or past the target at low level', () => {
    for (const weapon of ['gbu53', 'gbu39'] as const) {
      expect(cue(weapon, 7_000, 15_000, 0), weapon).toMatchObject({ inRange: true, offAxis: false });
      expect(cue(weapon, 7_000, 15_000, 45), weapon).toMatchObject({ inRange: true, offAxis: false });
      expect(cue(weapon, 7_000, 15_000, 90), weapon).toMatchObject({ inRange: false, offAxis: true, rel: -1 });
      expect(cue(weapon, 7_000, 3_000, 160), weapon).toMatchObject({ inRange: false, offAxis: true });
      // the low-level toss: nose on at 1.2 km is fine; once past it (0.9 km behind, or 50° off at
      // 0.7 km, inside the bomb's turn circle) it is not
      expect(cue(weapon, 300, 1_200, 0), weapon).toMatchObject({ inRange: true });
      expect(cue(weapon, 400, 900, 180), weapon).toMatchObject({ inRange: false, offAxis: true });
      expect(cue(weapon, 400, 700, 50), weapon).toMatchObject({ inRange: false, offAxis: false, rel: -1 });
    }
  });

  it('a JDAM turns less: in range 20° off, STEER 45° off', () => {
    expect(cue('gbu31', 7_000, 6_000, 20)).toMatchObject({ inRange: true, offAxis: false });
    expect(cue('gbu31', 7_000, 6_000, 45)).toMatchObject({ inRange: false, offAxis: true, rel: -1 });
  });

  it('the REL countdown runs only toward a target the bomb can turn to', () => {
    const ahead = cue('gbu53', 7_000, 35_000, 10);
    expect(ahead.inRange).toBe(false);
    expect(ahead.rel).toBeGreaterThan(0);
    expect(cue('gbu53', 7_000, 35_000, 80)).toMatchObject({ inRange: false, offAxis: true, rel: -1 });
  });

  it('a StormBreaker released 60° off the nose turns onto the ship instead of orbiting it (c06: 14 km, 4,700 m)', () => {
    const w = makeWorld(12);
    const cv = w.spawnGround({ type: 'ship', team: 'red', position: new Vector3(0, 0, 0), name: 'Corvette 531', path: [new Vector3(60_000, 0, 0)], speed: 5 });
    run(w, 0.2);
    // 14 km from the ship, ground track 60° left of it
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 4_700, 14_000), heading: -60 * DEG, speed: 250, loadout: 'strike_sdb2' });
    run(w, 0.5);
    w.combat.designate(p, cv.id, w);
    const m = release(w, p, 'gbu53', cv.id);
    run(w, 200, () => !m.alive);
    expect(m.alive).toBe(false);
    expect(cv.health).toBeLessThan(cv.maxHealth);
  });
});
