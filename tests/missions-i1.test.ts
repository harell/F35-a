/**
 * MISSIONS — iteration-1 regression tests (reviewer critiques):
 *  - dispose(): restarts must not leak EventBus handlers (heap leak across restarts)
 *  - Winchester → DARKSTAR RTB call, steering cue to the Whenuapai rearm point, 5 s hold → REARMED
 *  - bandits that bug out / keep away / are Winchester count as driven off (no soft-locked
 *    'destroy' objective; c01 "Splash the second MiG pair 1/2" forever)
 *  - c09 re-paced (Hammer pushes after the Flankers; Su-35s a minute later; survivors keep the route)
 *  - SEAD hint follows the selected weapon (no JDAM hint under an AARGM SHOOT cue)
 *  - debrief: informative reason, tips, medals, campaignComplete; MEDALS exported
 *  - Instant Action honours difficulty (count scaling, 'mixed' types)
 */
import { Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';

// multi-minute real-sim runs: under a parallel full-suite run they exceed the 5 s default on a loaded box
vi.setConfig({ testTimeout: 60_000 });
import { AKL, BRIDGE_SPAN_T } from '../src/core/auckland';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import { CAMPAIGN, MEDALS, TRAINING, buildInstantMissionSeeded, createMissionRunner, failStreak, recordResult, skipMission, wasSkipped } from '../src/missions';
import { defaultProgress, sanitizeProgress } from '../src/missions/progress';
import type { MissionResult } from '../src/core/contracts';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { remainingRoute, scaleTotal } from '../src/missions/runtime/spawner';
import { WINCHESTER_CREDIT, WITHDRAW_CREDIT } from '../src/missions/runtime/withdrawal';
import { REARM_HOLD } from '../src/missions/runtime/rearm';
import { SAM_DATA } from '../src/sim/sam/samData';
import { SDB_PRESS_RANGE } from '../src/missions/runtime/hints';
import { P } from '../src/missions/content/common';
import { flatLand, harness, killGroup, shieldPlayer, stubAi, type Harness } from './missions-helpers';

const byId = (id: string) => [...CAMPAIGN, ...TRAINING].find((m) => m.id === id)!;
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
      const runner = createMissionRunner(byId('c01'), { createAi: stubAi({ created: [], retasked: [] }), difficulty: diff, events });
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
    const h = harness(byId('c03'));
    h.run(1);
    h.runner.dispose!();
    expect(() => h.runner.dispose!()).not.toThrow();
  });
});

describe('i1: Winchester → RTB to Whenuapai → rearm', () => {
  it('Winchester triggers the DARKSTAR call, a HUD cue and steers to the rearm point', () => {
    const h = harness(byId('c01'));
    h.run(1, () => shieldPlayer(h));
    expect(h.runner.currentWaypoint?.id).toBe('wp_cap');
    emptyStores(h);
    const hints = new Set<string>();
    h.run(8, () => {
      shieldPlayer(h);
      if (h.runner.hint) hints.add(h.runner.hint);
    });
    const radio = h.of('radio').map((r) => r.text);
    expect(radio.some((t) => /Winchester — RTB to Whenuapai to rearm/.test(t))).toBe(true);
    expect(radio.some((t) => /Viper 2 has the fight/.test(t))).toBe(true);
    expect(h.of('hud:message').some((m) => /WINCHESTER — RTB WHENUAPAI/.test(m.text))).toBe(true);
    const wp = h.runner.currentWaypoint!;
    expect(wp.id).toBe('rearm');
    expect(Math.hypot(wp.position.x - WH.x, wp.position.z - WH.z)).toBeLessThan(10);
    // the Winchester hint pre-empts the scripted briefing hint
    expect([...hints].some((t) => /^WINCHESTER: follow the steering cue to Whenuapai/.test(t))).toBe(true);
  });

  it(`holding over the field below 1,500 m AGL for ${REARM_HOLD} s re-applies the loadout and refuels`, () => {
    const h = harness(byId('c01'));
    const p = h.world.player!;
    const fuel0 = p.flight.fuel;
    emptyStores(h);
    p.flight.fuel = fuel0 * 0.3;
    p.flares = 0;
    h.run(1, () => shieldPlayer(h));
    holdOverField(h, REARM_HOLD - 1.5);
    expect(h.of('hud:message').some((m) => m.text === 'REARMED')).toBe(false);
    holdOverField(h, 2);
    expect(h.of('hud:message').some((m) => m.text === 'REARMED')).toBe(true);
    expect(h.world.combat.remaining(p, 'aim120')).toBe(4);
    expect(p.flares).toBeGreaterThan(0);
    expect(p.flight.fuel).toBeGreaterThanOrEqual(fuel0 - 20);
    holdOverField(h, 8);
    expect(h.of('radio').some((r) => /rearmed and refuelled/.test(r.text))).toBe(true);
    // back to the mission's steering cue
    expect(h.runner.currentWaypoint?.id).not.toBe('rearm');
    expect(h.runner.result(h.world).medals!.some((m) => m.id === 'hot_pit')).toBe(false); // not won yet
  });

  it('leaving the gate resets the hold; too high does not count; nothing expended → no rearm', () => {
    const h = harness(byId('c01'));
    const p = h.world.player!;
    emptyStores(h);
    holdOverField(h, 3);
    h.run(0.5, () => {
      p.position.set(WH.x + 6000, 600, WH.z); // left the gate
    });
    holdOverField(h, 3);
    expect(h.of('hud:message').some((m) => m.text === 'REARMED')).toBe(false);
    h.run(REARM_HOLD + 1, () => {
      p.position.set(WH.x, 3000, WH.z); // over the field but too high
    });
    expect(h.of('hud:message').some((m) => m.text === 'REARMED')).toBe(false);
    holdOverField(h, REARM_HOLD + 0.5);
    expect(h.of('hud:message').filter((m) => m.text === 'REARMED')).toHaveLength(1);
    // fresh jet: circling the field does nothing
    holdOverField(h, REARM_HOLD * 2);
    expect(h.of('hud:message').filter((m) => m.text === 'REARMED')).toHaveLength(1);
  });

  it('survival mode keeps its own between-wave rearm (no Whenuapai logic)', () => {
    const def = buildInstantMissionSeeded({ mode: 'survival', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mig29', enemyCount: 2 }, 5);
    const h = harness(def);
    emptyStores(h);
    h.run(2, () => shieldPlayer(h));
    expect(h.of('radio').some((r) => /Winchester — RTB/.test(r.text))).toBe(false);
  });
});

describe('i1: driven-off bandits never soft-lock a destroy objective', () => {
  it(`a bandit in BUGOUT / RTB for ${WITHDRAW_CREDIT} s counts as driven off (reduced bonus) — c01 cannot stall`, () => {
    const h = harness(byId('c01'));
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
    const h = harness(byId('c01'));
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
    const h = harness(byId('c01'));
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
    const h = harness(byId('c01'));
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

  it('A-50 / bombers are never "driven off" (a fleeing Mainstay is a failure, not a win)', () => {
    const h = harness(byId('c07'));
    const awacs = h.world.aircraft.find((x) => x.groupId === 'mainstay')!;
    h.run(60, () => {
      awacs.aiState = 'RTB';
      awacs.position.set(0, 9000, -36_000);
      shieldPlayer(h);
    });
    expect(h.runner.objectives.find((o) => o.id === 'o_awacs')!.state).toBe('active');
  });
});

describe('i1: c09 Hammer Down re-paced', () => {
  it('Hammer waits for the Flankers, Su-35s come 60 s after the push, survivors keep their route', () => {
    const h = harness(byId('c09'));
    h.run(55, () => shieldPlayer(h));
    expect(h.world.aircraft.some((a) => a.groupId === 'hammer')).toBe(false);
    expect(h.world.aircraft.filter((a) => a.groupId === 'flankers')).toHaveLength(2);
    // Weasel flight is tasked against the SA-6 (not the player)
    const sa6 = h.world.sams.find((s) => s.groupId === 'wai_sa6')!;
    expect(h.ai.created.some((c) => c.role === 'fighter' && c.task?.kind === 'attack' && c.task.targetId === sa6.id)).toBe(true);
    killGroup(h, 'flankers');
    h.run(5, () => shieldPlayer(h));
    const hammer = h.world.aircraft.filter((a) => a.groupId === 'hammer');
    expect(hammer).toHaveLength(4);
    expect(h.world.aircraft.some((a) => a.groupId === 'sukhois')).toBe(false);
    h.run(60, () => shieldPlayer(h));
    expect(h.world.aircraft.filter((a) => a.groupId === 'sukhois')).toHaveLength(2);
    // lead lost: the survivors re-take the rest of the route
    const before = h.ai.retasked.length;
    h.world.applyDamage(hammer[0], 9999, null, 'r77');
    h.run(1, () => shieldPlayer(h));
    const re = h.ai.retasked.slice(before);
    expect(re.some((t) => t.kind === 'route')).toBe(true);
  });

  it('without a Flanker kill Hammer still pushes at 200 s (never waits forever)', () => {
    const h = harness(byId('c09'));
    h.run(206, () => shieldPlayer(h));
    expect(h.world.aircraft.filter((a) => a.groupId === 'hammer')).toHaveLength(4);
  });

  it('remainingRoute drops the points already flown', () => {
    const route = { kind: 'route' as const, points: [0, 10_000, 20_000, 30_000].map((x) => ({ x, z: 0, altitude: 5000 })) };
    expect(remainingRoute(route, { x: -500, z: 0 }).points.map((p) => p.x)).toEqual([10_000, 20_000, 30_000]);
    expect(remainingRoute(route, { x: 14_000, z: 0 }).points.map((p) => p.x)).toEqual([20_000, 30_000]);
    expect(remainingRoute(route, { x: 29_000, z: 500 }).points.map((p) => p.x)).toEqual([30_000]);
  });
});

describe('i1: hints follow the selected weapon (c03 SEAD)', () => {
  it('AARGM selected on the SA-6 → an AARGM hint, never "JDAM"; SDB → names the SDB', () => {
    // the reviewers' case: AARGM selected, SA-6 designated, the EW radar (a ground target) in range
    const h = harness(byId('c03'));
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
    // SDB selected, nothing designated → the hint names the real store
    const h2 = harness(byId('c03'));
    const p2 = h2.world.player!;
    const t2 = new Set<string>();
    h2.run(60, () => {
      pin(h2, P0.x, 6000, P0.z);
      if (p2.selectedWeapon !== 'gbu39') h2.world.combat.selectWeapon(p2, 'gbu39', h2.world);
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
    const t03 = byId('t03');
    const t3 = [...t03.briefing, ...(t03.script.hints ?? []).map((x) => x.text), ...t03.script.triggers.flatMap((tr) => tr.actions.map((a) => ('text' in a ? a.text : '')))].join(' ');
    for (const k of [/beam/i, /CHAFF/, /last (few )?seconds/i, /FLARES/, /300 ft/]) expect(t3).toMatch(k);
  });
});

describe('i1: debrief — reason, tips, medals, campaign ending', () => {
  it('shot down by the SA-10 → informative reason + a terrain-masking tip', () => {
    const h = harness(byId('c08'));
    h.run(1);
    const sa10 = h.world.sams.find((s) => s.type === 'sa10')!;
    const p = h.world.player!;
    for (let i = 0; i < 4 && p.alive; i++) h.world.applyDamage(p, 9999, sa10.id, 'm_48n6');
    h.run(1);
    const r = h.runner.result(h.world);
    expect(r.success).toBe(false);
    expect(r.reason).toBe('Shot down by an SA-10 Grumble');
    expect(r.tips!.length).toBeGreaterThanOrEqual(1);
    expect(r.tips!.length).toBeLessThanOrEqual(3);
    expect(r.tips![0]).toMatch(/Rangitoto/);
  });

  it('AMRAAMs fired far outside the SHOOT cue earn the "wait for SHOOT" tip', () => {
    const h = harness(byId('c01'));
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

  it('flying under the Harbour Bridge earns Bridge Runner; winning c12 completes the campaign', () => {
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

    const c12 = harness(byId('c12'));
    c12.run(1, () => shieldPlayer(c12));
    killGroup(c12, 'hq');
    c12.run(125, () => shieldPlayer(c12)); // the Felons scramble by t = 120
    killGroup(c12, 'felons');
    c12.run(2, () => shieldPlayer(c12));
    expect(c12.runner.state).toBe('success');
    const r = c12.runner.result(c12.world);
    expect(r.campaignComplete).toBe(true);
    expect(r.medals!.some((m) => m.id === 'southern_cross')).toBe(true);
    // non-final missions never claim the ending
    const c11 = harness(byId('c11'));
    killGroup(c11, 'sa10');
    c11.run(1, () => shieldPlayer(c11));
    expect(c11.runner.state).toBe('success');
    expect(c11.runner.result(c11.world).campaignComplete).toBeUndefined();
  });

  it('exports a MEDALS catalogue with stable ids', () => {
    expect(Object.keys(MEDALS)).toEqual(expect.arrayContaining(['bridge_runner', 'ace_in_a_day', 'iron_hand', 'no_hits', 'southern_cross', 'dfc', 'air_medal']));
    for (const m of Object.values(MEDALS) as { name: string; description: string }[]) {
      expect(m.name.length).toBeGreaterThan(3);
      expect(m.description.length).toBeGreaterThan(10);
    }
  });
});

describe('i1: Instant Action honours the difficulty', () => {
  const opts = { mode: 'dogfight', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 4 } as const;

  it('4 bandits → 3 on Recruit, 4 on Pilot / Veteran, 6 on Ace', () => {
    const count = (d: 'recruit' | 'pilot' | 'veteran' | 'ace') => harness(buildInstantMissionSeeded(opts, 9), d).world.aircraft.filter((a) => a.team === 'red').length;
    expect(count('recruit')).toBe(3);
    expect(count('pilot')).toBe(4);
    expect(count('veteran')).toBe(4);
    expect(count('ace')).toBe(6);
    expect(scaleTotal([2, 2], 0.75)).toEqual([2, 1]);
    expect(scaleTotal([2, 2], 1.5)).toEqual([3, 3]);
    expect(scaleTotal([1], 0.5)).toEqual([1]);
  });

  it("'mixed' flies MiG-29s / Su-27s below Veteran; Su-35 / Su-57 only on Veteran and Ace", () => {
    let sawModern = false;
    for (let seed = 1; seed < 30; seed++) {
      const def = buildInstantMissionSeeded(opts, seed);
      for (const d of ['recruit', 'pilot'] as const) {
        const types = harness(def, d).world.aircraft.filter((a) => a.team === 'red').map((a) => a.type);
        expect(types.every((t) => t === 'mig29' || t === 'su27')).toBe(true);
      }
      const vet = harness(def, 'veteran').world.aircraft.filter((a) => a.team === 'red').map((a) => a.type);
      if (vet.some((t) => t === 'su35' || t === 'su57')) sawModern = true;
    }
    expect(sawModern).toBe(true);
  });
});

describe('i1: progress safety valve (failure streak, skip)', () => {
  const res = (id: string, success: boolean): MissionResult => ({
    missionId: id, title: id, success, reason: success ? 'All objectives complete' : 'Objective failed: x', difficulty: 'pilot', time: 100, score: 100, grade: success ? 'B' : 'F',
    kills: { air: 0, sam: 0, ground: 0 }, friendlyLosses: 0, shotsFired: 0, hits: 0, accuracy: 0, damageTaken: 0, objectives: [],
  });
  it('counts consecutive failures, resets on success, survives save/load; skip unlocks the next mission', () => {
    let p = defaultProgress(CAMPAIGN, TRAINING);
    p = recordResult(p, res('c09', false));
    p = recordResult(p, res('c09', false));
    expect(failStreak(p, 'c09')).toBe(2);
    expect(p.unlocked.includes('c10')).toBe(false);
    const reloaded = sanitizeProgress(JSON.parse(JSON.stringify(p)), CAMPAIGN, TRAINING);
    expect(failStreak(reloaded, 'c09')).toBe(2);
    const skipped = skipMission(reloaded, 'c09');
    expect(skipped.unlocked.includes('c10')).toBe(true);
    expect(wasSkipped(skipped, 'c09')).toBe(true);
    const won = recordResult(skipped, res('c09', true));
    expect(failStreak(won, 'c09')).toBe(0);
  });
});

describe('i1: strike routes stay out of the short-range SAM envelopes; c11 support flights', () => {
  // the briefed high-altitude run-in (25,000 ft) is above the Tor / Osa / Shilka ceilings, and the
  // IP keeps out of their horizontal reach too (the bot died to the Tor flying the old 3,000 m IP)
  it('c04 / c06: every nav / IP point is above the SA-8 / SA-15 ceilings and outside their reach', () => {
    for (const id of ['c04', 'c06']) {
      const def = byId(id);
      const shorads = def.script.sams.filter((s) => s.type === 'sa15' || s.type === 'sa8' || s.type === 'zsu23');
      const route = def.script.waypoints.filter((w) => w.kind === 'nav' || w.kind === 'ip');
      expect(route.length).toBeGreaterThan(0);
      for (const w of route) {
        expect(w.altitude ?? 0, `${id} ${w.id}`).toBeGreaterThanOrEqual(7_000);
        for (const s of shorads) {
          const d = Math.hypot(w.x - s.x, w.z - s.z);
          expect(d, `${id} ${w.id} vs ${s.id}`).toBeGreaterThan(SAM_DATA[s.type].engageMax);
          expect(w.altitude!, `${id} ${w.id} above ${s.id}`).toBeGreaterThan(SAM_DATA[s.type].altMax);
        }
      }
      // the IP is a JDAM glide (~10–14 km) from the target
      const ip = route.find((w) => w.kind === 'ip')!;
      const tgt = def.script.waypoints.find((w) => w.kind === 'target')!;
      const d = Math.hypot(ip.x - tgt.x, ip.z - tgt.z);
      expect(d, `${id} IP → target`).toBeGreaterThan(9_000);
      expect(d, `${id} IP → target`).toBeLessThan(15_000);
    }
  });

  it('c11: Vipers 2–3 fly a forward CAP as fighters (40 km commit, not a 15 km wingman leash); Weasel flight goes for the Tor', () => {
    const def = byId('c11');
    const h = harness(def, 'pilot');
    const vipers = h.world.aircraft.filter((a) => a.groupId === 'viper');
    expect(vipers.map((a) => a.callsign)).toEqual(['Viper 2', 'Viper 3']);
    expect(vipers.every((a) => a.team === 'blue')).toBe(true);
    // created as 'fighter' (commits on bandits within 40 km) on a patrol ahead of the player,
    // west of the SA-10 (> 20 km from it)
    const sa10 = h.world.sams.find((s) => s.type === 'sa10')!;
    const created = h.ai.created.filter((c) => c.role === 'fighter');
    expect(created.length).toBeGreaterThanOrEqual(2);
    for (const c of created.slice(0, 2)) {
      expect(c.task?.kind).toBe('patrol');
      if (c.task?.kind === 'patrol') expect(Math.hypot(c.task.center.x - sa10.position.x, c.task.center.z - sa10.position.z)).toBeGreaterThan(20_000);
    }
    // c04 / c06: Viper 2 goes straight at the enemy CAP (briefed "top cover" / "takes on the Flankers")
    for (const [id, target] of [['c04', 'cap'], ['c06', 'flankers']] as const) {
      const hx = harness(byId(id), 'pilot');
      const ids = new Set(hx.world.aircraft.filter((a) => a.groupId === target).map((a) => a.id));
      const v = hx.ai.created.find((c) => c.role === 'fighter' && c.task?.kind === 'attack' && ids.has(c.task.targetId));
      expect(v, id).toBeTruthy();
      expect(hx.world.aircraft.find((a) => a.groupId === 'viper')?.callsign).toBe('Viper 2');
    }
    // Weasel pair spawns at 30 s with AARGMs, tasked on the Tor, and says so on the radio
    h.run(34, () => {
      shieldPlayer(h);
    });
    const weasels = h.world.aircraft.filter((a) => a.groupId === 'weasel');
    expect(weasels).toHaveLength(2);
    const tor = h.world.sams.find((s) => s.type === 'sa15')!;
    const wc = h.ai.created.slice(-2);
    for (const c of wc) expect(c.task?.kind === 'attack' && c.task.targetId === tor.id).toBe(true);
    expect(h.world.combat.remaining(weasels[0], 'aargm')).toBeGreaterThan(0);
    expect(h.of('radio').some((r) => r.from === 'Weasel 1' && /Tor/.test(r.text))).toBe(true);
  });
});

describe('i1: late fixes — no stalled package, SDB press-in', () => {
  it('c09: a Hammer package that misses the release basket is sent back over the strip (never orbits forever)', () => {
    const h = harness(byId('c09'));
    h.run(55, () => shieldPlayer(h));
    killGroup(h, 'flankers');
    h.run(5, () => shieldPlayer(h));
    const hammer = h.world.aircraft.filter((a) => a.groupId === 'hammer');
    expect(hammer).toHaveLength(4);
    // the package is stuck far from the strip (as when it sailed past the run-in point after a
    // defensive jink and circled its last route point)
    const before = h.ai.retasked.length;
    h.run(215, () => {
      pin(h, 0, 5_000, 3_000); // the (stub-flown) player stays inside the AO
      hammer.forEach((a, i) => {
        a.position.set(40_000 + i * 900, 1_000, 8_000);
        a.health = a.maxHealth;
      });
    });
    const re = h.ai.retasked.slice(before);
    const strip = P.waiAirstrip;
    const back = re.filter((t) => t.kind === 'route' && Math.hypot(t.waypoints[0].x - strip.x, t.waypoints[0].z - strip.z) < 100);
    expect(back.length).toBeGreaterThan(0);
    expect(h.of('radio').some((r) => /another pass/.test(r.text))).toBe(true);
    expect(h.of('radio').some((r) => /bombs away/.test(r.text))).toBe(false);
    // over the strip (4.5 km out still counts): release → Shack → egress
    h.run(20, () => {
      pin(h, 0, 5_000, 3_000);
      hammer.forEach((a, i) => {
        a.position.set(strip.x + 4_500, 3_200 + i * 300, strip.z);
        a.health = a.maxHealth;
      });
    });
    expect(h.of('radio').some((r) => /bombs away/.test(r.text))).toBe(true);
    expect(h.runner.objectives.find((o) => o.id === 'o_strike')!.state).toBe('complete');
  });

  it(`SDB: at its 30 km maximum the cue says press in to ${SDB_PRESS_RANGE / 1000} km; closer it says release`, () => {
    // a fresh sortie per range; the cue while holding that geometry (after the opening SEAD hint)
    const hintsAt = (range: number): string[] => {
      const h = harness(byId('c03'));
      const p = h.world.player!;
      const c = h.world.combat;
      const sa8 = h.world.sams.find((s) => s.type === 'sa8')!;
      const out = new Set<string>();
      let k = 0;
      h.run(50, () => {
        pin(h, sa8.position.x - (k++ < 16 * 60 ? 40_000 : range), 7_000, sa8.position.z);
        p.velocity.set(240, 0, 0);
        p.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2);
        if (p.selectedWeapon !== 'gbu39') c.selectWeapon(p, 'gbu39', h.world);
        if (p.radar.designatedId !== sa8.id) c.designate(p, sa8.id, h.world);
        const b = c.bombImpactPoint(p, h.world);
        if (k > 18 * 60 && h.runner.hint && b?.inRange) out.add(h.runner.hint);
      });
      return [...out];
    };
    const far = hintsAt(27_000);
    expect(far.some((t) => /press in to 20 km/.test(t)), JSON.stringify(far)).toBe(true);
    expect(far.some((t) => /release the SDB/.test(t))).toBe(false);
    const near = hintsAt(18_000);
    expect(near.some((t) => /release the SDB/.test(t)), JSON.stringify(near)).toBe(true);
    expect(near.some((t) => /press in/.test(t))).toBe(false);
  });
});
