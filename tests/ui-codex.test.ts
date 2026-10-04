/**
 * The Codex (src/ui/codex/data.ts): every number it shows comes from the game's tables, and every
 * hand-picked rating still matches the hits the sim computes, so a balance change that makes the
 * Codex wrong fails here. Also the debrief's "What happened?" link (missions/runtime/debrief.ts
 * codexTopic) and the blast fix found while writing it (no blast damage to the shooter's own side).
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { MissionResult } from '../src/core/contracts';
import { WEAPON_HUD } from '../src/hud/hmd/format';
import { codexTopic } from '../src/missions/runtime/debrief';
import { REASONS } from '../src/missions/runtime/reasons';
import type { MissionState } from '../src/missions/runtime/state';
import { MUNITIONS } from '../src/sim/weapons/defs';
import {
  CODEX_ENTRIES,
  CODEX_WARNINGS,
  CODEX_WEAPONS,
  MATRIX_WEAPONS,
  RATINGS,
  TARGET_CLASSES,
  classHits,
  codexEntry,
  codexForWeapon,
  liveMembers,
  searchCodex,
  useOn,
} from '../src/ui/codex/data';
import { FakeWorld, FlatTerrain } from './combat-helpers';

describe('Codex data comes from the game', () => {
  it('has a page for every weapon the player can carry (the GBU-39 is being removed), plus flares and chaff', () => {
    const ids = CODEX_WEAPONS.map((w) => w.id);
    for (const id of Object.keys(WEAPON_HUD)) if (id !== 'gbu39') expect(ids).toContain(id);
    expect(ids).toContain('cms');
    expect(ids).not.toContain('gbu39');
  });

  it('launch ranges are the sim\'s', () => {
    for (const w of CODEX_WEAPONS) {
      if (w.id === 'gun' || w.id === 'cms' || !w.range) continue;
      expect(w.range.min).toBe(MUNITIONS[w.id].minRange / 1000);
      expect(w.range.max).toBe(MUNITIONS[w.id].maxRange / 1000);
      expect(w.range.max).toBeLessThanOrEqual(w.range.scale);
    }
  });

  it('the first HUD label is the one the HMD shows', () => {
    for (const w of CODEX_WEAPONS) if (w.id !== 'cms') expect(w.hud[0][0].startsWith(WEAPON_HUD[w.id])).toBe(true);
  });

  it('every target class still has live sim types', () => {
    for (const c of TARGET_CLASSES) expect(liveMembers(c).length, c.id).toBeGreaterThan(0);
  });

  it('entry ids are unique and the briefing finds each store', () => {
    const ids = CODEX_ENTRIES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(codexForWeapon('gbu53')?.name).toMatch(/StormBreaker/);
    expect(codexForWeapon('gbu39')).toBeNull();
  });
});

describe('Codex ratings match the computed hits', () => {
  for (const id of MATRIX_WEAPONS) {
    it(id, () => {
      for (const c of TARGET_CLASSES) {
        const [rating] = RATINGS[id][c.id];
        const hits = classHits(id, c);
        const most = hits ? hits[1] : Infinity;
        if (rating === 'no') expect(hits, `${id} vs ${c.id}`).toBeNull();
        else expect(hits, `${id} vs ${c.id}`).not.toBeNull();
        if (rating === 'best') expect(most, `${id} best vs ${c.id}`).toBe(id === 'gun' ? most : 1);
        if (rating === 'good') expect(most, `${id} good vs ${c.id}`).toBeLessThanOrEqual(id === 'gun' ? 7 : 2);
      }
    });
  }

  it('air-to-air missiles do nothing to ground targets; bombs can\'t be aimed at aircraft', () => {
    const ad = TARGET_CLASSES.find((c) => c.id === 'ad')!;
    const air = TARGET_CLASSES.find((c) => c.id === 'air')!;
    expect(classHits('aim120', ad)).toBeNull();
    expect(classHits('gbu31', air)).toBeNull();
    expect(classHits('aim120', air)).toEqual([1, 1]);
  });

  it('a StormBreaker takes two hits on a bunker (250 vs 260 HP), one on a hangar', () => {
    const hard = TARGET_CLASSES.find((c) => c.id === 'hard')!;
    expect(classHits('gbu53', hard)).toEqual([1, 2]);
  });

  it('"Use it on" lists only Best and Good, best first', () => {
    for (const w of CODEX_WEAPONS) {
      const u = useOn(w.id);
      for (const x of u) expect(['best', 'good']).toContain(x.rating);
      const firstGood = u.findIndex((x) => x.rating === 'good');
      if (firstGood >= 0) expect(u.slice(firstGood).every((x) => x.rating === 'good')).toBe(true);
    }
    expect(useOn('aim120').map((u) => u.cls.id)).toEqual(['air']);
    expect(useOn('aargm').map((u) => u.cls.id)).toEqual(['ad']);
  });
});

describe('Codex search', () => {
  it('finds entries by name and by the HUD label', () => {
    expect(searchCodex('mud spike').map((e) => e.id)).toContain('mud');
    expect(searchCodex('AMRAAM').map((e) => e.id)).toContain('aim120');
    expect(searchCodex('fox 2').map((e) => e.id)).toContain('aim9x');
    expect(searchCodex('   ')).toEqual([]);
  });
});

describe('debrief → Codex link', () => {
  const state = (lastHitWeapon: string | null, lastHitBy: 'sam' | 'aircraft' | 'ground' | null = null) =>
    ({ stats: { lastHitWeapon, lastHitBy, lastHitType: null } }) as unknown as MissionState;
  const res = (reason: string, success = false) => ({ success, reason, freeFlight: false }) as MissionResult;

  it('names an entry that exists for each way of losing', () => {
    const cases: [MissionState, MissionResult, string][] = [
      [state('m_3m9', 'sam'), res(`${REASONS.shot} by an SA-6`), 'mud'],
      [state('flak', 'sam'), res(`${REASONS.shot} by Shilka flak`), 'mud'],
      [state('m_igla', 'sam'), res(`${REASONS.shot} by an SA-18`), 'silent'],
      [state('r73', 'aircraft'), res(`${REASONS.shot} by a MiG-29's R-73`), 'cms'],
      [state('r77', 'aircraft'), res(`${REASONS.shot} by an Su-35's R-77`), 'silent'],
      [state('r27', 'aircraft'), res(`${REASONS.shot} by an Su-27's R-27`), 'launch'],
      [state(null), res(REASONS.crash), 'pullup'],
      [state(null), res(REASONS.fuel), 'fuel'],
    ];
    for (const [s, r, want] of cases) {
      expect(codexTopic(s, r)).toBe(want);
      expect(codexEntry(want)).not.toBeNull();
    }
  });

  it('no link for a win, free flight, an enemy gun or a building', () => {
    expect(codexTopic(state('m_3m9', 'sam'), res(REASONS.success, true))).toBeUndefined();
    expect(codexTopic(state('gun', 'aircraft'), res(`${REASONS.shot} by a MiG-29's gun`))).toBeUndefined();
    expect(codexTopic(state(null), res(REASONS.building))).toBeUndefined();
  });

  it('every warning page the debrief can open has a demo and a reason', () => {
    for (const id of ['mud', 'silent', 'cms', 'launch', 'pullup', 'fuel']) {
      const e = codexEntry(id)!;
      expect(e.line.length).toBeGreaterThan(10);
    }
    expect(CODEX_WARNINGS.every((w) => w.reference || w.how.length > 0)).toBe(true);
  });
});

describe('blast damage spares the shooter\'s own side (found while writing the Codex)', () => {
  it('a JDAM next to a wingman leaves the wingman whole and still hurts an enemy fighter beside it', () => {
    const G = 30;
    const w = new FakeWorld({ terrain: new FlatTerrain(G), seed: 5 });
    const at = (x: number, y: number, z: number) => new Vector3(x, G + y, z);
    const f35 = w.spawnAircraft({ type: 'f35a', team: 'blue', position: at(3000, 4000, 0), heading: -Math.PI / 2, speed: 240, isPlayer: true, loadout: 'strike_beast' });
    const depot = w.spawnGround({ type: 'fuel', team: 'red', position: at(0, 0, 0) });
    // hovering 25 m over the depot: well inside the JDAM's 60 m blast
    const wingman = w.spawnAircraft({ type: 'f35a', team: 'blue', position: at(0, 25, 8), heading: 0, speed: 0.01, callsign: 'Viper 2' });
    const mig = w.spawnAircraft({ type: 'mig29', team: 'red', position: at(0, 25, -8), heading: 0, speed: 0.01 });
    w.run(0.5);
    w.combat.selectWeapon(f35, 'gbu31', w);
    w.combat.designate(f35, depot.id, w);
    const ends = w.record('munition:end');
    expect(w.combat.fire(f35, w, 'gbu31', depot.id)).not.toBeNull();
    w.run(60, () => ends.length > 0);
    expect(ends).toHaveLength(1);
    expect(depot.alive).toBe(false);
    expect(wingman.health).toBe(wingman.maxHealth);
    expect(mig.health).toBeLessThan(mig.maxHealth);
  });
});
