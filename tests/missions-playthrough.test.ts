/**
 * MISSIONS — real-terrain playthroughs (i1) with the REAL World / Combat / AI / MissionRunner and
 * the scripted competent player (tests/missions-bot.ts), on the two-wave MiG-29 sweep
 * (sweepFixture, tests/missions-helpers.ts: the shape of the removed Southern Cross c01, which was
 * soft-locked on 'Splash the second MiG pair 1/2' and had no Veteran win), with win-rate bands per
 * difficulty (the reviewers' suggested regression test).
 * The full per-difficulty sweep is tools/playtest/bot-sweep.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { terrainPadsFor } from '../src/missions';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import type { TerrainQuery } from '../src/sim/api';
import { runPlaythrough } from './missions-bot';
import { sweepFixture } from './missions-helpers';

const SWEEP = sweepFixture();
let terrain512: TerrainQuery;

beforeAll(() => {
  terrain512 = new TerrainQueryImpl(
    runSync(generateTerrain({ theater: SWEEP.theater, seed: SWEEP.seed, resolution: 512, features: allFeatures(SWEEP.theater, []), pads: terrainPadsFor(SWEEP) })),
  );
}, 60_000);

describe('i1: the MiG sweep plays through (real AI, scripted competent player)', () => {
  it('never stalls on Recruit (c01 was "running" at 600 s with one MiG left)', { timeout: 120_000 }, () => {
    const rows = [1, 14, 27].map((seed) => runPlaythrough(SWEEP, 'recruit', seed, terrain512, { maxT: 900 }));
    expect(rows.every((r) => r.state !== 'running'), JSON.stringify(rows.map((r) => [r.state, r.t, r.objectives]))).toBe(true);
    expect(rows.filter((r) => r.state === 'success').length).toBeGreaterThanOrEqual(2);
  });

  it('win-rate bands for a competent player: Recruit ≥ 75 %, Pilot ≥ 75 %, Veteran ≥ 25 % (c01 was 0/6 on Veteran)', { timeout: 120_000 }, () => {
    const seeds = [1, 14, 27, 40];
    const band = (diff: 'recruit' | 'pilot' | 'veteran') => {
      const rows = seeds.map((seed) => runPlaythrough(SWEEP, diff, seed, terrain512, { maxT: 900 }));
      expect(rows.every((r) => r.state !== 'running'), `${diff} stalled`).toBe(true);
      return { wins: rows.filter((r) => r.state === 'success').length, why: JSON.stringify(rows.map((r) => [r.state, r.t, r.reason])) };
    };
    const rec = band('recruit');
    expect(rec.wins, rec.why).toBeGreaterThanOrEqual(3);
    const pil = band('pilot');
    expect(pil.wins, pil.why).toBeGreaterThanOrEqual(3);
    const vet = band('veteran');
    expect(vet.wins, vet.why).toBeGreaterThanOrEqual(1);
  });
});
