/**
 * #282 F3: the HUD redraws the player's own missile's motor glow over the target box and LOCK cue (the
 * HUD canvas sits over the 3D view, so right after launch the box hid the AMRAAM's plume). Which
 * missiles get the marker, and when.
 */
import { describe, expect, it } from 'vitest';
import { MissileEntity } from '../src/sim/entities';
import { MUNITIONS } from '../src/sim/weapons/defs';
import { showsMotorGlow } from '../src/hud/hmd/targets';

const PLAYER = 1;

function missile(shooterId: number, burning: boolean, alive = true): MissileEntity {
  const m = new MissileEntity(500, MUNITIONS.aim120, 'blue', shooterId, 9);
  m.motorBurning = burning;
  m.alive = alive;
  return m;
}

describe('own missile motor glow on the HMD (#282 F3)', () => {
  it("marks the player's own missile while its motor burns", () => {
    expect(showsMotorGlow(missile(PLAYER, true), PLAYER, true)).toBe(true);
  });

  it('drops the marker once the motor burns out, or the missile is gone', () => {
    expect(showsMotorGlow(missile(PLAYER, false), PLAYER, true)).toBe(false);
    expect(showsMotorGlow(missile(PLAYER, true, false), PLAYER, true)).toBe(false);
  });

  it("never marks a wingman's or an enemy's missile", () => {
    expect(showsMotorGlow(missile(7, true), PLAYER, true)).toBe(false);
  });

  it('only in the pilot-eye (HMD) views, not from an outside camera', () => {
    expect(showsMotorGlow(missile(PLAYER, true), PLAYER, false)).toBe(false);
  });

  it('the AMRAAM motor still burns 1.5 s after launch, when the playtest saw the box hide it', () => {
    const d = MUNITIONS.aim120;
    expect(d.igniteDelay).toBeLessThan(1.5);
    expect(d.igniteDelay + d.boostTime + d.sustainTime).toBeGreaterThan(1.5);
  });
});
