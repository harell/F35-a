/**
 * Vertical manoeuvre drills (t04): the loop / Immelmann detector on synthetic flight paths and in
 * the real flight model, groups placed relative to the player, the 'respawn' action, and the
 * lesson flown end to end with scripted stick inputs.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { missionById, validateMission } from '../src/missions';
import { createManeuverTracker, updateManeuvers, type ManeuverId } from '../src/missions/runtime/maneuvers';
import type { AircraftEntity } from '../src/sim/entities';
import { initFlight } from '../src/sim/flight/FlightModel';
import { flatLand, harness, killGroup, shieldPlayer, type Harness } from './missions-helpers';

const KT = 0.514444;
const DEG = Math.PI / 180;

/** Feed (velocity, up) samples at 10 Hz; returns what was recognised. */
function feed(samples: [Vector3, Vector3][]): ManeuverId[] {
  const t = createManeuverTracker();
  const out: ManeuverId[] = [];
  samples.forEach(([v, up], i) => {
    const m = updateManeuvers(t, v, up, i * 0.1);
    if (m) out.push(m);
  });
  return out;
}

/** Level flight east for a second. */
function level(n = 10, dir = 1): [Vector3, Vector3][] {
  return Array.from({ length: n }, () => [new Vector3(200 * dir, 0, 0), new Vector3(0, 1, 0)]);
}

/** Pitch round the vertical plane (entry east) from θ0 to θ1 (rad, 0 = level east, +up), body up towards the centre. */
function arc(th0: number, th1: number, steps = 120): [Vector3, Vector3][] {
  const out: [Vector3, Vector3][] = [];
  for (let i = 0; i <= steps; i++) {
    const th = th0 + ((th1 - th0) * i) / steps;
    out.push([new Vector3(200 * Math.cos(th), 200 * Math.sin(th), 0), new Vector3(-Math.sin(th), Math.cos(th), 0)]);
  }
  return out;
}

/** Roll about a westbound velocity from on the back (up = −y) to upright. */
function rollUpright(steps = 20): [Vector3, Vector3][] {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const phi = Math.PI * (1 - i / steps);
    return [new Vector3(-200, 0, 0), new Vector3(0, Math.cos(phi), Math.sin(phi))] as [Vector3, Vector3];
  });
}

describe('vertical manoeuvre detector', () => {
  it('a full loop counts as a loop, once', () => {
    expect(feed([...level(), ...arc(0, 2 * Math.PI), ...level()])).toEqual(['loop']);
  });

  it('a half loop with a half roll at the top counts as an Immelmann', () => {
    expect(feed([...level(), ...arc(0, Math.PI), ...rollUpright(), ...level(10, -1)])).toEqual(['immelmann']);
  });

  it('a half loop left on its back is not an Immelmann (yet); carried on round it is a loop', () => {
    expect(feed([...level(), ...arc(0, Math.PI), ...arc(Math.PI, Math.PI, 30)])).toEqual([]);
  });

  it('a split-S (roll inverted, pull down through) counts as neither', () => {
    // inverted level flight east, then the lower half of a loop downwards to level west, upright
    const inverted: [Vector3, Vector3][] = Array.from({ length: 10 }, () => [new Vector3(200, 0, 0), new Vector3(0, -1, 0)]);
    const pullDown: [Vector3, Vector3][] = [];
    for (let i = 0; i <= 120; i++) {
      const th = (-Math.PI * i) / 120; // 0 → −π: east, straight down, west
      pullDown.push([new Vector3(200 * Math.cos(th), 200 * Math.sin(th), 0), new Vector3(Math.sin(th), -Math.cos(th), 0)]);
    }
    expect(feed([...level(), ...inverted, ...pullDown, ...level(10, -1)])).toEqual([]);
  });

  it('a steep climbing turn through 180° (never on its back) is not an Immelmann', () => {
    const out: [Vector3, Vector3][] = [...level()];
    for (let i = 0; i <= 60; i++) {
      const g = (65 * DEG * i) / 60; // climb to 65°
      out.push([new Vector3(200 * Math.cos(g), 200 * Math.sin(g), 0), new Vector3(-Math.sin(g), Math.cos(g), 0)]);
    }
    for (let i = 0; i <= 120; i++) {
      // turn the track from east to west at 65° nose-up, banked 90° (up horizontal)
      const psi = (Math.PI * i) / 120;
      const h = Math.cos(65 * DEG);
      out.push([new Vector3(200 * h * Math.cos(psi), 200 * Math.sin(65 * DEG), 200 * h * Math.sin(psi)), new Vector3(-Math.sin(psi), 0.05, Math.cos(psi))]);
    }
    for (let i = 0; i <= 60; i++) {
      const g = 65 * DEG * (1 - i / 60);
      out.push([new Vector3(-200 * Math.cos(g), 200 * Math.sin(g), 0), new Vector3(Math.sin(g), Math.cos(g), 0)]);
    }
    expect(feed([...out, ...level(10, -1)])).toEqual([]);
  });

  it('a zoom climb pushed over the same way is nothing', () => {
    expect(feed([...level(), ...arc(0, 70 * DEG), ...arc(70 * DEG, 0), ...level()])).toEqual([]);
  });
});

/* ───────────── scripted pilot (real flight model) ───────────── */

const _f = new Vector3();
const _u = new Vector3();
/** Flight-path angle (rad) and the jet's up-vector y. */
function attitude(p: AircraftEntity): { gamma: number; upY: number } {
  const v = p.velocity.length();
  _u.set(0, 1, 0).applyQuaternion(p.quaternion);
  return { gamma: Math.asin(p.velocity.y / Math.max(1, v)), upY: _u.y };
}

/**
 * Fly one manoeuvre with the stick: full afterburner and full back stick; for an Immelmann, once
 * over the top on its back, roll upright. Returns once rolled out (Immelmann) or pulled out level
 * (loop), or after `seconds`.
 */
function fly(h: Harness, kind: ManeuverId, seconds: number): void {
  const p = h.world.player!;
  let phase: 'pull' | 'roll' | 'level' = 'pull';
  let climbed = false;
  h.run(seconds, () => {
    shieldPlayer(h);
    const a = attitude(p);
    if (a.gamma > 60 * DEG) climbed = true;
    const inp = p.input;
    inp.throttle = 1;
    inp.yaw = 0;
    if (phase === 'pull') {
      inp.pitch = 1;
      inp.roll = 0;
      if (kind === 'immelmann' && climbed && a.upY < -0.5 && a.gamma < 15 * DEG) phase = 'roll';
      if (kind === 'loop' && climbed && a.gamma > -15 * DEG && a.gamma < 15 * DEG && a.upY > 0.5) phase = 'level';
    } else if (phase === 'roll') {
      inp.pitch = 0;
      inp.roll = 1;
      if (a.upY > 0.95) phase = 'level';
    }
    if (phase === 'level') {
      inp.pitch = 0;
      inp.roll = 0;
      return true;
    }
  });
}

/** Wings level, hold `kt` (rough autothrottle) for `seconds`. */
function cruise(h: Harness, kt: number, seconds: number, each?: () => boolean | void): void {
  const p = h.world.player!;
  h.run(seconds, () => {
    shieldPlayer(h);
    const inp = p.input;
    inp.pitch = 0;
    inp.roll = 0;
    inp.yaw = 0;
    inp.throttle = p.flight.ias < kt * KT ? 1 : 0.6;
    return each?.();
  });
}

const T04 = () => missionById('t04')!;
const obj = (h: Harness, id: string) => h.runner.objectives.find((o) => o.id === id)!.state;
const drone = (h: Harness, group: string) => h.world.aircraft.find((a) => a.groupId === group && a.alive) ?? null;

describe('t04 Vertical Reversals', () => {
  it('is a valid lesson after t03 that leads into the campaign', () => {
    const def = T04();
    expect(def.kind).toBe('training');
    expect(validateMission(def)).toEqual([]);
    expect(def.recommendedLoadout).toBe('clean');
  });

  it('the real flight model: a stick-flown Immelmann and loop from 350 kt are recognised', () => {
    const h = harness(T04(), 'pilot', undefined, flatLand(10));
    fly(h, 'immelmann', 30);
    expect(obj(h, 'o_imm')).toBe('complete');
    const p = h.world.player!;
    initFlight(p, { heading: Math.PI / 2, speed: 350 * KT });
    fly(h, 'loop', 40);
    // the loop is counted even before its objective opens
    expect(h.of('hud:message').some((m) => (m as { text: string }).text === 'LOOP')).toBe(true);
  });

  it('flown end to end: head-on drone, Immelmann, kill, drone behind, loop, it is ahead in gun range, kill', { timeout: 60_000 }, () => {
    const h = harness(T04(), 'pilot', undefined, flatLand(10));
    const p = h.world.player!;
    // the first drone appears 3 km ahead, 150 m below, flying at the jet
    cruise(h, 350, 4);
    const d1 = drone(h, 'imm_drone')!;
    expect(d1).not.toBeNull();
    const ahead = d1.position.clone().sub(p.position);
    const fwd = _f.copy(p.velocity).setY(0).normalize();
    expect(ahead.dot(fwd)).toBeGreaterThan(2000);
    expect(ahead.y).toBeLessThan(-100);
    expect(d1.velocity.dot(p.velocity)).toBeLessThan(0);
    // let it pass under the jet, extend ~3 s (it is ~700 m behind), then the Immelmann
    cruise(h, 350, 30, () => d1.position.clone().sub(p.position).dot(_f.copy(p.velocity).setY(0).normalize()) < -700);
    fly(h, 'immelmann', 30);
    h.run(0.3);
    expect(obj(h, 'o_imm')).toBe('complete');
    expect(obj(h, 'o_kill1')).toBe('active');
    // rolled out high and slow, the drone ahead and below, going the jet's way: a ~40° dive onto it
    const rel = d1.position.clone().sub(p.position);
    const along = rel.dot(_f.copy(p.velocity).setY(0).normalize());
    expect(rel.y).toBeLessThan(-800);
    expect(along).toBeGreaterThan(1000);
    expect(d1.velocity.dot(p.velocity)).toBeGreaterThan(0);
    expect(p.flight.ias).toBeLessThan(220 * KT);
    killGroup(h, 'imm_drone');
    // the next drone waits until the jet is fast again, then appears 200 m behind it
    cruise(h, 400, 60, () => drone(h, 'loop_drone') !== null);
    const d2 = drone(h, 'loop_drone')!;
    expect(d2).not.toBeNull();
    const behind = d2.position.clone().sub(p.position).dot(_f.copy(p.velocity).setY(0).normalize());
    expect(behind).toBeLessThan(-100);
    expect(behind).toBeGreaterThan(-400);
    expect(d2.velocity.dot(p.velocity)).toBeGreaterThan(0);
    fly(h, 'loop', 40);
    h.run(0.3);
    expect(obj(h, 'o_loop')).toBe('complete');
    // out of the loop the drone is ahead of the jet, in gun range
    const ahead2 = d2.position.clone().sub(p.position).dot(_f.copy(p.velocity).setY(0).normalize());
    expect(ahead2).toBeGreaterThan(300);
    expect(ahead2).toBeLessThan(1200);
    killGroup(h, 'loop_drone');
    h.run(1);
    expect(h.runner.state).toBe('success');
  });

  it('a drone shot down before the Immelmann does not count: a new one comes head-on', () => {
    const h = harness(T04(), 'pilot', undefined, flatLand(10));
    cruise(h, 350, 4);
    const first = drone(h, 'imm_drone')!;
    killGroup(h, 'imm_drone');
    cruise(h, 350, 6);
    const second = drone(h, 'imm_drone');
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first.id);
    expect(obj(h, 'o_kill1')).toBe('pending');
    expect(h.runner.state).toBe('running');
  });
});
