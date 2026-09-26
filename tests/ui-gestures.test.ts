import { describe, expect, it } from 'vitest';
import { GESTURES, classifyGesture, isDoubleTap, lookDelta } from '../src/input/gestures';

describe('tap vs drag classification', () => {
  it('a quick release without travel is a tap', () => {
    expect(classifyGesture(2, -3, 120, true)).toBe('tap');
    expect(classifyGesture(0, 0, GESTURES.tapMs, true)).toBe('tap');
  });

  it('travelling beyond the slop makes it a drag, even if quick', () => {
    expect(classifyGesture(GESTURES.slop + 1, 0, 60, true)).toBe('drag');
    expect(classifyGesture(0, -(GESTURES.slop + 5), 60, false)).toBe('drag');
    expect(classifyGesture(9, 9, 100, false)).toBe('drag'); // hypot > 12
  });

  it('holding still too long is a press (neither tap nor look)', () => {
    expect(classifyGesture(1, 1, GESTURES.tapMs + 50, true)).toBe('press');
    expect(classifyGesture(1, 1, GESTURES.tapMs + 50, false)).toBe('press');
  });

  it('a pointer still down and within slop/time is pending', () => {
    expect(classifyGesture(3, 3, 80, false)).toBe('pending');
  });
});

describe('double tap', () => {
  it('needs two taps close in time and space', () => {
    const a = { x: 400, y: 200, t: 1000 };
    expect(isDoubleTap(null, a)).toBe(false);
    expect(isDoubleTap(a, { x: 410, y: 205, t: 1200 })).toBe(true);
    expect(isDoubleTap(a, { x: 410, y: 205, t: 1000 + GESTURES.doubleTapMs + 1 })).toBe(false);
    expect(isDoubleTap(a, { x: 500, y: 200, t: 1100 })).toBe(false);
    expect(isDoubleTap(a, { x: 400, y: 200, t: 900 })).toBe(false);
  });
});

describe('look delta', () => {
  it('scales with FOV and viewport height; swipe right = look right, swipe up = look up', () => {
    const o = { yaw: 0, pitch: 0 };
    lookDelta(390, 0, 390, 60, o);
    expect(o.yaw).toBeCloseTo((60 * Math.PI) / 180 * 1.6);
    expect(o.pitch).toBeCloseTo(0);
    lookDelta(0, -100, 390, 60, o);
    expect(o.pitch).toBeGreaterThan(0);
    const narrow = lookDelta(100, 0, 390, 30, { yaw: 0, pitch: 0 }).yaw;
    const wide = lookDelta(100, 0, 390, 90, { yaw: 0, pitch: 0 }).yaw;
    expect(wide).toBeCloseTo(narrow * 3);
  });
});
