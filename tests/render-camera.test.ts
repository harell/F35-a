import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { quatFromHPR } from '../src/core/math';
import {
  DEG,
  LOOK_LIMITS,
  chasePosition,
  clampAboveGround,
  clampLook,
  flybyAnchor,
  fovToFrame,
  headQuaternion,
  orbitOffset,
  passedAnchor,
  shakeNoise,
  smoothK,
} from '../src/render/camera/cameraMath';

describe('render camera math', () => {
  it('clamps head look to ±160° yaw and -40°..+90° pitch', () => {
    const o = { yaw: 0, pitch: 0 };
    clampLook(4, 3, o);
    expect(o.yaw).toBeCloseTo(LOOK_LIMITS.yaw);
    expect(o.pitch).toBeCloseTo(90 * DEG);
    clampLook(-4, -3, o);
    expect(o.yaw).toBeCloseTo(-160 * DEG);
    expect(o.pitch).toBeCloseTo(-40 * DEG);
    clampLook(0.3, 0.2, o);
    expect(o.yaw).toBeCloseTo(0.3);
    expect(o.pitch).toBeCloseTo(0.2);
  });

  it('head quaternion: yaw + looks right, pitch + looks up (nose = -Z)', () => {
    const q = new Quaternion();
    const f = new Vector3();
    headQuaternion(90 * DEG, 0, q);
    f.set(0, 0, -1).applyQuaternion(q);
    expect(f.x).toBeCloseTo(1);
    headQuaternion(0, 45 * DEG, q);
    f.set(0, 0, -1).applyQuaternion(q);
    expect(f.y).toBeCloseTo(Math.SQRT1_2);
    expect(f.z).toBeCloseTo(-Math.SQRT1_2);
    headQuaternion(0, 0, q);
    expect(q.w).toBeCloseTo(1);
  });

  it('chase camera sits behind and above the aircraft in its frame', () => {
    const pos = new Vector3(100, 2000, -500);
    const out = new Vector3();
    // heading north (-Z): behind = +Z
    chasePosition(pos, quatFromHPR(0, 0, 0), 20, 5, out);
    expect(out.x).toBeCloseTo(100);
    expect(out.y).toBeCloseTo(2005);
    expect(out.z).toBeCloseTo(-480);
    // heading east (+X): behind = -X
    chasePosition(pos, quatFromHPR(90 * DEG, 0, 0), 20, 5, out);
    expect(out.x).toBeCloseTo(80);
    expect(out.z).toBeCloseTo(-500);
    // inverted: "above" in the body frame is below in the world
    chasePosition(pos, quatFromHPR(0, 0, 180 * DEG), 20, 5, out);
    expect(out.y).toBeCloseTo(1995);
  });

  it('ground clamp lifts the camera above terrain + clearance only when needed', () => {
    const p = new Vector3(0, 10, 0);
    expect(clampAboveGround(p, 12, 3)).toBe(true);
    expect(p.y).toBe(15);
    expect(clampAboveGround(p, 5, 3)).toBe(false);
    expect(p.y).toBe(15);
  });

  it('fly-by anchor is ahead along the track and to the right; detects passing', () => {
    const pos = new Vector3(0, 500, 0);
    const vel = new Vector3(0, 0, -200); // north
    const out = new Vector3();
    flybyAnchor(pos, vel, new Vector3(0, 0, -1), 600, 30, 6, out);
    expect(out.z).toBeCloseTo(-600);
    expect(out.x).toBeCloseTo(30);
    expect(out.y).toBeCloseTo(506);
    expect(passedAnchor(out, pos, vel, 100)).toBe(false);
    expect(passedAnchor(out, new Vector3(0, 500, -750), vel, 100)).toBe(true);
    // zero velocity falls back to the forward axis
    flybyAnchor(pos, new Vector3(), new Vector3(1, 0, 0), 100, 0, 0, out);
    expect(out.x).toBeCloseTo(100);
  });

  it('orbit offset: yaw 0 is south of the target, pitch raises the camera', () => {
    const o = new Vector3();
    orbitOffset(0, 0, 50, o);
    expect(o.z).toBeCloseTo(50);
    orbitOffset(0, 90 * DEG, 50, o);
    expect(o.y).toBeCloseTo(50);
    expect(o.length()).toBeCloseTo(50);
  });

  it('smoothing factor, shake noise and framing FOV are well behaved', () => {
    expect(smoothK(5, 0)).toBe(0);
    expect(smoothK(5, 10)).toBeCloseTo(1);
    for (let t = 0; t < 10; t += 0.37) expect(Math.abs(shakeNoise(t, 1))).toBeLessThanOrEqual(1);
    const near = fovToFrame(16, 50, 0.5, 5, 60);
    const far = fovToFrame(16, 5000, 0.5, 5, 60);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThanOrEqual(5);
  });
});
