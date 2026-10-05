/**
 * A Stroll in the Park: the player can box every kind of civil traffic that moves (AeroFlop airliners, container ships,
 * cruise liners and a crude carrier), finds the airliners from the tour's start (their ADS-B, with the radar off) and can
 * shoot them down with the gun or an AIM-120, while the harbour ferries stay scenery in every mission and mode: never a sim
 * entity, so never on a sensor and never targetable (render/traffic/HarbourFerries.ts).
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import { createAiBrain } from '../src/ai';
import { CAMPAIGNS, TRAINING, buildInstantMissionSeeded, createMissionRunner } from '../src/missions';
import type { InstantActionOptions, MissionDef } from '../src/core/contracts';
import type { LoadoutId } from '../src/core/types';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { setQuatFromHPR } from '../src/sim/flight/attitude';
import type { AircraftEntity, Entity } from '../src/sim/entities';
import { FERRY_LENGTH } from '../src/render/traffic/ferryRoutes';
import { VESSEL_DATA } from '../src/sim/damage/tables';
import { FlatTerrain } from './combat-helpers';

const DT = 1 / 60;

const instant = (mode: InstantActionOptions['mode']) =>
  buildInstantMissionSeeded({ mode, theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 2 }, 5);

function sortie(def: MissionDef, loadout: LoadoutId = def.recommendedLoadout) {
  const events = new EventBus();
  const world = createSimWorld({ terrain: new FlatTerrain(-20), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(1) });
  const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty: DIFFICULTIES.pilot, events });
  runner.setup(world, loadout);
  const tick = (seconds: number) => {
    for (let i = 0; i < seconds * 60; i++) {
      world.step(DT);
      runner.update(world, DT);
    }
  };
  return { world, runner, tick };
}

describe('A Stroll in the Park: civil targets', () => {
  it('every merchant class sails (container, cruise, tanker) and the player can designate each, and an airliner', () => {
    const m = sortie(instant('stroll'));
    m.tick(40); // the first departure is off the runway
    const ships = m.world.ground.filter((g) => g.type === 'ship' && g.team === 'neutral');
    expect(new Set(ships.map((g) => g.vessel))).toEqual(new Set(['container', 'cruise', 'tanker']));
    const airliner = m.world.aircraft.find((a) => a.civil && a.alive)!;
    expect(airliner).toBeTruthy();
    const targets: Entity[] = [airliner, ...['container', 'cruise', 'tanker'].map((v) => ships.find((g) => g.vessel === v)!)];
    const p = m.world.player!;
    for (const t of targets) {
      // 3 km short of it, nose on, where the player's own sensors track it
      const at = t.position.clone();
      const from = at.clone().add(new Vector3(-3000, 0, 0));
      from.y = Math.max(600, at.y);
      p.position.copy(from);
      setQuatFromHPR(p.quaternion, Math.PI / 2, Math.atan2(at.y - from.y, 3000), 0);
      m.tick(1);
      m.world.combat.designate(p, t.id, m.world);
      expect(p.radar.designatedId, `${t.kind} ${t.id}`).toBe(t.id);
    }
    m.runner.dispose?.();
  });

  it("finds the airliners from the tour's start with the radar off: their ADS-B boxes them and TGT steps to one", () => {
    const m = sortie(instant('stroll'));
    const p = m.world.player!;
    const start = p.position.clone();
    expect(p.radar.emitting).toBe(false);
    for (let t = 0; t < 60; t++) {
      p.position.copy(start);
      m.tick(1);
    }
    const civil = m.world.aircraft.filter((a) => a.civil && a.alive);
    expect(civil.length).toBeGreaterThan(1);
    // beyond the DAS (15 km) and the gun's ACM radar (18.5 km), yet every airliner is a contact
    expect(Math.min(...civil.map((a) => a.position.distanceTo(p.position)))).toBeGreaterThan(15_000);
    for (const a of civil) expect(p.radar.contacts.some((c) => c.id === a.id), a.callsign).toBe(true);
    m.world.combat.cycleTarget(p, m.world);
    expect(civil.map((a) => a.id)).toContain(p.radar.designatedId);
    m.runner.dispose?.();
  });

  it('wartime airliners have no ADS-B: only an onboard sensor tracks them', () => {
    const m = sortie(instant('dogfight'));
    const p = m.world.player!;
    m.world.combat.setRadarEmitting(p, false, m.world);
    m.tick(40);
    const civil = m.world.aircraft.filter((x) => x.civil && x.alive);
    expect(civil.length).toBeGreaterThan(0);
    for (const a of civil) {
      expect(a.civil!.adsb).toBeFalsy();
      // radar off: past the DAS's 15 km nothing tracks it
      if (a.position.distanceTo(p.position) > 16_000) expect(p.radar.contacts.some((c) => c.id === a.id)).toBe(false);
    }
    m.runner.dispose?.();
  });

  /** Fly 400 m in trail of the airliner, nose on it, matching its velocity. */
  function trail(p: AircraftEntity, a: AircraftEntity, back: number): void {
    const dir = a.velocity.clone().normalize();
    p.position.copy(a.position).addScaledVector(dir, -back);
    p.velocity.copy(a.velocity);
    const rel = a.position.clone().sub(p.position);
    setQuatFromHPR(p.quaternion, Math.atan2(rel.x, -rel.z), Math.atan2(rel.y, Math.hypot(rel.x, rel.z)), 0);
    p.health = p.maxHealth;
  }

  it('the clean jet guns an airliner down', () => {
    const m = sortie(instant('stroll'));
    m.tick(40);
    const p = m.world.player!;
    const a = m.world.aircraft.find((x) => x.civil && x.alive && x.position.y > 150)!;
    expect(a).toBeTruthy();
    expect(p.selectedWeapon).toBe('gun');
    for (let i = 0; i < 60 * 6 && a.alive; i++) {
      trail(p, a, 400);
      p.input.fireGun = true;
      m.tick(1 / 60);
    }
    p.input.fireGun = false;
    expect(a.alive).toBe(false);
    m.runner.dispose?.();
  });

  it('an AIM-120 shot down the ADS-B track kills an airliner', () => {
    const m = sortie(instant('stroll'), 'a2a_stealth');
    m.tick(40);
    const p = m.world.player!;
    const a = m.world.aircraft.find((x) => x.civil && x.alive && x.position.y > 150)!;
    expect(a).toBeTruthy();
    m.world.combat.selectWeapon(p, 'aim120', m.world);
    trail(p, a, 6000);
    m.tick(1 / 60);
    m.world.combat.designate(p, a.id, m.world);
    let fired = false;
    for (let i = 0; i < 60 * 40 && a.alive; i++) {
      trail(p, a, 6000);
      if (!fired) fired = !!m.world.combat.fire(p, m.world, 'aim120', a.id) || m.world.missiles.some((x) => x.alive && x.targetId === a.id);
      m.tick(1 / 60);
    }
    expect(fired).toBe(true);
    expect(a.alive).toBe(false);
    m.runner.dispose?.();
  });

  it('no mission or mode makes a harbour ferry a sim entity', () => {
    const defs: MissionDef[] = [
      ...(['stroll', 'dogfight', 'sam_gauntlet', 'strike', 'defend'] as const).map(instant),
      ...TRAINING,
      ...CAMPAIGNS.flatMap((c) => c.missions),
    ];
    const smallest = Math.min(...Object.values(VESSEL_DATA).map((v) => v.length));
    expect(smallest).toBeGreaterThan(FERRY_LENGTH * 3);
    for (const def of defs) {
      const m = sortie(def);
      for (const g of m.world.ground) {
        // (a civil train, #146, is a neutral ground entity too, but no ship)
        if (g.team === 'neutral' && g.type !== 'train') expect(['container', 'cruise', 'tanker'], `${def.id}: ${g.name}`).toContain(g.vessel);
      }
      m.runner.dispose?.();
    }
  });
});
