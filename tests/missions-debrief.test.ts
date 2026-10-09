/**
 * MISSIONS — scoring and debrief follow-ups from the 2026-10-02 playtest's exploit charter (#64):
 *  - a win with no kills and no hits (bandits only driven off, or killed by someone else) grades
 *    at most C, says why in the tips, and doesn't award Untouchable (2.3-b: a parked Defend win got
 *    A, ACE ×2, Untouchable; review: one gun burst into the air got around a shots-only rule);
 *  - one pass under the Harbour Bridge in T01 pays once, and the stunt and o_bridge share one span
 *    test (2.3-d: +250 twice, and the two hit zones disagreed);
 *  - the debrief's NEXT button says 'Next lesson' / 'Start the campaign' in training, and the
 *    "use the AMRAAM's reach" time tip stays out of missions with nothing to shoot or under par (2.3-e).
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus } from '../src/core/events';
import { AKL } from '../src/core/auckland';
import { DIFFICULTIES } from '../src/core/data';
import type { MissionDef, MissionResult } from '../src/core/contracts';
import { PLAYABLE_CAMPAIGNS, TRAINING, buildInstantMissionSeeded, missionById, nextMissionLabel, validateMission } from '../src/missions';
import { computeScore, type ScoreInput } from '../src/missions/runtime/scoring';
import { buildTips, hasAirToAirObjective } from '../src/missions/runtime/debrief';
import { MissionState } from '../src/missions/runtime/state';
import { flatLand, harness, killGroup, shieldPlayer, stubAi } from './missions-helpers';

const byId = (id: string): MissionDef => missionById(id)!;
/** The first playable campaign's missions (the IRGC campaign: g01, g02). */
const CAMPAIGN = PLAYABLE_CAMPAIGNS[0].missions;

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

  it('one gun burst into the air does not buy the grade back (review: a single shot gave B, A with the bridge)', () => {
    for (const bonus of [0, 250]) {
      const r = computeScore({ ...parked, shotsFired: 1, hits: 0, bonus });
      expect(r.playerShare, `bonus ${bonus}`).toBe(0);
      expect(['C', 'D', 'F'], `bonus ${bonus}`).toContain(r.grade);
    }
  });

  it('a hit without a kill (bandit damaged, then driven off) is a fight', () => {
    const r = computeScore({ ...parked, shotsFired: 2, hits: 1 });
    expect(r.playerShare).toBe(1);
    expect(['C', 'D', 'F']).not.toContain(r.grade);
  });

  it('end to end: g01 won with every Shahed killed by nobody the player flies with → at most C, no Untouchable', () => {
    const h = harness(byId('g01'));
    h.run(1, () => shieldPlayer(h));
    expect(killGroup(h, 'shaheds', false)).toBeGreaterThan(0);
    h.run(1, () => shieldPlayer(h));
    expect(h.runner.state).toBe('success');
    const r = h.runner.result(h.world);
    expect(r.shotsFired).toBe(0);
    expect(r.kills).toEqual({ air: 0, sam: 0, ground: 0 });
    expect(['C', 'D', 'F']).toContain(r.grade);
    expect(r.medals!.map((m) => m.id)).not.toContain('no_hits');
    // the debrief says why it is a C (review: the notes box was empty)
    expect(r.tips).toContain('You won without firing a shot: S and A grades need you in the fight — engage the bandits yourself.');
  });

  it('end to end: one shot that hit nothing still caps at C, gets no Untouchable, and the tip says why', () => {
    const h = harness(byId('g01'));
    h.run(1, () => shieldPlayer(h));
    expect(killGroup(h, 'shaheds', false)).toBeGreaterThan(0);
    h.run(1, () => shieldPlayer(h));
    expect(h.runner.state).toBe('success');
    const p = h.world.player!;
    p.shotsFired = 1; // one gun trigger pull
    p.hits = 0;
    p.health = p.maxHealth;
    const r = h.runner.result(h.world);
    expect(['C', 'D', 'F']).toContain(r.grade);
    expect(r.medals!.map((m) => m.id)).not.toContain('no_hits');
    expect(r.tips!.some((t) => /^You won without landing a hit: S and A grades need you in the fight/.test(t))).toBe(true);
  });

  it('Untouchable still goes to a clean win the player fought', () => {
    const h = harness(byId('g01'));
    h.run(1, () => shieldPlayer(h));
    expect(killGroup(h, 'shaheds')).toBeGreaterThan(0);
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

const _fwd = new Vector3(0, 0, -1);
const _dir = new Vector3();

/** Fly the T01 jet straight across the bridge line at `frac` (0 = south abutment, 1 = north), `alt` m MSL. */
function bridgePass(frac: number, alt = 20, passes = 1) {
  const h = harness(byId('t01'), 'pilot', undefined, flatLand(0));
  h.run(0.5, () => shieldPlayer(h));
  const scoreBefore = h.runner.result(h.world).score;
  const S = AKL.bridge_s;
  const N = AKL.bridge_n;
  const len = Math.hypot(N.x - S.x, N.z - S.z);
  const ux = (N.x - S.x) / len;
  const uz = (N.z - S.z) / len;
  // perpendicular to the deck
  const nx = -uz;
  const nz = ux;
  const cx = S.x + (N.x - S.x) * frac;
  const cz = S.z + (N.z - S.z) * frac;
  const p = h.world.player!;
  const v = 250;
  for (let pass = 0; pass < passes; pass++) {
    const dir = pass % 2 === 0 ? 1 : -1;
    let k = 0;
    // 600 m run-in to 600 m beyond the line, 250 m/s, re-pinned every step
    h.run(4.8, () => {
      const d = -600 + k * (v / 60);
      p.position.set(cx + nx * d * dir, alt, cz + nz * d * dir);
      p.velocity.set(nx * v * dir, 0, nz * v * dir);
      // nose along the track: Auto-GCAS (off above Recruit) no longer pulls a jet flying sideways off the deck
      p.quaternion.setFromUnitVectors(_fwd, _dir.set(nx * dir, 0, nz * dir));
      shieldPlayer(h);
      k++;
    });
  }
  const r = h.runner.result(h.world);
  return {
    r,
    scoreBefore,
    objective: r.objectives.find((o) => o.id === 'o_bridge')!.state,
    stunt: r.medals!.some((m) => m.id === 'bridge_runner'),
  };
}

describe('#64: the Harbour Bridge pays once in T01', () => {
  it('one pass under the span pays +250 once (stunt), and o_bridge completes on it', () => {
    const one = bridgePass(0.76);
    expect(one.stunt).toBe(true);
    expect(one.objective).toBe('complete');
    expect(one.r.success).toBe(false); // no time bonus in the difference
    expect(one.r.score - one.scoreBefore).toBe(Math.round(250 * DIFFICULTIES.pilot.scoreMultiplier));
    // a second pass (back the other way) doesn't pay again
    const two = bridgePass(0.76, 20, 2);
    expect(two.r.score).toBe(one.r.score);
  });

  it('the stunt and o_bridge use the same span test (sweep along the deck at 20 m)', () => {
    const hits: number[] = [];
    for (let f = 0.5; f <= 0.951; f += 0.05) {
      const { objective, stunt } = bridgePass(f);
      expect(objective === 'complete', `fraction ${f.toFixed(2)}: objective ${objective}, stunt ${stunt}`).toBe(stunt);
      if (stunt) hits.push(Number(f.toFixed(2)));
    }
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.length).toBeLessThan(10);
  });

  it("a 'bridge' objective validates in Auckland only", () => {
    const t01 = byId('t01');
    expect(validateMission(t01)).toEqual([]);
    // through unknown: the theatre list may shrink to Auckland only (#73)
    const elsewhere = { ...t01, theater: 'desert' } as unknown as MissionDef;
    expect(validateMission(elsewhere).some((e) => /o_bridge.*Harbour Bridge/.test(e))).toBe(true);
  });
});

describe('#64: training debrief', () => {
  it("NEXT reads 'Next lesson' between lessons and 'Start the campaign' after T03 and after the optional T04", () => {
    expect(TRAINING.map((m) => m.id)).toEqual(['t01', 't02', 't03', 't04']);
    expect(nextMissionLabel('t01')).toBe('Next lesson');
    expect(nextMissionLabel('t02')).toBe('Next lesson');
    expect(nextMissionLabel('t03')).toBe('Start the campaign');
    expect(nextMissionLabel('t04')).toBe('Start the campaign');
    for (const m of CAMPAIGN.slice(0, -1)) expect(nextMissionLabel(m.id), m.id).toBe('Next mission');
    expect(nextMissionLabel(CAMPAIGN[CAMPAIGN.length - 1].id)).toBeNull();
    expect(nextMissionLabel('ia_dogfight_auckland')).toBeNull();
  });

  it('knows which missions have an air-to-air objective', () => {
    expect(hasAirToAirObjective(byId('t01').script)).toBe(false);
    expect(hasAirToAirObjective(byId('t03').script)).toBe(false);
    expect(hasAirToAirObjective(byId('t02').script)).toBe(true);
    expect(hasAirToAirObjective(byId('g01').script)).toBe(true);
    const dogfight = buildInstantMissionSeeded({ mode: 'dogfight', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 2 }, 3);
    expect(hasAirToAirObjective(dogfight.script)).toBe(true);
  });

  const state = (id: string) => new MissionState(byId(id), { createAi: stubAi({ created: [], retasked: [] }), difficulty: DIFFICULTIES.pilot, events: new EventBus() });
  const win = (id: string, time: number): MissionResult => ({
    missionId: id,
    title: byId(id).title,
    success: true,
    reason: 'All objectives complete',
    difficulty: 'pilot',
    time,
    score: 1000,
    grade: 'A',
    kills: { air: 0, sam: 0, ground: 0 },
    friendlyLosses: 0,
    shotsFired: 0,
    hits: 0,
    accuracy: 0,
    damageTaken: 0,
    objectives: [],
  });
  const amraam = (tips: string[]) => tips.some((t) => /AMRAAM/.test(t));

  it('the AMRAAM time tip never shows in T01 (no weapons, no air-to-air objective)', () => {
    expect(amraam(buildTips(state('t01'), win('t01', 3)))).toBe(false);
    const slow = buildTips(state('t01'), win('t01', 900));
    expect(amraam(slow)).toBe(false);
    expect(slow.some((t) => /Faster missions score higher/.test(t))).toBe(true); // over par: the plain time tip
    expect(amraam(buildTips(state('t03'), win('t03', 900)))).toBe(false);
  });

  it('a no-fight win explains its C, in place of the wingman tip; a fight gets neither', () => {
    const noFightTip = (tips: string[]) => tips.some((t) => /S and A grades need you in the fight/.test(t));
    const wingmanTip = (tips: string[]) => tips.some((t) => /Your wingman scored/.test(t));
    const s = state('g01');
    s.enemiesSpawned = 4;
    s.flightKills = 4;
    const idle = buildTips(s, win('g01', 100));
    expect(noFightTip(idle)).toBe(true);
    expect(wingmanTip(idle)).toBe(false);
    // the player landed a hit: it was a fight, the wingman's share is the reason instead
    const hit = buildTips(s, { ...win('g01', 100), shotsFired: 2, hits: 1, accuracy: 0.5 });
    expect(noFightTip(hit)).toBe(false);
    expect(wingmanTip(hit)).toBe(true);
    // no hostiles at all (T01): nothing to say
    expect(noFightTip(buildTips(state('t01'), win('t01', 100)))).toBe(false);
    // a loss is not capped by it
    expect(noFightTip(buildTips(s, { ...win('g01', 100), success: false, reason: 'Out of time' }))).toBe(false);
  });

  it('a crash tip names Auto-GCAS only on Recruit, the one difficulty that has it', () => {
    const crashed = (d: 'recruit' | 'pilot' | 'veteran') => {
      const s = new MissionState(byId('g01'), { createAi: stubAi({ created: [], retasked: [] }), difficulty: DIFFICULTIES[d], events: new EventBus() });
      s.playerDied = true;
      s.stats.downReason = 'crash';
      return buildTips(s, { ...win('g01', 100), success: false, reason: 'Crashed', difficulty: d });
    };
    expect(crashed('recruit').some((t) => /let Auto-GCAS fly the pull-up/.test(t))).toBe(true);
    for (const d of ['pilot', 'veteran'] as const) {
      const tips = crashed(d);
      expect(tips.some((t) => /no Auto-GCAS, so the pull-up is yours/.test(t))).toBe(true);
      expect(tips.some((t) => /let Auto-GCAS/.test(t))).toBe(false);
    }
  });

  it('the time tip only shows over par', () => {
    const par = byId('g01').script.parTime!;
    expect(buildTips(state('g01'), win('g01', par - 30)).some((t) => /Faster missions/.test(t))).toBe(false);
    expect(amraam(buildTips(state('g01'), win('g01', par + 60)))).toBe(true);
  });
});
