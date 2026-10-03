/**
 * MISSIONS i2 — campaign difficulty walls (reviewer sweep with the project's MissionBot):
 *  - c04 'Broken Wing' was 0/2 on Pilot (SA-6 / SA-15 point defence shooting down the JDAMs);
 *  - c10 'Night Harbour' was 0/2 on Pilot (Su-27 sweep R-27s at 137/159 s) and failed on Recruit;
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
import { hangarLoadouts } from '../src/ui/hangar';
import { C08_ACE_SCRAMBLE_T } from '../src/missions/content/campaign2';
import { scaledCount } from '../src/missions/runtime/spawner';
import { SAM_DATA } from '../src/sim/sam/samData';
import type { Difficulty } from '../src/core/types';
import { LOADOUTS } from '../src/core/data';
import type { TerrainQuery } from '../src/sim/api';
import { runPlaythrough } from './missions-bot';
import { G02_MISSILE_WAVE_AT } from '../src/missions/content/irgcHauraki';

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
  // #114 (playtest 2026-10-02 bc94edd, 1.3-d): even with the warning, the StormBreaker load lost the
  // low strike under the SA-10 (bot, 6 seeds: Recruit 6/6, Pilot 2/6, Veteran 0/6), so c08 no longer
  // offers it, and neither the briefing nor the hangar suggests it
  it('c08 does not offer strike_sdb2 (no answer to the SA-10; Pilot 2/6, Veteran 0/6 with it)', () => {
    const def = missionById('c08')!;
    expect(LOADOUTS.strike_sdb2.stores.some((s) => s.weapon === 'aargm')).toBe(false);
    expect(def.allowedLoadouts).not.toContain('strike_sdb2');
    expect(def.recommendedLoadout).not.toBe('strike_sdb2');
    expect(hangarLoadouts(def).cards).not.toContain('strike_sdb2');
    expect(def.briefing.join(' ')).not.toMatch(/StormBreaker|GBU-53/i);
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
  it('c10: the Flanker sweep is Veteran+ and the eastern raid leaves time for the northern one', () => {
    const def = missionById('c10')!;
    const sweep = def.script.groups.find((g) => g.id === 'sweep')!;
    expect(sweep.minDifficulty).toBe('veteran');
    const raidE = def.script.groups.find((g) => g.id === 'raidE')!;
    expect(raidE.spawn).toMatchObject({ kind: 'time' });
    expect((raidE.spawn as { t: number }).t).toBeGreaterThanOrEqual(150);
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
});

/** Where the playtest's exploit charter parks the player: 35 km south-west of the city, 13 km up. */
const FAR = { x: -35000, y: 13000, z: 35000 };

/**
 * A player parked with no shot fired (the playtest's exploit charter): real AI and combat on the real
 * terrain, seeded like runPlaythrough, the player pinned at `at` (default FAR) and kept fuelled and
 * unhurt, so only the friendlies and the enemy act.
 */
function parkedRun(id: string, diff: Difficulty, seed: number, maxT: number, at: { x: number; y: number; z: number } = FAR) {
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
    p.position.set(at.x, at.y, at.z);
    p.health = p.maxHealth;
    p.flight.fuel = fuel;
    world.step(1 / 60);
    runner.update(world, 1 / 60);
  }
  const result = runner.state !== 'running' ? runner.result(world) : null;
  return { state: runner.state, t: world.time, alive: p.alive, shots: p.shotsFired, reason: result?.reason ?? '', completed, objectives: runner.objectives };
}

/** Let vitest's worker answer its RPC between long synchronous playthroughs (as missions-bot.test.ts does). */
const breathe = () => new Promise((r) => setTimeout(r, 0));

/** wins(), yielding between playthroughs. */
async function winsYielding(id: string, diff: Difficulty, seeds: number[]): Promise<{ won: number; log: string[] }> {
  const log: string[] = [];
  let won = 0;
  for (const seed of seeds) {
    await breathe();
    const r = wins(id, diff, [seed]);
    won += r.won;
    log.push(...r.log);
  }
  return { won, log };
}

/** Seconds from an objective completing to the end of the mission, in a logged bot playthrough (null: never completed). */
function afterObjective(r: { events: string[]; t: number }, id: string): number | null {
  const line = r.events.find((e) => e.endsWith(`OBJ ${id} complete`));
  return line ? r.t - Number(line.trim().split(' ')[0]) : null;
}

describe('issue #57: Recruit and Pilot bands (MissionBot, 6 seeds, as the sweep)', () => {
  // the sweep: npx vite-node tools/playtest/bot-sweep.ts -- --missions=c02,c09,t03 --diffs=recruit,pilot --seeds=6
  // (was c02 4/6, c09 4/6, t03 2/6 on Pilot; Recruit 6/6 each)
  for (const id of ['c02', 'c09', 't03']) {
    for (const diff of ['recruit', 'pilot'] as const) {
      it(`${id} is won on ${diff} in ≥ 5 of 6 seeds`, { timeout: 300_000 }, async () => {
        const r = await winsYielding(id, diff, [0, 1, 2, 3, 4, 5]);
        expect(r.won, r.log.join('\n')).toBeGreaterThanOrEqual(5);
      });
    }
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
    // ...with the player there to see Kiwi home (the start is near Whenuapai, the charter's parking spot is not)
    const until = def.script.objectives.find((x) => x.id === 'o_kiwi')!;
    const area = until.kind === 'protect' && until.until?.kind === 'all' ? until.until.of.find((c) => c.kind === 'area' && !c.who) : undefined;
    expect(area?.kind).toBe('area');
    if (area?.kind === 'area') expect(Math.hypot(FAR.x - area.x, FAR.z - area.z)).toBeGreaterThan(area.radius + 10_000);
    // and the mission can't run on forever: Kiwi is bingo at 720 s
    const bingo = def.script.triggers.find((t) => t.id === 't_kiwi_bingo')!;
    expect(bingo.actions).toContainEqual({ kind: 'end', success: false, reason: 'Kiwi flight ran out of fuel' });
  });

  it('a Kiwi jet shot down: the chasers are pointed at the survivor (attack_group resolves to one jet)', () => {
    const hit = missionById('c02')!.script.triggers.find((t) => t.id === 't_kiwi_hit')!;
    for (const group of ['hunters', 'flankers']) expect(hit.actions, group).toContainEqual({ kind: 'retask', group, task: { kind: 'attack_group', group: 'kiwi' } });
  });

  // seeds 0-5 (review: seeds 0, 1, 3 and 4 used to run past 3000 s once one Kiwi jet was down)
  for (const diff of ['recruit', 'pilot'] as const) {
    it(`parked 50 km away on ${diff}: the protect is never credited, and the mission ends in failure (round 2, 2.3-c)`, { timeout: 300_000 }, async () => {
      for (const seed of [0, 1, 2, 3, 4, 5]) {
        await breathe();
        const r = parkedRun('c02', diff, seed, 900);
        const msg = `${diff} seed ${seed}: ${r.state}@${Math.round(r.t)}s ${r.reason} ${r.objectives.map((o) => `${o.id}=${o.state}`).join(' ')}`;
        expect(r.shots, msg).toBe(0);
        expect(r.completed.has('o_kiwi'), msg).toBe(false);
        expect(r.state, msg).toBe('failed');
        expect(r.alive, msg).toBe(true);
        // shot down, or (the chase never settled) Kiwi's bingo at 720 s: never an endless run
        expect(r.t, msg).toBeLessThanOrEqual(721);
      }
    });
  }
});

describe('c02 Shepherd: Viper 2 holds fire until the player engages (playtest 2026-10-02 bc94edd, 1.3-b)', () => {
  // parked over the player's own start with no shot fired, Viper 2 used to kill all four bandits:
  // Recruit 3/3 and Pilot 1/3 wins, grade C, 0 shots (the far park above already failed)
  it('parked at the start with no shot fired: no win on Recruit', { timeout: 300_000 }, async () => {
    for (const seed of [0, 1, 2]) {
      await breathe();
      const r = parkedRun('c02', 'recruit', seed, 900, { x: -6000, y: 4500, z: -14000 });
      const msg = `seed ${seed}: ${r.state}@${Math.round(r.t)}s ${r.reason} ${r.objectives.map((o) => `${o.id}=${o.state}`).join(' ')}`;
      expect(r.shots, msg).toBe(0);
      expect(r.state, msg).not.toBe('success');
    }
  });
});

describe('issue #57: c09 Hammer Down — needs its escort, and ends once Hammer is clear', () => {
  // parked with no shot fired: far away (the charter's spot), at the player's own start (17 km from the
  // push point) and 35 km west of the strip (19 km from it). Review: a 25 km escort circle held the start.
  const spots: [string, { x: number; y: number; z: number }, number[]][] = [
    ['50 km away', FAR, [1]],
    ['at the start', { x: -6000, y: 6500, z: -5000 }, [0, 1, 2]],
    ['35 km west of the strip', { x: -8100, y: 6000, z: -6600 }, [0]],
  ];
  for (const [where, at, seeds] of spots) {
    it(`parked ${where} with no shot fired: no win (round 3, 3.2-a: Weasel and Hammer won it alone)`, { timeout: 300_000 }, async () => {
      for (const diff of ['recruit', 'pilot'] as const) {
        for (const seed of seeds) {
          await breathe();
          const r = parkedRun('c09', diff, seed, 900, at);
          const msg = `${diff} seed ${seed}: ${r.state}@${Math.round(r.t)}s ${r.reason} ${r.objectives.map((o) => `${o.id}=${o.state}`).join(' ')}`;
          expect(r.shots, msg).toBe(0);
          expect(r.state, msg).toBe('failed');
          expect(r.alive, msg).toBe(true);
          expect(r.reason, msg).toMatch(/without its escort/);
        }
      }
    });
  }

  it('the start is outside the escort circle, and Hammer only counts as out once it has pushed', () => {
    const def = missionById('c09')!;
    const push = def.script.triggers.find((t) => t.id === 't_push')!;
    const escort = push.when.kind === 'all' ? push.when.of.find((c) => c.kind === 'area') : undefined;
    expect(escort?.kind).toBe('area');
    if (escort?.kind !== 'area') return;
    expect(Math.hypot(def.player.x - escort.x, def.player.z - escort.z)).toBeGreaterThan(escort.radius + 5000);
    // the steering cue leads to it
    expect(def.script.waypoints.some((w) => w.id === 'wp_push' && Math.hypot(w.x - escort.x, w.z - escort.z) < 1)).toBe(true);
    // a depot the player bombs before Hammer launches doesn't complete o_hammer / o_all4 (vacuous "clear")
    for (const id of ['o_hammer', 'o_all4']) {
      const o = def.script.objectives.find((x) => x.id === id)!;
      const until = o.kind === 'protect' ? o.until : undefined;
      expect(until?.kind === 'all' ? until.of : [], id).toContainEqual({ kind: 'trigger', id: 't_push' });
    }
  });

  it('no dead stretch after the strike: the mission ends ≤ 75 s after o_strike completes (was 240 s, a crash nursing a damaged jet home)', { timeout: 300_000 }, async () => {
    // the first three Pilot wins among seeds 1-5 (seed 0 is the band's loss)
    let checked = 0;
    const log: string[] = [];
    for (const seed of [1, 2, 3, 4, 5]) {
      if (checked >= 3) break;
      await breathe();
      const r = runPlaythrough('c09', 'pilot', seed, terrainFor('c09'), { maxT: 900, log: true });
      const msg = `seed ${seed}: ${r.state}@${Math.round(r.t)}s ${r.reason} ${r.objectives}`;
      log.push(msg);
      if (r.state !== 'success') continue;
      checked++;
      const gap = afterObjective(r, 'o_strike');
      expect(gap, msg).not.toBeNull();
      expect(gap!, msg).toBeLessThanOrEqual(75);
    }
    expect(checked, log.join('\n')).toBe(3);
  });
});

describe('issue #57: t03 SAMs & Strike — the route keeps the SA-6 off the player', () => {
  it('every steering point before the target stays ≥ 14 km from the SA-6, the IP behind Rangitoto from it', () => {
    const def = missionById('t03')!;
    const sa6 = def.script.sams.find((s) => s.type === 'sa6')!;
    const route = def.script.waypoints.filter((w) => w.kind === 'nav' || w.kind === 'ip');
    expect(route.length).toBeGreaterThan(0);
    const pts = [{ x: def.player.x, z: def.player.z }, ...route];
    for (const w of route) expect(Math.hypot(w.x - sa6.x, w.z - sa6.z), (w as { id: string }).id).toBeGreaterThanOrEqual(14_000);
    // every leg (start → … → IP) passes ≥ 14 km from the SA-6
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const t = Math.max(0, Math.min(1, ((sa6.x - a.x) * dx + (sa6.z - a.z) * dz) / (dx * dx + dz * dz)));
      expect(Math.hypot(a.x + dx * t - sa6.x, a.z + dz * t - sa6.z), `leg ${i}`).toBeGreaterThanOrEqual(14_000);
    }
    // the IP and the depot are on the far side of Rangitoto from the SA-6
    const ip = route.find((w) => w.kind === 'ip')!;
    const rangi = { x: 8700, z: -6850 };
    const along = (q: { x: number; z: number }) => ((q.x - sa6.x) * (rangi.x - sa6.x) + (q.z - sa6.z) * (rangi.z - sa6.z)) / Math.hypot(rangi.x - sa6.x, rangi.z - sa6.z);
    const rangiD = Math.hypot(rangi.x - sa6.x, rangi.z - sa6.z);
    expect(along(ip)).toBeGreaterThan(rangiD);
    for (const g of def.script.ground.filter((x) => x.group === 'depot')) expect(along(g), g.id).toBeGreaterThan(rangiD);
  });
});

/**
 * #58 (Balance 5/9): c04 and c10 reach the Veteran band (≥ 25 %: at least 2 of 6 seeds; both were 0/6),
 * and the win rate never rises from Pilot to Veteran or from Veteran to Ace. Seeds 0–5 are the ones
 * `tools/playtest/bot-sweep.ts -- --seeds=6` flies, so a failure here reproduces with
 *   npx vite-node tools/playtest/bot-sweep.ts -- --missions=<id> --diffs=pilot,veteran,ace --seeds=6 --log --json=<file>
 * c08 on Ace was 6/6, as easy as Pilot (#58): on Ace a ready MiG pair now launches at 100 s, on the
 * first pass (4/6; Veteran unchanged at 6/6). c02, c06 and c09 already fell (sweep without
 * rearming, 6 seeds, Pilot/Veteran/Ace: c02 6/5/3, c06 6/5/2, c09 5/4/2); their tests are guards.
 * Margins: c04 wins exactly 2/6 on Veteran here (seeds 0 and 3; 4/12 over seeds 0–11), c10 3/6 (6/12).
 * A change to the bot or the AI can flip one seed and fail the c04 gate: rerun the sweep with --seeds=12
 * before retuning. No c04/c10 run was ever rearmed, so removing rearming (#63) left these numbers as
 * they were.
 */
describe('#58: Veteran band in c04 and c10, and a difficulty curve that only falls (6 seeds)', () => {
  const SEEDS = [0, 1, 2, 3, 4, 5];
  const DIFFS = ['pilot', 'veteran', 'ace'] as const;
  type Curve = { won: Record<(typeof DIFFS)[number], number>; table: string };
  async function curve(id: string): Promise<Curve> {
    const won = { pilot: 0, veteran: 0, ace: 0 };
    const log: string[] = [];
    for (const d of DIFFS) {
      for (const seed of SEEDS) {
        const r = wins(id, d, [seed]);
        won[d] += r.won;
        log.push(...r.log);
        await new Promise((res) => setTimeout(res, 0)); // yield: vitest's worker RPC times out on long blocks
      }
    }
    return { won, table: `${id}: pilot ${won.pilot}/6, veteran ${won.veteran}/6, ace ${won.ace}/6\n${log.join('\n')}` };
  }
  function expectFalling(c: Curve): void {
    expect(c.won.veteran, `Veteran beats Pilot\n${c.table}`).toBeLessThanOrEqual(c.won.pilot);
    expect(c.won.ace, `Ace beats Veteran\n${c.table}`).toBeLessThanOrEqual(c.won.veteran);
  }

  it("c04: the Veteran Tor's point defence doesn't cover the parked jets (it shot the two JDAMs down)", () => {
    const def = missionById('c04')!;
    const tor = def.script.sams.find((s) => s.type === 'sa15')!;
    expect(tor.minDifficulty).toBe('veteran');
    const jets = def.script.ground.filter((g) => g.group === 'parked');
    expect(jets.length).toBeGreaterThan(0);
    for (const j of jets) expect(Math.hypot(j.x - tor.x, j.z - tor.z), j.id).toBeGreaterThan(SAM_DATA.sa15.pointDefense!.protect);
  });
  it('c10: the low western raid turns for home once it loses half its bombers, like the other two raids', () => {
    const objs = missionById('c10')!.script.objectives;
    const west = objs.find((o) => o.id === 'o_west')!;
    const north = objs.find((o) => o.id === 'o_north')!;
    expect(west.kind === 'intercept' && north.kind === 'intercept').toBe(true);
    if (west.kind !== 'intercept' || north.kind !== 'intercept') return;
    expect(west.abortFraction).toBe(north.abortFraction);
  });
  for (const id of ['c04', 'c10']) {
    it(`${id} wins at least 2/6 on Veteran (was 0/6), and Pilot ≥ Veteran ≥ Ace`, { timeout: 600_000 }, async () => {
      const c = await curve(id);
      expect(c.won.veteran, c.table).toBeGreaterThanOrEqual(2);
      expectFalling(c);
    });
  }
  for (const id of ['c01', 'c02', 'c03', 'c05', 'c06', 'c09', 'c11']) {
    it(`${id}: the win rate doesn't rise from Pilot to Veteran or from Veteran to Ace`, { timeout: 600_000 }, async () => {
      expectFalling(await curve(id));
    });
  }
  it('c08: Ace is below 90 % (was 6/6, as easy as Pilot), Pilot stays ≥ 75 %, and Pilot ≥ Veteran ≥ Ace', { timeout: 600_000 }, async () => {
    const c = await curve('c08');
    expect(c.won.ace, c.table).toBeLessThanOrEqual(5);
    expect(c.won.pilot, c.table).toBeGreaterThanOrEqual(5);
    expect(c.won.veteran, c.table).toBeGreaterThanOrEqual(2);
    expectFalling(c);
  });
  it('c08: only on Ace does a MiG pair launch on the first pass (the rest of the alert still waits until 300 s)', () => {
    const groups = missionById('c08')!.script.groups;
    const early = groups.find((g) => g.id === 'migs_ace')!;
    expect(early.minDifficulty).toBe('ace');
    expect(early.spawn).toEqual({ kind: 'time', t: C08_ACE_SCRAMBLE_T });
    expect(C08_ACE_SCRAMBLE_T).toBeLessThan(300);
    expect(scaledCount(early, DIFFICULTIES.ace.enemyCountScale)).toBe(2);
    const alert = groups.find((g) => g.id === 'migs')!;
    expect(alert.minDifficulty).toBeUndefined();
    expect(alert.spawn).toMatchObject({ kind: 'any' });
  });
});

describe('g01 Buzz Kill: the bot finishes the swarm with the gun (playtest 2026-10-02)', () => {
  // missiles take 7–8 of the 10 Shaheds; the rest need gun passes. The bot's 170 m/s gun chase
  // overshot a 51 m/s drone on every pass and it was 0/6 on every difficulty. With the slow-target
  // chase (ai-playerbot.ts gunChaseFloor) it measured, 6 seeds with jitter: Recruit 3/6, Pilot 6/6
  // (no jitter: 2/6, 5/6). Recruit then flew nine drones (G01_SWARM.recruitCount): 5/6, Pilot 6/6,
  // Veteran 6/6, Ace 4/6 (the sweep, 6 seeds). The bands below are the measured floors less one seed.
  it('Recruit ≥ 4/6 and Pilot ≥ 5/6 (was 0/6 and 0/6)', { timeout: 300_000 }, async () => {
    const seeds = [0, 1, 2, 3, 4, 5];
    await new Promise((r) => setTimeout(r, 0));
    const rec = wins('g01', 'recruit', seeds);
    await new Promise((r) => setTimeout(r, 0));
    const pil = wins('g01', 'pilot', seeds);
    expect(rec.won, rec.log.join('\n')).toBeGreaterThanOrEqual(4);
    expect(pil.won, pil.log.join('\n')).toBeGreaterThanOrEqual(5);
  });
});

describe('g02 Straight Outta Hauraki: no longer a walkover (#115)', () => {
  // The bot won 24/24 (Ace by rearming) by rippling all eight StormBreakers in the first 20–39 s, before
  // any missile boat counted down. Now the missile boats come in at G02_MISSILE_WAVE_AT, so that takes
  // a second pass against a ~3.9-minute launch, and Recruit flies a suicide boat fewer. Measured with
  // no rearming (#63), 6 seeds: Recruit 6/6, Pilot 6/6, Veteran 6/6, Ace 0/6 (nine boats for eight
  // bombs: Ace needs the gun, which the bot doesn't use on boats). The bands are the measured floors
  // less one seed, and the campaign's: Recruit and Pilot ≥ 75 %, Veteran ≥ 25 %, Ace under 90 %.
  it('Recruit ≥ 5/6, Pilot ≥ 5/6, Veteran ≥ 2/6, Ace ≤ 5/6, never rising with difficulty; no bomb on a missile boat before it is in the water', { timeout: 600_000 }, async () => {
    const seeds = [0, 1, 2, 3, 4, 5];
    const diffs: Difficulty[] = ['recruit', 'pilot', 'veteran', 'ace'];
    const won: Record<string, number> = {};
    const log: string[] = [];
    for (const d of diffs) {
      won[d] = 0;
      for (const seed of seeds) {
        await new Promise((r) => setTimeout(r, 0)); // yield: vitest's worker RPC times out on long blocks
        const r = runPlaythrough('g02', d, seed, terrainFor('g02'), { maxT: 600 });
        if (r.state === 'success') won[d]++;
        log.push(`g02 ${d} seed ${seed}: ${r.state}@${r.t}s ${r.reason}`);
        // the opening ripple can't cover both waves: every bomb on a missile boat goes after they came in
        for (const l of r.launches) if (l.group === 'missile_boats') expect(l.t, `${d} seed ${seed}`).toBeGreaterThan(G02_MISSILE_WAVE_AT);
      }
    }
    const table = `${diffs.map((d) => `${d} ${won[d]}/6`).join(', ')}\n${log.join('\n')}`;
    expect(won.recruit, table).toBeGreaterThanOrEqual(5);
    expect(won.pilot, table).toBeGreaterThanOrEqual(5);
    expect(won.veteran, table).toBeGreaterThanOrEqual(2);
    expect(won.ace, table).toBeLessThanOrEqual(5);
    expect(won.pilot, table).toBeLessThanOrEqual(won.recruit);
    expect(won.veteran, table).toBeLessThanOrEqual(won.pilot);
    expect(won.ace, table).toBeLessThanOrEqual(won.veteran);
  });
});
