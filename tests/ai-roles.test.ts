/**
 * AI roles & tasks: bomber route, escort, CAP commit, friendly wingman
 * (engage + radio), setTask re-tasking, difficulty/skill scaling.
 */
import { describe, expect, it } from 'vitest';
import { createAiBrain, deriveSkill, ENGAGED_STATES } from '../src/ai';
import { DIFFICULTIES } from '../src/core/data';
import type { AiBrain } from '../src/sim/api';
import { makeAiWorld, runFor, v3 } from './ai-helpers';

describe('AI bomber', () => {
  it('follows its route through every waypoint in order, then heads home', () => {
    const { world } = makeAiWorld('veteran');
    const wps = [v3(0, 8_000, -20_000), v3(18_000, 8_000, -30_000), v3(30_000, 8_500, -10_000), v3(15_000, 8_000, 8_000)];
    const brain = createAiBrain('bomber', { skill: 0.5, seed: 1, task: { kind: 'route', waypoints: wps, loop: false } });
    const ac = world.spawnAircraft({ type: 'su27', team: 'red', position: v3(0, 8_000, 5_000), heading: 0, speed: 240, ai: brain });
    const minD = wps.map(() => Infinity);
    const order: number[] = [];
    let maxBank = 0;
    runFor(world, 420, (t) => {
      for (let i = 0; i < wps.length; i++) {
        const d = Math.hypot(ac.position.x - wps[i].x, ac.position.z - wps[i].z);
        if (d < minD[i]) minD[i] = d;
        if (d < 2_000 && !order.includes(i)) order.push(i);
      }
      if (t > 5) maxBank = Math.max(maxBank, Math.abs(ac.flight.roll));
      return ac.aiState === 'RTB';
    });
    expect(ac.alive).toBe(true);
    for (let i = 0; i < wps.length; i++) expect(minD[i], `waypoint ${i}`).toBeLessThan(2_000);
    expect(order).toEqual([0, 1, 2, 3]);
    expect(ac.aiState).toBe('RTB');
    expect(maxBank).toBeLessThan(1.1); // steady: never beyond ~60° of bank
    expect(Math.abs(ac.position.y - 8_000)).toBeLessThan(900);
  });

  it('dispenses countermeasures and weaves when a missile is inbound', () => {
    const tw = makeAiWorld('veteran', undefined, 4);
    const w = tw.world;
    const bomber = w.spawnAircraft({ type: 'su27', team: 'red', position: v3(0, 6_000, 0), heading: 0, speed: 240, ai: createAiBrain('bomber', { skill: 0.7, seed: 2 }) });
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(1_200, 6_000, 3_000), heading: -0.3, speed: 280, loadout: 'a2a_beast' });
    const flares0 = bomber.flares;
    let fired = false;
    let sawDefensive = false;
    runFor(w, 15, (t) => {
      if (!fired && t > 0.3) fired = !!w.combat.fire(f35, w, 'aim9x', bomber.id);
      if (bomber.aiState === 'DEFENSIVE') sawDefensive = true;
    });
    expect(fired).toBe(true);
    expect(sawDefensive).toBe(true);
    expect(bomber.flares).toBeLessThan(flares0);
  });
});

describe('AI escort & CAP', () => {
  it('escort stays with its bomber, engages a threat to it, then returns', () => {
    const tw = makeAiWorld('veteran', undefined, 6);
    const w = tw.world;
    const bomber = w.spawnAircraft({ type: 'su27', team: 'red', position: v3(0, 7_000, 0), heading: 0, speed: 240, ai: createAiBrain('bomber', { skill: 0.5, seed: 1 }) });
    const esc = w.spawnAircraft({ type: 'su27', team: 'red', position: v3(1_500, 7_500, 1_500), heading: 0, speed: 240, ai: createAiBrain('escort', { skill: 0.8, seed: 2, task: { kind: 'escort', leaderId: bomber.id } }) });
    let maxD = 0;
    runFor(w, 50, (t) => {
      if (t > 25) maxD = Math.max(maxD, esc.position.distanceTo(bomber.position));
    });
    expect(esc.aiState).toBe('ESCORT');
    expect(maxD).toBeLessThan(4_000);
    // a (non-stealthy) hostile comes at the bomber
    const threat = w.spawnAircraft({ type: 'mig29', team: 'blue', position: v3(0, 7_000, -60_000), heading: Math.PI, speed: 250 });
    let engaged = false;
    runFor(w, 90, () => {
      if (ENGAGED_STATES.has(esc.aiState)) engaged = true;
      return engaged && tw.launches.some((l) => l.shooter === esc);
    });
    expect(engaged).toBe(true);
    // threat gone: back on the bomber's wing
    threat.alive = false;
    runFor(w, 60);
    expect(esc.aiState).toBe('ESCORT');
  });

  it('CAP patrols its station and commits on a bandit inside the commit range', () => {
    const tw = makeAiWorld('veteran', undefined, 9);
    const w = tw.world;
    const center = v3(0, 5_000, 0);
    const cap = w.spawnAircraft({ type: 'su35', team: 'red', position: v3(0, 5_000, 0), heading: 0, speed: 240, ai: createAiBrain('cap', { skill: 0.7, seed: 4, task: { kind: 'patrol', center, radius: 8_000, altitude: 5_000 } }) });
    let maxR = 0;
    runFor(w, 120, () => {
      maxR = Math.max(maxR, Math.hypot(cap.position.x, cap.position.z));
    });
    expect(cap.aiState).toBe('PATROL');
    expect(maxR).toBeLessThan(25_000);
    w.spawnAircraft({ type: 'mig29', team: 'blue', position: v3(25_000, 5_000, 0), heading: -Math.PI / 2, speed: 250 });
    let committed = false;
    runFor(w, 60, () => {
      if (ENGAGED_STATES.has(cap.aiState)) committed = true;
      return committed;
    });
    expect(committed).toBe(true);
  });
});

describe('AI friendly wingman', () => {
  it('engages a hostile fighter within 15 km with an "engaged" call, shoots it down and calls "splash"', () => {
    const tw = makeAiWorld('pilot', undefined, 8);
    const w = tw.world;
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 4_000, 0), heading: 0, speed: 240, isPlayer: true, callsign: 'Viper 1', loadout: 'a2a_stealth' });
    const wm = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(80, 4_000, 60), heading: 0, speed: 240, callsign: 'Viper 2', leaderId: p.id, ai: createAiBrain('wingman', { skill: 0.8, seed: 3 }) });
    runFor(w, 5);
    expect(wm.aiState).toBe('FORM');
    // an unarmed bandit (drone) so the outcome is about the wingman, not a coin toss
    const bandit = w.spawnAircraft({ type: 'su27', team: 'red', position: v3(3_000, 4_000, -14_000), heading: Math.PI, speed: 240, ai: createAiBrain('fighter', { skill: 0.1, seed: 5 }) });
    bandit.stores.forEach((st) => (st.count = 0));
    bandit.gunAmmo = 0;
    let engaged = false;
    runFor(w, 120, () => {
      if (ENGAGED_STATES.has(wm.aiState)) engaged = true;
      return !bandit.alive && tw.radio.some((r) => r.voice === 'p_splash');
    });
    expect(engaged).toBe(true);
    expect(tw.radio.some((r) => r.from === 'Viper 2' && r.voice === 'p_engaged')).toBe(true);
    expect(tw.launches.some((l) => l.shooter === wm && l.targetId === bandit.id)).toBe(true);
    expect(bandit.alive).toBe(false);
    expect(wm.kills).toBeGreaterThan(0);
    expect(tw.radio.some((r) => r.from === 'Viper 2' && r.voice === 'p_splash')).toBe(true);
    // rate limiting: never two "engaged" calls within 12 s
    const eng = tw.radio.filter((r) => r.voice === 'p_engaged');
    expect(eng.length).toBeLessThanOrEqual(2);
  });

  it("supports the player's designated target over a closer bandit", () => {
    const tw = makeAiWorld('pilot', undefined, 8);
    const w = tw.world;
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 4_000, 0), heading: 0, speed: 240, isPlayer: true, callsign: 'Viper 1', loadout: 'a2a_stealth' });
    const wm = w.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(80, 4_000, 60), heading: 0, speed: 240, callsign: 'Viper 2', leaderId: p.id, ai: createAiBrain('wingman', { skill: 0.8, seed: 3 }) });
    const near = w.spawnAircraft({ type: 'mig29', team: 'red', position: v3(-6_000, 4_000, -12_000), heading: 0, speed: 230 });
    const far = w.spawnAircraft({ type: 'su27', team: 'red', position: v3(6_000, 4_500, -22_000), heading: 0, speed: 230 });
    runFor(w, 2);
    w.combat.designate(p, far.id, w);
    expect(p.radar.designatedId).toBe(far.id);
    runFor(w, 3);
    expect((wm.ai as unknown as { target: number | null }).target).toBe(far.id);
    expect(near.alive).toBe(true);
  });

  it('red AI never makes radio calls (the player only hears friendlies)', () => {
    const tw = makeAiWorld('veteran', undefined, 2);
    const w = tw.world;
    w.spawnAircraft({ type: 'su27', team: 'red', position: v3(0, 4_000, 0), heading: 0, speed: 240, ai: createAiBrain('fighter', { skill: 0.8, seed: 1 }) });
    w.spawnAircraft({ type: 'mig29', team: 'blue', position: v3(0, 4_000, -15_000), heading: Math.PI, speed: 240, ai: createAiBrain('fighter', { skill: 0.5, seed: 2 }) });
    runFor(w, 40);
    expect(tw.radio.filter((r) => r.team === 'red').length).toBe(0);
  });
});

describe('AI RWR spike', () => {
  it('a red fighter that cannot see the stealthy F-35 turns towards its radar lock', () => {
    const { world } = makeAiWorld('veteran', undefined, 5);
    const red = world.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 5_000, 0), heading: 0, speed: 230, ai: createAiBrain('fighter', { skill: 0.7, seed: 2 }) });
    // clean F-35 20 km to the east, locking the MiG with its radar
    const f35 = world.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(20_000, 5_000, 0), heading: -Math.PI / 2, speed: 240, loadout: 'a2a_stealth' });
    runFor(world, 3, () => {
      if (f35.radar.designatedId !== red.id) world.combat.designate(f35, red.id, world);
    });
    let turned = false;
    runFor(world, 20, () => {
      if (f35.radar.designatedId !== red.id) world.combat.designate(f35, red.id, world);
      // heading east ≈ 90°
      if (red.aiState === 'INTERCEPT' && Math.abs(red.flight.heading - Math.PI / 2) < 0.3) turned = true;
      return turned;
    });
    expect(f35.radar.lockedId).toBe(red.id);
    expect(turned).toBe(true);
  });
});

describe('AI strike', () => {
  it('friendly F-35 on an attack task flies to a SAM site, releases A/G weapons and egresses', () => {
    const tw = makeAiWorld('veteran', undefined, 12);
    const w = tw.world;
    const sam = w.spawnSam({ type: 'sa6', team: 'red', position: v3(0, 0, -30_000), known: true });
    const f = w.spawnAircraft({
      type: 'f35a',
      team: 'blue',
      position: v3(0, 5_000, 5_000),
      heading: 0,
      speed: 250,
      callsign: 'Hammer 1',
      loadout: 'sead_stealth',
      ai: createAiBrain('fighter', { skill: 0.8, seed: 3, task: { kind: 'attack', targetId: sam.id } }),
    });
    const states = new Set<string>();
    runFor(w, 180, () => {
      states.add(f.aiState);
      return f.aiState === 'EGRESS';
    });
    const ag = tw.launches.filter((l) => l.shooter === f && l.missile.def.category !== 'aam');
    expect(states.has('STRIKE')).toBe(true);
    expect(ag.length).toBeGreaterThan(0);
    expect(ag.every((l) => l.targetId === sam.id || l.targetId === null)).toBe(true);
    expect(f.aiState).toBe('EGRESS');
  });

  it('bomber raid: runs in on its target, then turns for home', () => {
    const { world } = makeAiWorld('veteran');
    const tgt = world.spawnGround({ type: 'bunker', team: 'blue', position: v3(0, 0, -30_000) });
    const b = world.spawnAircraft({ type: 'su27', team: 'red', position: v3(8_000, 7_000, 10_000), heading: 0, speed: 250, ai: createAiBrain('bomber', { skill: 0.5, seed: 1, task: { kind: 'attack', targetId: tgt.id } }) });
    let minD = Infinity;
    runFor(world, 240, () => {
      minD = Math.min(minD, Math.hypot(b.position.x - tgt.position.x, b.position.z - tgt.position.z));
      return b.aiState === 'RTB';
    });
    expect(minD).toBeLessThan(2_500);
    expect(b.aiState).toBe('RTB');
  });
});

describe('AI tasks & skill', () => {
  it('setTask re-tasks a patrolling fighter to RTB', () => {
    const { world } = makeAiWorld('veteran');
    const brain: AiBrain = createAiBrain('fighter', { skill: 0.5, seed: 1 });
    const ac = world.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 3_000, 0), heading: 0, speed: 230, ai: brain });
    runFor(world, 10);
    expect(ac.aiState).toBe('PATROL');
    const home = v3(20_000, 0, 20_000);
    brain.setTask!({ kind: 'rtb', point: home });
    runFor(world, 150);
    expect(ac.aiState).toBe('RTB');
    expect(Math.hypot(ac.position.x - home.x, ac.position.z - home.z)).toBeLessThan(9_000);
  });

  it('difficulty and spawn skill scale reaction, g, aim and discipline', () => {
    const rookie = deriveSkill(DIFFICULTIES.recruit, 0.2, 'red', 'mig29');
    const ace = deriveSkill(DIFFICULTIES.veteran, 1, 'red', 'su35');
    expect(ace.level).toBeGreaterThan(rookie.level);
    expect(ace.reaction).toBeLessThan(rookie.reaction);
    expect(ace.maxG).toBeGreaterThan(rookie.maxG);
    expect(ace.aimSigma).toBeLessThan(rookie.aimSigma);
    expect(ace.gunCone).toBeLessThan(rookie.gunCone);
    expect(ace.maxG).toBeLessThanOrEqual(9);
    // friendlies are competent on every difficulty
    const wing = deriveSkill(DIFFICULTIES.recruit, 0.5, 'blue', 'f35a');
    expect(wing.level).toBeGreaterThan(0.6);
  });
});
