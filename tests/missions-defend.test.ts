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
import type { MissionResultExt } from '../src/missions/runtime/resultExt';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createAiBrain } from '../src/ai';
import type { GroundTargetEntity } from '../src/sim/entities';
import { flatLand, harness, killGroup, shieldPlayer } from './missions-helpers';

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
  it('is reachable by id and valid in every theatre', () => {
    expect(missionById('ia_defend_auckland')?.kind).toBe('instant');
    for (const theater of ['auckland', 'desert', 'islands', 'mountains', 'arctic'] as const) {
      const def = buildInstantMissionSeeded({ mode: 'defend', theater, timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 4 }, 1);
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

  it('enemy strikers spread over the tanks and destroy them; too many lost fails the mission', () => {
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
