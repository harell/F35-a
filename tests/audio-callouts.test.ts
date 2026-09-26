import { describe, expect, it } from 'vitest';
import {
  BINGO_CALL_INTERVAL,
  CalloutTracker,
  DEFEAT_CONFIRM,
  DefeatTracker,
  SPIKE_CALL_INTERVAL,
} from '../src/audio/voice/callouts';

/** Run a DefeatTracker over a timeline of MAWS lists; returns the times the cue fired. */
function runDefeat(list: (t: number) => number[], until: number, events: { t: number; id: number; reason: string }[] = [], dt = 0.05) {
  const d = new DefeatTracker();
  const ids = new Int32Array(16);
  const cues: number[] = [];
  let ev = 0;
  for (let i = 0; i <= Math.round(until / dt); i++) {
    const t = i * dt;
    const l = list(t);
    for (let k = 0; k < l.length; k++) ids[k] = l[k];
    if (d.update(t, ids, l.length, true)) cues.push(Math.round(t * 100) / 100);
    while (ev < events.length && events[ev].t <= t + 1e-9) {
      if (d.onEnd(events[ev].id, events[ev].reason)) cues.push(Math.round(t * 100) / 100);
      ev++;
    }
  }
  return cues;
}

describe('missile defeated detection (reviewer: warning ran ~6 s past a defeat, no positive feedback)', () => {
  it('a notched missile that drops off the MAWS list gives one cue within DEFEAT_CONFIRM', () => {
    // missile 7 guided 0..3 s, then guidance breaks; it self-destructs 1.5 s later
    const cues = runDefeat((t) => (t < 3 ? [7] : []), 8, [{ t: 4.5, id: 7, reason: 'selfdestruct' }]);
    expect(cues.length).toBe(1);
    expect(cues[0]).toBeGreaterThanOrEqual(3);
    expect(cues[0]).toBeLessThanOrEqual(3 + DEFEAT_CONFIRM + 0.06);
  });

  it('a decoyed missile ending with reason "decoyed" cues at once (no double cue later)', () => {
    const cues = runDefeat((t) => (t < 2 ? [3] : []), 6, [{ t: 2, id: 3, reason: 'decoyed' }]);
    expect(cues).toEqual([2]);
  });

  it('a missile that hits the jet is never celebrated', () => {
    const cues = runDefeat((t) => (t < 2 ? [5] : []), 5, [{ t: 2, id: 5, reason: 'proximity' }]);
    expect(cues).toEqual([]);
  });

  it('a salvo defeated together gets a single cue; a missile that re-acquires gets none', () => {
    expect(runDefeat((t) => (t < 2 ? [1, 2] : []), 5).length).toBe(1);
    // drops off for 0.15 s (sensor flicker) and comes back, then hits
    const cues = runDefeat((t) => (t < 2 || (t > 2.15 && t < 4) ? [9] : []), 6, [{ t: 4, id: 9, reason: 'hit' }]);
    expect(cues).toEqual([]);
  });

  it('player hit while the missile vanished cancels the guess', () => {
    const d = new DefeatTracker();
    const ids = new Int32Array([4]);
    d.update(0, ids, 1, true);
    d.update(0.05, ids, 0, true);
    d.onPlayerHit();
    let fired = false;
    for (let t = 0.1; t < 1; t += 0.05) fired = d.update(t, ids, 0, true) || fired;
    expect(fired).toBe(false);
  });
});

describe('situational pilot callouts (reviewer: p_spike / p_mud_spike / p_bingo never used)', () => {
  it('calls "Mud spike" on a SAM track and "Spike" on a fighter track, rate-limited', () => {
    const c = new CalloutTracker();
    expect(c.update(0, false, true)).toBe('p_mud_spike');
    expect(c.update(0.1, false, true)).toBeNull();
    expect(c.update(0.2, false, false)).toBeNull();
    expect(c.update(5, false, true)).toBeNull(); // re-spiked within the interval
    expect(c.update(6, true, false)).toBe('p_spike');
    c.update(7, false, false);
    expect(c.update(6 + SPIKE_CALL_INTERVAL + 1, true, false)).toBe('p_spike');
  });

  it('calls bingo once per interval', () => {
    const c = new CalloutTracker();
    expect(c.onBingo(10)).toBe('p_bingo');
    expect(c.onBingo(20)).toBeNull();
    expect(c.onBingo(10 + BINGO_CALL_INTERVAL)).toBe('p_bingo');
  });
});
