/**
 * A JDAM released too close flies long (dlz.ts gpsMinRange, playtest 2026-10-11): t07's player released
 * on IN RANGE close in, as the briefing then said ("low and close"), and the bomb landed a kilometre or two
 * past the rat. Inside GPS_MIN_FRACTION of the reach the cue reads TOO CLOSE, not IN RANGE; every release
 * the cue calls IN RANGE hits.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { GPS_MIN_FRACTION, gpsMaxRange, gpsMinRange } from '../src/sim/weapons/dlz';
import { MUNITIONS } from '../src/sim/weapons/defs';
import type { MissileEntity } from '../src/sim/entities';
import { FlatTerrain } from './combat-helpers';

const DT = 1 / 60;

/** A JDAM released level `range` m short of a still target, `alt` m up at `speed`: the cue then, and the miss (m). */
function drop(alt: number, speed: number, range: number): { inRange: boolean; tooClose: boolean; miss: number } {
  const w = createSimWorld({ terrain: new FlatTerrain(), difficulty: DIFFICULTIES.pilot, events: new EventBus(), combat: createCombatSystemSeeded(1) });
  const t = w.spawnGround({ type: 'hangar', team: 'red', position: new Vector3(0, 0, 0), name: 'T' });
  const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(-range, alt, 0), heading: Math.PI / 2, speed, loadout: 'strike_mixed' });
  w.combat.selectWeapon(p, 'gbu31', w);
  const hold = (n: number) => {
    for (let i = 0; i < n; i++) {
      w.step(DT);
      p.position.set(-range, alt, 0);
      p.velocity.set(speed, 0, 0);
    }
  };
  // the jet's sensors pick the target up first, then TGT designates it
  hold(60);
  w.combat.designate(p, t.id, w);
  hold(18);
  expect(p.radar.groundPoint).not.toBeNull();
  const cue = w.combat.bombImpactPoint(p, w)!;
  const { inRange, tooClose } = cue;
  const launches: MissileEntity[] = [];
  w.events.on('munition:launch', (e) => {
    if (e.shooter === p) launches.push(e.missile);
  });
  w.combat.fire(p, w, 'gbu31', t.id);
  for (let i = 0; i < 300 && !launches.length; i++) w.step(DT);
  expect(launches).toHaveLength(1);
  for (let i = 0; i < 120 * 60 && launches[0].alive; i++) w.step(DT);
  return { inRange, tooClose, miss: launches[0].position.distanceTo(t.position) };
}

describe('JDAM minimum range', { timeout: 120_000 }, () => {
  it('is GPS_MIN_FRACTION of the reach for the JDAM, none for the StormBreaker', () => {
    expect(gpsMinRange(MUNITIONS.gbu31 as never, 2_000)).toBe(GPS_MIN_FRACTION * 2_000);
    expect(gpsMinRange(MUNITIONS.gbu53 as never, 2_000)).toBe(0);
  });

  for (const [alt, speed] of [[1_000, 200], [1_500, 220], [2_500, 220]] as const) {
    it(`from ${alt} m at ${speed} m/s: TOO CLOSE flies long, every IN RANGE release hits`, () => {
      const rMax = gpsMaxRange(MUNITIONS.gbu31 as never, alt, speed, 0);
      const close = drop(alt, speed, 0.45 * rMax);
      expect(close.tooClose).toBe(true);
      expect(close.inRange).toBe(false);
      expect(close.miss).toBeGreaterThan(300);
      for (const f of [0.72, 0.85, 0.97]) {
        const r = drop(alt, speed, f * rMax);
        expect(r.inRange, `${f} of the reach`).toBe(true);
        expect(r.miss, `${f} of the reach`).toBeLessThan(15);
      }
    });
  }
});
