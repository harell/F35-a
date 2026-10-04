/**
 * A Stroll in the Park, sightseeing follow-ups (issue #113): the free-flight debrief shows what a
 * sightseer did (tour stops, distance flown, highest and lowest pass) instead of combat stats; a
 * calm cockpit (a clean jet by default, radar off), and civil traffic the player can designate and shoot.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { DIFFICULTIES, LOADOUTS } from '../src/core/data';
import { EventBus } from '../src/core/events';
import { createAiBrain } from '../src/ai';
import { buildInstantMissionSeeded, createMissionRunner } from '../src/missions';
import type { MissionResultExt } from '../src/missions/runtime/resultExt';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { sightseeingRows } from '../src/ui/screens/debrief';
import { hangarLoadouts } from '../src/ui/hangar';
import { isHomeView, sortieHomeView } from '../src/game/views';
import { FlatTerrain } from './combat-helpers';

const DT = 1 / 60;
const stroll = () => buildInstantMissionSeeded({ mode: 'stroll', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 8 }, 7);

function setup(loadout?: Parameters<ReturnType<typeof createMissionRunner>['setup']>[1]) {
  const def = stroll();
  const events = new EventBus();
  const world = createSimWorld({ terrain: new FlatTerrain(0), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(1) });
  const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty: DIFFICULTIES.pilot, events });
  runner.setup(world, loadout ?? def.recommendedLoadout);
  const radio: string[] = [];
  events.on('radio', (e) => radio.push(e.text));
  const hud: string[] = [];
  events.on('hud:message', (e) => hud.push(e.text));
  const tick = (seconds: number) => {
    for (let i = 0; i < seconds * 60; i++) {
      world.step(DT);
      runner.update(world, DT);
    }
  };
  return { def, world, runner, tick, radio, hud };
}

const ahead = (p: { velocity: Vector3 }) => p.velocity.clone().setY(0).normalize();
const sights = (r: ReturnType<ReturnType<typeof createMissionRunner>['result']>) => (r as MissionResultExt).sightseeing!;

describe('A Stroll in the Park: the free-flight debrief (2.2-5)', () => {
  it('counts the tour stops visited, the distance flown and the highest and lowest pass', () => {
    const m = setup();
    m.tick(1);
    const p = m.world.player!;
    const wps = m.runner.waypoints;
    for (const i of [0, 1, 2]) {
      p.position.set(wps[i].position.x, 600, wps[i].position.z);
      m.tick(0.5);
    }
    // a low pass at ~120 m that the jet flies on from
    p.position.y = 120;
    m.tick(0.3);
    p.position.y = 900;
    m.tick(4);
    const t = sights(m.runner.result(m.world));
    expect(t.stops).toBe(3);
    expect(t.totalStops).toBe(11);
    // about 7 s at ~150 m/s (the teleports between the stops don't count)
    expect(t.distance).toBeGreaterThan(600);
    expect(t.distance).toBeLessThan(2000);
    expect(t.lowestAgl!).toBeGreaterThan(100);
    expect(t.lowestAgl!).toBeLessThan(140);
    expect(t.highestAgl!).toBeGreaterThan(880);
  });

  it("a crash isn't the lowest pass", () => {
    const m = setup();
    m.tick(3);
    const p = m.world.player!;
    p.position.y = 15; // heading for the water
    m.tick(0.5);
    m.world.applyDamage(p, p.maxHealth * 10, null, 'gun');
    m.tick(1);
    const t = sights(m.runner.result(m.world));
    expect(t.lowestAgl!).toBeGreaterThan(400);
  });

  it('shows sightseeing rows, no Accuracy, Damage or SAM kills', () => {
    const r = {
      freeFlight: true,
      time: 754,
      sightseeing: { stops: 7, totalStops: 11, distance: 92_600, highestAgl: 1210, lowestAgl: 61 },
    } as unknown as MissionResultExt;
    const rows = sightseeingRows(r);
    const labels = rows.map((x) => x[1]);
    expect(labels).toEqual(['Tour stops', 'Flight time', 'Distance flown', 'Highest pass', 'Lowest pass']);
    expect(labels.join(' ')).not.toMatch(/Accuracy|Damage|SAM|kills/);
    const v = Object.fromEntries(rows.map((x) => [x[1], x[2]]));
    expect(v['Tour stops']).toBe('7/11');
    expect(v['Flight time']).toBe('12:34');
    expect(v['Distance flown']).toBe('50 nm <small>93 km</small>');
    expect(v['Highest pass']).toBe('3,970 ft <small>1,210 m</small>');
    expect(v['Lowest pass']).toBe('200 ft <small>61 m</small>');
  });
});

describe('A Stroll in the Park: a calm cockpit (1.1-g)', () => {
  it('a clean jet first in the hangar and by default, the others still offered', () => {
    const def = stroll();
    expect(def.recommendedLoadout).toBe('clean');
    expect(def.allowedLoadouts[0]).toBe('clean');
    expect(def.allowedLoadouts).toEqual(expect.arrayContaining(['strike_beast', 'a2a_beast', 'strike_sdb2_full', 'a2a_stealth']));
    expect(hangarLoadouts(def)).toEqual({ cards: def.allowedLoadouts, initial: 'clean' });
    const l = LOADOUTS.clean;
    expect(l.stores).toEqual([]);
    expect(l.rcsMultiplier).toBe(1);
    expect(l.gunAmmo).toBeGreaterThan(0);
  });

  it('starts on the gun with the radar off, and a clean jet is never Winchester', () => {
    const m = setup();
    m.tick(1);
    const p = m.world.player!;
    expect(p.stores).toEqual([]);
    expect(p.selectedWeapon).toBe('gun');
    expect(p.radar.emitting).toBe(false);
    m.tick(10);
    expect(p.radar.emitting).toBe(false);
    expect(m.hud.some((t) => /WINCHESTER/.test(t))).toBe(false);
    expect(m.radio.some((t) => /Winchester/.test(t))).toBe(false);
    expect(m.runner.currentWaypoint?.label).toBe('Harbour Bridge');
  });

  /** Radar on; the harbour's ships seen from the start, then an airliner 3 km ahead (the civil module flies it, so the jet moves). */
  const civilContacts = (m: ReturnType<typeof setup>) => {
    const p = m.world.player!;
    m.world.combat.setRadarEmitting(p, true, m.world);
    m.tick(1);
    const ships = p.radar.contacts.filter((c) => c.team === 'neutral' && m.world.getEntity(c.id)?.kind !== 'aircraft').length;
    const civ = m.world.aircraft.find((a) => a.civil)!;
    p.position.copy(civ.position).addScaledVector(ahead(p), -3000);
    m.tick(0.5);
    return { ships, airliner: p.radar.contacts.some((c) => c.id === civ.id) };
  };

  it('CIV boxes: TGT or a tap designates the civil traffic (owner, 2026-10-04)', () => {
    const m = setup();
    m.tick(1);
    const seen = civilContacts(m);
    expect(seen.ships).toBeGreaterThan(0);
    expect(seen.airliner).toBe(true);
    const p = m.world.player!;
    const civ = p.radar.contacts.filter((c) => c.team === 'neutral');
    expect(civ.length).toBeGreaterThan(0);
    // with nothing hostile about, TGT steps onto the civil traffic (the gun is selected: air mode)
    m.world.combat.cycleTarget(p, m.world);
    expect(m.world.getEntity(p.radar.designatedId)?.team).toBe('neutral');
    // a tap on any CIV box, ship or airliner
    for (const c of civ) {
      m.world.combat.designate(p, c.id, m.world);
      expect(p.radar.designatedId).toBe(c.id);
    }
  });

  /** Fly the jet `range` m behind and level with `target`, at its speed, nose on it. */
  const sitBehind = (p: { position: Vector3; velocity: Vector3; quaternion: { setFromUnitVectors(a: Vector3, b: Vector3): unknown } }, target: { position: Vector3; velocity: Vector3 }, range: number) => {
    const dir = target.velocity.clone().normalize();
    p.position.copy(target.position).addScaledVector(dir, -range);
    p.velocity.copy(target.velocity);
    p.quaternion.setFromUnitVectors(new Vector3(0, 0, -1), dir);
  };

  it('with the radar off, as the flight starts, a tap designates an airliner and the gun shoots it down', () => {
    const m = setup();
    m.tick(1);
    const p = m.world.player!;
    expect(p.selectedWeapon).toBe('gun');
    const civ = m.world.aircraft.find((a) => a.civil && a.alive)!;
    sitBehind(p, civ, 600);
    m.tick(0.5);
    // the CIV box is there without the radar (the HUD boxes what's on the contact list)
    expect(p.radar.contacts.some((c) => c.id === civ.id)).toBe(true);
    m.world.combat.designate(p, civ.id, m.world);
    expect(p.radar.designatedId).toBe(civ.id);
    // guns: hold the nose on the airliner
    const d = new Vector3();
    p.input.fireGun = true;
    for (let i = 0; i < 6 * 60 && civ.alive; i++) {
      d.subVectors(civ.position, p.position).normalize();
      p.quaternion.setFromUnitVectors(new Vector3(0, 0, -1), d);
      p.velocity.copy(d).multiplyScalar(civ.velocity.length());
      m.tick(1 / 60);
    }
    p.input.fireGun = false;
    expect(civ.alive).toBe(false);
    m.tick(1);
    expect(m.hud).toContain('CIVILIAN AIRLINER DOWN');
    expect(m.runner.state).toBe('running'); // free flight goes on: nothing counts against the player
  });

  it('a loaded jet bombs a designated civil ship', () => {
    const m = setup('strike_stealth');
    m.tick(1);
    const p = m.world.player!;
    const ship = m.world.ground.find((g) => g.team === 'neutral' && g.type === 'ship' && g.alive)!;
    // 4 km short of the ship at 6,000 m, flying at it
    const to = new Vector3(ship.position.x - p.position.x, 0, ship.position.z - p.position.z).normalize();
    p.position.set(ship.position.x, 6000, ship.position.z).addScaledVector(to, -4000);
    p.velocity.copy(to).multiplyScalar(250);
    p.quaternion.setFromUnitVectors(new Vector3(0, 0, -1), to);
    m.world.combat.selectWeapon(p, 'gbu31', m.world);
    m.tick(0.5);
    m.world.combat.designate(p, ship.id, m.world);
    expect(p.radar.designatedId).toBe(ship.id);
    m.world.combat.fire(p, m.world, 'gbu31'); // released once the bay doors are open
    for (let i = 0; i < 90 && ship.alive; i++) m.tick(1);
    expect(ship.alive).toBe(false);
    expect(m.hud).toContain('CIVILIAN SHIP DESTROYED');
  });
});

describe('A Stroll in the Park: the view (1.1-j)', () => {
  it('free flight starts in chase whatever the default view, or in the view the player picked in one', () => {
    expect(sortieHomeView(true, 'cockpit', null)).toBe('chase');
    expect(sortieHomeView(true, 'hud', null)).toBe('chase');
    expect(sortieHomeView(true, 'cockpit', 'cockpit')).toBe('cockpit');
    // every other sortie keeps the settings' default view
    expect(sortieHomeView(false, 'cockpit', 'chase')).toBe('cockpit');
    expect(sortieHomeView(false, 'hud', null)).toBe('hud');
    // the orbit, tactical, padlock and missile cameras aren't views to fly in
    expect(['cockpit', 'hud', 'chase', 'orbit', 'tactical', 'target', 'missile'].filter((v) => isHomeView(v as never))).toEqual(['cockpit', 'hud', 'chase']);
  });
});

describe('A Stroll in the Park: the Sky Tower as an obstacle (1.1-l)', () => {
  it('flying into the shaft ends the flight as a crash into the Sky Tower, not an Auto-GCAS lesson', () => {
    const m = setup();
    m.tick(1);
    const p = m.world.player!;
    const tower = m.world.landmarks[0];
    // 300 m short of the shaft at 120 m, flying at it
    p.position.copy(tower.base).addScaledVector(ahead(p), -300).setY(tower.base.y + 120);
    for (let i = 0; i < 10 && p.alive; i++) m.tick(0.25);
    expect(p.alive).toBe(false);
    expect(tower.alive).toBe(false); // the player's jet brings it down at once
    const r = m.runner.result(m.world);
    expect(r.reason).toBe('Crashed into the Sky Tower');
    expect(r.tips ?? []).toEqual([]);
    expect(m.hud).toContain('FLIGHT OVER');
    expect(m.hud).toContain('SKY TOWER DESTROYED');
    m.tick(3);
    expect(m.radio.some((t) => /The Sky Tower has been destroyed!/.test(t))).toBe(true);
  });
});

describe('A Stroll in the Park: the briefing (1.1-d)', () => {
  it('says only the CBD, motorways and main roads are real streets, and the jet is clean', () => {
    const text = stroll().briefing.join(' ');
    expect(text).toMatch(/CBD, the motorways and the main roads follow Auckland's real streets/);
    expect(text).toMatch(/suburbs between them are stylised/);
    expect(text).toMatch(/The jet is clean, radar off/);
    expect(text).not.toMatch(/loaded to the teeth/);
  });
});
