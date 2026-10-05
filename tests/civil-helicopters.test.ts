/**
 * Look and life 6/8 (#144): civil helicopters over Auckland — the Westpac Rescue AW169 between Auckland City
 * Hospital's rooftop pad and Waiheke's Onetangi pad, the police "Eagle" orbiting the city, sightseeing H130s from
 * Mechanics Bay — spawned per sortie, flown kinematically between the helipads of the #125 table, civilian but
 * targetable with the airliners' consequences.
 */
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES, QUALITY_PRESETS } from '../src/core/data';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createAiBrain } from '../src/ai';
import { createMissionRunner, missionById } from '../src/missions';
import type { MissionDef } from '../src/core/contracts';
import type { MissionResultExt } from '../src/missions/runtime/resultExt';
import { HELI_SITES, padNear } from '../src/missions/runtime/helicopters';
import { orbitCentre } from '../src/sim/civil/heli';
import { helipad } from '../src/core/sites';
import { civilLossRows } from '../src/ui/screens/debrief';
import { AIRCRAFT_SPECS } from '../src/render/models/specs';
import { getAircraftPrototype } from '../src/render/models/aircraft';
import { FlatTerrain } from './combat-helpers';

const DT = 1 / 60;
const ELEV = 7;
const FT = 0.3048;
const KT = 0.514444;

function setup(def: MissionDef, helicopters?: number) {
  const events = new EventBus();
  const world = createSimWorld({ terrain: new FlatTerrain(ELEV), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(1) });
  const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty: DIFFICULTIES.pilot, events, helicopters });
  runner.setup(world, def.recommendedLoadout);
  const radio: string[] = [];
  const hud: string[] = [];
  events.on('radio', (e) => radio.push(e.text));
  events.on('hud:message', (e: { text: string }) => hud.push(e.text));
  const tick = (seconds: number, each?: () => void) => {
    for (let i = 0; i < seconds * 60 && runner.state === 'running'; i++) {
      world.step(DT);
      runner.update(world, DT);
      each?.();
    }
  };
  const helis = () => world.aircraft.filter((a) => a.heli);
  return { world, runner, radio, hud, tick, helis };
}

describe('helicopter traffic', () => {
  it('spawns the rescue, police and sightseeing helicopters: 1 on low, 3 on medium, 4 on high', () => {
    expect([QUALITY_PRESETS.low.helicopters, QUALITY_PRESETS.medium.helicopters, QUALITY_PRESETS.high.helicopters]).toEqual([1, 3, 4]);
    for (const [n, types] of [
      [1, ['aw169']],
      [3, ['aw169', 'bell429', 'h130']],
      [4, ['aw169', 'bell429', 'h130', 'h130']],
    ] as const) {
      const m = setup(missionById('g01')!, n);
      m.tick(1);
      const hs = m.helis();
      expect(hs.map((h) => h.type)).toEqual(types);
      for (const h of hs) {
        expect(h.team).toBe('neutral');
        expect(h.ai).toBeNull();
        expect(m.world.hostilesOf('blue')).not.toContain(h);
        expect(m.world.hostilesOf('red')).not.toContain(h);
      }
      expect(hs[0].callsign).toMatch(/^Westpac Rescue [12]$/);
      if (n > 1) expect(hs[1].callsign).toBe('Eagle');
      m.runner.dispose?.();
    }
  });

  it('takes its pads from the helipad table (#125), at the issue’s positions', () => {
    const ach = helipad(HELI_SITES.hospital.id)!;
    expect(ach.roof).toBe(true);
    const one = padNear(HELI_SITES.onetangi.lat, HELI_SITES.onetangi.lon)!;
    expect(one.area).toBe('waiheke');
    expect(helipad(HELI_SITES.mechanicsBay.id)!.heliport).toBe(true);
    expect(helipad(HELI_SITES.vineyard.id)!.kind).toBe('vineyard');
  });

  it('the rescue helicopter flies Auckland City Hospital → Onetangi → back within a sortie, landing on both pads', () => {
    const m = setup(missionById('ia_stroll_auckland')!);
    m.tick(0.1);
    const rescue = m.helis().find((h) => h.type === 'aw169')!;
    const f = rescue.heli!;
    expect(f.pads.map((p) => p.id)).toEqual([HELI_SITES.hospital.id, padNear(HELI_SITES.onetangi.lat, HELI_SITES.onetangi.lon)!.id]);
    let maxY = 0;
    let maxV = 0;
    m.tick(20 * 60, () => {
      if (f.phase === 'transit') {
        maxY = Math.max(maxY, rescue.position.y);
        maxV = Math.max(maxV, rescue.velocity.length());
      }
    });
    // (a free flight never ends)
    expect(m.runner.state).toBe('running');
    expect(f.touchdowns.length).toBeGreaterThanOrEqual(2);
    const [island, home] = f.touchdowns;
    const one = padNear(HELI_SITES.onetangi.lat, HELI_SITES.onetangi.lon)!;
    const ach = helipad(HELI_SITES.hospital.id)!;
    expect(island.pad).toBe(one.id);
    expect(Math.hypot(island.x - one.x, island.z - one.z)).toBeLessThan(20);
    expect(home.pad).toBe(ach.id);
    expect(Math.hypot(home.x - ach.x, home.z - ach.z)).toBeLessThan(20);
    // back on the hospital roof within a sortie (12 min), on its roof (the LiDAR height), not the ground
    expect(home.t).toBeLessThan(12 * 60);
    expect(island.t).toBeLessThan(home.t);
    // cruising at ≈ 1,500 ft and ≈ 135 kt
    expect(maxY).toBeGreaterThan(1400 * FT);
    expect(maxY).toBeLessThan(1600 * FT);
    expect(maxV).toBeLessThan(140 * KT);
    expect(maxV).toBeGreaterThan(125 * KT);
    m.runner.dispose?.();
  }, 120_000);

  it('the police helicopter orbits its point of interest at 1,000–1,500 ft; the sightseeing one lands at the vineyard', () => {
    const m = setup(missionById('ia_stroll_auckland')!);
    m.tick(0.1);
    const eagle = m.helis().find((h) => h.type === 'bell429')!;
    const tour = m.helis().find((h) => h.type === 'h130')!;
    m.tick(90);
    const o = eagle.heli!.orbit!;
    let worst = 0;
    m.tick(240, () => {
      const c = orbitCentre(eagle.heli!);
      worst = Math.max(worst, Math.abs(Math.hypot(eagle.position.x - c.x, eagle.position.z - c.z) - o.radius));
      expect(eagle.position.y).toBeGreaterThan(950 * FT);
      expect(eagle.position.y).toBeLessThan(1550 * FT);
    });
    expect(worst).toBeLessThan(250);
    const vineyard = helipad(HELI_SITES.vineyard.id)!;
    m.tick(10 * 60);
    const t = tour.heli!.touchdowns.find((d) => d.pad === vineyard.id)!;
    expect(t).toBeDefined();
    expect(Math.hypot(t.x - vineyard.x, t.z - vineyard.z)).toBeLessThan(20);
    m.runner.dispose?.();
  }, 120_000);
});

describe('civilian, but targetable', () => {
  it('a player shoot-down is a civilian loss, not a kill, and the mission goes on; the wreck falls', () => {
    const m = setup(missionById('g01')!);
    m.tick(1);
    const p = m.world.player!;
    const heli = m.helis()[0];
    m.world.applyDamage(heli, 10_000, p.id, 'gun');
    m.tick(1);
    expect(heli.alive).toBe(false);
    expect(m.runner.state).toBe('running');
    const r = m.runner.result(m.world) as MissionResultExt;
    expect(r.kills.air).toBe(0);
    expect(p.kills).toBe(0);
    expect(r.civilianKills).toBe(1);
    expect(r.civilianHeliKills).toBe(1);
    expect(m.radio.some((t) => /check fire/i.test(t) && /civilian/i.test(t))).toBe(true);
    expect(civilLossRows(r)).toEqual([['skull', 'Civil helicopters downed', '1']]);
    // the wreck is no longer flown by its profile: it falls
    const y0 = heli.position.y;
    m.tick(3);
    expect(heli.position.y).toBeLessThan(y0);
    m.runner.dispose?.();
  });
});

describe('helicopter models', () => {
  it('builds each type low poly, with spinning rotors and the Eagle’s night searchlight', () => {
    for (const t of ['aw169', 'bell429', 'h130'] as const) {
      const proto = getAircraftPrototype(t);
      expect(proto.triangles).toBeGreaterThan(150);
      expect(proto.triangles).toBeLessThan(1500);
      expect(proto.drives.map((d) => d.part).sort()).toEqual(['rotor', 'tailrotor']);
      expect(proto.lod0.getObjectByName('pivot:rotor')).toBeDefined();
      expect(proto.lod1.getObjectByName('rotor-disc')).toBeDefined();
      expect(AIRCRAFT_SPECS[t].engines).toEqual([]);
      expect(AIRCRAFT_SPECS[t].lights.length).toBe(4);
      expect(!!proto.lod0.getObjectByName('night:searchlight')).toBe(t === 'bell429');
    }
  });
});
