/**
 * T03 "Maritime Strike" (StormBreaker, AARGM-ER and gun against boats, src/missions/content/trainingStrike.ts),
 * flown by the mission bot on the real LINZ coast at Pilot (training's fixed difficulty):
 *  - every boat's route runs in open water, 1 km from any shore;
 *  - the first boats are out of a StormBreaker's reach at the start (the lesson is "height is range");
 *  - the bot wins it, and the air-defence boat's practice rounds never kill the jet.
 * Sweep: npx vite-node tools/playtest/bot-sweep.ts -- --missions=t03 --seeds=12 --log
 */
import { describe, expect, it } from 'vitest';
import { missionById, terrainPadsFor } from '../src/missions';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { T03, T03_DEF } from '../src/missions/content/trainingStrike';
import { runPlaythrough } from './missions-bot';

let terrain: TerrainQueryImpl | null = null;
function realTerrain(): TerrainQueryImpl {
  if (!terrain) {
    const def = missionById('t03')!;
    terrain = new TerrainQueryImpl(runSync(generateTerrain({ theater: def.theater, seed: def.seed, resolution: 512, features: allFeatures(def.theater, []), pads: terrainPadsFor(def) })));
  }
  return terrain;
}

describe('t03 Maritime Strike', () => {
  it('every boat route runs in open water, 1 km from any shore', () => {
    const t = realTerrain();
    const routes = [...T03_DEF.script.ground, ...T03_DEF.script.sams].map((b) => ({ id: b.id, path: b.path ?? [] }));
    expect(routes.every((r) => r.path.length >= 2)).toBe(true);
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

  it('the first boats start out of a StormBreaker’s reach from 10,000 ft (~11.5 km)', () => {
    const near = Math.min(...T03_DEF.script.ground.filter((g) => g.group === 'd1').map((g) => Math.hypot(g.x - T03.start.x, g.z - T03.start.z)));
    expect(near).toBeGreaterThan(12500);
  });

  it('the bot flies it: every drill, never killed by a practice round', { timeout: 300_000 }, () => {
    let won = 0;
    const log: string[] = [];
    for (const seed of [0, 1, 2, 3, 4, 5]) {
      const r = runPlaythrough('t03', 'pilot', seed, realTerrain(), { maxT: 900 });
      log.push(`seed ${seed}: ${r.state}@${r.t}s ${r.reason ?? ''}`);
      if (r.state === 'success') won++;
      expect(r.alive, `seed ${seed}: practice rounds, nothing kills the jet`).toBe(true);
    }
    expect(won, log.join('\n')).toBeGreaterThanOrEqual(5);
  });
});
