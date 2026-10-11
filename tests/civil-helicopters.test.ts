/**
 * Look and life 6/8 (#144): civil helicopters over Auckland, the real fleet on its real routes. Westpac Rescue 1
 * and 2 from Ardmore (Waiheke, Great Barrier), Northland Rescue from Whangārei to Starship, the police Eagle on
 * patrol from Onehunga; one of each, spawned once per sortie part-way round their cycles, flown kinematically
 * between the helipads of the #125 table, civilian but targetable with the airliners' consequences.
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
import { HELI_SITES, HelicopterTraffic, padNear } from '../src/missions/runtime/helicopters';
import { cycleSeconds, cyclePads, orbitCentre, placeHeli, stepHeli, type HeliFlight, type HeliLiveryId, type HeliPatrol } from '../src/sim/civil/heli';
import { HELI_LIVERIES, heliDecals } from '../src/render/models/aircraft/helicopters';
import type { AircraftEntity } from '../src/sim/entities';
import { helipad } from '../src/core/sites';
import { civilLossRows } from '../src/ui/screens/debrief';
import { entityLabel, killText, trackLabel, trackShort } from '../src/hud/hmd/format';
import { pipName } from '../src/hud/hmd/pip';
import { AIRCRAFT_SPECS } from '../src/render/models/specs';
import { getAircraftPrototype } from '../src/render/models/aircraft';
import { FlatTerrain } from './combat-helpers';
import { Matrix4, Vector3, type InstancedMesh } from 'three';
import { HeliBatch, mergedHelicopter } from '../src/render/visuals/HeliBatch';

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

/** Fly a flight alone on the flat terrain for `seconds` (the profile only, no world): fast. */
function fly(f: HeliFlight, seconds: number, each?: (ac: AircraftEntity) => void, warmup = 0) {
  const w = createSimWorld({ terrain: new FlatTerrain(ELEV), difficulty: DIFFICULTIES.pilot, events: new EventBus(), combat: createCombatSystemSeeded(1) });
  const ac = w.spawnAircraft({ type: f.role === 'police' ? 'bell429' : 'aw169', team: 'neutral', position: new Vector3(), heading: 0, speed: 0, ai: null });
  const terrain = new FlatTerrain(ELEV);
  placeHeli(ac, f, terrain, warmup);
  for (let t = 0; t < seconds; t += 0.25) {
    stepHeli(ac, 0.25, terrain);
    each?.(ac);
  }
  return ac;
}

/** The fleet a sortie plans (on the flat terrain), by livery. */
function plan(seed = 7) {
  const m = setup({ ...missionById('ia_stroll_auckland')!, seed }, 4);
  // the runner's own traffic, planned afresh (each plan call draws new flights from the sortie's rng)
  const traffic = (m.runner as unknown as { helicopters: HelicopterTraffic }).helicopters;
  const specs = traffic.plan(m.world.terrain);
  m.runner.dispose?.();
  return Object.fromEntries(specs.map((h) => [h.livery, h]));
}

const PAD = (id: string) => helipad(id)!;

describe('helicopter traffic', () => {
  it('spawns the real fleet, one of each, never more: 1 on low, 3 on medium, 4 on high', () => {
    expect([QUALITY_PRESETS.low.helicopters, QUALITY_PRESETS.medium.helicopters, QUALITY_PRESETS.high.helicopters]).toEqual([1, 3, 4]);
    for (const [n, callsigns] of [
      [1, ['Westpac Rescue 1']],
      [3, ['Westpac Rescue 1', 'Police Eagle', 'Northland Rescue']],
      [4, ['Westpac Rescue 1', 'Police Eagle', 'Northland Rescue', 'Westpac Rescue 2']],
      [9, ['Westpac Rescue 1', 'Police Eagle', 'Northland Rescue', 'Westpac Rescue 2']],
    ] as const) {
      const m = setup(missionById('g01')!, n);
      m.tick(1);
      const hs = m.helis();
      expect(hs.map((h) => h.callsign)).toEqual(callsigns);
      expect(new Set(hs.map((h) => h.heli!.livery)).size).toBe(hs.length);
      for (const h of hs) {
        expect(h.type).toBe(h.callsign === 'Police Eagle' ? 'bell429' : 'aw169');
        expect(h.team).toBe('neutral');
        expect(h.ai).toBeNull();
        expect(m.world.hostilesOf('blue')).not.toContain(h);
        expect(m.world.hostilesOf('red')).not.toContain(h);
      }
      m.runner.dispose?.();
    }
  });

  it('shows each by its real name on the HUD: the designated box, the contact box, the kill feed', () => {
    const m = setup(missionById('ia_stroll_auckland')!, 4);
    m.tick(0.1);
    const by = (cs: string) => m.helis().find((h) => h.callsign === cs)!;
    expect(entityLabel(by('Westpac Rescue 1'))).toBe('WESTPAC RESCUE 1');
    expect(entityLabel(by('Westpac Rescue 2'))).toBe('WESTPAC RESCUE 2');
    expect(entityLabel(by('Northland Rescue'))).toBe('NORTHLAND RESCUE');
    expect(entityLabel(by('Police Eagle'))).toBe('POLICE EAGLE');
    expect(trackLabel(by('Police Eagle'))).toBe('POLICE EAGLE');
    expect(trackShort(by('Police Eagle'))).toBe('EAGLE');
    expect(trackShort(by('Westpac Rescue 2'))).toBe('WESTPAC 2');
    expect(pipName(by('Westpac Rescue 1'))).toBe('WESTPAC RESCUE 1 AW169');
    expect(killText(by('Police Eagle'))).toBe('SPLASH POLICE EAGLE');
    m.runner.dispose?.();
  });

  it('flies the real routes between real pads: Ardmore, Onetangi, the hospital roof, Onehunga, Whangārei, Great Barrier', () => {
    const ach = PAD(HELI_SITES.hospital.id);
    expect(ach.roof).toBe(true);
    expect(PAD(HELI_SITES.ardmore.id).site).toBe('Ardmore Aerodrome');
    expect(PAD(HELI_SITES.onehunga.id).site).toBe('Auckland Heliport');
    const one = padNear(HELI_SITES.onetangi.lat, HELI_SITES.onetangi.lon)!;
    expect(one.area).toBe('waiheke');
    const p = plan();
    const ids = (l: string) => cyclePads(p[l].flight).map((x) => x.id);
    expect(ids('westpac1')).toEqual([HELI_SITES.ardmore.id, one.id, ach.id]);
    expect(ids('westpac2')).toEqual([HELI_SITES.ardmore.id, 'great_barrier_claris', ach.id]);
    expect(ids('northland')).toEqual(['whangarei_hospital', ach.id]);
    expect(ids('eagle')).toEqual([HELI_SITES.onehunga.id]);
    expect(p.eagle.flight.stops.some((st) => 'patrol' in st)).toBe(true);
    // the off-map pads are where they really are: Whangārei ≈ 125 km north, Great Barrier ≈ 85 km north-east
    const pad = (l: string, id: string) => cyclePads(p[l].flight).find((x) => x.id === id)!;
    const wh = pad('northland', 'whangarei_hospital');
    const gb = pad('westpac2', 'great_barrier_claris');
    expect(Math.hypot(wh.x, wh.z) / 1000).toBeGreaterThan(115);
    expect(wh.z).toBeLessThan(-100_000);
    expect(Math.hypot(gb.x, gb.z) / 1000).toBeGreaterThan(75);
    expect(gb.x).toBeGreaterThan(50_000);
  });

  it('Westpac Rescue 1 lands on each pad of its cycle in order, cruising at ≈ 1,500 ft and ≈ 135 kt', () => {
    const f = plan().westpac1.flight;
    let maxY = 0;
    let maxV = 0;
    fly(f, 2 * cycleSeconds(f), (ac) => {
      if (f.phase === 'transit') {
        maxY = Math.max(maxY, ac.position.y);
        maxV = Math.max(maxV, ac.velocity.length());
      }
    });
    const pads = cyclePads(f);
    const seq = f.touchdowns.map((t) => t.pad);
    expect(seq.length).toBeGreaterThanOrEqual(4);
    // from the base: the island, the hospital, base, the island…
    seq.forEach((id, i) => expect(id).toBe(pads[(i + 1) % pads.length].id));
    for (const t of f.touchdowns) {
      const pd = pads.find((x) => x.id === t.pad)!;
      expect(Math.hypot(t.x - pd.x, t.z - pd.z)).toBeLessThan(20);
    }
    expect(maxY).toBeGreaterThan(1400 * FT);
    expect(maxY).toBeLessThan(1600 * FT);
    expect(maxV).toBeLessThan(140 * KT);
    expect(maxV).toBeGreaterThan(125 * KT);
  });

  it('Northland Rescue and Westpac Rescue 2 fly the whole way to their off-map pads and back', () => {
    const p = plan();
    for (const l of ['northland', 'westpac2']) {
      const f = p[l].flight;
      let far = 0;
      fly(f, 1.5 * cycleSeconds(f), (ac) => (far = Math.max(far, Math.hypot(ac.position.x, ac.position.z))));
      const seq = f.touchdowns.map((t) => t.pad);
      expect(seq).toContain(l === 'northland' ? 'whangarei_hospital' : 'great_barrier_claris');
      expect(seq).toContain(HELI_SITES.hospital.id);
      // well beyond the 88 km map's edge
      expect(far).toBeGreaterThan(70_000);
    }
  });

  it.each([7, 11, 23])('the Eagle patrols at 1,000–1,500 ft round its point of interest, then lands at Onehunga to refuel and goes again (seed %i)', (seed) => {
    const f = plan(seed).eagle.flight;
    const patrol = f.stops.find((st): st is { patrol: HeliPatrol } => 'patrol' in st)!.patrol;
    let worst = 0;
    let orbiting = 0;
    let lifts = 0;
    let last = f.phase;
    fly(f, 2.2 * cycleSeconds(f), (ac) => {
      if (f.phase === 'orbit' && f.timer > 240) {
        orbiting++;
        const c = orbitCentre(f);
        worst = Math.max(worst, Math.abs(Math.hypot(ac.position.x - c.x, ac.position.z - c.z) - patrol.radius));
        expect(ac.position.y).toBeGreaterThan(950 * FT);
        expect(ac.position.y).toBeLessThan(1550 * FT);
      }
      if (last === 'parked' && f.phase === 'liftoff') lifts++;
      last = f.phase;
    });
    expect(orbiting).toBeGreaterThan(0);
    expect(worst).toBeLessThan(250);
    const base = PAD(HELI_SITES.onehunga.id);
    expect(f.touchdowns.length).toBeGreaterThanOrEqual(1);
    for (const t of f.touchdowns) expect(Math.hypot(t.x - base.x, t.z - base.z)).toBeLessThan(20);
    expect(lifts).toBeGreaterThanOrEqual(2);
  });

  it('starts every helicopter at a random point of its cycle: the same for a seed, different across seeds', () => {
    const state = (seed: number) => {
      const m = setup({ ...missionById('ia_stroll_auckland')!, seed }, 4);
      m.tick(0.1);
      const out = m.helis().map((h) => ({ phase: h.heli!.phase, x: Math.round(h.position.x), z: Math.round(h.position.z) }));
      m.runner.dispose?.();
      return out;
    };
    expect(state(3)).toEqual(state(3));
    const runs = [1, 2, 3, 4, 5, 6].map(state);
    // positions vary from sortie to sortie, and over a few sorties some of the fleet is already in the air
    expect(new Set(runs.map((r) => r[0].x)).size).toBeGreaterThan(3);
    expect(runs.flat().some((h) => h.phase !== 'parked')).toBe(true);
    expect(runs.flat().some((h) => h.phase === 'parked')).toBe(true);
  });

  it('a helicopter shot down stays down for the session; a new session brings the whole fleet back', () => {
    const m = setup(missionById('ia_stroll_auckland')!, 4);
    m.tick(1);
    const before = m.helis();
    m.world.applyDamage(before[0], 10_000, m.world.player!.id, 'gun');
    // a wreck falls, crashes and is cleared away; nothing takes its place, however long the session runs
    m.tick(10 * 60);
    expect(before[0].alive).toBe(false);
    expect(m.helis().filter((h) => h.alive).map((h) => h.callsign)).toEqual(['Police Eagle', 'Northland Rescue', 'Westpac Rescue 2']);
    expect(m.helis().length).toBeLessThanOrEqual(4);
    m.runner.dispose?.();
    const again = setup(missionById('ia_stroll_auckland')!, 4);
    again.tick(1);
    expect(again.helis().filter((h) => h.alive).map((h) => h.callsign)).toEqual(['Westpac Rescue 1', 'Police Eagle', 'Northland Rescue', 'Westpac Rescue 2']);
    again.runner.dispose?.();
  });
});

describe('civilian, but targetable', () => {
  it('a player shoot-down is a civilian loss, not a kill, and the mission goes on; the wreck falls', () => {
    const m = setup(missionById('g01')!, 4);
    m.tick(1);
    const p = m.world.player!;
    // one in the air (the fleet starts part-way round its cycles: some are parked), so that its wreck can fall
    while (!m.helis().some((h) => h.heli!.phase === 'transit' || h.heli!.phase === 'orbit')) m.tick(10);
    const heli = m.helis().find((h) => h.heli!.phase === 'transit' || h.heli!.phase === 'orbit')!;
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
  it('builds the shared airframe for both types, with spinning rotors and the Eagle’s night searchlight', () => {
    for (const t of ['aw169', 'bell429'] as const) {
      const proto = getAircraftPrototype(t);
      expect(proto.triangles).toBeGreaterThan(3000);
      expect(proto.triangles).toBeLessThan(8000);
      expect(proto.drives.map((d) => d.part).sort()).toEqual(['rotor', 'tailrotor']);
      expect(proto.lod0.getObjectByName('pivot:rotor')).toBeDefined();
      expect(proto.lod1.getObjectByName('rotor-disc')).toBeDefined();
      expect(AIRCRAFT_SPECS[t].engines).toEqual([]);
      expect(AIRCRAFT_SPECS[t].lights.length).toBe(4);
      expect(!!proto.lod0.getObjectByName('night:searchlight')).toBe(t === 'bell429');
    }
  });

  it('gives every helicopter its own name and registration, one decal atlas row each', () => {
    const regs = Object.values(HELI_LIVERIES).map((l) => l.reg);
    expect(new Set(regs).size).toBe(regs.length);
    expect(HELI_LIVERIES.westpac1.reg).toBe('ZK-HLH');
    expect(HELI_LIVERIES.westpac2.reg).toBe('ZK-IZB');
    const d = heliDecals('aw169')!;
    expect(d.rows).toBe(3);
    expect(new Set(['westpac1', 'westpac2', 'northland'].map((id) => d.row(id as HeliLiveryId))).size).toBe(3);
    expect(heliDecals('bell429')!.rows).toBe(1);
    // both sides of every field
    expect(d.geometry.getAttribute('position').count).toBe(2 * 2 * 6);
  });
});

describe('instanced helicopters (one draw call per type)', () => {
  it('merges each airframe and its rotors into one geometry, the rotors tagged to spin about their hubs', () => {
    for (const t of ['aw169', 'bell429'] as const) {
      const proto = getAircraftPrototype(t);
      expect(proto.instanced).toBe(true);
      const g = mergedHelicopter(proto);
      const spin = g.getAttribute('aSpin');
      const pivot = g.getAttribute('aPivot');
      const pos = g.getAttribute('position');
      expect(spin.count).toBe(pos.count);
      let main = 0;
      let tail = 0;
      for (let i = 0; i < spin.count; i++) {
        if (spin.getW(i) === 0) continue;
        // main rotor: vertical axis through the hub; tail rotor: the lateral axis
        if (Math.abs(spin.getY(i)) > 0.99) main++;
        else if (Math.abs(spin.getX(i)) > 0.99) tail++;
        const r = Math.hypot(pos.getX(i) - pivot.getX(i), pos.getZ(i) - pivot.getZ(i));
        expect(r).toBeLessThan(AIRCRAFT_SPECS[t].span / 2 + 0.5);
      }
      expect(main).toBeGreaterThan(0);
      expect(tail).toBeGreaterThan(0);
    }
  });

  it('draws all three AW169s with one InstancedMesh; the Eagle’s searchlight is one more, at night only', () => {
    const batch = new HeliBatch(getAircraftPrototype);
    const m = new Matrix4();
    batch.begin(1, false);
    for (const l of ['westpac1', 'westpac2', 'northland'] as const) batch.add('aw169', m.makeTranslation(50, 300, 0), true, l);
    batch.add('bell429', m, true, 'eagle');
    batch.end();
    // (node: no canvas, so no decal meshes)
    expect(batch.drawCalls).toBe(2);
    const meshes = batch.group.children.filter((o) => (o as InstancedMesh).isInstancedMesh && o.visible) as InstancedMesh[];
    expect(meshes.find((o) => o.name === 'heli:aw169')!.count).toBe(3);
    batch.begin(2, true);
    batch.add('bell429', m, true, 'eagle');
    batch.add('aw169', m, false, 'westpac1'); // a wreck: drawn, rotors stopped
    batch.end();
    expect(batch.drawCalls).toBe(3); // AW169 + Bell 429 + the Bell's searchlight
    batch.begin(3, false);
    batch.end();
    expect(batch.drawCalls).toBe(0);
    batch.dispose();
  });
});
