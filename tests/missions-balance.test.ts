/**
 * MISSIONS i2 — campaign difficulty walls (reviewer sweep with the project's MissionBot):
 *  - c04 'Broken Wing' was 0/2 on Pilot (SA-6 / SA-15 point defence shooting down the JDAMs);
 *  - c10 'Night Harbour' was 0/2 on Pilot (Su-27 sweep R-27s at 137/159 s) and failed on Recruit;
 *  - c07 'Mainstay' on Veteran/Ace was an unavoidable Su-35 R-77 kill at 51–58 s.
 * Full sweep: npx vite-node tools/playtest/bot-sweep.ts -- --missions=<ids> --diffs=<difficulties>.
 *
 * Issue #57 (playtest 2026-10-02): the Pilot band (≥ 75 % over 6 seeds) in c02, c09 and t03, and no
 * free wins in c02 / c09 for a player parked far from the fight.
 */
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import { buildInstantMissionSeeded, createMissionRunner, missionById, terrainPadsFor } from '../src/missions';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createAiBrain } from '../src/ai';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { difficultyAtLeast } from '../src/missions/runtime/state';
import type { Difficulty } from '../src/core/types';
import { LOADOUTS } from '../src/core/data';
import type { TerrainQuery } from '../src/sim/api';
import { runPlaythrough } from './missions-bot';

const terrains = new Map<string, TerrainQuery>();
function terrainFor(id: string): TerrainQuery {
  let t = terrains.get(id);
  if (!t) {
    const def = missionById(id)!;
    t = new TerrainQueryImpl(runSync(generateTerrain({ theater: def.theater, seed: def.seed, resolution: 512, features: allFeatures(def.theater, []), pads: terrainPadsFor(def) })));
    terrains.set(id, t);
  }
  return t;
}

function wins(id: string, diff: Difficulty, seeds: number[]): { won: number; log: string[] } {
  const log: string[] = [];
  let won = 0;
  for (const seed of seeds) {
    const r = runPlaythrough(id, diff, seed, terrainFor(id), { maxT: 900 });
    if (r.state === 'success') won++;
    log.push(`${id} ${diff} seed ${seed}: ${r.state}@${Math.round(r.t)}s ${r.reason ?? ''}`);
  }
  return { won, log };
}

describe('#65: StormBreaker follow-ups (playtest 2026-10-02, 2.1-c / 2.2-h)', () => {
  it('c08 offers strike_sdb2 only while saying it carries no anti-radiation missile (Pilot was 0/3 to the SA-10)', () => {
    const def = missionById('c08')!;
    if (!def.allowedLoadouts.includes('strike_sdb2')) return;
    expect(LOADOUTS.strike_sdb2.stores.some((s) => s.weapon === 'aargm')).toBe(false);
    expect(LOADOUTS.strike_sdb2.description).toMatch(/no anti-radiation missile/i);
    expect(def.briefing.join(' ')).toMatch(/StormBreaker[^.]*no anti-radiation missile/i);
  });

  // decision: no fast corvette. Measured (crossing ship, IN RANGE release from 7.6 km): a JDAM's
  // 56 s fall sinks a 1 m/s corvette and misses one at 3, 5, 6 or 8 m/s; a StormBreaker hits at all
  it('c06: the corvettes stay slow enough for the recommended JDAM load (≤ 1 m/s)', () => {
    const def = missionById('c06')!;
    expect(LOADOUTS[def.recommendedLoadout].stores.every((s) => s.weapon !== 'gbu53')).toBe(true);
    const fleet = def.script.ground.filter((g) => g.group === 'fleet');
    expect(fleet.length).toBe(2);
    for (const cv of fleet) expect(cv.speed ?? 0, cv.id).toBeLessThanOrEqual(1);
  });

  // the bot used to keep one bomb in flight at a time (each glides 110–160 s): 12 of 36 runs of the
  // repro sweep took over 600 s, every c04 and c06 one (c04 657–668 s, c06 619–686 s)
  for (const id of ['c04', 'c06']) {
    it(`${id} with strike_sdb2 is won in under 600 s on Pilot (the bot ripples its bombs)`, { timeout: 300_000 }, async () => {
      for (const seed of [0, 1]) {
        // yield between runs: a worker blocked for long stretches can trip vitest's RPC timeout
        await new Promise((r) => setTimeout(r, 0));
        const r = runPlaythrough(id, 'pilot', seed, terrainFor(id), { maxT: 900, loadout: 'strike_sdb2' });
        const line = `${id} pilot seed ${seed}: ${r.state}@${Math.round(r.t)}s ${r.reason ?? ''}`;
        expect(r.state, line).toBe('success');
        expect(r.t, line).toBeLessThan(600);
      }
    });
  }
});

describe('i2: campaign content has no Pilot walls (static)', () => {
  it('c04: the SA-15 point defence only appears from Veteran up', () => {
    const sa15 = missionById('c04')!.script.sams.find((s) => s.type === 'sa15')!;
    expect(difficultyAtLeast('pilot', sa15.minDifficulty)).toBe(false);
    expect(difficultyAtLeast('veteran', sa15.minDifficulty)).toBe(true);
  });
  it('Instant Action strike: the SA-15 Tor only appears from Veteran up, as in c04 (playtest 2026-10-02, 1.1-b)', () => {
    for (const theater of ['auckland'] as const) {
      const def = buildInstantMissionSeeded({ mode: 'strike', theater, timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 4 }, 1);
      const sa15 = def.script.sams.find((s) => s.type === 'sa15')!;
      expect(difficultyAtLeast('pilot', sa15.minDifficulty)).toBe(false);
      expect(difficultyAtLeast('veteran', sa15.minDifficulty)).toBe(true);
    }
  });
  it('c12: the Motutapu SA-15 is Pilot+, so the Recruit finale is forgiving (playtest 2026-10-02, 3.2-b: Recruit 4/8 → 7/8)', () => {
    const sa15 = missionById('c12')!.script.sams.find((s) => s.id === 'sa15')!;
    expect(difficultyAtLeast('recruit', sa15.minDifficulty)).toBe(false);
    expect(difficultyAtLeast('pilot', sa15.minDifficulty)).toBe(true);
  });
  it('c10: the Flanker sweep is Veteran+ and the eastern raid leaves time for the northern one', () => {
    const def = missionById('c10')!;
    const sweep = def.script.groups.find((g) => g.id === 'sweep')!;
    expect(sweep.minDifficulty).toBe('veteran');
    const raidE = def.script.groups.find((g) => g.id === 'raidE')!;
    expect(raidE.spawn).toMatchObject({ kind: 'time' });
    expect((raidE.spawn as { t: number }).t).toBeGreaterThanOrEqual(150);
  });
  it('c07: the Su-35 CAP starts beyond first-shot range of the player start (> 40 km)', () => {
    const def = missionById('c07')!;
    const cap = def.script.groups.find((g) => g.id === 'cap')!;
    expect(Math.hypot(cap.x - def.player.x, cap.z - def.player.z)).toBeGreaterThan(40_000);
  });
});

describe('i2: MissionBot playthroughs (real World / Combat / AI, 3 seeds)', () => {
  it('c04 Broken Wing is winnable on Pilot (≥ 2/3; was 0/2)', { timeout: 300_000 }, () => {
    const r = wins('c04', 'pilot', [1, 2, 3]);
    expect(r.won, r.log.join('\n')).toBeGreaterThanOrEqual(2);
  });
  it('c10 Night Harbour is winnable on Pilot (≥ 2/3; was 0/2) and on Recruit', { timeout: 300_000 }, () => {
    const p = wins('c10', 'pilot', [1, 2, 3]);
    expect(p.won, p.log.join('\n')).toBeGreaterThanOrEqual(2);
    const rc = wins('c10', 'recruit', [1, 2]);
    expect(rc.won, rc.log.join('\n')).toBeGreaterThanOrEqual(1);
  });
  it('c07 on Veteran: no scripted R-77 ambush in the first 80 s (was dead at 51–58 s in every run)', { timeout: 300_000 }, () => {
    for (const seed of [1, 2, 3]) {
      const r = runPlaythrough('c07', 'veteran', seed, terrainFor('c07'), { maxT: 80 });
      expect(r.state === 'failed' && r.t < 80, `seed ${seed}: ${r.state}@${Math.round(r.t)}s ${r.reason ?? ''}`).toBe(false);
    }
  });
});

/**
 * A player parked far from the fight with no shot fired (the playtest's exploit charter): real AI and
 * combat on the real terrain, seeded like runPlaythrough, the player pinned at (-35, 13, 35) km and kept
 * fuelled and unhurt, so only the friendlies and the enemy act.
 */
function parkedRun(id: string, diff: Difficulty, seed: number, maxT: number) {
  const def = missionById(id)!;
  const events = new EventBus();
  const d = DIFFICULTIES[diff];
  const world = createSimWorld({ terrain: terrainFor(id), difficulty: d, events, combat: createCombatSystemSeeded(seed) });
  const runner = createMissionRunner({ ...def, seed: def.seed + seed * 101 }, { createAi: createAiBrain, difficulty: d, events });
  runner.setup(world, def.recommendedLoadout);
  const p = world.player!;
  const fuel = p.flight.fuel;
  const completed = new Map<string, number>();
  events.on('objective', (e) => {
    if (e.state === 'complete' && !completed.has(e.id)) completed.set(e.id, world.time);
  });
  for (let i = 0; i < maxT * 60 && runner.state === 'running'; i++) {
    p.position.set(-35000, 13000, 35000);
    p.health = p.maxHealth;
    p.flight.fuel = fuel;
    world.step(1 / 60);
    runner.update(world, 1 / 60);
  }
  const result = runner.state !== 'running' ? runner.result(world) : null;
  return { state: runner.state, t: world.time, alive: p.alive, shots: p.shotsFired, reason: result?.reason ?? '', completed, objectives: runner.objectives };
}

describe('issue #57: Recruit and Pilot bands (MissionBot, 6 seeds, as the sweep)', () => {
  // the sweep: npx vite-node tools/playtest/bot-sweep.ts -- --missions=c02,c09,t03 --diffs=recruit,pilot --seeds=6
  // (was c02 4/6, c09 4/6, t03 2/6 on Pilot; Recruit 6/6 each)
  for (const id of ['c02']) {
    it(`${id} is won on Recruit and on Pilot in ≥ 5 of 6 seeds`, { timeout: 300_000 }, () => {
      for (const diff of ['recruit', 'pilot'] as const) {
        const r = wins(id, diff, [0, 1, 2, 3, 4, 5]);
        expect(r.won, r.log.join('\n')).toBeGreaterThanOrEqual(5);
      }
    });
  }
});

describe('issue #57: c02 Shepherd — Kiwi has to be protected for real', () => {
  it('Kiwi is safe only when it is home AND the fighters chasing it are dealt with', () => {
    const def = missionById('c02')!;
    for (const id of ['o_kiwi', 'o_both']) {
      const o = def.script.objectives.find((x) => x.id === id)!;
      expect(o.kind).toBe('protect');
      const until = o.kind === 'protect' ? o.until : undefined;
      expect(until?.kind, id).toBe('all');
      expect(until?.kind === 'all' ? until.of : [], id).toContainEqual({ kind: 'objective', id: 'o_bandits', state: 'complete' });
    }
    expect(def.recommendedLoadout).toBe('a2a_beast');
  });

  it('parked 50 km away: the protect is never credited, and the mission ends when Kiwi is shot down (round 2, 2.3-c)', { timeout: 120_000 }, () => {
    for (const diff of ['recruit', 'pilot'] as const) {
      const r = parkedRun('c02', diff, 1, 3000);
      const msg = `${diff}: ${r.state}@${Math.round(r.t)}s ${r.reason} ${r.objectives.map((o) => `${o.id}=${o.state}`).join(' ')}`;
      expect(r.shots, msg).toBe(0);
      expect(r.completed.has('o_kiwi'), msg).toBe(false);
      expect(r.state, msg).toBe('failed');
      expect(r.alive, msg).toBe(true);
      expect(r.objectives.find((o) => o.id === 'o_kiwi')?.state, msg).toBe('failed');
      expect(r.t, msg).toBeLessThan(3000);
    }
  });
});
