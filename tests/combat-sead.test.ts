/**
 * Regression tests for SEAD depth (i1): AARGMs used to kill every SAM (16/16) and SAMs never
 * defended themselves. Now:
 *  - SA-15 sites shoot down anti-radiation missiles and GPS bombs aimed at them or
 *    at co-located sites (probability based, limited fire channels)
 *  - crews time their EMCON shutdown to the ARM's approach and come back on afterwards
 *  - an AARGM against an emitter that went silent flies to a degraded memory point and can miss
 */
import { describe, expect, it } from 'vitest';
import { FakeWorld, v3 } from './combat-helpers';
import type { Difficulty, SamType, WeaponId } from '../src/core/types';
import type { CombatMissile } from '../src/sim/weapons/missile';

interface SeadResult {
  siteKilled: boolean;
  intercepted: number;
  fired: number;
  radio: string[];
  shutdownTti: number;
  backOn: boolean;
}

function seadTrial(seed: number, diff: Difficulty, target: SamType, guard: boolean, weapon: Exclude<WeaponId, 'gun'>, dist: number, shots = 1): SeadResult {
  const w = new FakeWorld({ seed, difficulty: diff });
  const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 9000, 0), heading: 0, speed: 280, loadout: weapon === 'gbu31' ? 'strike_stealth' : 'sead_stealth', callsign: 'Viper 1' });
  const site = w.spawnSam({ type: target, team: 'red', position: v3(0, 0, -dist), known: true });
  if (guard) w.spawnSam({ type: 'sa15', team: 'red', position: v3(600, 0, -dist + 500), known: true });
  f35.selectedWeapon = weapon;
  f35.radar.mode = 'ground';
  w.run(1);
  if (weapon !== 'aargm') w.combat.designate(f35, site.id, w);
  const ends = w.record('munition:end');
  const radio = w.record('radio');
  const mine: CombatMissile[] = [];
  w.events.on('munition:launch', (e) => {
    if (e.shooter === f35) mine.push(e.missile as CombatMissile);
  });
  for (let i = 0; i < shots; i++) {
    w.combat.fire(f35, w, weapon, site.id);
    w.run(0.7);
  }
  let shutdownTti = -1;
  let wasOff = false;
  w.run(150, () => {
    const arm = mine.find((m) => m.alive && m.def.guidance === 'anti_radiation');
    if (shutdownTti < 0 && site.alive && !site.radarOn && arm) shutdownTti = arm.position.distanceTo(site.position) / Math.max(100, arm.speed);
    if (!site.radarOn) wasOff = true;
    return mine.length > 0 && mine.every((m) => !m.alive);
  });
  w.run(12);
  const intercepted = ends.filter((e) => mine.includes(e.missile as CombatMissile) && e.reason === 'selfdestruct').length;
  return { siteKilled: !site.alive, intercepted, fired: mine.length, radio: radio.map((r) => r.text), shutdownTti, backOn: wasOff && site.alive && site.radarOn };
}

describe('combat: SEAD depth', () => {
  it('an SA-15 guarding an SA-6 shoots down many (not all) single AARGMs; the lone SA-6 dies more often', { timeout: 60_000 }, () => {
    const N = 16;
    let guardedKills = 0;
    let loneKills = 0;
    let intercepted = 0;
    let radioSeen = false;
    for (let s = 1; s <= N; s++) {
      const g = seadTrial(s, 'veteran', 'sa6', true, 'aargm', 30_000);
      if (g.siteKilled) guardedKills++;
      intercepted += g.intercepted;
      if (g.radio.some((t) => /shot down by SA-15/.test(t))) radioSeen = true;
      if (seadTrial(s, 'veteran', 'sa6', false, 'aargm', 30_000).siteKilled) loneKills++;
    }
    expect(intercepted).toBeGreaterThan(N * 0.2);
    expect(intercepted).toBeLessThan(N * 0.9);
    expect(guardedKills).toBeGreaterThan(0);
    expect(loneKills).toBeGreaterThan(guardedKills);
    expect(radioSeen).toBe(true); // "AARGM shot down by SA-15" feedback for the player
  });

  it('the SA-15 sometimes shoots down SDBs and JDAMs aimed at it', { timeout: 60_000 }, () => {
    for (const weapon of ['gbu39', 'gbu31'] as const) {
      let fired = 0;
      let down = 0;
      let kills = 0;
      for (let s = 1; s <= 10; s++) {
        const r = seadTrial(s, 'veteran', 'sa15', false, weapon, weapon === 'gbu39' ? 12_000 : 7_000, 2);
        fired += r.fired;
        down += r.intercepted;
        if (r.siteKilled) kills++;
      }
      expect(fired, weapon).toBeGreaterThanOrEqual(15);
      expect(down / fired, weapon).toBeGreaterThan(0.1);
      expect(down / fired, weapon).toBeLessThan(0.7);
      expect(kills, weapon).toBeGreaterThan(3); // a two-bomb attack still usually gets through
    }
  });

  it('crews time the EMCON shutdown to the ARM (seconds before impact, not at launch) and come back on', { timeout: 60_000 }, () => {
    const ttis: number[] = [];
    let backOn = 0;
    for (let s = 1; s <= 16; s++) {
      const r = seadTrial(s, 'ace', 'sa6', false, 'aargm', 32_000);
      if (r.shutdownTti > 0) ttis.push(r.shutdownTti);
      if (r.backOn) backOn++;
    }
    expect(ttis.length).toBeGreaterThan(6);
    // disciplined crews go quiet ~6–16 s before impact; nobody switches off at launch (~30 s out)
    expect(Math.max(...ttis)).toBeLessThan(22);
    expect(ttis.some((t) => t > 5)).toBe(true);
    expect(backOn).toBeGreaterThan(0);
  });

  it('an AARGM against an SA-6 that goes silent can miss (degraded memory point); it does not always kill', { timeout: 60_000 }, () => {
    let kills = 0;
    const N = 20;
    for (let s = 1; s <= N; s++) if (seadTrial(s, 'veteran', 'sa6', false, 'aargm', 32_000).siteKilled) kills++;
    expect(kills).toBeGreaterThan(N * 0.15);
    expect(kills).toBeLessThan(N * 0.85);
  });
});
