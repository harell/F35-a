/**
 * MISSIONS — content validity: every campaign / training / instant-action mission passes the
 * validator (unique ids, bounds, references, loadouts, pads, safe player starts).
 */
import { describe, expect, it } from 'vitest';
import type { InstantActionOptions } from '../src/core/contracts';
import { CAMPAIGN, TRAINING, buildInstantMission, buildInstantMissionSeeded, terrainPadsFor, validateMission } from '../src/missions';
import { mergePads } from '../src/missions/pads';
import type { TheaterId } from '../src/core/types';

const ALL = [...CAMPAIGN, ...TRAINING];

describe('missions: campaign & training content', () => {
  it('has 12 campaign missions and 3 training missions in order', () => {
    expect(CAMPAIGN).toHaveLength(12);
    expect(TRAINING).toHaveLength(3);
    CAMPAIGN.forEach((m, i) => {
      expect(m.kind).toBe('campaign');
      expect(m.index).toBe(i + 1);
    });
    TRAINING.forEach((m) => expect(m.kind).toBe('training'));
  });

  it('mission ids are unique', () => {
    const ids = ALL.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every mission definition is valid', () => {
    const errors = ALL.flatMap((m) => validateMission(m));
    expect(errors).toEqual([]);
  });

  it('campaign and training are set in Auckland with time-of-day / weather variety', () => {
    for (const m of ALL) expect(m.theater).toBe('auckland');
    const tods = new Set(CAMPAIGN.map((m) => m.timeOfDay));
    expect(tods).toEqual(new Set(['dawn', 'day', 'dusk', 'night']));
    expect(new Set(CAMPAIGN.map((m) => m.weather)).size).toBeGreaterThanOrEqual(3);
  });

  it('briefings are substantial and objectives are listed', () => {
    for (const m of CAMPAIGN) {
      expect(m.briefing.length).toBeGreaterThanOrEqual(2);
      expect(m.briefing.length).toBeLessThanOrEqual(4);
      expect(m.objectiveText.length).toBeGreaterThan(0);
      expect(m.intel.length).toBeGreaterThan(0);
      expect(m.allowedLoadouts).toContain(m.recommendedLoadout);
    }
  });

  it('SAM sites and static compounds get terrain pads; ships do not', () => {
    const c06 = CAMPAIGN.find((m) => m.id === 'c06')!;
    const pads = terrainPadsFor(c06);
    for (const s of c06.script.sams) expect(pads.some((p) => Math.hypot(p.x - s.x, p.z - s.z) <= p.radius)).toBe(true);
    for (const g of c06.script.ground.filter((g) => g.type === 'ship')) {
      expect(pads.some((p) => Math.hypot(p.x - g.x, p.z - g.z) <= p.radius)).toBe(false);
    }
  });

  it('merges overlapping pads into one bounding circle', () => {
    const merged = mergePads([
      { x: 0, z: 0, radius: 60 },
      { x: 80, z: 0, radius: 60 },
      { x: 5000, z: 0, radius: 60 },
    ]);
    expect(merged).toHaveLength(2);
    const big = merged.find((p) => p.x < 1000)!;
    expect(Math.abs(big.x) + 60).toBeLessThanOrEqual(big.radius + 1e-6);
    expect(Math.abs(80 - big.x) + 60).toBeLessThanOrEqual(big.radius + 1e-6);
  });

  it('SAM missions keep the player outside the threat rings (validator catches violations)', () => {
    const c03 = CAMPAIGN.find((m) => m.id === 'c03')!;
    const bad = { ...c03, player: { ...c03.player, x: c03.script.sams[0].x + 2000, z: c03.script.sams[0].z } };
    expect(validateMission(bad).some((e) => e.includes('threat ring'))).toBe(true);
  });

  it('validator catches dangling references', () => {
    const c01 = CAMPAIGN[0];
    const bad = {
      ...c01,
      script: { ...c01.script, objectives: [...c01.script.objectives, { id: 'o_x', kind: 'destroy' as const, groups: ['nope'], label: 'x', primary: false }] },
    };
    expect(validateMission(bad).some((e) => e.includes('unknown group "nope"'))).toBe(true);
  });
});

describe('missions: instant action generator', () => {
  const modes: InstantActionOptions['mode'][] = ['dogfight', 'sam_gauntlet', 'strike', 'survival'];
  const theaters: TheaterId[] = ['auckland', 'desert', 'islands', 'mountains', 'arctic'];

  it('builds a valid mission for every mode × theatre × size', () => {
    for (const mode of modes) {
      for (const theater of theaters) {
        for (const enemyCount of [1, 4, 8]) {
          const def = buildInstantMissionSeeded({ mode, theater, timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount }, 1234 + enemyCount);
          expect(def.kind).toBe('instant');
          expect(def.theater).toBe(theater);
          expect(validateMission(def)).toEqual([]);
        }
      }
    }
  });

  it('dogfight spawns the requested number of bandits of the requested type', () => {
    const def = buildInstantMission({ mode: 'dogfight', theater: 'auckland', timeOfDay: 'dusk', weather: 'scattered', enemyType: 'su35', enemyCount: 5 });
    const red = def.script.groups.filter((g) => g.team === 'red');
    expect(red.reduce((n, g) => n + g.count, 0)).toBe(5);
    expect(red.every((g) => g.type === 'su35' && g.fixedCount)).toBe(true);
    expect(def.timeOfDay).toBe('dusk');
  });

  it('survival uses endless waves', () => {
    const def = buildInstantMission({ mode: 'survival', theater: 'desert', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 2 });
    expect(def.script.survival).toBeTruthy();
    expect(def.id.startsWith('ia_survival')).toBe(true);
  });

  it('sam gauntlet and strike have ground targets and SAMs', () => {
    for (const mode of ['sam_gauntlet', 'strike'] as const) {
      const def = buildInstantMission({ mode, theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mig29', enemyCount: 4 });
      expect(def.script.ground.length).toBeGreaterThan(0);
      expect(def.script.sams.length).toBeGreaterThan(0);
      expect(def.recommendedLoadout).not.toBe('a2a_beast');
    }
  });
});
