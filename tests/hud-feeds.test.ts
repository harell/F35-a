import { describe, expect, it } from 'vitest';
import { KillFeed, MessageQueue, RadioQueue, RADIO_PAGE_MIN, classifyHudMessage, messagePriority } from '../src/hud/hmd/feeds';

function tick(q: { update(dt: number): void }, seconds: number) {
  for (let t = 0; t < seconds; t += 0.05) q.update(0.05);
}

describe('hud radio subtitle queue', () => {
  it('pages long calls instead of truncating them: every page gets ≥ RADIO_PAGE_MIN seconds', () => {
    const q = new RadioQueue();
    q.push('DARKSTAR', 'x'.repeat(260));
    const base = q.duration;
    q.setPages(3);
    expect(q.duration).toBeGreaterThanOrEqual(3 * RADIO_PAGE_MIN - 1e-9);
    expect(q.duration).toBeGreaterThanOrEqual(base);
    expect(q.page).toBe(0);
    tick(q, q.duration / 3 + 0.1);
    expect(q.page).toBe(1);
    tick(q, q.duration / 3);
    expect(q.page).toBe(2);
    // an urgent call still cuts it short
    q.push('AWACS', 'SAM launch!', 3);
    tick(q, 0.4);
    expect(q.current?.from).toBe('AWACS');
    expect(q.page).toBe(0);
  });

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
  it('shows ONE centre message at a time: highest priority wins, the others wait, duplicates refresh', () => {
    const m = new MessageQueue();
    m.push('RADAR ON', 'info', 1.5);
    expect(m.items.length).toBe(1);
    expect(m.current?.text).toBe('RADAR ON');
    // a more important one pre-empts; the info one waits (never stacked on screen)
    m.push('OBJECTIVE COMPLETE', 'good', 3);
    expect(m.items.length).toBe(1);
    expect(m.current?.text).toBe('OBJECTIVE COMPLETE');
    m.push('MISSION FAILED', 'bad', 5);
    expect(m.current?.text).toBe('MISSION FAILED');
    expect(messagePriority('MISSION FAILED', 'bad')).toBe(5);
    // duplicate refresh, no second copy
    m.push('MISSION FAILED', 'bad', 5);
    expect(m.items.length).toBe(1);
    expect(m.queue.filter((q) => q.text === 'MISSION FAILED').length).toBe(0);
    tick(m, 5.1);
    // the interrupted good message resumes before the low-priority one
    expect(m.current?.text).toBe('OBJECTIVE COMPLETE');
    tick(m, 3.2);
    // the low-priority RADAR ON waited too long (> 5 s) and was dropped
    expect(m.current).toBeNull();
    expect(m.queue.length).toBe(0);
  });

  it('keeps important queued messages even after a long wait and shortens under backlog', () => {
    const m = new MessageQueue();
    m.push('G-LOC', 'bad', 6);
    m.push('RETURN TO AO — 20 s', 'warn', 3);
    m.push('BINGO FUEL — RTB WHENUAPAI', 'warn', 4);
    tick(m, 6.1);
    // warn messages (priority 3) survive the wait
    expect(m.current?.text).toMatch(/RETURN TO AO|BINGO/);
  });

  it('kill feed keeps newest first and fades out', () => {
    const k = new KillFeed(3, 5);
    k.push('SPLASH MIG-29');
    k.push('SA-6 DESTROYED');
    expect(k.items[0].text).toBe('SA-6 DESTROYED');
    tick(k, 5.1);
    expect(k.items.length).toBe(0);
  });

  it('kill feed: max 3 lines; a mission kill message merges into the HUD line for the same kill', () => {
    const k = new KillFeed();
    expect(k.maxItems).toBe(3);
    k.push('SPLASH SU-27', 'info');
    k.merge('HAMMER 1: SPLASH SU-27', 'info');
    expect(k.items.length).toBe(1);
    expect(k.items[0].text).toBe('HAMMER 1: SPLASH SU-27');
    // the HUD's "VIPER 2 DOWN" beats the generic "FRIENDLY DOWN"
    k.push('VIPER 2 DOWN', 'bad');
    k.merge('FRIENDLY DOWN', 'bad');
    expect(k.items[0].text).toBe('VIPER 2 DOWN');
    for (let i = 0; i < 5; i++) k.push('SPLASH MIG-' + i, 'good');
    expect(k.items.length).toBe(3);
  });
});

describe('hud message routing', () => {
  it('routes kills to the feed, the title to the banner and drops the duplicate AUTO GCAS', () => {
    expect(classifyHudMessage('SPLASH MIG-29', null)).toBe('kill');
    expect(classifyHudMessage('HAMMER 1: SPLASH SU-27', null)).toBe('kill');
    expect(classifyHudMessage('SA-6 SITE DESTROYED', null)).toBe('kill');
    expect(classifyHudMessage('FRIENDLY DOWN', null)).toBe('kill');
    expect(classifyHudMessage('MIG-29 DRIVEN OFF', null)).toBe('kill');
    expect(classifyHudMessage('DAWN PATROL', 'Dawn Patrol')).toBe('title');
    expect(classifyHudMessage('AUTO GCAS', null)).toBe('drop');
    expect(classifyHudMessage('OBJECTIVE COMPLETE', null)).toBe('centre');
    expect(classifyHudMessage('PRIMARY OBJECTIVE FAILED', null)).toBe('centre');
    expect(classifyHudMessage('RADAR ON', null)).toBe('centre');
  });
});
