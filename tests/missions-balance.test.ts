/**
 * MISSIONS i2 — campaign difficulty walls (reviewer sweep with the project's MissionBot):
 *  - c04 'Broken Wing' was 0/2 on Pilot (SA-6 / SA-15 point defence shooting down the JDAMs);
 *  - c10 'Night Harbour' was 0/2 on Pilot (Su-27 sweep R-27s at 137/159 s) and failed on Recruit;
 *  - c07 'Mainstay' on Veteran/Ace was an unavoidable Su-35 R-77 kill at 51–58 s.
 * Full sweep: npx vite-node tools/playtest/bot-sweep.ts -- --missions=<ids> --diffs=<difficulties>.
 */
import { describe, expect, it } from 'vitest';
import { buildInstantMissionSeeded, missionById, terrainPadsFor } from '../src/missions';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { difficultyAtLeast } from '../src/missions/runtime/state';
import type { Difficulty } from '../src/core/types';
import type { TerrainQuery } from '../src/sim/api';
import { runPlaythrough } from './missions-bot';

const terrains = new Map<string, TerrainQuery>();
function terrainFor(id: string): TerrainQuery {
  let t = terrains.get(id);
  if (!t) {
    const def = missionById(id)!;
    t = new TerrainQueryImpl(runSync(generateTerrain({ theater: def.theater, seed: def.seed, resolution: 512, features: allFeatures(def.theater, []), pads: terrainPadsFor(def) })));
    terrains.set(id, t);
  }
  return t;
}

function wins(id: string, diff: Difficulty, seeds: number[]): { won: number; log: string[] } {
  const log: string[] = [];
  let won = 0;
  for (const seed of seeds) {
    const r = runPlaythrough(id, diff, seed, terrainFor(id), { maxT: 900 });
    if (r.state === 'success') won++;
    log.push(`${id} ${diff} seed ${seed}: ${r.state}@${Math.round(r.t)}s ${r.reason ?? ''}`);
  }
  return { won, log };
}

describe('i2: campaign content has no Pilot walls (static)', () => {
  it('c04: the SA-15 point defence only appears from Veteran up', () => {
    const sa15 = missionById('c04')!.script.sams.find((s) => s.type === 'sa15')!;
    expect(difficultyAtLeast('pilot', sa15.minDifficulty)).toBe(false);
    expect(difficultyAtLeast('veteran', sa15.minDifficulty)).toBe(true);
  });
  it('Instant Action strike: the SA-15 Tor only appears from Veteran up, as in c04 (playtest 2026-10-02, 1.1-b)', () => {
    for (const theater of ['auckland', 'desert'] as const) {
      const def = buildInstantMissionSeeded({ mode: 'strike', theater, timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 4 }, 1);
      const sa15 = def.script.sams.find((s) => s.type === 'sa15')!;
      expect(difficultyAtLeast('pilot', sa15.minDifficulty)).toBe(false);
      expect(difficultyAtLeast('veteran', sa15.minDifficulty)).toBe(true);
    }
  });
  it('c12: the Motutapu SA-15 is Pilot+, so the Recruit finale is forgiving (playtest 2026-10-02, 3.2-b: Recruit 4/8 → 7/8)', () => {
    const sa15 = missionById('c12')!.script.sams.find((s) => s.id === 'sa15')!;
    expect(difficultyAtLeast('recruit', sa15.minDifficulty)).toBe(false);
    expect(difficultyAtLeast('pilot', sa15.minDifficulty)).toBe(true);
  });
  it('c10: the Flanker sweep is Veteran+ and the eastern raid leaves time for the northern one', () => {
    const def = missionById('c10')!;
    const sweep = def.script.groups.find((g) => g.id === 'sweep')!;
    expect(sweep.minDifficulty).toBe('veteran');
    const raidE = def.script.groups.find((g) => g.id === 'raidE')!;
    expect(raidE.spawn).toMatchObject({ kind: 'time' });
    expect((raidE.spawn as { t: number }).t).toBeGreaterThanOrEqual(150);
  });
  it('c07: the Su-35 CAP starts beyond first-shot range of the player start (> 40 km)', () => {
    const def = missionById('c07')!;
    const cap = def.script.groups.find((g) => g.id === 'cap')!;
    expect(Math.hypot(cap.x - def.player.x, cap.z - def.player.z)).toBeGreaterThan(40_000);
  });
});

describe('i2: MissionBot playthroughs (real World / Combat / AI, 3 seeds)', () => {
  it('c04 Broken Wing is winnable on Pilot (≥ 2/3; was 0/2)', { timeout: 300_000 }, () => {
    const r = wins('c04', 'pilot', [1, 2, 3]);
    expect(r.won, r.log.join('\n')).toBeGreaterThanOrEqual(2);
  });
  it('c10 Night Harbour is winnable on Pilot (≥ 2/3; was 0/2) and on Recruit', { timeout: 300_000 }, () => {
    const p = wins('c10', 'pilot', [1, 2, 3]);
    expect(p.won, p.log.join('\n')).toBeGreaterThanOrEqual(2);
    const rc = wins('c10', 'recruit', [1, 2]);
    expect(rc.won, rc.log.join('\n')).toBeGreaterThanOrEqual(1);
  });
  it('c07 on Veteran: no scripted R-77 ambush in the first 80 s (was dead at 51–58 s in every run)', { timeout: 300_000 }, () => {
    for (const seed of [1, 2, 3]) {
      const r = runPlaythrough('c07', 'veteran', seed, terrainFor('c07'), { maxT: 80 });
      expect(r.state === 'failed' && r.t < 80, `seed ${seed}: ${r.state}@${Math.round(r.t)}s ${r.reason ?? ''}`).toBe(false);
    }
  });
});
