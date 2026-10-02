/**
 * Design pillar 3 (docs/ARCHITECTURE.md): "pop-up SAMs, AAA and MANPADS threaten low flight".
 * Issue #68: on Veteran the SA-18 Igla hit more often at 1,500 m than low, and a low pass over a
 * ZSU-23-4 was survivable. A jet flies straight over the site on flat ground (no flares, no
 * manoeuvring), low and at 1,500 m, over several seeds.
 */
import { describe, expect, it } from 'vitest';
import { FakeWorld, v3 } from './combat-helpers';
import type { Difficulty } from '../src/core/types';
import { SAM_DATA } from '../src/sim/sam/samData';
import { heightMissFactor } from '../src/sim/sam/endgame';
import { CLOSE_AIM_ERROR, closeInAimFactor } from '../src/sim/sam/aaa';

/** Simulation-heavy tests get an explicit timeout (a loaded CI runner can take > 5 s). */
const SIM = { timeout: 60_000 };

/** First Igla round of each pass: launched at the jet, and did it fuze on it (hit or proximity)? */
function iglaPasses(diff: Difficulty, height: number, seeds: number): { launched: number; fuzed: number } {
  let launched = 0;
  let fuzed = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    for (const offset of [0, 900]) {
      const w = new FakeWorld({ difficulty: diff, seed });
      w.spawnSam({ type: 'sa18', team: 'red', position: v3(0, 0, 0) });
      const jet = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(offset, height, -9000), heading: Math.PI, speed: 240, loadout: 'strike_stealth', callsign: 'Viper 1' });
      jet.health = 1e9; // count fuzed rounds, not kills
      const launches = w.record('munition:launch');
      const ends = w.record('munition:end');
      const first = () => launches.find((l) => l.targetId === jet.id)?.missile;
      w.run(60, () => {
        const m = first();
        return !!m && ends.some((e) => e.missile === m);
      });
      const m = first();
      if (!m) continue;
      launched++;
      const end = ends.find((e) => e.missile === m);
      if (end && (end.reason === 'hit' || end.reason === 'proximity')) fuzed++;
    }
  }
  return { launched, fuzed };
}

/** Mean damage of one straight pass over a ZSU-23-4 at `height` m, `offset` m to the side. */
function zsuPass(diff: Difficulty, height: number, offset: number, seeds: number): number {
  let dmg = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const w = new FakeWorld({ difficulty: diff, seed });
    w.spawnSam({ type: 'zsu23', team: 'red', position: v3(0, 0, 0) });
    const jet = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(offset, height, -6000), heading: Math.PI, speed: 240, loadout: 'strike_stealth', callsign: 'Viper 1' });
    jet.health = 1e9;
    w.run(50, () => jet.position.z > 6000);
    for (const d of w.damageLog) if (d.targetId === jet.id) dmg += d.amount;
  }
  return dmg / seeds;
}

describe('#68: MANPADS and AAA threaten low flight (design pillar 3)', () => {
  it('the Igla end game is tighter against a low jet than one at 1,500 m; radar SAMs do not care', () => {
    const igla = SAM_DATA.sa18;
    expect(heightMissFactor(igla, 50)).toBeLessThan(1);
    expect(heightMissFactor(igla, 1_500)).toBeGreaterThan(1);
    let prev = 0;
    for (let h = -200; h <= 3_000; h += 100) {
      const f = heightMissFactor(igla, h);
      expect(f).toBeGreaterThanOrEqual(prev); // monotonic: the higher the jet, the wider the miss
      prev = f;
    }
    for (const type of ['sa6', 'sa8', 'sa10', 'sa15', 'zsu23'] as const) {
      expect(heightMissFactor(SAM_DATA[type], 50)).toBe(1);
      expect(heightMissFactor(SAM_DATA[type], 1_500)).toBe(1);
    }
  });

  it('Veteran: the Igla fuzes on a low jet more often than on one at 1,500 m', SIM, () => {
    const low = iglaPasses('veteran', 60, 10);
    const high = iglaPasses('veteran', 1_500, 10);
    expect(low.launched).toBeGreaterThanOrEqual(16);
    expect(high.launched).toBeGreaterThanOrEqual(16);
    const pkLow = low.fuzed / low.launched;
    const pkHigh = high.fuzed / high.launched;
    expect(pkLow).toBeGreaterThan(0.85);
    expect(pkLow - pkHigh).toBeGreaterThan(0.2);
  });

  it('the Shilka aims tighter at a jet inside 1.5 km and below 300 m, and only there', () => {
    expect(closeInAimFactor(600, 100)).toBeCloseTo(CLOSE_AIM_ERROR, 6);
    expect(closeInAimFactor(600, -150)).toBeCloseTo(CLOSE_AIM_ERROR, 6); // a jet below the site (over a valley or the sea)
    expect(closeInAimFactor(1_600, 100)).toBe(1);
    expect(closeInAimFactor(600, 400)).toBe(1);
    expect(closeInAimFactor(1_250, 250)).toBeGreaterThan(CLOSE_AIM_ERROR);
    expect(closeInAimFactor(1_250, 250)).toBeLessThan(1);
  });

  it('Veteran: a low pass close to a ZSU-23-4 costs far more than a pass at 1,500 m', SIM, () => {
    const low = zsuPass('veteran', 150, 600, 6);
    const high = zsuPass('veteran', 1_500, 600, 6);
    expect(low).toBeGreaterThan(30); // a third of the jet (≈ 19 hp before the close-in aim, #68)
    expect(high).toBeLessThan(10);
  });
});
