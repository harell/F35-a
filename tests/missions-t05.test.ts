/**
 * DEFENCE "Gulf Defence" (missile-defence drills with practice rounds, src/missions/content/trainingDefence.ts),
 * flown by the mission bot on the real LINZ coast at Pilot (training's fixed difficulty):
 *  - every range boat sits in open water;
 *  - three drills, two in a row each, no high-altitude drill and no exam (playtest 2026-10-10, 1.4-e/f);
 *  - the student (the bot in a defenceCoach mission: beam + CMS as taught) gets through the drills
 *    in about three minutes, and drill 3's boat fires only the heat-seekers it grades (playtest r2,
 *    2.3-j: four radar rounds first cost ~55 s);
 *  - a pilot who ignores the warning (bot option defend: false) is moved on by the coach after four
 *    misses, so the lesson still ends (it hung at 900 s with three in a row and an exam);
 *  - drill 3's heat-seekers can reach a jet that flies the briefed pass and doesn't defend: it takes the
 *    hits and doesn't pass (#284: passing 3.5 km off, every round fell short of it or was outflown).
 * Sweep: npx vite-node tools/playtest/bot-sweep.ts -- --missions=t05 --seeds=12 --log
 */
import { describe, expect, it } from 'vitest';
import { missionById, terrainPadsFor } from '../src/missions';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { D3_REACH, DEFENCE, DRILL_MOVE_ON_AFTER, T05_DEFENCE } from '../src/missions/content/trainingDefence';
import { DRILL_MOVE_ON } from '../src/missions/runtime/objectives';
import { runPlaythrough, type PlaythroughResult } from './missions-bot';

let terrain: TerrainQueryImpl | null = null;
function realTerrain(): TerrainQueryImpl {
  if (!terrain) {
    const def = missionById('t05')!;
    terrain = new TerrainQueryImpl(runSync(generateTerrain({ theater: def.theater, seed: def.seed, resolution: 512, features: allFeatures(def.theater, []), pads: terrainPadsFor(def) })));
  }
  return terrain;
}

/** Objective id → second it completed, from a logged run. */
function completed(r: PlaythroughResult): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of r.events) {
    const m = e.match(/^\s*(\d+) OBJ (\S+) complete/);
    if (m) out.set(m[2], Number(m[1]));
  }
  return out;
}

describe('t05 Gulf Defence', () => {
  it('every range boat sits in open water, 1.5 km from any shore', { timeout: 60_000 }, () => {
    const t = realTerrain();
    for (const s of T05_DEFENCE.script.sams) {
      for (let a = 0; a < 8; a++) {
        const ang = (a * Math.PI) / 4;
        expect(t.isWater(s.x + Math.sin(ang) * 1500, s.z + Math.cos(ang) * 1500), `${s.id} ${a}`).toBe(true);
      }
    }
    expect(T05_DEFENCE.script.sams.every((s) => s.type === 'ad_boat' && s.noHarass)).toBe(true);
  });

  it('three drills, two in a row each, with a way on: no high-altitude drill and no exam', () => {
    const objs = T05_DEFENCE.script.objectives;
    expect(objs.map((o) => o.id)).toEqual(['o_d1', 'o_d2', 'o_d3']);
    for (const o of objs) {
      expect(o.kind, o.id).toBe('missile_drill');
      if (o.kind !== 'missile_drill') continue;
      expect([o.defeat, o.inARow, o.moveOn], o.id).toEqual([2, true, DRILL_MOVE_ON_AFTER]);
    }
    expect(DRILL_MOVE_ON_AFTER).toBe(4);
    // the first boat is close and ahead: nothing to fly through before the first shot
    expect(Math.hypot(DEFENCE.b1.x - DEFENCE.start.x, DEFENCE.b1.z - DEFENCE.start.z)).toBeLessThan(15_000);
    expect(T05_DEFENCE.player.altitude).toBeLessThan(6_000);
    expect(T05_DEFENCE.briefing.length).toBeLessThanOrEqual(3);
  });

  it('the student flies it: every drill in about three minutes', { timeout: 300_000 }, () => {
    let won = 0;
    const log: string[] = [];
    for (const seed of [0, 1, 2, 3, 4, 5]) {
      const r = runPlaythrough('t05', 'pilot', seed, realTerrain(), { maxT: 600, log: true });
      const done = completed(r);
      log.push(`seed ${seed}: ${r.state}@${r.t}s ${[...done].map(([k, v]) => `${k}@${v}`).join(' ')}`);
      if (r.state === 'success' && r.t <= 300) won++;
      expect(r.state, `seed ${seed}`).toBe('success');
      // once drill 3 opens, only heat-seekers fly (drill 2's boat holds fire, drill 3's is IR-only)
      const d3 = r.events.findIndex((e) => / OBJ o_d3 active/.test(e));
      expect(d3, `seed ${seed}`).toBeGreaterThanOrEqual(0);
      expect(r.events.slice(d3).filter((e) => / LAUNCH m_9m330 /.test(e)), `seed ${seed}`).toEqual([]);
      expect(r.alive, `seed ${seed}: practice rounds, nothing kills the jet`).toBe(true);
    }
    expect(won, log.join('\n')).toBeGreaterThanOrEqual(4);
  });

  it('ignoring the missile warning: the coach moves him on, so the lesson ends instead of hanging', { timeout: 300_000 }, () => {
    const log: string[] = [];
    let d3Skipped = 0;
    let irRounds = 0;
    let irHits = 0;
    for (const seed of [0, 1, 2, 4]) {
      const r = runPlaythrough('t05', 'pilot', seed, realTerrain(), { maxT: 900, log: true, bot: { defend: false } });
      const moved = r.events.filter((e) => e.includes(DRILL_MOVE_ON)).length;
      const d3 = r.events.slice(r.events.findIndex((e) => / OBJ o_d3 active/.test(e)));
      irRounds += d3.filter((e) => / LAUNCH m_igla /.test(e)).length;
      irHits += d3.filter((e) => / HUD HIT — heat-seeker/.test(e)).length;
      if (r.result!.objectives.find((o) => o.id === 'o_d3')?.skipped) d3Skipped++;
      log.push(`seed ${seed}: ${r.state}@${r.t}s moved on ${moved}× ${[...completed(r)].map(([k, v]) => `${k}@${v}`).join(' ')}`);
      expect(r.state, log.join('\n')).toBe('success');
      expect(moved, log.join('\n')).toBeGreaterThanOrEqual(1);
      // ...and says which drills he skipped instead of "All objectives complete" (r2, 2.3-h)
      expect(r.reason, log.join('\n')).toMatch(/^Drills? [\d–, and]+ skipped: fly Gulf Defence again$/);
      expect(r.result!.objectives.filter((o) => o.skipped).length, log.join('\n')).toBeGreaterThanOrEqual(moved);
    }
    // drill 3 tests the defence, not the geometry: its heat-seekers reach a pass that isn't defended
    // (#284: passing 3.5 km off, every one fell short of it or was outflown, and the drill passed)
    log.push(`drill 3: skipped ${d3Skipped}/4, heat-seekers hit ${irHits}/${irRounds}`);
    expect(d3Skipped, log.join('\n')).toBeGreaterThanOrEqual(3);
    expect(irHits, log.join('\n')).toBeGreaterThan(irRounds / 2);
  });

  it('the drill 3 boat appears only when its drill opens, 1.5 km from the pass point, and fires only heat-seekers in reach', () => {
    const later = T05_DEFENCE.script.sams.filter((s) => s.spawn).map((s) => s.id);
    expect(later).toEqual(['b3']);
    expect(T05_DEFENCE.script.sams.map((s) => !!s.irOnly)).toEqual([false, false, true]);
    // ...restocked once spent: never out of rounds with the drill still open (r2 soft lock)
    expect(T05_DEFENCE.script.sams.map((s) => !!s.restock)).toEqual([false, false, true]);
    expect(Math.hypot(DEFENCE.d3Pass.x - DEFENCE.b3.x, DEFENCE.d3Pass.z - DEFENCE.b3.z)).toBeCloseTo(1500, -2);
    // ...only inside its reach (the pass comes through it), never up the tail of a jet flying away (#284)
    expect(T05_DEFENCE.script.sams.map((s) => s.irReach)).toEqual([undefined, undefined, D3_REACH]);
    expect(D3_REACH).toBeGreaterThan(1500);
  });
});

describe('SAM site: an empty launcher reloads from track (found by t05)', () => {
  it('a site left in track with no rounds and nothing in flight goes to reload and comes back full', async () => {
    const { FakeWorld, FlatTerrain, v3 } = await import('./combat-helpers');
    const w = new FakeWorld({ difficulty: 'pilot', terrain: new FlatTerrain(0) });
    const site = w.spawnSam({ type: 'ad_boat', team: 'red', position: v3(0, 0, 0) });
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 2000, -7000), heading: 0, speed: 0, loadout: 'a2a_stealth' });
    w.controllers.set(p.id, (ac) => ac.velocity.set(0, 0, 0));
    w.run(5);
    // the state the bug left it in: tracking, launcher empty, nothing in flight
    site.missilesReady = 0;
    site.state = 'track';
    site.trackedTargetId = p.id;
    w.run(1);
    expect(site.state).toBe('reload');
    w.run(95);
    expect(site.missilesReady).toBe(site.missilesMax);
  });
});

describe('a range boat fires its heat-seekers only where they reach (irReach, found by t05: #284)', () => {
  /** Heat-seekers an IR-only boat fires in `seconds` at a jet starting `range` m north of it at 150 m, flying on at 200 m/s. */
  async function irShots(range: number, away: boolean, irReach: number | undefined, seconds: number): Promise<number> {
    const { FakeWorld, FlatTerrain, v3 } = await import('./combat-helpers');
    const w = new FakeWorld({ difficulty: 'pilot', terrain: new FlatTerrain(0) });
    const site = w.spawnSam({ type: 'ad_boat', team: 'red', position: v3(0, 0, 0) });
    site.irOnly = true;
    site.irReach = irReach;
    const launches = w.record('munition:launch');
    w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 150, -range), heading: away ? 0 : Math.PI, speed: 200, loadout: 'a2a_stealth' });
    w.run(seconds);
    return launches.filter((e) => e.missile.def.id === 'm_igla').length;
  }

  it('fires at a jet coming in, never up the tail of one flying away', async () => {
    // a jet flying away from 1.2 km out: a round chases its tail (the SA-18 reaches ~0.8 km up the tail low down)
    expect(await irShots(1_200, true, undefined, 6)).toBeGreaterThan(0);
    expect(await irShots(1_200, true, D3_REACH, 6)).toBe(0);
    // coming in from 2.4 km: in reach, and it fires
    expect(await irShots(2_400, false, D3_REACH, 6)).toBeGreaterThan(0);
  });
});
