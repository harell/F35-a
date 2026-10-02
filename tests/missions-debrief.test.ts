/**
 * MISSIONS — scoring and debrief follow-ups from the 2026-10-02 playtest's exploit charter (#64):
 *  - a win with no kills and no shots (bandits only driven off, or killed by someone else) grades
 *    at most C and doesn't award Untouchable (2.3-b: a parked Defend win got A, ACE ×2, Untouchable);
 *  - one pass under the Harbour Bridge in T01 pays once, and the stunt and o_bridge share one span
 *    test (2.3-d: +250 twice, and the two hit zones disagreed);
 *  - the debrief's NEXT button says 'Next lesson' / 'Start the campaign' in training, and the
 *    "use the AMRAAM's reach" time tip stays out of missions with nothing to shoot or under par (2.3-e).
 */
import { describe, expect, it } from 'vitest';
import type { MissionDef } from '../src/core/contracts';
import { missionById } from '../src/missions';
import { computeScore, type ScoreInput } from '../src/missions/runtime/scoring';
import { harness, killGroup, shieldPlayer } from './missions-helpers';

const byId = (id: string): MissionDef => missionById(id)!;

describe('#64: no fight, no credit', () => {
  // the parked Defend run from the playtest: everything driven off, nothing fired, nothing killed
  const parked: ScoreInput = {
    success: true,
    time: 112,
    parTime: 420,
    kills: { air: 0, sam: 0, ground: 0 },
    enemiesSpawned: 4,
    objectiveBonus: 750,
    primaryDone: 2,
    primaryTotal: 2,
    secondaryDone: 0,
    secondaryTotal: 0,
    shotsFired: 0,
    hits: 0,
    damageTaken: 0,
    friendlyLosses: 0,
    bonus: 0,
    scoreMultiplier: 1,
  };

  it('a 0-kill, 0-shot win rates a share of 0 and grades at most C', () => {
    const r = computeScore(parked);
    expect(r.playerShare).toBe(0);
    expect(['C', 'D', 'F']).toContain(r.grade);
  });

  it('a mission with no hostiles (T01) still grades as before: nothing to fight is not "no fight"', () => {
    const r = computeScore({ ...parked, enemiesSpawned: 0, time: 150, parTime: 300 });
    expect(r.playerShare).toBe(1);
    expect(['S', 'A']).toContain(r.grade);
  });

  it('a player who fought keeps the old grading', () => {
    const r = computeScore({ ...parked, kills: { air: 4, sam: 0, ground: 0 }, shotsFired: 4, hits: 4 });
    expect(r.playerShare).toBe(1);
    expect(['S', 'A']).toContain(r.grade);
  });

  it('end to end: c01 won with every MiG killed by nobody the player flies with → at most C, no Untouchable', () => {
    const h = harness(byId('c01'));
    h.run(1, () => shieldPlayer(h));
    expect(killGroup(h, 'fulcrum1', false)).toBeGreaterThan(0);
    h.run(9, () => shieldPlayer(h)); // the second pair spawns 7 s after the first is down
    expect(killGroup(h, 'fulcrum2', false)).toBeGreaterThan(0);
    h.run(1, () => shieldPlayer(h));
    expect(h.runner.state).toBe('success');
    const r = h.runner.result(h.world);
    expect(r.shotsFired).toBe(0);
    expect(r.kills).toEqual({ air: 0, sam: 0, ground: 0 });
    expect(['C', 'D', 'F']).toContain(r.grade);
    expect(r.medals!.map((m) => m.id)).not.toContain('no_hits');
  });

  it('Untouchable still goes to a clean win the player fought', () => {
    const h = harness(byId('c01'));
    h.run(1, () => shieldPlayer(h));
    killGroup(h, 'fulcrum1');
    h.run(9, () => shieldPlayer(h));
    killGroup(h, 'fulcrum2');
    h.run(1, () => shieldPlayer(h));
    expect(h.runner.state).toBe('success');
    const p = h.world.player!;
    p.shotsFired = 4;
    p.hits = 4;
    p.health = p.maxHealth;
    const r = h.runner.result(h.world);
    expect(r.medals!.map((m) => m.id)).toContain('no_hits');
    expect(['S', 'A']).toContain(r.grade);
  });
});
