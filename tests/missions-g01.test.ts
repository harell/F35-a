/**
 * IRGC campaign mission g01 "Buzz Kill" (issue #78): a swarm of 10 Shahed-136 drones in a triangle
 * flies at the Sky Tower over the suburbs. Shoot them all down → win; two reach the tower → it
 * collapses and the mission fails; one reaches it → the tower is damaged and the mission goes on,
 * still winnable; and missiles alone can't win (10 drones, at most 8 missiles), so the gun is
 * required and the mission carries more rounds than the real 180.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { AKL } from '../src/core/auckland';
import { DIFFICULTIES, LOADOUTS, WEAPON_INFO } from '../src/core/data';
import { EventBus } from '../src/core/events';
import type { Difficulty } from '../src/core/types';
import { CAMPAIGNS, campaignOf, createMissionRunner, missionById, missionGunAmmo, terrainPadsFor, validateMission } from '../src/missions';
import { G01, G01_GUN_PASS, G01_SWARM } from '../src/missions/content/irgc';
import { evalCondition } from '../src/missions/runtime/conditions';
import { slowGunPass } from '../src/missions/runtime/hints';
import type { MissionState } from '../src/missions/runtime/state';
import { SHAHED_SPEED } from '../src/sim/drone/oneWay';
import { stallSpeedIas } from '../src/sim/flight/performance';
import { AircraftEntity as AircraftEntityC } from '../src/sim/entities';
import { REASONS } from '../src/missions/runtime/reasons';
import { createAiBrain } from '../src/ai';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { MUNITIONS } from '../src/sim/weapons/defs';
import { AIRCRAFT_HEALTH } from '../src/sim/damage/tables';
import { AIRCRAFT_PERF } from '../src/sim/flight/aircraftData';
import { initFlight } from '../src/sim/flight/FlightModel';
import type { AircraftEntity } from '../src/sim/entities';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { harness, type Harness } from './missions-helpers';
import { MissionBot, type MissionBotOptions } from './missions-bot';

const DIFFS: Difficulty[] = ['recruit', 'pilot', 'veteran', 'ace'];
const AAMS = ['aim120', 'aim9x'] as const;

/**
 * Farthest from a Shahed that one air-to-air missile's burst kills it outright (m): the blast falls
 * off linearly from the hull (sim/weapons/flight.ts applyBlast). About 25 m for the AIM-120.
 */
const SHAHED_HP = AIRCRAFT_HEALTH.shahed136 ?? 0;
const SHAHED_KILL_RADIUS = Math.max(
  ...AAMS.map((w) => MUNITIONS[w].blastRadius * Math.max(0, 1 - SHAHED_HP / MUNITIONS[w].damage) + 0.5 * AIRCRAFT_PERF.shahed136.radius),
);

const drones = (h: Harness): AircraftEntity[] => h.world.aircraft.filter((a) => a.groupId === 'shaheds');
const tower = (h: Harness) => h.world.landmarks.find((l) => l.id === 'skytower')!;

/** Shoot a drone down (credited to the player's AIM-120, as a hit would be). */
function kill(h: Harness, d: AircraftEntity): void {
  h.world.applyDamage(d, 1_000, h.world.player!.id, 'aim120', d.position.clone());
}

/** Run with the player parked on its CAP (out of the drones' way, inside the AO). */
function runParked(h: Harness, seconds: number, until?: () => boolean): void {
  const p = h.world.player!;
  const park = p.position.clone();
  h.run(seconds, () => {
    p.position.copy(park);
    return until?.() ?? h.runner.state !== 'running';
  });
}

describe('g01 Buzz Kill: content', () => {
  it('is the IRGC campaign\'s first mission, reachable by id (?mission=g01&autostart=1) and valid', () => {
    const irgc = CAMPAIGNS.find((c) => c.id === 'irgc')!;
    expect(irgc.missions[0]).toBe(G01);
    expect(G01.id).toBe('g01');
    expect(G01.index).toBe(1);
    expect(missionById('g01')).toBe(G01);
    expect(campaignOf('g01')?.id).toBe('irgc');
    expect(validateMission(G01)).toEqual([]);
    expect(G01.theater).toBe('auckland');
    // a drone stagger has to be a distance behind, not in front
    const bad = { ...G01, script: { ...G01.script, groups: G01.script.groups.map((g) => ({ ...g, oneWay: { ...g.oneWay!, stagger: -65 } })) } };
    expect(validateMission(bad).some((e) => e.includes('stagger'))).toBe(true);
  });

  it('10 dumb Shaheds in a triangle, 10–12 km from the Sky Tower over the suburbs; no SAMs, no fighters, no wingmen', () => {
    const sc = G01.script;
    expect(sc.sams).toEqual([]);
    expect(sc.ground).toEqual([]);
    expect(sc.groups).toHaveLength(1);
    const g = sc.groups[0];
    expect(g).toMatchObject({ type: 'shahed136', team: 'red', count: 10, fixedCount: true, formation: 'triangle' });
    expect(g.oneWay).toBeDefined();
    const d = Math.hypot(g.x - AKL.skytower.x, g.z - AKL.skytower.z);
    expect(d).toBeGreaterThanOrEqual(10_000);
    expect(d).toBeLessThanOrEqual(12_000);
    // 3.3–4 minutes to impact at the drone's speed
    expect(d / g.speed).toBeGreaterThan(195);
    expect(d / g.speed).toBeLessThan(240);
    // aimed at the tower, on a straight route (the triangle keeps its shape)
    const ow = g.oneWay!;
    expect(Math.hypot(ow.targetX - AKL.skytower.x, ow.targetZ - AKL.skytower.z)).toBeLessThan(1);
    for (const w of ow.route ?? []) {
      const cross = (w.x - AKL.skytower.x) * (g.z - AKL.skytower.z) - (w.z - AKL.skytower.z) * (g.x - AKL.skytower.x);
      expect(Math.abs(cross) / d).toBeLessThan(5);
    }
  });

  it('air-to-air only (#136): beast mode alone, carrying both air-to-air missiles, and the gun', () => {
    expect(G01.recommendedLoadout).toBe('a2a_beast');
    expect(G01.allowedLoadouts).toEqual(['a2a_beast']);
    for (const lo of G01.allowedLoadouts) {
      const kinds = new Set(LOADOUTS[lo].stores.map((s) => WEAPON_INFO[s.weapon].kind));
      expect([...kinds], lo).toEqual(['aam']);
      // the player meets every air-to-air missile the game has
      const aams = (Object.keys(WEAPON_INFO) as (keyof typeof WEAPON_INFO)[]).filter((w) => WEAPON_INFO[w].kind === 'aam');
      for (const w of aams) expect(LOADOUTS[lo].stores.some((s) => s.weapon === w), `${lo} ${w}`).toBe(true);
      expect(LOADOUTS[lo].gunAmmo, lo).toBeGreaterThan(0);
    }
  });

  it('carries more gun rounds than usual (360–400), on every difficulty and loadout', () => {
    for (const diff of DIFFS) {
      for (const lo of G01.allowedLoadouts) {
        const n = missionGunAmmo(G01, diff, lo);
        expect(n, `${diff} ${lo}`).toBeGreaterThanOrEqual(360);
        expect(n, `${diff} ${lo}`).toBeLessThanOrEqual(400);
        expect(n).toBeGreaterThan(LOADOUTS[lo].gunAmmo);
      }
    }
    // fewer on harder difficulties, never more
    const rounds = DIFFS.map((d) => missionGunAmmo(G01, d, 'a2a_beast'));
    for (let i = 1; i < rounds.length; i++) expect(rounds[i]).toBeLessThanOrEqual(rounds[i - 1]);
  });

  it('missiles alone can\'t win: more drones than missiles, and the drones are spaced so one missile can\'t take two', () => {
    for (const lo of G01.allowedLoadouts) {
      const missiles = LOADOUTS[lo].stores.filter((s) => (AAMS as readonly string[]).includes(s.weapon)).reduce((n, s) => n + s.count, 0);
      expect(missiles, lo).toBeLessThanOrEqual(8);
      expect(missiles, lo).toBeLessThan(G01_SWARM.count);
      expect(missiles, lo).toBeLessThan(G01_SWARM.recruitCount); // the gun is required on Recruit too
    }
    // over the suburbs nearest neighbours are `spacing` apart; converging on the tower they close up
    // into single file `stagger` apart: both wider than two kill radii (the runtime test below flies it)
    expect(G01_SWARM.spacing).toBeGreaterThan(2 * SHAHED_KILL_RADIUS);
    expect(G01_SWARM.stagger).toBeGreaterThan(2 * SHAHED_KILL_RADIUS);
  });
});

describe('g01 Buzz Kill: the swarm in the mission runtime', () => {
  it('spawns 10 drones (9 on Recruit) in rows of 1, 2, 3, 4 (each stepped back, so no two abreast) with the nose on the Sky Tower', () => {
    const { spacing, stagger } = G01_SWARM;
    for (const diff of DIFFS) {
      const h = harness(G01, diff);
      const ds = drones(h);
      const n = diff === 'recruit' ? G01_SWARM.recruitCount : G01_SWARM.count;
      expect(ds, diff).toHaveLength(n);
      const lead = ds[0];
      const heading = Math.atan2(AKL.skytower.x - lead.position.x, -(AKL.skytower.z - lead.position.z));
      const fwd = new Vector3(Math.sin(heading), 0, -Math.cos(heading));
      const right = new Vector3(Math.cos(heading), 0, Math.sin(heading));
      for (const d of ds) {
        expect(d.oneWay).not.toBeNull();
        expect(Math.abs(Math.atan2(Math.sin(d.flight.heading - heading), Math.cos(d.flight.heading - heading)))).toBeLessThan(0.01);
      }
      // front to back: every drone has its own place along the track, at least `stagger` behind the
      // one ahead; a row ends where the gap opens up by the row spacing
      const slots = ds
        .map((d) => ({ aft: -d.position.clone().sub(lead.position).dot(fwd), right: d.position.clone().sub(lead.position).dot(right) }))
        .sort((a, b) => a.aft - b.aft);
      const rows: (typeof slots)[] = [[slots[0]]];
      for (let i = 1; i < slots.length; i++) {
        const gap = slots[i].aft - slots[i - 1].aft;
        expect(gap, diff).toBeGreaterThan(stagger - 1);
        if (gap > stagger + spacing / 2) rows.push([]);
        rows[rows.length - 1].push(slots[i]);
      }
      expect(rows.map((r) => r.length), diff).toEqual(n === 10 ? [1, 2, 3, 4] : [1, 2, 3, 3]);
      // each full row spread across the lead's track, `spacing` apart: a triangle seen from above
      rows.forEach((row, r) => {
        if (row.length !== r + 1) return; // Recruit's short last row
        const xs = row.map((q) => q.right).sort((a, b) => a - b);
        xs.forEach((x, j) => expect(x).toBeCloseTo((j - r / 2) * spacing, 0));
      });
    }
  });

  it('all 10 destroyed → mission complete, tower untouched (bonus objective too)', () => {
    const h = harness(G01);
    h.run(5);
    for (const d of drones(h)) kill(h, d);
    h.run(2);
    expect(h.runner.state).toBe('success');
    expect(tower(h).alive).toBe(true);
    expect(tower(h).hits).toBe(0);
    expect(h.runner.objectives.find((o) => o.id === 'o_tower')?.state).toBe('complete');
  });

  it('two drones reach the tower → it collapses and the mission fails', { timeout: 60_000 }, () => {
    const h = harness(G01);
    const ds = drones(h);
    const impacts: unknown[] = [];
    h.events.on('drone:impact', (e) => {
      if (e.landmark === tower(h)) impacts.push(e);
    });
    h.run(1);
    for (const d of ds.slice(2)) kill(h, d); // the lead and one drone of the second row get through
    runParked(h, 300);
    expect(impacts).toHaveLength(2);
    expect(tower(h).hits).toBe(2);
    expect(tower(h).alive).toBe(false);
    expect(h.runner.state).toBe('failed');
    expect(h.of('mission:end')).toEqual([{ success: false, reason: REASONS.skytowerLost }]);
  });

  it('Winchester means the gun, not a trip home (there is no rearming, #63): no RTB call, no home cue, and the loss tip says how to beat the swarm (playtest 1.3-j, 1.4-h)', { timeout: 60_000 }, () => {
    const h = harness(G01);
    const hud: string[] = [];
    const radio: string[] = [];
    h.events.on('hud:message', (e) => hud.push(e.text));
    h.events.on('radio', (e) => radio.push(e.text));
    h.run(1);
    const p = h.world.player!;
    for (const st of p.stores) st.count = 0; // every missile fired
    h.run(2);
    expect(hud).toContain('WINCHESTER — GUNS ONLY');
    expect(radio.some((t) => /Winchester\. (Guns only|.* has the fight)/.test(t))).toBe(true);
    expect(hud.some((t) => /RTB/.test(t))).toBe(false);
    expect(radio.some((t) => /RTB|rearm/i.test(t))).toBe(false);
    expect(h.runner.currentWaypoint?.kind).not.toBe('rtb');
    runParked(h, 300);
    const r = h.runner.result(h.world);
    expect(r.reason).toBe(REASONS.skytowerLost);
    expect(r.tips?.[0]).toMatch(/swarm got through.*about 200 kt/);
    expect(r.tips?.some((t) => /Whenuapai/.test(t))).toBe(false);
  });

  it('one missile never takes two drones: live drones stay more than two missile kill radii apart all the way into the tower', { timeout: 60_000 }, () => {
    const h = harness(G01);
    const ds = drones(h);
    expect(ds[0].maxHealth).toBe(SHAHED_HP);
    expect(ds[0].radius).toBe(AIRCRAFT_PERF.shahed136.radius);
    let closest = Infinity;
    let where = '';
    runParked(h, 300, () => {
      const live = ds.filter((d) => d.alive);
      for (let a = 0; a < live.length; a++) {
        for (let b = a + 1; b < live.length; b++) {
          const sep = live[a].position.distanceTo(live[b].position);
          if (sep < closest) {
            closest = sep;
            const toTower = Math.round(Math.hypot(live[a].position.x - AKL.skytower.x, live[a].position.z - AKL.skytower.z));
            where = `${live[a].callsign} / ${live[b].callsign}, ${toTower} m from the tower at t=${h.world.time.toFixed(1)} s`;
          }
        }
      }
      return live.length === 0; // past the mission's end: every drone flies on into its target
    });
    expect(ds.every((d) => d.oneWay?.impacted), 'every drone flew all the way in').toBe(true);
    expect(closest, `closest pair ${closest.toFixed(1)} m: ${where}`).toBeGreaterThan(2 * SHAHED_KILL_RADIUS);
  });

  it('one drone reaches the tower → damaged and burning, the mission goes on and is still winnable', { timeout: 60_000 }, () => {
    const h = harness(G01);
    const ds = drones(h);
    h.run(1);
    const [first, ...rest] = ds;
    const last = rest.pop()!;
    for (const d of rest) kill(h, d); // 8 shot down, the lead and the back-row straggler left
    runParked(h, 300, () => tower(h).hits > 0 || h.runner.state !== 'running');
    expect(first.alive).toBe(false);
    expect(first.oneWay?.impacted).toBe(true);
    expect(tower(h).hits).toBe(1);
    expect(tower(h).alive).toBe(true);
    expect(h.runner.state).toBe('running');
    expect(h.of('hud:message').some((m) => m.text === 'SKY TOWER HIT')).toBe(true);
    expect(h.runner.objectives.find((o) => o.id === 'o_tower')?.state).toBe('failed');
    expect(last.alive).toBe(true);
    kill(h, last);
    h.run(2);
    expect(h.runner.state).toBe('success');
    expect(tower(h).alive).toBe(true);
  });
});

describe('g01 Buzz Kill: the competent bot (real Auckland terrain, sim and runner)', () => {
  it('missiles alone can\'t win: the bot fires its whole load with no gun rounds, and the drones left bring the tower down', { timeout: 180_000 }, () => {
    const terrain = new TerrainQueryImpl(runSync(generateTerrain({ theater: G01.theater, seed: G01.seed, resolution: 512, features: allFeatures(G01.theater, []), pads: terrainPadsFor(G01) })));
    // (Pilot: Recruit's nine drones let a flawless missile run win with the tower hit once)
    for (const seed of [1, 2]) {
      const events = new EventBus();
      const d = DIFFICULTIES.pilot;
      const world = createSimWorld({ terrain, difficulty: d, events, combat: createCombatSystemSeeded(seed) });
      const runner = createMissionRunner({ ...G01, gunAmmo: 0 }, { createAi: createAiBrain, difficulty: d, events });
      runner.setup(world, 'a2a_beast');
      const p = world.player!;
      const bot = new MissionBot(runner, world, p, { rtb: false } as MissionBotOptions);
      let kills = 0;
      events.on('destroyed', (e) => {
        if (e.attackerId === p.id && e.entity.kind === 'aircraft') kills++;
      });
      // one load: once the last missile is gone the jet is parked where it is (no trip home for more)
      let park: Vector3 | null = null;
      for (let i = 0; i < 400 * 60 && runner.state === 'running'; i++) {
        const left = world.combat.remaining(p, 'aim120') + world.combat.remaining(p, 'aim9x');
        const flying = world.missiles.some((m) => m.alive && m.shooterId === p.id);
        if (!park && left === 0 && !flying) park = p.position.clone();
        if (park) p.position.copy(park);
        else if (i % 3 === 0) bot.update(3 / 60);
        world.step(1 / 60);
        runner.update(world, 1 / 60);
      }
      const why = `seed ${seed}: ${runner.state}@${Math.round(world.time)}s kills=${kills}`;
      expect(park, why).not.toBeNull();
      expect(kills, why).toBeLessThanOrEqual(8);
      expect(kills, why).toBeGreaterThanOrEqual(6); // the missiles did their part: the head-on intercept is reachable
      expect(runner.state, why).toBe('failed');
      expect(runner.result(world).reason, why).toBe(REASONS.skytowerLost);
      runner.dispose?.();
    }
  });
});

describe('g01 Buzz Kill: the briefed gun pass lines the pipper up (playtest r3, 3.1-a)', () => {
  // the jet flies ~12° nose-up at 200 kt: level behind a drone the pipper sits above it. From the
  // briefed 400 ft below at 200 kt the drone rises into the pipper inside the briefed burst window.
  it(`${G01_GUN_PASS.belowFt} ft below at ${G01_GUN_PASS.approachKt} kt: the pipper crosses the drone between ${G01_GUN_PASS.burstFrom} and ${G01_GUN_PASS.burstTo} m`, { timeout: 60_000 }, () => {
    const err = (range: number) => {
      const h = harness(G01, 'pilot');
      h.run(1);
      const w = h.world;
      const p = w.player!;
      const d = drones(h)[0];
      const v = d.velocity.clone().setY(0).normalize();
      p.position.copy(d.position).addScaledVector(v, -range).setY(d.position.y - G01_GUN_PASS.belowFt * 0.3048);
      initFlight(p, { heading: Math.atan2(v.x, -v.z), speed: (G01_GUN_PASS.approachKt * 1852) / 3600 });
      w.combat.selectWeapon(p, 'gun', w);
      w.combat.designate(p, d.id, w);
      h.run(0.25);
      const lp = w.combat.gunLeadPoint(p, w)!;
      const el = (q: Vector3) => (Math.atan2(q.y - p.position.y, Math.hypot(q.x - p.position.x, q.z - p.position.z)) * 180) / Math.PI;
      return el(lp) - el(d.position); // + : the pipper above the drone
    };
    const far = err(G01_GUN_PASS.burstTo + 50);
    const near = err(G01_GUN_PASS.burstFrom - 50);
    expect(far, 'still above the drone just outside the window').toBeGreaterThan(0);
    expect(near, 'below it just inside the near end').toBeLessThan(0);
    expect(Math.abs(err(600)), 'on the drone at 600 m').toBeLessThan(1.5);
  });
});

describe('g01 Buzz Kill: gun pass and swarm hints', () => {
  const KT = 1.943844;
  const hint = (id: string) => G01.script.hints!.find((h) => h.id === id)!;
  const state = (weapon: string, shotsFired = 0) => ({ player: { alive: true, selectedWeapon: weapon, shotsFired } }) as unknown as MissionState;

  it('gives the real numbers: the Shahed\'s cruise speed, an approach speed well above the F-35\'s stall, no "throttle right back"', () => {
    const shahedKt = SHAHED_SPEED * KT;
    const f35 = new AircraftEntityC(1, 'f35a', 'blue');
    // half the internal fuel (mid-mission), clean: about the measured 1 g stall (~72 m/s, ~140 kt)
    f35.flight.fuel = AIRCRAFT_PERF.f35a.internalFuel * 0.5;
    const stallKt = stallSpeedIas(f35) * KT;
    expect(stallKt).toBeGreaterThan(120);
    expect(stallKt).toBeLessThan(160);
    // ~200 kt from behind: clear of the stall (the jet wallows below ~175 kt), closing at ~100 kt
    expect(G01_GUN_PASS.approachKt).toBeGreaterThanOrEqual(stallKt * 1.3);
    expect(Math.abs(G01_GUN_PASS.approachKt - shahedKt - G01_GUN_PASS.closureKt)).toBeLessThanOrEqual(10);
    const gun = hint('h_gun').text;
    expect(gun).toContain(`~${Math.round(shahedKt / 10) * 10} kt`);
    expect(gun).toContain(`${G01_GUN_PASS.approachKt} kt`);
    expect(gun).toContain(`Vc ${G01_GUN_PASS.closureKt}`);
    expect(gun).toContain(`${G01_GUN_PASS.burstFrom}–${G01_GUN_PASS.burstTo} m`);
    expect(hint('h_overshoot').text).toMatch(new RegExp(`${G01_GUN_PASS.belowFt} ft below it: the drone rises into the pipper near 600 m. Overshot\\? Pull up, come round`));
    expect(G01.briefing.join(' ')).toContain(`${G01_GUN_PASS.burstFrom} to ${G01_GUN_PASS.burstTo} m`);
    expect(G01.briefing.join(' ')).toContain(`about ${G01_GUN_PASS.belowFt} ft below the drone`);
    expect(hint('h_9x').text).toMatch(/AIM-9X.*inside about 2 km/); // NO SEEKER beyond ~2 km head-on (playtest r2, 2.1-e)
    const all = [...G01.briefing, ...G01.script.hints!.map((h) => h.text)].join(' ');
    expect(all).not.toMatch(/throttle right back/i);
    expect(G01.briefing.join(' ')).toContain(`${G01_GUN_PASS.approachKt} knots`);
  });

  it('times them: the swarm hint after the first launch (missiles), the gun pass hints once the GUN is selected', () => {
    const swarm = hint('h_swarm');
    expect(swarm.text).toBe('After each launch the next drone is boxed: keep pressing FIRE. TGT steps through them.');
    expect(evalCondition(swarm.when, state('aim120', 0))).toBe(false);
    expect(evalCondition(swarm.when, state('aim120', 1))).toBe(true);
    expect(evalCondition(swarm.when, state('gun', 3))).toBe(false);
    for (const id of ['h_gun', 'h_overshoot']) {
      expect(evalCondition(hint(id).when, state('aim120', 8))).toBe(false);
      expect(evalCondition(hint(id).when, state('gun', 8))).toBe(true);
    }
    // the gun hint first, then what to do on an overshoot (scripted hints show once each, in order)
    const ids = G01.script.hints!.map((h) => h.id);
    expect(ids.indexOf('h_gun')).toBeLessThan(ids.indexOf('h_overshoot'));
  });

  it('"Too slow" keeps quiet on a gun pass (air target designated within 2 km, IAS above stall + 10 %), not when really slow', () => {
    const p = new AircraftEntityC(1, 'f35a', 'blue');
    const drone = new AircraftEntityC(2, 'shahed136', 'red');
    p.position.set(0, 300, 0);
    drone.position.set(0, 300, -800);
    p.radar.designatedId = drone.id;
    p.warnings.add('speed_low');
    const s = { player: p, world: { getEntity: (id: number | null) => (id === drone.id ? drone : null) } } as unknown as MissionState;
    const stall = stallSpeedIas(p);
    p.flight.ias = stall * 1.2;
    expect(slowGunPass(p, s)).toBe(true);
    p.flight.ias = stall * 1.05; // too close to the stall: the hint stands
    expect(slowGunPass(p, s)).toBe(false);
    p.flight.ias = stall * 1.2;
    drone.position.set(0, 300, -3000); // nothing close: the hint stands
    expect(slowGunPass(p, s)).toBe(false);
    drone.position.set(0, 300, -800);
    p.radar.designatedId = null;
    expect(slowGunPass(p, s)).toBe(false);
  });
});
