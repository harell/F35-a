/**
 * Regression tests for the i1 missile-flight fixes:
 *  - thrust-vector g is no longer charged as induced drag (AIM-9X / R-73 high off-boresight shots
 *    used to stall during the boost and self-destruct at 2.0 s)
 *  - vertical-launch SAMs (SA-15) pitch over with a rate-limited, speed-preserving turn
 *    and do not fly into the ground against low targets
 */
import { describe, expect, it } from 'vitest';
import { FakeWorld, FlatTerrain, v3 } from './combat-helpers';
import type { CombatMissile } from '../src/sim/weapons/missile';

const DEG = Math.PI / 180;

/** F-35 (5 km, 250 m/s, heading north) fires an AIM-9X at a non-manoeuvring MiG-29. */
function nineX(bearingDeg: number, range: number, tgtHeadingDeg: number) {
  const w = new FakeWorld({ difficulty: 'pilot', seed: 5 });
  const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 5000, 0), heading: 0, speed: 250, loadout: 'a2a_beast' });
  const b = bearingDeg * DEG;
  const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(Math.sin(b) * range, 5000, -Math.cos(b) * range), heading: tgtHeadingDeg * DEG, speed: 250 });
  w.combat.selectWeapon(f35, 'aim9x', w);
  w.combat.designate(f35, mig.id, w);
  w.run(0.5);
  const ends = w.record('munition:end');
  const m = w.combat.fire(f35, w, 'aim9x', mig.id) as CombatMissile | null;
  expect(m, `9X brg${bearingDeg} r${range} th${tgtHeadingDeg} fired`).not.toBeNull();
  let minSpeedAfterBoost = Infinity;
  let speedAt1 = 0;
  w.run(25, () => {
    if (m!.alive && m!.age > 0.5 && m!.age < 2.0) minSpeedAfterBoost = Math.min(minSpeedAfterBoost, m!.speed);
    if (m!.alive && Math.abs(m!.age - 1) < 0.01) speedAt1 = m!.speed;
    return ends.length > 0;
  });
  return { reason: ends[0]?.reason, age: m!.age, mig, minSpeedAfterBoost, speedAt1 };
}

describe('combat: thrust-vectoring dogfight missiles', () => {
  it('AIM-9X 45° off-boresight, 3 km, head-on: keeps its energy through the boost and hits', () => {
    const r = nineX(45, 3000, 180);
    expect(r.minSpeedAfterBoost).toBeGreaterThan(250); // used to fall to ~12 m/s
    expect(['hit', 'proximity']).toContain(r.reason);
    expect(r.mig.alive).toBe(false);
  });

  it('AIM-9X 20° off-boresight vs a crossing target at 1.5 km hits (used to self-destruct at 2.0 s)', () => {
    const r = nineX(20, 1500, 90);
    expect(r.speedAt1).toBeGreaterThan(350);
    expect(['hit', 'proximity']).toContain(r.reason);
    expect(r.age).toBeGreaterThan(1);
  });

  it('AIM-9X boresight crossing shot at 1.5 km and a 70° HMD shot at 1.5 km both hit', () => {
    for (const [brg, th] of [
      [0, 90],
      [70, 0],
    ] as const) {
      const r = nineX(brg, 1500, th);
      expect(['hit', 'proximity'], `brg${brg} th${th}: ${r.reason} @${r.age.toFixed(1)}s`).toContain(r.reason);
    }
  });

  it('R-73 45° off-boresight shot keeps flying after the boost', () => {
    const w = new FakeWorld({ difficulty: 'veteran', seed: 3 });
    const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 4000, 0), heading: 0, speed: 240 });
    const tgt = w.spawnAircraft({ type: 'mig29', team: 'blue', position: v3(Math.sin(45 * DEG) * 2500, 4000, -Math.cos(45 * DEG) * 2500), heading: Math.PI, speed: 240 });
    mig.selectedWeapon = 'aim9x';
    w.run(0.3);
    w.combat.designate(mig, tgt.id, w);
    w.run(0.3);
    const ends = w.record('munition:end');
    const m = w.combat.fire(mig, w, 'aim9x', tgt.id) as CombatMissile;
    expect(m?.def.id).toBe('r73');
    let minV = Infinity;
    w.run(20, () => {
      if (m.alive && m.age > 0.4 && m.age < 2.2) minV = Math.min(minV, m.speed);
      return ends.length > 0;
    });
    expect(minV).toBeGreaterThan(220);
    expect(['hit', 'proximity']).toContain(ends[0].reason);
  });
});

/** Vertical-launch SAM vs a MiG at `agl` over flat ground (20 m MSL), `dist` north of the site. */
function vls(type: 'sa15', agl: number, dist: number, heading: number) {
  const ground = 20;
  const w = new FakeWorld({ difficulty: 'veteran', seed: 7, terrain: new FlatTerrain(ground) });
  w.spawnSam({ type, team: 'red', position: v3(0, 0, 0) });
  const ac = w.spawnAircraft({ type: 'mig29', team: 'blue', position: v3(0, ground + agl, -dist), heading, speed: 250 });
  const launches = w.record('munition:launch');
  const ends = w.record('munition:end');
  w.run(40, () => launches.length > 0);
  expect(launches.length, `${type} launched at ${agl} m AGL / ${dist} m`).toBeGreaterThan(0);
  const m = launches[0].missile as CombatMissile;
  let minAgl = Infinity;
  let maxClimbAt1 = 0;
  w.run(45, () => {
    if (m.alive && m.age > 0.3) minAgl = Math.min(minAgl, m.position.y - ground);
    if (m.alive && Math.abs(m.age - 1.5) < 0.01) maxClimbAt1 = m.position.y - ground;
    return ends.some((e) => e.missile === m);
  });
  const end = ends.find((e) => e.missile === m)!;
  return { reason: end.reason, minAgl, heightAt1_5: maxClimbAt1, m, ac };
}

describe('combat: vertical-launch SAM pitch-over', () => {
  it('SA-15 vs a 300 m AGL target 3–6 km away: pitches over, never hits the ground, kills', () => {
    for (const dist of [3000, 4500, 6000]) {
      const r = vls('sa15', 300, dist, Math.PI);
      expect(r.reason, `SA-15 @${dist} m`).not.toBe('ground');
      expect(['hit', 'proximity']).toContain(r.reason);
      expect(r.minAgl).toBeGreaterThan(5);
    }
  });

  it('SA-15 vs a 50 m AGL crossing target at 3 km still intercepts', () => {
    const r = vls('sa15', 50, 3000, Math.PI / 2);
    expect(['hit', 'proximity']).toContain(r.reason);
  });

  it('SA-15 vs a 300 m AGL target 6 km head-on / 4 km crossing: climbs out of the tube, turns over, intercepts', () => {
    for (const [heading, dist] of [[Math.PI, 6000], [Math.PI / 2, 4000]]) {
      const r = vls('sa15', 300, dist, heading);
      expect(r.reason).not.toBe('ground');
      expect(['hit', 'proximity']).toContain(r.reason);
      expect(r.heightAt1_5).toBeGreaterThan(60); // it rose above the launcher before turning over
      expect(r.m.turned).toBe(true);
    }
  });
});
