/**
 * Loadout strike_maritime (#81, #136): the full internal SDB II load, 8× GBU-53/B StormBreaker +
 * 2× AARGM-ER (four bombs and an anti-radiation missile in each bay), for the boat swarm of g02, where
 * the GBU-53/B is the bomb that kills a moving boat. It is offered only by missions that list it in
 * allowedLoadouts (g02 and the free-flight Stroll), so no other mission's balance moves.
 */
import { Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { FrameContext, MissionDef } from '../src/core/contracts';
import { DIFFICULTIES, LOADOUTS, WEAPON_INFO } from '../src/core/data';
import { EventBus } from '../src/core/events';
import { CAMPAIGNS, TRAINING, missionById, validateMission } from '../src/missions';
import { drawSmsPage } from '../src/hud/cockpit/pages';
import { Pen } from '../src/hud/hmd/pen';
import { installPath2D, makeFakeCanvas } from '../src/hud/dev/fakeCanvas';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import type { AircraftEntity, MissileEntity } from '../src/sim/entities';
import { STORE_SIZE, placeStores } from '../src/ui/art/storesDiagram';
import { storeLines } from '../src/ui/format';
import { hangarLoadouts } from '../src/ui/hangar';
import { FlatTerrain } from './combat-helpers';
import { harness } from './missions-helpers';

// the launch tests build a real-sim mission harness: give a loaded box room
vi.setConfig({ testTimeout: 60_000 });
installPath2D();

const FULL = 'strike_maritime' as const;
/** t03 (the strike lesson) as a mission that also lists the maritime load. */
const offering = (): MissionDef => {
  const t03 = missionById('t03')!;
  return { ...t03, allowedLoadouts: [...t03.allowedLoadouts, FULL] };
};

/** What the cockpit stores page (SMS) draws for this jet. */
function smsTexts(p: AircraftEntity): string[] {
  const { ctx } = makeFakeCanvas(512, 512);
  drawSmsPage(new Pen(ctx as unknown as CanvasRenderingContext2D), 0, 0, 480, 480, { ctx: {} as FrameContext, p, flash: false });
  return ctx.texts.map((t) => t.text);
}

describe('strike_maritime: the loadout', () => {
  it('8× GBU-53/B + 2× AARGM-ER, all internal, as stealthy as the clean jet, a strike loadout', () => {
    const l = LOADOUTS[FULL];
    expect(l.id).toBe(FULL);
    expect(l.stores).toEqual([
      { weapon: 'gbu53', count: 8, internal: true },
      { weapon: 'aargm', count: 2, internal: true },
    ]);
    expect(l.rcsMultiplier).toBe(1);
    expect(l.rcsMultiplier).toBe(LOADOUTS.a2a_stealth.rcsMultiplier);
    expect(l.role).toBe('ag');
    // the rest matches the four-bomb StormBreaker loadout (SEAD)
    expect(l.gunAmmo).toBe(LOADOUTS.sead_stealth.gunAmmo);
    expect(l.flares).toBe(LOADOUTS.sead_stealth.flares);
    expect(l.chaff).toBe(LOADOUTS.sead_stealth.chaff);
  });

  it('only g02 and the Stroll offer it: no other campaign, training or Instant Action mission does', () => {
    const instant = ['dogfight', 'sam_gauntlet', 'strike', 'defend'].flatMap((mode) => missionById(`ia_${mode}_auckland`) ?? []);
    expect(instant.length).toBeGreaterThanOrEqual(4);
    expect(missionById('g02')!.allowedLoadouts).toContain(FULL);
    expect(missionById('ia_stroll_auckland')!.allowedLoadouts).toContain(FULL);
    for (const m of [...CAMPAIGNS.flatMap((c) => c.missions), ...TRAINING, ...instant]) {
      if (m.id === 'g02') continue;
      expect(m.allowedLoadouts, m.id).not.toContain(FULL);
      expect(m.recommendedLoadout, m.id).not.toBe(FULL);
      expect(hangarLoadouts(m).cards, m.id).not.toContain(FULL);
    }
  });
});

describe('strike_maritime: a mission that allows it', () => {
  it('validates, and the briefing hangar offers its card', () => {
    const def = offering();
    expect(validateMission(def)).toEqual([]);
    const { cards, initial } = hangarLoadouts(def);
    expect(cards).toContain(FULL);
    expect(initial).toBe(def.recommendedLoadout);
  });

  it('the hangar card lists 8× GBU-53/B and 2× AGM-88G AARGM-ER in the bays', () => {
    const names = Object.fromEntries(Object.entries(WEAPON_INFO).map(([k, v]) => [k, v.name]));
    expect(storeLines(LOADOUTS[FULL], names)).toEqual([
      { text: '8× GBU-53/B StormBreaker', internal: true },
      { text: '2× AGM-88G AARGM-ER', internal: true },
    ]);
  });

  it('the hangar store diagram draws all ten in the bays, four bombs and an AARGM-ER a side, none overlapping', () => {
    const placed = placeStores(LOADOUTS[FULL]);
    expect(placed).toHaveLength(10);
    expect(placed.every((p) => p.internal)).toBe(true);
    for (const side of [1, -1]) {
      const mine = placed.filter((p) => Math.sign(p.x) === side);
      expect(mine.filter((p) => p.weapon === 'gbu53'), `side ${side}`).toHaveLength(4);
      expect(mine.filter((p) => p.weapon === 'aargm'), `side ${side}`).toHaveLength(1);
    }
    // each store is its own shape: no two outlines (width × length, as drawn) overlap
    const box = (p: (typeof placed)[number]) => {
      const [len, wid] = STORE_SIZE[p.weapon];
      return { x0: p.x - wid / 2, x1: p.x + wid / 2, y0: p.y - len / 2, y1: p.y + len / 2 };
    };
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = box(placed[i]);
        const b = box(placed[j]);
        const overlap = a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
        expect(overlap, `${placed[i].weapon}@${placed[i].x.toFixed(2)},${placed[i].y.toFixed(2)} vs ${placed[j].weapon}@${placed[j].x.toFixed(2)},${placed[j].y.toFixed(2)}`).toBe(false);
      }
    }
  });

  it('the jet launches with 8 GBU-53/B and 2 AARGM-ER, no AMRAAM, StormBreakers selected', () => {
    const h = harness(offering(), 'pilot', FULL);
    const p = h.world.player!;
    expect(p.loadout).toBe(FULL);
    expect(h.world.combat.remaining(p, 'gbu53')).toBe(8);
    expect(h.world.combat.remaining(p, 'aargm')).toBe(2);
    expect(h.world.combat.remaining(p, 'aim120')).toBe(0);
    expect(h.world.combat.remaining(p, 'gbu31')).toBe(0);
    expect(p.stores.every((s) => s.internal)).toBe(true);
    expect(p.rcsMultiplier).toBe(1);
    expect(p.selectedWeapon).toBe('gbu53');
    expect(p.gunAmmo).toBe(180);
  });

  it('the cockpit stores page shows them: SDB II 8 and AARGM 2 on the stations, QTY of the selected weapon', () => {
    const h = harness(offering(), 'pilot', FULL);
    const p = h.world.player!;
    let texts = smsTexts(p);
    expect(texts).toContain('GBU-53');
    expect(texts).toContain('QTY 8');
    // station boxes: label (first four letters of the HUD name) and count
    expect(texts).toContain('SDB ');
    expect(texts).toContain('8');
    expect(texts).toContain('AARG');
    expect(texts).toContain('2');
    h.world.combat.selectWeapon(p, 'aargm', h.world);
    texts = smsTexts(p);
    expect(texts).toContain('AGM-88G');
    expect(texts).toContain('QTY 2');
  });
});

describe('strike_maritime: all eight StormBreakers release', () => {
  it('eight designated boats, eight releases, then the jet is out of GBU-53/B', () => {
    const w = createSimWorld({ terrain: new FlatTerrain(-20), difficulty: DIFFICULTIES.pilot, events: new EventBus(), combat: createCombatSystemSeeded(5) });
    const boats = Array.from({ length: 8 }, (_, i) =>
      w.spawnGround({ type: 'missile_boat', team: 'red', position: new Vector3((i - 3.5) * 600, 0, 0), heading: 0, name: `Boat ${i + 1}` }),
    );
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, 8_000, 18_000), heading: 0, speed: 250, loadout: FULL });
    const launches: MissileEntity[] = [];
    w.events.on('munition:launch', (e) => launches.push(e.missile));
    const step = (seconds: number, until: () => boolean) => {
      for (let i = 0; i < seconds * 60 && !until(); i++) w.step(1 / 60);
    };
    step(1, () => false);
    for (const [i, boat] of boats.entries()) {
      w.combat.designate(p, boat.id, w);
      w.combat.fire(p, w, 'gbu53', boat.id);
      step(4, () => launches.length > i);
      expect(launches, `bomb ${i + 1}`).toHaveLength(i + 1);
    }
    expect(launches.every((m) => m.def.id === 'gbu53')).toBe(true);
    expect(new Set(launches.map((m) => m.targetId))).toEqual(new Set(boats.map((b) => b.id)));
    expect(w.combat.remaining(p, 'gbu53')).toBe(0);
    expect(w.combat.remaining(p, 'aargm')).toBe(2);
    expect(w.combat.fire(p, w, 'gbu53', boats[0].id)).toBeNull();
  });
});
