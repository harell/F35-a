import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TILT_NEUTRAL,
  WHEEL_FLOOR,
  angleDiff,
  deviceToScreen,
  deviceUpVector,
  tiltAngles,
  tiltToAxes,
  type TiltAngles,
  type Vec3,
} from '../src/input/tiltMath';

const D = Math.PI / 180;
const ang = (): TiltAngles => ({ bank: 0, back: 0 });
const v3 = (): Vec3 => ({ x: 0, y: 0, z: 0 });
const axes = () => ({ roll: 0, pitch: 0 });

/**
 * Build DeviceOrientation beta/gamma for a phone held in landscape.
 * Physical pose: screen tilted back `backDeg` from vertical, rotated like a steering wheel by
 * `wheelDeg` (+ = clockwise = right turn), for screen angle 90 or 270.
 * We construct the world-up vector in SCREEN axes, rotate it back into device axes, then invert
 * up = (-sinγ cosβ, sinβ, cosγ cosβ).
 */
function pose(backDeg: number, wheelDeg: number, screenAngle: 90 | 270): { beta: number; gamma: number } {
  const b = backDeg * D;
  const w = wheelDeg * D;
  // up in screen axes: upright = +y, tilted back → +z; turning the wheel clockwise tilts world-up towards screen-left (-x)
  const sy0 = Math.cos(b);
  const sz = Math.sin(b);
  const sx = -Math.sin(w) * sy0;
  const sy = Math.cos(w) * sy0;
  // screen → device: inverse rotation of deviceToScreen
  const a = screenAngle * D;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = sx * c + sy * s;
  const dy = -sx * s + sy * c;
  const dz = sz;
  const beta = Math.asin(Math.max(-1, Math.min(1, dy))) / D;
  const cb = Math.cos(beta * D);
  const gamma = Math.atan2(-dx / cb, dz / cb) / D;
  return { beta, gamma };
}

describe('tilt math', () => {
  it('device up vector: flat on a table points out of the screen, portrait upright points to the top edge', () => {
    const f = deviceUpVector(0, 0, v3());
    expect(f.z).toBeCloseTo(1);
    const p = deviceUpVector(90, 0, v3());
    expect(p.y).toBeCloseTo(1);
  });

  it('screen rotation maps device axes for both landscape orientations', () => {
    // device +y (top edge) is screen-left at 90°, screen-right at 270°
    expect(deviceToScreen({ x: 0, y: 1, z: 0 }, 90, v3()).x).toBeCloseTo(-1);
    expect(deviceToScreen({ x: 0, y: 1, z: 0 }, 270, v3()).x).toBeCloseTo(1);
    // device +x (right edge) is screen-up at 90°, screen-down at 270°
    expect(deviceToScreen({ x: 1, y: 0, z: 0 }, 90, v3()).y).toBeCloseTo(1);
    expect(deviceToScreen({ x: 1, y: 0, z: 0 }, 270, v3()).y).toBeCloseTo(-1);
  });

  for (const sa of [90, 270] as const) {
    describe(`landscape ${sa}°`, () => {
      it('recovers the physical pose (tilt-back and wheel angle)', () => {
        for (const [back, wheel] of [
          [35, 0],
          [35, 20],
          [50, -15],
          [10, 5],
          [80, 25],
        ]) {
          const { beta, gamma } = pose(back, wheel, sa);
          const a = tiltAngles(beta, gamma, sa, ang());
          // tilt-back is recovered exactly, whatever the wheel angle
          expect(a.back / D).toBeCloseTo(back, 3);
          // wheel angle: exact while the screen is reasonably upright, damped when nearly flat
          const sy = Math.cos(wheel * D) * Math.cos(back * D);
          const expected = Math.atan2(Math.sin(wheel * D) * Math.cos(back * D), Math.max(sy, WHEEL_FLOOR)) / D;
          expect(a.bank / D).toBeCloseTo(expected, 3);
          if (sy >= WHEEL_FLOOR) expect(a.bank / D).toBeCloseTo(wheel, 3);
          else expect(Math.abs(a.bank / D)).toBeLessThan(Math.abs(wheel));
        }
      });

      it('turning the phone clockwise rolls right, counter-clockwise rolls left', () => {
        const r = tiltToAxes(tiltAngles(pose(35, 20, sa).beta, pose(35, 20, sa).gamma, sa, ang()), DEFAULT_TILT_NEUTRAL, 1, false, axes());
        const l = tiltToAxes(tiltAngles(pose(35, -20, sa).beta, pose(35, -20, sa).gamma, sa, ang()), DEFAULT_TILT_NEUTRAL, 1, false, axes());
        expect(r.roll).toBeGreaterThan(0.4);
        expect(l.roll).toBeLessThan(-0.4);
        expect(Math.abs(r.pitch)).toBeLessThan(0.05);
      });

      it('top edge towards you (more upright) = nose up; away = nose down', () => {
        const up = pose(15, 0, sa);
        const dn = pose(55, 0, sa);
        const u = tiltToAxes(tiltAngles(up.beta, up.gamma, sa, ang()), DEFAULT_TILT_NEUTRAL, 1, false, axes());
        const d = tiltToAxes(tiltAngles(dn.beta, dn.gamma, sa, ang()), DEFAULT_TILT_NEUTRAL, 1, false, axes());
        expect(u.pitch).toBeGreaterThan(0.5);
        expect(d.pitch).toBeLessThan(-0.5);
        const inv = tiltToAxes(tiltAngles(up.beta, up.gamma, sa, ang()), DEFAULT_TILT_NEUTRAL, 1, true, axes());
        expect(inv.pitch).toBeCloseTo(-u.pitch);
      });

      it('the neutral pose is centred and small wobbles sit in the deadzone', () => {
        const n = pose(35, 0, sa);
        const c = tiltToAxes(tiltAngles(n.beta, n.gamma, sa, ang()), DEFAULT_TILT_NEUTRAL, 1, false, axes());
        expect(c.roll).toBe(0);
        expect(c.pitch).toBe(0);
        const w = pose(36.5, 1.5, sa);
        const cw = tiltToAxes(tiltAngles(w.beta, w.gamma, sa, ang()), DEFAULT_TILT_NEUTRAL, 1, false, axes());
        expect(cw.roll).toBe(0);
        expect(cw.pitch).toBe(0);
      });

      it('calibration: any held pose can become level', () => {
        const held = pose(60, 8, sa);
        const a = tiltAngles(held.beta, held.gamma, sa, ang());
        const neutral = { bank: a.bank, back: a.back };
        const c = tiltToAxes(a, neutral, 1, false, axes());
        expect(c.roll).toBe(0);
        expect(c.pitch).toBe(0);
      });
    });
  }

  it('is continuous through vertical (where Euler angles flip)', () => {
    const a1 = tiltAngles(pose(-2, 10, 90).beta, pose(-2, 10, 90).gamma, 90, ang());
    const a2 = tiltAngles(pose(2, 10, 90).beta, pose(2, 10, 90).gamma, 90, ang());
    expect(Math.abs(a1.back - a2.back)).toBeLessThan(5 * D);
    expect(Math.abs(a1.bank - a2.bank)).toBeLessThan(2 * D);
  });

  it('higher sensitivity needs less tilt for full deflection; output is clamped', () => {
    const p = pose(35, 12, 90);
    const a = tiltAngles(p.beta, p.gamma, 90, ang());
    const lo = tiltToAxes(a, DEFAULT_TILT_NEUTRAL, 0.5, false, axes());
    const hi = tiltToAxes(a, DEFAULT_TILT_NEUTRAL, 2, false, axes());
    expect(hi.roll).toBeGreaterThan(lo.roll);
    const big = pose(35, 80, 90);
    expect(tiltToAxes(tiltAngles(big.beta, big.gamma, 90, ang()), DEFAULT_TILT_NEUTRAL, 2, false, axes()).roll).toBeLessThanOrEqual(1);
  });

  it('angleDiff wraps', () => {
    expect(angleDiff(0.1, 2 * Math.PI - 0.1)).toBeCloseTo(0.2);
    expect(angleDiff(-3, 3)).toBeCloseTo(2 * Math.PI - 6);
  });
});
