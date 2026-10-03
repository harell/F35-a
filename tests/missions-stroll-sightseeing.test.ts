/**
 * A Stroll in the Park, sightseeing follow-ups (issue #113): the free-flight debrief shows what a
 * sightseer did (tour stops, distance flown, highest and lowest pass) instead of combat stats; a
 * calm cockpit (a clean jet by default, radar off, no CIV boxes).
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

function setup() {
  const def = stroll();
  const events = new EventBus();
  const world = createSimWorld({ terrain: new FlatTerrain(0), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(1) });
  const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty: DIFFICULTIES.pilot, events });
  runner.setup(world, def.recommendedLoadout);
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

  it('no CIV boxes: the civil traffic never becomes a contact, so TGT has nothing to designate', () => {
    const m = setup();
    m.tick(1);
    expect(civilContacts(m)).toEqual({ ships: 0, airliner: false });
    const p = m.world.player!;
    expect(p.radar.contacts.filter((c) => c.team === 'neutral')).toEqual([]);
    m.world.combat.cycleTarget(p, m.world);
    expect(p.radar.designatedId).toBeNull();
  });

  it('outside free flight the player still sees the civil traffic', () => {
    const m = setup();
    m.tick(1);
    m.world.player!.ignoresCivil = false;
    const seen = civilContacts(m);
    expect(seen.ships).toBeGreaterThan(0);
    expect(seen.airliner).toBe(true);
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
    expect(tower.alive).toBe(true);
    expect(tower.hits).toBe(1); // burning where the jet went in
    const r = m.runner.result(m.world);
    expect(r.reason).toBe('Crashed into the Sky Tower');
    expect(r.tips ?? []).toEqual([]);
    expect(m.hud).toContain('FLIGHT OVER');
  });
});
