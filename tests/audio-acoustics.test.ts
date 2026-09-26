import { describe, expect, it } from 'vitest';
import {
  airAbsorptionCutoff,
  distanceGain,
  dopplerFactor,
  explosionLoudness,
  explosionRange,
  insideMachCone,
  machAngle,
  retardedTime,
  soundArrived,
  soundDelay,
  SPEED_OF_SOUND,
  stereoPan,
} from '../src/audio/acoustics';
import type { ExplosionSize } from '../src/core/types';

describe('distance attenuation', () => {
  it('is 1 inside the reference distance and follows 1/d beyond', () => {
    expect(distanceGain(0, 30, 5000)).toBe(1);
    expect(distanceGain(30, 30, 5000)).toBe(1);
    expect(distanceGain(60, 30, 5000)).toBeCloseTo(0.5, 5);
    expect(distanceGain(300, 30, 5000)).toBeCloseTo(0.1, 5);
  });
  it('a softer exponent falls off more gently', () => {
    expect(distanceGain(300, 30, 5000, 0.7)).toBeGreaterThan(distanceGain(300, 30, 5000, 1));
  });
  it('fades smoothly to silence at maxDist and is monotonic', () => {
    expect(distanceGain(5000, 30, 5000)).toBe(0);
    expect(distanceGain(9000, 30, 5000)).toBe(0);
    let prev = 2;
    for (let d = 0; d <= 5000; d += 50) {
      const g = distanceGain(d, 30, 5000);
      expect(g).toBeLessThanOrEqual(prev + 1e-12);
      prev = g;
    }
  });
  it('rejects NaN / negative distances', () => {
    expect(distanceGain(NaN, 30, 5000)).toBe(0);
    expect(distanceGain(-5, 30, 5000)).toBe(0);
  });
});

describe('air absorption', () => {
  it('darkens with distance within audible bounds', () => {
    expect(airAbsorptionCutoff(0)).toBe(18000);
    expect(airAbsorptionCutoff(1000)).toBeLessThan(5000);
    expect(airAbsorptionCutoff(1000)).toBeGreaterThan(3000);
    expect(airAbsorptionCutoff(10_000)).toBeLessThan(700);
    expect(airAbsorptionCutoff(1e7)).toBe(180);
  });
});

describe('speed of sound', () => {
  it('delays by d / 343', () => {
    expect(SPEED_OF_SOUND).toBe(343);
    expect(soundDelay(3430)).toBeCloseTo(10, 6);
    expect(soundDelay(-1)).toBe(0);
    expect(soundArrived(1, 343)).toBe(true);
    expect(soundArrived(0.99, 343)).toBe(false);
  });
});

describe('retarded time (moving sources)', () => {
  it('equals d/c for a static source', () => {
    expect(retardedTime(686, 0, 0, 0, 0, 0)).toBeCloseTo(2, 6);
  });
  it('a subsonic jet that has flown past is heard from where it was', () => {
    // listener at origin; jet now 500 m east of it, flying east at 250 m/s
    // D = listener - source = (-500, 0, 0)
    const tau = retardedTime(-500, 0, 0, 250, 0, 0);
    expect(tau).toBeGreaterThan(0);
    // emission point x_e = 500 - 250 τ; distance must equal c τ
    const xe = 500 - 250 * tau;
    expect(Math.abs(xe)).toBeCloseTo(SPEED_OF_SOUND * tau, 4);
    expect(xe).toBeLessThan(500);
  });
  it('an approaching subsonic jet is heard from further out', () => {
    // jet 500 m east, flying west towards the listener at 250 m/s
    const tau = retardedTime(-500, 0, 0, -250, 0, 0);
    const xe = 500 + 250 * tau;
    expect(xe).toBeCloseTo(SPEED_OF_SOUND * tau, 4);
    expect(xe).toBeGreaterThan(500);
  });
  it('an approaching supersonic jet is not heard until its Mach cone arrives', () => {
    // jet 2 km east, flying west (towards us) at Mach 1.5, passing 50 m abeam
    expect(retardedTime(-2000, 50, 0, -514, 0, 0)).toBe(-1);
    expect(insideMachCone(-2000, 50, 0, -514, 0, 0)).toBe(false);
  });
  it('after passing, the listener is inside the Mach cone and hears it', () => {
    // jet 2 km west of us, still flying west at Mach 1.5, 50 m abeam
    expect(insideMachCone(2000, 50, 0, -514, 0, 0)).toBe(true);
    const tau = retardedTime(2000, 50, 0, -514, 0, 0);
    expect(tau).toBeGreaterThan(0);
  });
  it('the cone boundary matches the Mach angle', () => {
    const V = 2 * SPEED_OF_SOUND; // Mach 2 → μ = 30°
    expect(machAngle(V)).toBeCloseTo(Math.PI / 6, 6);
    expect(machAngle(200)).toBeCloseTo(Math.PI / 2, 6);
    // source at origin flying +x; listener behind at angle θ from the -x axis, distance 1000
    const at = (deg: number) => {
      const th = (deg * Math.PI) / 180;
      return insideMachCone(-1000 * Math.cos(th), 1000 * Math.sin(th), 0, V, 0, 0);
    };
    expect(at(25)).toBe(true);
    expect(at(35)).toBe(false);
  });
  it('a chase camera stays inside the cone of its supersonic jet', () => {
    // camera 25 m behind a Mach 1.5 jet
    expect(insideMachCone(-25, 5, 0, 514, 0, 0)).toBe(true);
  });
});

describe('Doppler', () => {
  it('raises the pitch of an approaching source and lowers a receding one', () => {
    // u = unit vector from source to listener = +x
    const approach = dopplerFactor(1, 0, 0, 100, 0, 0, 0, 0, 0, 0.1, 10);
    expect(approach).toBeCloseTo(343 / 243, 6);
    const recede = dopplerFactor(1, 0, 0, -100, 0, 0, 0, 0, 0, 0.1, 10);
    expect(recede).toBeCloseTo(343 / 443, 6);
  });
  it('accounts for listener motion and cancels for a co-moving chase camera', () => {
    expect(dopplerFactor(1, 0, 0, 0, 0, 0, -50, 0, 0, 0.1, 10)).toBeCloseTo(393 / 343, 6);
    expect(dopplerFactor(1, 0, 0, 250, 0, 0, 250, 0, 0)).toBeCloseTo(1, 6);
  });
  it('is clamped to a musical range', () => {
    expect(dopplerFactor(1, 0, 0, 330, 0, 0, 0, 0, 0)).toBe(1.8);
    expect(dopplerFactor(1, 0, 0, -600, 0, 0, 0, 0, 0)).toBe(0.55);
  });
});

describe('stereo pan', () => {
  it('pans right for sources on the right, never fully one-sided, centred when very close', () => {
    expect(stereoPan(1, 100)).toBeCloseTo(0.8, 6);
    expect(stereoPan(-1, 100)).toBeCloseTo(-0.8, 6);
    expect(stereoPan(1, 0)).toBe(0);
    expect(Math.abs(stereoPan(5, 100))).toBeLessThanOrEqual(0.8);
  });
});

describe('explosions', () => {
  it('bigger explosions are louder and carry further', () => {
    const sizes: ExplosionSize[] = ['tiny', 'small', 'medium', 'large', 'huge'];
    for (let i = 1; i < sizes.length; i++) {
      expect(explosionRange(sizes[i])).toBeGreaterThan(explosionRange(sizes[i - 1]));
      expect(explosionLoudness(sizes[i])).toBeGreaterThanOrEqual(explosionLoudness(sizes[i - 1]));
    }
  });
});
