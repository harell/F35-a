import { describe, expect, it } from 'vitest';
import { PICK_RADIUS, PickRegistry } from '../src/hud/hmd/picking';

describe('hud pick()', () => {
  it('returns the nearest symbol within the thumb radius', () => {
    const r = new PickRegistry();
    r.begin();
    r.add(1, 100, 100);
    r.add(2, 140, 100);
    r.add(3, 400, 300);
    expect(r.pick(110, 100)).toBe(1);
    expect(r.pick(131, 102)).toBe(2);
    expect(r.pick(400 + PICK_RADIUS - 1, 300)).toBe(3);
    expect(r.pick(400 + PICK_RADIUS + 2, 300)).toBeNull();
    expect(r.pick(700, 50)).toBeNull();
  });

  it('prefers a large box the tap is inside over a nearer small symbol centre', () => {
    const r = new PickRegistry();
    r.begin();
    r.add(7, 200, 200, 20); // big TD box
    r.add(8, 222, 200, 0); // small symbol just outside the box edge
    expect(r.pick(215, 200)).toBe(7);
  });

  it('forgets symbols on begin(), ignores duplicates / NaN and respects capacity', () => {
    const r = new PickRegistry(2);
    r.begin();
    r.add(1, 10, 10);
    r.add(1, 50, 50);
    r.add(2, NaN, 10);
    r.add(3, 30, 30);
    r.add(4, 31, 31);
    expect(r.count).toBe(2);
    expect(r.pick(50, 50)).toBe(3);
    r.begin();
    expect(r.pick(10, 10)).toBeNull();
  });
});
