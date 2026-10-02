/**
 * IRGC Navy fast boats (issue #79, sim/boats.ts): the suicide boat chases a moving ship and rams it
 * (one hit), the missile boat closes to its launch point, counts down and fires a Kowsar that scores
 * one hit (nothing if it is killed during the countdown), the air-defence boat is a SAM that moves
 * and still fires (radar SAM + SA-18s) and an AGM-88G homes on its radar, a GBU-53/B hits a weaving
 * boat, and no boat ever leaves the water.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus, type GameEventMap } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import type { SimWorld, TerrainQuery } from '../src/sim/api';
import type { AircraftEntity, GroundTargetEntity, MissileEntity } from '../src/sim/entities';
import { BOAT_COUNTDOWN, BOAT_SPEED, isKowsar } from '../src/sim/boats';
import { SAM_DATA } from '../src/sim/sam/samData';
import { emptyScript } from '../src/missions/schema';
import { validateMission } from '../src/missions/validate';
import { framingDistance } from '../src/render/targetCam/pose';
import { getGroundPrototype } from '../src/render/models/ground';
import { getSamPrototype } from '../src/render/models/sams';
import { groundHudName, samHudName } from '../src/missions/runtime/names';
import { FlatTerrain } from './combat-helpers';
import type { MissionDef } from '../src/core/contracts';
import { missionById } from '../src/missions';
import { PerspectiveCamera } from 'three';
import type { FrameContext } from '../src/core/contracts';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../src/core/data';
import { GroundTargetEntity as GroundEntity } from '../src/sim/entities';
import { makeBoat } from '../src/sim/boats';
import { createHud } from '../src/hud/Hud';
import { buildMock } from '../src/hud/dev/mockWorld';
import { installPath2D, makeFakeCanvas } from '../src/hud/dev/fakeCanvas';

const DEG = Math.PI / 180;
const DT = 1 / 60;

/** Sea everywhere (20 m deep) except the walls, which are land 30 m high. */
class SeaTerrain extends FlatTerrain {
  override isWater(x = 0, z = 0): boolean {
    return this.heightAt(x, z) < 0;
  }
}

type Island = { x0: number; x1: number; z0: number; z1: number };

function seaWorld(seed = 1, islands: Island[] = []): SimWorld {
  const terrain: TerrainQuery = new SeaTerrain(
    -20,
    islands.map((i) => ({ ...i, h: 30 })),
  );
  return createSimWorld({ terrain, difficulty: DIFFICULTIES.pilot, events: new EventBus(), combat: createCombatSystemSeeded(seed) });
}

function run(world: SimWorld, seconds: number, each?: () => boolean | void): void {
  for (let i = 0; i < seconds * 60; i++) {
    world.step(DT);
    if (each?.()) return;
  }
}

/** A two-hit tanker sailing north from (x, z0) at 6 m/s. */
function tanker(w: SimWorld, x = 0, z0 = -4000, heading = 0): GroundTargetEntity {
  const dx = Math.sin(heading) * 30_000;
  const dz = -Math.cos(heading) * 30_000;
  return w.spawnGround({
    type: 'ship',
    team: 'neutral',
    vessel: 'tanker',
    hitsToSink: 2,
    position: new Vector3(x, 0, z0),
    path: [new Vector3(x + dx, 0, z0 + dz)],
    speed: 6,
    name: 'MT Marsden Point',
    groupId: 'tanker',
  });
}

/** A player F-35 parked far out of the fight (only there to hear the radio). */
function bystander(w: SimWorld, at = new Vector3(-30_000, 8_000, 30_000)): AircraftEntity {
  return w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: at, heading: 0, speed: 250, loadout: 'a2a_stealth' });
}

function record<K extends keyof GameEventMap>(w: SimWorld, name: K): GameEventMap[K][] {
  const out: GameEventMap[K][] = [];
  w.events.on(name, (e) => out.push(e));
  return out;
}

/* ───────────────────────── suicide boat ───────────────────────── */

describe('suicide boat', { timeout: 30_000 }, () => {
  it('chases a moving tanker, weaving, and its contact is one hit on her; then the boat is gone', () => {
    const w = seaWorld();
    const t = tanker(w);
    const boat = w.spawnGround({ type: 'suicide_boat', team: 'red', position: new Vector3(4000, 0, -3000), boat: { chaseId: t.id } });
    expect(boat.boat?.chaseId).toBe(t.id);
    expect(boat.boat?.speed).toBe(BOAT_SPEED);
    const hits = record(w, 'vessel:hit');
    let maxOff = 0;
    run(w, 400, () => {
      if (boat.alive && boat.velocity.lengthSq() > 1) {
        const course = Math.atan2(boat.velocity.x, -boat.velocity.z);
        const bearing = Math.atan2(t.position.x - boat.position.x, -(t.position.z - boat.position.z));
        const off = Math.abs(Math.atan2(Math.sin(course - bearing), Math.cos(course - bearing)));
        if (boat.position.distanceTo(t.position) > 600) maxOff = Math.max(maxOff, off);
      }
      return !boat.alive;
    });
    expect(boat.alive).toBe(false);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ship: t, hits: 1, attackerId: boat.id, weapon: 'collision' });
    expect(t.alive).toBe(true);
    expect(t.hits).toBe(1);
    // it weaved about its intercept course (so a GPS bomb's fixed aim point misses it)
    expect(maxOff).toBeGreaterThan(12 * DEG);
    run(w, 30);
    expect(t.hits).toBe(1); // a dead boat does nothing more
  });
});

/* ───────────────────────── missile boat ───────────────────────── */

function missileBoat(w: SimWorld, t: GroundTargetEntity, at: Vector3, missiles = 1): GroundTargetEntity {
  return w.spawnGround({ type: 'missile_boat', team: 'red', position: at, boat: { strike: { targetId: t.id, range: 6000, countdown: BOAT_COUNTDOWN, missiles } } });
}

describe('missile boat', { timeout: 30_000 }, () => {
  it('reaches its launch point, counts down (radio + HUD), launches a Kowsar that scores one hit', () => {
    const w = seaWorld(2);
    const t = tanker(w);
    bystander(w);
    const boat = missileBoat(w, t, new Vector3(7500, 0, -5000));
    const radio = record(w, 'radio');
    const hud = record(w, 'hud:message');
    const launches = record(w, 'munition:launch');
    const hits = record(w, 'vessel:hit');
    let countdownAt = -1;
    let launchedAt = -1;
    run(w, 200, () => {
      if (countdownAt < 0 && boat.boat!.strike!.timer >= 0) {
        countdownAt = w.time;
        // stopped at the launch point, within range of the tanker
        expect(boat.position.distanceTo(t.position)).toBeLessThanOrEqual(6000 + 50);
      }
      if (countdownAt >= 0 && launchedAt < 0) {
        if (launches.length) launchedAt = w.time;
        else expect(boat.velocity.length()).toBe(0); // lies stopped while it counts down
      }
      return hits.length > 0;
    });
    expect(countdownAt).toBeGreaterThan(0);
    expect(launchedAt - countdownAt).toBeCloseTo(BOAT_COUNTDOWN, 0);
    expect(launches).toHaveLength(1);
    expect(launches[0].shooter).toBe(boat);
    expect(launches[0].missile.def.id).toBe('kowsar');
    expect(isKowsar(launches[0].missile)).toBe(true);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ ship: t, hits: 1, attackerId: boat.id, weapon: 'kowsar' });
    expect(t.alive).toBe(true);
    // the warning: a radio call with the bearing, then a HUD countdown
    expect(radio.some((r) => /missile boat, launch imminent, bearing \d{3}/i.test(r.text))).toBe(true);
    expect(hud.some((h) => h.text === `MISSILE BOAT LAUNCH ${BOAT_COUNTDOWN}`)).toBe(true);
    expect(hud.some((h) => h.text === 'MISSILE BOAT LAUNCH 1')).toBe(true);
    // one missile carried: nothing more
    run(w, 60);
    expect(t.hits).toBe(1);
  });

  it('killed during the countdown: no launch, no hit', () => {
    const w = seaWorld(2);
    const t = tanker(w);
    const p = bystander(w);
    const boat = missileBoat(w, t, new Vector3(7500, 0, -5000), 2);
    const launches = record(w, 'munition:launch');
    const hits = record(w, 'vessel:hit');
    run(w, 200, () => boat.boat!.strike!.timer >= 0 && boat.boat!.strike!.timer < BOAT_COUNTDOWN - 12);
    expect(boat.boat!.strike!.timer).toBeGreaterThan(0);
    w.applyDamage(boat, 30, p.id, 'gun');
    w.applyDamage(boat, 30, p.id, 'gun');
    expect(boat.alive).toBe(false);
    run(w, 120);
    expect(launches.filter((l) => l.missile.def.id === 'kowsar')).toHaveLength(0);
    expect(hits).toHaveLength(0);
    expect(t.hits).toBe(0);
  });

  it('the Kowsar is never a target: it is not a sensor contact and not hostile to anyone', () => {
    const w = seaWorld(4);
    const t = tanker(w);
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(9000, 3000, -2000), heading: 0, speed: 250, loadout: 'a2a_stealth' });
    missileBoat(w, t, new Vector3(6500, 0, -4000));
    let kowsar: MissileEntity | null = null;
    let seen = false;
    run(w, 120, () => {
      kowsar = w.missiles.find((m) => m.alive && isKowsar(m)) ?? null;
      if (!kowsar) return false;
      seen = true;
      expect(w.hostilesOf('blue')).not.toContain(kowsar);
      expect(p.radar.contacts.some((c) => c.id === kowsar!.id)).toBe(false);
      return false;
    });
    expect(seen).toBe(true);
  });
});

/* ───────────────────────── air-defence boat ───────────────────────── */

describe('air-defence boat (moving SAM)', { timeout: 60_000 }, () => {
  it('sails its route and still fires at the player (radar SAM and SA-18s)', () => {
    const w = seaWorld(5);
    const ad = w.spawnSam({ type: 'ad_boat', team: 'red', position: new Vector3(0, 0, 0), known: true, boat: { path: [new Vector3(20_000, 0, 0)] } });
    expect(ad.boat).toBeDefined();
    expect(ad.position.y).toBe(0);
    // a beast-mode jet running in at 2,500 m from 10 km
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 2500, 10_000), heading: 0, speed: 200, loadout: 'strike_beast' });
    const launches: { munition: string; at: Vector3 }[] = [];
    w.events.on('munition:launch', (e) => {
      if (e.shooter === ad) launches.push({ munition: e.missile.def.id, at: ad.position.clone() });
    });
    const start = ad.position.clone();
    run(w, 60, () => {
      p.health = p.maxHealth; // keep the target alive
      return launches.some((l) => l.munition === 'm_9m330') && launches.some((l) => l.munition === 'm_igla');
    });
    expect(ad.position.distanceTo(start)).toBeGreaterThan(100);
    expect(ad.velocity.length()).toBeGreaterThan(10);
    expect(launches.some((l) => l.munition === 'm_9m330')).toBe(true);
    expect(launches.some((l) => l.munition === 'm_igla')).toBe(true);
    // fired from where the boat was by then, not from its spawn point
    expect(launches.some((l) => l.at.distanceTo(start) > 50)).toBe(true);
  });

  it('keeps station on the boat it escorts', () => {
    const w = seaWorld(6);
    const t = tanker(w, 0, -2000);
    const lead = w.spawnGround({ type: 'suicide_boat', team: 'red', position: new Vector3(0, 0, 4000), boat: { chaseId: t.id, weave: 0 } });
    const ad = w.spawnSam({ type: 'ad_boat', team: 'red', position: new Vector3(500, 0, 4500), boat: { escortId: lead.id, escortRight: 150, escortAft: 250 } });
    run(w, 60);
    expect(lead.alive).toBe(true);
    expect(ad.position.distanceTo(lead.position)).toBeLessThan(500);
  });

  it('an AGM-88G homes on its radar while it sails, and kills it', () => {
    let homed = 0;
    let kills = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const w = seaWorld(seed);
      const ad = w.spawnSam({ type: 'ad_boat', team: 'red', position: new Vector3(0, 0, -30_000), known: true, boat: { path: [new Vector3(30_000, 0, -30_000)] } });
      const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 9000, 0), heading: 0, speed: 280, loadout: 'sead_stealth' });
      p.selectedWeapon = 'aargm';
      p.radar.mode = 'ground';
      run(w, 1);
      const mine: MissileEntity[] = [];
      w.events.on('munition:launch', (e) => {
        if (e.shooter === p) mine.push(e.missile);
      });
      w.combat.fire(p, w, 'aargm', ad.id);
      run(w, 1);
      expect(mine).toHaveLength(1);
      const arm = mine[0];
      const launchPos = ad.position.clone();
      let tracked = false;
      run(w, 150, () => {
        // seeker locked on the emitter, aim point on the boat where it is now (it has moved)
        if (arm.alive && arm.seekerLocked && ad.radarOn && ad.position.distanceTo(launchPos) > 300 && arm.targetPoint.distanceTo(ad.position) < 5) tracked = true;
        return !arm.alive;
      });
      if (tracked) homed++;
      if (!ad.alive) kills++;
    }
    expect(homed).toBe(4);
    expect(kills).toBeGreaterThanOrEqual(2);
  });
});

/* ───────────────────────── GBU-53/B vs a weaving boat ───────────────────────── */

describe('GBU-53/B vs a weaving boat', { timeout: 60_000 }, () => {
  it('a designated StormBreaker follows a weaving suicide boat and sinks it', () => {
    const w = seaWorld(3);
    const t = tanker(w, 0, -20_000);
    const boat = w.spawnGround({ type: 'suicide_boat', team: 'red', position: new Vector3(0, 0, -2000), boat: { chaseId: t.id } });
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 7000, 12_000), heading: 0, speed: 250, loadout: 'strike_sdb2' });
    w.combat.selectWeapon(p, 'gbu53', w);
    run(w, 1);
    w.combat.designate(p, boat.id, w);
    run(w, 0.5);
    const launches: MissileEntity[] = [];
    w.events.on('munition:launch', (e) => {
      if (e.shooter === p) launches.push(e.missile);
    });
    w.combat.fire(p, w, 'gbu53', boat.id);
    run(w, 3, () => launches.length > 0);
    expect(launches).toHaveLength(1);
    const bomb = launches[0];
    expect(bomb.targetId).toBe(boat.id);
    let weave = 0;
    let lastCourse = NaN;
    run(w, 150, () => {
      if (boat.alive && boat.velocity.lengthSq() > 1) {
        const c = Math.atan2(boat.velocity.x, -boat.velocity.z);
        if (!Number.isNaN(lastCourse)) weave += Math.abs(Math.atan2(Math.sin(c - lastCourse), Math.cos(c - lastCourse)));
        lastCourse = c;
      }
      return !bomb.alive;
    });
    expect(weave).toBeGreaterThan(30 * DEG); // it was turning while the bomb flew
    expect(boat.alive).toBe(false);
    expect(t.hits).toBe(0);
  });
});

/* ───────────────────────── boats stay in the water ───────────────────────── */

describe('boats never leave the water', { timeout: 60_000 }, () => {
  it('a suicide boat goes round an island to reach its ship; a missile boat and an AD boat stop at the shore', () => {
    const island: Island = { x0: -1500, x1: 1500, z0: -3000, z1: -2000 };
    const w = seaWorld(7, [island]);
    const water = (e: { position: Vector3 }) => w.terrain.isWater(e.position.x, e.position.z);
    const t = tanker(w, 0, -6000, 90 * DEG);
    const s = w.spawnGround({ type: 'suicide_boat', team: 'red', position: new Vector3(0, 0, 0), boat: { chaseId: t.id } });
    // a missile boat whose target sits beyond a coast it can't pass (a wide spit of land)
    const spit: Island = { x0: 5000, x1: 40_000, z0: 5000, z1: 6000 };
    const w2 = seaWorld(8, [spit]);
    const t2 = w2.spawnGround({ type: 'ship', team: 'neutral', vessel: 'tanker', hitsToSink: 2, position: new Vector3(20_000, 0, 20_000) });
    const mb = w2.spawnGround({ type: 'missile_boat', team: 'red', position: new Vector3(20_000, 0, -3000), boat: { strike: { targetId: t2.id, range: 2000 } } });
    const ad = w2.spawnSam({ type: 'ad_boat', team: 'red', position: new Vector3(10_000, 0, 0), boat: { path: [new Vector3(10_000, 0, 20_000)] } });
    const hits = record(w, 'vessel:hit');
    let steps = 0;
    run(w, 600, () => {
      steps++;
      expect(water(s)).toBe(true);
      return !s.alive;
    });
    expect(steps).toBeGreaterThan(60);
    expect(hits).toHaveLength(1); // it got round the island
    run(w2, 300, () => {
      expect(water(mb)).toBe(true);
      expect(water(ad)).toBe(true);
    });
    expect(mb.position.z).toBeLessThan(5000);
    expect(ad.position.z).toBeLessThan(5000);
    expect(t2.hits).toBe(0);
  });
});

/* ───────────────────────── names, models, framing, mission options ───────────────────────── */

describe('boat presentation and mission options', () => {
  it('HUD names, models and PiP framing for each boat type', () => {
    expect(groundHudName('suicide_boat')).toBe('SUICIDE BOAT');
    expect(groundHudName('missile_boat')).toBe('MISSILE BOAT');
    expect(samHudName('ad_boat')).toBe('AD BOAT');
    expect(SAM_DATA.ad_boat.missile).toBe(SAM_DATA.sa15.missile);
    expect(SAM_DATA.ad_boat.manpads?.missile).toBe('m_igla');
    for (const type of ['suicide_boat', 'missile_boat'] as const) {
      expect(getGroundPrototype(type).root.children.length).toBeGreaterThan(0);
      const d = framingDistance({ kind: 'ground', type, id: 1, position: new Vector3(), quaternion: new Vector3() as never, radius: 9 });
      expect(d).toBeGreaterThan(18);
      expect(d).toBeLessThan(45);
    }
    expect(getSamPrototype('ad_boat').root.children.length).toBeGreaterThan(0);
    expect(framingDistance({ kind: 'sam', type: 'ad_boat', id: 1, position: new Vector3(), quaternion: new Vector3() as never, radius: 11 })).toBeLessThan(45);
  });

  it('a mission can chase / strike / escort by group, and the validator checks it', () => {
    const base = missionById('c01')!;
    const script = emptyScript();
    script.ground.push(
      { id: 'mt', group: 'tanker', type: 'ship', team: 'neutral', vessel: 'tanker', hitsToSink: 2, x: 0, z: -5000 },
      { id: 'sb1', group: 'boats', type: 'suicide_boat', x: 3000, z: -5000, chase: 'tanker' },
      { id: 'mb1', group: 'boats', type: 'missile_boat', x: 9000, z: -5000, strike: { group: 'tanker', countdown: 15 } },
    );
    script.sams.push({ id: 'ad1', group: 'boats', type: 'ad_boat', x: 3500, z: -5200, escort: 'boats' });
    script.objectives.push({ id: 'p', kind: 'protect', label: 'Protect the tanker', primary: true, group: 'tanker' } as never);
    const def = { ...base, script } as MissionDef;
    const errs = validateMission(def).filter((e) => /sb1|mb1|ad1|chase|strike|escort/.test(e));
    expect(errs).toEqual([]);
    const bad = emptyScript();
    bad.ground.push({ id: 'x', group: 'g', type: 'truck', x: 0, z: 0, chase: 'nope' });
    bad.sams.push({ id: 'y', group: 'g', type: 'sa6', x: 0, z: 0, path: [{ x: 1, z: 1 }] });
    const badErrs = validateMission({ ...base, script: bad } as MissionDef);
    expect(badErrs.some((e) => /only a suicide boat chases/.test(e))).toBe(true);
    expect(badErrs.some((e) => /unknown group "nope"/.test(e))).toBe(true);
    expect(badErrs.some((e) => /only an AD boat moves/.test(e))).toBe(true);
  });
});

/* ───────────────────────── the launch warning on the tac map ───────────────────────── */

describe('missile boat launch ring', () => {
  it('the tac map draws a counting-down missile boat with its seconds left; a dead one, nothing', () => {
    installPath2D();
    const mock = buildMock('aa');
    const p = mock.player;
    const boat = new GroundEntity(9_000, 'missile_boat', 'red', { radius: 9 });
    boat.position.set(p.position.x + 3000, 0, p.position.z - 6000);
    makeBoat(boat, { strike: { targetId: p.id, range: 6000 } });
    boat.boat!.strike!.timer = 12.3;
    mock.world.ground.push(boat);
    const W = 844;
    const H = 390;
    const { canvas, ctx: fake } = makeFakeCanvas(W, H, 1);
    const hud = createHud(canvas, mock.events);
    hud.resize(W, H, 1);
    hud.setVisible(false);
    const camera = new PerspectiveCamera(60, W / H, 0.5, 60_000);
    camera.position.copy(p.position).add(new Vector3(0, 5, 20));
    camera.updateMatrixWorld();
    const ctx: FrameContext = {
      dt: 1 / 30,
      time: 0,
      world: mock.world,
      player: p,
      camera,
      viewMode: 'tactical',
      focusId: p.id,
      mission: mock.mission,
      settings: { ...DEFAULT_SETTINGS },
      quality: { ...QUALITY_PRESETS.medium },
      paused: false,
      screen: { width: W, height: H, dpr: 1, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
    };
    const frame = (): string[] => {
      fake.reset();
      ctx.time += 1 / 30;
      hud.update(ctx);
      return fake.texts.map((t) => t.text);
    };
    frame();
    expect(frame()).toContain('LAUNCH 13');
    boat.alive = false;
    expect(frame()).not.toContain('LAUNCH 13');
  });
});
