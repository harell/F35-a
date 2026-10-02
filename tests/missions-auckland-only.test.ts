/**
 * Issue #73: Auckland is the only theatre. The procedural desert / islands / mountains / arctic
 * theatres (Instant Action only) are gone from the code; Instant Action keeps every mode, in
 * Auckland; `ia_<mode>_auckland` ids still resolve and the other theatres' ids don't; a saved
 * Instant Action setup naming a removed theatre loads and starts in Auckland.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES, THEATER_INFO } from '../src/core/data';
import type { InstantActionOptions, MissionDef } from '../src/core/contracts';
import { buildInstantMission, createMissionRunner, missionById, terrainPadsFor, validateMission } from '../src/missions';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createAiBrain } from '../src/ai';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { parseInstantSetup } from '../src/ui/screens/instantAction';

const MODES: InstantActionOptions['mode'][] = ['stroll', 'dogfight', 'sam_gauntlet', 'strike', 'defend', 'survival'];
const REMOVED = ['desert', 'islands', 'mountains', 'arctic'];

// node:fs without @types/node (the project doesn't ship node typings): the minimal surface used here
interface Fs {
  readFileSync(p: URL, enc: 'utf8'): string;
  readdirSync(p: URL, opts: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
}
let fs: Fs;
beforeAll(async () => {
  fs = (await import(/* @vite-ignore */ 'node:fs' as string)) as Fs;
});

/** Every text source file under `dir` (a directory URL ending in '/'). */
function sourceFiles(dir: URL, out: URL[] = []): URL[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) sourceFiles(new URL(`${e.name}/`, dir), out);
    else if (/\.(ts|js|mjs|css|html|glsl|json)$/.test(e.name)) out.push(new URL(e.name, dir));
  }
  return out;
}

const terrains = new Map<string, TerrainQueryImpl>();
/** The real Auckland terrain a mission flies over (512², the bot sweep's resolution). */
function terrainFor(def: MissionDef): TerrainQueryImpl {
  const features = allFeatures(def.theater, def.features);
  const key = `${def.seed}|${JSON.stringify(features)}|${JSON.stringify(terrainPadsFor(def))}`;
  let t = terrains.get(key);
  if (!t) {
    t = new TerrainQueryImpl(runSync(generateTerrain({ theater: def.theater, seed: def.seed, resolution: 512, features, pads: terrainPadsFor(def) })));
    terrains.set(key, t);
  }
  return t;
}

/** Set the mission up with the real AI and combat over Auckland and fly it for `seconds`; returns console errors. */
function start(def: MissionDef, seconds: number) {
  const events = new EventBus();
  const diff = DIFFICULTIES.pilot;
  const terrain = terrainFor(def);
  const world = createSimWorld({ terrain, difficulty: diff, events, combat: createCombatSystemSeeded(3) });
  const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty: diff, events });
  const errors: unknown[] = [];
  const oe = console.error;
  console.error = (...a: unknown[]) => errors.push(a);
  try {
    runner.setup(world, def.recommendedLoadout);
    for (let i = 0; i < seconds * 60; i++) {
      world.step(1 / 60);
      runner.update(world, 1 / 60);
    }
  } finally {
    console.error = oe;
  }
  runner.dispose?.();
  return { world, runner, terrain, errors };
}

describe('Auckland is the only theatre (issue #73)', () => {
  it('no source file names a removed theatre (only Auckland\'s own islands remain)', () => {
    const src = new URL('../src/', import.meta.url);
    // a quoted theatre id ('desert'), not an indexed type such as ChartData['islands'] (Auckland's)
    const ids = new RegExp(`(?<!\\[)['"\`](${REMOVED.join('|')})['"\`]`);
    const names = /sandstorm|northern watch|pacific shield|iron ridge|persian gulf|kola peninsula|south china sea|caucasus/i;
    const hits: string[] = [];
    const files = sourceFiles(src);
    expect(files.length).toBeGreaterThan(100);
    for (const f of files) {
      fs.readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line: string, i: number) => {
          if (ids.test(line) || names.test(line)) hits.push(`${f.href.slice(src.href.length)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('THEATER_INFO lists Auckland only', () => {
    expect(Object.keys(THEATER_INFO)).toEqual(['auckland']);
  });

  it('ia_<mode>_auckland resolves for every mode; the removed theatres\' ids return null', () => {
    for (const mode of MODES) {
      const def = missionById(`ia_${mode}_auckland`);
      expect(def, mode).not.toBeNull();
      expect(def!.theater).toBe('auckland');
      expect(def!.id).toBe(`ia_${mode}_auckland`);
      expect(validateMission(def!)).toEqual([]);
      for (const theater of REMOVED) expect(missionById(`ia_${mode}_${theater}`), `ia_${mode}_${theater}`).toBeNull();
    }
  });

  it('Instant Action starts in every mode over the real Auckland terrain', { timeout: 120_000 }, () => {
    for (const mode of MODES) {
      const def = missionById(`ia_${mode}_auckland`)!;
      const { world, runner, terrain, errors } = start(def, 10);
      expect(errors, mode).toEqual([]);
      expect(runner.state, mode).toBe('running');
      const p = world.player!;
      expect(p.alive, mode).toBe(true);
      expect(p.position.y - terrain.surfaceHeightAt(p.position.x, p.position.z), `${mode}: player AGL`).toBeGreaterThan(500);
      // every enemy jet is flying, clear of the ground
      for (const a of world.aircraft.filter((e) => e.team === 'red' && e.alive)) {
        expect(a.position.y - terrain.surfaceHeightAt(a.position.x, a.position.z), `${mode} ${a.callsign} AGL`).toBeGreaterThan(50);
      }
    }
  });

  it('a saved Instant Action setup naming a removed theatre loads and starts in Auckland', { timeout: 60_000 }, () => {
    for (const theater of REMOVED) {
      // what an older build stored in localStorage 'f35a.instant.v1'
      const raw = JSON.stringify({ mode: 'strike', theater, timeOfDay: 'dusk', weather: 'overcast', enemyType: 'mixed', enemyCount: 4 });
      const opts = parseInstantSetup(raw);
      expect(opts).toEqual({ mode: 'strike', theater: 'auckland', timeOfDay: 'dusk', weather: 'overcast', enemyType: 'mixed', enemyCount: 4 });
      const def = buildInstantMission(opts);
      expect(def.id).toBe('ia_strike_auckland');
      expect(def.theater).toBe('auckland');
      expect(validateMission(def)).toEqual([]);
    }
    const def = buildInstantMission(parseInstantSetup(JSON.stringify({ mode: 'defend', theater: 'mountains' })));
    const { runner, errors } = start(def, 5);
    expect(errors).toEqual([]);
    expect(runner.state).toBe('running');
  });

  it('a missing or broken Instant Action save gives the Auckland defaults', () => {
    for (const raw of [null, '', '{not json', 'null', '42']) {
      const o = parseInstantSetup(raw);
      expect(o.theater, String(raw)).toBe('auckland');
      expect(MODES).toContain(o.mode);
    }
    expect(parseInstantSetup(JSON.stringify({ theater: 'auckland', enemyCount: 99 })).enemyCount).toBe(8);
  });
});
