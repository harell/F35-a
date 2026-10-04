/**
 * Design pillar 3 (docs/ARCHITECTURE.md): "pop-up SAMs, AAA and MANPADS threaten low flight".
 * Issue #68: on Veteran a low pass over a ZSU-23-4 was survivable. A jet flies straight over the
 * site on flat ground (no flares, no manoeuvring), low and at 1,500 m, over several seeds.
 */
import { describe, expect, it } from 'vitest';
import { FakeWorld, v3 } from './combat-helpers';
import type { Difficulty } from '../src/core/types';
import { CLOSE_AIM_ERROR, closeInAimFactor } from '../src/sim/sam/aaa';

/** Simulation-heavy tests get an explicit timeout (a loaded CI runner can take > 5 s). */
const SIM = { timeout: 60_000 };

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

describe('#68: AAA threatens low flight (design pillar 3)', () => {
  it('the Shilka aims tighter at a jet inside 1.5 km and below 300 m, and only there', () => {
    expect(closeInAimFactor(600, 100)).toBeCloseTo(CLOSE_AIM_ERROR, 6);
    expect(closeInAimFactor(600, -150)).toBeCloseTo(CLOSE_AIM_ERROR, 6); // a jet below the site (over a valley or the sea)
    expect(closeInAimFactor(1_600, 100)).toBe(1);
    expect(closeInAimFactor(600, 400)).toBe(1);
    expect(closeInAimFactor(1_250, 250)).toBeGreaterThan(CLOSE_AIM_ERROR);
    expect(closeInAimFactor(1_250, 250)).toBeLessThan(1);
  });

  it('Veteran: a low pass close to a ZSU-23-4 costs far more than a pass at 1,500 m', SIM, () => {
    // One pass is noisy (0–100 hp), so 24 seeds and relative bounds: over seeds 1–72, 24-seed means
    // run 36–50 hp low and 7–10 hp at 1,500 m; before the close-in aim (#68) 18 hp low, 8 hp high.
    const low = zsuPass('veteran', 150, 600, 24);
    const high = zsuPass('veteran', 1_500, 600, 24);
    expect(high).toBeLessThan(15);
    expect(low).toBeGreaterThan(3 * high);
    expect(low).toBeGreaterThan(27);
  });
});
