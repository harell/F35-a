import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { FakeWorld, steerToward, v3 } from './combat-helpers';
import type { CombatMissile } from '../src/sim/weapons/missile';
import { FLARE_LIFE } from '../src/sim/weapons/countermeasures';

/**
 * R-77 (Su-35, 7 km) vs a MiG-29 at 1,500 m, head-on at 9–11.5 km. The target optionally beams
 * (turns perpendicular to the missile) once the missile is inside 5 km, and optionally pumps chaff.
 */
function radarTrial(seed: number, beam: boolean, chaff: boolean): { defeated: boolean; reason: string } {
  const w = new FakeWorld({ seed, difficulty: 'veteran' });
  const off = ((seed * 7919) % 4000) - 2000;
  const range = 9000 + ((seed * 104729) % 2500);
  const a = w.spawnAircraft({ type: 'su35', team: 'red', position: v3(0, 7000, 0), heading: 0, speed: 280 });
  const b = w.spawnAircraft({ type: 'mig29', team: 'blue', position: v3(off, 1500, -range), heading: Math.PI, speed: 280 });
  w.run(1);
  const ends = w.record('munition:end');
  const m = w.combat.fire(a, w, 'aim120', b.id) as CombatMissile;
  expect(m?.def.id).toBe('r77');
  const side = seed % 2 ? 1 : -1;
  const dir = new Vector3();
  w.controllers.set(b.id, (ac, dt) => {
    if (!m.alive || m.position.distanceTo(ac.position) > 5000) return;
    ac.input.chaff = chaff;
    if (!beam) return;
    dir.subVectors(ac.position, m.position);
    dir.y = 0;
    dir.normalize();
    dir.set(-dir.z * side, 0, dir.x * side);
    steerToward(ac, dir, 7, dt, 280);
  });
  w.run(80, () => ends.length > 0);
  return { defeated: b.health >= 100, reason: ends[0]?.reason ?? 'none' };
}

/** R-73 from 1.1–1.6 km in the rear quarter; the target optionally holds the flare button and breaks. */
function irTrial(seed: number, flares: boolean, turn: boolean): { defeated: boolean; reason: string } {
  const w = new FakeWorld({ seed, difficulty: 'veteran' });
  const range = 1100 + ((seed * 7919) % 500);
  const a = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 5000, 0), heading: 0, speed: 260 });
  const b = w.spawnAircraft({ type: 'mig29', team: 'blue', position: v3(((seed * 31) % 300) - 150, 5000, -range), heading: 0, speed: 250 });
  a.selectedWeapon = 'aim9x';
  w.run(0.5);
  a.radar.designatedId = b.id;
  w.run(0.2);
  const ends = w.record('munition:end');
  const m = w.combat.fire(a, w, 'aim9x', b.id) as CombatMissile;
  expect(m?.def.id).toBe('r73');
  const side = seed % 2 ? 1 : -1;
  const dir = new Vector3(side, 0, -0.3).normalize();
  let t = 0;
  w.controllers.set(b.id, (ac, dt) => {
    t += dt;
    if (t < 0.6) return;
    ac.input.flare = flares;
    if (turn) steerToward(ac, dir, 6, dt, 250);
  });
  w.run(30, () => ends.length > 0);
  return { defeated: b.health >= 100, reason: ends[0]?.reason ?? 'none' };
}

const rate = (n: number, f: (seed: number) => { defeated: boolean }) => {
  let d = 0;
  for (let s = 1; s <= n; s++) if (f(s).defeated) d++;
  return d / n;
};

describe('combat: countermeasures', () => {
  it('flares decoy IR missiles statistically (never always, never never)', () => {
    const N = 30;
    const control = rate(N, (s) => irTrial(s, false, true));
    const withFlares = rate(N, (s) => irTrial(s, true, true));
    expect(control).toBeLessThan(0.15);
    expect(withFlares).toBeGreaterThan(0.2);
    expect(withFlares).toBeLessThan(0.9);
    const reasons = new Set<string>();
    for (let s = 1; s <= 10; s++) reasons.add(irTrial(s, true, true).reason);
    expect(reasons.has('decoyed')).toBe(true);
  });

  it('hard beam + chaff low in the clutter defeats radar missiles sometimes; chaff alone rarely', () => {
    const N = 30;
    const control = rate(N, (s) => radarTrial(s, false, false));
    const chaffOnly = rate(N, (s) => radarTrial(s, false, true));
    const beamOnly = rate(N, (s) => radarTrial(s, true, false));
    const beamChaff = rate(N, (s) => radarTrial(s, true, true));
    expect(control).toBe(0);
    expect(chaffOnly).toBeLessThan(0.25); // Doppler filtering: chaff without a beam turn is weak
    expect(beamChaff).toBeGreaterThan(0.2);
    expect(beamChaff).toBeLessThan(0.95);
    expect(beamChaff).toBeGreaterThan(beamOnly);
  });

  it('flare program: rising edge = 2-flare salvo 0.15 s apart, held = repeat every 0.6 s', () => {
    const w = new FakeWorld();
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 3000, 0), heading: 0, speed: 250, loadout: 'a2a_stealth' });
    const cm = w.record('countermeasure');
    const start = f35.flares;
    f35.input.flare = true;
    w.run(0.1);
    expect(cm.length).toBe(1);
    w.run(0.1); // 0.2 s
    expect(cm.length).toBe(2);
    w.run(0.2); // 0.4 s: still 2 (salvo done, repeat at 0.6)
    expect(cm.length).toBe(2);
    w.run(0.9); // 1.3 s: salvos at 0.6 and 1.2 started
    expect(cm.length).toBe(5);
    f35.input.flare = false;
    w.run(1);
    expect(cm.length).toBe(6);
    expect(f35.flares).toBe(start - 6);
    expect(cm.every((c) => c.decoy.type === 'flare' && c.ownerId === f35.id)).toBe(true);
    // flares fall and burn out after ~3.5 s
    const d = cm[0].decoy;
    expect(d.velocity.y).toBeLessThan(-5);
    w.run(FLARE_LIFE);
    expect(d.alive).toBe(false);
  });

  it('chaff blooms and drifts; nothing is dispensed when empty', () => {
    const w = new FakeWorld();
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 3000, 0), heading: 0, speed: 250, loadout: 'a2a_stealth' });
    const cm = w.record('countermeasure');
    f35.input.chaff = true;
    w.run(0.05);
    f35.input.chaff = false;
    w.run(1);
    expect(cm.length).toBe(2);
    const c = cm[0].decoy;
    expect(c.type).toBe('chaff');
    expect(c.velocity.length()).toBeLessThan(30); // stopped in the airstream
    expect(c.radius).toBeGreaterThan(10);
    f35.chaff = 0;
    f35.input.chaff = true;
    w.run(1);
    expect(cm.length).toBe(2);
  });
});
