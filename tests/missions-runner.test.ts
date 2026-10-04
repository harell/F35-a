/**
 * MISSIONS — MissionRunner with the real SimWorld + CombatSystem (flat fake terrain, stub AI):
 * spawning, objectives → success, failure paths, triggers, callouts, AWACS, hints, AO, bridge
 * bonus, stale-listener safety.
 *
 * The mechanics are flown on small test-only missions shaped like the removed Southern Cross
 * missions that used to carry these tests: sweepFixture / seadFixture (./missions-helpers, c01 / c03
 * shaped, extended below) and the protect (c02), bomber intercept (c05), ship strike (c06) and
 * friendly strike package (c09) fixtures below.
 */
import { describe, expect, it } from 'vitest';
import type { MissionDef } from '../src/core/contracts';
import { TRAINING } from '../src/missions';
import type { ObjectiveDef } from '../src/missions/schema';
import { NEVER, flight, mission, site, target, wingmen } from '../src/missions/content/common';
import { harness, killGroup, raiderFixture, seadFixture, shieldPlayer, sweepFixture } from './missions-helpers';
import { AKL, BRIDGE_SPAN_T } from '../src/core/auckland';

const DS = 'DARKSTAR';
/** Places (m, world space: origin Sky Tower, +X east, −Z north), on land or open water on the real coast. */
const BROWNS_IS = { x: 11830, z: -1720 };
const MOTUIHE = { x: 16170, z: -4490 };
const WAIHEKE_S = { x: 26300, z: -4400 };
const WAIHEKE_STRIP = { x: 26900, z: -6600 };
const WHENUAPAI = { x: Math.round(AKL.whenuapai.x), z: Math.round(AKL.whenuapai.z) };
const byId = (id: string) => TRAINING.find((m) => m.id === id)!;
const base = { kind: 'campaign', index: 1, timeOfDay: 'day', weather: 'clear', briefing: ['Test fixture.'] } satisfies Partial<MissionDef>;

/** Protect: the player escorts Kiwi flight (two unarmed F-35As) home while MiGs hunt it (once c02). */
const kiwiStart = { x: -6000, z: -14000, altitude: 4500, heading: 70, speed: 240 };
const PROTECT_FIXTURE: MissionDef = mission({
  ...base,
  id: 'fx_protect',
  title: 'Protect fixture',
  subtitle: 'Bring Kiwi home',
  recommendedLoadout: 'a2a_beast',
  allowedLoadouts: ['a2a_stealth', 'a2a_beast'],
  player: kiwiStart,
  script: {
    groups: [
      wingmen(1, kiwiStart),
      flight('kiwi', 'f35a', 2, { x: 17000, z: -19000 }, 6000, 243, 200, 'bomber', {
        team: 'blue',
        callsign: 'Kiwi',
        fixedCount: true,
        unarmed: true,
        loadout: 'strike_stealth',
        announce: false,
        task: { kind: 'route', points: [{ x: WHENUAPAI.x, z: WHENUAPAI.z, altitude: 1200 }] },
      }),
      flight('hunters', 'mig29', 2, { x: 33000, z: -28000 }, 6500, 243, 260, 'interceptor', { task: { kind: 'attack_group', group: 'kiwi' } }),
    ],
    objectives: [
      { id: 'o_kiwi', kind: 'protect', group: 'kiwi', minSurvivors: 1, until: { kind: 'objective', id: 'o_bandits', state: 'complete' }, label: 'Get Kiwi flight home', primary: true },
      { id: 'o_bandits', kind: 'destroy', groups: ['hunters'], label: 'Splash the fighters chasing Kiwi', primary: true },
    ],
  },
});

/** The c01-shaped sweep plus a bonus intercept: keep both MiG pairs off Takapuna. */
const CAP_FIXTURE: MissionDef = (() => {
  const def = sweepFixture();
  const shore: ObjectiveDef = { id: 'o_shore', kind: 'intercept', groups: ['fulcrum1', 'fulcrum2'], x: Math.round(AKL.takapuna.x), z: Math.round(AKL.takapuna.z), radius: 3000, label: 'Keep the MiGs off the North Shore', primary: false };
  return { ...def, script: { ...def.script, objectives: [...def.script.objectives, shore] } };
})();

/** The c03-shaped SEAD mission plus difficulty-gated sites: a second Shilka from Pilot, a pop-up (EMCON, unknown) SA-15 from Veteran. */
const SEAD_FIXTURE: MissionDef = (() => {
  const def = seadFixture();
  return {
    ...def,
    script: {
      ...def.script,
      sams: [
        ...def.script.sams,
        site('zsu2', 'rangi_aaa', 'zsu23', { x: 9600, z: -5500 }, { minDifficulty: 'pilot' }),
        site('sa15pop', 'popup', 'sa15', BROWNS_IS, { emcon: true, minDifficulty: 'veteran' }),
      ],
    },
  };
})();

/** Bomber intercept: three Su-27 strike jets (bomber role) routed at the Sky Tower, fail inside 7 km, turn back after losing two-thirds (once c05). */
const raidStart = { x: -2000, z: -13000, altitude: 6500, heading: 50, speed: 250 };
const RAID_FIXTURE: MissionDef = mission({
  ...base,
  id: 'fx_raid',
  title: 'Raid fixture',
  subtitle: 'Intercept the bombers',
  recommendedLoadout: 'a2a_beast',
  allowedLoadouts: ['a2a_beast', 'a2a_stealth'],
  player: raidStart,
  script: {
    groups: [
      flight('raid', 'su27', 3, { x: 34000, z: -33000 }, 9000, 240, 240, 'bomber', {
        maxCount: 4,
        formation: 'wall',
        spacing: 700,
        task: { kind: 'route', points: [{ x: 12000, z: -15000, altitude: 8500 }, { x: 0, z: 0, altitude: 8000 }] },
      }),
    ],
    objectives: [
      {
        id: 'o_raid',
        kind: 'intercept',
        groups: ['raid'],
        x: 0,
        z: 0,
        radius: 7000,
        abortFraction: 0.67,
        abortTo: { x: 34000, z: -34000, altitude: 9000 },
        label: 'Stop the raid before missile range',
        primary: true,
      },
    ],
  },
});

/**
 * Ship strike: two slow corvettes on a patrol line (primary), a moored supply ship, a Tor, an SA-8,
 * a Shilka on Browns Island in front of the run-in, a Flanker CAP and a fighter sweep (once c06).
 */
const shipStart = { x: 1000, z: 7000, altitude: 3500, heading: 75, speed: 240 };
const SHIP_FIXTURE: MissionDef = mission({
  ...base,
  id: 'fx_ships',
  title: 'Ship strike fixture',
  subtitle: 'Sink the corvettes',
  recommendedLoadout: 'strike_stealth',
  allowedLoadouts: ['strike_stealth', 'strike_beast', 'sead_stealth', 'strike_sdb2'],
  player: shipStart,
  script: {
    groups: [
      flight('flankers', 'su27', 2, { x: 26000, z: -1000 }, 5500, 250, 240, 'cap', { task: { kind: 'patrol', x: 21000, z: -2500, radius: 7000, altitude: 5000 } }),
      // Viper 2 as a fighter sweep ahead of the player, straight at the CAP
      flight('viper', 'f35a', 1, { x: 5500, z: 5000 }, 6500, 70, 250, 'fighter', {
        team: 'blue',
        callsign: 'Viper',
        firstNumber: 2,
        fixedCount: true,
        loadout: 'a2a_stealth',
        announce: false,
        task: { kind: 'attack_group', group: 'flankers' },
      }),
    ],
    sams: [
      site('sa15', 'motuihe_sa15', 'sa15', MOTUIHE),
      site('sa8', 'wai_sa8', 'sa8', WAIHEKE_S),
      site('zsu', 'browns_aaa', 'zsu23', BROWNS_IS, { minDifficulty: 'pilot' }),
    ],
    ground: [
      target('cv1', 'fleet', 'ship', { x: 24000, z: 1000 }, { name: 'Corvette 531', path: [{ x: 17000, z: -500 }, { x: 24000, z: 1000 }], loop: true, speed: 1 }),
      target('cv2', 'fleet', 'ship', { x: 25500, z: 1800 }, { name: 'Corvette 532', path: [{ x: 18500, z: 300 }, { x: 25500, z: 1800 }], loop: true, speed: 1 }),
      target('supply', 'supply', 'ship', { x: 20500, z: -2300 }, { name: 'Supply Ship' }),
    ],
    objectives: [
      { id: 'o_fleet', kind: 'destroy', groups: ['fleet'], label: 'Sink both corvettes', primary: true },
      { id: 'o_supply', kind: 'destroy', groups: ['supply'], label: 'Sink the supply ship', primary: false },
    ],
    waypoints: [{ id: 'wp_fleet', label: 'Corvettes', kind: 'target', x: 21000, z: 500, objective: 'o_fleet' }],
  },
});

/**
 * Friendly strike package: Hammer flight (four F-35As) is spawned by trigger once the Flankers are
 * down, and its scripted 'strike' action takes out the Waiheke depot when it reaches the target (once c09).
 */
const pkgStart = { x: -6000, z: -5000, altitude: 6500, heading: 95, speed: 240 };
const strip = WAIHEKE_STRIP;
const PACKAGE_FIXTURE: MissionDef = mission({
  ...base,
  id: 'fx_package',
  title: 'Strike package fixture',
  subtitle: 'Escort Hammer',
  recommendedLoadout: 'a2a_beast',
  allowedLoadouts: ['a2a_beast', 'a2a_stealth'],
  player: pkgStart,
  script: {
    groups: [
      flight('hammer', 'f35a', 4, { x: 9000, z: 3000 }, 6000, 95, 230, 'bomber', {
        team: 'blue',
        callsign: 'Hammer',
        fixedCount: true,
        loadout: 'strike_stealth',
        formation: 'box',
        spacing: 250,
        announce: false,
        spawn: NEVER,
        task: { kind: 'route', points: [{ x: strip.x + 300, z: strip.z + 3000, altitude: 400 }, { x: 33000, z: 1500, altitude: 3000 }] },
      }),
      flight('flankers', 'su27', 2, { x: 32000, z: -22000 }, 7000, 240, 250, 'interceptor', { maxCount: 2, task: { kind: 'attack_player' } }),
    ],
    ground: [
      target('fuel1', 'depot', 'fuel', { x: strip.x + 500, z: strip.z + 600 }),
      target('fuel2', 'depot', 'fuel', { x: strip.x + 580, z: strip.z + 600 }),
      target('hangar', 'depot', 'hangar', { x: strip.x - 800, z: strip.z + 650 }, { name: 'Airfield Hangar' }),
    ],
    objectives: [
      { id: 'o_hammer', kind: 'protect', group: 'hammer', minSurvivors: 2, until: { kind: 'objective', id: 'o_strike', state: 'complete' }, label: 'Keep Hammer alive', primary: true },
      { id: 'o_strike', kind: 'destroy', groups: ['depot'], label: 'Hammer destroys the fuel farm', primary: true },
    ],
    triggers: [
      {
        id: 't_push',
        when: { kind: 'group_destroyed', group: 'flankers' },
        delay: 3,
        actions: [
          { kind: 'radio', from: DS, text: 'Hammer, Darkstar. Picture clean. Hammer, push!', priority: 3 },
          { kind: 'spawn', group: 'hammer' },
        ],
      },
      { id: 't_release', when: { kind: 'area', who: { group: 'hammer' }, x: strip.x, z: strip.z, radius: 5000 }, delay: 1, actions: [{ kind: 'radio', from: 'Hammer 1', text: 'Hammer 1, bombs away!', priority: 2 }] },
      {
        id: 't_impact',
        when: { kind: 'trigger', id: 't_release' },
        delay: 12,
        actions: [
          { kind: 'strike', group: 'depot', by: 'hammer' },
          { kind: 'radio', from: 'Hammer 1', text: 'Shack! Good hits on the fuel farm.', priority: 2 },
        ],
      },
    ],
  },
});

describe('MissionRunner: setup', () => {
  it('spawns the player, wingman and enemies (CAP fixture, pilot)', () => {
    const h = harness(CAP_FIXTURE);
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
    const rec = harness(SEAD_FIXTURE, 'recruit');
    const ace = harness(SEAD_FIXTURE, 'ace');
    // sa6, sa8, zsu1 always; zsu2 pilot+; sa15pop veteran+
    expect(rec.world.sams).toHaveLength(3);
    expect(ace.world.sams).toHaveLength(5);
    const capAce = harness(CAP_FIXTURE, 'ace');
    expect(capAce.world.aircraft.filter((a) => a.team === 'red')).toHaveLength(3); // 2 × 1.5
    const raidRec = harness(RAID_FIXTURE, 'recruit');
    expect(raidRec.world.aircraft.filter((a) => a.groupId === 'raid')).toHaveLength(2); // round(3 × 0.75)
  });

  it('applies ground spawns: ships, pop-up SAMs, known flags', () => {
    const h = harness(SHIP_FIXTURE);
    // the mission's own (hostile) ships; neutral civil shipping is spawned on top of them
    const own = h.world.ground.filter((g) => g.team !== 'neutral');
    expect(own.filter((g) => g.type === 'ship')).toHaveLength(3);
    const moving = own.filter((g) => g.path);
    expect(moving).toHaveLength(2);
    const pop = harness(SEAD_FIXTURE, 'veteran').world.sams.find((s) => s.type === 'sa15')!;
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
  it('destroying all primary targets completes the mission (SEAD fixture)', () => {
    const h = harness(SEAD_FIXTURE);
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

  it('chains objectives through triggers (CAP fixture: second MiG pair after the first)', () => {
    const h = harness(CAP_FIXTURE);
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
    const h = harness(CAP_FIXTURE);
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

  it('losing the protected flight fails the mission (protect fixture)', () => {
    const h = harness(PROTECT_FIXTURE);
    h.run(0.5);
    killGroup(h, 'kiwi', false);
    h.run(2);
    expect(h.runner.objectives.find((o) => o.id === 'o_kiwi')!.state).toBe('failed');
    expect(h.runner.state).toBe('failed');
    expect(h.runner.result(h.world).friendlyLosses).toBe(2);
    expect(h.of('radio').some((r) => r.voice === 'a_friendly_down')).toBe(true);
  });

  it('a raid reaching its launch point fails the intercept (raid fixture)', () => {
    const h = harness(RAID_FIXTURE);
    h.run(0.5);
    const bomber = h.world.aircraft.find((a) => a.groupId === 'raid')!;
    bomber.position.set(1000, 8000, 1000);
    h.run(0.3);
    expect(h.runner.objectives.find((o) => o.id === 'o_raid')!.state).toBe('failed');
    expect(h.runner.state).toBe('failed');
  });

  it('a raid that loses two-thirds of its bombers turns back (abortFraction)', () => {
    const h = harness(RAID_FIXTURE);
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

  it('scripted strike by a friendly package destroys the target (strike package fixture)', () => {
    const h = harness(PACKAGE_FIXTURE);
    // Hammer only pushes (a trigger spawns it) once the Flankers are dealt with
    h.run(0.5);
    expect(h.world.aircraft.some((a) => a.groupId === 'hammer')).toBe(false);
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

  it('time limit fails the mission', () => {
    const def = raiderFixture();
    const h = harness(def);
    h.world.player!.position.set(-30000, 7000, 30000); // far from the fight
    h.run(0.2);
    const limit = def.timeLimit!;
    (h.world as unknown as { time: number }).time = limit - 0.5;
    h.run(1, () => shieldPlayer(h));
    expect(h.runner.state).toBe('failed');
    expect(h.runner.result(h.world).reason).toMatch(/time/i);
  });
});

describe('MissionRunner: presentation', () => {
  it('kill callouts: splash radio + HUD for a player air kill', () => {
    const h = harness(CAP_FIXTURE);
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

  it('kill callouts: target destroyed for SAM kills', () => {
    const h = harness(SEAD_FIXTURE);
    h.run(0.5);
    killGroup(h, 'rangi_aaa');
    h.run(8, () => shieldPlayer(h));
    expect(h.of('hud:message').some((m) => /DESTROYED/.test(m.text))).toBe(true);
    expect(h.of('radio').some((r) => r.voice === 'p_target_destroyed')).toBe(true);
  });

  it('AWACS calls the initial picture in BRAA format', () => {
    const h = harness(CAP_FIXTURE);
    h.run(8, () => shieldPlayer(h));
    const call = h.of('radio').find((r) => r.from === 'DARKSTAR' && /BRAA \d{3}, \d+ miles, angels \d+, (hot|flanking|beaming|cold)/.test(r.text));
    expect(call).toBeTruthy();
    expect(call!.voice).toBe('a_bandits');
  });

  it('AWACS uses bullseye when the mission asks for it', () => {
    const h = harness(raiderFixture());
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
    const t = BRIDGE_SPAN_T;
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

  it('ignores events from a disposed world (stale runner)', () => {
    const h = harness(CAP_FIXTURE);
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

describe('A/G auto-designation ranks the primary targets first (playtest 2.2-f: the ship strike boxed the Shilka)', () => {
  const designatedGroup = (h: ReturnType<typeof harness>) => {
    const p = h.world.player!;
    const e = h.world.getEntity(p.radar.designatedId);
    return e && (e.kind === 'ground' || e.kind === 'sam') ? e.groupId : null;
  };

  it('ship strike with the StormBreaker: a corvette, not the Shilka on Browns Island in front', () => {
    const def = SHIP_FIXTURE;
    const h = harness(def, 'pilot', 'strike_sdb2');
    const p = h.world.player!;
    shieldPlayer(h);
    expect(p.selectedWeapon).toBe('gbu53');
    // the Shilka is in the picture and in front: before the fix it won on range
    expect(h.world.sams.some((s) => s.type === 'zsu23' && s.alive)).toBe(true);
    let first: string | null = null;
    h.run(3, () => {
      first ??= designatedGroup(h);
      return false;
    });
    expect(first).toBe('fleet');
    // TGT cycling: the other corvette next, then the rest
    const order: string[] = [];
    for (let i = 0; i < 2; i++) {
      h.world.combat.cycleTarget(p, h.world);
      order.push(designatedGroup(h) ?? '');
    }
    expect(order).toEqual(['fleet', 'fleet']);
  });

  it('SEAD still boxes a primary SAM first, and a dead primary group stops ranking', () => {
    const def = SEAD_FIXTURE;
    const h = harness(def, 'pilot', def.recommendedLoadout);
    shieldPlayer(h);
    h.run(0.2);
    const flagged = h.world.sams.filter((s) => s.objective).map((s) => s.groupId);
    expect(new Set(flagged)).toEqual(new Set(['rangi_sa6', 'rangi_sa8']));
    expect(h.world.sams.filter((s) => s.groupId === 'rangi_aaa').every((s) => !s.objective)).toBe(true);
    let first: string | null = null;
    h.run(3, () => {
      first ??= designatedGroup(h);
      return false;
    });
    expect(['rangi_sa6', 'rangi_sa8']).toContain(first);
    killGroup(h, 'rangi_sa6');
    h.run(1);
    expect(h.world.sams.filter((s) => s.groupId === 'rangi_sa8').every((s) => s.objective)).toBe(true);
  });
});
