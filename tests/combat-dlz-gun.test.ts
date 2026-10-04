import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { FakeWorld, v3 } from './combat-helpers';
import { GUNS, MUNITIONS } from '../src/sim/weapons/defs';
import { gpsMaxRange, type CombatLaunchZone } from '../src/sim/weapons/dlz';
import { DEFAULT_PIPPER_RANGE } from '../src/sim/weapons/gun';
import type { AircraftEntity } from '../src/sim/entities';

function zone(opts: { alt?: number; tAlt?: number; speed?: number; tHeading?: number; range?: number; difficulty?: 'recruit' | 'veteran' }) {
  const w = new FakeWorld({ difficulty: opts.difficulty ?? 'veteran' });
  const alt = opts.alt ?? 6000;
  const a = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, alt, 0), heading: 0, speed: opts.speed ?? 280, loadout: 'a2a_beast' });
  const b = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, opts.tAlt ?? alt, -(opts.range ?? 20000)), heading: opts.tHeading ?? Math.PI, speed: 280 });
  w.run(0.2);
  return { w, a, b, z: w.combat.launchZoneFor(a, 'aim120', b, w) };
}

describe('combat: dynamic launch zone', () => {
  it('rMax grows with altitude and launch speed', () => {
    const lo = zone({ alt: 1000 }).z.rMax;
    const mid = zone({ alt: 5000 }).z.rMax;
    const hi = zone({ alt: 9000 }).z.rMax;
    expect(mid).toBeGreaterThan(lo * 1.15);
    expect(hi).toBeGreaterThan(mid * 1.15);
    const slow = zone({ speed: 200 }).z.rMax;
    const fast = zone({ speed: 400 }).z.rMax;
    expect(fast).toBeGreaterThan(slow * 1.05);
    // shooting down is easier than shooting up
    expect(zone({ alt: 9000, tAlt: 4000 }).z.rMax).toBeGreaterThan(zone({ alt: 4000, tAlt: 9000 }).z.rMax);
  });

  it('head-on > beam > tail; rMin < rNe < rMax; tof grows with range', () => {
    const head = zone({ tHeading: Math.PI }).z;
    const beam = zone({ tHeading: Math.PI / 2 }).z;
    const tail = zone({ tHeading: 0, range: 8000 }).z;
    expect(head.rMax).toBeGreaterThan(beam.rMax);
    expect(beam.rMax).toBeGreaterThan(tail.rMax);
    for (const z of [head, beam, tail]) {
      expect(z.rMin).toBeLessThan(z.rNe);
      expect(z.rNe).toBeLessThanOrEqual(z.rMax);
    }
    expect(head.closure).toBeGreaterThan(500);
    expect(tail.closure).toBeLessThan(50);
    const near = zone({ range: 10000 }).z.timeOfFlight;
    const far = zone({ range: 25000 }).z.timeOfFlight;
    expect(far).toBeGreaterThan(near);
    // AIM-120 reference: ~30 km co-alt head-on at 6 km, NEZ ~10 km
    expect(head.rMax).toBeGreaterThan(25_000);
    expect(head.rMax).toBeLessThan(40_000);
  });

  it('SHOOT only inside the Pk-calibrated range (rNe ≤ rShoot ≤ 0.9·rMax); generous cues never go beyond it', () => {
    for (const difficulty of ['veteran', 'recruit'] as const) {
      const t = zone({ difficulty });
      const rShoot = (t.z as CombatLaunchZone).rShoot;
      expect(rShoot).toBeGreaterThanOrEqual(t.z.rNe * 0.8);
      expect(rShoot).toBeLessThanOrEqual(t.z.rMax * 0.9);
      expect(rShoot).toBeLessThanOrEqual(t.z.rNe * 1.36);
      // between rShoot and rMax: in range but no SHOOT (the reviewers' 1.1·rMax cue is gone)
      for (const frac of [1.05, 0.95, 0.8]) {
        t.b.position.set(0, 6000, -t.z.rMax * frac);
        t.w.run(0.2);
        const z = t.w.combat.launchZoneFor(t.a, 'aim120', t.b, t.w) as CombatLaunchZone;
        if (z.range > z.rShoot) expect(z.shoot, `${difficulty} @${frac}·rMax`).toBe(false);
      }
      t.b.position.set(0, 6000, -rShoot * 0.8);
      t.w.run(0.2);
      const zIn = t.w.combat.launchZoneFor(t.a, 'aim120', t.b, t.w) as CombatLaunchZone;
      expect(zIn.range).toBeLessThan(zIn.rShoot);
      expect(zIn.shoot).toBe(true);
    }
    // HUD helper: selected weapon vs designated target
    const rec = zone({ difficulty: 'recruit' });
    const hud = rec.w.combat.launchZone(rec.a, rec.w);
    expect(hud?.targetId).toBe(rec.b.id);
    rec.w.combat.designate(rec.a, null, rec.w);
    rec.b.alive = false;
    expect(rec.w.combat.launchZone(rec.a, rec.w)).toBeNull();
  });

  it('SHOOT range is shorter against a hot bandit than its kinematic rMax, and shorter for a TWS than an STT shot', () => {
    const t = zone({ range: 16000 });
    t.w.run(0.3);
    const tws = t.w.combat.launchZoneFor(t.a, 'aim120', t.b, t.w) as CombatLaunchZone;
    t.w.combat.designate(t.a, t.b.id, t.w);
    t.w.run(1.8);
    expect(t.a.radar.lockedId).toBe(t.b.id);
    const stt = t.w.combat.launchZoneFor(t.a, 'aim120', t.b, t.w) as CombatLaunchZone;
    expect(stt.rShoot).toBeLessThan(stt.rMax * 0.6);
    expect(tws.rShoot).toBeLessThan(stt.rShoot);
    // an AI shooter still gets the kinematic cue (its own doctrine picks the range)
    const ai = t.w.spawnAircraft({ type: 'su27', team: 'red', position: v3(30000, 6000, -20000), heading: 0, speed: 280 });
    const blue = t.w.spawnAircraft({ type: 'mig29', team: 'blue', position: v3(30000, 6000, -40000), heading: Math.PI, speed: 280 });
    t.w.run(0.5);
    ai.radar.designatedId = blue.id;
    t.w.run(3);
    const zAi = t.w.combat.launchZoneFor(ai, 'aim120', blue, t.w);
    expect(zAi.range).toBeGreaterThan((zAi as CombatLaunchZone).rShoot);
    expect(zAi.shoot).toBe(true);
  });

  it('GPS envelopes: SDB II (GBU-53) standoff ≫ JDAM, higher and faster releases reach further', () => {
    const jdam = gpsMaxRange(MUNITIONS.gbu31, 9000, 250, 0);
    const sdb = gpsMaxRange(MUNITIONS.gbu53, 9000, 250, 0);
    expect(sdb).toBeGreaterThan(2 * jdam);
    expect(sdb).toBeGreaterThan(18_000);
    expect(jdam).toBeGreaterThan(5_000);
    expect(gpsMaxRange(MUNITIONS.gbu53, 4000, 250, 0)).toBeLessThan(sdb);
    expect(gpsMaxRange(MUNITIONS.gbu31, 9000, 320, 0)).toBeGreaterThan(jdam);
  });

  it('CCIP predicts a ground impact ahead of the jet', () => {
    const w = new FakeWorld();
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 3000, 0), heading: 0, speed: 250, loadout: 'strike_stealth' });
    w.run(0.1);
    expect(f35.radar.groundPoint).toBeNull();
    const r = w.combat.bombImpactPoint(f35, w)!;
    expect(r).not.toBeNull();
    expect(r.point.y).toBeCloseTo(0, 0);
    expect(-r.point.z).toBeGreaterThan(3000);
    expect(-r.point.z).toBeLessThan(250 * Math.sqrt((2 * 3000) / 9.81));
    expect(Math.abs(r.point.x)).toBeLessThan(10);
    expect(r.inRange).toBe(true);
    // an unguided drop lands close to the CCIP point
    const cc = r.point.clone();
    const ends = w.record('munition:end');
    w.combat.fire(f35, w, 'gbu31');
    w.run(60, () => ends.length > 0);
    expect(ends[0].position.distanceTo(cc)).toBeLessThan(60);
  });
});

describe('combat: guns', () => {
  it('GAU-22: 3,300 rpm, 180 rounds ≈ 3.3 s, tracer every 4th, gun:state events', () => {
    const w = new FakeWorld();
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 3000, 0), heading: 0, speed: 250, loadout: 'a2a_stealth' });
    const states = w.record('gun:state');
    f35.input.fireGun = true;
    w.run(1);
    expect(f35.gunFiring).toBe(true);
    expect(180 - f35.gunAmmo).toBeGreaterThanOrEqual(53);
    expect(180 - f35.gunAmmo).toBeLessThanOrEqual(57);
    const active = w.projectiles.filter((p) => p.active);
    const tracers = active.filter((p) => p.tracer).length;
    expect(tracers / active.length).toBeGreaterThan(0.2);
    expect(tracers / active.length).toBeLessThan(0.3);
    w.run(2.5);
    expect(f35.gunAmmo).toBe(0);
    expect(f35.gunFiring).toBe(false);
    expect(states.map((s) => s.firing)).toEqual([true, false]);
    expect(states[0]).toMatchObject({ weapon: 'gau22', shooterId: f35.id });
    // rounds leave at ~1,040 m/s relative to the jet
    const p = w.projectiles.find((q) => q.active)!;
    expect(p.velocity.length()).toBeGreaterThan(900);
  });

  it('LCOS pipper: rounds fired with the target on the pipper hit a constant-velocity target', () => {
    const disp = GUNS.gau22.dispersion;
    GUNS.gau22.dispersion = 0;
    try {
      for (const tv of [new Vector3(120, 0, 0), new Vector3(-80, 30, -150), new Vector3(0, 0, 200)]) {
        const w = new FakeWorld();
        const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 3000, 0), heading: 0, speed: 240, loadout: 'a2a_stealth' });
        const tgt = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(20, 3010, -700), heading: 0, speed: 1 });
        tgt.velocity.copy(tv);
        w.run(0.3);
        f35.radar.designatedId = tgt.id;
        // put the target on the pipper (fixed point: the pipper depends on the target's range)
        for (let i = 0; i < 6; i++) {
          const p = w.combat.gunLeadPoint(f35, w)!;
          tgt.position.copy(p);
        }
        const before = tgt.health;
        f35.input.fireGun = true;
        w.step();
        f35.input.fireGun = false;
        w.run(2);
        expect(tgt.health, `target velocity ${tv.toArray()}`).toBeLessThan(before);
      }
    } finally {
      GUNS.gau22.dispersion = disp;
    }
  });

  it('GAU-22 (25 mm APEX): a fighter falls to 4–8 hits inside 800 m, still ≤ 9 hits at 1.2 km', () => {
    const disp = GUNS.gau22.dispersion;
    GUNS.gau22.dispersion = 0;
    try {
      for (const range of [300, 600, 800, 1200]) {
        const w = new FakeWorld();
        const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 3000, 0), heading: 0, speed: 240, loadout: 'a2a_stealth' });
        const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 3000, -range), heading: 0, speed: 230 });
        w.run(0.3);
        w.combat.designate(f35, mig.id, w);
        w.controllers.set(mig.id, () => {
          // keep the target sitting on the pipper at a constant range
          const p = w.combat.gunLeadPoint(f35, w)!;
          const d = p.clone().sub(f35.position).setLength(range);
          mig.position.copy(f35.position).add(d);
          mig.velocity.copy(f35.velocity).multiplyScalar(230 / 240);
        });
        f35.input.fireGun = true;
        w.run(3.4, () => !mig.alive);
        const hits = w.damageLog.filter((d) => d.targetId === mig.id && d.weapon === 'gun').length;
        expect(mig.alive, `range ${range}`).toBe(false);
        if (range <= 800) {
          expect(hits, `range ${range}`).toBeGreaterThanOrEqual(4);
          expect(hits, `range ${range}`).toBeLessThanOrEqual(8);
        } else expect(hits).toBeLessThanOrEqual(9);
        expect(f35.gunAmmo, 'most of the 180 rounds left for more kills').toBeGreaterThan(90);
      }
    } finally {
      GUNS.gau22.dispersion = disp;
    }
  });

  it('gun cue: funnel to 1.5 km, SHOOT only inside 1.2 km with the pipper on the target', () => {
    const w = new FakeWorld();
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 3000, 0), heading: 0, speed: 240, loadout: 'a2a_stealth' });
    const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 3000, -700), heading: 0, speed: 240 });
    w.combat.selectWeapon(f35, 'gun', w);
    w.run(0.3);
    w.combat.designate(f35, mig.id, w);
    const place = (range: number, offRad: number) => {
      const p = w.combat.gunLeadPoint(f35, w)!;
      const d = p.clone().sub(f35.position).normalize();
      d.applyAxisAngle(new Vector3(0, 1, 0), offRad);
      mig.position.copy(f35.position).addScaledVector(d, range);
      return w.combat.launchZone(f35, w)!;
    };
    let z = place(700, 0);
    for (let i = 0; i < 4; i++) z = place(700, 0);
    expect(z.weapon).toBe('gun');
    expect(z.rMax).toBe(1500);
    expect(z.rNe).toBe(800);
    expect(z.shoot).toBe(true);
    for (let i = 0; i < 4; i++) z = place(700, 0.05); // 3° off the pipper
    expect(z.shoot).toBe(false);
    for (let i = 0; i < 4; i++) z = place(1350, 0); // on the pipper, but beyond the effective range
    expect(z.range).toBeGreaterThan(1300);
    expect(z.shoot).toBe(false);
    for (let i = 0; i < 4; i++) z = place(1100, 0);
    expect(z.shoot).toBe(true);
  });

  it('pipper defaults to the 1,000 ft range line with no target', () => {
    const w = new FakeWorld();
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 3000, 0), heading: 0, speed: 250, loadout: 'a2a_stealth' });
    w.run(0.1);
    const p = w.combat.gunLeadPoint(f35, w)!;
    const d = p.distanceTo(f35.position);
    expect(d).toBeGreaterThan(DEFAULT_PIPPER_RANGE * 0.9);
    expect(d).toBeLessThan(DEFAULT_PIPPER_RANGE * 1.4);
    expect(p.z).toBeLessThan(-250);
    expect(p.y).toBeLessThan(3000.5); // gravity drop
  });

  it('strafing damages ground targets', () => {
    const w = new FakeWorld();
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 400, 0), heading: 0, speed: 200, loadout: 'a2a_stealth' });
    const jet = w.spawnGround({ type: 'parked_jet', team: 'red', position: v3(0, 0, -1500), health: 60 });
    // aim the nose at the parked jet
    const dir = new Vector3().subVectors(jet.position, f35.position).normalize();
    f35.quaternion.setFromUnitVectors(new Vector3(0, 0, -1), dir);
    f35.velocity.copy(dir).multiplyScalar(200);
    f35.input.fireGun = true;
    w.run(1);
    f35.input.fireGun = false;
    w.run(2);
    expect(jet.health).toBeLessThan(60);
    const shooter: AircraftEntity = f35;
    expect(shooter.hits).toBeGreaterThanOrEqual(1);
  });
});
