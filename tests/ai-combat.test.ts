/**
 * AI air combat with the REAL SimWorld + CombatSystem: intercept and BVR launch, missile
 * defence (IR flares/break, radar notch/chaff), gun tracking, a full 1v1 dogfight.
 */
import { describe, expect, it } from 'vitest';
import { createAiBrain } from '../src/ai';
import { makeAiWorld, runFor, v3 } from './ai-helpers';

describe('AI intercept & BVR', () => {
  it('fighter on an attack task intercepts a straight-flying target and launches at it', () => {
    const tw = makeAiWorld('veteran', undefined, 7);
    const w = tw.world;
    // beast-mode F-35 (external stores wreck its stealth) flying straight and level, no AI
    const tgt = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 5_000, 0), heading: Math.PI / 2, speed: 240, loadout: 'a2a_beast' });
    const ftr = w.spawnAircraft({
      type: 'su27',
      team: 'red',
      position: v3(-12_000, 6_000, -36_000),
      heading: Math.PI,
      speed: 250,
      ai: createAiBrain('fighter', { skill: 0.8, seed: 3, task: { kind: 'attack', targetId: tgt.id } }),
    });
    const states = new Set<string>();
    runFor(w, 200, () => {
      states.add(ftr.aiState);
      return tw.launches.some((l) => l.shooter === ftr);
    });
    const shot = tw.launches.find((l) => l.shooter === ftr);
    expect(shot, 'fighter launched').toBeTruthy();
    expect(shot!.targetId).toBe(tgt.id);
    expect(shot!.missile.def.category).toBe('aam');
    expect(states.has('INTERCEPT')).toBe(true);
    expect(states.has('BVR')).toBe(true);
    // launched inside the missile's zone, not blindly
    const range = shot!.missile.position.distanceTo(tgt.position);
    expect(range).toBeLessThan(35_000);
  });

  it('interceptor scrambles on GCI vectors, finds the bandit with its own sensors and shoots', () => {
    const tw = makeAiWorld('ace', undefined, 11);
    const w = tw.world;
    const tgt = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(10_000, 4_000, 10_000), heading: 0, speed: 240, loadout: 'a2a_beast' });
    const ftr = w.spawnAircraft({ type: 'su35', team: 'red', position: v3(-20_000, 3_000, -35_000), heading: 2, speed: 240, ai: createAiBrain('interceptor', { skill: 0.9, seed: 5 }) });
    let sawIntercept = false;
    runFor(w, 180, () => {
      if (ftr.aiState === 'INTERCEPT') sawIntercept = true;
      return tw.launches.some((l) => l.shooter === ftr);
    });
    expect(sawIntercept).toBe(true);
    expect(tw.launches.some((l) => l.shooter === ftr && l.targetId === tgt.id)).toBe(true);
  });

  it('cranks after a radar-missile shot to keep supporting it', () => {
    const tw = makeAiWorld('veteran', undefined, 2);
    const w = tw.world;
    const tgt = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 5_000, 0), heading: 0, speed: 230, loadout: 'a2a_beast' });
    const ftr = w.spawnAircraft({ type: 'su35', team: 'red', position: v3(0, 5_500, -24_000), heading: Math.PI, speed: 260, ai: createAiBrain('fighter', { skill: 0.9, seed: 1, task: { kind: 'attack', targetId: tgt.id } }) });
    let launchT = -1;
    let cranked = false;
    runFor(w, 60, (t) => {
      if (launchT < 0 && tw.launches.some((l) => l.shooter === ftr)) launchT = t;
      if (launchT > 0 && ftr.aiState === 'CRANK') cranked = true;
      return cranked;
    });
    expect(launchT).toBeGreaterThan(0);
    expect(cranked).toBe(true);
  });
});

describe('AI missile defence', () => {
  it('a defending AI survives an R-73 shot at least sometimes (flares, throttle chop, break)', () => {
    const run = (withAi: boolean) => {
      let survivors = 0;
      let fired = 0;
      let flaresUsed = 0;
      for (let seed = 1; seed <= 8; seed++) {
        const tw = makeAiWorld('veteran', undefined, seed * 13);
        const w = tw.world;
        const def = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 4_000, 0), heading: 0, speed: 210, ai: withAi ? createAiBrain('fighter', { skill: 0.7, seed }) : null });
        const ang = 0.5 + (seed / 8) * 0.8; // shooter in the right rear quarter
        const sh = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(Math.sin(ang) * 2_200, 4_000, Math.cos(ang) * 2_200), heading: -0.3, speed: 280 });
        let done = false;
        runFor(w, 25, (t) => {
          if (!done && t > 0.5) {
            done = true;
            if (w.combat.fire(sh, w, 'aim9x', def.id)) fired++;
          }
          return !def.alive;
        });
        if (def.alive) survivors++;
        flaresUsed += 24 - def.flares;
      }
      return { survivors, fired, flaresUsed };
    };
    const ai = run(true);
    const passive = run(false);
    expect(ai.fired).toBeGreaterThanOrEqual(6);
    expect(ai.flaresUsed).toBeGreaterThan(0);
    expect(ai.survivors).toBeGreaterThanOrEqual(1);
    expect(ai.survivors).toBeGreaterThan(passive.survivors);
  });

  it('reacts to an AIM-9X: flares + defensive manoeuvre (non-DAS jet sees it visually)', () => {
    const tw = makeAiWorld('ace', undefined, 3);
    const w = tw.world;
    const def = w.spawnAircraft({ type: 'su27', team: 'red', position: v3(0, 4_000, 0), heading: 0, speed: 220, ai: createAiBrain('fighter', { skill: 0.9, seed: 2 }) });
    const sh = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(1_300, 4_000, 1_500), heading: -0.5, speed: 270, loadout: 'a2a_beast' });
    let fired = false;
    const states = new Set<string>();
    const flares0 = def.flares;
    runFor(w, 12, (t) => {
      if (!fired && t > 0.3) fired = !!w.combat.fire(sh, w, 'aim9x', def.id);
      states.add(def.aiState);
      return !def.alive;
    });
    expect(fired).toBe(true);
    expect(states.has('DEFENSIVE')).toBe(true);
    expect(def.flares).toBeLessThan(flares0);
  });

  it('notches and dispenses chaff against a radar missile', () => {
    const tw = makeAiWorld('veteran', undefined, 21);
    const w = tw.world;
    const def = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 2_500, 0), heading: 0, speed: 250, ai: createAiBrain('fighter', { skill: 0.8, seed: 2 }) });
    const sh = w.spawnAircraft({ type: 'su35', team: 'red', position: v3(0, 3_500, -15_000), heading: Math.PI, speed: 260, loadout: undefined });
    // the shooter needs a track: a beast-mode target is easier; force a designation + lock chance
    def.rcsMultiplier = 40;
    let fired = false;
    const states = new Set<string>();
    const chaff0 = def.chaff;
    runFor(w, 40, (t) => {
      if (!fired && t > 1) {
        w.combat.designate(sh, def.id, w);
        fired = !!w.combat.fire(sh, w, 'aim120', def.id);
      }
      states.add(def.aiState);
      return fired && t > 30;
    });
    expect(fired).toBe(true);
    expect(states.has('NOTCH') || states.has('DEFENSIVE')).toBe(true);
    expect(def.chaff).toBeLessThan(chaff0);
  });
});

describe('AI guns & dogfight', () => {
  it('tracks a turning target with the gun and scores hits', () => {
    const tw = makeAiWorld('veteran', undefined, 5);
    const w = tw.world;
    const a = w.spawnAircraft({ type: 'su27', team: 'red', position: v3(0, 3_000, 0), heading: 0, speed: 230, ai: createAiBrain('fighter', { skill: 0.9, seed: 9 }) });
    const b = w.spawnAircraft({ type: 'mig29', team: 'blue', position: v3(0, 3_000, -1_500), heading: 0, speed: 200 });
    a.stores.forEach((s) => (s.count = 0));
    let gunHits = 0;
    let sawGuns = false;
    tw.events.on('damage', (p) => {
      if (p.target === b && p.weapon === 'gun') gunHits++;
    });
    runFor(w, 40, (t) => {
      b.input.pitch = t > 5 ? 0.25 : 0;
      b.input.roll = t > 5 && Math.abs(b.flight.roll) < 1.0 ? 0.4 : 0;
      if (a.aiState === 'GUNS') sawGuns = true;
      return !b.alive;
    });
    expect(sawGuns).toBe(true);
    expect(gunHits).toBeGreaterThan(0);
  });

  it('1v1 dogfight: both fight (BFM), nobody hits the ground, somebody gets shot', () => {
    const tw = makeAiWorld('veteran', undefined, 5);
    const w = tw.world;
    const a = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 3_000, 0), heading: 0, speed: 230, ai: createAiBrain('fighter', { skill: 0.8, seed: 9 }) });
    const b = w.spawnAircraft({ type: 'su35', team: 'red', position: v3(2_500, 3_200, -3_000), heading: Math.PI * 1.5, speed: 230, ai: createAiBrain('fighter', { skill: 0.8, seed: 3 }) });
    a.stores.forEach((s) => (s.count = 0));
    b.stores.forEach((s) => (s.count = 0));
    const statesA = new Set<string>();
    const statesB = new Set<string>();
    let damage = 0;
    tw.events.on('damage', (p) => {
      if (p.weapon === 'gun') damage += p.amount;
    });
    // a jet may only hit the ground after being badly shot up (crippled engine / airframe)
    const healthyCrash: string[] = [];
    const shotUp = new Set<number>();
    tw.events.on('damage', (p) => {
      if (p.weapon !== 'collision') shotUp.add(p.target.id);
    });
    tw.events.on('destroyed', (p) => {
      if (p.weapon === 'collision' && !shotUp.has(p.entity.id)) healthyCrash.push(p.entity.name);
    });
    runFor(w, 150, () => {
      statesA.add(a.aiState);
      statesB.add(b.aiState);
      return !a.alive || !b.alive;
    });
    expect(statesA.has('BFM') && statesB.has('BFM')).toBe(true);
    expect(statesA.has('GUNS') || statesB.has('GUNS')).toBe(true);
    expect(healthyCrash).toEqual([]);
    expect(damage).toBeGreaterThan(0);
  });
});
