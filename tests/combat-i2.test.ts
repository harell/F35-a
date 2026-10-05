/**
 * Iteration-2 combat regression tests (reviewer critiques in i2-combat.md).
 */
import { describe, expect, it } from 'vitest';
import { FakeWorld, v3 } from './combat-helpers';
import { Quaternion, Vector3 } from 'three';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createAiBrain } from '../src/ai';
import { flatLand } from './missions-helpers';
import { presentedScale, roundEnergyFactor } from '../src/sim/weapons/gun';
import type { Projectile } from '../src/sim/entities';
import type { Difficulty } from '../src/core/types';

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


/**
 * Reviewer's i2-gunmerge harness, first pass only: guns-only, 3 km head-on, a perfect LCOS
 * aimbot fires whenever the pipper is on the bandit inside 1,200 m. Returns true when the
 * bandit dies before the jets have passed each other (range opening again).
 */
function headOnPass(diff: Difficulty, seed: number): { killed: boolean; hits: number; time: number; minR: number } {
  const events = new EventBus();
  const world = createSimWorld({ terrain: flatLand(0), difficulty: DIFFICULTIES[diff], events, combat: createCombatSystemSeeded(seed) });
  const p = world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 4000, 0), heading: 0, speed: 230, loadout: 'a2a_stealth', fuel: 0.6 });
  const t = world.spawnAircraft({
    type: 'mig29', team: 'red', position: new Vector3(300, 4000, -3000), heading: Math.PI, speed: 220, fuel: 0.6,
    ai: createAiBrain('fighter', { skill: DIFFICULTIES[diff].aiSkill, seed }),
  });
  t.stores.length = 0;
  p.stores.length = 0;
  world.combat.selectWeapon(p, 'gun', world);
  for (let i = 0; i < 30; i++) world.step(1 / 60);
  world.combat.designate(p, t.id, world);
  let hits = 0;
  events.on('damage', (e) => {
    if (e.target === t && e.weapon === 'gun') hits++;
  });
  const inv = new Quaternion();
  const toT = new Vector3();
  const toP = new Vector3();
  let minR = Infinity;
  for (let i = 0; i < 60 * 20 && t.alive; i++) {
    const R = p.position.distanceTo(t.position);
    minR = Math.min(minR, R);
    if (minR < 800 && R > minR + 60) break; // passed each other, range opening: end of the pass
    const lp = world.combat.gunLeadPoint(p, world);
    p.input.throttle = 0.95;
    p.input.fireGun = false;
    if (lp) {
      inv.copy(p.quaternion).invert();
      toT.copy(t.position).sub(p.position).applyQuaternion(inv).normalize();
      toP.copy(lp).sub(p.position).applyQuaternion(inv).normalize();
      const ex = toT.x - toP.x;
      const ey = toT.y - toP.y;
      const err = Math.hypot(ex, ey);
      const bank = Math.atan2(ex, Math.max(ey, -0.2));
      p.input.roll = Math.max(-1, Math.min(1, bank * (err > 0.02 ? 2 : 0.5)));
      p.input.pitch = Math.max(-1, Math.min(1, ey * 12 + (Math.abs(bank) < 0.8 ? err * 6 : 0)));
      if (err < 0.015 && R < 1_200 && p.gunAmmo > 0) p.input.fireGun = true;
    }
    world.step(1 / 60);
  }
  return { killed: !t.alive, hits, time: +world.time.toFixed(1), minR: Math.round(minR) };
}

describe('combat i2: head-on gun snapshot is not a free kill', () => {
  it('perfect-aim head-on pass vs Veteran / Pilot MiG-29: first-pass Pk well below 30%', () => {
    for (const diff of ['veteran', 'pilot'] as const) {
      let kills = 0;
      for (let k = 0; k < 6; k++) {
        if (headOnPass(diff, 300 + k).killed) kills++;
      }
      expect(kills / 6).toBeLessThan(0.3);
    }
  }, 60_000);

  it('rounds from ahead present a smaller target; damage does not grow with closure', () => {
    const tgt = { velocity: new Vector3(0, 0, -250), quaternion: new Quaternion() } as never; // flying north (−Z)
    const round = (vx: number, vz: number) => ({ calibre: 0.025, velocity: new Vector3(vx, 0, vz) }) as unknown as Projectile;
    const head = round(0, 1_200); // coming straight at its nose
    const tail = round(0, -1_200); // overtaking from behind
    const beam = round(1_200, 0);
    expect(presentedScale(head, tgt)).toBeCloseTo(0.5, 2);
    expect(presentedScale(tail, tgt)).toBe(1);
    expect(presentedScale(beam, tgt)).toBe(1);
    // energy factor depends only on the round's own speed, never on the target's closure
    expect(roundEnergyFactor(head)).toBe(roundEnergyFactor(tail));
  });
});

import { createCombatSystem, aiSaltFor } from '../src/sim/weapons/CombatSystem';
import { CombatMissile } from '../src/sim/weapons/missile';
import { midcourseError } from '../src/sim/weapons/guidance';
import { rollNotchNeed, AAM_IMMUNE_CAP } from '../src/sim/weapons/ew';
import { buildInstantMission } from '../src/missions/content/instant';
import { MUNITIONS } from '../src/sim/weapons/defs';
import { makeAiWorld } from './ai-helpers';

describe('combat i2: per-sortie variation', () => {
  it('in-game combat systems get a fresh seed (AI salt) per sortie; seeded ones are reproducible', () => {
    const a = createCombatSystem() as unknown as { aiSalt: number };
    const b = createCombatSystem() as unknown as { aiSalt: number };
    expect(a.aiSalt).not.toBe(b.aiSalt);
    expect((createCombatSystemSeeded(7) as unknown as { aiSalt: number }).aiSalt).toBe(aiSaltFor(7));
    expect(aiSaltFor(7)).not.toBe(aiSaltFor(8));
  });

  it('the same mission AI seed flies differently under a different sortie salt', () => {
    const fly = (combatSeed: number) => {
      const events = new EventBus();
      const world = createSimWorld({ terrain: flatLand(0), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(combatSeed) });
      const p = world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 5000, 0), heading: 0, speed: 250, loadout: 'a2a_beast' });
      world.spawnAircraft({ type: 'mig29', team: 'red', position: new Vector3(2000, 5000, -30000), heading: Math.PI, speed: 250, ai: createAiBrain('fighter', { skill: 0.5, seed: 42 }) });
      p.stores.length = 0;
      let first = -1;
      events.on('munition:launch', () => {
        if (first < 0) first = world.time;
      });
      for (let i = 0; i < 60 * 90 && first < 0 && p.alive; i++) world.step(1 / 60);
      return first;
    };
    const tA = fly(1);
    const tB = fly(1);
    const others = [fly(2), fly(3), fly(4)];
    expect(tA).toBeGreaterThan(0);
    expect(tA).toBe(tB); // deterministic for a given sortie seed
    expect(others.some((t) => Math.abs(t - tA) > 0.01)).toBe(true); // but not across sorties
  }, 60_000);
});

describe('combat i2: radar missile defence before the active seeker locks', () => {
  it('beaming the launcher (notch) drags the datalinked midcourse track off; a clean track stays clean', () => {
    const w = new FakeWorld({ difficulty: 'veteran' });
    const su = w.spawnAircraft({ type: 'su35', team: 'red', position: v3(0, 1500, -6000), heading: Math.PI, speed: 260 });
    const beamer = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 1500, 0), heading: Math.PI / 2, speed: 260, loadout: 'a2a_stealth' });
    let seed = 1;
    const ctx = { world: w, time: 0, rng: () => ((seed = (seed * 16807) % 2147483647) / 2147483647) } as never;
    const m = new CombatMissile(9999, MUNITIONS.r77 as never, 'red', su.id, beamer.id);
    m.notchNeed = 3;
    let err = 0;
    for (let i = 0; i < 120; i++) err = midcourseError(ctx, m, su, beamer, 1 / 30);
    expect(err).toBeGreaterThan(800); // 4 s in the launcher's notch at low level: a km-class error
    // hot target (closing on the launcher): no notch, no error
    const hot = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 1500, 0), heading: Math.PI, speed: 260, loadout: 'a2a_stealth' });
    const m2 = new CombatMissile(9998, MUNITIONS.r77 as never, 'red', su.id, hot.id);
    m2.notchNeed = 3;
    let err2 = 0;
    for (let i = 0; i < 120; i++) err2 = midcourseError(ctx, m2, su, hot, 1 / 30);
    expect(err2).toBe(0);
  });

  it('the "seeker not fooled" roll of an air-to-air seeker is capped at ~15% even on Veteran', () => {
    const w = new FakeWorld({ difficulty: 'veteran' });
    let rng = 0;
    const ctx = { rng: () => ((rng = (rng * 9301 + 49297) % 233280) / 233280), world: w } as never;
    let immune = 0;
    for (let i = 0; i < 2000; i++) if (rollNotchNeed(ctx, 0.45, 0.76, AAM_IMMUNE_CAP) === Infinity) immune++;
    expect(immune / 2000).toBeLessThan(0.18);
  });
});

describe('combat i2: AIM-9X rear-aspect kinematics', () => {
  it('5 km altitude, 250 m/s shooter and receding target: tail rMax ≥ 4.8 km (was 2.6 km)', () => {
    const w = new FakeWorld({ difficulty: 'pilot' });
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 5000, 0), heading: 0, speed: 250, loadout: 'a2a_beast' });
    const t = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 5000, -3000), heading: 0, speed: 250 });
    w.run(0.2);
    const z = w.combat.launchZoneFor(p, 'aim9x', t, w);
    expect(z.rMax).toBeGreaterThan(4_800);
    expect(z.rNe).toBeGreaterThan(2_000);
  });
});

describe('combat i2: instant action & recruit forgiveness', () => {
  it('Instant Action dogfight recommends the stealth loadout', () => {
    const def = buildInstantMission({ mode: 'dogfight', enemyCount: 4, enemyType: 'mixed', theater: 'auckland', timeOfDay: 'day' } as never);
    expect(def.recommendedLoadout).toBe('a2a_stealth');
  });

  const rearShot = (diff: Difficulty, seed: number) => {
    const tw = makeAiWorld(diff, undefined, seed);
    const w = tw.world;
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 4_000, 0), heading: 0, speed: 210, loadout: 'a2a_stealth' });
    const ang = 0.9;
    const sh = w.spawnAircraft({ type: 'mig29', team: 'red', position: new Vector3(Math.sin(ang) * 2_200, 4_000, Math.cos(ang) * 2_200), heading: -0.3, speed: 280 });
    for (let i = 0; i < 30; i++) w.step(1 / 60);
    const m = w.combat.fire(sh, w, 'aim9x', p.id) as CombatMissile | null;
    return { w, p, m };
  };

  it('Recruit: an undefended player still gets automatic flares vs an R-73; Pilot does not', () => {
    for (const diff of ['recruit', 'pilot'] as const) {
      const { w, p, m } = rearShot(diff, 3);
      expect(m).not.toBeNull();
      const f0 = p.flares;
      for (let i = 0; i < 60 * 4; i++) w.step(1 / 60);
      if (diff === 'recruit') expect(p.flares).toBeLessThan(f0);
      else expect(p.flares).toBe(f0);
    }
  });

  it('Recruit: enemy missiles at the player sometimes go stupid (per-missile Pk well below 100%)', () => {
    let duds = 0;
    let n = 0;
    for (let k = 0; k < 80; k++) {
      const { m } = rearShot('recruit', 100 + k * 17);
      if (!m) continue;
      n++;
      if (m.dudAt >= 0) duds++;
    }
    expect(n).toBeGreaterThan(60);
    expect(duds / n).toBeGreaterThan(0.3);
    expect(duds / n).toBeLessThan(0.6);
    // never on Pilot / Veteran
    for (let k = 0; k < 10; k++) expect(rearShot('veteran', 200 + k).m?.dudAt ?? -1).toBe(-1);
    for (let k = 0; k < 10; k++) expect(rearShot('pilot', 300 + k).m?.dudAt ?? -1).toBe(-1);
  });
});

describe('combat i2: high-AoA regime of the flight model without flight assist (Pilot holds 28°, carefree FBW opens up)', () => {
  // the engine knobs survive the removal of the Ace preset: Veteran with flight assist off and G effects on
  const NO_ASSIST = { ...DIFFICULTIES.veteran, id: 'veteran' as const, flightAssist: false, gEffects: true };
  const pull = (diff: Difficulty | 'noAssist', speed: number, seconds = 6) => {
    const events = new EventBus();
    const world = createSimWorld({ terrain: flatLand(0), difficulty: diff === 'noAssist' ? NO_ASSIST : DIFFICULTIES[diff], events, combat: createCombatSystemSeeded(1) });
    const p = world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 4000, 0), heading: 0, speed, loadout: 'a2a_stealth', fuel: 0.5 });
    let maxA = 0;
    let stalled = 0;
    for (let i = 0; i < 60 * seconds; i++) {
      p.input.pitch = 1;
      p.input.roll = 0;
      p.input.throttle = 1;
      world.step(1 / 60);
      maxA = Math.max(maxA, p.flight.alpha);
      if (p.flight.stalled) stalled++;
    }
    return { maxA: maxA / DEG_, stalled, alive: p.alive };
  };
  const DEG_ = Math.PI / 180;
  it('full aft stick at low speed: Pilot holds 28°, no-assist opens to ~33° without departing', () => {
    const pilot = pull('pilot', 140);
    const ace = pull('noAssist', 140);
    expect(pilot.maxA).toBeLessThan(28.8);
    expect(ace.maxA).toBeGreaterThan(30.5);
    expect(ace.maxA).toBeLessThan(35);
    expect(ace.stalled).toBeLessThan(30); // at most a brief stall-warning flicker, no departure
    expect(ace.alive).toBe(true);
    // fast (above ~250 KIAS, first second of the pull) the no-assist limiter is the normal one
    expect(pull('noAssist', 280, 1).maxA).toBeLessThan(29);
  });
});
