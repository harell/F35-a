/**
 * Auckland's trains (#146): the baked network (AT GTFS lines, the port ↔ Wiri freight path), the timetable
 * stepped through whole cycles (stops at the real stations, departures per hour per line, the CRL tunnel,
 * top speeds), the trains near the player as civil sim entities, their hit volume along the cars, and a
 * hit on one counted as a civilian loss that never fails the mission.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES, QUALITY_PRESETS } from '../src/core/data';
import type { MissionDef } from '../src/core/contracts';
import type { TimeOfDay } from '../src/core/types';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createAiBrain } from '../src/ai';
import {
  AM_VMAX,
  CAR_LENGTH,
  FREIGHT_START_WINDOW,
  FREIGHT_VMAX,
  LINE_EW,
  LINE_FREIGHT,
  LINE_OW,
  LINE_SC,
  RAIL_LINES,
  TrainService,
  inTunnel,
  pointAt,
  railNetwork,
  servicePeriod,
  type CarPose,
  type RailPath,
  type TrainUnit,
  type UnitState,
} from '../src/sim/civil/rail';
import { trainHullDistance, vesselSegmentHit } from '../src/sim/civil/vessels';
import { SIM_MAX, SIM_RANGE } from '../src/missions/runtime/trains';
import { createMissionRunner, missionById } from '../src/missions';
import type { MissionResultExt } from '../src/missions/runtime/resultExt';
import { civilLossRows } from '../src/ui/screens/debrief';
import { entityLabel } from '../src/hud/hmd/format';
import { amCarGeometry, dlGeometry, TrainRenderer, wagonGeometry } from '../src/render/traffic/Trains';
import { FlatTerrain } from './combat-helpers';

const DT = 1 / 60;
const net = railNetwork();
const flat = () => 10;
const st = (): UnitState => ({ path: null!, s: 0, v: 0, x: 0, z: 0 });

describe('the baked rail network', () => {
  it('has both directions of the three post-CRL lines and the freight path, in a small data file', () => {
    for (const line of [LINE_EW, LINE_SC, LINE_OW, LINE_FREIGHT]) for (const dir of [0, 1]) expect(net.path(line, dir).length).toBeGreaterThan(20_000);
    expect(net.bytes).toBeLessThan(16_000);
    const names = (l: number, d: number) => net.path(l, d).stops.map((s) => s.name);
    // the East-West line from Swanson to Manukau through the CRL
    expect(names(LINE_EW, 1)[0]).toBe('Swanson');
    expect(names(LINE_EW, 1).at(-1)).toBe('Manukau');
    expect(names(LINE_EW, 1)).toEqual(expect.arrayContaining(['Henderson', 'New Lynn', 'Maungawhau', 'Karanga-a-Hape', 'Te Waihorotiu', 'Waitemata', 'Orakei', 'Panmure', 'Otahuhu', 'Puhinui']));
    // South-City: Pukekohe up to Newmarket, round the CRL and back to Newmarket by Parnell
    expect(names(LINE_SC, 0)[0]).toBe('Pukekohe');
    expect(names(LINE_SC, 0).slice(-6)).toEqual(['Grafton', 'Karanga-a-Hape', 'Te Waihorotiu', 'Waitemata', 'Parnell', 'Newmarket']);
    // Onehunga-West: Onehunga to Henderson by Newmarket and Maungawhau
    expect(names(LINE_OW, 0)[0]).toBe('Onehunga');
    expect(names(LINE_OW, 0).at(-1)).toBe('Henderson');
    expect(names(LINE_OW, 0)).toEqual(expect.arrayContaining(['Penrose', 'Newmarket', 'Grafton', 'Maungawhau', 'Kingsland']));
    expect(names(LINE_FREIGHT, 0)).toEqual(['Ports of Auckland', 'Wiri Inland Port']);
  });

  it('every station on the track is within 20 m of its GTFS stop position', () => {
    const p = { x: 0, z: 0 };
    for (const path of net.paths) {
      if (path.line === LINE_FREIGHT) continue;
      for (const s of path.stops) {
        pointAt(path, s.s, p);
        expect(Math.hypot(p.x - s.gx, p.z - s.gz), `${s.name}`).toBeLessThan(20);
      }
    }
  });

  it('the CRL is underground: its three stations and the track between Maungawhau and Quay Park; Newmarket is not', () => {
    for (const [line, dir] of [
      [LINE_EW, 0],
      [LINE_EW, 1],
      [LINE_SC, 0],
      [LINE_SC, 1],
    ]) {
      const path = net.path(line, dir);
      const at = (n: string) => path.stops.find((s) => s.name === n)!.s;
      for (const n of ['Karanga-a-Hape', 'Te Waihorotiu', 'Waitemata']) expect(inTunnel(path, at(n)), `${line}/${dir} ${n}`).toBe(true);
      // between Te Waihorotiu and Waitematā: all tunnel
      const a = Math.min(at('Te Waihorotiu'), at('Waitemata'));
      const b = Math.max(at('Te Waihorotiu'), at('Waitemata'));
      for (let s = a; s <= b; s += 20) expect(inTunnel(path, s)).toBe(true);
      const open = path.stops.find((s) => s.name === (line === LINE_SC ? 'Newmarket' : 'Kingsland'))!;
      expect(inTunnel(path, open.s)).toBe(false);
    }
    // the Western line's stations at Maungawhau and Kingsland are open air, and so is the port's yard
    const ew = net.path(LINE_EW, 1);
    for (const n of ['Maungawhau', 'Kingsland', 'Orakei']) expect(inTunnel(ew, ew.stops.find((s) => s.name === n)!.s), n).toBe(false);
    expect(inTunnel(net.path(LINE_FREIGHT, 0), 200)).toBe(false);
  });
});

/** Step a unit through `seconds` from `t0`; dwells (≥ 20 s stopped) by where the consist's middle stood. */
function dwells(svc: TrainService, u: TrainUnit, t0: number, seconds: number): { t: number; x: number; z: number; path: RailPath; s: number }[] {
  const out: { t: number; x: number; z: number; path: RailPath; s: number }[] = [];
  const s = st();
  let since = -1;
  for (let t = t0; t <= t0 + seconds; t += 1) {
    svc.state(u, t, s);
    if (s.v < 1e-6) {
      if (since < 0) since = t;
      if (t - since === 20) out.push({ t, x: s.x, z: s.z, path: s.path, s: s.s });
    } else since = -1;
  }
  return out;
}

describe('the timetable', () => {
  it('passenger trains stop at the real stations (the consist’s middle within 20 m of the GTFS stop), every one of them', () => {
    const svc = new TrainService({ timeOfDay: 'day', seed: 3, height: flat });
    for (const line of [LINE_EW, LINE_SC, LINE_OW]) {
      const u = svc.units.find((x) => x.line === line)!;
      const ds = dwells(svc, u, 0, u.period);
      const served = new Set<string>();
      for (const d of ds) {
        const near = d.path.stops.map((s) => ({ s, d: Math.hypot(s.gx - d.x, s.gz - d.z) })).sort((a, b) => a.d - b.d)[0];
        expect(near.d, `${u.name} at ${near.s.name}`).toBeLessThan(20);
        served.add(near.s.name);
      }
      // every station of both directions is served round the cycle (a terminus while the train lays over there)
      for (const dir of [0, 1]) for (const s of net.path(line, dir).stops) expect(served.has(s.name), `${line}/${dir} ${s.name}`).toBe(true);
    }
  });

  it('stands ~30 s at an intermediate station, and its trips take the GTFS time (± 2 min)', () => {
    const svc = new TrainService({ timeOfDay: 'day', seed: 5, height: flat });
    for (const u of svc.units.filter((x) => x.line !== LINE_FREIGHT)) {
      for (const plan of [u.a, u.b]) {
        const gtfs = plan.path.stops.at(-1)!.t;
        expect(Math.abs(plan.duration - gtfs)).toBeLessThan(120);
        for (let i = 1; i < plan.runs.length; i++) expect(plan.runs[i].t0 - (plan.runs[i - 1].t0 + plan.runs[i - 1].T)).toBeCloseTo(30, 6);
      }
    }
  });

  const departuresPerHour = (tod: TimeOfDay, line: number, dir: number): number => {
    const svc = new TrainService({ timeOfDay: tod, seed: 11, height: flat });
    const s = st();
    let n = 0;
    const T = 3 * 3600;
    for (const u of svc.units.filter((x) => x.line === line)) {
      let prev = 0;
      for (let t = 1000; t < 1000 + T; t += 2) {
        svc.state(u, t, s);
        // leaving the first stop of this direction
        if (s.path.dir === dir && prev < 1e-6 && s.v > 0 && Math.abs(s.s - s.path.stops[0].s) < 5) n++;
        prev = s.v;
      }
    }
    return n / 3;
  };

  it('runs each line’s GTFS frequency, both ways: peak at dawn and dusk, off-peak by day, the evening service at night', () => {
    for (const tod of ['dawn', 'day', 'dusk', 'night'] as TimeOfDay[]) {
      for (const L of RAIL_LINES) for (const dir of [0, 1]) expect(departuresPerHour(tod, L.id, dir), `${L.name} ${tod} dir ${dir}`).toBeCloseTo(L.perHour[servicePeriod(tod)], 0);
    }
    expect(servicePeriod('dawn')).toBe('peak');
    expect(servicePeriod('day')).toBe('offpeak');
    expect(servicePeriod('night')).toBe('evening');
    // East-West: 8 an hour each way at peak, 4 off-peak; Onehunga-West 2
    expect(RAIL_LINES[LINE_EW].perHour).toEqual({ peak: 8, offpeak: 4, evening: 2 });
    expect(RAIL_LINES[LINE_SC].perHour).toEqual({ peak: 6, offpeak: 4, evening: 2 });
    expect(RAIL_LINES[LINE_OW].perHour.offpeak).toBe(2);
  });

  it('3- and 6-car AM sets (72 m and 144 m), at most 110 km/h; freight at most 80 km/h, leaving within the first 15 min', () => {
    const svc = new TrainService({ timeOfDay: 'dawn', seed: 2, height: flat });
    const pass = svc.units.filter((u) => u.line !== LINE_FREIGHT);
    expect(new Set(pass.map((u) => u.cars.length))).toEqual(new Set([3, 6]));
    for (const u of pass) expect(u.length).toBeCloseTo(u.cars.length === 3 ? 72.03 : 144.18, 0);
    const s = st();
    const vmax = (u: TrainUnit, T: number, dt: number) => {
      let m = 0;
      for (let t = 0; t < T; t += dt) m = Math.max(m, svc.state(u, t, s).v);
      return m;
    };
    for (const u of pass.slice(0, 6)) expect(vmax(u, u.period, 5)).toBeLessThanOrEqual(AM_VMAX + 1e-6);
    const freight = svc.units.filter((u) => u.line === LINE_FREIGHT);
    expect(freight).toHaveLength(2);
    for (const f of freight) {
      expect(f.cars[0].kind).toBe('dl');
      expect(f.length).toBeGreaterThan(380);
      expect(svc.state(f, 0, s).v).toBe(0); // standing at the start…
      expect(vmax(f, FREIGHT_START_WINDOW + 60, 1)).toBeGreaterThan(5); // …and leaving within the window
      expect(vmax(f, 4 * 3600, 5)).toBeLessThanOrEqual(FREIGHT_VMAX + 1e-6);
    }
    // one from the port, one from Wiri
    expect(new Set(freight.map((f) => svc.state(f, 0, s).path.dir))).toEqual(new Set([0, 1]));
  });

  it('cars follow the track, coupled, and are hidden in the CRL tunnel', () => {
    const svc = new TrainService({ timeOfDay: 'day', seed: 9, height: flat });
    const u = svc.units.find((x) => x.line === LINE_EW && x.cars.length === 6)!;
    const s = st();
    const cars: CarPose[] = [];
    let hiddenSeen = false;
    let shownSeen = false;
    for (let t = 0; t < u.period; t += 7) {
      svc.state(u, t, s);
      svc.cars(u, s, cars);
      expect(cars).toHaveLength(6);
      for (let i = 1; i < cars.length; i++) {
        const gap = Math.hypot(cars[i].x - cars[i - 1].x, cars[i].z - cars[i - 1].z);
        expect(gap).toBeLessThan((CAR_LENGTH[cars[i].kind] + CAR_LENGTH[cars[i - 1].kind]) / 2 + 0.5);
        expect(gap).toBeGreaterThan(18); // a chord on the tightest curves
      }
      const tun = inTunnel(s.path, s.s);
      if (tun) hiddenSeen ||= cars.some((c) => c.hidden);
      else shownSeen ||= cars.every((c) => !c.hidden);
    }
    expect(hiddenSeen && shownSeen).toBe(true);
  });

  it('the same sortie (seed, time of day) runs the same timetable; another seed shifts it', () => {
    const a = new TrainService({ timeOfDay: 'day', seed: 4, height: flat });
    const b = new TrainService({ timeOfDay: 'day', seed: 4, height: flat });
    const c = new TrainService({ timeOfDay: 'day', seed: 5, height: flat });
    expect(a.units.map((u) => u.phase0)).toEqual(b.units.map((u) => u.phase0));
    expect(a.units.map((u) => u.phase0)).not.toEqual(c.units.map((u) => u.phase0));
  });
});

describe('train hit volume', () => {
  const body = { unit: 0, cars: [{ kind: 'am_end', x: 0, y: 2, z: 0, heading: Math.PI / 2, pitch: 0, hidden: false, tint: 0 }] as CarPose[] };
  it('is the car itself: 24 m long, 2.8 m wide, 4 m tall, along its heading', () => {
    expect(trainHullDistance(body, new Vector3(10, 4, 0))).toBe(0); // inside, 10 m along (heading east)
    expect(trainHullDistance(body, new Vector3(0, 4, 3.38))).toBeCloseTo(2, 5); // 2 m off the side
    expect(trainHullDistance(body, new Vector3(14.15, 4, 0))).toBeCloseTo(2, 5); // 2 m past the end
    expect(trainHullDistance(body, new Vector3(0, 8, 0))).toBeCloseTo(2.01, 5); // 2 m over the roof
  });
  it('a gun round across a car hits it; one past it does not; a car in a tunnel cannot be hit', () => {
    const g = { train: body, vessel: null } as never;
    expect(vesselSegmentHit(g, new Vector3(0, 30, -15), new Vector3(0, 0, 3))).toBeGreaterThan(0);
    expect(vesselSegmentHit(g, new Vector3(0, 30, -15), new Vector3(0, 0, -6))).toBe(-1);
    const under = { unit: 0, cars: [{ ...body.cars[0], hidden: true }] };
    expect(trainHullDistance(under, new Vector3(0, 3, 0))).toBe(Infinity);
  });
});

describe('trains in missions', () => {
  function setup(def: MissionDef, civilTraffic?: boolean) {
    const events = new EventBus();
    const world = createSimWorld({ terrain: new FlatTerrain(-20), difficulty: DIFFICULTIES.pilot, events, combat: createCombatSystemSeeded(1) });
    const runner = createMissionRunner(def, { createAi: createAiBrain, difficulty: DIFFICULTIES.pilot, events, civilTraffic } as never);
    runner.setup(world, def.recommendedLoadout);
    const radio: string[] = [];
    const hud: string[] = [];
    events.on('radio', (e) => radio.push(e.text));
    events.on('hud:message', (e) => hud.push(e.text));
    const tick = (seconds: number) => {
      for (let i = 0; i < seconds * 60; i++) {
        world.step(DT);
        runner.update(world, DT);
      }
    };
    const trains = () => world.ground.filter((g) => g.type === 'train');
    /** Park the jet high over Newmarket, in the middle of the network. */
    const overNewmarket = () => {
      const p = world.player!;
      p.position.set(1480, 3000, 2350);
    };
    return { world, runner, radio, hud, tick, trains, overNewmarket };
  }

  it('the trains near the player are neutral, unknown sim entities (≤ SIM_MAX, within SIM_RANGE), boxed CIV, posed on their timetable', () => {
    const m = setup(missionById('g01')!);
    m.overNewmarket();
    m.tick(2);
    const svc = m.world.trains!;
    expect(svc).toBeTruthy();
    const live = m.trains().filter((g) => g.alive);
    expect(live.length).toBeGreaterThan(0);
    expect(live.length).toBeLessThanOrEqual(SIM_MAX);
    const p = m.world.player!;
    const s = st();
    for (const g of live) {
      expect(g.team).toBe('neutral');
      expect(g.known).toBe(false);
      expect(g.scenery).toBe(true);
      expect(entityLabel(g)).toBe('CIV');
      expect(Math.hypot(g.position.x - p.position.x, g.position.z - p.position.z)).toBeLessThan(SIM_RANGE + 2_500);
      svc.state(svc.units[g.train!.unit], m.world.time, s);
      // the entity is where the timetable has the train (the middle of its cars above ground)
      if (g.train!.cars.every((c) => !c.hidden)) expect(Math.hypot(g.position.x - s.x, g.position.z - s.z)).toBeLessThan(25);
    }
    // a train far away is not an entity, and leaves when the jet does
    p.position.set(-30_000, 3000, -30_000);
    m.tick(1.5);
    expect(m.trains().filter((g) => g.alive)).toHaveLength(0);
    m.runner.dispose?.();
  });

  it('train entities take their ids from the civil range: coming and going, they never shift the mission’s ids', () => {
    const m = setup(missionById('g01')!);
    m.overNewmarket();
    const before = m.world.nextId();
    m.tick(2);
    expect(m.trains().length).toBeGreaterThan(0);
    for (const g of m.trains()) expect(g.id).toBeGreaterThanOrEqual(1_000_000_000);
    // only the mission's own spawns (and munitions) advance the shared sequence, not the trains
    const ids = m.world.ground.filter((g) => g.type !== 'train').map((g) => g.id);
    expect(ids.every((id) => id < 1_000_000_000)).toBe(true);
    expect(m.world.nextId()).toBeLessThan(before + 50);
    m.runner.dispose?.();
  });

  it('no trains with civil traffic switched off', () => {
    const m = setup(missionById('g01')!, false);
    m.overNewmarket();
    m.tick(1);
    expect(m.world.trains ?? null).toBeNull();
    expect(m.trains()).toHaveLength(0);
    m.runner.dispose?.();
  });

  it('player hits one: CIVILIAN TRAIN HIT, check fire, a civilian loss (score, debrief row) that does not fail the mission; it stays a wreck and the timetable skips it', () => {
    const m = setup(missionById('g01')!);
    m.overNewmarket();
    m.tick(2);
    const p = m.world.player!;
    const train = m.trains().find((g) => g.alive && g.train!.cars.some((c) => !c.hidden))!;
    const unit = train.train!.unit;
    m.world.applyDamage(train, 1, p.id, 'gbu53'); // any bomb / missile hit destroys it
    m.tick(1);
    expect(train.alive).toBe(false);
    expect(m.hud).toContain('CIVILIAN TRAIN HIT');
    expect(m.radio.some((t) => /check fire/i.test(t) && t.includes(`civilian train, the ${train.name}`))).toBe(true);
    expect(p.kills).toBe(0);
    // the wreck stays where it stopped, the timetable skips its unit
    const where = train.position.clone();
    expect(m.world.trains!.isWrecked(unit)).toBe(true);
    m.tick(20);
    expect(train.position.distanceTo(where)).toBeLessThan(1e-6);
    expect(m.world.ground).toContain(train);
    expect(m.trains().filter((g) => g.alive && g.train!.unit === unit)).toHaveLength(0);
    expect(m.runner.state).toBe('running'); // never fails the mission
    const r = m.runner.result(m.world) as MissionResultExt;
    expect(r.kills.ground).toBe(0);
    expect(r.civilianKills).toBe(1);
    expect(r.civilianTrainKills).toBe(1);
    expect(civilLossRows(r)).toEqual([['skull', 'Civil trains destroyed', '1']]);
    m.runner.dispose?.();
  });

  it('the gun wears one down: a few rounds on its cars destroy it', () => {
    const m = setup(missionById('g01')!);
    m.overNewmarket();
    m.tick(2);
    const p = m.world.player!;
    const train = m.trains().find((g) => g.alive)!;
    for (let i = 0; i < 4 && train.alive; i++) m.world.applyDamage(train, 90, p.id, 'gun');
    expect(train.alive).toBe(false);
    m.runner.dispose?.();
  });
});

describe('train renderer', () => {
  it('four instanced meshes (one per model), the nearest QualitySettings.trains trains, a few thousand triangles', () => {
    const svc = new TrainService({ timeOfDay: 'dawn', seed: 7, height: flat });
    const r = new TrainRenderer(QUALITY_PRESETS.medium.trains, 'medium');
    expect(Object.keys(r.meshes)).toHaveLength(4);
    const cam = new Vector3(1480, 400, 2350); // over Newmarket
    let most = 0;
    let tris = 0;
    for (let t = 0; t < 1800; t += 30) {
      r.update(svc, t, cam);
      most = Math.max(most, r.drawn);
      tris = Math.max(tris, r.triangles());
    }
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(QUALITY_PRESETS.medium.trains);
    expect(tris).toBeLessThan(15_000);
    for (const g of [amCarGeometry(true), amCarGeometry(false), dlGeometry(), wagonGeometry()]) expect(g.getAttribute('position').count / 3).toBeLessThan(250);
    expect([QUALITY_PRESETS.low.trains, QUALITY_PRESETS.medium.trains, QUALITY_PRESETS.high.trains]).toEqual([4, 8, 14]);
    r.dispose();
  });
});
