/**
 * Regression tests for the i1 render review: missile camera lag, padlock composition, tactical
 * coverage (see scratchpad i1-render.md).
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import {
  MISSILE_CAM,
  PADLOCK,
  impactPose,
  missileCamPose,
  padlockPose,
  sideOf,
  tacticalCoverage,
  tacticalHeight,
} from '../src/render/camera/cameraMath';

/** Project a world point with a camera placed at `pos` looking at `aim` (NDC x,y in -1..1). */
function ndc(pos: Vector3, aim: Vector3, pt: Vector3, fov = 60, aspect = 16 / 9): Vector3 {
  const cam = new PerspectiveCamera(fov, aspect, 0.5, 1e6);
  cam.position.copy(pos);
  cam.up.set(0, 1, 0);
  cam.lookAt(aim);
  cam.updateMatrixWorld();
  return pt.clone().project(cam);
}

describe('missile camera (reviewer: camera sat ~80-90 m behind a 900 m/s missile)', () => {
  it('is rigid along-track: distance to the missile does not grow with speed', () => {
    const fwd = new Vector3(0, 0, -1);
    const side = new Vector3();
    sideOf(fwd, new Vector3(1, 0, 0), side);
    const pos = new Vector3();
    const aim = new Vector3();
    // simulate 2 s of a 900 m/s missile at 60 Hz, re-posing every frame (the rig does exactly this)
    const m = new Vector3(0, 3000, 0);
    let maxD = 0;
    for (let i = 0; i < 120; i++) {
      m.addScaledVector(fwd, 900 / 60);
      missileCamPose(m, fwd, side, 3.65, null, pos, aim);
      maxD = Math.max(maxD, pos.distanceTo(m));
    }
    expect(maxD).toBeLessThan(MISSILE_CAM.back + 3.65 + 3); // ~10-12 m, not ~80 m
    expect(maxD).toBeGreaterThan(5);
  });

  it('frames the missile body large and in the lower part of the view, target in frame', () => {
    const fwd = new Vector3(0, 0, -1);
    const side = sideOf(fwd, new Vector3(1, 0, 0), new Vector3());
    const m = new Vector3(0, 3000, 0);
    const tgt = new Vector3(600, 3100, -4000);
    const pos = new Vector3();
    const aim = new Vector3();
    missileCamPose(m, fwd, side, 3.65, tgt, pos, aim);
    const pm = ndc(pos, aim, m);
    expect(Math.abs(pm.x)).toBeLessThan(0.9);
    expect(pm.y).toBeLessThan(0); // missile in the lower half
    expect(pm.y).toBeGreaterThan(-0.9);
    const pt = ndc(pos, aim, tgt);
    expect(Math.abs(pt.x)).toBeLessThan(1);
    expect(Math.abs(pt.y)).toBeLessThan(1);
    expect(pt.z).toBeLessThan(1);
    // AIM-120 body (3.65 m) at ~10 m spans a big part of the screen: > 15% of the view height
    const tail = m.clone().addScaledVector(fwd, -3.65);
    const nose = ndc(pos, aim, m.clone().addScaledVector(fwd, 0));
    const tl = ndc(pos, aim, tail);
    expect(Math.hypot(nose.x - tl.x, nose.y - tl.y)).toBeGreaterThan(0.3);
  });

  it('impact linger pose is behind/above/right of the impact, 80-120 m away', () => {
    const out = impactPose(new Vector3(0, 2000, 0), new Vector3(0, 0, -1), new Vector3(1, 0, 0), new Vector3());
    expect(out.z).toBeGreaterThan(50);
    expect(out.x).toBeGreaterThan(20);
    expect(out.y).toBeGreaterThan(2010);
    const d = out.distanceTo(new Vector3(0, 2000, 0));
    expect(d).toBeGreaterThan(80);
    expect(d).toBeLessThan(120);
  });
});

describe('padlock / target camera (reviewer: jet tiny and hidden under the target box)', () => {
  const cases: [string, Vector3][] = [
    ['far ahead', new Vector3(300, 3200, -8000)],
    ['beam', new Vector3(3000, 3000, -200)],
    ['close', new Vector3(80, 3030, -300)],
    ['high', new Vector3(0, 6000, -2000)],
  ];
  for (const [name, tgt] of cases) {
    it(`keeps the jet low-left and the target upper-right, both on screen (${name})`, () => {
      const jet = new Vector3(0, 3000, 0);
      const dir = tgt.clone().sub(jet).normalize();
      const pos = new Vector3();
      const look = new Vector3();
      padlockPose(jet, tgt, dir, 20, pos, look);
      const back = pos.clone().sub(jet);
      // back distance capped at ~35 m (+ up/side offsets)
      expect(back.length()).toBeLessThan(Math.hypot(PADLOCK.backMax, PADLOCK.up, PADLOCK.side) + 0.01);
      const aim = pos.clone().add(look);
      const pj = ndc(pos, aim, jet);
      const pt = ndc(pos, aim, tgt);
      for (const p of [pj, pt]) {
        expect(Math.abs(p.x)).toBeLessThan(0.95);
        expect(Math.abs(p.y)).toBeLessThan(0.95);
        expect(p.z).toBeLessThan(1);
      }
      expect(pj.x).toBeLessThan(pt.x);
      expect(pj.y).toBeLessThan(pt.y);
      // they no longer overlap on screen (separated by > 15% of the view)
      expect(Math.hypot(pj.x - pt.x, pj.y - pt.y)).toBeGreaterThan(0.3);
    });
  }
});

describe('tactical camera coverage (HUD map matching)', () => {
  it('height ↔ half coverage round-trips through the FOV', () => {
    const h = tacticalHeight(10_000, 60);
    expect(h).toBeCloseTo(10_000 / Math.tan(Math.PI / 6), 3);
    expect(tacticalCoverage(h, 60)).toBeCloseTo(10_000, 3);
  });
});
