/**
 * Practice rounds and the defence coach (MissionScript.practiceRounds / defenceCoach, the t05 lesson):
 * a hit does no damage and is called out with its first fault; a defeat is called out with how; a
 * 'missile_drill' objective counts the defeats. The jet is steered by script (its velocity, turning at
 * up to 6 g) round an IRGC air-defence boat at Pilot. Measured on this geometry over 12 bearings: flying
 * at it 40/40 rounds hit, a beam alone 22/22, a beam with a CMS press every 2.5 s 0/22, low and on the
 * beam 0/10; turning to run after the launch 8/16 (caught in the turn).
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { MissionDef } from '../src/core/contracts';
import { mission, site } from '../src/missions/content/common';
import { validateMission } from '../src/missions/validate';
import { COACH_TEXT, drillRecords, isDrillDefeat, type MissileRecord } from '../src/missions/runtime/defenceCoach';
import { DRILL_MOVE_ON, skippedDrillsText } from '../src/missions/runtime/objectives';
import type { MissionState } from '../src/missions/runtime/state';
import { LOADOUTS } from '../src/core/data';
import { harness, type Harness } from './missions-helpers';
import { FlatTerrain, steerToward } from './combat-helpers';

/** Out in the Gulf (the world origin is the Sky Tower: rounds fired from there hit it). */
const BOAT = { x: 8000, z: -20000 };

function drillFixture(opts: { practice?: boolean; coach?: boolean; noHarass?: boolean } = {}): MissionDef {
  return mission({
    id: 'fx_drill',
    kind: 'training',
    index: 9,
    title: 'Drill fixture',
    subtitle: 'test',
    timeOfDay: 'day',
    weather: 'clear',
    briefing: ['test'],
    recommendedLoadout: 'a2a_stealth',
    allowedLoadouts: ['a2a_stealth'],
    player: { x: BOAT.x, z: BOAT.z + 7000, altitude: 2000, heading: 0, speed: 250 },
    script: {
      practiceRounds: opts.practice ?? true,
      defenceCoach: opts.coach ?? true,
      awacs: { silent: true },
      groups: [],
      ground: [],
      sams: [site('boat', 'boats', 'ad_boat', BOAT, opts.noHarass ? { noHarass: true } : {})],
      objectives: [
        { id: 'o_drill', kind: 'missile_drill', groups: ['boats'], defeat: 2, label: 'Defeat two missiles', primary: false },
        { id: 'o_stay', kind: 'survive', seconds: 900, label: 'Keep flying', primary: true },
      ],
      waypoints: [],
      triggers: [],
    },
  });
}

type Style = 'hot' | 'beam' | 'beam_cms' | 'run';

/**
 * Fly the jet by script, 11 km from the boat on bearing `brg` at the start (far enough out to turn
 * before the first round arrives): at it until it shoots (a jet already on the beam is never shot
 * at), then at it still ('hot'), round it on the beam ('beam'; 'beam_cms' with a CMS press every
 * 2.5 s from 6 s to impact), or away ('run'). Turns at up to 6 g; level at `alt`.
 */
function flyDrill(style: Style, brg: number, seconds = 60, alt = 2000): Harness {
  const def = drillFixture();
  // nose on the boat (heading: degrees clockwise from north, −Z)
  const heading = (((-brg * 180) / Math.PI) % 360 + 360) % 360;
  def.player = { ...def.player, x: BOAT.x + Math.sin(brg) * 11_000, z: BOAT.z + Math.cos(brg) * 11_000, altitude: alt, heading };
  const h = harness(def, 'pilot', undefined, new FlatTerrain(0));
  const p = h.world.player!;
  const v = new Vector3();
  let lastCms = -99;
  let defending = false;
  h.run(seconds, () => {
    const dx = p.position.x - BOAT.x;
    const dz = p.position.z - BOAT.z;
    const d = Math.hypot(dx, dz) || 1;
    if (p.incoming.length > 0) defending = true;
    if (!defending || style === 'hot') v.set(-dx / d, 0, -dz / d);
    else if (style === 'run') v.set(dx / d, 0, dz / d);
    else v.set(-dz / d, 0, dx / d);
    v.y = (alt - p.position.y) / 2000;
    steerToward(p, v, 6, 1 / 60, 250);
    p.input.chaff = false;
    const tti = p.incoming.length ? Math.min(...p.incoming.map((m) => m.timeToImpact)) : Infinity;
    if (style === 'beam_cms' && tti < 6 && h.world.time - lastCms > 2.5) {
      p.input.chaff = true;
      lastCms = h.world.time;
    }
  });
  return h;
}

function records(h: Harness): MissileRecord[] {
  return (h.runner as unknown as { s: { missileLog: MissileRecord[] } }).s.missileLog.filter((r) => r.outcome !== null && r.outcome !== 'void');
}

/** Radar-round outcomes over four approach bearings. */
function sweep(style: Style, seconds = 60): { recs: MissileRecord[]; hs: Harness[] } {
  const recs: MissileRecord[] = [];
  const hs: Harness[] = [];
  for (let k = 0; k < 4; k++) {
    const h = flyDrill(style, (k / 4) * Math.PI * 2 + 0.3, seconds);
    hs.push(h);
    recs.push(...records(h).filter((r) => r.guidance === 'radar'));
  }
  return { recs, hs };
}

describe('practice rounds', () => {
  it('a missile hit does no damage and is reported as practice:hit; the ground still kills', () => {
    const h = harness(drillFixture(), 'pilot', undefined, new FlatTerrain(0));
    const p = h.world.player!;
    const hits: unknown[] = [];
    h.events.on('practice:hit', (e) => hits.push(e));
    h.world.applyDamage(p, 500, null, 'm_9m330');
    expect(p.health).toBe(p.maxHealth);
    expect(p.alive).toBe(true);
    expect(hits).toHaveLength(1);
    h.world.applyDamage(p, 5000, null, 'collision');
    expect(p.alive).toBe(false);
  });

  it('off unless the mission asks for it', () => {
    const h = harness(drillFixture({ practice: false }), 'pilot', undefined, new FlatTerrain(0));
    const p = h.world.player!;
    h.world.applyDamage(p, 30, null, 'm_9m330');
    expect(p.health).toBeLessThan(p.maxHealth);
  });

  it('a missile_drill needs the coach (validate)', () => {
    expect(validateMission(drillFixture({ coach: false })).join(' ')).toMatch(/defenceCoach/);
    expect(validateMission(drillFixture()).join(' ')).not.toMatch(/defenceCoach|missile_drill|o_drill/);
  });
});

// measured on this geometry (12 bearings): at it 40/40 hit, beam alone 22/22, beam + CMS every 2.5 s 0/22
describe('the defence coach', { timeout: 120_000 }, () => {
  it('flying at the boat: every hit called out as "you flew at it", the jet unhurt', () => {
    // (35 s: before it overflies the boat, where the scripted turn back would overstress the jet)
    const { recs, hs } = sweep('hot', 35);
    expect(recs.length).toBeGreaterThan(4);
    expect(recs.filter((r) => r.outcome === 'hit').length).toBeGreaterThanOrEqual(recs.length - 1);
    expect(recs.filter((r) => r.outcome === 'hit').every((r) => r.fault === 'no_beam')).toBe(true);
    for (const h of hs) expect(h.world.player!.health).toBe(h.world.player!.maxHealth);
    expect(hs.some((h) => h.of('hud:message').some((m) => m.text === COACH_TEXT.no_beam))).toBe(true);
  });

  it('on the beam without CMS: hit, called out as "no CMS"', () => {
    const { recs } = sweep('beam');
    const hits = recs.filter((r) => r.outcome === 'hit');
    expect(hits.length).toBeGreaterThan(recs.length / 2);
    expect(hits.every((r) => r.fault === 'no_cms')).toBe(true);
  });

  it('beam + a CMS press every 2.5 s: defeated (chaff or the notch), and the drill completes', () => {
    const { recs, hs } = sweep('beam_cms');
    expect(recs.length).toBeGreaterThan(4);
    expect(recs.filter((r) => r.outcome === 'hit').length).toBeLessThanOrEqual(1);
    for (const r of recs) if (r.outcome !== 'hit') expect(['chaff', 'notch']).toContain(r.outcome);
    expect(hs.filter((h) => h.runner.objectives.find((o) => o.id === 'o_drill')?.state === 'complete').length).toBeGreaterThanOrEqual(3);
  });

  it('turning to run after the launch: still hit (it is caught in the turn), blamed on the geometry, never on CMS', () => {
    // a 180° turn at 6 g takes ~8 s, about the round's whole flight from 8 km: most of its end game
    // sees the jet still coming in or crossing, so the call-out is "beam it" (or "running loses")
    const { recs } = sweep('run');
    const hits = recs.filter((r) => r.outcome === 'hit');
    // (measured: 8 of 16 rounds hit, against 0 of 22 for beam + CMS)
    expect(hits.length).toBeGreaterThanOrEqual(recs.length / 3);
    for (const r of hits) expect(['ran', 'no_beam']).toContain(r.fault);
  });
});

describe('drill bookkeeping', () => {
  const rec = (r: Partial<MissileRecord>): MissileRecord => ({ missileId: 1, group: 'b', guidance: 'radar', launchT: 10, endT: 20, outcome: 'chaff', fault: null, agl: 100, ...r });

  it('a drill counts only its own rounds fired after it opened, and only real defeats', () => {
    const s = { missileLog: [rec({ launchT: 5 }), rec({}), rec({ group: 'other' }), rec({ endT: -1, outcome: null }), rec({ guidance: 'ir' })] } as unknown as MissionState;
    expect(drillRecords(s, ['b'], 8)).toHaveLength(2);
    expect(drillRecords(s, ['b'], 8, 'radar')).toHaveLength(1);
    for (const o of ['chaff', 'flares', 'notch', 'outflown'] as const) expect(isDrillDefeat(rec({ outcome: o }))).toBe(true);
    for (const o of ['short', 'void', 'hit'] as const) expect(isDrillDefeat(rec({ outcome: o }))).toBe(false);
  });

  it('moveOn: after that many missiles that did not count, the coach moves the player on and the drill completes', () => {
    const def = drillFixture({ noHarass: true });
    const o = def.script.objectives[0];
    if (o.kind !== 'missile_drill') throw new Error('fixture');
    // the lesson's only primary, as in t05: the mission ends when the drill does
    Object.assign(o, { inARow: true, maxAgl: 200, moveOn: 4, primary: true });
    def.script.objectives.splice(1);
    const h = harness(def, 'pilot', undefined, new FlatTerrain(0));
    h.run(1);
    const log = (h.runner as unknown as { s: MissionState }).s.missileLog;
    const stateOf = () => h.runner.objectives.find((x) => x.id === 'o_drill')!.state;
    // three hits and a defeat too high to count: not yet; a short round counts for nothing
    log.push(rec({ group: 'boats', missileId: 101, launchT: 1, endT: 2, outcome: 'hit' }), rec({ group: 'boats', missileId: 102, launchT: 1, endT: 2, outcome: 'chaff', agl: 2000 }));
    log.push(rec({ group: 'boats', missileId: 103, launchT: 1, endT: 2, outcome: 'hit' }), rec({ group: 'boats', missileId: 104, launchT: 1, endT: 2, outcome: 'short' }));
    h.run(0.5);
    expect(stateOf()).toBe('active');
    log.push(rec({ group: 'boats', missileId: 105, launchT: 1, endT: 2, outcome: 'hit' }));
    h.run(0.5);
    expect(stateOf()).toBe('complete');
    expect(h.of('hud:message').map((m) => m.text)).toContain('DRILL SKIPPED — MOVING ON');
    h.run(20);
    const radio = h.of('radio').map((r) => r.text).join(' | ');
    expect(radio).toContain(DRILL_MOVE_ON);
    expect(radio).not.toMatch(/Objective complete/);
    // marked skipped (r2, 2.3-h): the lesson ends saying so, not "All objectives complete"
    expect(h.runner.objectives[0].skipped).toBe(true);
    expect(h.runner.state).toBe('success');
    const r = h.runner.result(h.world);
    expect(r.reason).toBe('Drill 1 skipped: fly Drill fixture again');
    expect(r.objectives[0].skipped).toBe(true);
    expect(radio).toContain('Drill 1 skipped: fly Drill fixture again.');
  });

  it('skippedDrillsText names the skipped drills by their place in the lesson', () => {
    const o = (...skipped: boolean[]) => skipped.map((s) => ({ skipped: s }));
    expect(skippedDrillsText(o(false, false, false), 'Gulf Defence')).toBeNull();
    expect(skippedDrillsText(o(false, true, false), 'Gulf Defence')).toBe('Drill 2 skipped: fly Gulf Defence again');
    expect(skippedDrillsText(o(true, true, false), 'Gulf Defence')).toBe('Drills 1–2 skipped: fly Gulf Defence again');
    expect(skippedDrillsText(o(true, false, true), 'Gulf Defence')).toBe('Drills 1 and 3 skipped: fly Gulf Defence again');
    expect(skippedDrillsText(o(true, true, true), 'Gulf Defence')).toBe('Drills 1–3 skipped: fly Gulf Defence again');
  });

  it('refill_cms tops the dispensers up to the loadout', () => {
    const def = drillFixture();
    def.script.triggers.push({ id: 't', when: { kind: 'time', t: 1 }, actions: [{ kind: 'refill_cms' }] });
    const h = harness(def, 'pilot', undefined, new FlatTerrain(0));
    const p = h.world.player!;
    p.chaff = 0;
    p.flares = 3;
    h.run(1.5);
    expect(p.chaff).toBe(LOADOUTS.a2a_stealth.chaff);
    expect(p.flares).toBe(LOADOUTS.a2a_stealth.flares);
  });

  it('noHarass: a boat that has tracked the jet fires no long shots past its 12 km envelope (Pilot)', { timeout: 60_000 }, () => {
    const longShots = (noHarass: boolean): number => {
      const def = drillFixture({ noHarass });
      def.player = { ...def.player, x: BOAT.x, z: BOAT.z + 7000, heading: 180 };
      const h = harness(def, 'pilot', undefined, new FlatTerrain(0));
      const p = h.world.player!;
      let n = 0;
      h.events.on('munition:launch', (e) => {
        if (e.targetId === p.id && Math.hypot(p.position.x - BOAT.x, p.position.z - BOAT.z) > 12_500) n++;
      });
      // tracked inside 9 km, then away to 20 km
      const v = new Vector3(0, 0, 1);
      h.run(70, () => {
        v.y = (2000 - p.position.y) / 2000;
        steerToward(p, v, 4, 1 / 60, 250);
      });
      return n;
    };
    expect(longShots(false)).toBeGreaterThan(0);
    expect(longShots(true)).toBe(0);
  });
});
