/**
 * Headless playtest sweep: flies missions with the scripted competent pilot (tests/missions-bot.ts)
 * against the REAL sim, AI and mission runner on the LINZ Auckland data, no browser and no rendering
 * (~0.5–3 s per run). The fast way to answer "is this mission winnable / too easy / did my change
 * break it" before spending minutes per mission in Playwright.
 *
 *   npx vite-node tools/playtest/bot-sweep.ts -- [--missions=g01,g02|irgc|campaigns|training|all]
 *       [--diffs=recruit,pilot,veteran] [--seeds=3] [--maxT=900] [--jobs=4] [--json=out.json]
 *       [--loadout=sead_stealth] [--log] [--nojitter] [--park[=start|far] | --gunonly | --route=<name>]
 *
 * Defaults: every playable campaign mission and training, pilot, 3 seeds, all cores. Prints one line per run and a
 * win-rate table per mission × difficulty; --json writes every PlaythroughResult (minus the raw
 * MissionResult) for the playtest ledger. --jobs splits the runs over child processes.
 *   --loadout   fly this loadout instead of each mission's recommended one; missions that don't
 *               allow it are skipped (their cells read "skip" and the table says why)
 *   --log       record the bot's event log (launches, kills, objectives, radio, a state line every
 *               5 s) into each row's `events` (keep it with --json), and measure each run's longest
 *               dead stretch (no radio, HUD message, launch, kill or objective change:
 *               tests/missions-pacing.ts) into `dead`; a pacing table after the win rates lists each
 *               mission's longest one and every run over 90 s
 *   --nojitter  no seeded jitter of the player start and enemy positions: the seed only changes
 *               the combat RNG and the mission seed
 *   --park[=start|far]  park-and-wait probe instead of the bot: the jet stays at its start (or 35 km
 *               south-west, 13 km up), no input, no shot, kept unhurt and fuelled. Is the mission won,
 *               or an objective credited, by waiting?
 *   --gunonly   gun-only probe: the stores are emptied every step and the air-to-air bot presses on
 *               with the gun; rows count `gunRounds`, and a rounds table follows the win rates
 *   --route=<name>  route probe (#198): fly one of the mission's ROUTE_PROBES (g03: straight, north,
 *               south, wide, high, golden, golden_north), then the bot attacks; `killall` attacks every
 *               SAM site first. "Is there a free way round?" and "does the intended way work?"
 *   (tests/missions-probes.ts; every row's `probe` says which ran: bot, park:start, park:far, gunonly, route:<name>,
 *   and with --log the event log starts with a PROBE line)
 * Mission ids include Instant Action (`ia_<mode>_auckland`, e.g. ia_strike_auckland): the id seeds
 * the layout, so the same id is the same mission in every run (missionById()).
 * Exit code 0 even when missions fail: the table is the result, judging it is the caller's job.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import '../../tests/linz-setup';
import { runPlaythrough, type PlaythroughResult } from '../../tests/missions-bot';
import { MAX_DEAD_STRETCH, deadStretchText, longestDeadStretch, type DeadStretch } from '../../tests/missions-pacing';
import { parseProbe, probeLabel } from '../../tests/missions-probes';
import { CAMPAIGNS, PLAYABLE_CAMPAIGNS, TRAINING, missionById, terrainPadsFor } from '../../src/missions';
import { generateTerrain, runSync } from '../../src/world/terrain/generate';
import { TerrainQueryImpl } from '../../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../../src/world/scenery/Scenery';
import { LOADOUTS } from '../../src/core/data';
import type { Difficulty, LoadoutId } from '../../src/core/types';
import type { TerrainQuery } from '../../src/sim/api';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a !== '--')
    .map((a) => {
      const m = a.match(/^--([^=]+)=?(.*)$/);
      return m ? [m[1], m[2]] : [a, ''];
    }),
) as Record<string, string>;

/**
 * Ids and groups, comma-separated in any mix (e.g. campaigns,training,ia_defend_auckland): campaigns (every
 * playable campaign: today the IRGC campaign only), irgc (g01–g03), training, all (every playable campaign and
 * training; the default).
 */
function missionIds(spec: string): string[] {
  const playable = PLAYABLE_CAMPAIGNS.flatMap((c) => c.missions);
  const groups: Record<string, readonly { id: string }[]> = {
    irgc: CAMPAIGNS.find((c) => c.id === 'irgc')?.missions ?? [],
    campaigns: playable,
    training: TRAINING,
    all: [...playable, ...TRAINING],
  };
  const group = (s: string) => groups[s] ?? null;
  return [...new Set(spec.split(',').filter(Boolean).flatMap((s) => group(s)?.map((m) => m.id) ?? [s]))];
}

const missions = missionIds(args.missions || 'all');
const diffs = (args.diffs || 'pilot').split(',') as Difficulty[];
const seeds = Number(args.seeds || 3);
const maxT = Number(args.maxT || 900);
const jobs = Math.max(1, Number(args.jobs || os.cpus().length));
const loadout = (args.loadout || undefined) as LoadoutId | undefined;
if (loadout && !LOADOUTS[loadout]) throw new Error(`no loadout ${loadout} (${Object.keys(LOADOUTS).join(', ')})`);
const log = 'log' in args;
const jitter = !('nojitter' in args);
/** --park / --gunonly (null: the plain mission bot). */
const probe = parseProbe(args);
for (const id of missions) if (!missionById(id)) throw new Error(`no mission ${id}`);
/** Missions that don't allow the --loadout (skipped). */
const skipped = loadout ? missions.filter((id) => !missionById(id)!.allowedLoadouts.includes(loadout)) : [];

type Run = { mission: string; diff: Difficulty; seed: number };
const runs: Run[] = missions
  .filter((m) => !skipped.includes(m))
  .flatMap((mission) => diffs.flatMap((diff) => Array.from({ length: seeds }, (_, seed) => ({ mission, diff, seed }))));
/** `dead`: the run's longest dead stretch (only with --log). `probe`: what flew the jet (bot, park:start, park:far, gunonly). */
type Row = Omit<PlaythroughResult, 'result' | 'probe'> & { loadout: LoadoutId; wallMs: number; dead?: DeadStretch; probe: string; gunRounds?: number };

if (args.shard) {
  // child: run my share, one JSON line per run on stdout
  const [k, n] = args.shard.split('/').map(Number);
  const terrains = new Map<string, TerrainQuery>();
  for (const [i, r] of runs.entries()) {
    if (i % n !== k) continue;
    let t = terrains.get(r.mission);
    if (!t) {
      const def = missionById(r.mission)!;
      t = new TerrainQueryImpl(runSync(generateTerrain({ theater: def.theater, seed: def.seed, resolution: 512, features: allFeatures(def.theater, []), pads: terrainPadsFor(def) })));
      terrains.set(r.mission, t);
    }
    const t0 = Date.now();
    const { result: _, probe: pr, ...rest } = runPlaythrough(r.mission, r.diff, r.seed, t, { maxT, loadout, log, jitter, probe });
    const dead = log ? longestDeadStretch(rest.events, rest.t) : undefined;
    const row: Row = { ...rest, probe: probeLabel(probe), gunRounds: pr?.gunRounds, loadout: loadout ?? missionById(r.mission)!.recommendedLoadout, wallMs: Date.now() - t0, dead };
    process.stdout.write(JSON.stringify(row) + '\n');
  }
} else {
  const t0 = Date.now();
  const n = Math.min(jobs, runs.length);
  const rows: Row[] = [];
  const passthrough = process.argv.slice(2).filter((a) => a !== '--' && !a.startsWith('--jobs') && !a.startsWith('--json'));
  await Promise.all(
    Array.from({ length: n }, (_, k) => {
      const child = spawn('npx', ['vite-node', 'tools/playtest/bot-sweep.ts', '--', ...passthrough, `--shard=${k}/${n}`], { stdio: ['ignore', 'pipe', 'inherit'] });
      let buf = '';
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.startsWith('{')) continue;
          const r = JSON.parse(line) as Row;
          rows.push(r);
          console.log(`${r.state === 'success' ? 'WIN ' : r.state === 'failed' ? 'LOSS' : 'HUNG'} ${r.mission.padEnd(5)} ${r.diff.padEnd(8)} seed ${r.seed}  t=${Math.round(r.t)}s  kills=${r.playerKills}  ${r.reason ?? ''}  (${(r.wallMs / 1000).toFixed(1)} s)`);
        }
      });
      return new Promise<void>((resolve) => child.on('close', () => resolve()));
    }),
  );
  const flags = [probe ? `probe ${probeLabel(probe)}` : '', loadout ? `loadout ${loadout}` : '', log ? 'log' : '', jitter ? '' : 'no jitter'].filter(Boolean).join(', ');
  console.log(`\nwin rate (${seeds} seeds, maxT ${maxT} s${flags ? `, ${flags}` : ''}), ${rows.length}/${runs.length} runs in ${((Date.now() - t0) / 1000).toFixed(0)} s on ${n} jobs`);
  const w = Math.max(9, ...missions.map((m) => m.length + 2));
  console.log(`${'mission'.padEnd(w)}${diffs.map((d) => d.padEnd(9)).join('')}`);
  for (const m of missions) {
    const cells = diffs.map((d) => {
      if (skipped.includes(m)) return 'skip'.padEnd(9);
      const rs = rows.filter((r) => r.mission === m && r.diff === d);
      return `${rs.filter((r) => r.state === 'success').length}/${rs.length}`.padEnd(9);
    });
    console.log(`${m.padEnd(w)}${cells.join('')}`);
  }
  if (skipped.length) console.log(`skip = ${loadout} is not an allowed loadout there (${skipped.join(', ')}); those missions were not flown`);
  if (probe?.kind === 'gunonly') {
    // gun-only: did the fights reach the gun? (rounds fired, and runs that fired any, per cell)
    console.log(`\ngun rounds fired (total / runs that fired)`);
    for (const m of missions) {
      const cells = diffs.map((d) => {
        const rs = rows.filter((r) => r.mission === m && r.diff === d);
        return `${rs.reduce((n, r) => n + (r.gunRounds ?? 0), 0)}/${rs.filter((r) => (r.gunRounds ?? 0) > 0).length}`.padEnd(9);
      });
      console.log(`${m.padEnd(w)}${cells.join('')}`);
    }
  }
  if (probe?.kind === 'park') {
    // parked: a win, or any player kill, means the mission was won (or credited) without the player
    const won = rows.filter((r) => r.state === 'success');
    console.log(`\nparked (${probeLabel(probe)}): ${won.length}/${rows.length} runs won without the player${won.length ? `: ${won.map((r) => `${r.mission} ${r.diff} seed ${r.seed}`).join(', ')}` : ''}`);
  }
  if (log) {
    // pacing: each mission's longest dead stretch over all its runs (#59: none should pass 90 s)
    console.log(`\nlongest dead stretch (no radio, HUD message, launch, kill or objective change; bar ${MAX_DEAD_STRETCH} s)`);
    for (const m of missions) {
      const rs = rows.filter((r) => r.mission === m && r.dead);
      if (!rs.length) continue;
      const worst = rs.reduce((a, b) => (b.dead!.length > a.dead!.length ? b : a));
      const over = rs.filter((r) => r.dead!.length > MAX_DEAD_STRETCH);
      console.log(`${m.padEnd(w)}${deadStretchText(worst.dead!)} in ${worst.diff} seed ${worst.seed}; ${over.length}/${rs.length} runs over ${MAX_DEAD_STRETCH} s`);
      for (const r of over) console.log(`${''.padEnd(w)}  ${r.diff} seed ${r.seed}: ${deadStretchText(r.dead!)}`);
    }
  }
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(rows, null, 1));
}
