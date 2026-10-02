/**
 * Instant Action's A Stroll in the Park: free flight over Auckland with no hostiles. No enemy
 * aircraft, SAMs or targets, no objectives; the heaviest loadout by default with every loadout
 * allowed; the sortie only ends when the player quits or goes down; shooting down an airliner costs
 * nothing and bringing the Sky Tower down doesn't end it. A saved setup and the menu default pick it.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { AKL } from '../src/core/auckland';
import { DIFFICULTIES } from '../src/core/data';
import { EventBus } from '../src/core/events';
import { createAiBrain } from '../src/ai';
import { CAMPAIGNS, TRAINING, buildInstantMissionSeeded, createMissionRunner, missionById, validateMission } from '../src/missions';
import { applyResult, defaultProgress } from '../src/missions/progress';
import type { MissionResultExt } from '../src/missions/runtime/resultExt';
import { destroyLandmark } from '../src/sim/landmarks';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { parseInstantSetup } from '../src/ui/screens/instantAction';
import { FlatTerrain } from './combat-helpers';

const DT = 1 / 60;
const CAMPAIGN_CHAINS = CAMPAIGNS.map((c) => c.missions);
const stroll = () => buildInstantMissionSeeded({ mode: 'stroll', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 8 }, 7);

function setup() {
  const def = stroll();
  const events = new EventBus();
  const world = createSimWorld({ terrain: new FlatTerrain(0), difficulty: DIFFICULTIES.ace, events, combat: createCombatSystemSeeded(1) });
  const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty: DIFFICULTIES.ace, events });
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
  return { world, runner, radio, hud, tick };
}

describe('Instant Action: A Stroll in the Park', () => {
  it('has no hostiles, no objectives and every loadout, the heaviest by default', () => {
    const def = stroll();
    expect(validateMission(def)).toEqual([]);
    expect(def.title).toBe('A Stroll in the Park — Auckland');
    expect(def.script.freeFlight).toBe(true);
    // the enemy count is ignored: 8 asked for, none spawned
    expect(def.script.groups).toEqual([]);
    expect(def.script.sams).toEqual([]);
    expect(def.script.ground).toEqual([]);
    expect(def.script.objectives).toEqual([]);
    expect(def.script.survival).toBeUndefined();
    expect(def.intel.filter((i) => i.kind === 'sam' || i.kind === 'air')).toEqual([]);
    expect(def.recommendedLoadout).toBe('strike_beast');
    expect(def.allowedLoadouts).toContain('strike_sdb2_full');
    expect(def.allowedLoadouts).toContain('a2a_beast');
    expect(def.briefing[0]).toMatch(/^Everyone's friendly\. It's New Zealand\./);
    expect(def.objectiveText).toEqual(['Free flight: no objectives. Explore Auckland at your own pace.']);
    expect(missionById('ia_stroll_auckland')?.script.freeFlight).toBe(true);
  });

  it('offers a sightseeing tour on the steering cue, from a low, steady start (playtest 1.1-c)', () => {
    const def = stroll();
    const wps = def.script.waypoints;
    expect(wps.map((w) => w.label)).toEqual(['Harbour Bridge', 'Sky Tower', 'North Head', 'Rangitoto', 'Mission Bay', 'Museum', 'Eden Park', 'Mt Eden', 'One Tree Hill', 'Airport', 'Whenuapai']);
    for (const w of wps) {
      expect(w.kind, w.id).toBe('nav'); // advances as the jet passes, never tied to an objective
      expect(w.altitude, w.id).toBeGreaterThanOrEqual(500);
    }
    expect(def.player.altitude).toBeLessThanOrEqual(1000);
    expect(def.player.speed).toBeLessThanOrEqual(160);
    expect(def.briefing.join(' ')).toMatch(/steering cue offers a tour/);
    // the briefing map has no enemy in free flight
    expect(def.intel.map((i) => i.label)).not.toContain('Enemy airstrip');
  });

  it('the tour ticks each stop off, a detour past a later stop doesn\'t end it, and the last says TOUR COMPLETE (playtest r2, 2.2-3)', () => {
    const m = setup();
    m.tick(1);
    const p = m.world.player!;
    const wps = m.runner.waypoints;
    const visit = (i: number) => {
      p.position.set(wps[i].position.x, 600, wps[i].position.z);
      m.tick(0.5);
    };
    visit(wps.length - 1); // straight to Whenuapai, the last stop
    expect(m.runner.currentWaypoint?.label).toBe('Harbour Bridge');
    visit(0);
    expect(m.hud).toContain('HARBOUR BRIDGE ✓  1/11');
    expect(m.runner.currentWaypoint?.label).toBe('Sky Tower');
    for (let i = 1; i < wps.length - 1; i++) visit(i);
    // Whenuapai was already visited: the tour ends as the second-last stop is reached
    expect(m.hud).toContain('ONE TREE HILL ✓  9/11');
    expect(m.hud).toContain('TOUR COMPLETE');
    expect(m.runner.currentWaypoint).toBeNull();
    expect(m.runner.state).toBe('running');
  });

  it('only civilians in the air, and it keeps running until the player quits', () => {
    const m = setup();
    m.tick(60);
    expect(m.world.aircraft.some((a) => a.civil)).toBe(true);
    expect(m.world.aircraft.filter((a) => a !== m.world.player && a.team !== 'neutral')).toEqual([]);
    expect(m.world.sams).toEqual([]);
    expect(m.runner.state).toBe('running');
    expect(m.radio.some((t) => /Nothing hostile/.test(t))).toBe(true);
    expect(m.radio.some((t) => /picture/i.test(t))).toBe(false);
  });

  it('shooting down an airliner costs nothing', () => {
    const m = setup();
    m.tick(1);
    const p = m.world.player!;
    const civ = m.world.aircraft.find((a) => a.civil)!;
    m.world.applyDamage(civ, 10_000, p.id, 'gun');
    m.tick(6);
    expect(civ.alive).toBe(false);
    expect(m.runner.state).toBe('running');
    expect((m.runner.result(m.world) as MissionResultExt).civilianKills).toBeUndefined();
  });

  it('bringing the Sky Tower down does not end it', () => {
    const m = setup();
    m.tick(1);
    const p = m.world.player!;
    const tower = m.world.landmarks[0];
    destroyLandmark(tower, m.world.events, m.world.time, new Vector3(AKL.skytower.x + 10, 200, AKL.skytower.z), p.id, 'gbu31', p.position);
    m.tick(5);
    expect(tower.alive).toBe(false);
    expect(m.runner.state).toBe('running');
  });

  it('flying off the map is a nudge, not a failure (no AO)', () => {
    const m = setup();
    m.tick(1);
    m.world.player!.position.x = -60_000; // the default AO fails 30 s outside ±38 km
    m.tick(45);
    expect(m.runner.state).toBe('running');
    expect(m.hud).toContain('EDGE OF THE MAP — TURN BACK');
    expect(m.hud.some((t) => /RETURN TO AO/.test(t))).toBe(false);
    expect(m.radio.some((t) => /area of operations/.test(t))).toBe(false);
  });

  it('a low pass over Whenuapai is no pit stop, and a refuel at bingo sends no one back into a fight', () => {
    const m = setup();
    m.tick(1);
    const p = m.world.player!;
    const over = () => {
      p.position.set(AKL.whenuapai.x, 400, AKL.whenuapai.z);
      m.tick(1);
    };
    p.flight.fuel *= 0.7; // a real amount used, but not bingo
    for (let i = 0; i < 8; i++) over();
    expect(m.hud.some((t) => /REARM/.test(t))).toBe(false);
    p.flight.fuel = 100; // bingo: the gate refuels
    for (let i = 0; i < 8; i++) over();
    expect(m.hud).toContain('REARMED');
    expect(m.radio.some((t) => /rearmed and refuelled\. Enjoy the rest of your flight\./.test(t))).toBe(true);
    expect(m.radio.some((t) => /into the fight/.test(t))).toBe(false);
  });

  it('crashing still ends it', () => {
    const m = setup();
    m.tick(1);
    const p = m.world.player!;
    m.world.applyDamage(p, p.maxHealth * 10, null, 'gun');
    m.tick(1);
    expect(m.runner.state).toBe('failed');
    // no MISSION FAILED banner or 'Mission failed' call (playtest r2, 2.2-4)
    expect(m.hud).toContain('FLIGHT OVER');
    expect(m.hud).not.toContain('MISSION FAILED');
    expect(m.radio.some((t) => /Mission failed/.test(t))).toBe(false);
    // ...as a 'flight over', not a failed mission: no tips, no medals, nothing in the career
    const r = m.runner.result(m.world);
    expect(r.freeFlight).toBe(true);
    expect(r.tips).toEqual([]);
    const before = defaultProgress(CAMPAIGN_CHAINS, TRAINING);
    expect(applyResult(before, r, CAMPAIGN_CHAINS)).toBe(before);
  });

  it('is the menu default, and a saved stroll setup loads as one', () => {
    expect(parseInstantSetup(null).mode).toBe('stroll');
    expect(parseInstantSetup(JSON.stringify({ mode: 'stroll', theater: 'auckland' })).mode).toBe('stroll');
    // an existing player's saved mode is kept
    expect(parseInstantSetup(JSON.stringify({ mode: 'dogfight' })).mode).toBe('dogfight');
  });
});
