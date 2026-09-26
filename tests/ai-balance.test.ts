/**
 * Regression tests for the iteration-1 lethality / stealth balance (SIM-AI):
 *  - reviewers: "enemies are unfairly lethal on the default 'pilot' difficulty, stealth buys almost
 *    nothing, enemy counts outgrow the player's weapons, recruit/pilot/veteran all play the same"
 *  - lead: a player who defends reasonably survives c01 on recruit almost always, on pilot most of
 *    the time, on veteran sometimes, on ace rarely; enemies never shoot beyond their own sensor
 *    track, prefer shots inside a sensible fraction of rMax on lower difficulties and react slower
 *    there; a clean F-35 typically gets the first shot, beast mode is seen much earlier; wingmen
 *    contribute.
 * Everything runs the REAL World / Combat / AI / MissionRunner with the scripted competent player of
 * tests/ai-playerbot.ts (the same code as e2e/review/dev-simai-balance.ts / dev-simai-duel.ts).
 */
import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../src/core/data';
import type { Difficulty } from '../src/core/types';
import type { LaunchZone } from '../src/sim/api';
import { createAiBrain } from '../src/ai';
import { deriveSkill } from '../src/ai/skill';
import { WeaponsOfficer } from '../src/ai/brain/weapons';
import { fcrStealthFactor } from '../src/sim/sensors/signatures';
import { flat, makeAiWorld, runFor, v3 } from './ai-helpers';
import { runBalanceMission, runDuel, type BalanceResult } from './ai-playerbot';

const DIFFS: Difficulty[] = ['recruit', 'pilot', 'veteran', 'ace'];
const SEEDS = [11, 18, 25, 32, 39, 46, 53, 60];

describe('AI shot doctrine & reactions per difficulty', () => {
  const zone = (rMax: number, rNe: number): LaunchZone => ({ weapon: 'aim120', targetId: 1, range: 0, rMin: 1_000, rNe, rMax, shoot: true, closure: 500, timeOfFlight: 20 });

  it('radar-missile launch range ceiling grows with skill (rookies ≤ 45 % rMax, pilot-level ≤ 55 %)', () => {
    const z = zone(24_000, 9_000);
    const ceiling = (level: number) => {
      let worst = 0;
      for (let k = 0; k < 40; k++) {
        const w = new WeaponsOfficer();
        let s = k * 7919 + 1;
        w.newEngagement(level, () => ((s = (s * 16807) % 2147483647) / 2147483647));
        worst = Math.max(worst, w.shotRange(z));
      }
      return worst / z.rMax;
    };
    expect(ceiling(0.15)).toBeLessThanOrEqual(0.451);
    expect(ceiling(0.4)).toBeLessThanOrEqual(0.551);
    expect(ceiling(0.65)).toBeLessThanOrEqual(0.701);
    expect(ceiling(0.9)).toBeGreaterThan(ceiling(0.4));
  });

  it('enemy pilots react slower on recruit / pilot than on veteran / ace', () => {
    // c01's MiG groups fly at difficulty.aiSkill − 0.2
    const r = DIFFS.map((d) => deriveSkill(DIFFICULTIES[d], DIFFICULTIES[d].aiSkill - 0.2, 'red', 'mig29').reaction);
    expect(r[0]).toBeGreaterThan(r[1]);
    expect(r[1]).toBeGreaterThan(r[2]);
    expect(r[2]).toBeGreaterThan(r[3]);
    expect(r[0]).toBeGreaterThan(3);
    expect(r[1]).toBeGreaterThan(1.9);
  });

  it('veteran no longer multiplies the enemy count (c01 = 4 MiGs), ace = 6', () => {
    expect(Math.round(2 * DIFFICULTIES.veteran.enemyCountScale)).toBe(2);
    expect(Math.round(2 * DIFFICULTIES.ace.enemyCountScale)).toBe(3);
    expect(DIFFICULTIES.pilot.enemyCountScale).toBe(1);
  });
});

describe('stealth matters (1v1 head-on vs a MiG-29, competent player)', () => {
  it('a clean F-35 gets the first shot on every difficulty (reviewer: MiG saw it at 9.1 km and shot at 7.5 km)', () => {
    for (const d of DIFFS) {
      let first = 0;
      let survived = 0;
      for (let k = 0; k < 3; k++) {
        // STT shots, and one silent TWS shot (no lock → no RWR spike)
        const r = runDuel(d, 100 + k * 13, flat(0), { redType: 'mig29', tws: k === 2 });
        if (r.firstShot === 'player') first++;
        if (r.survived) survived++;
      }
      expect(first, d).toBe(3);
      expect(survived, d).toBe(3);
    }
  });

  it('the MiG-29 radar finds a clean F-35 inside ~8 km, beast mode about twice as far', () => {
    const detectRange = (loadout: 'a2a_stealth' | 'a2a_beast', diff: Difficulty) => {
      const { world } = makeAiWorld(diff, undefined, 3);
      const mig = world.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 5_000, 0), heading: Math.PI, speed: 240 });
      const f = world.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 5_000, 40_000), heading: 0, speed: 240, loadout });
      let found = -1;
      runFor(world, 90, () => {
        const c = mig.radar.contacts.find((k) => k.id === f.id);
        if (c && c.source === 'radar') found = mig.position.distanceTo(f.position);
        return found > 0;
      });
      return found;
    };
    for (const d of ['pilot', 'ace'] as Difficulty[]) {
      const clean = detectRange('a2a_stealth', d);
      const beast = detectRange('a2a_beast', d);
      expect(clean, d).toBeGreaterThan(5_000);
      expect(clean, d).toBeLessThan(8_500);
      expect(beast, d).toBeGreaterThan(1.8 * clean);
    }
    // the LO bonus is lost with external stores or open bays
    const { world } = makeAiWorld('pilot');
    const f = world.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 5_000, 0), heading: 0, speed: 240, loadout: 'a2a_stealth' });
    expect(fcrStealthFactor(f, 0.5)).toBeLessThan(0.85);
    f.bayDoors = 1;
    expect(fcrStealthFactor(f, 0.5)).toBe(1);
  });

  it('hostile jets never launch a radar missile at the player without their own sensor track on it', () => {
    let checked = 0;
    // every red radar-missile launch is checked at the moment it happens (an EWR feeds red a
    // datalink picture of the F-35 from far out — they still have to find it themselves)
    const tw = makeAiWorld('ace', undefined, 7);
    const w = tw.world;
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 5_000, 0), heading: 0, speed: 250, loadout: 'a2a_beast' });
    for (let i = 0; i < 2; i++) w.spawnAircraft({ type: i ? 'su35' : 'mig29', team: 'red', position: v3(i * 3_000, 5_500, -30_000), heading: Math.PI, speed: 250, ai: createAiBrain('fighter', { skill: 0.9, seed: 4 + i }) });
    w.spawnGround({ type: 'ewr', team: 'red', position: v3(0, 0, -45_000) }); // datalink picture for red
    tw.events.on('munition:launch', (e) => {
      if (e.shooter.kind !== 'aircraft' || e.shooter.team !== 'red' || e.missile.def.guidance === 'ir') return;
      const c = e.shooter.radar.contacts.find((k) => k.id === e.targetId);
      expect(c, 'red shot without a contact').toBeTruthy();
      expect(c!.source, 'red shot from a datalink-only track').not.toBe('datalink');
      checked++;
    });
    runFor(w, 90, () => {
      f35.input.pitch = 0;
      f35.input.roll = 0;
      return !f35.alive;
    });
    expect(checked).toBeGreaterThan(0);
  });
});

describe('c01 lethality ladder (competent scripted player, 8 jittered runs per difficulty)', () => {
  const runs = (d: Difficulty, strategy: 'bot' | 'committed'): BalanceResult[] => SEEDS.map((s) => runBalanceMission('c01', d, s, flat(0), { strategy }));
  const surv = (rs: BalanceResult[]) => rs.filter((r) => r.survived).length;

  it('recruit almost always, pilot most of the time, ace rarely — a clean F-35 shoots first', { timeout: 180_000 }, () => {
    const rec = runs('recruit', 'bot');
    const pil = runs('pilot', 'bot');
    const vet = runs('veteran', 'committed');
    const aceRtb = runs('ace', 'bot');
    const aceCommitted = runs('ace', 'committed');
    expect(surv(rec)).toBeGreaterThanOrEqual(7);
    expect(surv(pil)).toBeGreaterThanOrEqual(6);
    // veteran: sometimes (the committed pilot fights the whole mission)
    expect(surv(vet)).toBeGreaterThanOrEqual(2);
    // ace: rarely for a pilot who stays to finish the job, and clearly harder than pilot even for
    // one who goes home when Winchester
    expect(surv(aceCommitted)).toBeLessThanOrEqual(3);
    expect(surv(aceRtb)).toBeLessThan(surv(pil));
    // stealth: the player's first AMRAAM leaves before any enemy missile in (nearly) every run
    for (const rs of [rec, pil, vet, aceRtb]) {
      const first = rs.filter((r) => r.playerFirstShot >= 0 && (r.redFirstShotAtPlayer < 0 || r.playerFirstShot < r.redFirstShotAtPlayer)).length;
      expect(first).toBeGreaterThanOrEqual(7);
    }
    // wingmen contribute (Viper 2 scores kills of its own)
    const wing = [...rec, ...pil].reduce((s, r) => s + r.wingKills, 0) / 16;
    expect(wing).toBeGreaterThanOrEqual(1);
    // no more than 4 MiGs on pilot / veteran (reviewer: veteran/ace turned c01 into 6)
    expect(Math.max(...vet.map((r) => r.redTotal))).toBeLessThanOrEqual(4);
  });
});

describe('AI behaviour fixes', () => {
  it('unarmed training drones keep flying their task instead of bugging out supersonic (t02)', () => {
    const { world } = makeAiWorld('pilot', undefined, 2);
    const drone = world.spawnAircraft({
      type: 'mig29',
      team: 'red',
      position: v3(0, 4_000, -20_000),
      heading: Math.PI / 2,
      speed: 220,
      ai: createAiBrain('fighter', { skill: 0, seed: 3, task: { kind: 'patrol', center: v3(0, 4_000, -20_000), radius: 4_000, altitude: 4_000 } }),
    });
    drone.stores.length = 0;
    drone.gunAmmo = 0;
    world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 4_000, 0), heading: 0, speed: 240, loadout: 'a2a_stealth' });
    const states = new Set<string>();
    let maxMach = 0;
    runFor(world, 60, () => {
      states.add(drone.aiState);
      maxMach = Math.max(maxMach, drone.flight.mach);
    });
    expect(states.has('BUGOUT')).toBe(false);
    expect(states.has('PATROL')).toBe(true);
    expect(maxMach).toBeLessThan(0.95);
  });

  it('a friendly gun-only F-35 disengages from a fighter at BVR range; a red gun-only MiG keeps fighting', () => {
    const { world } = makeAiWorld('veteran', undefined, 4);
    const blue = world.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 5_000, 0), heading: 0, speed: 250, loadout: 'a2a_beast', ai: createAiBrain('fighter', { skill: 0.8, seed: 1 }) });
    const red = world.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 5_000, -9_000), heading: Math.PI, speed: 250, ai: createAiBrain('fighter', { skill: 0.8, seed: 2 }) });
    for (const s of blue.stores) s.count = 0;
    for (const s of red.stores) s.count = 0;
    const blueStates = new Set<string>();
    const redStates = new Set<string>();
    runFor(world, 6, () => {
      blueStates.add(blue.aiState);
      redStates.add(red.aiState);
    });
    expect(blueStates.has('BUGOUT')).toBe(true);
    expect(redStates.has('BUGOUT')).toBe(false);
  });

  it('a red fighter gives up a long tail chase of a cold, non-threatening F-35 (no endless hunts)', () => {
    const { world } = makeAiWorld('pilot', undefined, 6);
    const f35 = world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 5_000, 0), heading: 0, speed: 290, loadout: 'a2a_beast' });
    for (const s of f35.stores) s.count = 0;
    const mig = world.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 5_000, 6_000), heading: 0, speed: 260, ai: createAiBrain('fighter', { skill: 0.3, seed: 8 }) });
    for (const s of mig.stores) s.count = 0; // no missiles: the chase can only end in a gun kill
    let gaveUp = false;
    let chasing = 0;
    runFor(world, 120, (t) => {
      f35.input.pitch = 0;
      f35.input.roll = 0;
      f35.input.throttle = 1;
      if (mig.aiState === 'INTERCEPT' || mig.aiState === 'BFM' || mig.aiState === 'MERGE') chasing = t;
      if (chasing > 0 && (mig.aiState === 'PATROL' || mig.aiState === 'RTB')) gaveUp = true;
      return gaveUp || !f35.alive;
    });
    expect(f35.alive).toBe(true);
    expect(gaveUp).toBe(true);
  });

  it('Ace-level enemies get GCI vectors onto an unseen stealth jet; pilot-level ones do not', () => {
    const commits = (d: Difficulty) => {
      const { world } = makeAiWorld(d, undefined, 9);
      const mig = world.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 5_000, -30_000), heading: Math.PI / 2, speed: 230, ai: createAiBrain('fighter', { skill: DIFFICULTIES[d].aiSkill, seed: 2 }) });
      world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(-12_000, 6_000, -2_000), heading: Math.PI / 2, speed: 240, loadout: 'a2a_stealth' });
      let intercept = false;
      runFor(world, 20, () => {
        intercept ||= mig.aiState === 'INTERCEPT';
        return intercept;
      });
      return intercept;
    };
    expect(commits('pilot')).toBe(false);
    expect(commits('ace')).toBe(true);
  });

  it("exposes the pilot's derived skill publicly (combat reads skill.defense for countermeasures)", () => {
    const { world } = makeAiWorld('veteran');
    const brain = createAiBrain('fighter', { skill: 0.7, seed: 1 }) as unknown as { skill?: { defense: number }; spawnSkill: number };
    world.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 5_000, 0), heading: 0, speed: 230, ai: brain as never });
    runFor(world, 0.2);
    expect(typeof brain.skill?.defense).toBe('number');
    expect(brain.spawnSkill).toBe(0.7);
  });
});
