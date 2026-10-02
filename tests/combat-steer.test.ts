/**
 * Issue #65 (playtest 3.3-c): the GPS / glide bomb STEER cue gives a direction (STEER LEFT /
 * STEER RIGHT) and reads BOMB AWAY instead while the player's own bomb is still guiding onto the
 * designated target. The release doesn't follow the cue's cone or turn circle: from altitude the
 * bombs turn onto targets the cue calls off the cone or inside the turn, so the release reads the
 * range only, as before. The 1.1 × range pad on Recruit / Pilot stays for the JDAM, which still
 * reaches there, and is gone for the glide bombs, which fall short past the cue.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import type { LoadoutId } from '../src/core/types';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { MUNITIONS } from '../src/sim/weapons/defs';
import { gpsMaxRange } from '../src/sim/weapons/dlz';
import type { SimWorld } from '../src/sim/api';
import type { AircraftEntity, MissileEntity } from '../src/sim/entities';
import { FlatTerrain } from './combat-helpers';

const DEG = Math.PI / 180;
const DT = 1 / 60;
type Bomb = 'gbu53' | 'gbu39' | 'gbu31';
const LOADOUT: Record<Bomb, LoadoutId> = { gbu53: 'strike_sdb2', gbu39: 'sead_stealth', gbu31: 'strike_stealth' };

function run(world: SimWorld, seconds: number, each?: () => boolean | void): void {
  for (let i = 0; i < seconds * 60; i++) {
    world.step(DT);
    if (each?.()) return;
  }
}

/**
 * A jet with `weapon` selected and designated on an EWR at the origin, then put `d` m from it at
 * `alt`, flying north (−z) with the target `deg` right of the ground track (negative = left).
 */
function setup(weapon: Bomb, alt: number, d: number, deg: number, isPlayer = true): { w: SimWorld; p: AircraftEntity; tgt: number } {
  const w = createSimWorld({ terrain: new FlatTerrain(0), difficulty: DIFFICULTIES.pilot, events: new EventBus(), combat: createCombatSystemSeeded(1) });
  const tgt = w.spawnGround({ type: 'ewr', team: 'red', position: new Vector3(0, 0, 0), name: 'EWR' });
  const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer, position: new Vector3(0, alt, 5_000), heading: 0, speed: 250, loadout: LOADOUT[weapon] });
  run(w, 1);
  w.combat.selectWeapon(p, weapon, w);
  w.combat.designate(p, tgt.id, w);
  run(w, 0.2);
  expect(p.radar.groundPoint).not.toBeNull();
  place(p, alt, d, deg);
  return { w, p, tgt: tgt.id };
}

function place(p: AircraftEntity, alt: number, d: number, deg: number): void {
  p.position.set(-Math.sin(deg * DEG) * d, alt, Math.cos(deg * DEG) * d);
  p.velocity.set(0, 0, -250);
}

/** Press release once; returns the denial reasons and the munitions launched within 3 s. */
function pickle(w: SimWorld, p: AircraftEntity, weapon: Bomb, alt: number, d: number, deg: number): { denied: string[]; launched: MissileEntity[] } {
  const denied: string[] = [];
  const launched: MissileEntity[] = [];
  const offD = w.events.on('weapon:denied', (e) => denied.push(e.reason));
  const offL = w.events.on('munition:launch', (e) => launched.push(e.missile));
  w.combat.fire(p, w, weapon);
  // hold the geometry while the bay doors open
  run(w, 1.5, () => {
    place(p, alt, d, deg);
    return launched.length > 0;
  });
  offD?.();
  offL?.();
  return { denied, launched };
}

describe('STEER gives a direction (issue #65)', () => {
  it('a target off the release cone reads steer +1 to the right of the ground track, −1 to the left; 0 inside the cone', () => {
    for (const weapon of ['gbu53', 'gbu39', 'gbu31'] as const) {
      const right = setup(weapon, 7_000, 15_000, 90);
      expect(right.w.combat.bombImpactPoint(right.p, right.w), weapon).toMatchObject({ offAxis: true, steer: 1, inRange: false });
      const left = setup(weapon, 7_000, 15_000, -90);
      expect(left.w.combat.bombImpactPoint(left.p, left.w), weapon).toMatchObject({ offAxis: true, steer: -1, inRange: false });
      const behindLeft = setup(weapon, 7_000, 3_000, -160);
      expect(behindLeft.w.combat.bombImpactPoint(behindLeft.p, behindLeft.w), weapon).toMatchObject({ offAxis: true, steer: -1 });
      const ahead = setup(weapon, 7_000, 5_000, 10);
      expect(ahead.w.combat.bombImpactPoint(ahead.p, ahead.w), weapon).toMatchObject({ offAxis: false, steer: 0 });
    }
  });
});

/** Let the bomb fly out (300 s at most); true when the target it was released at is destroyed. */
function hits(w: SimWorld, m: MissileEntity, tgt: number): boolean {
  const target = w.getEntity(tgt)!;
  run(w, 300, () => !m.alive);
  return !target.alive;
}

describe("the player's GPS / glide bomb release reads the range, not the cue's cone or turn circle (issue #65)", () => {
  it('off the release cone from altitude the release goes and the bomb turns onto the target', () => {
    for (const [weapon, deg] of [
      ['gbu53', 90],
      ['gbu53', -90],
      ['gbu39', 120],
      ['gbu31', -45],
    ] as const) {
      const { w, p, tgt } = setup(weapon, 7_000, 9_000, deg);
      expect(w.combat.bombImpactPoint(p, w), `${weapon} ${deg}°`).toMatchObject({ offAxis: true, steer: deg > 0 ? 1 : -1 });
      const r = pickle(w, p, weapon, 7_000, 9_000, deg);
      expect(r.denied, `${weapon} ${deg}°`).toEqual([]);
      expect(r.launched, `${weapon} ${deg}°`).toHaveLength(1);
      expect(hits(w, r.launched[0], tgt), `${weapon} ${deg}°`).toBe(true);
    }
  });

  it("a JDAM from 7,600 m with the target 1.2 km ahead and 14° off (inside the cue's turn circle) is released and hits", () => {
    const { w, p, tgt } = setup('gbu31', 7_600, 1_200, 14);
    const r = pickle(w, p, 'gbu31', 7_600, 1_200, 14);
    expect(r.denied).toEqual([]);
    expect(r.launched).toHaveLength(1);
    expect(hits(w, r.launched[0], tgt)).toBe(true);
  });

  it('inside the cone and in range it releases, as before', () => {
    for (const [weapon, deg] of [
      ['gbu53', 45],
      ['gbu39', -45],
      ['gbu31', 20],
    ] as const) {
      const d = weapon === 'gbu31' ? 6_000 : 12_000;
      const { w, p } = setup(weapon, 7_000, d, deg);
      expect(w.combat.bombImpactPoint(p, w)!.inRange, weapon).toBe(true);
      const r = pickle(w, p, weapon, 7_000, d, deg);
      expect(r.denied, weapon).toEqual([]);
      expect(r.launched, weapon).toHaveLength(1);
    }
  });

  it('on Pilot a JDAM may go 1.1 × past the cue and still hits; a glide bomb gets no pad (it falls short there)', () => {
    const jdamD = 1.09 * gpsMaxRange(MUNITIONS.gbu31, 7_000, 250, 0);
    const jdam = setup('gbu31', 7_000, jdamD, 0);
    expect(jdam.w.combat.bombImpactPoint(jdam.p, jdam.w)!.inRange).toBe(false);
    const r = pickle(jdam.w, jdam.p, 'gbu31', 7_000, jdamD, 0);
    expect(r.denied).toEqual([]);
    expect(r.launched).toHaveLength(1);
    expect(hits(jdam.w, r.launched[0], jdam.tgt)).toBe(true);
    // from 7,000 m a StormBreaker or SDB released 1.05 × past the cue 45° off the nose falls short
    for (const weapon of ['gbu53', 'gbu39'] as const) {
      const d = 1.05 * gpsMaxRange(MUNITIONS[weapon], 7_000, 250, 0);
      const { w, p } = setup(weapon, 7_000, d, 45);
      const before = w.combat.remaining(p, weapon);
      const g = pickle(w, p, weapon, 7_000, d, 45);
      expect(g.denied, weapon).toEqual(['OUT OF RANGE']);
      expect(g.launched, weapon).toHaveLength(0);
      expect(w.combat.remaining(p, weapon)).toBe(before);
    }
  });
});

describe('BOMB AWAY while our own bomb is guiding (issue #65)', () => {
  it('set while our StormBreaker flies to the designated target, cleared for another target and once it lands', () => {
    const { w, p, tgt } = setup('gbu53', 7_000, 12_000, 0);
    // a second target near the first, picked up by the radar on the run-in
    const other = w.spawnGround({ type: 'ewr', team: 'red', position: new Vector3(1_500, 0, -500), name: 'EWR 2' });
    run(w, 1, () => place(p, 7_000, 12_000, 0));
    expect(w.combat.bombImpactPoint(p, w)!.bombAway).toBe(false);
    const r = pickle(w, p, 'gbu53', 7_000, 12_000, 0);
    expect(r.launched).toHaveLength(1);
    const m = r.launched[0];
    expect(m.targetId).toBe(tgt);
    expect(w.combat.bombImpactPoint(p, w)!.bombAway).toBe(true);
    // another target designated: our bomb isn't flying to that one
    w.combat.designate(p, other.id, w);
    expect(p.radar.designatedId).toBe(other.id);
    run(w, 0.1);
    expect(w.combat.bombImpactPoint(p, w)!.bombAway).toBe(false);
    w.combat.designate(p, tgt, w);
    run(w, 0.1);
    // egress: the jet turns away, the target is behind it, where STEER read "turn back for the bomb"
    p.velocity.set(0, 0, 250);
    expect(w.combat.bombImpactPoint(p, w)).toMatchObject({ offAxis: true, bombAway: true });
    run(w, 200, () => !m.alive);
    expect(m.alive).toBe(false);
    const after = w.combat.bombImpactPoint(p, w);
    if (after) expect(after.bombAway).toBe(false);
  });
});
