/**
 * Regression tests for missile-defeat feedback (i1):
 *  - MAWS lists only missiles that still threaten; it clears ≤ 0.5 s after a missile is defeated
 *    (decoyed, lost guidance, passed) instead of ~6 s later
 *  - defeated missiles end promptly and 'munition:end' carries the ORIGINAL target id (not the
 *    decoy's), so HUD / audio can report "MISSILE DEFEATED" for the player
 *  - semi-active missiles go ballistic at once when the illuminator dies / loses lock, and no
 *    longer proximity-fuze on the player after that
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { FakeWorld, steerToward, v3 } from './combat-helpers';
import type { CombatMissile } from '../src/sim/weapons/missile';

describe('combat: missile defeat feedback', () => {
  it('SARH R-27: shooting the launcher down makes the missile ballistic within 0.3 s; the player survives', { timeout: 60_000 }, () => {
    let survived = 0;
    const N = 8;
    for (let seed = 1; seed <= N; seed++) {
      const w = new FakeWorld({ seed, difficulty: 'veteran' });
      const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 6000, 0), heading: 0, speed: 260, loadout: 'a2a_stealth' });
      const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 6000, -7000), heading: Math.PI, speed: 260 });
      w.run(0.3);
      w.combat.designate(mig, f35.id, w);
      w.run(4);
      expect(mig.radar.lockedId).toBe(f35.id);
      const m = w.combat.fire(mig, w, 'aim120', f35.id) as CombatMissile;
      expect(m.def.id).toBe('r27');
      const ends = w.record('munition:end');
      // player keeps flying straight — the worst case for a ballistic missile
      w.run(2);
      mig.alive = false; // shot down 2 s after launch (≈ 3 s before impact)
      const killedAt = w.time;
      let brokenAt = -1;
      let mawsClearedAt = -1;
      w.run(10, () => {
        if (brokenAt < 0 && m.trackBroken) brokenAt = w.time;
        if (brokenAt > 0 && mawsClearedAt < 0 && !f35.incoming.some((i) => i.missileId === m.id)) mawsClearedAt = w.time;
        return ends.length > 0;
      });
      expect(brokenAt - killedAt).toBeLessThanOrEqual(0.3);
      expect(mawsClearedAt - brokenAt).toBeLessThanOrEqual(0.5);
      expect(ends[0].targetId).toBe(f35.id);
      expect(ends[0].reason).toBe('selfdestruct');
      if (f35.health >= 100) survived++;
    }
    expect(survived).toBeGreaterThanOrEqual(N - 1);
  });

  it('SARH R-27: illuminator turning away beyond its gimbal breaks guidance at once', () => {
    const w = new FakeWorld({ seed: 3, difficulty: 'veteran' });
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 6000, 0), heading: 0, speed: 260, loadout: 'a2a_stealth' });
    const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 6000, -7500), heading: Math.PI, speed: 200 });
    w.run(0.3);
    w.combat.designate(mig, f35.id, w);
    w.run(4);
    const m = w.combat.fire(mig, w, 'aim120', f35.id) as CombatMissile;
    expect(m?.def.id).toBe('r27');
    w.run(0.8);
    expect(m.trackBroken).toBe(false);
    // the MiG breaks hard away (the F-35 ends up far outside its ±60° radar gimbal): no illumination
    const away = new Vector3(1, 0, -0.3).normalize();
    w.controllers.set(mig.id, (ac, dt) => steerToward(ac, away, 30, dt, 260));
    const fwd = new Vector3();
    const rel = new Vector3();
    let outAt = -1;
    w.run(4, () => {
      fwd.set(0, 0, -1).applyQuaternion(mig.quaternion);
      rel.subVectors(f35.position, mig.position).normalize();
      if (outAt < 0 && fwd.dot(rel) < Math.cos(Math.PI / 3)) outAt = w.time;
      return m.trackBroken;
    });
    expect(outAt).toBeGreaterThan(0);
    expect(m.trackBroken).toBe(true);
    expect(w.time - outAt).toBeLessThanOrEqual(0.45); // sensor sweep (0.1 s) + 0.3 s memory
  });

  it('flare-decoyed R-73: MAWS drops it within 0.5 s and munition:end names the player, reason decoyed', () => {
    let checked = 0;
    for (let seed = 1; seed <= 30 && checked < 3; seed++) {
      const w = new FakeWorld({ seed, difficulty: 'recruit' });
      const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 5000, -1400), heading: 0, speed: 250, loadout: 'a2a_stealth' });
      const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 5000, 0), heading: 0, speed: 260 });
      mig.selectedWeapon = 'aim9x';
      f35.flight.afterburner = 1;
      w.run(0.5);
      w.combat.designate(mig, f35.id, w);
      w.run(0.2);
      const m = w.combat.fire(mig, w, 'aim9x', f35.id) as CombatMissile;
      expect(m?.def.id).toBe('r73');
      const ends = w.record('munition:end');
      const dir = new Vector3(1, 0, -0.2).normalize();
      w.controllers.set(f35.id, (ac, dt) => {
        ac.input.flare = true;
        steerToward(ac, dir, 7, dt, 250);
      });
      let decoyedAt = -1;
      let cleared = -1;
      w.run(20, () => {
        if (decoyedAt < 0 && m.decoyed && !m.threat) decoyedAt = w.time;
        if (decoyedAt > 0 && cleared < 0 && !f35.incoming.some((i) => i.missileId === m.id)) cleared = w.time;
        return ends.length > 0;
      });
      if (decoyedAt < 0 || ends[0].reason !== 'decoyed') continue;
      checked++;
      expect(cleared - decoyedAt).toBeLessThanOrEqual(0.5);
      expect(ends[0].targetId).toBe(f35.id); // not the flare's id
      expect(w.time - decoyedAt).toBeLessThan(2.5); // ends promptly (~1.5 s after the defeat)
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('chaff-seduced SA-6 missile: site track broken, missile ballistic, MAWS clear, reason decoyed', () => {
    let seen = 0;
    for (let seed = 1; seed <= 20 && seen < 2; seed++) {
      const w = new FakeWorld({ seed, difficulty: 'recruit' });
      const site = w.spawnSam({ type: 'sa6', team: 'red', position: v3(0, 0, 0) });
      const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 3000, -15000), heading: Math.PI, speed: 260, loadout: 'a2a_beast' });
      const ends = w.record('munition:end');
      const launches = w.record('munition:launch');
      const dir = new Vector3();
      w.controllers.set(f35.id, (ac, dt) => {
        if (!launches.length) return;
        dir.subVectors(ac.position, site.position);
        dir.y = 0;
        dir.normalize();
        dir.set(-dir.z, 0, dir.x);
        steerToward(ac, dir, 6, dt, 260);
        ac.input.chaff = ac.incoming.length > 0 && ac.incoming[0].timeToImpact < 7;
      });
      w.run(80, () => ends.some((e) => e.reason === 'decoyed'));
      const e = ends.find((x) => x.reason === 'decoyed');
      if (!e) continue;
      seen++;
      expect(e.targetId).toBe(f35.id);
      expect((e.missile as CombatMissile).trackBroken).toBe(true);
      expect(f35.incoming.some((i) => i.missileId === e.missile.id)).toBe(false);
      expect(site.alive).toBe(true);
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('a missile that overshoots its target is dropped from MAWS and self-destructs', () => {
    const w = new FakeWorld({ seed: 2, difficulty: 'veteran' });
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 6000, 0), heading: 0, speed: 250, loadout: 'a2a_stealth' });
    const su = w.spawnAircraft({ type: 'su35', team: 'red', position: v3(0, 6000, -9000), heading: Math.PI, speed: 260 });
    w.run(1);
    const m = w.combat.fire(su, w, 'aim120', f35.id) as CombatMissile;
    expect(m).not.toBeNull();
    const ends = w.record('munition:end');
    let sidestepped = false;
    let passedAt = -1;
    w.run(30, () => {
      // a sudden 400 m side-step with the missile 600 m out: it can't turn that hard and overshoots
      if (!sidestepped && m.position.distanceTo(f35.position) < 600) {
        sidestepped = true;
        f35.position.x += 400;
      }
      if (sidestepped && passedAt < 0 && !m.threat) passedAt = w.time;
      return ends.length > 0;
    });
    expect(sidestepped).toBe(true);
    expect(passedAt).toBeGreaterThan(0);
    expect(f35.incoming.some((i) => i.missileId === m.id)).toBe(false);
    expect(f35.health).toBe(100);
    expect(ends[0].reason).toBe('selfdestruct');
    expect(ends[0].targetId).toBe(f35.id);
    expect(w.time - passedAt).toBeLessThan(2.5);
  });
});
