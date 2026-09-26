import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { atmosphere } from '../src/core/atmosphere';
import { AB_DETENT, type AircraftType, type Difficulty } from '../src/core/types';
import { AIRCRAFT_PERF } from '../src/sim/flight/aircraftData';
import { liftCoefficient, alphaForLift } from '../src/sim/flight/aero';
import { DEG, KT, makeWorld, run, type TestWorld } from './sim-fakes';

function spawnF35(tw: TestWorld, alt: number, tas: number, extra: { heading?: number; fuel?: number } = {}) {
  return tw.world.spawnAircraft({
    type: 'f35a',
    team: 'blue',
    isPlayer: true,
    position: new Vector3(0, alt, 0),
    heading: extra.heading ?? 0,
    speed: tas,
    loadout: 'a2a_stealth',
    fuel: extra.fuel ?? 0.6,
  });
}

const tasFromIas = (ias: number, alt: number) => ias / Math.sqrt(atmosphere(alt).sigma);

describe('aircraft performance data', () => {
  it('has realistic F-35A numbers', () => {
    const p = AIRCRAFT_PERF.f35a;
    expect(p.emptyMass).toBe(13_290);
    expect(p.internalFuel).toBe(8_278);
    expect(p.wingArea).toBeCloseTo(42.7);
    expect(p.thrustDry).toBeCloseTo(125_000, -3);
    expect(p.thrustAB).toBeCloseTo(191_000, -3);
    expect(p.maxG).toBe(9);
    expect(p.minG).toBe(-3);
    expect(p.maxMach).toBeCloseTo(1.6);
    expect(p.rcs).toBeLessThanOrEqual(0.001);
    expect(p.aoaLimitAssisted / DEG).toBeCloseTo(28);
    expect(p.aoaLimitUnassisted / DEG).toBeCloseTo(50);
  });
  it('lift curve is continuous, peaks at the stall AoA and inverts', () => {
    for (const type of Object.keys(AIRCRAFT_PERF) as AircraftType[]) {
      const p = AIRCRAFT_PERF[type];
      let prev = liftCoefficient(p, -Math.PI, 0.3);
      for (let a = -Math.PI; a <= Math.PI; a += 0.25 * DEG) {
        const cl = liftCoefficient(p, a, 0.3);
        expect(Number.isFinite(cl)).toBe(true);
        expect(Math.abs(cl - prev)).toBeLessThan(0.08);
        prev = cl;
      }
      const clStall = liftCoefficient(p, p.alphaStall, 0.3);
      expect(clStall).toBeGreaterThan(liftCoefficient(p, p.alphaStall - 5 * DEG, 0.3));
      expect(clStall).toBeGreaterThan(liftCoefficient(p, p.alphaStall + 5 * DEG, 0.3));
      const a = alphaForLift(p, 0.5, 0.5, 1, -1);
      expect(liftCoefficient(p, a, 0.5)).toBeCloseTo(0.5, 3);
    }
  });
});

describe('flight model — F-35A (assisted)', () => {
  it('holds altitude with neutral stick (250 m/s, 3000 m, MIL-ish throttle)', () => {
    const tw = makeWorld('pilot');
    const ac = spawnF35(tw, 3000, 250);
    expect(ac.flight.alpha).toBeGreaterThan(0);
    let maxDev = 0;
    run(tw.world, 30, () => {
      ac.input.throttle = 0.8;
      maxDev = Math.max(maxDev, Math.abs(ac.position.y - 3000));
    });
    expect(ac.alive).toBe(true);
    expect(maxDev).toBeLessThan(50);
    expect(Math.abs(ac.flight.gLoad - 1)).toBeLessThan(0.1);
    expect(ac.flight.tas).toBeGreaterThan(250); // MIL-ish accelerates
  });

  it('pulls ~9 g at corner speed and never exceeds the limit', () => {
    const tw = makeWorld('pilot');
    const ac = spawnF35(tw, 3000, tasFromIas(400 * KT, 3000));
    let gMax = 0;
    run(tw.world, 3, () => {
      ac.input.throttle = AB_DETENT;
      ac.input.pitch = 1;
      gMax = Math.max(gMax, ac.flight.gLoad);
    });
    expect(gMax).toBeGreaterThan(8.6);
    expect(gMax).toBeLessThan(9.3);
    expect(ac.flight.overstress).toBe(0);
  });

  it('bleeds speed in a sustained max-g turn at MIL', () => {
    const tw = makeWorld('pilot');
    const ac = spawnF35(tw, 3000, tasFromIas(420 * KT, 3000));
    const v0 = ac.flight.tas;
    let gMax = 0;
    run(tw.world, 10, (t) => {
      ac.input.throttle = AB_DETENT;
      // hold ~80° of bank, full aft stick after the roll-in
      ac.input.roll = Math.max(-1, Math.min(1, (80 * DEG - ac.flight.roll) * 2));
      ac.input.pitch = t > 0.5 ? 1 : 0;
      gMax = Math.max(gMax, ac.flight.gLoad);
    });
    expect(gMax).toBeLessThan(9.3);
    expect(ac.flight.tas).toBeLessThan(v0 - 60);
    expect(ac.alive).toBe(true);
  });

  it('accelerates past Mach 1.4 at 10 km in afterburner in reasonable time', () => {
    const tw = makeWorld('pilot');
    const a = atmosphere(10_000).speedOfSound;
    const ac = spawnF35(tw, 10_000, 0.9 * a);
    const transonic: boolean[] = [];
    tw.events.on('transonic', (e) => transonic.push(e.supersonic));
    const t = run(tw.world, 150, () => {
      ac.input.throttle = 1;
      return ac.flight.mach > 1.4;
    });
    expect(ac.flight.mach).toBeGreaterThan(1.4);
    expect(t).toBeLessThan(120);
    expect(Math.abs(ac.position.y - 10_000)).toBeLessThan(300);
    expect(transonic).toContain(true);
    expect(ac.flight.supersonic).toBe(true);
  });

  it('rolls at ~180-220 °/s with full stick at 400 kt', () => {
    const tw = makeWorld('pilot');
    const ac = spawnF35(tw, 3000, tasFromIas(400 * KT, 3000));
    let pMax = 0;
    run(tw.world, 1.5, () => {
      ac.input.roll = 1;
      pMax = Math.max(pMax, ac.rates.x);
    });
    expect(pMax / DEG).toBeGreaterThan(180);
    expect(pMax / DEG).toBeLessThan(225);
  });

  it('AoA limiter holds ~28° at low speed and prevents the stall', () => {
    const tw = makeWorld('pilot');
    const ac = spawnF35(tw, 4000, 130);
    let aMax = 0;
    let stalled = false;
    run(tw.world, 8, () => {
      ac.input.throttle = AB_DETENT;
      ac.input.pitch = 1;
      aMax = Math.max(aMax, ac.flight.alpha);
      stalled ||= ac.flight.stalled;
    });
    expect(aMax / DEG).toBeGreaterThan(24);
    expect(aMax / DEG).toBeLessThan(29.5);
    expect(stalled).toBe(false);
  });

  it('neutral stick commands ~1 g (flight path held) after a pull', () => {
    const tw = makeWorld('pilot');
    const ac = spawnF35(tw, 5000, 230);
    run(tw.world, 1.5, () => {
      ac.input.pitch = 0.4;
    });
    const gammaAfterPull = Math.asin(ac.velocity.y / ac.velocity.length());
    expect(gammaAfterPull).toBeGreaterThan(5 * DEG);
    run(tw.world, 1, () => {
      ac.input.pitch = 0;
    });
    const g1 = Math.asin(ac.velocity.y / ac.velocity.length());
    run(tw.world, 4, () => {
      ac.input.pitch = 0;
      ac.input.throttle = 1;
    });
    const g2 = Math.asin(ac.velocity.y / ac.velocity.length());
    expect(Math.abs(g2 - g1)).toBeLessThan(2 * DEG);
  });
});

describe('flight model — unassisted (ace)', () => {
  it('departs when over-pulled at low speed and recovers when unloaded', () => {
    const tw = makeWorld('ace');
    const ac = spawnF35(tw, 6000, 140);
    let aMax = 0;
    let stalled = false;
    run(tw.world, 5, () => {
      ac.input.throttle = AB_DETENT;
      ac.input.pitch = 1;
      aMax = Math.max(aMax, ac.flight.alpha);
      stalled ||= ac.flight.stalled;
    });
    expect(aMax).toBeGreaterThan(AIRCRAFT_PERF.f35a.alphaStall);
    expect(stalled).toBe(true);
    // unload
    run(tw.world, 2, () => {
      ac.input.pitch = -0.4;
      ac.input.roll = 0;
    });
    run(tw.world, 4, () => {
      ac.input.pitch = 0;
    });
    expect(ac.flight.stalled).toBe(false);
    expect(ac.flight.alpha).toBeLessThan(AIRCRAFT_PERF.f35a.alphaStall - 5 * DEG);
    expect(ac.alive).toBe(true);
  });

  it('a developed departure (spin) recovers once the stick is released', () => {
    const tw = makeWorld('ace');
    const ac = spawnF35(tw, 6000, 250);
    let depMax = 0;
    run(tw.world, 6, () => {
      ac.input.throttle = AB_DETENT;
      ac.input.pitch = 1;
      depMax = Math.max(depMax, ac.sim!.departure);
    });
    expect(depMax).toBeGreaterThan(0.5);
    run(tw.world, 4, () => {
      ac.input.pitch = 0;
    });
    expect(ac.sim!.departure).toBeLessThan(0.05);
    expect(Math.abs(ac.flight.beta)).toBeLessThan(5 * DEG);
    expect(ac.flight.stalled).toBe(false);
  });

  it('can over-G and accumulates overstress (damage) without the limiter', () => {
    const tw = makeWorld('ace');
    const ac = spawnF35(tw, 3000, 300);
    let gMax = 0;
    run(tw.world, 4, () => {
      ac.input.throttle = 1;
      ac.input.pitch = 1;
      gMax = Math.max(gMax, ac.flight.gLoad);
    });
    expect(gMax).toBeGreaterThan(10);
    const damaged = ac.flight.overstress > 0 || ac.health < ac.maxHealth;
    expect(damaged).toBe(true);
    expect(tw.of('damage').some((d) => d.weapon === 'collision')).toBe(true);
  });
});

describe('engine', () => {
  it('spools idle → MIL in ~3-4 s and lights the afterburner after ~0.4 s', () => {
    const tw = makeWorld('pilot');
    const ac = spawnF35(tw, 5000, 250);
    run(tw.world, 10, () => {
      ac.input.throttle = 0;
    });
    expect(ac.sim!.power).toBeLessThan(0.02);
    const rpmIdle = ac.flight.engineRpm;
    const tMil = run(tw.world, 10, () => {
      ac.input.throttle = AB_DETENT;
      return ac.sim!.power >= 0.9;
    });
    expect(tMil).toBeGreaterThan(2.5);
    expect(tMil).toBeLessThan(4.5);
    expect(ac.flight.engineRpm).toBeGreaterThan(rpmIdle + 0.2);
    run(tw.world, 3, () => {
      ac.input.throttle = AB_DETENT;
    });
    const thrustMil = ac.flight.thrust;
    const tLight = run(tw.world, 3, () => {
      ac.input.throttle = 1;
      return ac.flight.afterburner > 0;
    });
    expect(tLight).toBeGreaterThanOrEqual(0.35);
    expect(tLight).toBeLessThan(0.8);
    run(tw.world, 1.5, () => {
      ac.input.throttle = 1;
    });
    expect(ac.flight.thrust).toBeGreaterThan(thrustMil * 1.3);
  });

  it('burns much more fuel in afterburner', () => {
    const tw = makeWorld('veteran');
    const ac = spawnF35(tw, 5000, 250);
    run(tw.world, 6, () => {
      ac.input.throttle = AB_DETENT;
    });
    const ffMil = ac.flight.fuelFlow;
    const fuel0 = ac.flight.fuel;
    run(tw.world, 6, () => {
      ac.input.throttle = 1;
    });
    const ffAb = ac.flight.fuelFlow;
    expect(ffMil).toBeGreaterThan(0.5);
    expect(ffAb).toBeGreaterThan(2 * ffMil);
    expect(ac.flight.fuel).toBeLessThan(fuel0);
    expect(ac.flight.mass).toBeGreaterThan(AIRCRAFT_PERF.f35a.emptyMass);
  });

  it('flames out at zero fuel and glides', () => {
    const tw = makeWorld('pilot');
    const ac = spawnF35(tw, 8000, 230, { fuel: 0.001 });
    run(tw.world, 5, () => {
      ac.input.throttle = 1;
    });
    expect(ac.flight.fuel).toBe(0);
    expect(ac.flight.thrust).toBe(0);
    expect(ac.alive).toBe(true);
    expect(ac.warnings.has('engine_fail')).toBe(true);
  });
});

describe('stability', () => {
  const types: AircraftType[] = ['f35a', 'mig29', 'su27', 'su35', 'su57', 'tu22m', 'a50'];
  for (const diff of ['pilot', 'ace'] as Difficulty[]) {
    it(`every type survives random stick abuse without NaNs (${diff})`, () => {
      const tw = makeWorld(diff);
      const list = types.map((type, i) =>
        tw.world.spawnAircraft({
          type,
          team: 'red',
          isPlayer: type === 'f35a',
          position: new Vector3(i * 2000, 8000, 0),
          heading: i,
          speed: 200 + i * 10,
        }),
      );
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
      run(tw.world, 40, (t) => {
        if (Math.round(t * 60) % 20 === 0) {
          for (const ac of list) {
            ac.input.pitch = rnd();
            ac.input.roll = rnd();
            ac.input.yaw = rnd() * 0.5;
            ac.input.throttle = (rnd() + 1) / 2;
          }
        }
      });
      for (const ac of list) {
        for (const v of [ac.position.x, ac.position.y, ac.position.z, ac.velocity.length(), ac.quaternion.w, ac.flight.alpha, ac.flight.gLoad]) {
          expect(Number.isFinite(v)).toBe(true);
        }
        expect(ac.velocity.length()).toBeLessThan(900);
        expect(Math.abs(ac.quaternion.length() - 1)).toBeLessThan(1e-6);
      }
    });
  }
});

describe('Auto-GCAS', () => {
  /** Push into a ~35° dive, then let go (the assisted law holds the dive angle). */
  function diveAtGround(difficulty: Difficulty, onStep?: (ac: ReturnType<typeof spawnF35>) => void) {
    const tw = makeWorld(difficulty);
    const ac = spawnF35(tw, 1800, 230);
    run(tw.world, 25, (t) => {
      ac.input.throttle = 0.7;
      ac.input.pitch = t < 2.2 ? -1 : 0;
      onStep?.(ac);
    });
    return { tw, ac };
  }
  it('recovers an assisted jet diving at the ground and says AUTO GCAS', () => {
    let gcasSeen = false;
    let minGamma = 0;
    const { tw, ac } = diveAtGround('pilot', (a) => {
      gcasSeen ||= !!a.gcasActive;
      minGamma = Math.min(minGamma, Math.asin(a.velocity.y / a.velocity.length()));
    });
    expect(minGamma).toBeLessThan(-15 * DEG);
    expect(gcasSeen).toBe(true);
    expect(ac.alive).toBe(true);
    expect(tw.of('hud:message').some((m) => m.text === 'AUTO GCAS')).toBe(true);
    expect(tw.of('player:down')).toHaveLength(0);
    expect(ac.gcasActive).toBe(false); // hands control back after the recovery
  });
  it('does not save an unassisted (ace) pilot', () => {
    const { tw, ac } = diveAtGround('ace');
    expect(ac.alive).toBe(false);
    expect(tw.of('player:down')[0]?.reason).toBe('crash');
  });
});
