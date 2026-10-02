/**
 * IRGC campaign mission 2, g02 "Straight Outta Hauraki" (#82): an escort under a clock. The two-hit
 * tanker sails out of the Rangitoto Channel into the Hauraki Gulf; suicide boats reach her about 2
 * minutes in, missile boats reach launch range 3–4 minutes in (a Kowsar can't be shot down), and
 * air-defence boats escort them. Sinking the suicide and missile boats with her afloat wins; two
 * hits sink her and fail the mission.
 *
 * The clocks are checked on the real LINZ coast (the boats steer round land), with the player
 * parked far out of the fight.
 */
import { describe, expect, it } from 'vitest';
import { EventBus, type GameEventMap } from '../src/core/events';
import { DIFFICULTIES, LOADOUTS } from '../src/core/data';
import type { Difficulty } from '../src/core/types';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createAiBrain } from '../src/ai';
import type { SimWorld, TerrainQuery } from '../src/sim/api';
import { isKowsar } from '../src/sim/boats';
import { CAMPAIGNS, campaignOf, createMissionRunner, missionById, missionGunAmmo, terrainPadsFor, validateMission } from '../src/missions';
import { G02, G02_GROUPS, G02_TANKER } from '../src/missions/content/irgcHauraki';
import { forceDestroy } from '../src/game/forceDestroy';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { runPlaythrough } from './missions-bot';

const DT = 1 / 60;
const DIFFS: Difficulty[] = ['recruit', 'pilot', 'veteran', 'ace'];

let terrain: TerrainQuery | null = null;
/** The real Auckland terrain (LINZ coast) the mission is flown on. */
function realTerrain(): TerrainQuery {
  terrain ??= new TerrainQueryImpl(runSync(generateTerrain({ theater: G02.theater, seed: G02.seed, resolution: 512, features: allFeatures(G02.theater, []), pads: terrainPadsFor(G02) })));
  return terrain;
}

/** g02 on the real coast; the player is parked far out of the fight (unless `park` is false). */
function setup(difficulty: Difficulty = 'pilot') {
  const events = new EventBus();
  const diff = DIFFICULTIES[difficulty];
  const world = createSimWorld({ terrain: realTerrain(), difficulty: diff, events, combat: createCombatSystemSeeded(5) });
  const runner = createMissionRunner(G02, { createAi: createAiBrain, difficulty: diff, events });
  runner.setup(world, G02.recommendedLoadout);
  const p = world.player!;
  const tanker = world.ground.find((g) => g.groupId === G02_TANKER.group)!;
  const group = (id: string) => [...world.ground, ...world.sams].filter((e) => e.groupId === id);
  const record = <K extends keyof GameEventMap>(name: K): (GameEventMap[K] & { t: number })[] => {
    const out: (GameEventMap[K] & { t: number })[] = [];
    events.on(name, (e) => out.push({ ...e, t: world.time }));
    return out;
  };
  /** Run up to `seconds` while the mission runs; `each` returning true stops early. */
  const tick = (seconds: number, each?: () => boolean | void) => {
    for (let i = 0; i < seconds * 60 && runner.state === 'running'; i++) {
      p.position.set(-35_000, 13_000, 35_000);
      p.health = p.maxHealth;
      world.step(DT);
      runner.update(world, DT);
      if (each?.()) return;
    }
  };
  const objective = (id: string) => runner.objectives.find((o) => o.id === id)!;
  return { world, runner, p, tanker, group, record, tick, objective };
}

const water = (w: SimWorld, e: { position: { x: number; z: number } }) => w.terrain.isWater(e.position.x, e.position.z);

describe('g02 Straight Outta Hauraki: content', () => {
  it('is the IRGC campaign mission 2, reachable by id (?mission=g02&autostart=1), and valid', () => {
    expect(missionById('g02')).toBe(G02);
    expect(campaignOf('g02')?.id).toBe('irgc');
    const irgc = CAMPAIGNS.find((c) => c.id === 'irgc')!;
    expect(irgc.missions).toContain(G02);
    expect(G02.kind).toBe('campaign');
    expect(G02.index).toBe(2);
    expect(G02.title).toBe('Straight Outta Hauraki');
    expect(G02.theater).toBe('auckland');
    expect(validateMission(G02)).toEqual([]);
  });

  it('offers only loadouts whose bombs can hit a moving boat (GBU-53/B), recommends all eight, and loads 360 rounds', () => {
    expect(G02.recommendedLoadout).toBe('strike_sdb2_full');
    expect(G02.allowedLoadouts).toContain('strike_sdb2');
    for (const id of G02.allowedLoadouts) {
      const bombs = LOADOUTS[id].stores.filter((s) => s.weapon === 'gbu31' || s.weapon === 'gbu39' || s.weapon === 'gbu53');
      expect(bombs.length, id).toBeGreaterThan(0);
      for (const b of bombs) expect(b.weapon, id).toBe('gbu53'); // GPS-only JDAM / GBU-39 miss a moving boat (#65)
      for (const d of DIFFS) expect(missionGunAmmo(G02, d, id), `${id} ${d}`).toBe(360);
    }
  });

  it('the briefing names the mother ship, the two-hit rule, the early release and the friendly-fire risk', () => {
    const text = G02.briefing.join(' ');
    expect(text).toMatch(/mother ship/i);
    expect(text).toMatch(/two hits sink her/i);
    expect(text).toMatch(/release early/i);
    expect(text).toMatch(/alongside the tanker can hit her/i);
    expect(text).toMatch(/cannot be shot down/i);
  });

  it('every boat and the tanker start on open water, and her route out through the Gulf stays on it (real LINZ coast)', () => {
    const t = realTerrain();
    for (const g of [...G02.script.ground, ...G02.script.sams]) expect(t.isWater(g.x, g.z), g.id).toBe(true);
    const route = [G02_TANKER.start, ...G02_TANKER.path];
    for (let i = 1; i < route.length; i++) {
      for (let k = 0; k <= 20; k++) {
        const x = route[i - 1].x + ((route[i].x - route[i - 1].x) * k) / 20;
        const z = route[i - 1].z + ((route[i].z - route[i - 1].z) * k) / 20;
        expect(t.isWater(x, z), `leg ${i} at ${Math.round(x)},${Math.round(z)}`).toBe(true);
      }
    }
  });

  it('the boat mix: 2 air-defence, 3 missile, 3 suicide; Veteran adds a suicide boat, Ace a missile boat too', { timeout: 60_000 }, () => {
    const want: Record<Difficulty, [number, number, number]> = { recruit: [3, 3, 2], pilot: [3, 3, 2], veteran: [4, 3, 2], ace: [4, 4, 2] };
    for (const d of DIFFS) {
      const m = setup(d);
      const n = [m.group(G02_GROUPS.suicide).length, m.group(G02_GROUPS.missile).length, m.group(G02_GROUPS.ad).length];
      expect(n, d).toEqual(want[d]);
      expect(m.tanker.team).toBe('neutral');
      expect(m.tanker.hitsToSink).toBe(2);
      expect(m.tanker.name).toBe(G02_TANKER.name);
      m.runner.dispose?.();
    }
  });
});

describe('g02: the clocks and the outcome (real sim, real coast)', { timeout: 60_000 }, () => {
  it('untouched: the suicide wave hits her at about 2 minutes and the second ram sinks her: mission failed', () => {
    const m = setup();
    const hits = m.record('vessel:hit');
    let wet = true;
    m.tick(300, () => {
      for (const b of [...m.group(G02_GROUPS.suicide), ...m.group(G02_GROUPS.missile), ...m.group(G02_GROUPS.ad)]) if (b.alive && !water(m.world, b)) wet = false;
    });
    expect(wet).toBe(true); // no boat ever crossed the coast
    expect(hits.length).toBe(2);
    expect(hits[0].weapon).toBe('collision'); // a suicide boat's ram
    expect(hits[0].t).toBeGreaterThan(105);
    expect(hits[0].t).toBeLessThan(135);
    expect(hits[1].hits).toBe(2);
    expect(m.tanker.alive).toBe(false);
    expect(m.objective('o_tanker').state).toBe('failed');
    expect(m.runner.state).toBe('failed');
    expect(m.runner.result(m.world).success).toBe(false);
    m.runner.dispose?.();
  });

  it('untouched missile boats (the suicide boats sunk at the start): in range and counting down at about 3 minutes, launching at 3–4', () => {
    const m = setup();
    for (const b of m.group(G02_GROUPS.suicide)) forceDestroy(m.world, b, m.p.id);
    const launches = m.record('munition:launch');
    const hits = m.record('vessel:hit');
    let countdownAt = -1;
    m.tick(300, () => {
      if (countdownAt < 0 && m.group(G02_GROUPS.missile).some((b) => b.kind === 'ground' && (b.boat?.strike?.timer ?? -1) >= 0)) countdownAt = m.world.time;
    });
    const kowsars = launches.filter((l) => isKowsar(l.missile));
    expect(countdownAt).toBeGreaterThan(165);
    expect(countdownAt).toBeLessThan(225);
    expect(kowsars.length).toBeGreaterThanOrEqual(2);
    expect(kowsars[0].t).toBeGreaterThan(180);
    expect(kowsars[0].t).toBeLessThan(240);
    // two Kowsar hits sink her: the mission fails
    expect(hits.filter((h) => h.weapon === 'kowsar').length).toBe(2);
    expect(m.tanker.alive).toBe(false);
    expect(m.runner.state).toBe('failed');
    m.runner.dispose?.();
  });

  it('killing every boat wins, the escorts included (with the tanker never hit)', () => {
    const m = setup();
    m.tick(5);
    for (const id of [G02_GROUPS.ad, G02_GROUPS.suicide, G02_GROUPS.missile]) for (const b of m.group(id)) forceDestroy(m.world, b, m.p.id);
    m.tick(5);
    expect(m.tanker.alive).toBe(true);
    expect(m.tanker.hits).toBe(0);
    for (const o of ['o_suicide', 'o_missile', 'o_ad', 'o_tanker']) expect(m.objective(o).state, o).toBe('complete');
    expect(m.runner.state).toBe('success');
    m.runner.dispose?.();
  });

  it('the air-defence boats are a bonus: sinking the suicide and missile boats with her afloat (even hit once) wins', () => {
    const m = setup();
    m.tick(2);
    m.world.applyDamage(m.tanker, 300, null, 'kowsar');
    for (const id of [G02_GROUPS.suicide, G02_GROUPS.missile]) for (const b of m.group(id)) forceDestroy(m.world, b, m.p.id);
    m.tick(5);
    expect(m.tanker.alive).toBe(true);
    expect(m.tanker.hits).toBe(1);
    expect(m.objective('o_ad').primary).toBe(false);
    expect(m.objective('o_ad').state).toBe('active');
    expect(m.runner.state).toBe('success');
    m.runner.dispose?.();
  });
});

describe('g02: the competent bot (tests/missions-bot.ts)', () => {
  it('wins on Recruit and Pilot by rippling a StormBreaker onto each boat, suicide boats first', { timeout: 120_000 }, () => {
    for (const diff of ['recruit', 'pilot'] as const) {
      for (const seed of [0, 1]) {
        const r = runPlaythrough('g02', diff, seed, realTerrain(), { maxT: 400 });
        expect(r.state, `${diff} seed ${seed}: ${r.reason}`).toBe('success');
        // before the suicide boats' 2-minute clock runs out
        expect(r.t, `${diff} seed ${seed}`).toBeLessThan(240);
      }
    }
  });
});
