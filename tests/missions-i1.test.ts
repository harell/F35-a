/**
 * MISSIONS — iteration-1 regression tests (reviewer critiques):
 *  - dispose(): restarts must not leak EventBus handlers (heap leak across restarts)
 *  - Winchester and bingo: DARKSTAR calls only, the steering cue stays on the mission (no rearming, #63)
 *  - bandits that bug out / keep away / are Winchester count as driven off (no soft-locked
 *    'destroy' objective: "Splash the second MiG pair 1/2" forever)
 *  - a strike package whose lead is lost: the survivors keep the route
 *  - SEAD hint follows the selected weapon (no JDAM hint under an AARGM SHOOT cue)
 *  - debrief: informative reason, tips, medals, campaignComplete; MEDALS exported
 *  - Instant Action honours difficulty (count scaling, 'mixed' types)
 *  - a point-defence SAM shooting the player's weapons down (the 'munitions_shot_down' condition)
 *  - the time limit's HUD countdown
 * The air-to-air and SEAD cases run on test fixtures (tests/missions-helpers.ts) shaped like the
 * removed Southern Cross missions c01 and c03.
 */
import { Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';

// multi-minute real-sim runs: under a parallel full-suite run they exceed the 5 s default on a loaded box
vi.setConfig({ testTimeout: 60_000 });
import { AKL, BRIDGE_SPAN_T } from '../src/core/auckland';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import { CAMPAIGNS, MEDALS, TRAINING, buildInstantMissionSeeded, createMissionRunner, failStreak, missionById, recordResult, skipMission, wasSkipped } from '../src/missions';
import { defaultProgress, sanitizeProgress } from '../src/missions/progress';
import type { MissionResult } from '../src/core/contracts';
import type { MissileEntity } from '../src/sim/entities';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { remainingRoute, scaleTotal } from '../src/missions/runtime/spawner';
import { WINCHESTER_CREDIT, WITHDRAW_CREDIT } from '../src/missions/runtime/withdrawal';
import { SDB_PRESS_RANGE } from '../src/missions/runtime/hints';
import { flight, mission } from '../src/missions/content/common';
import { flatLand, harness, killGroup, raiderFixture, seadFixture, shieldPlayer, stubAi, sweepFixture, type Harness } from './missions-helpers';

const byId = (id: string) => missionById(id)!;
const WH = AKL.whenuapai;

function handlerCount(events: EventBus): number {
  let n = 0;
  for (const set of (events as unknown as { handlers: Map<string, Set<unknown>> }).handlers.values()) n += set.size;
  return n;
}

function emptyStores(h: Harness): void {
  for (const st of h.world.player!.stores) st.count = 0;
}

/** Keep the (uncontrolled) player jet at a fixed spot, alive (stub world: teleport every step). */
function pin(h: Harness, x: number, y: number, z: number): void {
  const p = h.world.player!;
  p.position.set(x, y, z);
  shieldPlayer(h);
}

/** Hold the player over Whenuapai at 600 m (stub world: teleport every step). */
function holdOverField(h: Harness, seconds: number): void {
  const p = h.world.player!;
  h.run(seconds, () => {
    p.position.set(WH.x + 300, 600, WH.z);
    shieldPlayer(h);
  });
}

describe('i1: MissionRunner.dispose() — no leak across restarts', () => {
  it('four restarts on one EventBus leave the handler count where it started', () => {
    const events = new EventBus();
    const diff = DIFFICULTIES.pilot;
    const counts: number[] = [];
    let last: ReturnType<typeof createMissionRunner> | null = null;
    for (let i = 0; i < 4; i++) {
      const before = handlerCount(events);
      const world = createSimWorld({ terrain: flatLand(), difficulty: diff, events, combat: createCombatSystemSeeded(1) });
      const runner = createMissionRunner(sweepFixture(), { createAi: stubAi({ created: [], retasked: [] }), difficulty: diff, events });
      runner.setup(world, 'a2a_stealth');
      for (let k = 0; k < 120; k++) {
        world.step(1 / 60);
        runner.update(world, 1 / 60);
      }
      expect(handlerCount(events)).toBeGreaterThan(before); // the runner listens while alive
      const r = runner.result(world);
      runner.dispose!();
      world.dispose();
      counts.push(handlerCount(events) - before);
      // after dispose: cached result, inert API
      expect(runner.result(world)).toBe(r);
      expect(runner.hint).toBeNull();
      expect(runner.currentWaypoint).toBeNull();
      expect(() => runner.update(world, 1 / 60)).not.toThrow();
      last = runner;
    }
    expect(counts).toEqual([0, 0, 0, 0]);
    expect(last).toBeTruthy();
  });

  it('dispose() twice is harmless', () => {
    const h = harness(seadFixture());
    h.run(1);
    h.runner.dispose!();
    expect(() => h.runner.dispose!()).not.toThrow();
  });
});

describe('Winchester and bingo: calls only, no rearming (issue #63)', () => {
  it('Winchester triggers the DARKSTAR call and a HUD cue; the steering cue stays on the mission', () => {
    const h = harness(sweepFixture());
    h.run(1, () => shieldPlayer(h));
    expect(h.runner.currentWaypoint?.id).toBe('wp_cap');
    emptyStores(h);
    const hints = new Set<string>();
    h.run(8, () => {
      shieldPlayer(h);
      if (h.runner.hint) hints.add(h.runner.hint);
    });
    const radio = h.of('radio').map((r) => r.text);
    expect(radio.some((t) => /Winchester\. Viper 2 has the fight\./.test(t))).toBe(true);
    expect(radio.some((t) => /rearm|RTB/i.test(t))).toBe(false);
    expect(h.of('hud:message').some((m) => m.text === 'WINCHESTER — GUNS ONLY')).toBe(true);
    expect(h.runner.currentWaypoint?.id).toBe('wp_cap');
    // the Winchester hint pre-empts the scripted briefing hint
    expect([...hints].some((t) => /^WINCHESTER: missiles and bombs gone/.test(t))).toBe(true);
    expect([...hints].some((t) => /rearm|Whenuapai/i.test(t))).toBe(false);
  });

  it('bingo fuel: a call, no RTB steering', () => {
    const h = harness(sweepFixture());
    h.run(1, () => shieldPlayer(h));
    h.world.player!.flight.fuel = 100;
    h.run(3, () => shieldPlayer(h));
    expect(h.of('hud:message').some((m) => m.text === 'BINGO FUEL')).toBe(true);
    expect(h.of('radio').some((r) => /bingo fuel/.test(r.text) && !/refuel|RTB/i.test(r.text))).toBe(true);
    expect(h.runner.currentWaypoint?.id).toBe('wp_cap');
  });

  it('circling low over Whenuapai with empty stores and tanks reloads and refuels nothing', () => {
    const h = harness(sweepFixture());
    const p = h.world.player!;
    emptyStores(h);
    p.flight.fuel = 500;
    p.flares = 0;
    h.run(1, () => shieldPlayer(h));
    holdOverField(h, 30);
    expect(h.of('hud:message').some((m) => /REARM/.test(m.text))).toBe(false);
    expect(h.world.combat.remaining(p, 'aim120')).toBe(0);
    expect(p.flares).toBe(0);
    expect(p.flight.fuel).toBeLessThanOrEqual(500);
  });
});

describe('i1: driven-off bandits never soft-lock a destroy objective', () => {
  it(`a bandit in BUGOUT / RTB for ${WITHDRAW_CREDIT} s counts as driven off (reduced bonus) — a sweep cannot stall`, () => {
    const h = harness(sweepFixture());
    h.run(1, () => shieldPlayer(h));
    const migs = h.world.aircraft.filter((a) => a.groupId === 'fulcrum1');
    h.world.applyDamage(migs[0], 9999, h.world.player!.id, 'aim120');
    // the reviewers' case: out of AMRAAMs, the last MiG runs home
    emptyStores(h);
    const P0 = h.world.player!.position.clone();
    const keep = () => {
      pin(h, P0.x, 3000, P0.z);
      migs[1].aiState = 'BUGOUT';
      migs[1].position.set(P0.x + 12_000, 5000, P0.z); // running, but inside 25 km
    };
    h.run(WITHDRAW_CREDIT - 5, keep);
    expect(h.runner.objectives.find((o) => o.id === 'o_sweep')!.state).toBe('active');
    expect(h.of('radio').some((r) => /bugging out\. Splash him for the bonus/.test(r.text))).toBe(true);
    h.run(6, keep);
    const sweep = h.runner.objectives.find((o) => o.id === 'o_sweep')!;
    expect(sweep.state).toBe('complete');
    expect(sweep.progress).toEqual({ done: 2, total: 2 });
    expect(h.of('hud:message').some((m) => m.text === 'MIG-29 DRIVEN OFF')).toBe(true);
    // the second pair: one splashed, one driven off by range → the mission completes
    h.run(10, () => pin(h, P0.x, 3000, P0.z));
    const second = h.world.aircraft.filter((a) => a.groupId === 'fulcrum2');
    expect(second).toHaveLength(2);
    killGroup(h, 'fulcrum2');
    h.run(2, () => pin(h, P0.x, 3000, P0.z));
    expect(h.runner.state).toBe('success');
    const r = h.runner.result(h.world);
    expect(r.score).toBeGreaterThan(0);
    expect(r.objectives.find((o) => o.id === 'o_sweep')!.state).toBe('complete');
  });

  it('a withdrawing bandit 25 km from the player is credited at once', () => {
    const h = harness(sweepFixture());
    h.run(1, () => shieldPlayer(h));
    const [a, b] = h.world.aircraft.filter((x) => x.groupId === 'fulcrum1');
    h.world.applyDamage(a, 9999, h.world.player!.id, 'aim120');
    const p = h.world.player!;
    h.run(1, () => {
      b.aiState = 'RTB';
      b.position.set(p.position.x + 30_000, 6000, p.position.z);
      shieldPlayer(h);
    });
    expect(h.runner.objectives.find((o) => o.id === 'o_sweep')!.state).toBe('complete');
  });

  it(`a gun-only (Winchester) bandit is credited after ${WINCHESTER_CREDIT} s`, () => {
    const h = harness(sweepFixture());
    const [a, b] = h.world.aircraft.filter((x) => x.groupId === 'fulcrum1');
    h.world.applyDamage(a, 9999, h.world.player!.id, 'aim120');
    for (const st of b.stores) st.count = 0;
    h.run(WINCHESTER_CREDIT - 3, () => shieldPlayer(h));
    expect(h.runner.objectives.find((o) => o.id === 'o_sweep')!.state).toBe('active');
    h.run(5, () => shieldPlayer(h));
    expect(h.runner.objectives.find((o) => o.id === 'o_sweep')!.state).toBe('complete');
    expect(h.of('hud:message').some((m) => /WINCHESTER — NO LONGER A THREAT/.test(m.text))).toBe(true);
  });

  it('an engaged bandit that keeps beyond 15 km for 2 min is credited; an untouched patrol is not', () => {
    const h = harness(sweepFixture());
    const p = h.world.player!;
    const P0 = p.position.clone();
    const [a, b] = h.world.aircraft.filter((x) => x.groupId === 'fulcrum1');
    // untouched: far away the whole time → no credit
    h.run(150, () => {
      pin(h, P0.x, 3000, P0.z);
      a.position.set(P0.x + 30_000, 6000, P0.z);
      b.position.set(P0.x + 31_000, 6000, P0.z);
    });
    expect(h.runner.objectives.find((o) => o.id === 'o_sweep')!.state).toBe('active');
    // b merges with the player once, then runs a stern chase at 20 km
    h.run(1, () => {
      pin(h, P0.x, 3000, P0.z);
      b.position.set(P0.x + 5_000, 3000, P0.z);
    });
    h.world.applyDamage(a, 9999, p.id, 'aim120');
    h.run(115, () => {
      pin(h, P0.x, 3000, P0.z);
      b.position.set(P0.x + 20_000, 6000, P0.z);
      b.aiState = 'BVR';
    });
    expect(h.runner.objectives.find((o) => o.id === 'o_sweep')!.state).toBe('active');
    h.run(10, () => {
      pin(h, P0.x, 3000, P0.z);
      b.position.set(P0.x + 20_000, 6000, P0.z);
      b.aiState = 'BVR';
    });
    expect(h.runner.objectives.find((o) => o.id === 'o_sweep')!.state).toBe('complete');
  });

  it('bombers are never "driven off" (a fleeing bomber is a failure, not a win)', () => {
    const h = harness(raiderFixture());
    const bomber = h.world.aircraft.find((x) => x.groupId === 'raider')!;
    h.run(60, () => {
      bomber.aiState = 'RTB';
      bomber.position.set(0, 9000, -36_000);
      shieldPlayer(h);
    });
    expect(h.runner.objectives.find((o) => o.id === 'o_raider')!.state).toBe('active');
  });
});

describe('i1: a strike package keeps its route', () => {
  it('lead lost: the survivors re-take the rest of the route', () => {
    const route = { kind: 'route' as const, points: [{ x: 10_000, z: -10_000, altitude: 5000 }, { x: 20_000, z: -10_000, altitude: 5000 }, { x: 30_000, z: -10_000, altitude: 5000 }] };
    const def = mission({
      id: 'fx_package',
      kind: 'training',
      index: 1,
      title: 'Package fixture',
      subtitle: 'test',
      timeOfDay: 'day',
      weather: 'clear',
      briefing: ['test'],
      recommendedLoadout: 'a2a_stealth',
      allowedLoadouts: ['a2a_stealth'],
      player: { x: -20_000, z: 10_000, altitude: 3000, heading: 0, speed: 230 },
      script: {
        groups: [flight('pkg', 'mig29', 4, { x: 0, z: -10_000 }, 5000, 90, 240, 'bomber', { fixedCount: true, task: route })],
        objectives: [{ id: 'o', kind: 'destroy', groups: ['pkg'], label: 'x', primary: true }],
      },
    });
    const h = harness(def);
    h.run(1, () => shieldPlayer(h));
    const pkg = h.world.aircraft.filter((a) => a.groupId === 'pkg');
    expect(pkg).toHaveLength(4);
    const before = h.ai.retasked.length;
    h.world.applyDamage(pkg[0], 9999, null, 'r77');
    h.run(1, () => shieldPlayer(h));
    const re = h.ai.retasked.slice(before);
    expect(re.some((t) => t.kind === 'route')).toBe(true);
  });

  it('remainingRoute drops the points already flown', () => {
    const route = { kind: 'route' as const, points: [0, 10_000, 20_000, 30_000].map((x) => ({ x, z: 0, altitude: 5000 })) };
    expect(remainingRoute(route, { x: -500, z: 0 }).points.map((p) => p.x)).toEqual([10_000, 20_000, 30_000]);
    expect(remainingRoute(route, { x: 14_000, z: 0 }).points.map((p) => p.x)).toEqual([20_000, 30_000]);
    expect(remainingRoute(route, { x: 29_000, z: 500 }).points.map((p) => p.x)).toEqual([30_000]);
  });
});

describe('i1: hints follow the selected weapon (SEAD)', () => {
  it('AARGM selected on the SA-6 → an AARGM hint, never "JDAM"; SDB II → names the SDB II', () => {
    // the reviewers' case: AARGM selected, SA-6 designated, the EW radar (a ground target) in range
    const h = harness(seadFixture());
    const p = h.world.player!;
    const c = h.world.combat;
    const sa6 = h.world.sams.find((s) => s.groupId === 'rangi_sa6')!;
    const P0 = { x: sa6.position.x - 18_000, z: sa6.position.z + 2_000 };
    const texts = new Set<string>();
    h.run(60, () => {
      pin(h, P0.x, 6000, P0.z);
      if (p.selectedWeapon !== 'aargm') c.selectWeapon(p, 'aargm', h.world);
      if (p.radar.designatedId !== sa6.id) c.designate(p, sa6.id, h.world);
      if (h.runner.hint) texts.add(h.runner.hint);
    });
    const all = [...texts];
    expect(all.some((t) => /AARGM/.test(t))).toBe(true);
    expect(all.filter((t) => /JDAM/.test(t))).toEqual([]);
    // SDB II selected, nothing designated → the hint names the real store
    const h2 = harness(seadFixture());
    const p2 = h2.world.player!;
    const t2 = new Set<string>();
    h2.run(60, () => {
      pin(h2, P0.x, 6000, P0.z);
      if (p2.selectedWeapon !== 'gbu53') h2.world.combat.selectWeapon(p2, 'gbu53', h2.world);
      if (p2.radar.designatedId !== null) h2.world.combat.designate(p2, null, h2.world);
      if (h2.runner.hint) t2.add(h2.runner.hint);
    });
    expect([...t2].some((t) => /SDB/.test(t))).toBe(true);
    expect([...t2].filter((t) => /JDAM/.test(t))).toEqual([]);
  });

  it('training T02 teaches the lock drill (designate → nose within 30° → SHOOT → crank)', () => {
    const t02 = byId('t02');
    const all = [...t02.briefing, ...(t02.script.hints ?? []).map((x) => x.text)].join(' ');
    for (const k of [/TD box/, /30°/, /SHOOT/, /crank/i, /PITBULL/]) expect(all).toMatch(k);
    const t06 = byId('t06');
    const t3 = [...t06.briefing, ...(t06.script.hints ?? []).map((x) => x.text), ...t06.script.triggers.flatMap((tr) => tr.actions.map((a) => ('text' in a ? a.text : '')))].join(' ');
    // (one CMS control drops chaff and flares together on every input: #62)
    for (const k of [/beam/i, /\bCMS\b/, /chaff and flares/i, /6 s to impact/i, /every (two or three|2–3) s/i, /300 ft/]) expect(t3).toMatch(k);
  });
});

describe('i1: debrief — reason, tips, medals, campaign ending', () => {
  it('shot down by the SA-6 → informative reason + a beam-the-SAM tip', () => {
    const h = harness(seadFixture());
    h.run(1);
    const sa6 = h.world.sams.find((s) => s.groupId === 'rangi_sa6')!;
    const p = h.world.player!;
    for (let i = 0; i < 4 && p.alive; i++) h.world.applyDamage(p, 9999, sa6.id, 'm_3m9');
    h.run(1);
    const r = h.runner.result(h.world);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('Shot down by an SA-6 Gainful');
    expect(r.tips!.length).toBeGreaterThanOrEqual(1);
    expect(r.tips!.length).toBeLessThanOrEqual(3);
    expect(r.tips![0]).toMatch(/beam it/);
  });

  it('AMRAAMs fired far outside the SHOOT cue earn the "wait for SHOOT" tip', () => {
    const h = harness(sweepFixture());
    const p = h.world.player!;
    const c = h.world.combat;
    h.run(1, () => shieldPlayer(h));
    const mig = h.world.aircraft.find((a) => a.groupId === 'fulcrum1')!;
    const P0 = p.position.clone();
    const fwd = new Vector3(0, 0, -1).applyQuaternion(p.quaternion);
    const hold = () => {
      pin(h, P0.x, P0.y, P0.z);
      mig.position.copy(P0).addScaledVector(fwd, 26_000);
      mig.velocity.copy(fwd).multiplyScalar(-230);
      if (p.radar.designatedId !== mig.id) c.designate(p, mig.id, h.world);
    };
    h.run(4, hold);
    for (let i = 0; i < 3; i++) {
      c.fire(p, h.world, 'aim120', mig.id); // internal bay: released once the doors open
      h.run(3, hold);
    }
    expect(p.shotsFired).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < 4 && p.alive; i++) h.world.applyDamage(p, 9999, mig.id, 'r27');
    h.run(1);
    const r = h.runner.result(h.world);
    expect(r.tips!.some((t) => /Wait for SHOOT/.test(t))).toBe(true);
  });

  it('flying under the Harbour Bridge earns Bridge Runner; winning the finale completes the campaign', () => {
    const h = harness(byId('t01'));
    h.run(0.5);
    const p = h.world.player!;
    const S = AKL.bridge_s;
    const N = AKL.bridge_n;
    const t = BRIDGE_SPAN_T;
    const cx = S.x + (N.x - S.x) * t;
    const cz = S.z + (N.z - S.z) * t;
    let k = 0;
    h.run(1.2, () => {
      p.position.set(cx - 300 + k * 60, 30, cz);
      p.velocity.set(250, 0, 0);
      shieldPlayer(h);
      k++;
    });
    expect(h.runner.result(h.world).medals!.some((m) => m.id === 'bridge_runner')).toBe(true);

    // the IRGC campaign is still being built (#197): no mission is its finale, so winning g02 doesn't end it
    const irgc = CAMPAIGNS.find((c) => c.id === 'irgc')!.missions;
    expect(irgc.filter((m) => m.script.campaignFinale).map((m) => m.id)).toEqual([]);
    const g02 = harness(byId('g02'));
    killGroup(g02, 'suicide_boats');
    g02.run(62, () => shieldPlayer(g02)); // the missile boats come in at 60 s
    killGroup(g02, 'missile_boats');
    g02.run(2, () => shieldPlayer(g02));
    expect(g02.runner.state).toBe('success');
    expect(g02.runner.result(g02.world).campaignComplete).toBeUndefined();
    // non-final missions never claim the ending
    const g01 = harness(byId('g01'));
    killGroup(g01, 'shaheds');
    g01.run(1, () => shieldPlayer(g01));
    expect(g01.runner.state).toBe('success');
    expect(g01.runner.result(g01.world).campaignComplete).toBeUndefined();
  });

  it('exports a MEDALS catalogue with stable ids', () => {
    expect(Object.keys(MEDALS)).toEqual(expect.arrayContaining(['bridge_runner', 'ace_in_a_day', 'iron_hand', 'no_hits', 'dfc', 'air_medal']));
    expect(Object.keys(MEDALS)).not.toContain('southern_cross');
    for (const m of Object.values(MEDALS) as { name: string; description: string }[]) {
      expect(m.name.length).toBeGreaterThan(3);
      expect(m.description.length).toBeGreaterThan(10);
    }
  });
});

describe('i1: Instant Action honours the difficulty', () => {
  const opts = { mode: 'dogfight', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 4 } as const;

  it("4 bandits → 3 on Recruit, 4 on Pilot / Veteran", () => {
    const count = (d: 'recruit' | 'pilot' | 'veteran') => harness(buildInstantMissionSeeded(opts, 9), d).world.aircraft.filter((a) => a.team === 'red').length;
    expect(count('recruit')).toBe(3);
    expect(count('pilot')).toBe(4);
    expect(count('veteran')).toBe(4);
    expect(scaleTotal([2, 2], 0.75)).toEqual([2, 1]);
    expect(scaleTotal([2, 2], 1.5)).toEqual([3, 3]);
    expect(scaleTotal([1], 0.5)).toEqual([1]);
  });

  it("'mixed' flies MiG-29s / Su-27s on every difficulty (issue #60: the Su-35's and Su-57's R-77s walled Veteran, then Ace, since removed)", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed < 30; seed++) {
      const def = buildInstantMissionSeeded(opts, seed);
      for (const d of ['recruit', 'pilot', 'veteran'] as const) {
        const types = harness(def, d).world.aircraft.filter((a) => a.team === 'red').map((a) => a.type);
        types.forEach((t) => seen.add(t));
        expect(types.every((t) => t === 'mig29' || t === 'su27')).toBe(true);
      }
    }
    expect([...seen].sort()).toEqual(['mig29', 'su27']);
  });
});

describe('i1: progress safety valve (failure streak, skip)', () => {
  const res = (id: string, success: boolean): MissionResult => ({
    missionId: id, title: id, success, reason: success ? 'All objectives complete' : 'Objective failed: x', difficulty: 'pilot', time: 100, score: 100, grade: success ? 'B' : 'F',
    kills: { air: 0, sam: 0, ground: 0 }, friendlyLosses: 0, shotsFired: 0, hits: 0, accuracy: 0, damageTaken: 0, objectives: [],
  });
  it('counts consecutive failures, resets on success, survives save/load; skip unlocks the next mission', () => {
    const chains = CAMPAIGNS.map((c) => c.missions);
    let p = defaultProgress(chains, TRAINING);
    p = recordResult(p, res('g01', false));
    p = recordResult(p, res('g01', false));
    expect(failStreak(p, 'g01')).toBe(2);
    expect(p.unlocked.includes('g02')).toBe(false);
    const reloaded = sanitizeProgress(JSON.parse(JSON.stringify(p)), chains, TRAINING);
    expect(failStreak(reloaded, 'g01')).toBe(2);
    const skipped = skipMission(reloaded, 'g01');
    expect(skipped.unlocked.includes('g02')).toBe(true);
    expect(wasSkipped(skipped, 'g01')).toBe(true);
    const won = recordResult(skipped, res('g01', true));
    expect(failStreak(won, 'g01')).toBe(0);
  });
});

describe('i1: late fixes — SDB press-in', () => {
  it(`SDB: near its maximum the cue says press in to ${SDB_PRESS_RANGE / 1000} km; closer it says release`, () => {
    // a fresh sortie per range; the cue while holding that geometry (after the opening SEAD hint)
    const hintsAt = (range: number): string[] => {
      const h = harness(seadFixture());
      const p = h.world.player!;
      const c = h.world.combat;
      const sa15 = h.world.sams.find((s) => s.groupId === 'rangi_sa15')!;
      const out = new Set<string>();
      let k = 0;
      h.run(50, () => {
        pin(h, sa15.position.x - (k++ < 16 * 60 ? 40_000 : range), 7_000, sa15.position.z);
        p.velocity.set(240, 0, 0);
        p.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2);
        if (p.selectedWeapon !== 'gbu53') c.selectWeapon(p, 'gbu53', h.world);
        if (p.radar.designatedId !== sa15.id) c.designate(p, sa15.id, h.world);
        const b = c.bombImpactPoint(p, h.world);
        if (k > 18 * 60 && h.runner.hint && b?.inRange) out.add(h.runner.hint);
      });
      return [...out];
    };
    const far = hintsAt(24_000);
    expect(far.some((t) => /press in to 20 km/.test(t)), JSON.stringify(far)).toBe(true);
    expect(far.some((t) => /release the SDB/.test(t))).toBe(false);
    const near = hintsAt(18_000);
    expect(near.some((t) => /release the SDB/.test(t)), JSON.stringify(near)).toBe(true);
    expect(near.some((t) => /press in/.test(t))).toBe(false);
  });
});

const CALL = /Gauntlet is shooting your weapons down/;

/** A 'munition:end' for one of the player's bombs, shot down by `siteId`'s point defence. */
function shotDown(h: Harness, siteId: number): void {
  const p = h.world.player!;
  const fake = { shooterId: p.id, interceptedBy: siteId, def: { category: 'bomb', id: 'gbu53' } } as unknown as MissileEntity;
  h.events.emit('munition:end', { missile: fake, position: p.position.clone(), reason: 'selfdestruct', targetId: null });
}

describe("#114: the 'munitions_shot_down' condition counts the player's weapons a site shoots down", () => {
  it('one loss: no call; the second: the call, the site revealed and the steering cue on it', () => {
    const h = harness(seadFixture(), 'recruit');
    h.run(1, () => shieldPlayer(h));
    const sa15 = h.world.sams.find((s) => s.groupId === 'rangi_sa15')!;
    const sa6 = h.world.sams.find((s) => s.groupId === 'rangi_sa6')!;
    shotDown(h, sa15.id);
    shotDown(h, sa6.id); // a loss to another site doesn't count toward the SA-15's
    h.run(5, () => shieldPlayer(h));
    expect(h.of('radio').some((r) => CALL.test(r.text))).toBe(false);
    shotDown(h, sa15.id);
    h.run(5, () => shieldPlayer(h));
    expect(h.of('radio').filter((r) => CALL.test(r.text))).toHaveLength(1);
    expect(sa15.known).toBe(true);
    expect(h.runner.currentWaypoint?.id).toBe('wp_sa15');
  });

  it('the site already dead: no call', () => {
    const h = harness(seadFixture(), 'recruit');
    h.run(1, () => shieldPlayer(h));
    const sa15 = h.world.sams.find((s) => s.groupId === 'rangi_sa15')!;
    h.world.applyDamage(sa15, 99_999, h.world.player!.id, 'aargm');
    shotDown(h, sa15.id);
    shotDown(h, sa15.id);
    h.run(5, () => shieldPlayer(h));
    expect(h.of('radio').some((r) => CALL.test(r.text))).toBe(false);
  });
});

describe('#114: a time limit counts down on the HUD, then fails the mission', () => {
  it('"SECONDS REMAINING" on the HUD, then "Out of time"', () => {
    const limit = 900;
    const h = harness(seadFixture(limit), 'recruit');
    h.world.player!.position.set(-30000, 7000, 30000); // far from the fight
    h.run(0.2);
    (h.world as unknown as { time: number }).time = limit - 0.5;
    h.run(1, () => shieldPlayer(h));
    expect(h.of('hud:message').some((m) => /SECONDS REMAINING/.test(m.text))).toBe(true);
    expect(h.runner.state).toBe('failed');
    expect(h.runner.result(h.world).reason).toBe('Out of time');
  });
});
