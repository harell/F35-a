/**
 * g03's stoat (#200, sim/stoat.ts): its route with stops at the bait stations, its clock (it catches up
 * when spawned late), the alert when targeted, bolting after a near miss; the GBU-53/B against a
 * target too small to track on the move (sim/weapons/small.ts); the model and its poses.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import type { SimWorld } from '../src/sim/api';
import type { GroundTargetEntity, MissileEntity } from '../src/sim/entities';
import { NEAR_MISS, STOAT_STOP, stoatArrival, type StoatSpawn } from '../src/sim/stoat';
import { isSmallGround } from '../src/sim/weapons/small';
import { getGroundPrototype } from '../src/render/models/ground';
import { GroundVisual } from '../src/render/visuals/SiteVisuals';
import { PERISCOPE_PITCH, TAIL_PUFF, stoatNodes } from '../src/render/visuals/stoatPose';
import { podClass, podReadout } from '../src/hud/hmd/pip';
import { groundHudName } from '../src/missions/runtime/names';
import { FlatTerrain } from './combat-helpers';

const DT = 1 / 60;

function world(seed = 1): SimWorld {
  return createSimWorld({ terrain: new FlatTerrain(0), difficulty: DIFFICULTIES.pilot, events: new EventBus(), combat: createCombatSystemSeeded(seed) });
}

function run(w: SimWorld, seconds: number, each?: () => boolean | void): void {
  for (let i = 0; i < seconds * 60; i++) {
    w.step(DT);
    if (each?.()) return;
  }
}

/** A stoat running east from x = 0: stations every 100 m (route points 1–3), the nest at 400 m. */
const ROUTE = (): StoatSpawn => ({
  route: [0, 100, 200, 300, 400].map((x) => new Vector3(x, 0, 0)),
  stations: [1, 2, 3],
  speed: 2.5,
  stopTime: 20,
});

function stoat(w: SimWorld, spec: StoatSpawn = ROUTE()): GroundTargetEntity {
  return w.spawnGround({ type: 'stoat', team: 'red', position: spec.route[0].clone(), name: 'Stoat', stoat: spec });
}

describe('the stoat: route, stops and clock', () => {
  it('is a 0.3 kg target: one hit point, smaller than a bomb can track on the move', () => {
    const w = world();
    const s = stoat(w);
    expect(s.maxHealth).toBe(1);
    expect(s.radius).toBeLessThan(0.5);
    expect(isSmallGround(s)).toBe(true);
    expect(groundHudName('stoat')).toBe('STOAT');
  });

  it('runs to each bait station, stops there for its stop time, and reaches the nest when its clock says', () => {
    const w = world();
    const s = stoat(w);
    const st = s.stoat!;
    const stops: { leg: number; from: number; to: number }[] = [];
    let at = -1;
    run(w, 400, () => {
      if (st.phase === 'stop' && (stops.length === 0 || stops[stops.length - 1].to >= 0)) stops.push({ leg: st.leg, from: w.time, to: -1 });
      if (st.phase !== 'stop' && stops.length && stops[stops.length - 1].to < 0) stops[stops.length - 1].to = w.time;
      if (st.atNest && at < 0) at = w.time;
      return st.atNest;
    });
    expect(stops.map((x) => x.leg)).toEqual([1, 2, 3]);
    for (const x of stops) expect(x.to - x.from).toBeCloseTo(STOAT_STOP, 0);
    // the planned arrival (route at its average dash speed + the stops), give or take a dash
    expect(at).toBeGreaterThan(stoatArrival(ROUTE()) - 6);
    expect(at).toBeLessThan(stoatArrival(ROUTE()) + 6);
    expect(Math.hypot(s.position.x - 400, s.position.z)).toBeLessThan(0.5);
    // stopped: no velocity (the bombs read it)
    expect(s.velocity.length()).toBe(0);
  });

  it('spawned late, it catches up with its clock: where a stoat spawned at the start would be by then', () => {
    const a = world();
    const early = stoat(a);
    run(a, 150);
    const b = world();
    run(b, 150); // nothing yet
    const late = stoat(b);
    run(b, DT);
    expect(Math.hypot(late.position.x - early.position.x, late.position.z - early.position.z)).toBeLessThan(3);
    expect(late.stoat!.leg).toBe(early.stoat!.leg);
  });

  it('designated, it rears up into the periscope stance at its stop; running, it keeps running', () => {
    const w = world();
    const s = stoat(w);
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(-4_000, 1_200, 0), heading: Math.PI / 2, speed: 200, loadout: 'sead_precision' });
    run(w, 5);
    p.radar.designatedId = s.id;
    run(w, DT);
    expect(s.stoat!.targeted).toBe(true);
    expect(s.stoat!.phase).toBe('run'); // still running to the first station
    expect(s.velocity.length()).toBeGreaterThan(0);
    run(w, 60, () => {
      p.radar.designatedId = s.id;
      return s.stoat!.phase === 'stop' && s.stoat!.phaseT > 1;
    });
    expect(s.stoat!.phase).toBe('stop');
    expect(s.stoat!.alert).toBeGreaterThan(0.95);
    // undesignated: it sinks back down
    p.radar.designatedId = null;
    run(w, 2);
    expect(s.stoat!.alert).toBeLessThan(0.1);
  });

  it(`a near miss (within ${NEAR_MISS} m, alive) cuts its stop short and makes it bolt to the next station`, () => {
    const w = world();
    const s = stoat(w);
    run(w, 60, () => s.stoat!.phase === 'stop');
    expect(s.stoat!.phase).toBe('stop');
    const leg = s.stoat!.leg;
    // a weapon of ours that was in flight at it, last seen 20 m off, is gone
    s.stoat!.incoming.set(987_654, new Vector3(s.position.x + 20, 0, s.position.z));
    run(w, DT * 2);
    expect(s.stoat!.phase).toBe('run');
    expect(s.stoat!.bolting).toBe(true);
    expect(s.stoat!.leg).toBe(leg + 1);
    // twice as fast to the next station, where it stops (and calms down)
    const t0 = w.time;
    run(w, 60, () => s.stoat!.phase === 'stop');
    expect(w.time - t0).toBeLessThan(100 / 2.5 / 1.6);
    expect(s.stoat!.bolting).toBe(false);
  });
});

describe('a GBU-53/B against the stoat', { timeout: 60_000 }, () => {
  /** Release one StormBreaker at the stoat from 4 km, 1,200 m up; true when it dies. */
  function drop(spec: StoatSpawn, releaseWhen: (s: GroundTargetEntity) => boolean, seed = 1): { killed: boolean; ranOff: number } {
    const w = world(seed);
    const s = stoat(w, spec);
    const p = w.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(spec.route[0].x - 4_000, 1_200, 0), heading: Math.PI / 2, speed: 230, loadout: 'sead_precision' });
    w.combat.selectWeapon(p, 'gbu53', w);
    run(w, 400, () => releaseWhen(s));
    // keep the jet where it was for the release (a fixed geometry: the bomb's flight time is the test)
    p.position.set(s.position.x - 4_000, 1_200, s.position.z);
    p.velocity.set(230, 0, 0);
    w.combat.designate(p, s.id, w);
    run(w, 0.3);
    const launches: MissileEntity[] = [];
    w.events.on('munition:launch', (e) => {
      if (e.shooter === p) launches.push(e.missile);
    });
    const from = s.position.clone();
    w.combat.fire(p, w, 'gbu53', s.id);
    run(w, 3, () => launches.length > 0);
    expect(launches).toHaveLength(1);
    run(w, 90, () => !launches[0].alive || !s.alive);
    return { killed: !s.alive, ranOff: s.position.distanceTo(from) };
  }

  it('released while it stands at a bait station (stopped long enough), it kills it', () => {
    let kills = 0;
    for (const seed of [1, 2, 3]) {
      const r = drop({ ...ROUTE(), stopTime: 60 }, (s) => s.stoat!.phase === 'stop' && s.stoat!.phaseT > 1, seed);
      if (r.killed) kills++;
    }
    expect(kills).toBe(3);
  });

  it('released while it runs a long leg, the bomb lands where it was and misses', () => {
    let kills = 0;
    let ran = 0;
    for (const seed of [1, 2, 3]) {
      // one long leg, no station before the bomb lands
      const spec: StoatSpawn = { route: [new Vector3(0, 0, 0), new Vector3(2_000, 0, 0)], stations: [], speed: 3 };
      const r = drop(spec, (s) => s.position.x > 30, seed);
      if (r.killed) kills++;
      ran = Math.max(ran, r.ranOff);
    }
    expect(kills).toBe(0);
    expect(ran).toBeGreaterThan(30);
  });
});

describe('the stoat in the HUD and on screen', () => {
  it('the pod reads it as a stoat, with its classification line', () => {
    const w = world();
    const s = stoat(w);
    expect(podReadout(s, false)).toBe('TGT STOAT');
    expect(podClass(s)?.[0]).toBe('HOSTILE · MUSTELA ERMINEA · 0.3 KG');
  });

  it('the model: true scale, a few hundred triangles, posable parts; the periscope stance at full alert; a killed one is gone', () => {
    const proto = getGroundPrototype('stoat');
    let tris = 0;
    proto.root.traverse((o) => {
      const g = (o as { geometry?: { index: unknown; attributes: { position: { count: number } } } }).geometry;
      if (g) tris += g.attributes.position.count / 3;
    });
    expect(tris).toBeGreaterThan(50);
    expect(tris).toBeLessThan(800);
    const v = new GroundVisual(proto);
    const w = world();
    const s = stoat(w);
    const nodes = stoatNodes(v.root)!;
    expect(nodes).not.toBeNull();
    const cam = new Vector3(0, 2, 5);
    v.update(s, 0, DT, cam, 20_000);
    expect(nodes.hips.rotation.x).toBeLessThan(0.5); // running, not rearing
    s.stoat!.phase = 'stop';
    s.stoat!.alert = 1;
    v.update(s, 1, DT, cam, 20_000);
    expect(nodes.hips.rotation.x).toBeCloseTo(PERISCOPE_PITCH, 5);
    expect(nodes.tail.scale.x).toBeCloseTo(TAIL_PUFF, 5);
    s.alive = false;
    expect(v.update(s, 2, DT, cam, 20_000)).toBe(false);
    expect(v.root.visible).toBe(false);
  });
});
