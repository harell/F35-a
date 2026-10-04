/**
 * Neutral civil traffic (AeroFlop A320s at Auckland Airport): the 'neutral' team, the scripted
 * arrival / departure profiles, AI and SAMs ignoring airliners, and the player being able to
 * designate, shoot and destroy one (a civilian loss, never a kill).
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import { isHostile } from '../src/core/types';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createAiBrain } from '../src/ai';
import {
  A320_GEAR_HEIGHT,
  approachHeight,
  createArrival,
  createDeparture,
  placeCivil,
  thresholdOf,
  type Runway,
} from '../src/sim/civil/route';
import type { SimWorld } from '../src/sim/api';
import type { AircraftEntity } from '../src/sim/entities';
import { FlatTerrain } from './combat-helpers';
import { buildInstantMissionSeeded, createMissionRunner, missionById } from '../src/missions';
import type { MissionResultExt } from '../src/missions/runtime/resultExt';
import type { MissionDef } from '../src/core/contracts';
import { computeScore, POINTS } from '../src/missions/runtime/scoring';

const DEG = Math.PI / 180;
const DT = 1 / 60;
const ELEV = 7;

function makeWorld(seed = 1): SimWorld {
  return createSimWorld({ terrain: new FlatTerrain(ELEV), difficulty: DIFFICULTIES.pilot, events: new EventBus(), combat: createCombatSystemSeeded(seed) });
}

const RUNWAY: Runway = { x: 0, z: 0, heading: 250 * DEG, length: 3_600, elevation: ELEV };

function spawnCivil(world: SimWorld, kind: 'arrival' | 'departure', distance = 12_000): AircraftEntity {
  const f = kind === 'arrival' ? createArrival(RUNWAY, distance, A320_GEAR_HEIGHT) : createDeparture(RUNWAY, 195 * DEG, 7_000, A320_GEAR_HEIGHT);
  const ac = world.spawnAircraft({ type: 'a320', team: 'neutral', position: new Vector3(0, 500, 0), heading: f.heading, speed: 70, callsign: 'AeroFlop 421', ai: null });
  placeCivil(ac, f);
  return ac;
}

function run(world: SimWorld, seconds: number, each?: () => boolean | void): void {
  for (let i = 0; i < seconds * 60; i++) {
    world.step(DT);
    if (each?.()) return;
  }
}

describe('neutral team', () => {
  it('nobody is hostile to neutrals, blue and red are hostile to each other', () => {
    expect(isHostile('blue', 'red')).toBe(true);
    expect(isHostile('red', 'blue')).toBe(true);
    expect(isHostile('blue', 'blue')).toBe(false);
    expect(isHostile('blue', 'neutral')).toBe(false);
    expect(isHostile('red', 'neutral')).toBe(false);
    expect(isHostile('neutral', 'red')).toBe(false);
  });

  it("neutrals are in neither side's hostile list", () => {
    const w = makeWorld();
    const civ = spawnCivil(w, 'arrival');
    expect(w.hostilesOf('blue')).not.toContain(civ);
    expect(w.hostilesOf('red')).not.toContain(civ);
  });
});

describe('scripted civil flight profiles', () => {
  it('approach height follows the 3° glide slope and flares smoothly to the touchdown point', () => {
    expect(approachHeight(-10_000)).toBeCloseTo(10_000 * Math.tan(3 * DEG), 3);
    expect(approachHeight(0)).toBe(0);
    let prev = approachHeight(-400);
    for (let s = -399; s <= 0; s++) {
      const h = approachHeight(s);
      expect(h).toBeLessThanOrEqual(prev + 1e-9); // monotonic descent through the flare
      prev = h;
    }
  });

  it('an arrival flies the glide path, touches down beyond the threshold, rolls out and vacates', () => {
    const w = makeWorld();
    const ac = spawnCivil(w, 'arrival', 12_000);
    const thr = thresholdOf(RUNWAY);
    const start = ac.position.clone();
    expect(start.y - ELEV - A320_GEAR_HEIGHT).toBeCloseTo((12_000 - 0) * Math.tan(3 * DEG), 0);
    let touchdown: Vector3 | null = null;
    let minAgl = Infinity;
    run(w, 400, () => {
      const f = ac.civil!;
      minAgl = Math.min(minAgl, ac.position.y - ELEV);
      if (!touchdown && f.phase === 'rollout') touchdown = ac.position.clone();
      return !w.aircraft.includes(ac);
    });
    expect(touchdown).not.toBeNull();
    const along = touchdown!.clone().sub(thr).setY(0).length();
    expect(along).toBeGreaterThan(150);
    expect(along).toBeLessThan(600);
    expect(minAgl).toBeCloseTo(A320_GEAR_HEIGHT, 1); // wheels on the runway, never below it
    expect(ac.gear).toBe(1);
    expect(ac.alive).toBe(true);
    expect(w.aircraft).not.toContain(ac); // vacated and removed (no player around)
  });

  it('a departure rolls, rotates, raises the gear, climbs and turns onto its exit heading', () => {
    const w = makeWorld();
    const ac = spawnCivil(w, 'departure');
    expect(ac.position.y).toBeCloseTo(ELEV + A320_GEAR_HEIGHT, 3);
    let liftoffAt = -1;
    run(w, 240, () => {
      if (liftoffAt < 0 && ac.position.y > ELEV + A320_GEAR_HEIGHT + 1) liftoffAt = w.time;
    });
    expect(liftoffAt).toBeGreaterThan(25);
    expect(liftoffAt).toBeLessThan(50);
    expect(ac.gear).toBe(0);
    expect(ac.position.y).toBeGreaterThan(2_000);
    const err = Math.abs(Math.atan2(Math.sin(ac.civil!.heading - 195 * DEG), Math.cos(ac.civil!.heading - 195 * DEG)));
    expect(err).toBeLessThan(2 * DEG);
  });
});

describe('who engages airliners', () => {
  it('a red fighter AI and a red SAM site ignore an airliner flying past them', () => {
    const w = makeWorld(3);
    const civ = spawnCivil(w, 'arrival', 20_000);
    const p = civ.position;
    w.spawnAircraft({ type: 'mig29', team: 'red', position: new Vector3(p.x + 3_000, p.y, p.z + 2_000), heading: 0, speed: 220, ai: createAiBrain('fighter', { skill: 0.9, seed: 7 }) });
    w.spawnSam({ type: 'sa6', team: 'red', position: new Vector3(p.x + 2_000, 0, p.z + 6_000), known: true });
    let launchesAtCivil = 0;
    w.events.on('munition:launch', (e) => {
      if (e.targetId === civ.id) launchesAtCivil++;
    });
    run(w, 90);
    expect(launchesAtCivil).toBe(0);
    expect(civ.alive).toBe(true);
    expect(civ.health).toBe(civ.maxHealth);
  });

  it('the player can designate, lock and shoot one down: a wreck, not a kill', () => {
    const w = makeWorld(5);
    const civ = spawnCivil(w, 'departure');
    run(w, 70); // airborne and climbing out
    expect(civ.position.y).toBeGreaterThan(ELEV + 100);
    const fwd = new Vector3(Math.sin(civ.civil!.heading), 0, -Math.cos(civ.civil!.heading));
    // head-on, 14 km ahead of the climbing airliner
    const pos = civ.position.clone().addScaledVector(fwd, 14_000);
    pos.y = civ.position.y + 600;
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: pos, heading: civ.civil!.heading + Math.PI, speed: 240, loadout: 'a2a_stealth' });
    run(w, 1);
    // never auto-designated...
    expect(p.radar.designatedId).not.toBe(civ.id);
    expect(p.radar.contacts.some((c) => c.id === civ.id && c.team === 'neutral')).toBe(true);
    // ...but the pilot may box it deliberately and commit
    w.combat.designate(p, civ.id, w);
    let destroyedBy: number | null = null;
    w.events.on('destroyed', (e) => {
      if (e.entity === civ) destroyedBy = e.attackerId;
    });
    let fired = false;
    run(w, 40, () => {
      if (!fired && p.radar.lockedId === civ.id) {
        p.selectedWeapon = 'aim120';
        fired = !!w.combat.fire(p, w, 'aim120', civ.id);
      }
      return !civ.alive && w.time > 0;
    });
    expect(fired).toBe(true);
    expect(civ.alive).toBe(false);
    expect(destroyedBy).toBe(p.id);
    expect(p.kills).toBe(0); // shooting a civilian is never a kill
    // the wreck now falls under the flight model (it may coast up briefly from the climb)
    const y0 = civ.position.y;
    run(w, 20);
    expect(civ.civil!.phase).not.toBe('takeoff');
    expect(civ.velocity.y < 0 || civ.crashed).toBe(true);
    expect(civ.position.y).toBeLessThan(y0);
  });
});

describe('civil traffic in missions', () => {
  function setup(def: MissionDef, civilTraffic = true) {
    const events = new EventBus();
    const world = createSimWorld({ terrain: new FlatTerrain(ELEV), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(1) });
    // RunnerDeps.civilTraffic (not in the public CreateMissionRunner contract)
    const deps = { createAi: createAiBrain, difficulty: DIFFICULTIES.pilot, events, civilTraffic };
    const runner = createMissionRunner(def, deps);
    runner.setup(world, def.recommendedLoadout);
    const radio: string[] = [];
    events.on('radio', (e) => radio.push(e.text));
    const tick = (seconds: number) => {
      for (let i = 0; i < seconds * 60 && runner.state === 'running'; i++) {
        world.step(DT);
        runner.update(world, DT);
      }
    };
    return { world, runner, radio, tick };
  }

  it('Auckland missions get neutral A320 traffic, unless civil traffic is switched off', () => {
    const akl = setup(missionById('g01')!);
    akl.tick(1);
    const civ = akl.world.aircraft.filter((a) => a.civil);
    expect(civ.length).toBeGreaterThan(0);
    for (const a of civ) {
      expect(a.type).toBe('a320');
      expect(a.team).toBe('neutral');
      expect(a.ai).toBeNull();
      expect(a.callsign).toMatch(/^AeroFlop \d+$/);
    }
    akl.tick(60); // the opening departure lines up behind the arrival
    expect(akl.world.aircraft.some((a) => a.civil?.kind === 'departure')).toBe(true);
    akl.runner.dispose?.();

    const off = setup(buildInstantMissionSeeded({ mode: 'dogfight', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mig29', enemyCount: 2 }, 3), false);
    off.tick(30);
    expect(off.world.aircraft.some((a) => a.civil || a.team === 'neutral')).toBe(false);
    off.runner.dispose?.();
  });

  it('a player shoot-down is a civilian loss: AWACS check-fire call, no kill, score penalty in the debrief', () => {
    const m = setup(missionById('g01')!);
    m.tick(1);
    const p = m.world.player!;
    const civ = m.world.aircraft.find((a) => a.civil)!;
    m.world.applyDamage(civ, 10_000, p.id, 'gun');
    m.tick(6);
    expect(civ.alive).toBe(false);
    const r = m.runner.result(m.world) as MissionResultExt;
    expect(r.kills.air).toBe(0);
    expect(r.civilianKills).toBe(1);
    expect(m.radio.some((t) => /check fire/i.test(t) && /civilian/i.test(t))).toBe(true);
    m.runner.dispose?.();
  });
});

describe('peacetime airliners (A Stroll in the Park)', () => {
  it('a busier airport whatever the conditions, and departures turning north over the city', () => {
    for (const [timeOfDay, weather] of [['day', 'clear'], ['night', 'overcast'], ['dawn', 'scattered']] as const) {
      const def = buildInstantMissionSeeded({ mode: 'stroll', theater: 'auckland', timeOfDay, weather, enemyType: 'mixed', enemyCount: 4 }, 11);
      const events = new EventBus();
      const world = createSimWorld({ terrain: new FlatTerrain(ELEV), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(1) });
      const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty: DIFFICULTIES.pilot, events });
      runner.setup(world, def.recommendedLoadout);
      let most = 0;
      const exits = new Set<number>();
      for (let i = 0; i < 15 * 60 * 60 && runner.state === 'running'; i++) {
        world.step(DT);
        runner.update(world, DT);
        if (i % 60) continue;
        const civ = world.aircraft.filter((a) => a.civil && a.alive);
        most = Math.max(most, civ.length);
        for (const a of civ) if (a.civil!.kind === 'departure') exits.add(Math.round((a.civil!.exitHeading * 180) / Math.PI));
      }
      expect(runner.state).toBe('running');
      expect(most).toBeGreaterThan(3); // the wartime flow never has more than 3
      expect(most).toBeLessThanOrEqual(5);
      expect([...exits].some((h) => h >= 330 || h <= 25)).toBe(true);
      runner.dispose?.();
    }
  });
});

describe('scoring', () => {
  it('each civilian airliner shot down costs points and rating', () => {
    const base = {
      success: true, time: 300, parTime: 480, kills: { air: 4, sam: 0, ground: 0 }, enemiesSpawned: 4, objectiveBonus: 500,
      primaryDone: 1, primaryTotal: 1, secondaryDone: 0, secondaryTotal: 0, shotsFired: 4, hits: 4, damageTaken: 0,
      friendlyLosses: 0, bonus: 0, scoreMultiplier: 1,
    };
    const clean = computeScore(base);
    const dirty = computeScore({ ...base, civilianKills: 1 });
    expect(clean.score - dirty.score).toBe(POINTS.civilian);
    expect(dirty.rating).toBeLessThan(clean.rating);
  });
});
