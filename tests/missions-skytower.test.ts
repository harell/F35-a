/**
 * The Sky Tower in the mission runtime and saved progress (issues #16, #75): stood up intact in
 * every Auckland sortie; one enemy hit damages it (radio call, HUD) and the sortie goes on, a second
 * collapses it and fails the mission; the player destroying it (damaged or not) fails the mission at
 * once (AWACS check-fire call, debrief reason and tip); survival runs end; and it is never destroyed
 * for good: nothing goes in the save, so a restart (or an old save that has it down) finds it standing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three';
import { AKL } from '../src/core/auckland';
import type { CampaignProgress, MissionDef, MissionResult } from '../src/core/contracts';
import { CAMPAIGN, TRAINING, missionById, recordResult, skipMission } from '../src/missions';
import { PROGRESS_KEY, defaultProgress, loadProgressFrom, sanitizeProgress } from '../src/missions/progress';
import { REASONS } from '../src/missions/runtime/reasons';
import { destroyLandmark, hitSkyTower } from '../src/sim/landmarks';
import { harness, type Harness } from './missions-helpers';

const byId = (id: string): MissionDef => missionById(id)!;

/** The player's JDAM brings it down (the path sim/weapons/flight.ts takes). */
function knockDown(h: Harness): void {
  const tower = h.world.landmarks[0];
  const p = h.world.player!;
  destroyLandmark(tower, h.world.events, h.world.time, new Vector3(AKL.skytower.x + 10, 200, AKL.skytower.z), p.id, 'gbu31', p.position);
}

/** An enemy hit (a Shahed diving into it, #76 / #78). */
const enemyHit = (h: Harness): number => hitSkyTower(h.world, { attackerId: 999 });

describe('Sky Tower in Auckland sorties', () => {
  it('every mission (all Auckland) stands the tower up', () => {
    for (const def of [byId('c01'), byId('t01'), byId('ia_strike_auckland'), byId('ia_survival_auckland')]) {
      const h = harness(def);
      expect(h.world.landmarks.map((l) => l.id), def.id).toEqual(['skytower']);
      expect(h.world.landmarks[0].base.x).toBeCloseTo(AKL.skytower.x, 6);
    }
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
    const r = h.runner.result(h.world);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('Destroyed the Sky Tower');
    expect(h.world.landmarks[0].fallHeading).toBeCloseTo((270 * Math.PI) / 180, 6); // hit from the east
    expect(r.tips?.[0]).toMatch(/Sky Tower is a protected landmark/);
    expect(r).not.toHaveProperty('skyTowerDown');
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

  it('one enemy hit: damaged, "Sky Tower is hit!", SKY TOWER HIT, and the sortie goes on', () => {
    const h = harness(byId('c01'));
    h.run(3);
    expect(enemyHit(h)).toBe(1);
    h.run(2);
    const tower = h.world.landmarks[0];
    expect(tower.alive).toBe(true);
    expect(tower.hits).toBe(1);
    expect(h.runner.state).toBe('running');
    expect(h.of('mission:end')).toEqual([]);
    expect(h.of('radio').some((r) => /Sky Tower is hit!/.test(r.text))).toBe(true);
    expect(h.of('hud:message').some((m) => m.text === 'SKY TOWER HIT')).toBe(true);
    h.run(10);
    expect(h.runner.state).toBe('running');
  });

  it('a second enemy hit collapses it and fails the mission (no check fire, no "protected landmark" tip)', () => {
    const h = harness(byId('c01'));
    h.run(3);
    enemyHit(h);
    h.run(5);
    expect(enemyHit(h)).toBe(2);
    h.run(0.5);
    expect(h.world.landmarks[0].alive).toBe(false);
    expect(h.runner.state).toBe('failed');
    expect(h.of('mission:end')).toEqual([{ success: false, reason: REASONS.skytowerLost }]);
    expect(h.of('hud:message').some((m) => m.text === 'SKY TOWER DESTROYED')).toBe(true);
    h.run(6);
    const radio = h.of('radio').map((r) => r.text);
    expect(radio.some((t) => /Sky Tower is coming down/.test(t))).toBe(true);
    expect(radio.some((t) => /Check fire/.test(t))).toBe(false);
    const r = h.runner.result(h.world);
    expect(r.reason).toBe('The Sky Tower fell');
    expect(r.tips ?? []).not.toContainEqual(expect.stringMatching(/protected landmark/));
  });

  it('a player munition on the damaged tower: collapse, check fire, failed with the player reason', () => {
    const h = harness(byId('c01'));
    h.run(3);
    enemyHit(h);
    h.run(2);
    knockDown(h);
    h.run(0.5);
    expect(h.world.landmarks[0].alive).toBe(false);
    expect(h.world.landmarks[0].cause).toBe('player');
    expect(h.runner.state).toBe('failed');
    expect(h.of('mission:end')).toEqual([{ success: false, reason: REASONS.skytower }]);
    h.run(3);
    expect(h.of('radio').some((r) => /Check fire.*Sky Tower/.test(r.text))).toBe(true);
  });

  it('survival: enemy hits bringing it down end the run too', () => {
    const h = harness(byId('ia_survival_auckland'));
    h.run(2);
    enemyHit(h);
    enemyHit(h);
    h.run(0.5);
    expect(h.runner.state).toBe('failed');
    expect(h.runner.result(h.world).reason).toMatch(/^The Sky Tower fell — survived 0 waves$/);
  });
});

describe('Sky Tower: never destroyed for good (issue #75)', () => {
  const fresh = () => defaultProgress([CAMPAIGN], TRAINING);
  /** What Game does between sorties: fold the result into the save, write it, read it back. */
  const saveAndLoad = (p: CampaignProgress) => sanitizeProgress(JSON.parse(JSON.stringify(p)), [CAMPAIGN], TRAINING);

  afterEach(() => vi.unstubAllGlobals());

  it('restarting the mission after a collapse (or after damage) finds the tower intact', () => {
    let p = fresh();
    for (const what of ['collapse', 'damage'] as const) {
      const h = harness(byId('c01'));
      h.run(3);
      enemyHit(h);
      if (what === 'collapse') knockDown(h);
      h.run(1);
      p = saveAndLoad(recordResult(p, h.runner.result(h.world)));
      expect(p).not.toHaveProperty('skyTowerDown');
      h.runner.dispose?.();
      const again = harness(byId('c01'));
      const tower = again.world.landmarks[0];
      expect(tower.id, what).toBe('skytower');
      expect(tower.alive, what).toBe(true);
      expect(tower.hits, what).toBe(0);
      expect(tower.damagedAt, what).toBe(-1);
      // and it takes two fresh hits again
      expect(enemyHit(again), what).toBe(1);
      expect(tower.alive, what).toBe(true);
    }
  });

  it('an old save with skyTowerDown loads with the tower standing (the flag is dropped)', () => {
    const old = { ...fresh(), skyTowerDown: { fallHeading: 1.25 } } as CampaignProgress;
    const store = new Map<string, string>([[PROGRESS_KEY, JSON.stringify(old)]]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    const loaded = loadProgressFrom([CAMPAIGN], TRAINING);
    expect(loaded).not.toHaveProperty('skyTowerDown');
    expect(loaded.unlocked).toContain('c01');
    // results and skips folded into an unsanitised old object don't carry it on either
    const fail: MissionResult = { missionId: 'c01', title: 'x', success: false, reason: REASONS.skytower, difficulty: 'pilot', time: 60, score: 0, grade: 'F', kills: { air: 0, sam: 0, ground: 0 }, friendlyLosses: 0, shotsFired: 1, hits: 0, accuracy: 0, damageTaken: 0, objectives: [] };
    expect(recordResult(old, fail)).not.toHaveProperty('skyTowerDown');
    expect(skipMission(old, 'c01')).not.toHaveProperty('skyTowerDown');
    // every Auckland sortie flown on that save stands the tower up
    const h = harness(byId('c01'));
    expect(h.world.landmarks.map((l) => [l.id, l.alive])).toEqual([['skytower', true]]);
  });
});
