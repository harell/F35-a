/**
 * Vertical manoeuvres and t03 Turn and Gun: the loop / Immelmann detector on synthetic flight paths
 * and in the real flight model, groups placed relative to the player, the 'respawn' action, and the
 * lesson flown end to end with scripted stick inputs and by the mission bot.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { missionById, terrainPadsFor, validateMission } from '../src/missions';
import { createManeuverTracker, updateManeuvers, type ManeuverId } from '../src/missions/runtime/maneuvers';
import type { AircraftEntity } from '../src/sim/entities';
import { initFlight } from '../src/sim/flight/FlightModel';
import { flatLand, harness, killGroup, shieldPlayer, type Harness } from './missions-helpers';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { runPlaythrough } from './missions-bot';

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

/** Straight and level at `kt` for `seconds`: the stick holds the flight path on the horizon (neutral stick holds a climb or dive). */
function levelFlight(h: Harness, kt: number, seconds: number, each?: () => boolean | void): void {
  const p = h.world.player!;
  h.run(seconds, () => {
    shieldPlayer(h);
    const inp = p.input;
    inp.throttle = p.flight.ias < kt * KT ? 1 : 0.6;
    inp.roll = 0;
    inp.yaw = 0;
    inp.pitch = Math.max(-0.5, Math.min(1, -attitude(p).gamma * 4));
    return each?.();
  });
}

const T03 = () => missionById('t03')!;
const obj = (h: Harness, id: string) => h.runner.objectives.find((o) => o.id === id)!.state;
const drone = (h: Harness, group: string) => h.world.aircraft.find((a) => a.groupId === group && a.alive) ?? null;
/** How far `d` is ahead of the jet along its track (m; negative: behind it). */
const ahead = (h: Harness, d: AircraftEntity) => {
  const p = h.world.player!;
  return d.position.clone().sub(p.position).dot(_f.copy(p.velocity).setY(0).normalize());
};

/** The drill as briefed: level at 350 kt while the head-on drone passes under, ~700 m on, then the Immelmann. */
function passAndImmelmann(h: Harness, d: AircraftEntity): void {
  cruise(h, 350, 30, () => ahead(h, d) < -700);
  fly(h, 'immelmann', 30);
  h.run(0.3);
}

describe('t03 Turn and Gun', () => {
  it('is a valid lesson, the last one g01 wants, leading into the campaign', () => {
    const def = T03();
    expect(def.kind).toBe('training');
    expect(validateMission(def)).toEqual([]);
    expect(def.recommendedLoadout).toBe('clean');
  });

  it('the real flight model: a stick-flown Immelmann from 350 kt is recognised (a loop is still called, though no drill asks for one)', { timeout: 60_000 }, () => {
    const h = harness(T03(), 'pilot', undefined, flatLand(10));
    fly(h, 'immelmann', 30);
    expect(obj(h, 'o_imm')).toBe('complete');
    const p = h.world.player!;
    initFlight(p, { heading: Math.PI / 2, speed: 350 * KT });
    fly(h, 'loop', 40);
    expect(h.of('hud:message').some((m) => (m as { text: string }).text === 'LOOP')).toBe(true);
  });

  it('flown end to end: head-on drone, Immelmann, it is ahead and below going the jet\'s way, gun kill, done', { timeout: 60_000 }, () => {
    const h = harness(T03(), 'pilot', undefined, flatLand(10));
    const p = h.world.player!;
    // the drone appears 3 km ahead, 150 m below, flying at the jet
    cruise(h, 350, 4);
    const d = drone(h, 'imm_drone')!;
    expect(d).not.toBeNull();
    expect(ahead(h, d)).toBeGreaterThan(2000);
    expect(d.position.y - p.position.y).toBeLessThan(-100);
    expect(d.velocity.dot(p.velocity)).toBeLessThan(0);
    // let it pass under the jet, extend ~3 s (it is ~700 m behind), then the Immelmann
    passAndImmelmann(h, d);
    expect(obj(h, 'o_imm')).toBe('complete');
    expect(obj(h, 'o_kill')).toBe('active');
    // rolled out high and slow, the drone ahead and below, going the jet's way: a ~40° dive onto it
    expect(d.position.y - p.position.y).toBeLessThan(-800);
    expect(ahead(h, d)).toBeGreaterThan(1000);
    expect(d.velocity.dot(p.velocity)).toBeGreaterThan(0);
    expect(p.flight.ias).toBeLessThan(220 * KT);
    killGroup(h, 'imm_drone');
    h.run(1);
    expect(obj(h, 'o_kill')).toBe('complete');
    expect(h.runner.state).toBe('success');
  });

  it('a drone that gets away after the Immelmann is not a kill: the next one waits for straight and level, fast and high (the hint says so)', { timeout: 60_000 }, () => {
    const h = harness(T03(), 'pilot', undefined, flatLand(10));
    const p = h.world.player!;
    cruise(h, 350, 4);
    const first = drone(h, 'imm_drone')!;
    passAndImmelmann(h, first);
    expect(obj(h, 'o_imm')).toBe('complete');
    // it reaches its target and blows up (no attacker): not the player's kill
    killGroup(h, 'imm_drone', false);
    h.run(0.5);
    expect(obj(h, 'o_kill')).toBe('active');
    expect(h.runner.state).toBe('running');
    // dive in afterburner: soon fast (> 280 kt) and still high (> 2,300 ft), but not level: no drone yet
    let sawFastHighDive = false;
    const hints = new Set<string>();
    h.run(12, () => {
      shieldPlayer(h);
      p.input.throttle = 1;
      p.input.roll = 0;
      p.input.pitch = attitude(p).gamma > -25 * DEG ? -0.3 : 0;
      if (h.runner.hint) hints.add(h.runner.hint);
      if (p.flight.ias > 290 * KT && p.position.y > 900 && attitude(p).gamma < -15 * DEG) sawFastHighDive = true;
      expect(drone(h, 'imm_drone'), `t=${h.world.time.toFixed(1)}: drone while diving`).toBeNull();
      return p.position.y < 900;
    });
    expect(sawFastHighDive).toBe(true);
    // the hint names the gate's numbers (playtest r1, 1.4-l: it said 2,000 ft and 300 knots for a 700 m / 280 kt gate)
    expect([...hints].join(' | ')).toMatch(/straight and level above 2,300 ft, over 280 knots/);
    // pull out and fly level: now it comes, head-on again
    levelFlight(h, 350, 60, () => drone(h, 'imm_drone') !== null);
    const next = drone(h, 'imm_drone');
    expect(next).not.toBeNull();
    expect(next!.id).not.toBe(first.id);
    expect(ahead(h, next!)).toBeGreaterThan(2000);
    expect(next!.velocity.dot(p.velocity)).toBeLessThan(0);
    // the player's own kill completes it
    killGroup(h, 'imm_drone');
    h.run(1);
    expect(obj(h, 'o_kill')).toBe('complete');
    expect(h.runner.state).toBe('success');
  });

  it('a drone shot down before the Immelmann does not count: a new one comes head-on', { timeout: 60_000 }, () => {
    const h = harness(T03(), 'pilot', undefined, flatLand(10));
    cruise(h, 350, 4);
    const first = drone(h, 'imm_drone')!;
    killGroup(h, 'imm_drone');
    cruise(h, 350, 6);
    const second = drone(h, 'imm_drone');
    expect(second).not.toBeNull();
    expect(second!.id).not.toBe(first.id);
    expect(obj(h, 'o_kill')).toBe('pending');
    expect(h.runner.state).toBe('running');
  });
});

describe('t03 Turn and Gun, flown by the mission bot', () => {
  it('on the real LINZ coast with the stick and the gun, no shortcuts: the Immelmann, then the gun kill from behind', { timeout: 300_000 }, () => {
    const def = missionById('t03')!;
    const terrain = new TerrainQueryImpl(runSync(generateTerrain({ theater: def.theater, seed: def.seed, resolution: 512, features: allFeatures(def.theater, []), pads: terrainPadsFor(def) })));
    let won = 0;
    const log: string[] = [];
    for (const seed of [0, 1, 2, 3, 4, 5]) {
      const r = runPlaythrough('t03', 'pilot', seed, terrain, { maxT: 720, log: true });
      const at = (re: RegExp) => r.events.find((e) => re.test(e))?.trim().split(' ')[0] ?? '-';
      log.push(`seed ${seed}: ${r.state}@${r.t}s immelmann@${at(/HUD IMMELMANN$/)} kill@${at(/DESTROYED Drone \d+ by PLAYER/)}`);
      if (r.state !== 'success') continue;
      won++;
      expect(r.alive, `seed ${seed}`).toBe(true);
      // the manoeuvre was recognised by the mission's own detector, then the drone was gunned
      const imm = r.events.findIndex((e) => /HUD IMMELMANN$/.test(e));
      const kill = r.events.findIndex((e) => /DESTROYED Drone \d+ by PLAYER/.test(e));
      expect(imm, `seed ${seed}: no Immelmann`).toBeGreaterThanOrEqual(0);
      expect(kill, `seed ${seed}: no kill after the Immelmann`).toBeGreaterThan(imm);
      expect(r.events.some((e) => /LAUNCH /.test(e) && /PLAYER/.test(e)), `seed ${seed}: a missile left the jet`).toBe(false);
    }
    expect(won, log.join('\n')).toBeGreaterThanOrEqual(5);
  });
});
