/**
 * The escorted oil tanker (issue #80): a 250 m crude carrier ('tanker' VesselClass) that a mission
 * flags to take two bomb / missile hits (GroundTargetDef.hitsToSink). One hit: burning, a little
 * slower, still sailing her path. Two: she sinks and the protect objective on her fails the mission.
 * A player hit is one of the two (check-fire call); a player sinking her is a civilian loss. Every
 * other civil ship keeps #19's one-hit rule.
 */
import { describe, expect, it } from 'vitest';
import { Box3, Vector3 } from 'three';
import { EventBus, type GameEventMap } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import type { MissionDef } from '../src/core/contracts';
import type { VesselClass } from '../src/core/types';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createAiBrain } from '../src/ai';
import { VESSEL_DATA, VESSEL_HIT_SPEED_FACTOR } from '../src/sim/damage/tables';
import type { SimWorld } from '../src/sim/api';
import type { GroundTargetEntity } from '../src/sim/entities';
import { createMissionRunner, missionById } from '../src/missions';
import { emptyScript, type MissionScript } from '../src/missions/schema';
import { validateMission } from '../src/missions/validate';
import type { MissionResultExt } from '../src/missions/runtime/resultExt';
import { vesselCounters } from '../src/hud/hmd/escort';
import { SHIP_DIMS } from '../src/render/visuals/shipMotion';
import { getGroundPrototype } from '../src/render/models/ground';
import { framingDistance } from '../src/render/targetCam/pose';
import { FlatTerrain } from './combat-helpers';

const DT = 1 / 60;

function seaWorld(seed = 1): SimWorld {
  return createSimWorld({ terrain: new FlatTerrain(-20), difficulty: DIFFICULTIES.pilot, events: new EventBus(), combat: createCombatSystemSeeded(seed) });
}

function run(world: SimWorld, seconds: number, each?: () => boolean | void): void {
  for (let i = 0; i < seconds * 60; i++) {
    world.step(DT);
    if (each?.()) return;
  }
}

/** A tanker sailing north from (0, z0) at 6 m/s. */
function spawnTanker(w: SimWorld, hitsToSink = 2, z0 = -4000): GroundTargetEntity {
  return w.spawnGround({
    type: 'ship',
    team: 'neutral',
    vessel: 'tanker',
    hitsToSink,
    position: new Vector3(0, 0, z0),
    path: [new Vector3(0, 0, z0 - 20_000)],
    speed: 6,
    name: 'MT Marsden Point',
    groupId: 'tanker',
  });
}

/* ───────────────────────── sim: the two-hit rule ───────────────────────── */

describe('tanker damage (sim)', { timeout: 30_000 }, () => {
  it('one hit: damaged, burning, a little slower and still sailing; the second hit sinks her', () => {
    const w = seaWorld();
    const t = spawnTanker(w);
    expect(t.vessel).toBe('tanker');
    expect(t.radius).toBe(VESSEL_DATA.tanker.length / 2);
    expect(t.hitsToSink).toBe(2);
    const hits: GameEventMap['vessel:hit'][] = [];
    w.events.on('vessel:hit', (e) => hits.push(e));
    run(w, 2);
    w.applyDamage(t, 40, null, 'gbu31'); // even a glancing blast is one whole hit
    expect(t.alive).toBe(true);
    expect(t.hits).toBe(1);
    expect(t.health).toBeCloseTo(t.maxHealth / 2, 6);
    expect(t.speed).toBeCloseTo(6 * VESSEL_HIT_SPEED_FACTOR, 6);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ship: t, hits: 1, hitsToSink: 2, attackerId: null, weapon: 'gbu31' });
    const z = t.position.z;
    run(w, 10);
    expect(t.alive).toBe(true);
    expect(z - t.position.z).toBeCloseTo(10 * 6 * VESSEL_HIT_SPEED_FACTOR, 0); // still under way, slower
    w.applyDamage(t, 40, null, 'kab500');
    expect(t.alive).toBe(false);
    expect(t.hits).toBe(2);
    expect(hits).toHaveLength(2);
    expect(hits[1].hits).toBe(2);
    run(w, 1);
    expect(t.velocity.length()).toBe(0);
  });

  it('a hit from the player counts the same; gun damage still only accumulates', () => {
    const w = seaWorld();
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 3000, 10_000), heading: 0, speed: 230, loadout: 'strike_sdb2' });
    const t = spawnTanker(w);
    run(w, 1);
    for (let i = 0; i < 40; i++) w.applyDamage(t, 20, p.id, 'gun');
    expect(t.hits).toBe(0);
    expect(t.health).toBe(t.maxHealth - 800);
    w.applyDamage(t, 5, p.id, 'gbu53');
    expect(t.alive).toBe(true);
    expect(t.hits).toBe(1);
    expect(t.health).toBe(t.maxHealth / 2); // the hit takes her to half, not half on top of the gun damage
    w.applyDamage(t, 5, p.id, 'gbu53');
    expect(t.alive).toBe(false);
    expect(p.kills).toBe(0); // never a kill
  });

  it('container ships and cruise liners still sink to one hit, even next to the tanker', () => {
    const w = seaWorld();
    const t = spawnTanker(w);
    for (const [i, v] of (['container', 'cruise'] as VesselClass[]).entries()) {
      const s = w.spawnGround({ type: 'ship', team: 'neutral', vessel: v, position: new Vector3(3000 + i * 1000, 0, -4000), heading: 0, name: v, groupId: 'civil-ship' });
      expect(s.hitsToSink).toBe(1);
      w.applyDamage(s, 2, null, 'gbu39');
      expect(s.alive).toBe(false);
      expect(s.hits).toBe(0);
    }
    expect(t.alive).toBe(true);
    // hitsToSink is only for civil ships: a corvette keeps its plain hit points
    const c = w.spawnGround({ type: 'ship', team: 'red', hitsToSink: 2, position: new Vector3(-3000, 0, -4000) });
    expect(c.hitsToSink).toBe(1);
  });

  it('a real JDAM released on the tanker is one hit, not a sinking', () => {
    const w = seaWorld(4);
    const t = w.spawnGround({ type: 'ship', team: 'neutral', vessel: 'tanker', hitsToSink: 2, position: new Vector3(0, 0, -8_000), heading: 90, name: 'MT Marsden Point' });
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 6_000, 0), heading: 0, speed: 250, loadout: 'strike_stealth' });
    run(w, 1);
    w.combat.designate(p, t.id, w);
    const ends: GameEventMap['munition:end'][] = [];
    w.events.on('munition:end', (e) => ends.push(e));
    w.combat.fire(p, w, 'gbu31', t.id);
    run(w, 90, () => ends.length > 0);
    expect(ends).toHaveLength(1);
    expect(t.hits).toBe(1);
    expect(t.alive).toBe(true);
  });
});

/* ───────────────────────── mission: protect a moving tanker ───────────────────────── */

function tankerMission(): MissionDef {
  const base = missionById('c06')!;
  const script: MissionScript = {
    ...emptyScript(),
    ground: [
      { id: 'tk', group: 'tanker', type: 'ship', team: 'neutral', vessel: 'tanker', hitsToSink: 2, name: 'MT Marsden Point', x: 4000, z: -6000, path: [{ x: 4000, z: -26_000 }], speed: 6 },
      { id: 'cv', group: 'corvette', type: 'ship', x: 12_000, z: -20_000, name: 'Corvette' },
    ],
    objectives: [
      { id: 'protect', kind: 'protect', group: 'tanker', label: 'Protect the tanker', primary: true },
      { id: 'kill', kind: 'destroy', groups: ['corvette'], label: 'Sink the corvette', primary: true },
    ],
  };
  return { ...base, id: 't_tanker', script };
}

function setup(def = tankerMission()) {
  const events = new EventBus();
  const world = createSimWorld({ terrain: new FlatTerrain(-20), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(1) });
  const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty: DIFFICULTIES.pilot, events });
  runner.setup(world, def.recommendedLoadout);
  const radio: { from: string; text: string }[] = [];
  const hud: string[] = [];
  events.on('radio', (e) => radio.push({ from: e.from, text: e.text }));
  events.on('hud:message', (e) => hud.push(e.text));
  const tick = (seconds: number) => {
    for (let i = 0; i < seconds * 60 && runner.state === 'running'; i++) {
      world.step(DT);
      runner.update(world, DT);
    }
  };
  const tanker = world.ground.find((g) => g.vessel === 'tanker')!;
  const protect = () => runner.objectives.find((o) => o.id === 'protect')!;
  return { world, runner, radio, hud, tick, tanker, protect };
}

describe('protecting the tanker (mission)', { timeout: 30_000 }, () => {
  it('the mission validates, and the tanker spawns as a neutral two-hit crude carrier on her path', () => {
    expect(validateMission(tankerMission())).toEqual([]);
    const m = setup();
    expect(m.tanker.team).toBe('neutral');
    expect(m.tanker.hitsToSink).toBe(2);
    expect(m.tanker.name).toBe('MT Marsden Point');
    // the random civil traffic keeps the one-hit rule and has no tankers
    const others = m.world.ground.filter((g) => g.vessel && g !== m.tanker);
    expect(others.length).toBeGreaterThan(0);
    for (const s of others) expect(s.hitsToSink).toBe(1);
    m.runner.dispose?.();
  });

  it('one enemy hit: still sailing, objective still active, the master calls it; two hits: sunk, objective and mission failed', () => {
    const m = setup();
    m.tick(5);
    expect(m.protect().state).toBe('active');
    const z0 = m.tanker.position.z;
    expect(z0).toBeLessThan(-6000 + 20); // under way
    m.world.applyDamage(m.tanker, 300, null, 'kab500');
    m.tick(10);
    expect(m.tanker.alive).toBe(true);
    expect(m.tanker.position.z).toBeLessThan(z0 - 40);
    expect(m.protect().state).toBe('active');
    expect(m.runner.state).toBe('running');
    expect(m.hud).toContain('TANKER HIT 1/2');
    expect(m.radio.some((r) => r.from === 'MT Marsden Point' && /we're hit/i.test(r.text))).toBe(true);
    expect(m.radio.some((r) => /check fire/i.test(r.text))).toBe(false); // not the player's
    m.world.applyDamage(m.tanker, 300, null, 'kab500');
    m.tick(3);
    expect(m.tanker.alive).toBe(false);
    expect(m.protect().state).toBe('failed');
    expect(m.runner.state).toBe('failed');
    expect(m.radio.some((r) => r.from === 'MT Marsden Point' && /abandon ship/i.test(r.text))).toBe(true);
    const r = m.runner.result(m.world) as MissionResultExt;
    expect(r.success).toBe(false);
    expect(r.civilianKills ?? 0).toBe(0); // the enemy sank her, not the player
    m.runner.dispose?.();
  });

  it('a player bomb is one of the two hits (check fire); a player sinking her is a civilian loss', () => {
    const m = setup();
    m.tick(2);
    const p = m.world.player!;
    m.world.applyDamage(m.tanker, 300, p.id, 'gbu53');
    m.tick(4);
    expect(m.tanker.alive).toBe(true);
    expect(m.tanker.hits).toBe(1);
    expect(m.hud).toContain('CHECK FIRE: TANKER HIT');
    expect(m.radio.some((r) => /check fire/i.test(r.text) && r.text.includes('tanker MT Marsden Point'))).toBe(true);
    expect((m.runner.result(m.world) as MissionResultExt).civilianKills ?? 0).toBe(0);
    m.world.applyDamage(m.tanker, 300, p.id, 'gbu53');
    m.tick(3);
    expect(m.tanker.alive).toBe(false);
    expect(m.hud).toContain('CIVILIAN SHIP DESTROYED');
    expect(m.runner.state).toBe('failed');
    const r = m.runner.result(m.world) as MissionResultExt;
    expect(r.civilianKills).toBe(1);
    expect(r.civilianShipKills).toBe(1);
    m.runner.dispose?.();
  });

  it('sinking the corvette with the tanker afloat (even hit once) wins', () => {
    const m = setup();
    m.tick(2);
    m.world.applyDamage(m.tanker, 300, null, 'kab500');
    const cv = m.world.ground.find((g) => g.groupId === 'corvette')!;
    m.world.applyDamage(cv, 10_000, m.world.player!.id, 'gbu53');
    m.tick(3);
    expect(m.protect().state).toBe('complete');
    expect(m.runner.state).toBe('success');
    m.runner.dispose?.();
  });

  it('validation: hitsToSink needs a vessel class', () => {
    const def = tankerMission();
    def.script.ground[1] = { ...def.script.ground[1], hitsToSink: 2 };
    expect(validateMission(def).some((e) => /hitsToSink/.test(e))).toBe(true);
  });
});

/* ───────────────────────── HUD counter, model, framing ───────────────────────── */

describe('tanker on screen', () => {
  it('HUD hit counter: TANKER 0/2 → 1/2 → SUNK; ordinary civil ships get none', () => {
    const w = seaWorld();
    w.spawnGround({ type: 'ship', team: 'neutral', vessel: 'container', position: new Vector3(3000, 0, -4000), name: 'MV Kōtuku Trader' });
    expect(vesselCounters(w)).toHaveLength(0);
    const t = spawnTanker(w);
    expect(vesselCounters(w).map((c) => [c.text, c.tone])).toEqual([['TANKER 0/2', 'main']]);
    w.applyDamage(t, 50, null, 'gbu31');
    expect(vesselCounters(w).map((c) => [c.text, c.tone])).toEqual([['TANKER 1/2', 'warn']]);
    w.applyDamage(t, 50, null, 'gbu31');
    expect(vesselCounters(w).map((c) => [c.text, c.tone])).toEqual([['TANKER SUNK', 'danger']]);
  });

  it('the crude-carrier model matches its hull dimensions and frames like the other merchant ships', () => {
    const d = SHIP_DIMS.tanker;
    expect(d.length).toBe(VESSEL_DATA.tanker.length);
    expect(d.beam).toBe(VESSEL_DATA.tanker.beam);
    const proto = getGroundPrototype('ship', 'green', 'tanker');
    expect(proto.radius).toBe(d.length / 2);
    expect(proto.lights.some((l) => l.kind === 'way')).toBe(true); // nav lights
    expect(proto.lights.some((l) => l.kind === 'anchor')).toBe(true);
    const box = new Box3().setFromObject(proto.root);
    expect(box.max.z - box.min.z).toBeGreaterThan(d.length - 2);
    expect(box.max.z - box.min.z).toBeLessThan(d.length + 4);
    expect(box.max.x - box.min.x).toBeLessThan(d.beam * 1.1);
    expect(box.max.y).toBeLessThanOrEqual(d.height + 1);
    expect(box.max.y).toBeGreaterThan(d.height - 6);
    const t = seaWorld().spawnGround({ type: 'ship', team: 'neutral', vessel: 'tanker', position: new Vector3(), name: 'MT' });
    expect(framingDistance(t)).toBeGreaterThan(d.length);
  });
});
