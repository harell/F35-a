/**
 * Enemy pilots in the vertical (src/ai/brain/bfm.ts): an Immelmann to reverse after a head-on pass,
 * a loop against an attacker closing too fast behind, oblique (nose-high / nose-low) turns in the
 * rate fight — and rookies who keep fighting flat. Judged from outside, by the same loop / Immelmann
 * detector that grades the player in T03 (src/missions/runtime/maneuvers.ts), on the real SimWorld.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { createAiBrain } from '../src/ai';
import type { Difficulty } from '../src/core/types';
import type { AircraftEntity } from '../src/sim/entities';
import { createManeuverTracker, updateManeuvers, type ManeuverId } from '../src/missions/runtime/maneuvers';
import { makeAiWorld, runFor, v3 } from './ai-helpers';

const DEG = Math.PI / 180;
const _up = new Vector3();

interface Watch {
  seen: ManeuverId[];
  maxGamma: number;
  crashed: boolean;
  states: Set<string>;
  /** Highest flight-path angle (deg) while in BFM above the corner speed. */
  minAgl: number;
}

/** Feed an AI jet's flight path to the manoeuvre detector at 10 Hz. */
function watcher(ac: AircraftEntity) {
  const tr = createManeuverTracker();
  const w: Watch = { seen: [], maxGamma: 0, crashed: false, states: new Set(), minAgl: Infinity };
  let next = 0;
  return {
    w,
    sample(t: number) {
      if (!ac.alive) {
        w.crashed = true;
        return;
      }
      w.states.add(ac.aiState);
      w.minAgl = Math.min(w.minAgl, ac.flight.agl);
      if (t < next) return;
      next = t + 0.1;
      const v = ac.velocity.length();
      w.maxGamma = Math.max(w.maxGamma, Math.asin(Math.max(-1, Math.min(1, ac.velocity.y / Math.max(1, v)))) / DEG);
      _up.set(0, 1, 0).applyQuaternion(ac.quaternion);
      const m = updateManeuvers(tr, ac.velocity, _up, t);
      if (m) w.seen.push(m);
    },
  };
}

/** A red AI fighter meets a blue jet flying straight and level head-on; guns only, no missiles. */
function headOn(difficulty: Difficulty, skill: number, seed: number, seconds = 60): Watch {
  const tw = makeAiWorld(difficulty, undefined, seed);
  const w = tw.world;
  const tgt = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(20_000, 4_000, 20_000), heading: 0, speed: 230 });
  const red = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(20_000 + 150 * (seed % 3), 4_100, 9_000), heading: Math.PI, speed: 270, ai: createAiBrain('fighter', { skill, seed }) });
  red.stores.forEach((s) => (s.count = 0));
  tgt.stores.forEach((s) => (s.count = 0));
  const wa = watcher(red);
  runFor(w, seconds, (t) => {
    tgt.input.throttle = 0.7;
    wa.sample(t);
  });
  return wa.w;
}

/** A blue jet closes fast from 2 km behind a red AI fighter, nose on it; guns only. */
function bounced(difficulty: Difficulty, skill: number, seed: number, seconds = 50): Watch {
  const tw = makeAiWorld(difficulty, undefined, seed);
  const w = tw.world;
  const red = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(20_000, 4_000, 20_000), heading: 0, speed: 250, ai: createAiBrain('fighter', { skill, seed }) });
  const att = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(20_000 + 30 * (seed % 3), 4_050, 22_000), heading: 0, speed: 330 });
  red.stores.forEach((s) => (s.count = 0));
  att.stores.forEach((s) => (s.count = 0));
  const wa = watcher(red);
  runFor(w, seconds, (t) => {
    att.input.throttle = 1;
    wa.sample(t);
  });
  return wa.w;
}

const SEEDS = [1, 2, 3, 4, 5, 6];
/** The vertical is a choice (a veteran takes it ~85 % of the time): judged over 12 encounters. */
const CHOICE_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

describe('enemy pilots fight in the vertical', () => {
  it("a veteran MiG reverses after a head-on pass with an Immelmann, mostly; never into the ground", { timeout: 120_000 }, () => {
    let imm = 0;
    const log: string[] = [];
    for (const seed of CHOICE_SEEDS) {
      const r = headOn('veteran', 0.9, seed);
      log.push(`seed ${seed}: ${r.seen.join(',') || 'flat'} max ${r.maxGamma.toFixed(0)}°`);
      if (r.seen.includes('immelmann')) imm++;
      expect(r.crashed, `seed ${seed}`).toBe(false);
    }
    // a choice, not a script: sometimes a flat turn
    expect(imm, log.join('\n')).toBeGreaterThanOrEqual(8);
  });

  it('a veteran MiG bounced from behind at high closure pulls a loop: the attacker overshoots under it', { timeout: 60_000 }, () => {
    let loops = 0;
    const log: string[] = [];
    for (const seed of CHOICE_SEEDS) {
      const r = bounced('veteran', 0.9, seed);
      log.push(`seed ${seed}: ${r.seen.join(',') || 'none'} max ${r.maxGamma.toFixed(0)}°`);
      if (r.seen.includes('loop')) loops++;
      expect(r.crashed, `seed ${seed}`).toBe(false);
    }
    expect(loops, log.join('\n')).toBeGreaterThanOrEqual(8);
  });

  it('rookies (Recruit) fight flat: no loop, no Immelmann (a flat turn after the pass)', { timeout: 60_000 }, () => {
    for (const seed of SEEDS) {
      const h = headOn('recruit', 0, seed);
      expect(h.seen, `seed ${seed}`).toEqual([]);
      expect(h.maxGamma, `seed ${seed}`).toBeLessThan(45);
      // bounced, a rookie's break can still zoom (the old defensive break), but it never loops
      expect(bounced('recruit', 0, seed).seen, `seed ${seed}`).toEqual([]);
    }
  });

  it('Pilot-level enemies sometimes reverse in the vertical, but never loop (a veteran move)', { timeout: 120_000 }, () => {
    let imm = 0;
    for (const seed of CHOICE_SEEDS) {
      const h = headOn('pilot', 0.5, seed);
      if (h.seen.includes('immelmann')) imm++;
      expect(h.crashed, `seed ${seed}`).toBe(false);
      expect(bounced('pilot', 0.5, seed).seen, `seed ${seed}`).not.toContain('loop');
    }
    expect(imm).toBeGreaterThanOrEqual(2);
    expect(imm).toBeLessThanOrEqual(10);
  });

  it('no loop without the height for it: bounced at 1,200 m, the veteran breaks instead and stays up', () => {
    for (const seed of [1, 2, 3]) {
      const tw = makeAiWorld('veteran', undefined, seed);
      const w = tw.world;
      const red = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(20_000, 1_200, 20_000), heading: 0, speed: 250, ai: createAiBrain('fighter', { skill: 0.9, seed }) });
      const att = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(20_000, 1_250, 22_000), heading: 0, speed: 330 });
      red.stores.forEach((x) => (x.count = 0));
      const wa = watcher(red);
      runFor(w, 40, (t) => {
        att.input.throttle = 1;
        wa.sample(t);
      });
      expect(wa.w.seen, `seed ${seed}`).not.toContain('loop');
      expect(wa.w.crashed, `seed ${seed}`).toBe(false);
      expect(wa.w.minAgl, `seed ${seed}`).toBeGreaterThan(600);
    }
  });

  it('oblique turns in the rate fight: nose-high when fast, nose-low when slow (skilled pilots only)', { timeout: 120_000 }, () => {
    // a turning fight against a blue AI fighter that fights back (guns only)
    const rateFight = (difficulty: Difficulty, skill: number, seed: number) => {
      const tw = makeAiWorld(difficulty, undefined, seed);
      const w = tw.world;
      const red = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(20_000, 4_000, 20_000), heading: 0, speed: 230, ai: createAiBrain('fighter', { skill, seed }) });
      const blue = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(22_500, 4_200, 17_000), heading: Math.PI * 1.5, speed: 230, ai: createAiBrain('fighter', { skill: 0.8, seed: seed + 50 }) });
      red.stores.forEach((x) => (x.count = 0));
      blue.stores.forEach((x) => (x.count = 0));
      const gam: Record<string, number[]> = { 'oblique-high': [], 'oblique-low': [] };
      let crashed = false;
      tw.events.on('destroyed', (p) => {
        if (p.entity === red && p.weapon === 'collision') crashed = true;
      });
      // the rate the flight path is pitching (deg/s) while in each mode
      let prev = 0;
      runFor(w, 90, (t) => {
        const g = Math.asin(red.velocity.y / Math.max(1, red.velocity.length())) / DEG;
        const mode = (red.ai as unknown as { bfm: { mode: string } }).bfm.mode;
        if (t > 0 && red.aiState === 'BFM' && mode in gam) gam[mode].push((g - prev) * 60);
        prev = g;
        return !red.alive || !blue.alive;
      });
      expect(crashed, `${difficulty} seed ${seed}: flew into the ground`).toBe(false);
      return gam;
    };
    const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
    const vet = { high: [] as number[], low: [] as number[] };
    for (const seed of [1, 2, 3, 4]) {
      const g = rateFight('veteran', 0.9, seed);
      vet.high.push(...g['oblique-high']);
      vet.low.push(...g['oblique-low']);
      const r = rateFight('recruit', 0, seed);
      expect(r['oblique-high'].length + r['oblique-low'].length, `recruit seed ${seed}`).toBe(0);
    }
    // the skilled pilot flies both, and in them the flight path really pitches up / down
    expect(vet.high.length).toBeGreaterThan(60);
    expect(vet.low.length).toBeGreaterThan(60);
    expect(mean(vet.high)).toBeGreaterThan(0);
    expect(mean(vet.low)).toBeLessThan(0);
  });
});
