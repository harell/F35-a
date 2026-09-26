import { describe, expect, it } from 'vitest';
import { AB_DETENT } from '../src/core/types';
import {
  AB_MIN,
  LEVER_AB,
  LEVER_MIL,
  clampToCircle,
  expo,
  leverToThrottle,
  lowPass,
  shapeStick,
  stickShapeFor,
  throttleToLever,
  throttleToggle,
  throttleZone,
} from '../src/input/curves';

const axes = () => ({ roll: 0, pitch: 0 });

describe('stick shaping (expo + deadzone)', () => {
  const shape = stickShapeFor(1);

  it('expo keeps the endpoints and softens the centre', () => {
    expect(expo(0, 0.5)).toBe(0);
    expect(expo(1, 0.5)).toBeCloseTo(1);
    expect(expo(-1, 0.5)).toBeCloseTo(-1);
    expect(expo(0.5, 0.5)).toBeLessThan(0.5);
    expect(expo(0.5, 0)).toBeCloseTo(0.5);
    // odd symmetry
    expect(expo(-0.3, 0.4)).toBeCloseTo(-expo(0.3, 0.4));
  });

  it('ignores tiny deflections inside the deadzone', () => {
    const r = shape.radius;
    const out = shapeStick(r * shape.deadzone * 0.9, 0, shape, false, axes());
    expect(out.roll).toBe(0);
    expect(out.pitch).toBe(0);
  });

  it('is continuous at the deadzone edge (no jump)', () => {
    const r = shape.radius;
    const just = shapeStick(r * (shape.deadzone + 0.002), 0, shape, false, axes());
    expect(just.roll).toBeGreaterThan(0);
    expect(just.roll).toBeLessThan(0.01);
  });

  it('reaches full deflection at (and beyond) the travel radius', () => {
    const r = shape.radius;
    expect(shapeStick(r, 0, shape, false, axes()).roll).toBeCloseTo(1);
    expect(shapeStick(-r * 3, 0, shape, false, axes()).roll).toBeCloseTo(-1);
    // pulling the thumb DOWN (towards the pilot) is aft stick = nose up
    expect(shapeStick(0, r, shape, false, axes()).pitch).toBeCloseTo(1);
    expect(shapeStick(0, -r, shape, false, axes()).pitch).toBeCloseTo(-1);
  });

  it('diagonals reach full roll AND full pitch (square gate)', () => {
    const r = shape.radius;
    const d = r / Math.SQRT2;
    const out = shapeStick(d, d, shape, false, axes());
    expect(out.roll).toBeCloseTo(1, 2);
    expect(out.pitch).toBeCloseTo(1, 2);
  });

  it('is monotonic along an axis', () => {
    let prev = -1;
    for (let i = 0; i <= 40; i++) {
      const v = shapeStick((shape.radius * i) / 40, 0, shape, false, axes()).roll;
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('invertPitch flips pitch only', () => {
    const r = shape.radius * 0.7;
    const a = shapeStick(r * 0.5, r, shape, false, axes());
    const b = shapeStick(r * 0.5, r, shape, true, axes());
    expect(b.pitch).toBeCloseTo(-a.pitch);
    expect(b.roll).toBeCloseTo(a.roll);
  });

  it('sensitivity shortens the throw and reduces expo', () => {
    const lo = stickShapeFor(0.5);
    const hi = stickShapeFor(2);
    expect(hi.radius).toBeLessThan(shape.radius);
    expect(lo.radius).toBeGreaterThan(shape.radius);
    expect(hi.expo).toBeLessThan(lo.expo);
    // same finger travel → more output with higher sensitivity
    const px = 30;
    expect(shapeStick(px, 0, hi, false, axes()).roll).toBeGreaterThan(shapeStick(px, 0, lo, false, axes()).roll);
    // out-of-range settings are clamped
    expect(stickShapeFor(10).radius).toBeCloseTo(stickShapeFor(2).radius);
  });

  it('clampToCircle keeps the knob on the travel circle', () => {
    const o = clampToCircle(300, 400, 50, { x: 0, y: 0 });
    expect(Math.hypot(o.x, o.y)).toBeCloseTo(50);
    expect(o.x / o.y).toBeCloseTo(0.75);
    const i = clampToCircle(10, -5, 50, { x: 0, y: 0 });
    expect(i).toEqual({ x: 10, y: -5 });
  });
});

describe('throttle lever with MIL detent', () => {
  it('maps the ends: bottom = idle, top = max AB', () => {
    expect(leverToThrottle(0)).toBe(0);
    expect(leverToThrottle(1)).toBeCloseTo(1);
    expect(leverToThrottle(-1)).toBe(0);
    expect(leverToThrottle(2)).toBeCloseTo(1);
  });

  it('reaches MIL exactly at the detent line', () => {
    expect(leverToThrottle(LEVER_MIL)).toBeCloseTo(AB_DETENT);
  });

  it('holds MIL across the detent gate (thumb must push through)', () => {
    for (const l of [LEVER_MIL + 0.001, (LEVER_MIL + LEVER_AB) / 2, LEVER_AB - 0.001]) expect(leverToThrottle(l)).toBe(AB_DETENT);
  });

  it('enters afterburner only past the gate', () => {
    expect(leverToThrottle(LEVER_AB)).toBeCloseTo(AB_MIN);
    expect(leverToThrottle(LEVER_AB)).toBeGreaterThan(AB_DETENT);
    expect(throttleZone(leverToThrottle(LEVER_AB - 0.01))).toBe('mil');
    expect(throttleZone(leverToThrottle(LEVER_AB + 0.01))).toBe('ab');
  });

  it('gives the AB range a bigger share of travel than of the axis', () => {
    const abTravel = 1 - LEVER_AB;
    const abAxis = 1 - AB_DETENT;
    expect(abTravel).toBeGreaterThan(abAxis * 1.5);
  });

  it('is monotonic and round-trips outside the gate', () => {
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const t = leverToThrottle(i / 100);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
    for (const t of [0, 0.2, 0.5, 0.75, AB_DETENT, 0.93, 0.97, 1]) expect(leverToThrottle(throttleToLever(t))).toBeCloseTo(t, 5);
  });

  it('classifies zones', () => {
    expect(throttleZone(0)).toBe('idle');
    expect(throttleZone(0.5)).toBe('dry');
    expect(throttleZone(AB_DETENT)).toBe('mil');
    expect(throttleZone(1)).toBe('ab');
  });

  it('double-tap toggles MIL ↔ MAX AB', () => {
    expect(throttleToggle(0.6)).toBe(1);
    expect(throttleToggle(AB_DETENT)).toBe(1);
    expect(throttleToggle(1)).toBe(AB_DETENT);
    expect(throttleToggle(0.95)).toBe(AB_DETENT);
  });
});

describe('lowPass', () => {
  it('converges towards the target, frame-rate independently', () => {
    const a = lowPass(0, 1, 0.1, 0.1);
    let b = 0;
    for (let i = 0; i < 10; i++) b = lowPass(b, 1, 0.01, 0.1);
    expect(a).toBeCloseTo(b, 6);
    expect(a).toBeGreaterThan(0.6);
    expect(a).toBeLessThan(0.7);
    expect(lowPass(0.3, 1, 0.016, 0)).toBe(1);
  });
});
