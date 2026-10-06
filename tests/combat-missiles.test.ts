import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { FakeWorld, steerToward, v3 } from './combat-helpers';
import type { CombatMissile } from '../src/sim/weapons/missile';
import { MUNITIONS } from '../src/sim/weapons/defs';
import type { MunitionId } from '../src/core/types';

/** Place the target at `frac` × rMax (self-consistent: the zone depends on the range). */
function placeAtFraction(w: FakeWorld, shooterId: number, targetId: number, frac: number, alt: number): number {
  const a = w.getEntity(shooterId)!;
  const b = w.getEntity(targetId)!;
  let z = w.combat.launchZoneFor(a as never, 'aim120', b, w);
  for (let i = 0; i < 4; i++) {
    b.position.set(0, alt, a.position.z - z.rMax * frac);
    z = w.combat.launchZoneFor(a as never, 'aim120', b, w);
  }
  b.position.set(0, alt, a.position.z - z.rMax * frac);
  return z.rMax;
}

describe('combat: munition database', () => {
  it('defines every munition with sane values', () => {
    const ids: MunitionId[] = ['aim120', 'aim9x', 'gbu31', 'gbu53', 'aargm', 'r73', 'r27', 'r77', 'm_3m9', 'm_9m330', 'm_igla'];
    for (const id of ids) {
      const d = MUNITIONS[id];
      expect(d, id).toBeTruthy();
      expect(d.id).toBe(id);
      expect(d.mass).toBeGreaterThan(0);
      expect(d.maxRange).toBeGreaterThan(d.minRange);
      expect(d.damage).toBeGreaterThan(0);
      expect(d.blastRadius).toBeGreaterThan(0);
      expect(d.maxFlightTime).toBeGreaterThan(5);
      for (const k of ['flareResistance', 'chaffResistance', 'notchResistance', 'smoke'] as const) {
        expect(d[k]).toBeGreaterThanOrEqual(0);
        expect(d[k]).toBeLessThanOrEqual(1);
      }
      if (d.category !== 'bomb') expect(d.boostAccel).toBeGreaterThan(0);
    }
    expect(MUNITIONS.m_9m330.launch).toBe('vertical');
    expect(MUNITIONS.r27.guidance).toBe('semi_active');
    expect(MUNITIONS.m_igla.guidance).toBe('ir');
  });
});

describe('combat: missile flight & guidance', () => {
  it('AMRAAM intercepts a straight, non-manoeuvring target at 60 % rMax (player release via pickle)', () => {
    const w = new FakeWorld();
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 6000, 0), heading: 0, speed: 280, loadout: 'a2a_stealth', callsign: 'Viper 1' });
    const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 6000, -30000), heading: Math.PI, speed: 260 });
    w.run(0.2);
    const rMax = placeAtFraction(w, f35.id, mig.id, 0.6, 6000);
    expect(rMax).toBeGreaterThan(22_000);
    expect(rMax).toBeLessThan(40_000);
    // radar picks it up and auto-designates (TWS); the pilot taps the TD box to command the lock
    w.run(0.5);
    expect(f35.radar.designatedId).toBe(mig.id);
    expect(f35.radar.lockedId).toBeNull();
    w.combat.designate(f35, mig.id, w);
    w.run(2);
    expect(f35.radar.lockedId).toBe(mig.id);

    const launches = w.record('munition:launch');
    const ends = w.record('munition:end');
    const radio = w.record('radio');
    f35.input.fireWeapon = true;
    w.run(0.6);
    f35.input.fireWeapon = false;
    expect(launches.length).toBe(1);
    expect(radio.some((r) => r.voice === 'p_fox3' && r.from === 'Viper 1')).toBe(true);
    const m = launches[0].missile as CombatMissile;
    let wentActive = false;
    w.run(60, () => {
      if (m.seekerLocked) wentActive = true;
      return ends.length > 0;
    });
    expect(wentActive).toBe(true);
    expect(['hit', 'proximity']).toContain(ends[0].reason);
    expect(mig.alive).toBe(false);
    expect(f35.shotsFired).toBe(1);
    expect(f35.hits).toBe(1);
  });

  it('the 3-D flight agrees with the DLZ: hits inside rMax, falls short well beyond it', () => {
    for (const [frac, expectHit] of [
      [0.9, true],
      [1.3, false],
    ] as const) {
      const w = new FakeWorld();
      const a = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 6000, 0), heading: 0, speed: 280, loadout: 'a2a_beast' });
      const b = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 6000, -30000), heading: Math.PI, speed: 280 });
      w.run(0.2);
      placeAtFraction(w, a.id, b.id, frac, 6000);
      w.run(0.3);
      const ends = w.record('munition:end');
      expect(w.combat.fire(a, w, 'aim120', b.id)).not.toBeNull();
      w.run(90, () => ends.length > 0);
      expect(ends[0].reason === 'hit' || ends[0].reason === 'proximity', `frac ${frac}: ${ends[0].reason}`).toBe(expectHit);
    }
  });

  it('kinematic defeat: a target that turns cold at long range out-runs the missile', () => {
    const w = new FakeWorld();
    const a = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 6000, 0), heading: 0, speed: 280, loadout: 'a2a_beast' });
    const b = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 6000, -30000), heading: Math.PI, speed: 280 });
    w.run(0.2);
    placeAtFraction(w, a.id, b.id, 0.9, 6000);
    w.run(0.3);
    const ends = w.record('munition:end');
    const m = w.combat.fire(a, w, 'aim120', b.id) as CombatMissile;
    expect(m).not.toBeNull();
    // RWR/MAWS warning → the bandit rolls out cold within a few seconds and runs at 310 m/s
    const away = new Vector3(0, 0, -1);
    w.controllers.set(b.id, (ac, dt) => steerToward(ac, away, 30, dt, 310));
    w.run(90, () => ends.length > 0);
    expect(ends[0].reason).toBe('selfdestruct');
    expect(b.alive).toBe(true);
    expect(b.health).toBe(100);
    expect(m.speed).toBeLessThan(330);
  });

  it('boost/sustain motor, pitbull and speed profile look like an AMRAAM', () => {
    const w = new FakeWorld();
    const a = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 8000, 0), heading: 0, speed: 280, loadout: 'a2a_beast' });
    const b = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 8000, -25000), heading: Math.PI, speed: 250 });
    w.run(0.5);
    const m = w.combat.fire(a, w, 'aim120', b.id) as CombatMissile;
    let maxV = 0;
    let burningAt2 = false;
    let pitbullRange = -1;
    w.run(40, () => {
      maxV = Math.max(maxV, m.speed);
      if (Math.abs(m.age - 2) < 0.01) burningAt2 = m.motorBurning;
      if (pitbullRange < 0 && m.seekerLocked) pitbullRange = m.position.distanceTo(b.position);
      return !m.alive;
    });
    expect(burningAt2).toBe(true);
    expect(maxV).toBeGreaterThan(950); // ~Mach 3.5+ at altitude
    expect(pitbullRange).toBeGreaterThan(3_000);
    expect(pitbullRange).toBeLessThanOrEqual(MUNITIONS.aim120.activeRange + 500);
  });

  it('semi-active R-27 needs the launcher to keep its lock', () => {
    const run = (keepLock: boolean) => {
      const w = new FakeWorld();
      const a = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 6000, 0), heading: 0, speed: 280 });
      const b = w.spawnAircraft({ type: 'mig29', team: 'blue', position: v3(0, 6000, -14000), heading: Math.PI, speed: 260 });
      w.run(0.3);
      a.radar.designatedId = b.id;
      w.run(4); // AI lock time
      expect(a.radar.lockedId).toBe(b.id);
      const ends = w.record('munition:end');
      const m = w.combat.fire(a, w, 'aim120', b.id) as CombatMissile;
      expect(m?.def.id).toBe('r27');
      if (!keepLock) w.combat.setRadarEmitting(a, false, w);
      w.run(60, () => ends.length > 0);
      return ends[0].reason;
    };
    expect(['hit', 'proximity']).toContain(run(true));
    expect(run(false)).toBe('selfdestruct');
  });

  it('command-guided SAM missile goes ballistic when the site is destroyed', () => {
    const w = new FakeWorld();
    const site = w.spawnSam({ type: 'sa15', team: 'red', position: v3(0, 0, 0) });
    const ac = w.spawnAircraft({ type: 'mig29', team: 'blue', position: v3(0, 2000, -12000), heading: Math.PI, speed: 200 });
    const launches = w.record('munition:launch');
    const ends = w.record('munition:end');
    w.run(60, () => launches.length > 0);
    expect(launches.length).toBe(1);
    const m = launches[0].missile as CombatMissile;
    w.run(1);
    site.alive = false;
    w.run(30, () => ends.length > 0 && !m.alive);
    expect(m.trackBroken).toBe(true);
    expect(ac.health).toBe(100);
  });

  it('JDAM glides to a GPS point and destroys the target; unguided drop falls ballistically', () => {
    const w = new FakeWorld();
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 8000, 0), heading: 0, speed: 250, loadout: 'strike_beast' });
    const hangar = w.spawnGround({ type: 'hangar', team: 'red', position: v3(300, 0, -7000), health: 300 });
    hangar.known = true;
    f35.selectedWeapon = 'gbu31';
    f35.radar.mode = 'ground';
    w.run(0.5);
    w.combat.designate(f35, hangar.id, w);
    expect(f35.radar.groundPoint).not.toBeNull();
    const bip = w.combat.bombImpactPoint(f35, w)!;
    expect(bip.inRange).toBe(true);
    const ends = w.record('munition:end');
    const explosions = w.record('explosion');
    const m = w.combat.fire(f35, w, 'gbu31', hangar.id);
    expect(m).not.toBeNull();
    w.run(90, () => ends.length > 0);
    expect(ends[0].reason).toBe('hit');
    expect(hangar.alive).toBe(false);
    expect(explosions.some((e) => e.size === 'huge' && e.surface === 'ground')).toBe(true);
  });

  it('AARGM homes on an emitting SAM radar', () => {
    const w = new FakeWorld();
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 9000, 0), heading: 0, speed: 280, loadout: 'sead_stealth' });
    const sam = w.spawnSam({ type: 'sa6', team: 'red', position: v3(1000, 0, -35000) });
    f35.selectedWeapon = 'aargm';
    f35.radar.mode = 'ground';
    w.run(1);
    expect(sam.radarOn).toBe(true);
    const ends = w.record('munition:end');
    const m = w.combat.fire(f35, w, 'aargm');
    expect(m).not.toBeNull();
    expect(m!.targetId).toBe(sam.id);
    w.run(120, () => ends.length > 0);
    expect(ends[0].reason).toBe('hit');
    expect(sam.alive).toBe(false);
  });
});
