/**
 * MISSIONS — MissionRunner with the real SimWorld + CombatSystem (flat fake terrain, stub AI):
 * spawning, objectives → success, failure paths, triggers, callouts, AWACS, hints, AO, bridge
 * bonus, survival waves, stale-listener safety.
 */
import { describe, expect, it } from 'vitest';
import { CAMPAIGN, TRAINING, buildInstantMissionSeeded } from '../src/missions';
import { harness, killGroup, shieldPlayer } from './missions-helpers';
import { AKL } from '../src/core/auckland';

const byId = (id: string) => [...CAMPAIGN, ...TRAINING].find((m) => m.id === id)!;

describe('MissionRunner: setup', () => {
  it('spawns the player, wingman and enemies (c01, pilot)', () => {
    const h = harness(byId('c01'));
    const w = h.world;
    expect(w.player).toBeTruthy();
    expect(w.player!.callsign).toBe('Viper 1');
    expect(w.player!.loadout).toBe('a2a_stealth');
    expect(w.player!.isPlayer).toBe(true);
    const blue = w.aircraft.filter((a) => a.team === 'blue' && !a.isPlayer);
    const red = w.aircraft.filter((a) => a.team === 'red');
    expect(blue).toHaveLength(1);
    expect(blue[0].callsign).toBe('Viper 2');
    expect(blue[0].leaderId).toBe(w.player!.id);
    expect(red).toHaveLength(2); // fulcrum2 waits for its trigger
    expect(red.every((a) => a.groupId === 'fulcrum1' && a.type === 'mig29')).toBe(true);
    expect(h.ai.created.map((c) => c.role).sort()).toEqual(['fighter', 'fighter', 'wingman']);
    expect(h.runner.objectives.map((o) => o.id)).toEqual(['o_sweep', 'o_second', 'o_shore']);
    expect(h.runner.currentWaypoint?.id).toBe('wp_cap');
  });

  it('scales enemy groups with difficulty and gates sites by minDifficulty', () => {
    const rec = harness(byId('c03'), 'recruit');
    const ace = harness(byId('c03'), 'ace');
    // c03: sa6, sa8, zsu1 always; zsu2 pilot+; sa15pop veteran+
    expect(rec.world.sams).toHaveLength(3);
    expect(ace.world.sams).toHaveLength(5);
    const c01ace = harness(byId('c01'), 'ace');
    expect(c01ace.world.aircraft.filter((a) => a.team === 'red')).toHaveLength(3); // 2 × 1.5
    const c05rec = harness(byId('c05'), 'recruit');
    expect(c05rec.world.aircraft.filter((a) => a.groupId === 'raid')).toHaveLength(2); // round(3 × 0.75)
  });

  it('applies ground spawns: ships, pop-up SAMs, known flags', () => {
    const h = harness(byId('c06'));
    expect(h.world.ground.filter((g) => g.type === 'ship')).toHaveLength(3);
    const moving = h.world.ground.filter((g) => g.path);
    expect(moving).toHaveLength(2);
    const pop = harness(byId('c03'), 'veteran').world.sams.find((s) => s.type === 'sa15')!;
    expect(pop.state).toBe('emcon');
    expect(pop.known).toBe(false);
  });

  it('strips unarmed training drones', () => {
    const h = harness(byId('t02'));
    const drone = h.world.aircraft.find((a) => a.groupId === 'drone1')!;
    expect(drone.stores.every((s) => s.count === 0)).toBe(true);
    expect(drone.gunAmmo).toBe(0);
  });
});

describe('MissionRunner: objectives and outcome', () => {
  it('destroying all primary targets completes the mission (c03 SEAD)', () => {
    const h = harness(byId('c03'));
    h.run(1);
    expect(killGroup(h, 'rangi_sa6')).toBe(1);
    h.run(0.5);
    expect(h.runner.objectives.find((o) => o.id === 'o_sa6')!.state).toBe('complete');
    expect(h.runner.state).toBe('running');
    // the steering cue moves on to the SA-8
    expect(h.runner.currentWaypoint?.id).toBe('wp_sa8');
    killGroup(h, 'rangi_sa8');
    h.run(0.5);
    expect(h.runner.state).toBe('success');
    const end = h.of('mission:end');
    expect(end).toHaveLength(1);
    expect(end[0].success).toBe(true);
    expect(h.of('objective').some((o) => o.id === 'o_sa8' && o.state === 'complete')).toBe(true);
    expect(h.of('hud:message').some((m) => m.text === 'OBJECTIVE COMPLETE')).toBe(true);
    h.run(8);
    expect(h.of('radio').some((r) => r.voice === 'a_mission_complete')).toBe(true);
    const res = h.runner.result(h.world);
    expect(res.success).toBe(true);
    expect(res.kills.sam).toBe(2);
    expect(res.score).toBeGreaterThan(0);
    expect(['S', 'A', 'B', 'C']).toContain(res.grade);
  });

  it('chains objectives through triggers (c01: second MiG pair after the first)', () => {
    const h = harness(byId('c01'));
    h.run(1);
    killGroup(h, 'fulcrum1');
    h.run(0.5);
    expect(h.runner.objectives.find((o) => o.id === 'o_second')!.state).toBe('active');
    expect(h.world.aircraft.filter((a) => a.groupId === 'fulcrum2')).toHaveLength(0);
    h.run(8, () => shieldPlayer(h));
    expect(h.world.aircraft.filter((a) => a.groupId === 'fulcrum2' && a.alive)).toHaveLength(2);
    // AWACS announces the pop-up group
    h.run(14, () => shieldPlayer(h));
    expect(h.of('radio').some((r) => r.from === 'DARKSTAR' && /pop-up group/.test(r.text))).toBe(true);
    killGroup(h, 'fulcrum2');
    h.run(0.5);
    expect(h.runner.state).toBe('success');
    const res = h.runner.result(h.world);
    expect(res.kills.air).toBe(4);
    expect(res.objectives.find((o) => o.id === 'o_shore')!.state).toBe('complete');
  });

  it('player death fails the mission', () => {
    const h = harness(byId('c01'));
    h.run(0.5);
    const p = h.world.player!;
    h.world.applyDamage(p, 10_000, null, 'collision');
    h.run(0.3);
    expect(p.alive).toBe(false);
    expect(h.runner.state).toBe('failed');
    const end = h.of('mission:end');
    expect(end).toHaveLength(1);
    expect(end[0].success).toBe(false);
    const res = h.runner.result(h.world);
    expect(res.success).toBe(false);
    expect(['D', 'F']).toContain(res.grade);
    expect(res.reason).toMatch(/Mid-air collision|Shot down|Crashed/);
    h.run(4);
    expect(h.of('radio').some((r) => r.voice === 'a_eject')).toBe(true);
    expect(h.of('radio').some((r) => r.voice === 'a_mission_failed')).toBe(true);
  });

  it('losing the protected flight fails the mission (c02)', () => {
    const h = harness(byId('c02'));
    h.run(0.5);
    killGroup(h, 'kiwi', false);
    h.run(2);
    expect(h.runner.objectives.find((o) => o.id === 'o_kiwi')!.state).toBe('failed');
    expect(h.runner.state).toBe('failed');
    expect(h.runner.result(h.world).friendlyLosses).toBe(2);
    expect(h.of('radio').some((r) => r.voice === 'a_friendly_down')).toBe(true);
  });

  it('a raid reaching its launch point fails the intercept (c05)', () => {
    const h = harness(byId('c05'));
    h.run(0.5);
    const bomber = h.world.aircraft.find((a) => a.groupId === 'raid')!;
    bomber.position.set(1000, 8000, 1000);
    h.run(0.3);
    expect(h.runner.objectives.find((o) => o.id === 'o_raid')!.state).toBe('failed');
    expect(h.runner.state).toBe('failed');
  });

  it('a raid that loses two-thirds of its bombers turns back (abortFraction)', () => {
    const h = harness(byId('c05'));
    h.run(0.5);
    const raid = h.world.aircraft.filter((a) => a.groupId === 'raid');
    expect(raid).toHaveLength(3);
    const p = h.world.player!;
    h.world.applyDamage(raid[0], 9999, p.id, 'aim120');
    h.world.applyDamage(raid[1], 9999, p.id, 'aim120');
    h.run(0.3);
    expect(h.runner.objectives.find((o) => o.id === 'o_raid')!.state).toBe('complete');
    expect(h.ai.retasked.some((t) => t.kind === 'rtb')).toBe(true);
  });

  it('scripted strike by a friendly package destroys the target (c09)', () => {
    const h = harness(byId('c09'));
    // i1 re-pacing: Hammer only pushes (spawns at the push point) once the Flankers are dealt with
    h.run(0.5);
    expect(h.world.aircraft.some((a) => a.groupId === 'hammer')).toBe(false);
    h.run(52, () => shieldPlayer(h));
    killGroup(h, 'flankers');
    h.run(12, () => shieldPlayer(h));
    expect(h.of('radio').some((r) => /Hammer, push/.test(r.text))).toBe(true);
    const lead = h.world.aircraft.find((a) => a.groupId === 'hammer')!;
    expect(lead).toBeTruthy();
    // teleport Hammer over the strip
    h.world.aircraft.filter((x) => x.groupId === 'hammer').forEach((a, i) => a.position.set(26500 + i * 300, 5000 + i * 40, -6000 + (i % 2) * 300));
    h.run(22, () => shieldPlayer(h));
    expect(h.runner.objectives.find((o) => o.id === 'o_strike')!.state).toBe('complete');
    expect(h.world.ground.filter((g) => g.groupId === 'depot').every((g) => !g.alive)).toBe(true);
    expect(h.of('radio').some((r) => r.from === 'Hammer 1' && /Shack/.test(r.text))).toBe(true);
    expect(lead.alive).toBe(true);
    // player gets no credit for Hammer's bombs
    expect(h.runner.result(h.world).kills.ground).toBe(0);
  });

  it('leaving the AO fails after 30 s with warnings', () => {
    const h = harness(byId('t01'));
    h.run(0.5);
    const p = h.world.player!;
    h.run(32, () => {
      p.position.x = 39_500;
      shieldPlayer(h);
    });
    expect(h.of('hud:message').some((m) => m.text.startsWith('RETURN TO AO'))).toBe(true);
    expect(h.runner.state).toBe('failed');
    expect(h.runner.result(h.world).reason).toMatch(/area of operations/);
  });

  it('time limit fails the mission (c07)', () => {
    const h = harness(byId('c07'));
    h.world.player!.position.set(-30000, 7000, 30000); // far from the fight
    h.run(0.2);
    const limit = byId('c07').timeLimit!; // 720 s since i1 (room for a Winchester trip)
    (h.world as unknown as { time: number }).time = limit - 0.5;
    h.run(1, () => shieldPlayer(h));
    expect(h.runner.state).toBe('failed');
    expect(h.runner.result(h.world).reason).toMatch(/time/i);
  });
});

describe('MissionRunner: presentation', () => {
  it('kill callouts: splash radio + HUD for a player air kill', () => {
    const h = harness(byId('c01'));
    h.run(0.5);
    const mig = h.world.aircraft.find((a) => a.type === 'mig29')!;
    h.world.applyDamage(mig, 9999, h.world.player!.id, 'aim120');
    h.run(6, () => shieldPlayer(h));
    expect(h.of('hud:message').some((m) => m.text === 'SPLASH MIG-29' && m.tone === 'good')).toBe(true);
    const splash = h.of('radio').find((r) => r.voice === 'p_splash');
    expect(splash?.from).toBe('Viper 1');
    h.run(5);
    expect(h.of('radio').some((r) => r.voice === 'a_good_kill')).toBe(true);
  });

  it('kill callouts: target destroyed for SAM / ground kills', () => {
    const h = harness(byId('c03'));
    h.run(0.5);
    killGroup(h, 'rangi_ewr');
    h.run(8, () => shieldPlayer(h));
    expect(h.of('hud:message').some((m) => /DESTROYED/.test(m.text))).toBe(true);
    expect(h.of('radio').some((r) => r.voice === 'p_target_destroyed')).toBe(true);
  });

  it('AWACS calls the initial picture in BRAA format', () => {
    const h = harness(byId('c01'));
    h.run(8, () => shieldPlayer(h));
    const call = h.of('radio').find((r) => r.from === 'DARKSTAR' && /BRAA \d{3}, \d+ miles, angels \d+, (hot|flanking|beaming|cold)/.test(r.text));
    expect(call).toBeTruthy();
    expect(call!.voice).toBe('a_bandits');
  });

  it('AWACS uses bullseye when the mission asks for it (c07)', () => {
    const h = harness(byId('c07'));
    h.run(10, () => shieldPlayer(h));
    expect(h.of('radio').some((r) => /bullseye \d{3}, \d+ miles, angels \d+, track [a-z]+/.test(r.text))).toBe(true);
  });

  it('shows contextual hints (training)', () => {
    const h = harness(byId('t01'));
    h.run(2.5);
    expect(h.runner.hint).toMatch(/STICK/);
  });

  it('awards the Harbour Bridge bonus for flying under the main span', () => {
    const h = harness(byId('t01'), 'pilot', undefined);
    h.run(0.5);
    const p = h.world.player!;
    const S = AKL.bridge_s;
    const N = AKL.bridge_n;
    const t = 0.64;
    const cx = S.x + (N.x - S.x) * t;
    const cz = S.z + (N.z - S.z) * t;
    // fly across the bridge line, west → east, at 30 m
    let k = 0;
    h.run(1.2, () => {
      p.position.set(cx - 300 + k * 60, 30, cz);
      p.velocity.set(250, 0, 0);
      shieldPlayer(h);
      k++;
    });
    expect(h.of('hud:message').some((m) => /UNDER THE HARBOUR BRIDGE/.test(m.text))).toBe(true);
    const before = h.runner.result(h.world).score;
    expect(before).toBeGreaterThan(0);
  });

  it('survival mode spawns escalating waves and rearms the player', () => {
    const def = buildInstantMissionSeeded({ mode: 'survival', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mig29', enemyCount: 2 }, 99);
    const h = harness(def);
    h.run(7, () => shieldPlayer(h));
    const wave1 = h.world.aircraft.filter((a) => a.groupId === 'wave1');
    expect(wave1.length).toBe(1);
    const p = h.world.player!;
    p.stores.forEach((s) => (s.count = 0));
    killGroup(h, 'wave1');
    h.run(0.5);
    expect(h.of('hud:message').some((m) => m.text === 'WAVE 1 CLEARED')).toBe(true);
    expect(p.stores.some((s) => s.count > 0)).toBe(true);
    h.run(9, () => shieldPlayer(h));
    expect(h.world.aircraft.filter((a) => a.groupId === 'wave2').length).toBeGreaterThanOrEqual(1);
    h.world.applyDamage(p, 99999, null, 'collision');
    h.run(0.3);
    const res = h.runner.result(h.world);
    expect(res.success).toBe(false);
    expect(res.reason).toMatch(/survived 1 wave/);
    expect(res.grade).toBe('D');
  });

  it('ignores events from a disposed world (stale runner)', () => {
    const h = harness(byId('c01'));
    h.run(0.5);
    const before = h.runner.result(h.world).kills.air;
    const mig = h.world.aircraft.find((a) => a.type === 'mig29')!;
    const pid = h.world.player!.id;
    h.world.dispose();
    // a new mission world emitting on the same bus must not be counted by the old runner
    expect(() => h.events.emit('destroyed', { entity: mig, attackerId: pid, weapon: 'aim120' })).not.toThrow();
    expect(h.runner.result(h.world).kills.air).toBe(before);
  });
});
