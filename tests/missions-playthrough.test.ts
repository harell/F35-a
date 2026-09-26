/**
 * MISSIONS — real-terrain regression checks (i1):
 *  - c08: the landing ships and the harbour approach are masked from the Motutapu SA-10 by
 *    Rangitoto at wave-top height and at the ~800 ft pop-up (terrain line of sight at the
 *    in-game heightfield resolution);
 *  - full playthroughs with the REAL World / Combat / AI / MissionRunner and the scripted
 *    competent player (tests/missions-bot.ts): c09 (was unwinnable on every difficulty),
 *    c01 (was soft-locked on 'Splash the second MiG pair 1/2'), c08 (low-level under the SA-10),
 *    and c01 win-rate bands per difficulty (the reviewers' suggested regression test).
 * The full per-difficulty sweep is e2e/review/dev-missions-sweep.ts.
 */
import { Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { missionById, terrainPadsFor } from '../src/missions';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { allFeatures } from '../src/world/scenery/Scenery';
import { SAM_DATA } from '../src/sim/sam/samData';
import type { TerrainQuery } from '../src/sim/api';
import { runPlaythrough, type PlaythroughResult } from './missions-bot';

let terrain512: TerrainQuery;
let terrain1024: TerrainQuery;

beforeAll(() => {
  const def = missionById('c08')!;
  const spec = (resolution: number) => ({ theater: def.theater, seed: def.seed, resolution, features: allFeatures(def.theater, []), pads: terrainPadsFor(def) });
  terrain512 = new TerrainQueryImpl(runSync(generateTerrain(spec(512))));
  terrain1024 = new TerrainQueryImpl(runSync(generateTerrain(spec(1024))));
}, 60_000);

describe('i1: c08 — the Rangitoto Channel is in the SA-10 terrain shadow', () => {
  it('ships and the harbour approach are masked at 60 m, and the ships up to 250 m AGL', () => {
    const def = missionById('c08')!;
    const sa10 = def.script.sams.find((s) => s.type === 'sa10')!;
    for (const t of [terrain512, terrain1024]) {
      const eye = new Vector3(sa10.x, t.surfaceHeightAt(sa10.x, sa10.z) + SAM_DATA.sa10.mastHeight, sa10.z);
      const ships = def.script.ground.filter((g) => g.group === 'landing');
      expect(ships).toHaveLength(3);
      for (const s of ships) {
        for (const agl of [60, 150, 250]) {
          const p = new Vector3(s.x, t.surfaceHeightAt(s.x, s.z) + agl, s.z);
          expect(t.lineOfSight(eye, p), `ship ${s.id} at ${agl} m`).toBe(false);
        }
      }
      // the briefed route: under the bridge, North Head, into the channel — at wave-top height
      for (const id of ['wp_bridge', 'wp_ip', 'wp_ships']) {
        const w = def.script.waypoints.find((x) => x.id === id)!;
        const p = new Vector3(w.x, t.surfaceHeightAt(w.x, w.z) + 60, w.z);
        expect(t.lineOfSight(eye, p), `${id} at 60 m`).toBe(false);
      }
      // …and it really is an SA-10 umbrella above that
      const high = new Vector3(4200, 3000, -4700);
      expect(t.lineOfSight(eye, high)).toBe(true);
    }
  });
});

describe('i1: winnable playthroughs (real AI, scripted competent player)', () => {
  it('c09 Hammer Down is winnable on Recruit and Pilot (was lost at ~128 s on every difficulty)', { timeout: 120_000 }, () => {
    const rows: PlaythroughResult[] = [];
    for (const diff of ['recruit', 'pilot'] as const) {
      for (const seed of [1, 14, 27]) rows.push(runPlaythrough('c09', diff, seed, terrain512, { maxT: 700 }));
    }
    const wins = (d: string) => rows.filter((r) => r.diff === d && r.state === 'success').length;
    expect(wins('recruit'), JSON.stringify(rows.map((r) => [r.diff, r.state, r.reason]))).toBeGreaterThanOrEqual(2);
    expect(wins('pilot'), JSON.stringify(rows.map((r) => [r.diff, r.state, r.reason]))).toBeGreaterThanOrEqual(1);
    // nothing stalls: every run ends
    expect(rows.every((r) => r.state !== 'running')).toBe(true);
  });

  it('c01 never stalls on Recruit (was "running" at 600 s with one MiG left); c08 Pilot is winnable', { timeout: 120_000 }, () => {
    const c01 = [1, 14, 27].map((seed) => runPlaythrough('c01', 'recruit', seed, terrain512, { maxT: 900 }));
    expect(c01.every((r) => r.state !== 'running'), JSON.stringify(c01.map((r) => [r.state, r.t, r.objectives]))).toBe(true);
    expect(c01.filter((r) => r.state === 'success').length).toBeGreaterThanOrEqual(2);
    const c08 = [1, 14].map((seed) => runPlaythrough('c08', 'pilot', seed, terrain512, { maxT: 700 }));
    expect(c08.some((r) => r.state === 'success'), JSON.stringify(c08.map((r) => [r.state, r.reason]))).toBe(true);
  });

  it('c01 win-rate bands for a competent player: Recruit ≥ 75 %, Pilot ≥ 75 %, Veteran ≥ 25 % (was 0/6 on Veteran)', { timeout: 120_000 }, () => {
    const seeds = [1, 14, 27, 40];
    const band = (diff: 'recruit' | 'pilot' | 'veteran') => {
      const rows = seeds.map((seed) => runPlaythrough('c01', diff, seed, terrain512, { maxT: 900 }));
      expect(rows.every((r) => r.state !== 'running'), `${diff} stalled`).toBe(true);
      return { wins: rows.filter((r) => r.state === 'success').length, why: JSON.stringify(rows.map((r) => [r.state, r.t, r.reason])) };
    };
    const rec = band('recruit');
    expect(rec.wins, rec.why).toBeGreaterThanOrEqual(3);
    const pil = band('pilot');
    expect(pil.wins, pil.why).toBeGreaterThanOrEqual(3);
    const vet = band('veteran');
    expect(vet.wins, vet.why).toBeGreaterThanOrEqual(1);
  });
});
