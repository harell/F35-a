/**
 * SHOOT-cue calibration regression (i1 critique: SHOOT flashed at 1.1·rMax where Pk ≈ 0 and a
 * player "firing on SHOOT" got 0 kills).
 *
 * A player jet approaches a real AI MiG-29 (real flight model + AI brain, defending with
 * notch / chaff / drag / bug-out) and fires an AIM-120 the instant `launchZone().shoot` turns
 * true. Lead's acceptance: ≥ 60 % Pk on recruit/pilot and ≥ 45 % on veteran/ace. Covers hot /
 * flanking / cold aspects, STT and TWS shots, and armed (pressing) vs unarmed (bugging-out) bandits.
 * Full-size calibration tables: see the COMBAT report (40 trials per cell, all cells ≥ 55 %).
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import type { Difficulty } from '../src/core/types';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createAiBrain } from '../src/ai';
import { flatLand } from './missions-helpers';
import type { MissileEntity } from '../src/sim/entities';

type Aspect = 'hot' | 'flank' | 'cold';

function fireOnShoot(diff: Difficulty, aspect: Aspect, seed: number, stt: boolean, armed: boolean): 'hit' | 'miss' | 'noshot' {
  const events = new EventBus();
  const d = DIFFICULTIES[diff];
  const world = createSimWorld({ terrain: flatLand(0), difficulty: d, events, combat: createCombatSystemSeeded(seed) });
  const rnd = (k: number) => (((Math.sin(seed * 9301 + k * 49297) * 233280) % 1) + 1) % 1;
  const p = world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 6000, 0), heading: 0, speed: 260, loadout: 'a2a_stealth', fuel: 0.6 });
  const dev = aspect === 'hot' ? (rnd(1) - 0.5) * 0.7 : aspect === 'flank' ? (rnd(1) < 0.5 ? -1 : 1) * (1 + rnd(2) * 0.7) : Math.PI + (rnd(1) - 0.5) * 0.8;
  const t = world.spawnAircraft({
    type: 'mig29',
    team: 'red',
    position: new Vector3((rnd(3) - 0.5) * 4000, 6000 + (rnd(4) - 0.5) * 2000, aspect === 'cold' ? -22000 : -38000),
    heading: Math.PI + dev,
    speed: 250,
    fuel: 0.6,
    ai: createAiBrain('fighter', { skill: d.aiSkill, seed }),
  });
  if (!armed) {
    t.stores.length = 0;
    t.gunAmmo = 0;
  }
  // the player is invulnerable here: we only measure the player's missile
  const apply = world.applyDamage.bind(world);
  (world as { applyDamage: typeof world.applyDamage }).applyDamage = (tg, a, at, wp, hp) => {
    if (tg !== p) apply(tg, a, at, wp, hp);
  };
  world.combat.selectWeapon(p, 'aim120', world);
  let m: MissileEntity | null = null;
  let end = '';
  events.on('munition:launch', (e) => {
    if (e.shooter === p && !m) m = e.missile;
  });
  events.on('munition:end', (e) => {
    if (e.missile === m) end = e.reason;
  });
  const inv = p.quaternion.clone();
  const loc = new Vector3();
  for (let i = 0; i < 60 * 150 && !m && t.alive; i++) {
    // pursue the bandit
    inv.copy(p.quaternion).invert();
    loc.subVectors(t.position, p.position).applyQuaternion(inv).normalize();
    p.input.roll = Math.max(-1, Math.min(1, Math.atan2(loc.x, Math.max(0.2, -loc.z)) * 1.5));
    p.input.pitch = Math.max(-0.5, Math.min(0.5, loc.y * 3 + (Math.abs(loc.x) > 0.1 ? Math.abs(loc.x) * 0.8 : 0)));
    p.input.throttle = 0.85;
    if (i % 30 === 10) {
      if (stt && p.radar.lockedId !== t.id) world.combat.designate(p, t.id, world); // tap the TD box
      if (!stt && p.radar.designatedId !== t.id) world.combat.designate(p, t.id, world);
      if (!stt && p.radar.lockedId !== null) world.combat.cycleTarget(p, world); // break lock → TWS
    }
    if (i % 6 === 0) {
      const z = world.combat.launchZone(p, world);
      if (z && z.shoot) world.combat.fire(p, world, 'aim120', t.id);
    }
    world.step(1 / 60);
  }
  if (!m) return 'noshot';
  const missile: MissileEntity = m;
  for (let i = 0; i < 60 * 80 && missile.alive; i++) world.step(1 / 60);
  return end === 'hit' || end === 'proximity' ? 'hit' : 'miss';
}

function pk(diff: Difficulty, stt: boolean, armed: boolean, perAspect: number): { pk: number; shots: number } {
  let hits = 0;
  let shots = 0;
  for (const aspect of ['hot', 'flank', 'cold'] as Aspect[]) {
    for (let k = 0; k < perAspect; k++) {
      const r = fireOnShoot(diff, aspect, 700 + k * 29, stt, armed);
      if (r === 'noshot') continue;
      shots++;
      if (r === 'hit') hits++;
    }
  }
  return { pk: shots ? hits / shots : 0, shots };
}

describe('combat: SHOOT cue means high Pk (fire exactly on SHOOT against the defending AI)', () => {
  it('recruit: ≥ 60 % (STT vs armed, TWS vs bugging-out bandits)', () => {
    const a = pk('recruit', true, true, 8);
    const b = pk('recruit', false, false, 8);
    expect(a.shots).toBeGreaterThanOrEqual(20);
    expect(b.shots).toBeGreaterThanOrEqual(20);
    expect(a.pk).toBeGreaterThanOrEqual(0.6);
    expect(b.pk).toBeGreaterThanOrEqual(0.6);
  }, 60_000);

  it('ace: ≥ 45 % (STT vs bugging-out, TWS vs armed bandits)', () => {
    const a = pk('ace', true, false, 8);
    const b = pk('ace', false, true, 8);
    expect(a.shots).toBeGreaterThanOrEqual(20);
    expect(b.shots).toBeGreaterThanOrEqual(20);
    expect(a.pk).toBeGreaterThanOrEqual(0.45);
    expect(b.pk).toBeGreaterThanOrEqual(0.45);
  }, 60_000);

  it('pilot ≥ 60 % and veteran ≥ 45 % (STT vs armed bandits)', () => {
    expect(pk('pilot', true, true, 6).pk).toBeGreaterThanOrEqual(0.6);
    expect(pk('veteran', true, true, 6).pk).toBeGreaterThanOrEqual(0.45);
  }, 60_000);
});
