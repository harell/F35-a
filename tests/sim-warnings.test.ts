import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { WarningId } from '../src/core/types';
import { flatTerrain, makeWorld, run } from './sim-fakes';

function warningLog(tw: ReturnType<typeof makeWorld>) {
  return tw.of('warning');
}

describe('ICAWS warnings', () => {
  it('PULL UP when diving at the ground, cleared after recovery', () => {
    const tw = makeWorld('veteran', flatTerrain(0));
    const ac = tw.world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 3000, 0), heading: 0, speed: 250 });
    let firstAlt = -1;
    run(tw.world, 45, (t) => {
      ac.input.pitch = t < 2 ? -1 : 0;
      if (firstAlt < 0 && ac.warnings.has('pull_up')) firstAlt = ac.position.y;
      return firstAlt > 0;
    });
    expect(firstAlt).toBeGreaterThan(300);
    expect(warningLog(tw)).toContainEqual({ id: 'pull_up', active: true });
    // pull out
    run(tw.world, 12, () => {
      ac.input.pitch = 1;
      ac.input.throttle = 1;
    });
    expect(ac.alive).toBe(true);
    expect(ac.warnings.has('pull_up')).toBe(false);
    expect(warningLog(tw)).toContainEqual({ id: 'pull_up', active: false });
  });

  it('no PULL UP in level flight at low altitude over flat terrain; ALTITUDE when descending below 500 ft', () => {
    const tw = makeWorld('pilot', flatTerrain(100));
    const ac = tw.world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 100 + 120, 0), heading: 0, speed: 230 });
    run(tw.world, 5);
    expect(ac.warnings.has('pull_up')).toBe(false);
    expect(ac.warnings.has('altitude')).toBe(false);
    run(tw.world, 3, () => {
      ac.input.pitch = -0.08;
    });
    expect(ac.flight.verticalSpeed).toBeLessThan(-1.5);
    expect(ac.warnings.has('altitude')).toBe(true);
  });

  it('BINGO / FUEL LOW are mutually exclusive thresholds', () => {
    const tw = makeWorld('pilot');
    const ac = tw.world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 6000, 0), heading: 0, speed: 230, fuel: 0.25 });
    run(tw.world, 2);
    expect(ac.warnings.has('fuel_low')).toBe(true);
    expect(ac.warnings.has('bingo')).toBe(false);
    ac.flight.fuel = 0.1 * 8278;
    run(tw.world, 5);
    expect(ac.warnings.has('bingo')).toBe(true);
    expect(ac.warnings.has('fuel_low')).toBe(false);
  });

  it('MISSILE, SPIKE, damage and countermeasure warnings follow the aircraft state', () => {
    const tw = makeWorld('pilot');
    const ac = tw.world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 6000, 0), heading: 0, speed: 230, loadout: 'a2a_stealth' });
    run(tw.world, 0.5);
    const none: WarningId[] = ['missile', 'spike', 'flares_low', 'chaff_low', 'engine_fire', 'hydraulics', 'damage'];
    for (const id of none) expect(ac.warnings.has(id)).toBe(false);

    ac.incoming.push({ missileId: 99, bearing: 0, elevation: 0, distance: 5000, timeToImpact: 8, guidance: 'radar' });
    ac.rwr.push({ sourceId: 42, kind: 'fighter', symbol: '29', bearing: 0.2, strength: 0.8, state: 'track', age: 0 });
    ac.flares = 3;
    ac.chaff = 2;
    ac.damage.fire = true;
    ac.sim!.fireTimer = 1e9; // keep burning
    ac.damage.hydraulics = 0.7;
    ac.health = 40;
    run(tw.world, 1);
    for (const id of none) expect(ac.warnings.has(id)).toBe(true);

    // defeated missile dropped by MAWS: the MISSILE warning (and Betty) clears within 0.5 s
    // (regression i1: it used to hang on for 1.5 s after the incoming list emptied)
    const cleared: number[] = [];
    tw.events.on('warning', (w) => {
      if (w.id === 'missile' && !w.active) cleared.push(tw.world.time);
    });
    const t0 = tw.world.time;
    ac.incoming.length = 0;
    run(tw.world, 0.1);
    expect(ac.warnings.has('missile')).toBe(true); // brief hysteresis (no chatter on a 1-frame gap)
    run(tw.world, 0.4);
    expect(ac.warnings.has('missile')).toBe(false);
    expect(cleared[0] - t0).toBeLessThanOrEqual(0.5);
  });

  it('flares/chaff low only warn if the jet carried more than the threshold', () => {
    const tw = makeWorld('pilot');
    const ac = tw.world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 6000, 0), heading: 0, speed: 230 });
    ac.flares = 0;
    ac.chaff = 0;
    run(tw.world, 2);
    expect(ac.warnings.has('flares_low')).toBe(false);
  });

  it('SPEED and STALL warnings at low speed', () => {
    const tw = makeWorld('pilot');
    const ac = tw.world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 6000, 0), heading: 0, speed: 90 });
    run(tw.world, 10, () => {
      ac.input.throttle = 0;
      ac.input.pitch = 1;
    });
    expect(ac.warnings.has('speed_low') || ac.warnings.has('stall')).toBe(true);
  });

  it('clears every warning when the player dies', () => {
    const tw = makeWorld('pilot');
    const ac = tw.world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 6000, 0), heading: 0, speed: 230, fuel: 0.1 });
    run(tw.world, 3);
    expect(ac.warnings.size).toBeGreaterThan(0);
    tw.world.applyDamage(ac, 1000, null, 'collision');
    run(tw.world, 0.1);
    expect(ac.warnings.size).toBe(0);
    const log = warningLog(tw);
    expect(log.at(-1)?.active).toBe(false);
  });
});
