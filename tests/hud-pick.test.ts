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

  it('inside overlapping boxes, picks the box no missile of ours is flying at, nearest the tap', () => {
    const r = new PickRegistry();
    r.begin();
    r.add(1, 100, 100, 10); // nearest the tap, but already engaged
    r.add(2, 104, 101, 10);
    r.add(3, 108, 100, 10);
    r.add(4, 300, 100, 10); // elsewhere on the screen
    const engaged = (id: number) => id === 1;
    expect(r.pick(101, 100, PICK_RADIUS, 10, engaged)).toBe(2);
    // a tap far from the cluster later is an ordinary pick
    expect(r.pick(302, 100, PICK_RADIUS, 20, engaged)).toBe(4);
  });

  it('a second tap at the same spot within 1.5 s steps through the overlapping boxes', () => {
    const r = new PickRegistry();
    r.begin();
    r.add(1, 100, 100, 10);
    r.add(2, 104, 101, 10);
    r.add(3, 108, 100, 10);
    const engaged = (id: number) => id === 1;
    const taps = [10, 10.8, 11.5, 12.2].map((t) => r.pick(102, 100, PICK_RADIUS, t, engaged));
    expect(taps).toEqual([2, 3, 1, 2]); // free boxes first, the engaged one last, then round again
    // after a pause, the same spot starts over at the best box
    expect(r.pick(102, 100, PICK_RADIUS, 20, engaged)).toBe(2);
    expect(r.pick(102, 101, PICK_RADIUS, 20.5, engaged)).toBe(3);
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
