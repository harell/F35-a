/**
 * The Auckland Harbour Bridge as a solid (sim/buildings.ts, one hero per span): the player's jet into a span crashes and
 * brings that span down into the harbour, named on the HUD, the radio and in the debrief; the other spans stand; anybody
 * else's aircraft crashes on it and it stands; the clearance under the deck stays open. And the visual
 * (world/scenery/bridgeCollapse.ts): the span's vertices go under the water, the piers and the other spans stay.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { DIFFICULTIES } from '../src/core/data';
import { EventBus, type GameEventMap } from '../src/core/events';
import { HB_MAIN, HB_PIERS, HB_SUPPORTS, hbAt, hbDeck, hbFrame, hbSpanSolids } from '../src/core/harbourBridge';
import { createAiBrain } from '../src/ai';
import { buildInstantMissionSeeded, createMissionRunner } from '../src/missions';
import { crashedInto } from '../src/missions/runtime/reasons';
import { BuildingIndex, buildBuildingGeometry, HARBOUR_BRIDGE_ID, HARBOUR_BRIDGE_MAIN_SPAN, HARBOUR_BRIDGE_SPANS, HERO_BUILDINGS, pointInRing } from '../src/sim/buildings';
import type { SimWorld } from '../src/sim/api';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { initFlight } from '../src/sim/flight/FlightModel';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';
import { LightList } from '../src/world/scenery/builders';
import { buildHarbourBridge } from '../src/world/scenery/harbourBridge';
import { BridgeCollapseVisual, SPAN_FALL_TIME, SPAN_SINK, spanAt, spanDrop } from '../src/world/scenery/bridgeCollapse';
import { FlatTerrain } from './combat-helpers';

const DT = 1 / 60;
const MAIN_ID = HARBOUR_BRIDGE_ID - HARBOUR_BRIDGE_MAIN_SPAN;

function stroll() {
  const def = buildInstantMissionSeeded({ mode: 'stroll', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 4 }, 5);
  const events = new EventBus();
  const world = createSimWorld({ terrain: new FlatTerrain(0), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(1) });
  const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty: DIFFICULTIES.pilot, events });
  runner.setup(world, def.recommendedLoadout);
  const radio: string[] = [];
  const hud: string[] = [];
  const falls: GameEventMap['building:collapsed'][] = [];
  events.on('radio', (e) => radio.push(e.text));
  events.on('hud:message', (e) => hud.push(e.text));
  events.on('building:collapsed', (e) => falls.push(e));
  const tick = (seconds: number) => {
    for (let i = 0; i < seconds * 60; i++) {
      world.step(DT);
      runner.update(world, DT);
    }
  };
  /** Level at `y`, 150 m out square to the bridge at `s` (from the west-north-west), flying across it. */
  const across = (s: number, y: number) => {
    const p = world.player!;
    const [x, z] = hbAt(s, -150);
    p.position.set(x, y, z);
    const [nx, nz] = [hbAt(s, 1)[0] - hbAt(s, 0)[0], hbAt(s, 1)[1] - hbAt(s, 0)[1]];
    initFlight(p, { heading: Math.atan2(nx, -nz), speed: 150 });
  };
  return { world, runner, tick, across, radio, hud, falls };
}

describe('the Harbour Bridge as a solid', () => {
  it('seven spans between the abutments and the piers, each a hero named the Auckland Harbour Bridge', () => {
    const geo = buildBuildingGeometry(() => 0, 40, [])!;
    const spans = geo.buildings.filter((b) => b.hero?.id === 'harbour_bridge');
    expect(spans.map((b) => b.id)).toEqual(Array.from({ length: HARBOUR_BRIDGE_SPANS }, (_, i) => HARBOUR_BRIDGE_ID - i));
    expect(HARBOUR_BRIDGE_SPANS).toBe(7);
    for (const b of spans) {
      expect(b.name).toBe('the Auckland Harbour Bridge');
      expect(b.label).toBe('HARBOUR BRIDGE');
      expect(b.fixed).toBeUndefined();
    }
    // the navigation span is the one between the main piers, and its truss tops out at the measured 64.4 m
    const main = spans[HARBOUR_BRIDGE_MAIN_SPAN];
    expect(hbFrame(main.x, main.z)[0]).toBeGreaterThan(HB_MAIN[0]);
    expect(hbFrame(main.x, main.z)[0]).toBeLessThan(HB_MAIN[1]);
    expect(main.top).toBeGreaterThan(64);
    expect(main.top).toBeLessThan(66);
  });

  it('solid from under the deck up to the parapets along the whole bridge, open water under it', () => {
    // the navigation span's clearance: open 6 m under the road over its middle third
    const main = hbSpanSolids(HARBOUR_BRIDGE_MAIN_SPAN);
    for (let s = HB_MAIN[0] + 80; s < HB_MAIN[1] - 80; s += 5) {
      expect(main.some((p) => hbDeck(s) - 6 >= p.y0 && pointInRing(p.ring, ...hbAt(s, 0)))).toBe(false);
    }
    for (let i = 0; i < HARBOUR_BRIDGE_SPANS; i++) {
      const solids = hbSpanSolids(i);
      const inside = (s: number, t: number, y: number) => solids.some((p) => y >= p.y0 && y <= p.y1 && pointInRing(p.ring, ...hbAt(s, t)));
      for (let s = HB_SUPPORTS[i] + 1; s < HB_SUPPORTS[i + 1]; s += 7) {
        expect(inside(s, 0, hbDeck(s) + 0.5), `road at s=${s.toFixed(0)}`).toBe(true);
        expect(inside(s, 16, hbDeck(s) - 1), `clip-on at s=${s.toFixed(0)}`).toBe(true);
        expect(inside(s, 0, hbDeck(s) - 18), `under the deck at s=${s.toFixed(0)}`).toBe(false);
        expect(inside(s, 30, hbDeck(s)), `beside the deck at s=${s.toFixed(0)}`).toBe(false);
      }
    }
  });
});

describe("the player's jet into the Harbour Bridge", () => {
  it('the navigation span falls: the jet crashes, named on the HUD, the radio and in the debrief; the other spans stand', () => {
    const m = stroll();
    m.tick(1);
    const s = (HB_MAIN[0] + HB_MAIN[1]) / 2;
    m.across(s, hbDeck(s) + 6);
    m.tick(3);
    expect(m.world.player!.alive).toBe(false);
    expect(m.falls).toHaveLength(1);
    expect(m.falls[0]).toMatchObject({ building: MAIN_ID, isPlayer: true, hero: HERO_BUILDINGS.harbour_bridge, label: 'HARBOUR BRIDGE' });
    const idx = m.world.buildings!;
    const down = [...idx.collapsed].map((k) => idx.geo.buildings[k].id);
    expect(down).toEqual([MAIN_ID]);
    expect(m.runner.result(m.world).reason).toBe(crashedInto('the Auckland Harbour Bridge'));
    expect(m.hud).toContain('HARBOUR BRIDGE DESTROYED');
    expect(m.radio.some((t) => t.startsWith('The Auckland Harbour Bridge has been destroyed!'))).toBe(true);
    const strike = m.world.structureStrike!;
    expect(strike.label).toBe('HARBOUR BRIDGE');
    // the death cam frames the span
    expect(strike.radius).toBeGreaterThan(100);
  });

  it('a southern approach span falls on its own', () => {
    const m = stroll();
    m.tick(1);
    const s = (HB_PIERS[1] + HB_PIERS[2]) / 2;
    m.across(s, hbDeck(s));
    m.tick(3);
    const idx = m.world.buildings!;
    expect([...idx.collapsed].map((k) => idx.geo.buildings[k].id)).toEqual([HARBOUR_BRIDGE_ID - 2]);
  });

  it('under the navigation span the jet flies on and the bridge stands', () => {
    const m = stroll();
    m.tick(1);
    const s = (HB_MAIN[0] + HB_MAIN[1]) / 2;
    m.across(s, 25);
    m.tick(3);
    expect(m.world.player!.alive).toBe(true);
    expect(m.falls).toHaveLength(0);
    expect(m.world.buildings!.collapsed.size).toBe(0);
  });

  it('an AI jet into the bridge crashes and the bridge stands', () => {
    const m = stroll();
    m.tick(1);
    const s = (HB_MAIN[0] + HB_MAIN[1]) / 2;
    const [x, z] = hbAt(s, -300);
    const a = m.world.spawnAircraft({ type: 'mig29', team: 'red', position: new Vector3(x, hbDeck(s) + 6, z), heading: Math.atan2(0.88334, -0.46873), speed: 200 });
    a.position.y = hbDeck(s) + 6; // (spawnAircraft lifts a jet to a safe height)
    for (let i = 0; i < 240 && a.alive; i++) m.world.step(DT);
    expect(a.alive, `${a.position.toArray().map(Math.round)}`).toBe(false);
    expect(m.falls).toHaveLength(0);
    expect(m.world.buildings!.collapsed.size).toBe(0);
  });
});

describe('the span falling into the harbour (bridgeCollapse.ts)', () => {
  const B = new GeometryBuilder();
  const lights = new LightList();
  buildHarbourBridge(B, lights, () => -5);
  const geo = B.build()!;
  const pos = geo.getAttribute('position');
  const standing = Float32Array.from(pos.array as Float32Array);
  const geoIdx = buildBuildingGeometry(() => 0, 40, [])!;
  const k = geoIdx.buildings.findIndex((b) => b.id === MAIN_ID);

  it('spanAt: the stretch between two supports, clear of them', () => {
    expect(spanAt((HB_MAIN[0] + HB_MAIN[1]) / 2)).toBe(HARBOUR_BRIDGE_MAIN_SPAN);
    expect(spanAt(HB_PIERS[4])).toBe(-1);
    expect(spanAt(HB_SUPPORTS[0] - 50)).toBe(-1);
    expect(spanDrop(0.5, 0.5)).toBe(0);
    expect(spanDrop(SPAN_FALL_TIME, 0)).toBeCloseTo(SPAN_SINK, 3);
  });

  it('the hit span goes under the water, the piers and the other spans stay; a new world stands it up again', () => {
    const vis = new BridgeCollapseVisual(geo);
    const index = new BuildingIndex(geoIdx);
    index.collapse(k, 10);
    const world = { buildings: index, time: 10 + SPAN_FALL_TIME + 0.1 } as unknown as SimWorld;
    vis.update(world);
    const arr = pos.array as Float32Array;
    let sunk = 0;
    for (let v = 0; v < pos.count; v++) {
      const span = spanAt(hbFrame(arr[v * 3], arr[v * 3 + 2])[0]);
      if (span === HARBOUR_BRIDGE_MAIN_SPAN) {
        expect(arr[v * 3 + 1]).toBeLessThan(0);
        sunk++;
      } else expect(arr[v * 3 + 1]).toBe(standing[v * 3 + 1]);
    }
    expect(sunk).toBeGreaterThan(500);
    vis.update({ buildings: new BuildingIndex(geoIdx), time: 0 } as unknown as SimWorld);
    expect(Array.from(arr)).toEqual(Array.from(standing));
  });
});
