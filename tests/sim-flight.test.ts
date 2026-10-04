import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { atmosphere } from '../src/core/atmosphere';
import { AB_DETENT, type AircraftType, type Difficulty } from '../src/core/types';
import { AIRCRAFT_PERF } from '../src/sim/flight/aircraftData';
import { liftCoefficient, alphaForLift, dragCoefficient, thrustMil } from '../src/sim/flight/aero';
import { rollRateLimit } from '../src/sim/flight/controlLaws';
import { GLOC } from '../src/sim/flight/gloc';
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
    expect(p.aoaLimit / DEG).toBeCloseTo(28);
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

describe('flight model — Ace keeps the F-35 carefree handling (regression i1)', () => {
  // Reviewer: Ace multiplied the g limit by 1.35 and let the AoA reach 50°, so a full-stick
  // "thumb flick" over-G'd (12.2 g, health 70 in 6 s) or departed the jet.
  for (const spd of [250, 300, 350]) {
    it(`full aft stick at ${spd} m/s on Ace: ≤ 9.3 g, no overstress, no damage`, () => {
      const tw = makeWorld('ace');
      const ac = spawnF35(tw, 3000, spd);
      let gMax = 0;
      run(tw.world, 6, () => {
        ac.input.throttle = 0.9;
        ac.input.pitch = 1;
        ac.input.roll = 0;
        gMax = Math.max(gMax, ac.flight.gLoad);
      });
      expect(gMax).toBeGreaterThan(8.5);
      expect(gMax).toBeLessThan(9.3);
      expect(ac.flight.overstress).toBe(0);
      expect(ac.health).toBe(ac.maxHealth);
      expect(ac.damage.hydraulics).toBe(0);
      expect(tw.of('hud:message').some((m) => m.text === 'OVERSTRESS')).toBe(false);
    });
  }

  it('full aft stick + roll at low speed on Ace never departs (AoA limiter below the stall)', () => {
    const tw = makeWorld('ace');
    const ac = spawnF35(tw, 6000, 140);
    let aMax = 0;
    let stalled = false;
    let depMax = 0;
    run(tw.world, 8, (t) => {
      ac.input.throttle = AB_DETENT;
      ac.input.pitch = 1;
      ac.input.roll = t < 4 ? 0.5 : -1;
      aMax = Math.max(aMax, ac.flight.alpha);
      stalled ||= ac.flight.stalled;
      depMax = Math.max(depMax, ac.sim!.departure);
    });
    // i2: Ace opens the high-AoA regime at low speed (up to 1.5° under the 35° stall), still carefree
    expect(aMax / DEG).toBeLessThan(34);
    expect(stalled).toBe(false);
    expect(depMax).toBeLessThan(0.01);
  });

  it('the departure model still exists past the stall AoA (forced state) and recovers unloaded', () => {
    const tw = makeWorld('ace');
    const ac = spawnF35(tw, 6000, 120);
    // force a post-stall attitude (e.g. a tail slide the limiter could not prevent)
    ac.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), 45 * DEG);
    let depMax = 0;
    run(tw.world, 1.5, () => {
      ac.input.pitch = 1;
      depMax = Math.max(depMax, ac.sim!.departure);
    });
    expect(depMax).toBeGreaterThan(0.2);
    run(tw.world, 6, () => {
      ac.input.pitch = 0;
      ac.input.roll = 0;
    });
    expect(ac.sim!.departure).toBeLessThan(0.05);
    expect(ac.flight.stalled).toBe(false);
    expect(ac.alive).toBe(true);
  });

  it('Ace drops only the neutral-stick flight-path latch (the assisted law holds it)', () => {
    const drift = (diff: Difficulty) => {
      const tw = makeWorld(diff);
      const ac = spawnF35(tw, 5000, 230);
      run(tw.world, 1.5, () => {
        ac.input.pitch = 0.4;
      });
      run(tw.world, 1, () => {
        ac.input.pitch = 0;
      });
      const g1 = Math.asin(ac.velocity.y / ac.velocity.length());
      run(tw.world, 6, () => {
        ac.input.pitch = 0;
        ac.input.throttle = 1;
      });
      return Math.abs(Math.asin(ac.velocity.y / ac.velocity.length()) - g1);
    };
    expect(drift('pilot')).toBeLessThan(2 * DEG);
    expect(drift('ace')).toBeLessThan(12 * DEG); // still bank/γ-compensated 1 g, just no latch
  });
});

describe('G-LOC (Ace only)', () => {
  /** Hold ~9 g in a level-ish turn by pinning the speed (isolates the physiology model). */
  function sustainedPull(diff: Difficulty, seconds: number) {
    const tw = makeWorld(diff);
    const ac = spawnF35(tw, 5000, 300);
    const gTrace: { t: number; g: number; gloc: number; auth: number }[] = [];
    run(tw.world, seconds, (t) => {
      ac.input.throttle = 1;
      ac.input.pitch = 1;
      ac.input.roll = Math.max(-1, Math.min(1, (80 * DEG - ac.flight.roll) * 2));
      ac.velocity.setLength(300); // keep the energy up so the jet can hold the g
      gTrace.push({ t, g: ac.flight.gLoad, gloc: ac.gloc ?? 0, auth: ac.sim!.pilotAuthority });
    });
    return { tw, ac, gTrace };
  }

  it('sustained 9 g knocks the Ace pilot out after ~8-16 s; the stick is ignored, then control returns', () => {
    const { tw, ac, gTrace } = sustainedPull('ace', 30);
    const msg = tw.of('hud:message').find((m) => m.text === 'G-LOC');
    expect(msg).toBeTruthy();
    const out = gTrace.find((s) => s.gloc >= 1)!;
    expect(out.t).toBeGreaterThan(8);
    expect(out.t).toBeLessThan(16);
    // unconscious: full aft stick is ignored → the FBW unloads towards ~1-2 g
    const during = gTrace.filter((s) => s.t > out.t + 1.5 && s.t < out.t + GLOC.glocTime - 0.2);
    expect(Math.max(...during.map((s) => s.g))).toBeLessThan(3);
    expect(during.every((s) => s.auth === 0)).toBe(true);
    // wakes up and gets the stick back
    const back = gTrace.find((s) => s.t > out.t + GLOC.glocTime + GLOC.recoveryTime + 0.2);
    expect(back?.auth).toBe(1);
    expect(ac.alive).toBe(true);
  });

  it('no G-LOC on Pilot (vision effects only, HUD side)', () => {
    const { tw, gTrace } = sustainedPull('pilot', 25);
    expect(tw.of('hud:message').some((m) => m.text === 'G-LOC')).toBe(false);
    expect(gTrace.every((s) => s.auth === 1)).toBe(true);
  });

  it('short 9 g pulls (a break turn) do not G-LOC', () => {
    const { tw } = sustainedPull('ace', 6);
    expect(tw.of('hud:message').some((m) => m.text === 'G-LOC')).toBe(false);
  });
});

describe('flight model realism (regression i1)', () => {
  const mass = 13_290 + 0.6 * 8_278 + 4 * 161 + 180 * 0.45;
  /** Highest Mach where MIL thrust exceeds 1 g level-flight drag. */
  function milTopMach(alt: number): number {
    const p = AIRCRAFT_PERF.f35a;
    const atm = atmosphere(alt);
    let top = 0;
    for (let M = 0.5; M < 1.6; M += 0.005) {
      const V = M * atm.speedOfSound;
      const qS = 0.5 * atm.density * V * V * p.wingArea;
      const cl = (mass * 9.80665) / qS;
      const D = dragCoefficient(p, cl / p.clAlpha, 0, cl, M, 0) * qS;
      if (thrustMil(p, alt, atm.sigma, M) > D) top = M;
    }
    return top;
  }
  it('no supercruise: MIL tops out at ~M0.9-0.95 (reviewer: M0.99 low / M1.09 high)', () => {
    const low = milTopMach(300);
    const high = milTopMach(9_000);
    expect(low).toBeGreaterThan(0.86);
    expect(low).toBeLessThan(0.95);
    expect(high).toBeGreaterThan(0.9);
    expect(high).toBeLessThan(0.98);
    expect(high).toBeGreaterThanOrEqual(low);
  });
  it('MIL top speed in the full flight model (level, 240 s at 9 km) stays subsonic', () => {
    const tw = makeWorld('pilot');
    const ac = spawnF35(tw, 9_000, 230);
    let top = 0;
    run(tw.world, 240, () => {
      ac.input.throttle = AB_DETENT;
      ac.input.roll = 0;
      ac.input.pitch = Math.max(-1, Math.min(1, -ac.velocity.y * 0.02 + (9_000 - ac.position.y) * 0.001));
      top = Math.max(top, ac.flight.mach);
    });
    expect(top).toBeLessThan(0.98);
    expect(top).toBeGreaterThan(0.88);
  });

  it('roll rate varies with speed: slow at low KEAS, peak near corner, trimmed at high q̄ (reviewer: flat 210°/s)', () => {
    const p = AIRCRAFT_PERF.f35a;
    const q = (keas: number) => 0.5 * 1.225 * (keas * KT) ** 2;
    const at = (keas: number, nz = 1, ext = 0, heavy = 0) => rollRateLimit(p, q(keas), 3 * DEG, nz, ext, heavy) / DEG;
    expect(at(150)).toBeLessThan(110);
    expect(at(250)).toBeLessThan(175);
    expect(at(250)).toBeGreaterThan(at(150) + 40);
    expect(at(380)).toBeGreaterThan(200);
    expect(at(600)).toBeLessThan(at(400) - 25);
    // rolling-pull limit and heavy external stores
    expect(at(400, 9)).toBeLessThan(0.75 * at(400, 1));
    expect(at(400, 1, 2, 4)).toBeLessThan(0.8 * at(400));
  });

  it('measured full-stick roll rate in the flight model follows the schedule', () => {
    const peak = (keas: number, loadout: 'a2a_stealth' | 'strike_beast' = 'a2a_stealth') => {
      const tw = makeWorld('pilot');
      const ac = tw.world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 3000, 0), heading: 0, speed: tasFromIas(keas * KT, 3000), loadout, fuel: 0.6 });
      let pMax = 0;
      run(tw.world, 1.5, () => {
        ac.input.roll = 1;
        pMax = Math.max(pMax, ac.rates.x);
      });
      return pMax / DEG;
    };
    const slow = peak(180);
    const corner = peak(400);
    const fast = peak(600);
    expect(slow).toBeLessThan(corner - 50);
    expect(fast).toBeLessThan(corner - 20);
    expect(peak(400, 'strike_beast')).toBeLessThan(corner * 0.85);
  });

  it('full aft stick on the AoA limiter is crisp: no overshoot, no bobbing, steady bleed', () => {
    for (const spd of [120, 150, 200, 260]) {
      const tw = makeWorld('pilot');
      const ac = spawnF35(tw, 3000, spd);
      const a: number[] = [];
      const g: number[] = [];
      run(tw.world, 10, (t) => {
        ac.input.throttle = 1;
        ac.input.roll = 0;
        ac.input.pitch = t > 0.2 ? 1 : 0;
        a.push(ac.flight.alpha / DEG);
        g.push(ac.flight.gLoad);
      });
      const aMax = Math.max(...a);
      expect(aMax).toBeLessThan(28.3); // limiter 28°: < 0.3° overshoot
      expect(aMax).toBeGreaterThan(27.5);
      // after capture (last 6 s): AoA stays within ±0.3° and g changes smoothly (no oscillation)
      const tail = a.slice(-360);
      expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(0.6);
      const gt = g.slice(-360);
      let reversals = 0;
      let prev = 0;
      for (let i = 12; i < gt.length; i += 12) {
        const d = gt[i] - gt[i - 12];
        if (Math.abs(d) > 0.02 && prev !== 0 && Math.sign(d) !== Math.sign(prev)) reversals++;
        if (Math.abs(d) > 0.02) prev = d;
      }
      expect(reversals).toBeLessThanOrEqual(1);
    }
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
  it('recovers the Recruit jet diving at the ground and says AUTO GCAS', () => {
    let gcasSeen = false;
    let minGamma = 0;
    const { tw, ac } = diveAtGround('recruit', (a) => {
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
  for (const d of ['pilot', 'veteran', 'ace'] as const) {
    it(`lets the ${d} player fly into the ground: Auto-GCAS is a Recruit assist (owner, 2026-10-04)`, () => {
      let gcasSeen = false;
      const { tw, ac } = diveAtGround(d, (a) => {
        gcasSeen ||= !!a.gcasActive;
      });
      expect(gcasSeen).toBe(false);
      expect(ac.alive).toBe(false);
      expect(tw.of('hud:message').some((m) => m.text === 'AUTO GCAS')).toBe(false);
      expect(tw.of('player:down')).toHaveLength(1);
    });
  }
  it('still saves a friendly AI F-35 whatever the difficulty', () => {
    const tw = makeWorld('ace');
    const ac = tw.world.spawnAircraft({ type: 'f35a', team: 'blue', position: new Vector3(0, 1800, 0), heading: 0, speed: 230 });
    let gcasSeen = false;
    run(tw.world, 25, (t) => {
      ac.input.throttle = 0.7;
      ac.input.pitch = t < 2.2 ? -1 : 0;
      gcasSeen ||= !!ac.gcasActive;
    });
    expect(gcasSeen).toBe(true);
    expect(ac.alive).toBe(true);
  });
});
