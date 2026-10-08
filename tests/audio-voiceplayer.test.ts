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
  vp.onClipStart = (id, ch, t) => log.push({ id: id as VoiceId, ch, t: Math.round(t * 100) / 100 });
  const step = (dt: number, active: WarningId[]) => {
    clock.t += dt;
    vp.update(dt, new Set(active));
  };
  return { vp, log, step, clock };
}

describe('VoicePlayer prioritisation (reviewer: SAM call masked by Betty, Betty ran on after defeat)', () => {
  it('Betty MISSILE speaks first; the DARKSTAR "SAM launch" is dropped once MISSILE is up (i2 reviewer)', () => {
    const { vp, log, step } = setup();
    // same sim step: missile warning starts + SAM launch radio call
    vp.onRadio('a_sam_launch', 3);
    for (let i = 0; i < 160; i++) step(0.05, ['missile']);
    const betty = log.filter((l) => l.ch === 'betty');
    expect(betty[0].t).toBeLessThan(0.1);
    // Betty is the more timely cue: the AWACS call adds nothing while MISSILE is being called
    expect(log.find((l) => l.id === 'a_sam_launch')).toBeUndefined();
    // MISSILE keeps repeating every ~2.5 s
    expect(betty.length).toBeGreaterThanOrEqual(3);
  });

  it('an urgent call queued without a missile warning still plays and holds lesser Betty clips', () => {
    const { vp, log, step } = setup();
    vp.onRadio('a_sam_launch', 3);
    for (let i = 0; i < 80; i++) step(0.05, i > 4 ? ['fuel_low'] : []);
    const sam = log.find((l) => l.id === 'a_sam_launch')!;
    const fuel = log.find((l) => l.id === 'b_fuel_low')!;
    expect(sam.t).toBeLessThan(0.1);
    expect(fuel.t).toBeGreaterThanOrEqual(sam.t + 0.075 + DUR.a_sam_launch! - 0.01);
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
  it('Betty MISSILE is never delayed by an urgent radio call already on the air (i2 reviewer: 2 s delay)', () => {
    const { vp, log, step } = setup();
    vp.onRadio('a_sam_launch', 3);
    step(0.05, []); // radio keys up (browser log: munition:launch → RADIO a_sam_launch)
    for (let i = 0; i < 100; i++) step(0.05, ['missile']); // warning 0.1 s later
    const firstMissile = log.find((l) => l.id === 'b_missile')!;
    expect(firstMissile.t).toBeLessThan(0.16); // was 2.1 s (after the whole AWACS call)
    // the call was cut and, MISSILE being up, not repeated afterwards
    expect(log.filter((l) => l.id === 'a_sam_launch').length).toBe(1);
  });

  it('a routine call cut by MISSILE is re-queued and heard after Betty', () => {
    const { vp, log, step } = setup();
    vp.onRadio('a_good_kill', 2);
    step(0.05, []);
    for (let i = 0; i < 20; i++) step(0.05, ['missile']);
    for (let i = 0; i < 60; i++) step(0.05, []);
    const kills = log.filter((l) => l.id === 'a_good_kill');
    expect(kills.length).toBe(2);
    const m = log.find((l) => l.id === 'b_missile')!;
    expect(kills[1].t).toBeGreaterThanOrEqual(m.t + DUR.b_missile!);
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

describe('no MISSILE call after the missile hit (i2 reviewer: b_missile 0.1 s after player:hit)', () => {
  it('cuts a MISSILE clip at impact and does not start a new one during the warning off-delay', () => {
    const { vp, log, step } = setup();
    const ids = new Int32Array([42]);
    vp.noteIncoming(ids, 1);
    for (let i = 0; i < 40; i++) step(0.05, ['missile']); // 2 s: first clip played
    const before = log.filter((l) => l.id === 'b_missile').length;
    vp.onMissileImpact(ids, 1); // m_igla (id 42) hits
    expect(vp.speaking).toBe(false);
    for (let i = 0; i < 6; i++) {
      vp.noteIncoming(ids, 0); // incoming list empty after the hit
      step(0.05, ['missile']); // Warnings off-delay keeps 'missile' for ~0.3 s
    }
    step(0.05, []);
    expect(log.filter((l) => l.id === 'b_missile').length).toBe(before);
  });

  it('a second missile still inbound keeps MISSILE going (t06 SA-6 salvo)', () => {
    const { vp, log, step } = setup();
    vp.noteIncoming(new Int32Array([7, 8]), 2);
    for (let i = 0; i < 10; i++) step(0.05, ['missile']);
    vp.onMissileImpact(new Int32Array([7]), 1); // missile 7 hits, 8 is still inbound
    step(0.05, ['missile']);
    expect(vp.speaking).toBe(true); // the clip was not cut
    const inbound = new Int32Array([8]);
    for (let i = 0; i < 60; i++) {
      vp.noteIncoming(inbound, 1);
      step(0.05, ['missile']);
    }
    const all = log.filter((l) => l.id === 'b_missile');
    expect(all.length).toBe(2);
    expect(all[1].t).toBeLessThan(all[0].t + 2.5 + 0.1); // normal cadence, no mute
  });
});

describe('Betty does not nag for a whole recovery (i2 reviewer)', () => {
  it('engine fire: announced + 2 reminders, then quiet while it stays active', () => {
    const { log, step } = setup();
    for (let i = 0; i < 20 * 45; i++) step(0.05, ['engine_fire']); // 45 s
    const n = log.filter((l) => l.id === 'b_engine_fire').length;
    expect(n).toBe(3); // was 7 (every 6 s)
  });

  it('acknowledge silences reminders (and the clip playing) until the warning clears; MISSILE keeps repeating', () => {
    const { vp, log, step } = setup();
    for (let i = 0; i < 4; i++) step(0.05, ['engine_fire', 'damage']);
    expect(vp.acknowledge()).toBe(2);
    step(0.05, ['engine_fire', 'damage']);
    expect(vp.speaking).toBe(false);
    for (let i = 0; i < 20 * 30; i++) step(0.05, ['engine_fire', 'damage']);
    expect(log.filter((l) => l.id === 'b_engine_fire').length).toBe(1);
    // clears and comes back → announced again
    for (let i = 0; i < 20 * 5; i++) step(0.05, []);
    for (let i = 0; i < 20; i++) step(0.05, ['engine_fire']);
    expect(log.filter((l) => l.id === 'b_engine_fire').length).toBe(2);
    // MISSILE cannot be acknowledged
    for (let i = 0; i < 4; i++) step(0.05, ['missile']);
    expect(vp.acknowledge()).toBe(0);
    const m0 = log.filter((l) => l.id === 'b_missile').length;
    for (let i = 0; i < 20 * 6; i++) step(0.05, ['missile']);
    expect(log.filter((l) => l.id === 'b_missile').length).toBeGreaterThanOrEqual(m0 + 2);
  });
});

describe('long radio calls during a missile warning (no cut/replay loop)', () => {
  it('MISSILE reminders wait for a call on the air; a cut call is replayed at most once', () => {
    const { vp, log, step } = setup();
    for (let i = 0; i < 4; i++) step(0.05, ['missile']); // first MISSILE
    vp.onRadio('a_good_kill', 2); // queued, plays after Betty
    for (let i = 0; i < 20 * 20; i++) step(0.05, ['missile']);
    const kills = log.filter((l) => l.id === 'a_good_kill');
    expect(kills.length).toBe(1); // played once, never cut by the 2.5 s reminders
    const m = log.filter((l) => l.id === 'b_missile');
    expect(m.length).toBeGreaterThanOrEqual(6); // reminders continue around it
    const end = kills[0].t + 0.075 + 1;
    for (const b of m) expect(b.t < kills[0].t || b.t >= end - 0.01).toBe(true);
  });
});
