/**
 * Headless playtest sweep: flies missions with the scripted competent pilot (tests/missions-bot.ts)
 * against the REAL sim, AI and mission runner on the LINZ Auckland data, no browser and no rendering
 * (~0.5–3 s per run). The fast way to answer "is this mission winnable / too easy / did my change
 * break it" before spending minutes per mission in Playwright.
 *
 *   npx vite-node tools/playtest/bot-sweep.ts -- [--missions=c01,c04|campaign|training|all]
 *       [--diffs=recruit,pilot,veteran,ace] [--seeds=3] [--maxT=900] [--jobs=4] [--json=out.json]
 *       [--loadout=strike_sdb2] [--log] [--nojitter]
 *
 * Defaults: every campaign mission, pilot, 3 seeds, all cores. Prints one line per run and a
 * win-rate table per mission × difficulty; --json writes every PlaythroughResult (minus the raw
 * MissionResult) for the playtest ledger. --jobs splits the runs over child processes.
 *   --loadout   fly this loadout instead of each mission's recommended one; missions that don't
 *               allow it are skipped (their cells read "skip" and the table says why)
 *   --log       record the bot's event log (launches, kills, objectives, radio, a state line every
 *               5 s) into each row's `events` (only useful with --json; without it they stay empty)
 *   --nojitter  no seeded jitter of the player start and enemy positions: the seed only changes
 *               the combat RNG and the mission seed
 * Mission ids include Instant Action (`ia_<mode>_<theater>`, e.g. ia_strike_desert): the id seeds
 * the layout and terrain, so the same id is the same mission in every run (missionById()).
 * Exit code 0 even when missions fail: the table is the result, judging it is the caller's job.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import '../../tests/linz-setup';
import { runPlaythrough, type PlaythroughResult } from '../../tests/missions-bot';
import { CAMPAIGN, TRAINING, missionById, terrainPadsFor } from '../../src/missions';
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

/** Ids and the groups campaign / training / all, comma-separated in any mix (e.g. campaign,training,ia_defend_auckland). */
function missionIds(spec: string): string[] {
  const group = (s: string) => (s === 'campaign' ? CAMPAIGN : s === 'training' ? TRAINING : s === 'all' ? [...CAMPAIGN, ...TRAINING] : null);
  return [...new Set(spec.split(',').filter(Boolean).flatMap((s) => group(s)?.map((m) => m.id) ?? [s]))];
}

const missions = missionIds(args.missions || 'campaign');
const diffs = (args.diffs || 'pilot').split(',') as Difficulty[];
const seeds = Number(args.seeds || 3);
const maxT = Number(args.maxT || 900);
const jobs = Math.max(1, Number(args.jobs || os.cpus().length));
const loadout = (args.loadout || undefined) as LoadoutId | undefined;
if (loadout && !LOADOUTS[loadout]) throw new Error(`no loadout ${loadout} (${Object.keys(LOADOUTS).join(', ')})`);
const log = 'log' in args;
const jitter = !('nojitter' in args);
for (const id of missions) if (!missionById(id)) throw new Error(`no mission ${id}`);
/** Missions that don't allow the --loadout (skipped). */
const skipped = loadout ? missions.filter((id) => !missionById(id)!.allowedLoadouts.includes(loadout)) : [];

type Run = { mission: string; diff: Difficulty; seed: number };
const runs: Run[] = missions
  .filter((m) => !skipped.includes(m))
  .flatMap((mission) => diffs.flatMap((diff) => Array.from({ length: seeds }, (_, seed) => ({ mission, diff, seed }))));
type Row = Omit<PlaythroughResult, 'result'> & { loadout: LoadoutId; wallMs: number };

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
    const { result: _, ...rest } = runPlaythrough(r.mission, r.diff, r.seed, t, { maxT, loadout, log, jitter });
    process.stdout.write(JSON.stringify({ ...rest, loadout: loadout ?? missionById(r.mission)!.recommendedLoadout, wallMs: Date.now() - t0 } satisfies Row) + '\n');
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
  const flags = [loadout ? `loadout ${loadout}` : '', log ? 'log' : '', jitter ? '' : 'no jitter'].filter(Boolean).join(', ');
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
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(rows, null, 1));
}
