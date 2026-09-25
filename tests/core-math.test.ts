import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { forwardOf, hprFromQuat, quatFromHPR, relativeAngles, rightOf, upOf, DEG } from '../src/core/math';
import { atmosphere } from '../src/core/atmosphere';

describe('core math conventions', () => {
  it('heading 0 points north (-Z), 90° points east (+X)', () => {
    expect(forwardOf(quatFromHPR(0, 0, 0)).z).toBeCloseTo(-1);
    const e = forwardOf(quatFromHPR(90 * DEG, 0, 0));
    expect(e.x).toBeCloseTo(1);
    expect(e.z).toBeCloseTo(0);
  });
  it('positive pitch raises the nose, positive roll lowers the right wing', () => {
    expect(forwardOf(quatFromHPR(0, 30 * DEG, 0)).y).toBeCloseTo(0.5);
    expect(rightOf(quatFromHPR(0, 0, 30 * DEG)).y).toBeCloseTo(-0.5);
    expect(upOf(quatFromHPR(0, 0, 0)).y).toBeCloseTo(1);
  });
  it('hprFromQuat inverts quatFromHPR', () => {
    for (const [h, p, r] of [
      [10, 5, 20],
      [200, -30, -60],
      [359, 60, 170],
    ]) {
      const out = hprFromQuat(quatFromHPR(h * DEG, p * DEG, r * DEG));
      expect(out.heading / DEG).toBeCloseTo(h, 3);
      expect(out.pitch / DEG).toBeCloseTo(p, 3);
      expect(out.roll / DEG).toBeCloseTo(r, 3);
    }
  });
  it('relativeAngles: target to the right has positive bearing', () => {
    const q = quatFromHPR(0, 0, 0);
    const r = relativeAngles(new Vector3(), q, new Vector3(100, 0, -100));
    expect(r.bearing / DEG).toBeCloseTo(45);
    expect(r.offBoresight / DEG).toBeCloseTo(45);
  });
});

describe('ISA atmosphere', () => {
  it('matches reference values', () => {
    const sl = atmosphere(0);
    expect(sl.density).toBeCloseTo(1.225, 3);
    expect(sl.speedOfSound).toBeCloseTo(340.3, 0);
    const a11 = atmosphere(11000);
    expect(a11.temperature).toBeCloseTo(216.65, 1);
    expect(a11.density).toBeCloseTo(0.3639, 3);
    expect(atmosphere(20000).density).toBeCloseTo(0.0880, 3);
  });
});
