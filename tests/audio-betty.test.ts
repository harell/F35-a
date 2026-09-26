import { describe, expect, it } from 'vitest';
import { BETTY_RULES, BettyScheduler, MAX_REMINDERS, voiceForWarning } from '../src/audio/voice/betty';
import type { WarningId } from '../src/core/types';

/** Drive the scheduler like VoicePlayer does, with fixed clip durations; returns the log of clip starts. */
function run(
  active: (t: number) => WarningId[],
  until: number,
  durations: Partial<Record<string, number>> = {},
  dt = 0.05,
): { t: number; voice: string; preempt: boolean }[] {
  const s = new BettyScheduler();
  const log: { t: number; voice: string; preempt: boolean }[] = [];
  const steps = Math.round(until / dt);
  for (let i = 0; i <= steps; i++) {
    const t = i * dt;
    const set = new Set(active(t));
    const d = s.update(t, set);
    if (d) {
      if (d.preempt) s.stopped(t);
      log.push({ t: Math.round(t * 100) / 100, voice: d.voice, preempt: d.preempt });
      s.started(d.warning, t, durations[d.voice] ?? 1.0);
    }
  }
  return log;
}

describe('warning → Betty voice mapping', () => {
  it('maps every required warning to its clip', () => {
    const expected: [WarningId, string][] = [
      ['pull_up', 'b_pull_up'],
      ['missile', 'b_missile'],
      ['engine_fire', 'b_engine_fire'],
      ['over_g', 'b_over_g'],
      ['bingo', 'b_bingo'],
      ['fuel_low', 'b_fuel_low'],
      ['stall', 'b_aoa'],
      ['hydraulics', 'b_hydraulics'],
      ['flares_low', 'b_flares_low'],
      ['chaff_low', 'b_chaff_low'],
      ['speed_low', 'b_speed'],
      ['damage', 'b_warning'],
      ['altitude', 'b_altitude'],
    ];
    for (const [w, v] of expected) expect(voiceForWarning(w)).toBe(v);
  });
  it('has no voice for the RWR spike (the tone covers it)', () => {
    expect(voiceForWarning('spike')).toBeUndefined();
  });
  it('orders priorities PULL UP > MISSILE > ENGINE FIRE > the rest', () => {
    const p = (w: WarningId) => BETTY_RULES[w]!.priority;
    expect(p('pull_up')).toBeGreaterThan(p('missile'));
    expect(p('missile')).toBeGreaterThan(p('engine_fire'));
    for (const w of Object.keys(BETTY_RULES) as WarningId[]) {
      if (w !== 'pull_up' && w !== 'missile' && w !== 'engine_fire') expect(p('engine_fire')).toBeGreaterThan(p(w));
    }
  });
});

describe('Betty scheduling', () => {
  it('speaks a new warning immediately', () => {
    const log = run(() => ['fuel_low'], 0.2);
    expect(log[0]).toMatchObject({ t: 0, voice: 'b_fuel_low' });
  });

  it('repeats PULL UP about every 1.2 s while active', () => {
    const log = run(() => ['pull_up'], 6, { b_pull_up: 1.0 });
    const times = log.filter((l) => l.voice === 'b_pull_up').map((l) => l.t);
    expect(times.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(1.19);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeLessThanOrEqual(1.36);
  });

  it('repeats MISSILE about every 2.5 s while active', () => {
    const log = run(() => ['missile'], 10, { b_missile: 1.2 });
    const times = log.map((l) => l.t);
    expect(times.length).toBe(5);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeCloseTo(2.5, 1);
  });

  it('says cautions once, then only an occasional reminder', () => {
    const log = run(() => ['fuel_low'], 59);
    expect(log.length).toBe(1);
    const log2 = run(() => ['fuel_low'], 61);
    expect(log2.length).toBe(2);
    expect(log2[1].t).toBeCloseTo(BETTY_RULES.fuel_low!.repeat, 1);
  });

  it('plays the highest-priority warning first and never overlaps clips', () => {
    const log = run(() => ['fuel_low', 'over_g', 'missile'], 3, { b_missile: 1.2, b_over_g: 1.0, b_fuel_low: 0.9 });
    expect(log[0].voice).toBe('b_missile');
    // next clips start only after the previous one ended (+ gap), and not as preemptions
    const dur: Record<string, number> = { b_missile: 1.2, b_over_g: 1.0, b_fuel_low: 0.9 };
    for (let i = 1; i < log.length; i++) {
      expect(log[i].preempt).toBe(false);
      expect(log[i].t).toBeGreaterThanOrEqual(log[i - 1].t + dur[log[i - 1].voice] - 1e-6);
    }
    expect(log.map((l) => l.voice)).toContain('b_over_g');
  });

  it('PULL UP cuts a lower-priority clip short', () => {
    const log = run((t) => (t < 0.5 ? ['bingo'] : ['bingo', 'pull_up']), 1, { b_bingo: 1.5 });
    expect(log[0].voice).toBe('b_bingo');
    expect(log[1]).toMatchObject({ voice: 'b_pull_up', preempt: true });
    expect(log[1].t).toBeCloseTo(0.5, 5);
  });

  it('non-urgent warnings wait for the current clip instead of preempting', () => {
    const log = run((t) => (t < 0.3 ? ['fuel_low'] : ['fuel_low', 'engine_fire']), 3, { b_fuel_low: 1.0 });
    const fire = log.find((l) => l.voice === 'b_engine_fire')!;
    expect(fire.preempt).toBe(false);
    expect(fire.t).toBeGreaterThanOrEqual(1.0);
  });

  it('does not chatter when a warning flickers off and on', () => {
    // over_g toggles every 0.4 s for 3 s → announced at most twice (rearm 3 s)
    const log = run((t) => (Math.floor(t / 0.4) % 2 === 0 ? ['over_g'] : []), 3, { b_over_g: 0.8 });
    expect(log.length).toBeLessThanOrEqual(2);
  });

  it('announces a warning again after it cleared and the re-arm time passed', () => {
    const log = run((t) => (t < 1 || t > 8 ? ['altitude'] : []), 9, { b_altitude: 1.0 });
    expect(log.length).toBe(2);
    expect(log[1].t).toBeGreaterThan(8);
  });

  it('keeps working when a clip is missing (duration 0)', () => {
    const log = run(() => ['pull_up'], 3, { b_pull_up: 0 });
    expect(log.length).toBeGreaterThanOrEqual(2);
    expect(log[1].t - log[0].t).toBeGreaterThanOrEqual(1.19);
  });

  it('hold() delays the next clip (caution chime first)', () => {
    const s = new BettyScheduler();
    s.hold(0.45);
    expect(s.update(0, new Set<WarningId>(['bingo']))).toBeNull();
    expect(s.update(0.5, new Set<WarningId>(['bingo']))?.voice).toBe('b_bingo');
  });

  it('urgent warnings do not wait for the caution chime', () => {
    const s = new BettyScheduler();
    s.hold(0.45);
    expect(s.update(0, new Set<WarningId>(['fuel_low', 'pull_up']))?.voice).toBe('b_pull_up');
  });
});

describe('BettyScheduler iteration-2 rules', () => {
  const run = (b: BettyScheduler, from: number, to: number, active: Set<WarningId>, dur = 1) => {
    const said: [number, WarningId][] = [];
    for (let t = from; t < to; t += 0.05) {
      const d = b.update(t, active);
      if (d) {
        b.started(d.warning, t, dur);
        said.push([Math.round(t * 100) / 100, d.warning]);
      }
    }
    return said;
  };

  it('an urgent radio call (deferAll) never holds MISSILE back, but still holds cautions', () => {
    const b = new BettyScheduler();
    b.deferAll(3);
    const said = run(b, 0, 2.9, new Set<WarningId>(['missile', 'fuel_low']));
    expect(said[0]).toEqual([0, 'missile']);
    expect(said.some(([, w]) => w === 'fuel_low')).toBe(false);
  });

  it('non-urgent warnings: first call + MAX_REMINDERS reminders, then quiet until they clear', () => {
    const b = new BettyScheduler();
    const on = new Set<WarningId>(['engine_fire']);
    expect(run(b, 0, 60, on).length).toBe(1 + MAX_REMINDERS);
    run(b, 60, 70, new Set()); // clears
    expect(run(b, 70, 71, on).length).toBe(1); // comes back → announced again
  });

  it('acknowledge() silences active warnings below MISSILE, not MISSILE / PULL UP', () => {
    const b = new BettyScheduler();
    const on = new Set<WarningId>(['damage', 'missile']);
    run(b, 0, 0.5, on);
    expect(b.acknowledge()).toBe(1); // damage only
    const said = run(b, 0.5, 40, on);
    expect(said.every(([, w]) => w === 'missile')).toBe(true);
    expect(said.length).toBeGreaterThan(10);
  });

  it('mute() keeps a warning quiet until it expires or unmute()', () => {
    const b = new BettyScheduler();
    b.mute('missile', 1.2);
    const on = new Set<WarningId>(['missile']);
    expect(run(b, 0, 1.1, on).length).toBe(0);
    expect(run(b, 1.2, 1.3, on).length).toBe(1);
    const c = new BettyScheduler();
    c.mute('missile', 5);
    c.unmute('missile');
    expect(run(c, 0, 0.1, on).length).toBe(1);
  });
});
