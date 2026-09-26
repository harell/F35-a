import { describe, expect, it } from 'vitest';
import type { VoiceId, WarningId } from '../src/core/types';
import { Music, TensionFollower, tensionLayer, tempoFor } from '../src/audio/music/Music';
import { VoicePlayer } from '../src/audio/voice/VoicePlayer';

/** A universal Web Audio stand-in: every property is a callable, assignable node. */
function fakeNode(): any {
  const store: Record<string | symbol, unknown> = {};
  const fn = function () {
    return fakeNode();
  };
  return new Proxy(fn, {
    get(_t, k) {
      if (k in store) return store[k];
      if (k === 'then') return undefined;
      if (k === Symbol.toPrimitive) return () => 0;
      const n = fakeNode();
      store[k] = n;
      return n;
    },
    set(_t, k, v) {
      store[k] = v;
      return true;
    },
    apply() {
      return fakeNode();
    },
  });
}

function fakeEnv(clock: { t: number }, created: { n: number }) {
  const ctx = new Proxy(
    {},
    {
      get(_t, k) {
        if (k === 'currentTime') return clock.t;
        if (k === 'state') return 'running';
        if (k === 'sampleRate') return 48000;
        return (..._a: unknown[]) => {
          created.n++;
          return fakeNode();
        };
      },
    },
  );
  const mixer = fakeNode();
  return { ctx, mixer, buffers: fakeNode(), pool: fakeNode() } as any;
}

const DUR: Partial<Record<VoiceId, number>> = { b_missile: 1.11, b_pull_up: 0.9, a_sam_launch: 1.9, p_mud_spike: 0.8 };
const bank = { get: (id: VoiceId) => ({ duration: DUR[id] ?? 1 }) } as any;

function setup() {
  const clock = { t: 0 };
  const created = { n: 0 };
  const vp = new VoicePlayer(fakeEnv(clock, created), bank);
  const log: { id: VoiceId; ch: string; t: number }[] = [];
  vp.onClipStart = (id, ch, t) => log.push({ id, ch, t: Math.round(t * 100) / 100 });
  const step = (dt: number, active: WarningId[]) => {
    clock.t += dt;
    vp.update(dt, new Set(active));
  };
  return { vp, log, step, clock };
}

describe('VoicePlayer prioritisation (reviewer: SAM call masked by Betty, Betty ran on after defeat)', () => {
  it('the DARKSTAR SAM call waits for Betty, then Betty reminders wait for the call', () => {
    const { vp, log, step } = setup();
    // same sim step: missile warning starts + SAM launch radio call
    vp.onRadio('a_sam_launch', 3);
    for (let i = 0; i < 160; i++) step(0.05, ['missile']);
    const betty = log.filter((l) => l.ch === 'betty');
    const sam = log.find((l) => l.id === 'a_sam_launch')!;
    expect(betty[0].t).toBeLessThan(0.1);
    // SAM call starts only after the first Betty clip ended
    expect(sam.t).toBeGreaterThanOrEqual(betty[0].t + DUR.b_missile!);
    expect(sam.t).toBeLessThan(betty[0].t + DUR.b_missile! + 0.4);
    // no Betty clip starts while the SAM call is on the air
    const samEnd = sam.t + 0.075 + DUR.a_sam_launch!;
    for (const b of betty) expect(b.t < sam.t || b.t >= samEnd - 0.01).toBe(true);
    // Betty keeps reminding afterwards
    expect(betty.filter((b) => b.t >= samEnd).length).toBeGreaterThanOrEqual(1);
  });

  it('PULL UP is never held back by a radio call', () => {
    const { vp, log, step } = setup();
    vp.onRadio('a_sam_launch', 3);
    for (let i = 0; i < 20; i++) step(0.05, []);
    const sam = log.find((l) => l.id === 'a_sam_launch')!;
    expect(sam).toBeTruthy();
    for (let i = 0; i < 40; i++) step(0.05, ['pull_up']);
    const pu = log.filter((l) => l.id === 'b_pull_up');
    expect(pu[0].t).toBeLessThan(sam.t + 0.2 + 1); // first announcement immediately
    expect(pu.length).toBeGreaterThanOrEqual(2); // and it keeps repeating through the call
  });

  it('Betty "MISSILE" is cut within 0.1 s when the warning clears (missile defeated)', () => {
    const { vp, step } = setup();
    step(0.05, ['missile']);
    expect(vp.speaking).toBe(true);
    for (let i = 0; i < 6; i++) step(0.05, ['missile']); // 0.35 s into a 1.11 s clip
    expect(vp.speaking).toBe(true);
    step(0.05, []); // warning cleared
    expect(vp.speaking).toBe(false);
  });
});

describe('procedural music', () => {
  it('maps tension to layers and tempo', () => {
    expect(tensionLayer(0)).toBe(0);
    expect(tensionLayer(0.5)).toBe(1);
    expect(tensionLayer(1)).toBe(2);
    expect(tempoFor('mission', 2)).toBeGreaterThan(tempoFor('mission', 0));
  });

  it('combat music rises at once and falls only after a calm hold', () => {
    const f = new TensionFollower(8);
    expect(f.update(0, 1)).toBe(1);
    expect(f.update(5, 0)).toBe(1);
    expect(f.update(9, 0)).toBeLessThan(1);
    let v = 1;
    for (let t = 9; t < 60; t += 0.5) v = f.update(t, 0);
    expect(v).toBe(0);
  });

  it('schedules a cheap number of nodes per second in every mode, none when off', () => {
    const clock = { t: 0 };
    const created = { n: 0 };
    const m = new Music(fakeEnv(clock, created));
    const count = (mode: 'off' | 'menu' | 'mission', tension: number) => {
      m.resolveMode = () => mode;
      m.tension.reset();
      m.tension.update(clock.t, tension);
      const n0 = created.n;
      for (let i = 0; i < 100; i++) {
        clock.t += 0.12;
        m.tick();
      }
      return (created.n - n0) / 12; // nodes per second
    };
    expect(count('off', 0)).toBe(0);
    const menu = count('menu', 0);
    const cruise = count('mission', 0);
    const combat = count('mission', 1);
    expect(menu).toBeGreaterThan(0);
    expect(cruise).toBeLessThan(combat);
    expect(combat).toBeLessThan(60); // short-lived nodes/s, well within mobile budgets
  });
});

describe('SAM call and Betty interleave when the call keys up first (browser log order)', () => {
  it('Betty MISSILE waits for an urgent radio call already on the air, then speaks right after', () => {
    const { vp, log, step } = setup();
    vp.onRadio('a_sam_launch', 3);
    step(0.05, []); // radio keys up
    for (let i = 0; i < 100; i++) step(0.05, ['missile']); // warning 0.1 s later
    const sam = log.find((l) => l.id === 'a_sam_launch')!;
    const firstMissile = log.find((l) => l.id === 'b_missile')!;
    const samEnd = sam.t + 0.075 + DUR.a_sam_launch!;
    expect(firstMissile.t).toBeGreaterThanOrEqual(samEnd - 0.01);
    expect(firstMissile.t).toBeLessThan(samEnd + 0.3);
  });

  it('routine chatter (priority 1) does not hold Betty back', () => {
    const { vp, log, step } = setup();
    vp.onRadio('p_mud_spike', 1);
    step(0.05, []);
    for (let i = 0; i < 10; i++) step(0.05, ['missile']);
    const m = log.find((l) => l.id === 'b_missile')!;
    expect(m.t).toBeLessThan(0.2);
  });
});
