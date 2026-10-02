/**
 * MISSIONS — pacing (#59): no campaign mission goes quiet for more than 90 s. A dead stretch is mission
 * time with no radio call, HUD message, launch, kill or objective change (tests/missions-pacing.ts),
 * read from the bot's event log. The playtest of 2026-10-02 (1.1-i) measured c11 at 131 s; on this
 * code c11 Pilot seed 0 was 112 s (143–255 s) and seed 2 was 169 s.
 * Measure any mission: npx vite-node tools/playtest/bot-sweep.ts -- --missions=<ids> --diffs=pilot --seeds=1 --log
 */
import { describe, expect, it } from 'vitest';
import { missionById, terrainPadsFor } from '../src/missions';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import type { TerrainQuery } from '../src/sim/api';
import { runPlaythrough } from './missions-bot';
import { MAX_DEAD_STRETCH, deadStretchText, deadStretches, longestDeadStretch, pacingEventTimes } from './missions-pacing';

describe('pacing: dead stretches in the bot event log (#59)', () => {
  const log = [
    '  0 OBJ o_a active',
    '  3 RADIO DARKSTAR: Viper 1, Darkstar. Picture clean.',
    '  5 BOT NAV pos=(0.0,0.0)km alt=6000',
    ' 10 RED Fulcrum 1:cap@40km/4m',
    ' 40 LAUNCH aim120 PLAYER -> Fulcrum 1 30.0km',
    ' 40 RADIO Viper 1: Fox Three',
    ' 75 DESTROYED Fulcrum 1 by PLAYER',
    ' 75 HUD SPLASH MIG-29',
    '100 MSL gbu39->2@3km v200 y4000',
    '150 BOT HOLD pos=(1.0,1.0)km alt=500',
    '200 OBJ o_a complete',
  ];

  it('counts radio, HUD messages, launches, kills and objective changes; the bot state lines do not break a stretch', () => {
    expect(pacingEventTimes(log)).toEqual([0, 3, 40, 40, 75, 75, 200]);
    expect(longestDeadStretch(log, 200)).toEqual({ from: 75, to: 200, length: 125 });
  });

  it('a silent opening and a silent tail are stretches too, and the list is longest first', () => {
    const quiet = log.slice(2); // no OBJ at 0, no radio at 3
    expect(deadStretches(quiet, 330).map((d) => [d.from, d.to])).toEqual([
      [200, 330],
      [75, 200],
      [0, 40],
      [40, 75],
    ]);
    expect(longestDeadStretch([], 95)).toEqual({ from: 0, to: 95, length: 95 });
    expect(longestDeadStretch([], 0).length).toBe(0);
    expect(deadStretchText(longestDeadStretch(log, 200))).toBe('125 s (75–200)');
  });
});

// One terrain per mission: it depends on the mission's seed and on its SAM and ground-target pads
// (terrainPadsFor), so a mission must never fly on another mission's terrain.
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

describe('pacing: c11 Grumble has no dead stretch over 90 s (#59)', () => {
  // async, yielding after every playthrough: a long synchronous stretch starves vitest's worker RPC
  // (see tests/missions-instant-balance.test.ts)
  it('logged Pilot runs, seeds 0–2 (seed 0 was 112 s waiting on a GBU-39, seed 2 169 s before the reserve scrambled)', { timeout: 300_000 }, async () => {
    for (const seed of [0, 1, 2]) {
      const r = runPlaythrough('c11', 'pilot', seed, terrainFor('c11'), { maxT: 900, log: true });
      const worst = longestDeadStretch(r.events, r.t);
      expect(worst.length, `c11 pilot seed ${seed}: ${r.state}@${r.t}s, longest dead stretch ${deadStretchText(worst)}`).toBeLessThanOrEqual(MAX_DEAD_STRETCH);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
});

// Re-measure once the layers that are rewriting these missions land (#57 c02, #58 c04, #65 c08).
// Pilot seed 0 on this code: c02 124 s (131–255), c04 141 s (86–227), c08 95 s (7–102).
describe('pacing: c02/c04/c08 have no dead stretch over 90 s (#59, after #57/#58/#65)', () => {
  it('each mission flies on its own terrain', () => {
    expect(terrainFor('c11')).toBe(terrainFor('c11'));
    expect(terrainFor('c02')).not.toBe(terrainFor('c11'));
  });

  it.todo('c02: no dead stretch over 90 s on Pilot seed 0 (after #57; the rearm trip is gone with #63)');
  it.todo('c04: no dead stretch over 90 s on Pilot seed 0 (after #58)');
  it.todo('c08: no dead stretch over 90 s on Pilot seed 0 (after #65)');
});
