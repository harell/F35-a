/**
 * The Sky Tower as a protected landmark (issue #16): hit volume, one-hit kill by the player's
 * bombs / AGMs / AAMs (not the gun, not anybody else), rounds and munitions stopped by it,
 * aircraft crashing into it, the collapse timeline, and sensors never seeing it.
 * Issue #75: enemy hits (hitLandmark / hitSkyTower) damage it once and collapse it on the second;
 * the player's munition still brings it down at once, damaged or not.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus, type GameEventMap } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import { AKL } from '../src/core/auckland';
import { COLLAPSE, POD_HEIGHT, SKY_TOWER_HEIGHT, collapsePose, fallHeading, towerAxisPoint } from '../src/core/skyTower';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { DEFAULT_HIT_HEIGHT, createSkyTower, destroyLandmark, firstLandmarkHit, hitLandmark, hitSkyTower, landmarkDistance, landmarkSegmentHit, STRUCTURAL_BLAST_FRACTION } from '../src/sim/landmarks';
import { MUNITIONS } from '../src/sim/weapons/defs';
import { DT, FakeWorld, FlatTerrain } from './combat-helpers';

const { x: TX, z: TZ } = AKL.skytower;
const GROUND = 30;
const WEST = -Math.PI / 2;
const at = (dx: number, y: number, dz: number) => new Vector3(TX + dx, GROUND + y, TZ + dz);

function towerWorld(): { w: FakeWorld; tower: ReturnType<typeof createSkyTower> } {
  const w = new FakeWorld({ terrain: new FlatTerrain(GROUND), seed: 3 });
  const tower = createSkyTower(GROUND);
  w.landmarks.push(tower);
  return { w, tower };
}

describe('Sky Tower hit volume (OSM profile)', () => {
  const tower = createSkyTower(GROUND);

  it('is 328 m tall with the pod at its widest (r 16.6) and the SkyWalk ring (r 20.1)', () => {
    expect(tower.height).toBe(SKY_TOWER_HEIGHT);
    expect(tower.reach).toBeCloseTo(20.1, 5);
    expect(landmarkDistance(tower, at(16.6, 190, 0))).toBeCloseTo(0, 5);
    expect(landmarkDistance(tower, at(6.1, 120, 0))).toBeCloseTo(0, 5);
    expect(landmarkDistance(tower, at(0.6, 320, 0))).toBeCloseTo(0, 5);
    expect(landmarkDistance(tower, at(0, SKY_TOWER_HEIGHT + 5, 0))).toBeCloseTo(5, 5);
  });

  it('a pod hit at 200 m counts; a miss 30 m off the axis does not', () => {
    // hit point on the pod (Sugar Club tier, r 15.8 → envelope 16.6)
    expect(landmarkDistance(tower, at(0, 196, -16))).toBeLessThanOrEqual(0.6);
    // the strongest air-to-air warhead goes off 30 m off-axis level with the pod: outside its structural reach
    const reach = MUNITIONS.aim120.blastRadius * STRUCTURAL_BLAST_FRACTION;
    expect(landmarkDistance(tower, at(30, 200, 0))).toBeGreaterThan(reach);
    expect(landmarkDistance(tower, at(0, 200, 10))).toBeLessThan(reach);
  });

  it('segment test: crossing the shaft, the pod and the mast hits; passing beside or above misses', () => {
    expect(landmarkSegmentHit(tower, at(-100, 120, 0), at(100, 120, 0))).toBeCloseTo((100 - 6.1) / 200, 4);
    expect(landmarkSegmentHit(tower, at(-50, 190, 0), at(50, 190, 0))).toBeCloseTo((50 - 16.6) / 100, 4);
    expect(landmarkSegmentHit(tower, at(-30, 300, 0.5), at(30, 300, 0.5))).toBeGreaterThan(0); // 1.3 m mast
    expect(landmarkSegmentHit(tower, at(-100, 120, 9), at(100, 120, 9))).toBe(-1);
    expect(landmarkSegmentHit(tower, at(-100, 340, 0), at(100, 340, 0))).toBe(-1);
    // diving onto the top of the pod
    expect(landmarkSegmentHit(tower, at(5, 260, 5), at(5, 230, 5))).toBeGreaterThan(0);
    // padded (aircraft) test reaches further
    expect(landmarkSegmentHit(tower, at(-100, 120, 9), at(100, 120, 9), 4)).toBeGreaterThan(0);
    // a dead landmark is no longer in the way
    const dead = createSkyTower(GROUND);
    dead.alive = false;
    expect(firstLandmarkHit([dead], at(-100, 120, 0), at(100, 120, 0))).toBeNull();
  });
});

describe('Sky Tower: one hit from the player destroys it', () => {
  it('an AIM-120 whose target flies past the pod brings the tower down', () => {
    const { w, tower } = towerWorld();
    const destroyed = w.record('landmark:destroyed');
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', position: at(6000, 200, 0), heading: WEST, speed: 250, isPlayer: true, loadout: 'a2a_beast' });
    // a MiG hanging right against the pod's east face
    const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: at(19, 196, 0), heading: 0, speed: 0.01 });
    w.run(0.5);
    w.combat.designate(f35, mig.id, w);
    expect(w.combat.fire(f35, w, 'aim120', mig.id)).not.toBeNull();
    w.run(30, () => !tower.alive);
    expect(tower.alive).toBe(false);
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0].attackerId).toBe(f35.id);
    expect(destroyed[0].weapon).toBe('aim120');
    expect(tower.destroyedAt).toBeGreaterThan(0);
  });

  it('a missile that flies into the tower goes off against it (and destroys it)', () => {
    const { w, tower } = towerWorld();
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', position: at(6000, 150, 0), heading: WEST, speed: 250, isPlayer: true, loadout: 'a2a_beast' });
    // the bandit hides right behind the shaft
    const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: at(-200, 150, 0), heading: WEST, speed: 0.01 });
    const ends = w.record('munition:end');
    w.run(0.5);
    w.combat.designate(f35, mig.id, w);
    expect(w.combat.fire(f35, w, 'aim120', mig.id)).not.toBeNull();
    w.run(30, () => ends.length > 0);
    expect(ends).toHaveLength(1);
    expect(ends[0].reason).toBe('ground');
    expect(landmarkDistance(tower, ends[0].position)).toBeLessThan(1);
    expect(tower.alive).toBe(false);
    expect(mig.alive).toBe(true);
  });

  it('only the player’s munitions count: a wingman’s AMRAAM against the same MiG leaves it standing', () => {
    const { w, tower } = towerWorld();
    w.spawnAircraft({ type: 'f35a', team: 'blue', position: at(-9000, 3000, 0), heading: 0, speed: 250, isPlayer: true, loadout: 'a2a_stealth' });
    const viper2 = w.spawnAircraft({ type: 'f35a', team: 'blue', position: at(6000, 200, 0), heading: WEST, speed: 250, loadout: 'a2a_beast', callsign: 'Viper 2' });
    const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: at(19, 196, 0), heading: 0, speed: 0.01 });
    const ends = w.record('munition:end');
    w.run(0.5);
    w.combat.designate(viper2, mig.id, w);
    expect(w.combat.fire(viper2, w, 'aim120', mig.id)).not.toBeNull();
    w.run(30, () => ends.length > 0);
    expect(ends).toHaveLength(1);
    expect(landmarkDistance(tower, ends[0].position)).toBeLessThan(MUNITIONS.aim120.blastRadius * STRUCTURAL_BLAST_FRACTION);
    expect(tower.alive).toBe(true);
    expect(tower.hits).toBe(0); // nor does it count as an enemy hit
  });

  function jdamOnJet(dx: number) {
    const { w, tower } = towerWorld();
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', position: at(3000, 4000, 0), heading: WEST, speed: 240, isPlayer: true, loadout: 'strike_beast' });
    // a designated military target (a parked jet) on the street west of the tower
    const jet = w.spawnGround({ type: 'parked_jet', team: 'red', position: at(dx, 0, 0) });
    w.run(0.5);
    w.combat.selectWeapon(f35, 'gbu31', w);
    w.combat.designate(f35, jet.id, w);
    const ends = w.record('munition:end');
    const destroyed = w.record('landmark:destroyed');
    expect(w.combat.fire(f35, w, 'gbu31', jet.id)).not.toBeNull();
    w.run(60, () => ends.length > 0);
    expect(ends).toHaveLength(1);
    expect(jet.alive).toBe(false);
    return { tower, destroyed };
  }

  it('a JDAM on a parked jet 18 m from the axis brings it down; one 30 m out does not', () => {
    const near = jdamOnJet(-18);
    expect(near.tower.alive).toBe(false);
    expect(near.destroyed[0].weapon).toBe('gbu31');
    // hit from the west → falls east
    expect(near.tower.fallHeading).toBeCloseTo(Math.PI / 2, 3);
    const far = jdamOnJet(-30);
    expect(far.tower.alive).toBe(true);
    expect(far.destroyed).toHaveLength(0);
  });

  it('the structural reach is a fraction of each warhead’s blast radius', () => {
    for (const id of ['gbu31', 'gbu53', 'aargm', 'aim9x', 'aim120'] as const) {
      const reach = MUNITIONS[id].blastRadius * STRUCTURAL_BLAST_FRACTION;
      expect(reach).toBeGreaterThan(4);
      expect(reach).toBeLessThan(20);
    }
  });
});

describe('the gun cannot bring it down', () => {
  it('rounds stop at the tower (impact sparks) and do no harm', () => {
    const { w, tower } = towerWorld();
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', position: at(700, 122, 0), heading: WEST, speed: 200, isPlayer: true, loadout: 'a2a_stealth' });
    w.combat.selectWeapon(f35, 'gun', w);
    const impacts = w.record('gun:impact');
    f35.input.fireGun = true;
    w.run(1.5);
    f35.input.fireGun = false;
    w.run(2);
    expect(tower.alive).toBe(true);
    const onTower = impacts.filter((e) => landmarkDistance(tower, e.position) < 1);
    expect(onTower.length).toBeGreaterThan(0);
    // nothing got through: no round landed beyond the tower
    expect(impacts.every((e) => e.position.x > TX - 8)).toBe(true);
  });
});

describe('Sky Tower: enemy hits (issue #75)', () => {
  it('one enemy hit: damaged and burning on its face, not collapsed', () => {
    const { w, tower } = towerWorld();
    const damaged = w.record('landmark:damaged');
    const destroyed = w.record('landmark:destroyed');
    const booms = w.record('explosion');
    w.run(1);
    expect(hitLandmark(tower, w.events, w.time, { attackerId: 77 })).toBe(1);
    expect(tower.alive).toBe(true);
    expect(tower.hits).toBe(1);
    expect(tower.damagedAt).toBeCloseTo(w.time, 6);
    // default: the east face at DEFAULT_HIT_HEIGHT (shaft, r 6.1)
    expect(tower.damagePoint.x).toBeCloseTo(TX + 6.1, 5);
    expect(tower.damagePoint.y).toBeCloseTo(GROUND + DEFAULT_HIT_HEIGHT, 5);
    expect(tower.damagePoint.z).toBeCloseTo(TZ, 5);
    expect(damaged).toHaveLength(1);
    expect(damaged[0].hits).toBe(1);
    expect(damaged[0].attackerId).toBe(77);
    expect(booms).toHaveLength(1);
    expect(booms[0].size).toBe('large');
    expect(destroyed).toHaveLength(0);
    w.run(20);
    expect(tower.alive).toBe(true);
  });

  it('the hit lands where the attacker came in, snapped onto the face', () => {
    const { w, tower } = towerWorld();
    hitLandmark(tower, w.events, w.time, { point: at(0, 190, -40) }); // from the north, level with the pod
    expect(tower.damagePoint.x).toBeCloseTo(TX, 5);
    expect(tower.damagePoint.z).toBeCloseTo(TZ - 16.6, 5);
    expect(tower.damagePoint.y).toBeCloseTo(GROUND + 190, 5);
    expect(landmarkDistance(tower, tower.damagePoint)).toBeCloseTo(0, 5);
  });

  it('the second enemy hit brings it down (cause: enemy), falling away from the hit', () => {
    const events = new EventBus();
    const world = createSimWorld({ terrain: new FlatTerrain(GROUND), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(5) });
    const tower = createSkyTower(GROUND);
    world.landmarks.push(tower);
    const destroyed: GameEventMap['landmark:destroyed'][] = [];
    const damaged: GameEventMap['landmark:damaged'][] = [];
    const impacts: unknown[] = [];
    events.on('landmark:destroyed', (e) => destroyed.push(e));
    events.on('landmark:damaged', (e) => damaged.push(e));
    events.on('landmark:impact', (e) => impacts.push(e));
    expect(hitSkyTower(world, { attackerId: 5 })).toBe(1);
    for (let i = 0; i < 120; i++) world.step(DT);
    expect(tower.alive).toBe(true);
    expect(hitSkyTower(world, { attackerId: 6, point: at(-40, 120, 0) })).toBe(2); // from the west
    expect(tower.alive).toBe(false);
    expect(tower.cause).toBe('enemy');
    expect(damaged).toHaveLength(1);
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]).toMatchObject({ attackerId: 6, weapon: null, cause: 'enemy' });
    expect(tower.fallHeading).toBeCloseTo(Math.PI / 2, 3); // falls east
    // the existing scripted collapse plays out
    for (let i = 0; i < Math.ceil((COLLAPSE.impactAt + 1) / DT); i++) world.step(DT);
    expect(impacts).toHaveLength(1);
    // a fallen tower takes no more hits
    expect(hitSkyTower(world)).toBe(0);
    expect(destroyed).toHaveLength(1);
  });

  it('hitSkyTower on a sortie without a tower does nothing', () => {
    const w = new FakeWorld({ terrain: new FlatTerrain(GROUND), seed: 3 });
    const booms = w.record('explosion');
    expect(hitSkyTower(w)).toBe(0);
    expect(booms).toHaveLength(0);
  });

  it('the player’s AIM-120 still brings a damaged tower down at once (cause: player)', () => {
    const { w, tower } = towerWorld();
    hitLandmark(tower, w.events, w.time);
    expect(tower.hits).toBe(1);
    const destroyed = w.record('landmark:destroyed');
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', position: at(6000, 200, 0), heading: WEST, speed: 250, isPlayer: true, loadout: 'a2a_beast' });
    const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: at(19, 196, 0), heading: 0, speed: 0.01 });
    w.run(0.5);
    w.combat.designate(f35, mig.id, w);
    expect(w.combat.fire(f35, w, 'aim120', mig.id)).not.toBeNull();
    w.run(30, () => !tower.alive);
    expect(tower.alive).toBe(false);
    expect(tower.hits).toBe(1); // the player's hit is not an enemy hit
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]).toMatchObject({ attackerId: f35.id, weapon: 'aim120', cause: 'player' });
  });
});

describe('aircraft vs Sky Tower', () => {
  function realWorld() {
    const events = new EventBus();
    const world = createSimWorld({ terrain: new FlatTerrain(GROUND), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(5) });
    const tower = createSkyTower(GROUND);
    world.landmarks.push(tower);
    return { events, world, tower };
  }

  it("the player's jet flying into the shaft crashes ('structure') and brings the tower down at once, falling away from it", () => {
    const { events, world, tower } = realWorld();
    const downs: GameEventMap['player:down'][] = [];
    const destroyed: GameEventMap['landmark:destroyed'][] = [];
    events.on('player:down', (e) => downs.push(e));
    events.on('landmark:destroyed', (e) => destroyed.push(e));
    const p = world.spawnAircraft({ type: 'f35a', team: 'blue', position: at(400, 120, 0), heading: WEST, speed: 220, isPlayer: true });
    for (let i = 0; i < 240 && p.alive; i++) world.step(DT);
    expect(p.alive).toBe(false);
    expect(downs).toEqual([{ reason: 'structure' }]);
    expect(Math.abs(p.position.x - TX)).toBeLessThan(20);
    // one jet is enough (two Shaheds are needed): down at once, the player's doing, no munition
    expect(tower.alive).toBe(false);
    expect(destroyed).toHaveLength(1);
    expect(destroyed[0]).toMatchObject({ cause: 'player', weapon: null, attackerId: p.id });
    expect(tower.hitPoint.y - tower.base.y).toBeGreaterThan(100);
    expect(tower.hitPoint.y - tower.base.y).toBeLessThan(140);
    // came in from the east → falls west, away from the jet
    expect(tower.fallHeading).toBeCloseTo((270 * Math.PI) / 180, 1);
    // the strike is recorded for the death cam and the outro: named, framing the fall
    const strike = world.structureStrike!;
    expect(strike).toMatchObject({ name: 'the Sky Tower', label: 'SKY TOWER', duration: COLLAPSE.ruinsAt });
    expect(strike.center.x).toBeLessThan(TX - 100);
    expect(strike.radius).toBeGreaterThan(200);
    // the collapse plays: the pod lands
    const impacts: unknown[] = [];
    events.on('landmark:impact', (e) => impacts.push(e));
    // the wreck doesn't hang on the shaft: it falls to the ground
    const y0 = p.position.y;
    for (let i = 0; i < 600; i++) world.step(DT);
    expect(p.position.y).toBeLessThan(y0 - 80);
    expect(impacts).toHaveLength(1);
  });

  it('an AI jet flying into it crashes; the tower is unharmed and no strike is recorded', () => {
    const { events, world, tower } = realWorld();
    const downs: GameEventMap['player:down'][] = [];
    events.on('player:down', (e) => downs.push(e));
    const a = world.spawnAircraft({ type: 'mig29', team: 'red', position: at(400, 120, 0), heading: WEST, speed: 220 });
    for (let i = 0; i < 240 && a.alive; i++) world.step(DT);
    expect(a.alive).toBe(false);
    expect(downs).toEqual([]);
    expect(tower.alive).toBe(true);
    expect(tower.hits).toBe(0);
    expect(world.structureStrike).toBeNull();
  });

  it('flying past it does not', () => {
    const { world } = realWorld();
    const p = world.spawnAircraft({ type: 'f35a', team: 'blue', position: at(400, 120, 40), heading: WEST, speed: 220, isPlayer: true });
    for (let i = 0; i < 240; i++) world.step(DT);
    expect(p.alive).toBe(true);
  });
});

describe('collapse', () => {
  it('falls away from the blast, deterministically', () => {
    expect(fallHeading(0, 0, 10, 0)).toBeCloseTo((270 * Math.PI) / 180, 6); // hit from the east → falls west
    expect(fallHeading(0, 0, 0, -10)).toBeCloseTo(Math.PI, 6); // hit from the north → falls south
    expect(fallHeading(0, 0, 0, 0, 0, 500)).toBeCloseTo(0, 6); // dead on the axis: away from the attacker (south) → north
    expect(fallHeading(0, 0, 0, 0)).toBeCloseTo(Math.PI / 4, 6);
  });

  it('topples over 6–8 s: tilt grows from rest, the pod lands ~150 m out, the mast snaps', () => {
    expect(COLLAPSE.impactAt).toBeGreaterThanOrEqual(6);
    expect(COLLAPSE.impactAt).toBeLessThanOrEqual(8);
    expect(collapsePose(0).tilt).toBe(0);
    expect(collapsePose(1).tilt).toBeLessThan(0.05);
    expect(collapsePose(COLLAPSE.impactAt).tilt).toBeCloseTo(COLLAPSE.tiltAtImpact, 6);
    expect(collapsePose(COLLAPSE.mastSnapAt - 0.1).mastTilt).toBe(0);
    expect(collapsePose(COLLAPSE.impactAt).mastTilt).toBeGreaterThan(0);
    const [along, up] = towerAxisPoint(POD_HEIGHT, COLLAPSE.impactAt);
    expect(along).toBeGreaterThan(130);
    expect(along).toBeLessThan(170);
    expect(up).toBeLessThan(20);
    // the stump does not move
    expect(towerAxisPoint(30, 5)).toEqual([0, 30]);
  });

  it('plays its explosions on the timeline and reports the pod impact once', () => {
    const events = new EventBus();
    const world = createSimWorld({ terrain: new FlatTerrain(GROUND), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(5) });
    const tower = createSkyTower(GROUND);
    world.landmarks.push(tower);
    const booms: { t: number; size: string; y: number }[] = [];
    const impacts: GameEventMap['landmark:impact'][] = [];
    events.on('explosion', (e) => booms.push({ t: world.time, size: e.size, y: e.position.y }));
    events.on('landmark:impact', (e) => impacts.push({ ...e, position: e.position.clone() }));
    world.step(DT);
    destroyLandmark(tower, events, world.time, at(12, 120, 0), 1, 'gbu31');
    const t0 = world.time;
    for (let i = 0; i < 10 * 60; i++) world.step(DT);
    expect(booms[0]).toMatchObject({ size: 'huge' });
    expect(booms[0].y).toBeCloseTo(GROUND + COLLAPSE.breakHeight, 3);
    expect(booms.length).toBe(6);
    expect(impacts).toHaveLength(1);
    const dt = booms.find((b) => b.size === 'huge' && b.y === GROUND)!.t - t0;
    expect(dt).toBeCloseTo(COLLAPSE.impactAt, 1);
    // hit from the east → fell west
    expect(impacts[0].position.x).toBeLessThan(TX - 100);
    expect(Math.abs(impacts[0].position.z - TZ)).toBeLessThan(1);
    // a second "kill" does nothing
    destroyLandmark(tower, events, world.time, at(0, 0, 0), 1, 'gbu31');
    expect(tower.destroyedAt).toBeCloseTo(t0, 6);
  });
});

describe('sensors and AI never see it', () => {
  it('is in no hostile list and TGT cycling never lands on it', () => {
    const { w, tower } = towerWorld();
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', position: at(3000, 600, 0), heading: WEST, speed: 220, isPlayer: true, loadout: 'strike_stealth' });
    w.combat.selectWeapon(f35, 'gbu31', w);
    w.run(1);
    for (let i = 0; i < 4; i++) {
      w.combat.cycleTarget(f35, w);
      expect(f35.radar.designatedId).toBeNull();
    }
    expect(f35.radar.contacts.length).toBe(0);
    const ids = new Set([...w.aircraft, ...w.sams, ...w.ground].map((e) => e.id));
    expect(ids.size).toBe(1);
    expect(tower.alive).toBe(true);
    // the real world's hostile cache only ever lists entities
    const events = new EventBus();
    const world = createSimWorld({ terrain: new FlatTerrain(GROUND), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(5) });
    world.landmarks.push(createSkyTower(GROUND));
    expect(world.hostilesOf('blue')).toEqual([]);
    expect(world.hostilesOf('red')).toEqual([]);
  });
});
