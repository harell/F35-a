import { describe, expect, it } from 'vitest';
import { KillFeed, MessageQueue, RadioQueue } from '../src/hud/hmd/feeds';

function tick(q: { update(dt: number): void }, seconds: number) {
  for (let t = 0; t < seconds; t += 0.05) q.update(0.05);
}

describe('hud radio subtitle queue', () => {
  it('shows one subtitle at a time for ~4 s, in order', () => {
    const q = new RadioQueue();
    q.push('DARKSTAR', 'Bandits, bandits. BRAA 045/40, angels 20, hot.');
    q.push('VIPER 2', 'Two, contact.');
    expect(q.current?.from).toBe('DARKSTAR');
    expect(q.pending).toBe(1);
    expect(q.duration).toBeGreaterThan(3);
    expect(q.duration).toBeLessThan(5.6);
    tick(q, q.duration + 0.1);
    expect(q.current?.from).toBe('VIPER 2');
    tick(q, 6);
    expect(q.current).toBeNull();
    expect(q.alpha).toBe(0);
  });

  it('drops duplicates, lets priority calls jump the queue and bounds the backlog', () => {
    const q = new RadioQueue(3);
    q.push('A', 'one');
    q.push('A', 'one');
    expect(q.pending).toBe(0);
    q.push('B', 'two');
    q.push('C', 'three');
    q.push('D', 'SAM launch!', 2);
    // D jumped ahead of B and C
    tick(q, q.duration + 0.05);
    expect(q.current?.from).toBe('D');
    q.push('E', 'e');
    q.push('F', 'f');
    q.push('G', 'g');
    expect(q.pending).toBeLessThanOrEqual(3);
  });

  it('shortens subtitles when a backlog builds and cuts for urgent calls', () => {
    const q = new RadioQueue();
    const text = 'Picture, two groups, azimuth ten miles.';
    expect(q.durationFor(text, 3)).toBeLessThan(q.durationFor(text, 0));
    q.push('A', text);
    tick(q, 0.5);
    q.push('AWACS', 'SAM launch, SAM launch!', 3);
    tick(q, 0.4);
    expect(q.current?.from).toBe('AWACS');
  });
});

describe('hud centre messages and kill feed', () => {
  it('stacks at most two messages, refreshes duplicates and expires', () => {
    const m = new MessageQueue();
    m.push('TARGET DESTROYED', 'good', 2);
    m.push('AUTO GCAS', 'warn', 2);
    m.push('RADAR ON', 'info', 1);
    expect(m.items.length).toBe(2);
    expect(m.items[0].text).toBe('RADAR ON');
    m.push('RADAR ON', 'info', 3);
    expect(m.items.length).toBe(2);
    tick(m, 3.2);
    expect(m.items.length).toBe(0);
  });

  it('kill feed keeps newest first and fades out', () => {
    const k = new KillFeed(3, 5);
    k.push('SPLASH MIG-29');
    k.push('SA-6 DESTROYED');
    expect(k.items[0].text).toBe('SA-6 DESTROYED');
    tick(k, 5.1);
    expect(k.items.length).toBe(0);
  });
});
