/**
 * Iteration-2 combat regression tests (reviewer critiques in i2-combat.md).
 */
import { describe, expect, it } from 'vitest';
import { FakeWorld, v3 } from './combat-helpers';

describe('combat i2: TGT button state machine', () => {
  it('first TGT press locks the boxed (auto-designated) primary, the next press cycles', () => {
    const w = new FakeWorld();
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 6000, 0), heading: 0, speed: 250, loadout: 'a2a_stealth' });
    const a = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 6000, -15000), heading: 0, speed: 250 });
    const b = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(2000, 6000, -30000), heading: 0, speed: 250 });
    w.run(0.5);
    const boxed = f35.radar.designatedId;
    expect(boxed).not.toBeNull();
    expect(f35.radar.lockedId).toBeNull();
    w.combat.cycleTarget(f35, w); // LOCK the boxed primary — not skip to the second contact
    expect(f35.radar.designatedId).toBe(boxed);
    w.run(3);
    expect(f35.radar.lockedId).toBe(boxed);
    w.combat.cycleTarget(f35, w); // NEXT: move to the other bandit and lock it
    const other = boxed === a.id ? b.id : a.id;
    expect(f35.radar.designatedId).toBe(other);
    w.run(3);
    expect(f35.radar.lockedId).toBe(other);
  });
});
