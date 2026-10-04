/**
 * MISSIONS — Instant Action "Defend" (issue #49): the Wiri oil terminal's fuel tanks are friendly
 * ground targets on WIRI_TANKS, the enemy strike package (Flankers with KAB-500S bombs) can find
 * and destroy them, the player can't designate them, a player hit is friendly fire, losing too
 * many fails the mission and the debrief counts the tanks saved.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import { WIRI_TANKS } from '../src/core/sites';
import type { Difficulty } from '../src/core/types';
import type { MissionDef } from '../src/core/contracts';
import { buildInstantMissionSeeded, createMissionRunner, missionById, validateMission } from '../src/missions';
import { DEFEND_MIN_TANKS } from '../src/missions/content/instant';
import { flight, mission } from '../src/missions/content/common';
import type { MissionResultExt } from '../src/missions/runtime/resultExt';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createAiBrain } from '../src/ai';
import type { GroundTargetEntity } from '../src/sim/entities';
import { protectedSites } from '../src/hud/hmd/sites';
import { flatLand, harness, killGroup, shieldPlayer } from './missions-helpers';
import { terrainPadsFor } from '../src/missions';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';

/** A test-only mission whose protect objective is on an aircraft group (two unarmed friendly F-35As). */
const protectFlight = (): MissionDef =>
  mission({
    id: 'fx_protect_flight',
    kind: 'campaign',
    index: 1,
    title: 'Protect fixture',
    subtitle: 'test',
    timeOfDay: 'day',
    weather: 'clear',
    briefing: ['test'],
    recommendedLoadout: 'a2a_beast',
    allowedLoadouts: ['a2a_beast'],
    player: { x: -6000, z: -14000, altitude: 4500, heading: 70, speed: 240 },
    script: {
      groups: [
        flight('kiwi', 'f35a', 2, { x: 17000, z: -19000 }, 6000, 243, 200, 'bomber', { team: 'blue', callsign: 'Kiwi', fixedCount: true, unarmed: true, announce: false }),
        flight('hunters', 'mig29', 2, { x: 33000, z: -28000 }, 6500, 243, 260, 'interceptor', { task: { kind: 'attack_group', group: 'kiwi' } }),
      ],
      objectives: [
        { id: 'o_kiwi', kind: 'protect', group: 'kiwi', minSurvivors: 1, until: { kind: 'objective', id: 'o_hunters', state: 'complete' }, label: 'Protect Kiwi flight', primary: true },
        { id: 'o_hunters', kind: 'destroy', groups: ['hunters'], label: 'Splash the MiGs', primary: true },
      ],
    },
  });

const defend = (enemyCount = 4): MissionDef =>
  buildInstantMissionSeeded({ mode: 'defend', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount }, 49);

/** Real AI + combat; the player is parked far from the fight so only the enemy acts on the tanks. */
function realRun(def: MissionDef, difficulty: Difficulty = 'pilot') {
  const events = new EventBus();
  const diff = DIFFICULTIES[difficulty];
  const world = createSimWorld({ terrain: flatLand(10), difficulty: diff, events, combat: createCombatSystemSeeded(5) });
  const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty: diff, events });
  runner.setup(world, def.recommendedLoadout);
  const p = world.player!;
  // west of the city, beyond the strikers' sensors (a stealthy F-35 at ~20 km) but close enough
  // that their egress isn't credited as driven off the moment they turn for home
  const park = () => {
    p.position.set(-12000, 6000, 17000);
    p.health = p.maxHealth;
  };
  // the wingman (Viper 2) would defend Wiri on its own: take it out of the picture too
  for (const a of world.aircraft) if (a.team === 'blue' && a !== p) world.applyDamage(a, 1e6, null, 'gun');
  return { events, world, runner, park };
}

describe('missions: defend the Wiri oil terminal', () => {
  it('is reachable by id and valid', () => {
    expect(missionById('ia_defend_auckland')?.kind).toBe('instant');
    for (const seed of [1, 2, 3]) {
      const def = buildInstantMissionSeeded({ mode: 'defend', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 4 }, seed);
      expect(validateMission(def)).toEqual([]);
    }
  });

  it('spawns the fuel tanks on WIRI_TANKS as friendly, scenery-drawn targets', () => {
    const h = harness(defend());
    const tanks = h.world.ground.filter((g) => g.groupId === 'wiri');
    const fuel = WIRI_TANKS.filter((t) => t.fuel);
    expect(tanks.length).toBe(fuel.length);
    for (const t of fuel) {
      const e = tanks.find((g) => Math.hypot(g.position.x - t.x, g.position.z - t.z) < 1);
      expect(e, `tank at ${t.x},${t.z}`).toBeTruthy();
      expect(e!.team).toBe('blue');
      expect(e!.type).toBe('fuel');
      expect(e!.scenery).toBe(true);
    }
  });

  it('the strikers carry KAB-500S guided bombs', () => {
    const h = harness(defend());
    const strikers = h.world.aircraft.filter((a) => a.groupId === 'strikers');
    expect(strikers.length).toBeGreaterThanOrEqual(2);
    for (const s of strikers) {
      expect(s.stores.some((st) => st.weapon === 'gbu31' && st.count > 0)).toBe(true);
      expect(s.selectedWeapon).toBe('gbu31');
    }
  });

  it('the player cannot designate the tanks (TGT cycling, tap, auto-designation)', () => {
    const h = harness(defend());
    const w = h.world;
    const p = w.player!;
    const tankIds = new Set(w.ground.filter((g) => g.groupId === 'wiri').map((g) => g.id));
    // over the terminal, nose down, A/G weapon selected (radar in ground mode)
    p.position.set(7700, 2500, 20500);
    w.combat.selectWeapon(p, 'gbu31', w);
    const target = w.ground.find((g) => g.groupId === 'wiri')!;
    for (let i = 0; i < 120; i++) {
      w.step(1 / 60);
      p.position.set(7700, 2500, 20500);
      if (i % 20 === 0) {
        w.combat.cycleTarget(p, w);
        w.combat.designate(p, target.id, w);
        w.combat.designateNearestTo(p, new Vector3().subVectors(target.position, p.position), w);
      }
      expect(tankIds.has(p.radar.designatedId ?? -1)).toBe(false);
      expect(tankIds.has(p.radar.lockedId ?? -1)).toBe(false);
    }
  });

  it('a player hit on a tank is friendly fire: a loss, a check-fire call and no kill credit', () => {
    const h = harness(defend());
    const w = h.world;
    const tank = w.ground.find((g) => g.groupId === 'wiri')!;
    w.applyDamage(tank, 1e6, w.player!.id, 'gbu31');
    h.run(0.5);
    const r = h.runner.result(w);
    expect(r.friendlyLosses).toBe(1);
    expect(r.kills.ground).toBe(0);
    expect(h.of('hud:message').some((m) => m.text.startsWith('FRIENDLY FIRE'))).toBe(true);
    expect(h.of('radio').some((m) => /check fire/i.test(m.text))).toBe(true);
  });

  it('the first tank lost fails only the bonus: an amber BONUS FAILED, never a red OBJECTIVE FAILED (playtest 1.3-c)', () => {
    const h = harness(defend());
    const w = h.world;
    h.run(1);
    const tank = w.ground.find((g) => g.groupId === 'wiri')!;
    w.applyDamage(tank, 1e6, null, 'gbu31');
    h.run(1);
    const status = (id: string) => h.runner.objectives.find((o) => o.id === id)?.state;
    expect(status('o_all')).toBe('failed');
    expect(status('o_tanks')).toBe('active');
    const msgs = h.of('hud:message');
    expect(msgs.filter((m) => /OBJECTIVE FAILED/.test(m.text))).toEqual([]);
    const bonus = msgs.filter((m) => m.text === 'BONUS FAILED');
    expect(bonus.length).toBe(1);
    expect(bonus[0].tone).toBe('warn');
  });

  it('the HUD finds the Wiri tanks as the friendly site to defend, with the survivor count (playtest 1.3-b)', () => {
    const h = harness(defend());
    const w = h.world;
    h.run(1);
    const tanks = w.ground.filter((g) => g.groupId === 'wiri');
    let sites = protectedSites(h.runner, w, 'blue');
    expect(sites.length).toBe(1);
    expect(sites[0].group).toBe('wiri');
    expect(sites[0].label).toBe(`DEFEND ${tanks.length}/${tanks.length}`);
    const cx = tanks.reduce((a, t) => a + t.position.x, 0) / tanks.length;
    const cz = tanks.reduce((a, t) => a + t.position.z, 0) / tanks.length;
    expect(Math.hypot(sites[0].x - cx, sites[0].z - cz)).toBeLessThan(1);
    w.applyDamage(tanks[0], 1e6, null, 'gbu31');
    h.run(1);
    sites = protectedSites(h.runner, w, 'blue');
    expect(sites[0].label).toBe(`DEFEND ${tanks.length - 1}/${tanks.length}`);
    // the enemy's view: no site
    expect(protectedSites(h.runner, w, 'red').length).toBe(0);
    // protected aircraft (an escorted friendly flight) are drawn as friendlies, not sites
    const c = harness(protectFlight());
    c.run(1);
    expect(c.runner.objectives.some((o) => o.id === 'o_kiwi')).toBe(true);
    expect(c.world.aircraft.filter((a) => a.groupId === 'kiwi' && a.alive)).toHaveLength(2);
    expect(protectedSites(c.runner, c.world, 'blue').length).toBe(0);
  });

  it('parking 35 km away is no win: the raid between bomb passes is not "driven off" (playtest 2026-10-02, 2.3-a)', { timeout: 30_000 }, () => {
    const { world, runner } = realRun(defend());
    const p = world.player!;
    for (let i = 0; i < 60 * 480 && runner.state === 'running'; i++) {
      p.position.set(-35000, 13000, 35000);
      p.health = p.maxHealth;
      world.step(1 / 60);
      runner.update(world, 1 / 60);
    }
    // the strikers drop every bomb they carry; unopposed, that's more than Wiri can lose
    expect(runner.state).toBe('failed');
    expect(runner.objectives.find((o) => o.id === 'o_tanks')?.state).toBe('failed');
  });

  it('enemy strikers spread over the tanks and destroy them; too many lost fails the mission', { timeout: 30_000 }, () => {
    const { events, world, runner, park } = realRun(defend());
    const tankIds = new Set(world.ground.filter((g) => g.groupId === 'wiri').map((g) => g.id));
    const strikerIds = new Set(world.aircraft.filter((a) => a.groupId === 'strikers').map((a) => a.id));
    const killedBy = new Map<number, number>();
    const aimedAt = new Set<number>();
    events.on('destroyed', ({ entity, attackerId }) => {
      if (tankIds.has(entity.id) && attackerId !== null) killedBy.set(entity.id, attackerId);
    });
    events.on('munition:launch', ({ missile, targetId }) => {
      if (strikerIds.has(missile.shooterId) && targetId !== null) aimedAt.add(targetId);
    });
    for (let i = 0; i < 60 * 480 && runner.state === 'running'; i++) {
      park();
      world.step(1 / 60);
      runner.update(world, 1 / 60);
    }
    // bombs were aimed at more than one tank, and unopposed the raid wrecks enough to fail the mission
    expect([...aimedAt].filter((id) => tankIds.has(id)).length).toBeGreaterThan(1);
    expect(killedBy.size).toBeGreaterThan(tankIds.size - DEFEND_MIN_TANKS);
    for (const by of killedBy.values()) expect(strikerIds.has(by)).toBe(true);
    const left = world.ground.filter((g: GroundTargetEntity) => tankIds.has(g.id) && g.alive).length;
    const r = runner.result(world) as MissionResultExt;
    expect(r.saved).toEqual([{ label: 'Fuel tanks saved', saved: left, total: tankIds.size }]);
    expect(left).toBeLessThan(DEFEND_MIN_TANKS);
    expect(runner.state).toBe('failed');
    expect(r.success).toBe(false);
    expect(r.objectives.find((o) => o.id === 'o_tanks')?.state).toBe('failed');
  });

  it('shooting the strikers down wins once their bombs are down, and the debrief counts the tanks saved', () => {
    const h = harness(defend());
    h.run(5, () => shieldPlayer(h));
    expect(killGroup(h, 'strikers')).toBeGreaterThan(0);
    h.run(10, () => shieldPlayer(h));
    expect(h.runner.state).toBe('running'); // bombs already in the air get 20 s to land
    h.run(15, () => shieldPlayer(h));
    expect(h.runner.state).toBe('success');
    const r = h.runner.result(h.world) as MissionResultExt;
    expect(r.saved).toEqual([{ label: 'Fuel tanks saved', saved: 9, total: 9 }]);
    expect(r.objectives.find((o) => o.id === 'o_all')?.state).toBe('complete');
  });

  it('an escort pair does not stack on the escorted jet (the wingman flies on its own lead)', () => {
    const { world } = realRun(defend());
    const escorts = world.aircraft.filter((a) => a.groupId === 'escort');
    expect(escorts.length).toBe(2);
    let minSep = Infinity;
    for (let i = 0; i < 60 * 90; i++) {
      world.step(1 / 60);
      if (escorts.every((e) => e.alive)) minSep = Math.min(minSep, escorts[0].position.distanceTo(escorts[1].position));
    }
    expect(escorts.every((e) => e.alive)).toBe(true);
    expect(minSep).toBeGreaterThan(100);
  });
});

/**
 * Playtest 2026-10-02 (finding 1.1-a): a raid's "low" altitude is above sea level, and in a procedural
 * theatre (since removed, issue #73) a hill stood there: the strikers spawned inside it, died at t = 0 and
 * the mission won itself with no player input. Over Auckland's real terrain the raid must still fly.
 */
describe('defend: the raid survives the terrain', () => {
  // The run below uses one seed. In Auckland the raid comes from the fixed layout: the seed only
  // picks the escort type, so seeds 2 and 3 used to fly the same strikers over the same terrain.
  // If the raid's geometry ever becomes seeded, this fails: loop the run below over several seeds again.
  it('auckland: the strikers group (type, count, spawn point, route) is the same for every seed', () => {
    const strikers = (seed: number) =>
      buildInstantMissionSeeded({ mode: 'defend', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 4 }, seed).script.groups.find((g) => g.id === 'strikers');
    expect(strikers(1)).toBeDefined();
    for (const seed of [2, 3, 4, 5, 6, 7, 8]) expect(strikers(seed), `seed ${seed}`).toEqual(strikers(1));
  });

  for (const theater of ['auckland'] as const) {
    it(`${theater}: the strikers spawn above the ground and are still flying 60 s in`, { timeout: 60_000 }, () => {
      for (const seed of [1]) {
        const def = buildInstantMissionSeeded({ mode: 'defend', theater, timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 4 }, seed);
        const terrain = new TerrainQueryImpl(runSync(generateTerrain({ theater, seed: def.seed, resolution: 512, features: allFeatures(theater, []), pads: terrainPadsFor(def) })));
        const events = new EventBus();
        const diff = DIFFICULTIES.pilot;
        const world = createSimWorld({ terrain, difficulty: diff, events, combat: createCombatSystemSeeded(5) });
        const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty: diff, events });
        runner.setup(world, def.recommendedLoadout);
        const strikers = world.aircraft.filter((a) => a.groupId === 'strikers');
        expect(strikers.length).toBeGreaterThan(0);
        for (const a of strikers) expect(a.position.y - terrain.surfaceHeightAt(a.position.x, a.position.z), `seed ${seed} ${a.callsign} AGL at spawn`).toBeGreaterThan(50);
        const p = world.player!;
        for (let i = 0; i < 60 * 60; i++) {
          // the player and the wingman sit out the fight, far from the raid
          p.position.set(-36000, 9000, 36000);
          p.health = p.maxHealth;
          world.step(1 / 60);
          runner.update(world, 1 / 60);
        }
        expect(strikers.filter((a) => !a.alive).map((a) => a.callsign), `seed ${seed} terrain ${def.seed}: strikers lost by 60 s`).toEqual([]);
      }
    });
  }
});
