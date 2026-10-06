/**
 * MISSIONS — difficulty bands measured with the project's MissionBot (reviewer sweeps):
 *  - i2 / #57: no Pilot walls; the Pilot band (≥ 75 % over 6 seeds) in t03;
 *  - #65: the bot ripples its StormBreakers instead of waiting out each one's long glide;
 *  - #58: a difficulty curve that only falls, in every campaign mission;
 *  - the IRGC missions' own bands (g01, g02).
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
  for (const id of ['t03', 'ia_strike_auckland']) {
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
  // the sweep: npx vite-node tools/playtest/bot-sweep.ts -- --missions=t03 --diffs=recruit,pilot --seeds=6
  // (t03 was 2/6 on Pilot; Recruit 6/6)
  for (const id of ['t03']) {
    for (const diff of ['recruit', 'pilot'] as const) {
      it(`${id} is won on ${diff} in ≥ 5 of 6 seeds`, { timeout: 300_000 }, async () => {
        const r = await winsYielding(id, diff, [0, 1, 2, 3, 4, 5]);
        expect(r.won, r.log.join('\n')).toBeGreaterThanOrEqual(5);
      });
    }
  }
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

  // g02 and g03 check their own curves below (g03's with the route probe: the plain bot flies straight at it)
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

describe('g02 Straight Outta Hauraki: no longer a walkover (#115)', () => {
  // The bot won 24/24 by rippling all eight StormBreakers in the first 20–39 s, before any missile boat counted
  // down. Now the missile boats come in at G02_MISSILE_WAVE_AT, so that takes a second pass against a ~3.9-minute
  // launch, and Recruit flies a suicide boat fewer. Pilot and Veteran also meet the AD boats' harassment
  // (DifficultyParams.adBoatHarass): the bay opening for a stand-off release draws SAM shots, the bot breaks to
  // defend and reaches the second wave late; Veteran adds a third boat ahead of the suicide wave, inside the real
  // envelope of the opening release. Measured with no rearming (#63), 6 seeds: Recruit 6/6, Pilot 4/6, Veteran 3/6
  // (24 seeds: Pilot 18, Veteran 9). The bands are the measured floors less one seed, and the campaign's:
  // Recruit ≥ 75 %, Veteran ≥ 25 %.
  it('Recruit ≥ 5/6, Pilot ≥ 3/6, Veteran ≥ 2/6, never rising with difficulty; no bomb on a missile boat before it is in the water', { timeout: 600_000 }, async () => {
    const seeds = [0, 1, 2, 3, 4, 5];
    const diffs: Difficulty[] = ['recruit', 'pilot', 'veteran'];
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
    expect(won.pilot, table).toBeGreaterThanOrEqual(3);
    expect(won.veteran, table).toBeGreaterThanOrEqual(2);
    expect(won.pilot, table).toBeLessThanOrEqual(won.recruit);
    expect(won.veteran, table).toBeLessThanOrEqual(won.pilot);
  });
});

describe('g03 Stoat of Emergency: no free route (#198, #200)', () => {
  // The route probes (tests/missions-probes.ts ROUTE_PROBES.g03) fly the ways a player could try, then
  // the bot attacks the stoat, which sits at its bait station. There is no clock, so only the air
  // defences close a route: measured over 6 seeds on Pilot, every naive route (straight, both detours,
  // the wide way round Waiheke, above the SAMs, killing every site) 0/6, each run shot down, the wide
  // way and kill-all after 4–7 minutes; the intended way through (low down the Tāmaki Strait, an AARGM
  // at the strait's boat, a second at the airstrip SA-6 from close in, then the attack) Recruit 5/6,
  // Pilot 5/6, Veteran 2/6.
  const run = (route: string, diff: Difficulty, seed: number) =>
    runPlaythrough('g03', diff, seed, terrainFor('g03'), { maxT: 600, probe: { kind: 'route', route } as ProbeSpec });

  it('every naive route fails on Pilot, the wide way round and kill-all included', { timeout: 900_000 }, async () => {
    const log: string[] = [];
    let won = 0;
    for (const route of ['straight', 'north', 'south', 'wide', 'killall']) {
      for (const seed of [0, 1, 2, 3]) {
        await new Promise((r) => setTimeout(r, 0));
        const r = run(route, 'pilot', seed);
        if (r.state === 'success') won++;
        log.push(`${route} seed ${seed}: ${r.state}@${r.t}s ${r.reason}`);
      }
    }
    expect(won, log.join('\n')).toBeLessThanOrEqual(1);
  });

  it('the intended way through: Pilot ≥ 2/6, and no harder difficulty beats Pilot', { timeout: 600_000 }, async () => {
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
    expect(won.pilot, table).toBeGreaterThanOrEqual(2);
    expect(won.veteran, table).toBeLessThanOrEqual(won.pilot);
  });
});
