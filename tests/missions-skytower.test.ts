/**
 * The Sky Tower in the mission runtime and saved progress (issue #16): stood up in every Auckland
 * sortie, destroying it fails the mission at once (AWACS check-fire call, debrief reason and tip),
 * survival runs end, and the ruin persists in the save.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import { AKL } from '../src/core/auckland';
import type { MissionDef } from '../src/core/contracts';
import { CAMPAIGN, TRAINING, createMissionRunner, markSkyTowerDown, missionById, recordResult, skipMission, skyTowerRuin } from '../src/missions';
import { defaultProgress, sanitizeProgress } from '../src/missions/progress';
import { REASONS } from '../src/missions/runtime/reasons';
import type { MissionResultExt } from '../src/missions/runtime/resultExt';
import { destroyLandmark } from '../src/sim/landmarks';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { flatLand, harness, stubAi, type Harness } from './missions-helpers';

const byId = (id: string): MissionDef => missionById(id)!;

function knockDown(h: Harness): void {
  const tower = h.world.landmarks[0];
  const p = h.world.player!;
  destroyLandmark(tower, h.world.events, h.world.time, new Vector3(AKL.skytower.x + 10, 200, AKL.skytower.z), p.id, 'gbu31', p.position);
}

describe('Sky Tower in Auckland sorties', () => {
  it('every Auckland mode stands the tower up; other theatres do not', () => {
    for (const def of [byId('c01'), byId('t01'), byId('ia_strike_auckland'), byId('ia_survival_auckland')]) {
      const h = harness(def);
      expect(h.world.landmarks.map((l) => l.id), def.id).toEqual(['skytower']);
      expect(h.world.landmarks[0].base.x).toBeCloseTo(AKL.skytower.x, 6);
    }
    expect(harness(byId('ia_dogfight_desert')).world.landmarks).toEqual([]);
  });

  it('destroying it: check fire, SKY TOWER DESTROYED, mission failed with the reason, debrief tip', () => {
    const h = harness(byId('c01'));
    h.run(3);
    knockDown(h);
    h.run(0.5);
    expect(h.runner.state).toBe('failed');
    expect(h.of('mission:end')).toEqual([{ success: false, reason: REASONS.skytower }]);
    expect(h.of('hud:message').some((m) => m.text === 'SKY TOWER DESTROYED')).toBe(true);
    h.run(6);
    const radio = h.of('radio').map((r) => r.text);
    const check = radio.findIndex((t) => /Check fire.*Sky Tower/.test(t));
    const failed = radio.findIndex((t) => /Mission failed/.test(t));
    expect(check).toBeGreaterThanOrEqual(0);
    expect(failed).toBeGreaterThan(check);
    const r = h.runner.result(h.world) as MissionResultExt;
    expect(r.success).toBe(false);
    expect(r.reason).toBe('Destroyed the Sky Tower');
    expect(r.skyTowerDown?.fallHeading).toBeCloseTo((270 * Math.PI) / 180, 6); // hit from the east
    expect(r.tips?.[0]).toMatch(/Sky Tower is a protected landmark/);
  });

  it('the collapse keeps playing after MISSION FAILED', () => {
    const h = harness(byId('t01'));
    h.run(1);
    knockDown(h);
    const impacts: unknown[] = [];
    h.events.on('landmark:impact', (e) => impacts.push(e));
    h.run(8);
    expect(h.runner.state).toBe('failed');
    expect(impacts).toHaveLength(1);
  });

  it('survival ends the run', () => {
    const h = harness(byId('ia_survival_auckland'));
    h.run(2);
    knockDown(h);
    h.run(0.5);
    expect(h.runner.state).toBe('failed');
    expect(h.runner.result(h.world).reason).toMatch(/^Destroyed the Sky Tower — survived 0 waves$/);
  });

  it('a save with the tower down: no tower, no collision, nothing to destroy', () => {
    const events = new EventBus();
    const world = createSimWorld({ terrain: flatLand(), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(7) });
    const runner = createMissionRunner(byId('c01'), { createAi: stubAi({ created: [], retasked: [] }), difficulty: DIFFICULTIES.pilot, events, skyTowerDown: true });
    runner.setup(world, 'a2a_stealth');
    expect(world.landmarks).toEqual([]);
    expect((runner.result(world) as MissionResultExt).skyTowerDown).toBeUndefined();
  });

  it('an untouched tower leaves no mark on the result', () => {
    const h = harness(byId('c01'));
    h.run(2);
    expect((h.runner.result(h.world) as MissionResultExt).skyTowerDown).toBeUndefined();
  });
});

describe('Sky Tower persistence ("stays down")', () => {
  const fresh = () => defaultProgress(CAMPAIGN, TRAINING);

  it('round-trips through the save (JSON + sanitize)', () => {
    let p = fresh();
    expect(skyTowerRuin(p)).toBeNull();
    p = markSkyTowerDown(p, 1.25);
    const loaded = sanitizeProgress(JSON.parse(JSON.stringify(p)), CAMPAIGN, TRAINING);
    expect(skyTowerRuin(loaded)).toEqual({ fallHeading: 1.25 });
    // garbage is dropped
    expect(skyTowerRuin(sanitizeProgress({ ...p, skyTowerDown: { fallHeading: 'x' } }, CAMPAIGN, TRAINING))).toBeNull();
  });

  it('the first ruin sticks', () => {
    const p = markSkyTowerDown(markSkyTowerDown(fresh(), 1), 2);
    expect(skyTowerRuin(p)).toEqual({ fallHeading: 1 });
  });

  it('a mission result with the tower down marks the save; later results and skips keep it', () => {
    const fail = { missionId: 'c01', title: 'x', success: false, reason: REASONS.skytower, difficulty: 'pilot', time: 60, score: 0, grade: 'F', kills: { air: 0, sam: 0, ground: 0 }, friendlyLosses: 0, shotsFired: 1, hits: 0, accuracy: 0, damageTaken: 0, objectives: [] } as MissionResultExt;
    const withTower: MissionResultExt = { ...fail, skyTowerDown: { fallHeading: 0.5 } };
    let p = recordResult(fresh(), withTower);
    expect(skyTowerRuin(p)).toEqual({ fallHeading: 0.5 });
    p = recordResult(p, { ...fail, success: true, reason: REASONS.success, grade: 'A', score: 1000 });
    expect(skyTowerRuin(p)).toEqual({ fallHeading: 0.5 });
    p = skipMission(p, 'c02');
    expect(skyTowerRuin(p)).toEqual({ fallHeading: 0.5 });
    // the result never undoes an earlier mark
    expect(skyTowerRuin(recordResult(markSkyTowerDown(fresh(), 3), fail))).toEqual({ fallHeading: 3 });
  });
});
