/**
 * MISSIONS — integration smoke test: every campaign / training mission (and one of each
 * Instant Action mode) runs for 20 s of sim time with the REAL AI brains and CombatSystem
 * without errors, and the runner stays consistent.
 */
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import { CAMPAIGN, TRAINING, buildInstantMissionSeeded, createMissionRunner } from '../src/missions';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createAiBrain } from '../src/ai';
import { flatLand } from './missions-helpers';
import type { MissionDef } from '../src/core/contracts';

const instant: MissionDef[] = (['stroll', 'dogfight', 'sam_gauntlet', 'strike', 'defend', 'survival'] as const).map((mode, i) =>
  buildInstantMissionSeeded({ mode, theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 4 }, 42 + i),
);

describe('missions: integration with the real AI and combat', () => {
  for (const def of [...CAMPAIGN, ...TRAINING, ...instant]) {
    it(`${def.id} runs 20 s cleanly`, () => {
      const events = new EventBus();
      const diff = DIFFICULTIES.veteran;
      const world = createSimWorld({ terrain: flatLand(10), difficulty: diff, events, combat: createCombatSystemSeeded(11) });
      const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty: diff, events });
      const errors: unknown[] = [];
      const oe = console.error;
      console.error = (...a: unknown[]) => errors.push(a);
      let radios = 0;
      events.on('radio', () => radios++);
      try {
        runner.setup(world, def.recommendedLoadout);
        for (let i = 0; i < 60 * 20; i++) {
          world.step(1 / 60);
          runner.update(world, 1 / 60);
        }
      } finally {
        console.error = oe;
      }
      expect(errors).toEqual([]);
      expect(world.player).toBeTruthy();
      expect(radios).toBeGreaterThan(0);
      expect(['running', 'success', 'failed']).toContain(runner.state);
      const res = runner.result(world);
      expect(res.missionId).toBe(def.id);
      expect(Number.isFinite(res.score)).toBe(true);
      expect(res.objectives.length).toBe(runner.objectives.length);
    });
  }
});
