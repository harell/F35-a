/**
 * MISSIONS — content validity: every campaign / training / instant-action mission passes the
 * validator (unique ids, bounds, references, loadouts, pads, safe player starts).
 */
import { describe, expect, it } from 'vitest';
import type { InstantActionOptions, MissionDef } from '../src/core/contracts';
import { WEAPON_INFO } from '../src/core/data';
import { CAMPAIGNS, TRAINING, buildInstantMission, buildInstantMissionSeeded, missionById, terrainPadsFor, validateMission } from '../src/missions';
import { mergePads } from '../src/missions/pads';
import { P, target } from '../src/missions/content/common';
import type { TheaterId, WeaponId } from '../src/core/types';
import { seadFixture } from './missions-helpers';
import { FakeWorld, FlatTerrain, v3 } from './combat-helpers';

const CAMPAIGN = CAMPAIGNS.flatMap((c) => c.missions);
const ALL = [...CAMPAIGN, ...TRAINING];

describe('missions: campaign & training content', () => {
  it('has the IRGC campaign (3 missions) and 7 training missions in order; none is the finale while the campaign is built', () => {
    expect(CAMPAIGNS.map((c) => c.id)).toEqual(['irgc']);
    expect(CAMPAIGN.map((m) => m.id)).toEqual(['g01', 'g02', 'g03']);
    expect(CAMPAIGN.filter((m) => m.script.campaignFinale).map((m) => m.id)).toEqual([]);
    expect(TRAINING).toHaveLength(7);
    for (const c of CAMPAIGNS) {
      c.missions.forEach((m, i) => {
        expect(m.kind).toBe('campaign');
        expect(m.index).toBe(i + 1);
      });
    }
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

  it('campaign and training are set in Auckland', () => {
    for (const m of ALL) expect(m.theater).toBe('auckland');
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

  it('SAM sites and static compounds get terrain pads; ships and boats do not', () => {
    // land SAMs and a hangar (a test fixture: no remaining mission has a land SAM site)
    const base = seadFixture();
    const sead = { ...base, script: { ...base.script, ground: [target('hangar', 'rangi_hangar', 'hangar', P.rangN, { name: 'Hangar' })] } };
    const pads = terrainPadsFor(sead);
    for (const s of [...sead.script.sams, ...sead.script.ground]) expect(pads.some((p) => Math.hypot(p.x - s.x, p.z - s.z) <= p.radius)).toBe(true);
    // g02: the tanker, the boats and the air-defence boats (SAM sites at sea) never raise an island
    const g02 = CAMPAIGN.find((m) => m.id === 'g02')!;
    const atSea = [...g02.script.ground, ...g02.script.sams];
    expect(atSea.length).toBeGreaterThan(0);
    expect(terrainPadsFor(g02)).toEqual([]);
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
    const sead = seadFixture();
    expect(validateMission(sead)).toEqual([]);
    const bad = { ...sead, player: { ...sead.player, x: sead.script.sams[0].x + 2000, z: sead.script.sams[0].z } };
    expect(validateMission(bad).some((e) => e.includes('threat ring'))).toBe(true);
  });

  it('validator catches dangling references', () => {
    const g01 = CAMPAIGN[0];
    const bad = {
      ...g01,
      script: { ...g01.script, objectives: [...g01.script.objectives, { id: 'o_x', kind: 'destroy' as const, groups: ['nope'], label: 'x', primary: false }] },
    };
    expect(validateMission(bad).some((e) => e.includes('unknown group "nope"'))).toBe(true);
  });
});

/** Everything a mission says to the player in words: briefing, objectives, hints, triggered hints and radio calls. */
function playerTexts(m: MissionDef): { at: string; text: string }[] {
  return [
    ...m.briefing.map((text, i) => ({ at: `briefing ${i + 1}`, text })),
    ...m.script.objectives.map((o) => ({ at: o.id, text: o.label })),
    ...(m.script.hints ?? []).map((h) => ({ at: h.id, text: h.text })),
    ...(m.script.triggers ?? []).flatMap((t) => t.actions.flatMap((a) => ('text' in a && typeof a.text === 'string' ? [{ at: t.id, text: a.text }] : []))),
    ...(m.script.opening ?? []).flatMap((a) => ('text' in a && typeof a.text === 'string' ? [{ at: 'opening', text: a.text }] : [])),
  ];
}

/**
 * Does `text` send the player to WPN for `weapon`? WPN cycles (sim/weapons/loadouts.ts), so pressing it
 * for the weapon already on the FIRE button moves off it. A sentence naming the weapon may still say
 * what WPN does ("WPN changes weapon") or how far to press it ("WPN until FIRE reads …").
 */
function sendsToWpnFor(text: string, weapon: Exclude<WeaponId, 'gun'>): boolean {
  const info = WEAPON_INFO[weapon];
  const names = [info.short, info.name.split(' ').at(-1)!];
  return text
    .split(/(?<=[.!?])\s/)
    .some((s) => names.some((n) => s.includes(n)) && /\bWPN\b(?! (changes|until))/.test(s));
}

describe('missions: lesson texts and the weapon the jet already has (playtest r2, 2.1-c)', () => {
  it('no lesson tells the player to tap WPN for the weapon it starts with on any allowed loadout', () => {
    const w = new FakeWorld({ difficulty: 'pilot', terrain: new FlatTerrain(0) });
    for (const m of TRAINING) {
      for (const loadout of m.allowedLoadouts) {
        const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: v3(0, 2000, 0), heading: 0, speed: 200, loadout });
        const start = p.selectedWeapon;
        if (start === 'gun') continue;
        for (const { at, text } of playerTexts(m)) expect(sendsToWpnFor(text, start), `${m.id} ${loadout} (${start}) ${at}: "${text}"`).toBe(false);
      }
    }
  });

  it("T02's last drill: the AIM-9X comes up on its own once the AMRAAMs are gone, so no text sends the player to WPN for it", () => {
    const t02 = missionById('t02')!;
    for (const { at, text } of playerTexts(t02)) expect(sendsToWpnFor(text, 'aim9x'), `${at}: "${text}"`).toBe(false);
  });

  it('the check catches the old wording', () => {
    expect(sendsToWpnFor('Tap WPN to select the StormBreaker (GBU-53 on the button), TGT to designate a boat.', 'gbu53')).toBe(true);
    expect(sendsToWpnFor("StormBreaker (GBU-53 on WPN): release while the rat STOPS at a drain.", 'gbu53')).toBe(true);
    expect(sendsToWpnFor('Last drone, head-on: this one is for the AIM-9X (WPN selects it)', 'aim9x')).toBe(true);
    expect(sendsToWpnFor('Then the AARGM-ER: select it with WPN, designate the SA-6 with TGT.', 'aargm')).toBe(true);
    expect(sendsToWpnFor('Check the FIRE button reads GBU-53, the StormBreaker (WPN changes weapon).', 'gbu53')).toBe(false);
  });
});

describe('missions: one name per threat (playtest r2, 2.1-j)', () => {
  it('texts call a threat what its chip on the map calls it, the designation at most in brackets (#211)', () => {
    for (const m of ALL) {
      for (const { at, text } of playerTexts(m)) {
        expect(text.replace(/Shilka \(ZSU-23-4\)/g, ''), `${m.id} ${at}`).not.toMatch(/ZSU-23-4/);
        expect(text.replace(/SA-15 Tor/g, ''), `${m.id} ${at}`).not.toMatch(/\bTor\b/);
      }
    }
  });
});

describe('missions: instant action generator', () => {
  const modes: InstantActionOptions['mode'][] = ['stroll', 'dogfight', 'sam_gauntlet', 'strike', 'defend'];
  const theaters: TheaterId[] = ['auckland'];

  it('builds a valid mission for every mode × size, in Auckland', () => {
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

  it('dogfight spawns the requested number of bandits of the requested type (scaled by difficulty at run time)', () => {
    const def = buildInstantMission({ mode: 'dogfight', theater: 'auckland', timeOfDay: 'dusk', weather: 'scattered', enemyType: 'su35', enemyCount: 5 });
    const red = def.script.groups.filter((g) => g.team === 'red');
    expect(red.reduce((n, g) => n + g.count, 0)).toBe(5);
    // the runner scales the TOTAL by difficulty.enemyCountScale (i1: IA honours difficulty)
    expect(red.every((g) => g.type === 'su35' && !g.fixedCount)).toBe(true);
    expect(def.script.scaleEnemyTotal).toBe(true);
    expect(def.timeOfDay).toBe('dusk');
  });

  it('Survival is gone (it rearmed the player between waves; issue #63)', () => {
    expect(missionById('ia_survival_auckland')).toBeNull();
  });

  it('sam gauntlet and strike have ground targets and SAMs', () => {
    for (const mode of ['sam_gauntlet', 'strike'] as const) {
      const def = buildInstantMission({ mode, theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mig29', enemyCount: 4 });
      expect(def.script.ground.length).toBeGreaterThan(0);
      expect(def.script.sams.length).toBeGreaterThan(0);
      expect(def.recommendedLoadout).not.toBe('a2a_beast');
    }
  });

  it('sam gauntlet: the briefing warns of the fighter CAP when there is one (playtest 2026-10-02, 2.1-f)', () => {
    for (const enemyCount of [2, 4, 8]) {
      const def = buildInstantMission({ mode: 'sam_gauntlet', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount });
      const cap = def.script.groups.some((g) => g.id === 'cap');
      expect(/fighters/i.test(def.briefing.join(' ')), `enemyCount ${enemyCount}`).toBe(cap);
    }
  });
});
