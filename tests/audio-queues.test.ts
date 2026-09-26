import { describe, expect, it } from 'vitest';
import { RadioQueue } from '../src/audio/voice/radioQueue';
import { DelayQueue } from '../src/audio/world/DelayQueue';

describe('radio queue', () => {
  it('plays the most important call first, then oldest first', () => {
    const q = new RadioQueue(4, 6, 3);
    q.push('p_engaged', 1, 0);
    q.push('a_bandits', 2, 0.1);
    q.push('p_copy', 1, 0.2);
    q.push('a_sam_launch', 3, 0.3);
    expect(q.next(0.5)?.voice).toBe('a_sam_launch');
    expect(q.next(0.5)?.voice).toBe('a_bandits');
    expect(q.next(0.5)?.voice).toBe('p_engaged');
    expect(q.next(0.5)?.voice).toBe('p_copy');
    expect(q.next(0.5)).toBeNull();
  });

  it('does not stack identical clips', () => {
    const q = new RadioQueue();
    expect(q.push('p_fox3', 2, 0)).toBe(true);
    expect(q.push('p_fox3', 2, 0.2)).toBe(false);
    expect(q.length).toBe(1);
  });

  it('drops stale chatter but keeps urgent calls longer', () => {
    const q = new RadioQueue(4, 6, 3);
    q.push('p_engaged', 1, 0);
    q.push('a_eject', 4, 0);
    expect(q.next(7)?.voice).toBe('a_eject');
    expect(q.next(7)).toBeNull();
  });

  it('when full, evicts the least important call only for a more important one', () => {
    const q = new RadioQueue(2, 6, 3);
    q.push('p_engaged', 1, 0);
    q.push('p_copy', 1, 0.1);
    expect(q.push('p_defending', 1, 0.2)).toBe(false);
    expect(q.push('a_sam_launch', 3, 0.3)).toBe(true);
    expect(q.length).toBe(2);
    expect(q.next(0.4)?.voice).toBe('a_sam_launch');
    expect(q.next(0.4)?.voice).toBe('p_copy');
  });
});

describe('speed-of-sound delay queue', () => {
  const mk = () => new DelayQueue<{ tag: string }>(4, () => ({ tag: '' }));

  it('fires when the sound front reaches a static listener (d / 343 s)', () => {
    const q = mk();
    q.push(3430, 0, 0, 0, 30).tag = 'boom';
    const heard: { tag: string; t: number; d: number }[] = [];
    for (let t = 0; t <= 12; t += 0.05) q.update(t, 0, 0, 0, (p, d) => heard.push({ tag: p.tag, t, d }));
    expect(heard.length).toBe(1);
    expect(heard[0].tag).toBe('boom');
    expect(heard[0].t).toBeGreaterThanOrEqual(10 - 1e-9);
    expect(heard[0].t).toBeLessThan(10.06);
    expect(heard[0].d).toBeCloseTo(3430, 6);
  });

  it('a listener flying towards the blast hears it sooner, one racing away later (or never)', () => {
    const arrival = (vx: number) => {
      const q = mk();
      q.push(3430, 0, 0, 0, 30).tag = 'x';
      let at = -1;
      for (let t = 0; t <= 30 && at < 0; t += 0.01) q.update(t, vx * t, 0, 0, () => (at = t));
      return at;
    };
    const still = arrival(0);
    const towards = arrival(300);
    const away = arrival(-100);
    expect(towards).toBeLessThan(still);
    expect(away).toBeGreaterThan(still);
    expect(towards).toBeCloseTo(3430 / 643, 1);
    // supersonic escape: the front never catches up before maxWait
    expect(arrival(-400)).toBe(-1);
  });

  it('gives up after maxWait and replaces the oldest when full', () => {
    const q = mk();
    q.push(1e6, 0, 0, 0, 2).tag = 'far';
    let fired = 0;
    q.update(3, 0, 0, 0, () => fired++);
    expect(fired).toBe(0);
    expect(q.pending).toBe(0);
    for (let i = 0; i < 5; i++) q.push(100 * (i + 1), 0, 0, i, 60).tag = `e${i}`;
    expect(q.pending).toBe(4);
    const tags: string[] = [];
    q.update(100, 0, 0, 0, (p) => tags.push(p.tag));
    expect(tags.sort()).toEqual(['e1', 'e2', 'e3', 'e4']);
  });
});
