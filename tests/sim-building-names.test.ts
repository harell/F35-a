/**
 * Every building the player's jet can bring down has a name (sim/buildings.ts buildingName): a landmark's, a tower kit
 * tower's, a Scene apartment's, or the OpenStreetMap name or address of the rest (core/cbdBuildingNames.ts). A crash
 * into any of them names it on the HUD ("VERO CENTRE DESTROYED"), on the radio and in the debrief.
 */
import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../src/core/data';
import { EventBus } from '../src/core/events';
import { CBD_TOWERS } from '../src/core/cbdTowersData';
import { CBD_BUILDING_NAMES } from '../src/core/cbdBuildingNames';
import { createAiBrain } from '../src/ai';
import { buildInstantMissionSeeded, createMissionRunner } from '../src/missions';
import { crashedInto } from '../src/missions/runtime/reasons';
import { buildBuildingGeometry, SKYSCRAPER_MIN_HEIGHT, type SolidBuilding } from '../src/sim/buildings';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { initFlight } from '../src/sim/flight/FlightModel';
import { FlatTerrain } from './combat-helpers';

const DT = 1 / 60;

describe('building names', () => {
  const geo = buildBuildingGeometry(() => 0)!;

  it('every building that can come down has a name and a HUD label (only the port cranes, which never fall, have none)', () => {
    const unnamed = geo.buildings.filter((b) => !b.name);
    expect(unnamed.every((b) => b.fixed)).toBe(true);
    expect(unnamed.map((b) => b.id).sort((a, b) => b - a)).toEqual([-2, -3, -4, -5, -6, -7, -8, -9]);
    for (const b of geo.buildings) if (b.name) expect(b.label, b.name).toBeTruthy();
  });

  it('the tower kit, the Scene apartments and the OpenStreetMap names all reach the index, each used', () => {
    const names = new Set(geo.buildings.map((b) => b.name));
    // (the tower kit's low landmarks, the Ferry Building and the Chief Post Office, are under the skyscraper height)
    for (const t of CBD_TOWERS) if (t.parts.some((q) => q.h >= SKYSCRAPER_MIN_HEIGHT)) expect(names, t.name).toContain(t.name);
    for (const n of ['Scene One', 'Scene Two', 'Scene Three']) expect(names).toContain(n);
    for (const n of CBD_BUILDING_NAMES) expect(names, n.name).toContain(n.name);
    const street = geo.buildings.find((b) => b.name === 'a building on Symonds Street')!;
    expect(street.label).toBe('SYMONDS ST BUILDING');
    expect(geo.buildings.find((b) => b.name === 'Vero Centre')!.label).toBe('VERO CENTRE');
  });

  it("a crash names the building on the HUD, the radio and in the debrief", () => {
    const def = buildInstantMissionSeeded({ mode: 'stroll', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'mixed', enemyCount: 4 }, 5);
    const events = new EventBus();
    const world = createSimWorld({ terrain: new FlatTerrain(0), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(1) });
    const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty: DIFFICULTIES.pilot, events });
    runner.setup(world, def.recommendedLoadout);
    const hud: string[] = [];
    const radio: string[] = [];
    events.on('hud:message', (e) => hud.push(e.text));
    events.on('radio', (e) => radio.push(e.text));
    const vero: SolidBuilding = world.buildings!.geo.buildings.find((b) => b.name === 'Vero Centre')!;
    const p = world.player!;
    // level at 100 m, 150 m west of it, flying east into it
    p.position.set(vero.x - 150, 100, vero.z);
    initFlight(p, { heading: Math.PI / 2, speed: 150 });
    for (let i = 0; i < 180; i++) {
      world.step(DT);
      runner.update(world, DT);
    }
    expect(p.alive).toBe(false);
    expect(hud).toContain('VERO CENTRE DESTROYED');
    expect(radio.some((t) => t.startsWith('Vero Centre has been destroyed!'))).toBe(true);
    expect(runner.result(world).reason).toBe(crashedInto('Vero Centre'));
    expect(world.structureStrike!.label).toBe('VERO CENTRE');
  });
});
