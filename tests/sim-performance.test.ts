import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { atmosphere } from '../src/core/atmosphere';
import {
  availableG,
  cornerSpeedIas,
  specificExcessPower,
  stallSpeedIas,
  stickForG,
  turnRate,
  AIRCRAFT_PERF,
} from '../src/sim/flight';
import { DEG, KT, flatTerrain, makeWorld, run } from './sim-fakes';

describe('performance helpers (AI)', () => {
  it('corner / stall speeds and available g are sensible for the F-35A', () => {
    const tw = makeWorld('pilot');
    const ac = tw.world.spawnAircraft({ type: 'f35a', team: 'blue', position: new Vector3(0, 3000, 0), heading: 0, speed: 240, loadout: 'a2a_stealth', fuel: 0.5 });
    const corner = cornerSpeedIas(ac) / KT;
    expect(corner).toBeGreaterThan(340);
    expect(corner).toBeLessThan(450);
    const stall = stallSpeedIas(ac) / KT;
    expect(stall).toBeGreaterThan(100);
    expect(stall).toBeLessThan(160);
    expect(availableG(ac)).toBeGreaterThan(5);
    expect(availableG(ac)).toBeLessThanOrEqual(9);
    expect(turnRate(ac, 9)).toBeGreaterThan(turnRate(ac, 5));
  });

  it('stickForG commands the requested load factor', () => {
    const tw = makeWorld('pilot');
    const ac = tw.world.spawnAircraft({ type: 'su27', team: 'red', position: new Vector3(0, 4000, 0), heading: 0, speed: 260 });
    let g = 0;
    run(tw.world, 2, () => {
      ac.input.pitch = stickForG(ac, 5);
      g = ac.flight.gLoad;
    });
    expect(g).toBeGreaterThan(4.6);
    expect(g).toBeLessThan(5.4);
  });

  it('specific excess power: positive at 1 g in AB, negative at 9 g on MIL', () => {
    const tw = makeWorld('pilot');
    const ac = tw.world.spawnAircraft({ type: 'f35a', team: 'blue', position: new Vector3(0, 3000, 0), heading: 0, speed: 250 });
    expect(specificExcessPower(ac, 1, true)).toBeGreaterThan(50);
    expect(specificExcessPower(ac, 9, false)).toBeLessThan(0);
  });

  it('every type trims in level flight at a typical speed', () => {
    for (const type of Object.keys(AIRCRAFT_PERF) as (keyof typeof AIRCRAFT_PERF)[]) {
      const tw = makeWorld('pilot');
      // the Shahed flies a scripted profile while alive (sim/drone/oneWay.ts) and its flight-model
      // numbers only fly the wreck: trim it at its own cruise point
      const alt = type === 'a50' || type === 'tu22m' ? 8000 : type === 'shahed136' ? 1000 : 5000;
      const speed = type === 'a50' ? 200 : type === 'shahed136' ? 51 : 240;
      const ac = tw.world.spawnAircraft({ type, team: 'red', position: new Vector3(0, alt, 0), heading: 1, speed });
      run(tw.world, 15);
      expect(Math.abs(ac.position.y - alt)).toBeLessThan(60);
      expect(Math.abs(ac.flight.tas - speed)).toBeLessThan(25);
      expect(ac.flight.alpha).toBeGreaterThan(0);
      expect(ac.flight.alpha).toBeLessThan(AIRCRAFT_PERF[type].alphaStall);
    }
  });

  it('corner speed of each fighter is within a plausible band', () => {
    for (const type of ['f35a', 'mig29', 'su27', 'su35', 'su57'] as const) {
      const tw = makeWorld('pilot');
      const ac = tw.world.spawnAircraft({ type, team: 'red', position: new Vector3(0, 3000, 0), heading: 0, speed: 250 });
      const kt = cornerSpeedIas(ac) / KT;
      expect(kt).toBeGreaterThan(300);
      expect(kt).toBeLessThan(480);
      expect(atmosphere(3000).sigma).toBeLessThan(1);
    }
  });
});

describe('Auto-GCAS robustness', () => {
  it('an assisted F-35 flown with random stick inputs never hits the ground', () => {
    const tw = makeWorld('pilot');
    const jets = [0, 1, 2, 3].map((i) =>
      tw.world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: i === 0, position: new Vector3(i * 3000, 2000, 0), heading: i, speed: 240, loadout: 'a2a_stealth' }),
    );
    run(tw.world, 60, (t) => {
      for (const ac of jets) {
        ac.input.pitch = Math.sin(t * 1.1 + ac.id) * 0.7;
        ac.input.roll = Math.cos(t * 0.6 + ac.id * 2) * 0.6;
        ac.input.throttle = 0.8;
      }
    });
    for (const ac of jets) expect(ac.alive).toBe(true);
  });

  it('climbs over a ridge the pilot is flying straight into', () => {
    const tw = makeWorld('pilot', flatTerrain(0, { z: -6000, height: 800 }));
    const ac = tw.world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 300, 0), heading: 0, speed: 250 });
    let gcas = false;
    run(tw.world, 40, () => {
      ac.input.throttle = 0.85;
      gcas ||= !!ac.gcasActive;
    });
    expect(gcas).toBe(true);
    expect(ac.alive).toBe(true);
    expect(ac.position.z).toBeLessThan(-6000);
    expect(ac.position.y).toBeGreaterThan(800);
  });

  it('stays out of the way of a pilot who is already recovering', () => {
    const tw = makeWorld('pilot');
    const ac = tw.world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 2500, 0), heading: 0, speed: 230 });
    let gcas = false;
    // dive at ~30°, then a firm 7 g pull well above the ground
    run(tw.world, 20, (t) => {
      ac.input.pitch = t < 2.2 ? -1 : t < 6 ? 0 : 0.8;
      gcas ||= !!ac.gcasActive;
    });
    expect(ac.alive).toBe(true);
    expect(gcas).toBe(false);
    expect(ac.velocity.y).toBeGreaterThan(0);
    expect(DEG).toBeGreaterThan(0);
  });
});
