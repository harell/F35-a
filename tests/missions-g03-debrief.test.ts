/**
 * g03's words and its ending (#201): the cost summary in the debrief, the crater a killed stoat
 * leaves, the volunteers' radio, the runner_alert condition, and that every radio sender is one of the
 * mission's own (military or fictional) callsigns.
 */
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createAiBrain } from '../src/ai';
import { createMissionRunner, terrainPadsFor } from '../src/missions';
import { G03, G03_GROUPS, G03_NEST, G03_VOLUNTEERS } from '../src/missions/content/irgcWaiheke';
import { NZD_PER_USD, UNIT_COST_USD, costSummary, formatNzd } from '../src/missions/runtime/costs';
import type { MissionResultExt } from '../src/missions/runtime/resultExt';
import { costRows } from '../src/ui/screens/debrief';
import { Craters, craterProfile } from '../src/render/effects/Craters';
import { forceDestroy } from '../src/game/forceDestroy';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import type { TerrainQuery } from '../src/sim/api';

let terrain: TerrainQuery | null = null;
function realTerrain(): TerrainQuery {
  terrain ??= new TerrainQueryImpl(runSync(generateTerrain({ theater: G03.theater, seed: G03.seed, resolution: 512, features: allFeatures(G03.theater, G03.features), pads: terrainPadsFor(G03) })));
  return terrain;
}

/** g03 with the player pinned under the cloud 4 km west of the nest (the stoat is revealed at once). */
function setup() {
  const events = new EventBus();
  const world = createSimWorld({ terrain: realTerrain(), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(5) });
  const runner = createMissionRunner(G03, { createAi: createAiBrain, difficulty: DIFFICULTIES.pilot, events });
  runner.setup(world, G03.recommendedLoadout);
  const p = world.player!;
  const radio: { from: string; text: string }[] = [];
  events.on('radio', (e) => radio.push({ from: e.from, text: e.text }));
  const tick = (seconds: number) => {
    for (let i = 0; i < seconds * 60 && runner.state === 'running'; i++) {
      p.position.set(G03_NEST.x - 4_000, 1_200, G03_NEST.z);
      p.velocity.set(0, 0, 0);
      p.health = p.maxHealth;
      world.step(1 / 60);
      runner.update(world, 1 / 60);
    }
  };
  const stoat = () => world.ground.find((g) => g.groupId === G03_GROUPS.target);
  return { world, runner, p, radio, tick, stoat };
}

describe('the cost summary (#201)', () => {
  it('prices the flight time and each weapon fired, in NZ$, against the comparison', () => {
    const c = costSummary(1800, { aargm: 2, gbu53: 1 }, { label: 'Trap', nzd: 40 }, { label: 'Removed', count: 1 });
    expect(c.hours).toBeCloseTo(0.5, 6);
    expect(c.flightNzd).toBeCloseTo(0.5 * UNIT_COST_USD.flightHour * NZD_PER_USD, 3);
    expect(c.weapons).toEqual([
      { weapon: 'aargm', count: 2, nzd: 2 * UNIT_COST_USD.aargm * NZD_PER_USD },
      { weapon: 'gbu53', count: 1, nzd: UNIT_COST_USD.gbu53 * NZD_PER_USD },
    ]);
    expect(c.totalNzd).toBeCloseTo(c.flightNzd + c.weapons.reduce((n, w) => n + w.nzd, 0), 3);
    expect(formatNzd(40)).toBe('NZ$40');
    expect(formatNzd(2_500_000)).toBe('NZ$2.50 million');
    expect(formatNzd(21_000_000)).toBe('NZ$21.0 million');
  });

  it('g03 reports it: the stores fired since the start, the trap, and the stoats removed; the debrief lists it', { timeout: 60_000 }, () => {
    const m = setup();
    m.tick(2);
    const s = m.stoat()!;
    expect(s).toBeDefined();
    // two AARGMs and a StormBreaker gone from the stores, then the kill
    for (const st of m.p.stores) if (st.weapon === 'aargm') st.count = 0;
    for (const st of m.p.stores) if (st.weapon === 'gbu53') st.count -= 1;
    forceDestroy(m.world, s, m.p.id);
    m.tick(2);
    expect(m.runner.state).toBe('success');
    const r = m.runner.result(m.world) as MissionResultExt;
    const c = r.costSummary!;
    expect(c.weapons.map((w) => [w.weapon, w.count])).toEqual([
      ['aargm', 2],
      ['gbu53', 1],
    ]);
    expect(c.comparison).toEqual({ label: "Volunteer's trap, for comparison", nzd: 40 });
    expect(c.removed).toEqual({ label: 'Stoats removed', count: 1 });
    const rows = costRows(r);
    expect(rows.map((x) => x[1])).toEqual([expect.stringMatching(/^F-35A, [\d.]+ flight hours$/), '2 × AGM-88G AARGM-ER', '1 × GBU-53/B StormBreaker', 'Total', 'Volunteer&#39;s trap, for comparison', 'Stoats removed']);
    expect(rows.at(-2)![2]).toBe('NZ$40');
    expect(rows.at(-1)![2]).toBe('1');
    // the volunteers log the catch (the radio keeps playing after the end)
    for (let i = 0; i < 12 * 60; i++) {
      m.world.step(1 / 60);
      m.runner.update(m.world, 1 / 60);
    }
    expect(m.radio.some((x) => x.from === G03_VOLUNTEERS && /catch logged/.test(x.text))).toBe(true);
    m.runner.dispose?.();
  });

  it('a mission without a cost summary shows none', () => {
    expect(costRows({} as MissionResultExt)).toEqual([]);
  });
});

describe('the words (#201)', () => {
  it('every radio sender is DARKSTAR or the volunteers (fictional): no real organisation, station or brand', () => {
    const senders = new Set<string>();
    const walk = (actions: { kind: string; from?: string }[] | undefined) => {
      for (const a of actions ?? []) if (a.kind === 'radio') senders.add(a.from!);
    };
    walk(G03.script.opening);
    for (const t of G03.script.triggers) walk(t.actions);
    expect([...senders].sort()).toEqual(['DARKSTAR', G03_VOLUNTEERS].sort());
    const text = G03.briefing.join(' ');
    expect(text).toMatch(/Waiheke Trap Line volunteers/);
    expect(text).toMatch(/You will not destroy them all, and you will not need to/);
    expect(text).toMatch(/only authorised target/);
    expect(text).toMatch(/fire it close in/);
  });

  it('the volunteers call the bait stations and the moment it stands up; DARKSTAR types the contact', { timeout: 120_000 }, () => {
    const m = setup();
    m.tick(1);
    const s = m.stoat()!;
    // designated all along: at the first stop it stands up and the volunteers say so
    for (let i = 0; i < 160 && m.runner.state === 'running'; i++) {
      m.p.radar.designatedId = s.id;
      m.tick(0.5);
      if (m.radio.some((x) => /first station/.test(x.text)) && m.radio.some((x) => /stood up/.test(x.text))) break;
    }
    expect(m.radio.some((x) => x.from === 'DARKSTAR' && /Confirmed stoat/.test(x.text))).toBe(true);
    expect(m.radio.some((x) => x.from === G03_VOLUNTEERS && /first station/.test(x.text))).toBe(true);
    expect(m.radio.some((x) => x.from === G03_VOLUNTEERS && /stood up/.test(x.text))).toBe(true);
    m.runner.dispose?.();
  });

  it('no IRGC mission is the campaign finale (the campaign is still being built)', () => {
    expect(G03.script.campaignFinale).toBeFalsy();
  });
});

describe('the crater (#201)', () => {
  it('a shallow dark bowl with a raised sand rim, on the ground, facing up; the pool reuses the oldest', () => {
    expect(craterProfile(0, 0.45)).toBeCloseTo(0.06, 6);
    expect(craterProfile(0.9, 0.45)).toBeCloseTo(0.51, 6);
    expect(craterProfile(1.3, 0.45)).toBeCloseTo(0.06, 6);
    const c = new Craters(2);
    const ground = (x: number, z: number) => 10 + 0.01 * x - 0.02 * z;
    const mesh = c.add(100, 200, 3, ground);
    expect(c.count).toBe(1);
    const pos = mesh.geometry.getAttribute('position');
    const nrm = mesh.geometry.getAttribute('normal');
    // the centre sits on the ground (just above it), the normals point up
    expect(pos.getY(0)).toBeCloseTo(ground(100, 200) + 0.06, 3);
    expect(nrm.getY(0)).toBeGreaterThan(0.9);
    // every vertex within 1.4 radii, none below the ground
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + 100;
      const z = pos.getZ(i) + 200;
      expect(Math.hypot(x - 100, z - 200)).toBeLessThan(3 * 1.45);
      expect(pos.getY(i)).toBeGreaterThanOrEqual(ground(x, z));
    }
    c.add(0, 0, 3, ground);
    c.add(50, 50, 3, ground);
    expect(c.count).toBe(2);
    expect(c.group.children).toHaveLength(2);
    c.dispose();
  });

});
