/**
 * MISSIONS — difficulty bands measured with the project's MissionBot (reviewer sweeps):
 *  - i2 / #57: no Pilot walls; the Pilot band (≥ 75 % over 6 seeds) in t06;
 *  - #65: the bot ripples its StormBreakers instead of waiting out each one's long glide;
 *  - #58: a difficulty curve that only falls, in every campaign mission;
 *  - the IRGC missions' own bands (g01, g02, and g03 on its route probes).
 * Full sweep: npx vite-node tools/playtest/bot-sweep.ts -- --missions=<ids> --diffs=<difficulties>.
 */
import { describe, expect, it } from 'vitest';
import { CAMPAIGNS, buildInstantMissionSeeded, missionById, terrainPadsFor } from '../src/missions';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { difficultyAtLeast } from '../src/missions/runtime/state';
import type { Difficulty } from '../src/core/types';
import type { TerrainQuery } from '../src/sim/api';
import { runPlaythrough } from './missions-bot';
import { G02_MISSILE_WAVE_AT } from '../src/missions/content/irgcHauraki';
import type { ProbeSpec } from './missions-probes';

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

describe('#65: the bot ripples its StormBreakers (playtest 2026-10-02, 2.2-h)', () => {
  // the bot used to keep one bomb in flight at a time (each glides 110–160 s): 12 of 36 runs of the
  // repro sweep took over 600 s (every Southern Cross c04 and c06 one). Now its releases come close
  // together: the second StormBreaker leaves long before the first one lands.
  for (const id of ['t06', 'ia_strike_auckland']) {
    it(`${id} with sead_stealth (4 StormBreakers) is won in under 600 s on Pilot (the bot ripples its bombs)`, { timeout: 300_000 }, async () => {
      for (const seed of [0, 1]) {
        // yield between runs: a worker blocked for long stretches can trip vitest's RPC timeout
        await new Promise((r) => setTimeout(r, 0));
        const r = runPlaythrough(id, 'pilot', seed, terrainFor(id), { maxT: 900, loadout: 'sead_stealth' });
        const line = `${id} pilot seed ${seed}: ${r.state}@${Math.round(r.t)}s ${r.reason ?? ''}`;
        expect(r.state, line).toBe('success');
        expect(r.t, line).toBeLessThan(600);
        const drops = r.launches.filter((l) => l.weapon === 'gbu53').map((l) => l.t);
        expect(drops.length, line).toBeGreaterThanOrEqual(2);
        expect(drops[1] - drops[0], `${line} releases at ${drops.map((t) => Math.round(t)).join(', ')} s`).toBeLessThan(60);
      }
    });
  }
});

describe('i2: campaign content has no Pilot walls (static)', () => {
  it('Instant Action strike: the SA-15 Tor only appears from Veteran up (playtest 2026-10-02, 1.1-b)', () => {
    for (const theater of ['auckland'] as const) {
      const def = buildInstantMissionSeeded({ mode: 'strike', theater, timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 4 }, 1);
      const sa15 = def.script.sams.find((s) => s.type === 'sa15')!;
      expect(difficultyAtLeast('pilot', sa15.minDifficulty)).toBe(false);
      expect(difficultyAtLeast('veteran', sa15.minDifficulty)).toBe(true);
    }
  });
});

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

describe('issue #57: Recruit and Pilot bands (MissionBot, 6 seeds, as the sweep)', () => {
  // the sweep: npx vite-node tools/playtest/bot-sweep.ts -- --missions=t06 --diffs=recruit,pilot --seeds=6
  // (t06 was 2/6 on Pilot; Recruit 6/6)
  for (const id of ['t06']) {
    for (const diff of ['recruit', 'pilot'] as const) {
      it(`${id} is won on ${diff} in ≥ 5 of 6 seeds`, { timeout: 300_000 }, async () => {
        const r = await winsYielding(id, diff, [0, 1, 2, 3, 4, 5]);
        expect(r.won, r.log.join('\n')).toBeGreaterThanOrEqual(5);
      });
    }
  }
});

describe('issue #57: t06 Live SAMs — the route keeps the SA-6 off the player', () => {
  it('every steering point before the target stays ≥ 14 km from the SA-6, the IP behind Rangitoto from it', () => {
    const def = missionById('t06')!;
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
 * #58 (Balance 5/9): the win rate never rises from Pilot to Veteran in every
 * campaign mission. Seeds 0–5 are the ones `tools/playtest/bot-sweep.ts -- --seeds=6` flies, so a
 * failure here reproduces with
 *   npx vite-node tools/playtest/bot-sweep.ts -- --missions=<id> --diffs=pilot,veteran --seeds=6 --log --json=<file>
 * (g02 checks its own curve, with its bands, below.)
 */
describe('#58: a difficulty curve that only falls (6 seeds)', () => {
  const SEEDS = [0, 1, 2, 3, 4, 5];
  const DIFFS = ['pilot', 'veteran'] as const;
  type Curve = { won: Record<(typeof DIFFS)[number], number>; table: string };
  async function curve(id: string): Promise<Curve> {
    const won = { pilot: 0, veteran: 0 };
    const log: string[] = [];
    for (const d of DIFFS) {
      for (const seed of SEEDS) {
        const r = wins(id, d, [seed]);
        won[d] += r.won;
        log.push(...r.log);
        await breathe(); // yield: vitest's worker RPC times out on long blocks
      }
    }
    return { won, table: `${id}: pilot ${won.pilot}/6, veteran ${won.veteran}/6\n${log.join('\n')}` };
  }

  // g02 and g03 check their own curves below (g03's on its best route probe)
  for (const id of CAMPAIGNS.flatMap((c) => c.missions.map((m) => m.id)).filter((id) => id !== 'g02' && id !== 'g03')) {
    it(`${id}: the win rate doesn't rise from Pilot to Veteran`, { timeout: 600_000 }, async () => {
      const c = await curve(id);
      expect(c.won.veteran, `Veteran beats Pilot\n${c.table}`).toBeLessThanOrEqual(c.won.pilot);
    });
  }
});

describe('g01 Buzz Kill: the bot finishes the swarm with the gun (playtest 2026-10-02)', () => {
  // missiles take 7–8 of the 10 Shaheds; the rest need gun passes. The bot's 170 m/s gun chase
  // overshot a 51 m/s drone on every pass and it was 0/6 on every difficulty. With the slow-target
  // chase (ai-playerbot.ts gunChaseFloor) it measured, 6 seeds with jitter: Recruit 3/6, Pilot 6/6
  // (no jitter: 2/6, 5/6). Recruit then flew nine drones (G01_SWARM.recruitCount): 5/6, Pilot 6/6,
  // Veteran 6/6 (the sweep, 6 seeds). The bands below are the measured floors less one seed.
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

describe('g02 Straight Outta Hauraki: no longer a walkover (#115), and two ways to win (playtest r1)', () => {
  // The bot won 24/24 by rippling all eight StormBreakers in the first 20–39 s, before any missile boat counted
  // down. Now the missile boats come in at G02_MISSILE_WAVE_AT, so that takes a second pass against a ~3.9-minute
  // launch, and Recruit flies a suicide boat fewer. Pilot and Veteran also meet the AD boats' harassment
  // (DifficultyParams.adBoatHarass): the bay opening for a stand-off release draws SAM shots, the bot breaks to
  // defend and reaches the second wave late; Veteran adds a third boat ahead of the suicide wave, inside the real
  // envelope of the opening release. With Pilot's salvo grace (a pair is one hit) and the bot turning in on a
  // boat whose IP it is already inside (playtest r1, 1.3-d), 6 seeds: Recruit 6/6, Pilot 6/6, Veteran 3/6. The
  // bands are the measured floors less one seed, and the campaign's: Recruit ≥ 75 %, Veteran ≥ 25 %.
  const run = (d: Difficulty, seed: number, opts: Parameters<typeof runPlaythrough>[4] = {}) => runPlaythrough('g02', d, seed, terrainFor('g02'), { maxT: 600, ...opts });

  it('Recruit ≥ 5/6, Pilot ≥ 5/6, Veteran ≥ 2/6, never rising with difficulty; no bomb on a missile boat before it is in the water', { timeout: 600_000 }, async () => {
    const seeds = [0, 1, 2, 3, 4, 5];
    const diffs: Difficulty[] = ['recruit', 'pilot', 'veteran'];
    const won: Record<string, number> = {};
    const log: string[] = [];
    for (const d of diffs) {
      won[d] = 0;
      for (const seed of seeds) {
        await new Promise((r) => setTimeout(r, 0)); // yield: vitest's worker RPC times out on long blocks
        const r = run(d, seed);
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
    expect(won.pilot, table).toBeLessThanOrEqual(won.recruit);
    expect(won.veteran, table).toBeLessThanOrEqual(won.pilot);
  });

  // The casual player's proxy (bot-sweep --reaction=2.5: 2.5 s to react to any missile warning) lost all
  // 6 Pilot runs: Pilot's harassing pair beamed it south, away from the missile boats, and it flew on out to
  // its IP 28 km from them before turning in, so its second ripple went at 165 s from 18 km and the boats
  // launched first. Turning in from inside the IP: 6/6, the boats sunk ~35 s before their countdown.
  it('the casual proxy (2.5 s reactions) wins Pilot ≥ 3/6 (was 0/6)', { timeout: 300_000 }, async () => {
    const log: string[] = [];
    let won = 0;
    for (const seed of [0, 1, 2, 3, 4, 5]) {
      await new Promise((r) => setTimeout(r, 0));
      const r = run('pilot', seed, { bot: { reaction: 2.5, samReaction: 2.5 } });
      if (r.state === 'success') won++;
      log.push(`casual pilot seed ${seed}: ${r.state}@${r.t}s ${r.reason}`);
    }
    expect(won, log.join('\n')).toBeGreaterThanOrEqual(3);
  });

  // The second way (1.3-f): the briefing's AARGM-ER at the first escort as the opening shot
  // (ROUTE_PROBES.g02.sead), then the StormBreaker ripples. It sinks her in about half the runs (a crew
  // that sees it coming goes off the air) and Pilot's runs draw 2–8 SAM rounds instead of 10. Measured
  // Recruit 6/6, Pilot 6/6 (casual proxy 6/6), Veteran 0/6 (its third boat's long shots at the open bay
  // cost the opening ripple). The first way, bombs only with the AARGMs never fired, is the test above.
  it('the escort first, with an AARGM: Pilot ≥ 4/6, the AARGM on an escort', { timeout: 300_000 }, async () => {
    const log: string[] = [];
    let won = 0;
    for (const seed of [0, 1, 2, 3, 4, 5]) {
      await new Promise((r) => setTimeout(r, 0));
      const r = run('pilot', seed, { probe: { kind: 'route', route: 'sead' } as ProbeSpec });
      if (r.state === 'success') won++;
      const arm = r.launches.find((l) => l.weapon === 'aargm');
      log.push(`sead pilot seed ${seed}: ${r.state}@${r.t}s ${r.reason}, AARGM ${arm ? `at ${Math.round(arm.t)} s on ${arm.group}` : 'not fired'}`);
      expect(arm?.group, log.join('\n')).toBe('ad_boats');
    }
    expect(won, log.join('\n')).toBeGreaterThanOrEqual(4);
  });
});

describe('g03 Stoat of Emergency: several ways in (#198, #200; playtest 2026-10-10, r1)', () => {
  // The route probes (tests/missions-probes.ts ROUTE_PROBES.g03) fly the ways a player could try, then the bot
  // attacks at one of the stoat's stops (#200: a running stoat can't be bombed). Casual players (the owner's ask,
  // r1) get several ways in, each about as hard as g01: on Recruit and Pilot the Tor and the airstrip SA-6 are
  // Veteran's (minDifficulty), the boats fire no harassing long shots, the northern boats sail clear of the
  // straight line, and the stops fall later and last 60 s on a 5:20 clock. Measured, 6 seeds, Recruit / Pilot /
  // Veteran (casual proxy --reaction=2.5 on Pilot): golden (low down the strait, AARGMs at the strait's boat and,
  // on Veteran, the airstrip SA-6) 6 / 5 / 4 (2); golden_north (round the north, AARGMs at the northern boats)
  // 6 / 6 / 0 (5; Pilot 10/12 over 12 seeds); south (low down the strait, no AARGM) 6 / 6 / 0 (5; 11/12); sead
  // (low, an AARGM at the Motuihe SA-6, then straight in) 5 / 4 / 0 (4); the plain bot (straight in on the steering
  // cue) 6 / 3 / 0 (3); north (low, no AARGM) 6 / 0 / 0; high 6 / 1 / 0; killall 0 / 0 / 0. Before (4:00 clock, 40 s
  // stops, every site on every difficulty, boats harassing): golden 5 / 3 / 0 (0), golden_north 3 / 1 / 0, south
  // 2 / 0 / 0, the plain bot 0 / 0 / 0. Bands over 4–6 seeds are the measured floors less one seed.
  const run = (route: string, diff: Difficulty, seed: number) =>
    runPlaythrough('g03', diff, seed, terrainFor('g03'), { maxT: 400, probe: { kind: 'route', route } as ProbeSpec });

  it('at least three ways win on Pilot: the strait (golden, south) and round the north', { timeout: 900_000 }, async () => {
    const log: string[] = [];
    const won: Record<string, number> = {};
    for (const route of ['golden', 'south', 'golden_north']) {
      won[route] = 0;
      for (const seed of [0, 1, 2, 3]) {
        await new Promise((r) => setTimeout(r, 0)); // yield: vitest's worker RPC times out on long blocks
        const r = run(route, 'pilot', seed);
        if (r.state === 'success') won[route]++;
        log.push(`${route} seed ${seed}: ${r.state}@${r.t}s ${r.reason}`);
      }
    }
    // measured on these seeds: golden 3/4, south 4/4, golden_north 4/4
    const floor: Record<string, number> = { golden: 2, south: 3, golden_north: 3 };
    for (const route of Object.keys(won)) expect(won[route], `${route}\n${log.join('\n')}`).toBeGreaterThanOrEqual(floor[route]);
  });

  it('the best way on Veteran: wins some (≥ 2/6), never more than on Pilot', { timeout: 900_000 }, async () => {
    const won: Record<string, number> = {};
    const log: string[] = [];
    for (const d of ['pilot', 'veteran'] as const) {
      won[d] = 0;
      for (const seed of [0, 1, 2, 3, 4, 5]) {
        await new Promise((r) => setTimeout(r, 0));
        const r = run('golden', d, seed);
        if (r.state === 'success') won[d]++;
        log.push(`golden ${d} seed ${seed}: ${r.state}@${r.t}s ${r.reason}`);
      }
    }
    const table = log.join('\n');
    expect(won.veteran, table).toBeGreaterThanOrEqual(2);
    expect(won.veteran, table).toBeLessThanOrEqual(won.pilot);
  });

  it('not a walkover: straight over the top of every SAM (high) still fails on Pilot', { timeout: 600_000 }, async () => {
    // above the cloud nothing is revealed; diving through it from 43,000 ft at the end meets every site at once
    const log: string[] = [];
    let won = 0;
    for (const seed of [0, 1, 2, 3]) {
      await new Promise((r) => setTimeout(r, 0));
      const r = run('high', 'pilot', seed);
      if (r.state === 'success') won++;
      log.push(`high seed ${seed}: ${r.state}@${r.t}s ${r.reason}`);
    }
    expect(won, log.join('\n')).toBeLessThanOrEqual(1);
  });
});
