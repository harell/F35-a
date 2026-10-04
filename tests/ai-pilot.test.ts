/**
 * AI low-level piloting with the REAL flight model: attitude/altitude capture without
 * porpoising, formation keeping, terrain safety over hills, mid-air avoidance, map edge.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { createAiBrain, Autopilot, FormationKeeper, SLOT_FINGERTIP, gammaForAltitude } from '../src/ai';
import { dirWithElevation, headingDir } from '../src/ai/geom';
import type { AiBrain } from '../src/sim/api';
import type { AircraftType } from '../src/core/types';
import { every, hills, makeAiWorld, runFor, v3 } from './ai-helpers';

/** Minimal brain: fly a heading / altitude with the Autopilot. */
function headingBrain(hdg: () => number, alt: number, speed: number): AiBrain {
  const ap = new Autopilot();
  const h = new Vector3();
  return {
    role: 'fighter',
    update(ac, world, dt) {
      const it = ap.begin(ac, 150);
      dirWithElevation(headingDir(hdg(), h), gammaForAltitude(ac, alt, 0.35, 6), it.dir);
      it.gMax = 5;
      it.gain = 1.2;
      it.speed = speed;
      it.allowAb = true;
      ap.fly(ac, world, dt);
    },
  };
}

describe('AI autopilot', () => {
  for (const type of ['f35a', 'su35'] as AircraftType[]) {
    it(`${type}: captures heading and altitude without oscillation`, () => {
      const { world } = makeAiWorld('veteran');
      let hdg = Math.PI / 2;
      const ac = world.spawnAircraft({ type, team: 'red', position: v3(0, 3000, 0), heading: 0, speed: 230, ai: headingBrain(() => hdg, 4000, 250) });
      let maxHdgErr = 0;
      let maxAltErr = 0;
      let maxRollLevel = 0;
      // porpoising = the vertical speed reversing again and again (hysteresis ±1.5 m/s)
      let vsSign = 0;
      let reversals = 0;
      runFor(world, 110, (t) => {
        if (t > 60) hdg = Math.PI * 1.5 - 0.3; // second, 160° turn the other way
        if (t > 20 && t < 60) {
          const vs = ac.velocity.y;
          const s = vs > 1.5 ? 1 : vs < -1.5 ? -1 : 0;
          if (s !== 0 && vsSign !== 0 && s !== vsSign) reversals++;
          if (s !== 0) vsSign = s;
        }
        if (t > 45 && t < 60) {
          maxHdgErr = Math.max(maxHdgErr, Math.abs(ac.flight.heading - Math.PI / 2));
          maxAltErr = Math.max(maxAltErr, Math.abs(ac.position.y - 4000));
          maxRollLevel = Math.max(maxRollLevel, Math.abs(ac.flight.roll));
        }
      });
      expect(ac.alive).toBe(true);
      expect(maxHdgErr).toBeLessThan(0.03); // < 2°
      expect(maxAltErr).toBeLessThan(40);
      expect(reversals).toBeLessThanOrEqual(1); // no porpoising
      expect(maxRollLevel).toBeLessThan(0.1);
      // after the reversal: settled on the new heading
      const want = Math.PI * 1.5 - 0.3;
      expect(Math.abs(ac.flight.heading - want)).toBeLessThan(0.05);
    });
  }
});

describe('AI formation', () => {
  it('friendly wingman holds fingertip within 300 m of the slot for 60 s through turns and a climb', () => {
    const { world } = makeAiWorld('pilot', undefined, 3);
    const p = world.spawnAircraft({ type: 'f35a', team: 'blue', position: v3(0, 3000, 0), heading: 0, speed: 230, isPlayer: true, callsign: 'Viper 1', loadout: 'a2a_stealth' });
    const wm = world.spawnAircraft({
      type: 'f35a',
      team: 'blue',
      position: v3(600, 3000, 800),
      heading: 0,
      speed: 230,
      callsign: 'Viper 2',
      leaderId: p.id,
      ai: createAiBrain('wingman', { skill: 0.6, seed: 4 }),
    });
    const slot = new Vector3();
    let maxErr = 0;
    let maxErrLate = 0;
    let minSep = Infinity;
    runFor(world, 100, (t) => {
      // scripted "player": straight, 30° right turn, straight, 45° left turn, climb
      const want = t < 40 ? 0 : t < 55 ? 0.52 : t < 65 ? 0 : t < 80 ? -0.78 : 0;
      p.input.roll = Math.max(-1, Math.min(1, (want - p.flight.roll) * 2));
      p.input.pitch = t > 85 && t < 90 ? 0.15 : 0;
      p.input.throttle = 0.7;
      FormationKeeper.slotPosition(p, SLOT_FINGERTIP, slot);
      const err = slot.distanceTo(wm.position);
      if (t > 35) {
        maxErr = Math.max(maxErr, err);
        expect(wm.aiState).toBe('FORM');
      }
      if (t > 60) maxErrLate = Math.max(maxErrLate, err);
      minSep = Math.min(minSep, wm.position.distanceTo(p.position));
    });
    expect(wm.alive && p.alive).toBe(true);
    expect(maxErr).toBeLessThan(300);
    expect(maxErrLate).toBeLessThan(200);
    expect(minSep).toBeGreaterThan(20); // never close to a mid-air
  });

  it('enemy pair: wingman flies fighting wing on its AI leader while on patrol', () => {
    const { world } = makeAiWorld('veteran');
    const lead = world.spawnAircraft({ type: 'su27', team: 'red', position: v3(0, 4000, 0), heading: 0, speed: 240, ai: createAiBrain('cap', { skill: 0.6, seed: 1 }) });
    const wing = world.spawnAircraft({ type: 'su27', team: 'red', position: v3(1500, 4000, 1500), heading: 0, speed: 240, leaderId: lead.id, ai: createAiBrain('fighter', { skill: 0.6, seed: 2 }) });
    let maxD = 0;
    runFor(world, 90, (t) => {
      if (t > 30) maxD = Math.max(maxD, wing.position.distanceTo(lead.position));
    });
    expect(lead.aiState).toBe('PATROL');
    expect(wing.aiState).toBe('FORM');
    expect(maxD).toBeLessThan(1_200);
  });
});

describe('AI terrain & collision safety', () => {
  it('jets flying a low route over hills for 3 simulated minutes never hit the ground', () => {
    const terr = hills();
    const { world } = makeAiWorld('recruit', terr, 3);
    const wps = [v3(12_000, 150, -15_000), v3(-14_000, 150, -9_000), v3(-8_000, 150, 14_000), v3(13_000, 150, 9_000)];
    const route = (rev: boolean) => ({ kind: 'route' as const, waypoints: rev ? wps.slice().reverse() : wps, loop: true });
    const jets = [
      // red jets have no Auto-GCAS: the AI's own terrain layer must keep them alive
      world.spawnAircraft({ type: 'su27', team: 'red', position: v3(0, 900, 0), heading: 0.7, speed: 250, ai: createAiBrain('fighter', { skill: 0, seed: 1, task: route(false) }) }),
      world.spawnAircraft({ type: 'mig29', team: 'red', position: v3(2_000, 900, 2_000), heading: 3, speed: 260, ai: createAiBrain('fighter', { skill: 1, seed: 2, task: route(true) }) }),
      world.spawnAircraft({ type: 'su27', team: 'red', position: v3(-3_000, 1_200, 3_000), heading: 1, speed: 240, ai: createAiBrain('bomber', { skill: 0.5, seed: 3, task: route(false) }) }),
    ];
    const minAgl = jets.map(() => Infinity);
    runFor(world, 180, (t) => {
      if (t > 2) jets.forEach((j, i) => (minAgl[i] = Math.min(minAgl[i], j.position.y - terr.surfaceHeightAt(j.position.x, j.position.z))));
    });
    for (let i = 0; i < jets.length; i++) {
      expect(jets[i].alive, `${jets[i].type} alive`).toBe(true);
      expect(jets[i].crashed).toBe(false);
      expect(minAgl[i]).toBeGreaterThan(60);
    }
  });

  it('pulls out of a steep dive towards the sea', () => {
    const { world } = makeAiWorld('veteran');
    const ac = world.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 1_800, 0), heading: 0, speed: 280, ai: createAiBrain('fighter', { skill: 0.2, seed: 1, task: { kind: 'route', waypoints: [v3(0, 10, -30_000)], loop: false } }) });
    // start in a 45° dive
    ac.velocity.set(0, -200, -200);
    ac.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 4);
    let minAlt = Infinity;
    runFor(world, 30, () => {
      minAlt = Math.min(minAlt, ac.position.y);
    });
    expect(ac.alive).toBe(true);
    expect(minAlt).toBeGreaterThan(40);
  });

  it('recovers from a low-speed, nose-high start without departing or losing control', () => {
    const { world } = makeAiWorld('veteran');
    const ac = world.spawnAircraft({ type: 'su27', team: 'red', position: v3(0, 5_000, 0), heading: 0, speed: 95, ai: createAiBrain('fighter', { skill: 0.3, seed: 1 }) });
    // 30° nose-high, slow: the pilot must unload, go to full power and regain flying speed
    ac.velocity.set(0, 45, -85);
    ac.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), 0.55);
    let minAlt = Infinity;
    runFor(world, 40, () => {
      minAlt = Math.min(minAlt, ac.position.y);
    });
    expect(ac.alive).toBe(true);
    expect(ac.flight.ias).toBeGreaterThan(150);
    expect(minAlt).toBeGreaterThan(3_500);
  });

  it('two jets on a head-on collision course avoid each other', () => {
    const { world } = makeAiWorld('veteran');
    const route = (z: number) => ({ kind: 'route' as const, waypoints: [v3(0, 3_000, z)], loop: false });
    const a = world.spawnAircraft({ type: 'su27', team: 'red', position: v3(0, 3_000, 6_000), heading: 0, speed: 250, ai: createAiBrain('fighter', { skill: 0.5, seed: 1, task: route(-30_000) }) });
    const b = world.spawnAircraft({ type: 'mig29', team: 'red', position: v3(0, 3_000, -6_000), heading: Math.PI, speed: 250, ai: createAiBrain('fighter', { skill: 0.5, seed: 2, task: route(30_000) }) });
    let minD = Infinity;
    runFor(world, 40, () => {
      minD = Math.min(minD, a.position.distanceTo(b.position));
    });
    expect(a.alive && b.alive).toBe(true);
    expect(minD).toBeGreaterThan(30);
  });

  it('turns back before leaving the map', () => {
    const { world } = makeAiWorld('veteran');
    const ac = world.spawnAircraft({ type: 'su27', team: 'red', position: v3(30_000, 5_000, 0), heading: Math.PI / 2, speed: 300, ai: createAiBrain('fighter', { skill: 0.5, seed: 1, task: { kind: 'route', waypoints: [v3(200_000, 5_000, 0)], loop: false } }) });
    let maxX = 0;
    runFor(world, 90, (t) => {
      maxX = Math.max(maxX, ac.position.x);
      if (every(t, 1)) expect(Math.abs(ac.position.z)).toBeLessThan(40_000);
    });
    expect(maxX).toBeLessThan(40_000);
  });
});
