/**
 * STRIKE "Maritime Strike" (StormBreaker, AARGM-ER and gun against boats, src/missions/content/trainingStrike.ts),
 * flown by the mission bot on the real LINZ coast at Pilot (training's fixed difficulty):
 *  - every boat's route (or anchorage) is in open water, 1 km from any shore;
 *  - the drills sit close together (playtest 2026-10-10, 1.4-e): the first boat is in a StormBreaker's
 *    reach at the start, the air-defence boat and the gun boat a few kilometres on;
 *  - the AARGM drill teaches the one rule (AARGM_RULE), and an AARGM fired by it sinks the air-defence boat
 *    (playtest r2, 2.3-d: its crew went quiet, 4 of 6 runs' AARGMs missed and a bomb passed the drill);
 *  - the bot wins it in about 3 minutes with no long quiet stretch, and the air-defence boat's practice
 *    rounds never kill the jet.
 * Sweep: npx vite-node tools/playtest/bot-sweep.ts -- --missions=t04 --seeds=12 --log
 */
import { describe, expect, it } from 'vitest';
import { missionById, terrainPadsFor } from '../src/missions';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { AARGM_RULE } from '../src/core/data';
import { STRIKE, T04_STRIKE } from '../src/missions/content/trainingStrike';
import { runPlaythrough } from './missions-bot';
import { MAX_DEAD_STRETCH, deadStretchText, longestDeadStretch } from './missions-pacing';

let terrain: TerrainQueryImpl | null = null;
function realTerrain(): TerrainQueryImpl {
  if (!terrain) {
    const def = missionById('t04')!;
    terrain = new TerrainQueryImpl(runSync(generateTerrain({ theater: def.theater, seed: def.seed, resolution: 512, features: allFeatures(def.theater, []), pads: terrainPadsFor(def) })));
  }
  return terrain;
}

describe('t04 Maritime Strike', () => {
  it('every boat route runs in open water, 1 km from any shore', () => {
    const t = realTerrain();
    // (a boat at anchor: its spot, as a route of one point)
    const routes = [...T04_STRIKE.script.ground, ...T04_STRIKE.script.sams].map((b) => ({ id: b.id, path: b.path ?? [{ x: b.x, z: b.z }] }));
    for (const r of routes) {
      const pts = [...r.path, r.path[0]];
      for (let i = 0; i + 1 < pts.length; i++) {
        for (let f = 0; f <= 1; f += 0.25) {
          const x = pts[i].x + (pts[i + 1].x - pts[i].x) * f;
          const z = pts[i].z + (pts[i + 1].z - pts[i].z) * f;
          for (let a = 0; a < 8; a++) {
            const ang = (a * Math.PI) / 4;
            expect(t.isWater(x + Math.sin(ang) * 1000, z + Math.cos(ang) * 1000), `${r.id} leg ${i} at ${f}`).toBe(true);
          }
        }
      }
    }
  });

  it('the drills sit close together: the first boat in reach at the start, the next boats a few km on', () => {
    const near = Math.min(...T04_STRIKE.script.ground.filter((g) => g.group === 'd1').map((g) => Math.hypot(g.x - STRIKE.start.x, g.z - STRIKE.start.z)));
    // a StormBreaker reaches ~11.5 km from 10,000 ft
    expect(near).toBeLessThan(11_000);
    expect(Math.hypot(STRIKE.d2.x - STRIKE.start.x, STRIKE.d2.z - STRIKE.start.z)).toBeLessThan(8_000);
    // the gun boat where the AARGM pass ends, low: ~3 km on (r2, 2.3-d)
    expect(Math.hypot(STRIKE.d3Path[0].x - STRIKE.d2.x, STRIKE.d3Path[0].z - STRIKE.d2.z)).toBeLessThan(4_000);
    expect(T04_STRIKE.briefing.length).toBeLessThanOrEqual(3);
  });

  it('the AARGM drill teaches the one rule: inside about 10 km while the radar is on, then press in', () => {
    expect(T04_STRIKE.briefing.join(' ')).toContain(AARGM_RULE);
    expect(T04_STRIKE.briefing.join(' ')).not.toMatch(/outside its 12 km reach/);
    expect(T04_STRIKE.script.hints!.find((h) => h.id === 'h_d2')!.text).toMatch(/inside 10 km while its radar is on/);
  });

  it('the air-defence boat is a range crew: it keeps its radar on under the AARGM', () => {
    const ad = T04_STRIKE.script.sams.find((s) => s.group === 'd2')!;
    expect(ad.noArmShutdown).toBe(true);
  });

  it('the bot flies it: every drill, the AARGM drill with AARGMs, about 3 minutes, never killed by a practice round', { timeout: 300_000 }, () => {
    let won = 0;
    const log: string[] = [];
    for (const seed of [0, 1, 2, 3, 4, 5]) {
      const r = runPlaythrough('t04', 'pilot', seed, realTerrain(), { maxT: 900, log: true });
      const dead = longestDeadStretch(r.events, r.t);
      log.push(`seed ${seed}: ${r.state}@${r.t}s ${r.reason ?? ''} ${deadStretchText(dead)}`);
      if (r.state === 'success') won++;
      expect(r.alive, `seed ${seed}: practice rounds, nothing kills the jet`).toBe(true);
      // the rule sinks the boat: no StormBreaker was needed on it (2.3-d: two AARGMs missed, then a bomb)
      const onAdBoat = r.launches.filter((l) => l.group === 'd2').map((l) => l.weapon);
      expect(onAdBoat, `seed ${seed}`).toEqual(['aargm']);
      expect(r.t, log.join('\n')).toBeLessThanOrEqual(210);
      expect(dead.length, log.join('\n')).toBeLessThanOrEqual(MAX_DEAD_STRETCH);
    }
    expect(won, log.join('\n')).toBe(6);
  });
});
