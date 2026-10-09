/**
 * DEFENCE "Gulf Defence" (missile-defence drills with practice rounds, src/missions/content/trainingDefence.ts),
 * flown by the mission bot on the real LINZ coast at Pilot (training's fixed difficulty):
 *  - every range boat sits in open water;
 *  - drill 1 (above 23,000 ft) draws no shot;
 *  - the student (the bot in a defenceCoach mission: beam + CMS as taught) gets through the drills;
 *  - a pilot who ignores the warning (bot option defend: false) is stuck at drill 2: two in a row
 *    don't come by luck.
 * Sweep: npx vite-node tools/playtest/bot-sweep.ts -- --missions=t05 --seeds=12 --log
 */
import { describe, expect, it } from 'vitest';
import { missionById, terrainPadsFor } from '../src/missions';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { DEFENCE, T05_DEFENCE } from '../src/missions/content/trainingDefence';
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
  it('every range boat sits in open water, 1.5 km from any shore', () => {
    const t = realTerrain();
    for (const s of T05_DEFENCE.script.sams) {
      for (let a = 0; a < 8; a++) {
        const ang = (a * Math.PI) / 4;
        expect(t.isWater(s.x + Math.sin(ang) * 1500, s.z + Math.cos(ang) * 1500), `${s.id} ${a}`).toBe(true);
      }
    }
    expect(T05_DEFENCE.script.sams.every((s) => s.type === 'ad_boat' && s.noHarass)).toBe(true);
  });

  it('the student flies it: every drill and the exam, drill 1 without a shot fired', { timeout: 300_000 }, () => {
    let won = 0;
    const log: string[] = [];
    for (const seed of [0, 1, 2, 3, 4, 5]) {
      const r = runPlaythrough('t05', 'pilot', seed, realTerrain(), { maxT: 900, log: true });
      const done = completed(r);
      log.push(`seed ${seed}: ${r.state}@${r.t}s ${[...done].map(([k, v]) => `${k}@${v}`).join(' ')}`);
      if (r.state === 'success') won++;
      // drill 1: nothing launched at the jet before it was done
      const d1 = done.get('o_d1') ?? Infinity;
      expect(r.events.filter((e) => /LAUNCH m_\S+ sam -> Viper 1/.test(e) && Number(e.trim().split(' ')[0]) < d1), `seed ${seed}`).toEqual([]);
      expect(r.alive, `seed ${seed}: practice rounds, nothing kills the jet`).toBe(true);
    }
    expect(won, log.join('\n')).toBeGreaterThanOrEqual(5);
  });

  it('ignoring the missile warning does not pass drill 2 (three in a row)', { timeout: 300_000 }, () => {
    let passed = 0;
    const log: string[] = [];
    for (const seed of [0, 1, 2, 3, 4, 5]) {
      const r = runPlaythrough('t05', 'pilot', seed, realTerrain(), { maxT: 600, log: true, bot: { defend: false } });
      const done = completed(r);
      log.push(`seed ${seed}: ${[...done].map(([k, v]) => `${k}@${v}`).join(' ')}`);
      expect(done.has('o_d1'), `seed ${seed}`).toBe(true);
      if (done.has('o_d2')) passed++;
    }
    expect(passed, log.join('\n')).toBeLessThanOrEqual(1);
  });

  it('the drill 4 boat and the exam boats appear only when their drill opens', () => {
    const later = T05_DEFENCE.script.sams.filter((s) => s.spawn).map((s) => s.id);
    expect(later.sort()).toEqual(['b4', 'ex1', 'ex2']);
    expect(Math.hypot(DEFENCE.d4Pass.x - DEFENCE.b4.x, DEFENCE.d4Pass.z - DEFENCE.b4.z)).toBeCloseTo(3500, -2);
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
