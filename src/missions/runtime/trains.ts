/**
 * Civil trains around Auckland (#146; Auckland theatre only, gated with the airliners and ships by
 * deps.civilTraffic): Auckland Transport AM class sets on the East-West, South-City and Onehunga-West
 * lines and KiwiRail container trains between the port and Wiri, on their timetable
 * (sim/civil/rail.ts TrainService, which this module builds and hangs on world.trains for the renderer).
 *
 * The whole network runs 20–50 trains. Only the ones near the player are sim entities: every half
 * second the nearest SIM_MAX within SIM_RANGE of the jet (and not wholly underground) become neutral
 * 'train' ground entities, posed every step from the timetable; one that drifts past SIM_RELEASE, or is
 * crowded out, or goes underground, leaves the world (GroundTargetEntity.despawn) unless the player has
 * it designated or a weapon in flight at it. So a train the player can see on the EOTS or the radar
 * ground map is a contact like a civil ship: off the enemy datalink (known = false), boxed CIV,
 * designatable, hit along its cars. A bomb or missile on it, or enough gun rounds, destroys it: the
 * Callouts module calls the civilian loss (score and rating like any civil kill, never a mission
 * failure); the train stops where it was hit, burns and stays as a wreck for the sortie, and the
 * timetable skips its unit from then on.
 */
import { Vector3 } from 'three';
import { inTunnel, pointAt, TrainService, type TrainUnit, type UnitState } from '../../sim/civil/rail';
import type { GroundTargetEntity } from '../../sim/entities';
import { setQuatFromHPR } from '../../sim/flight/attitude';
import type { MissionState } from './state';

/** Trains within this horizontal distance of the player become sim entities (m)… */
export const SIM_RANGE = 15_000;
/** …and stay until past this one (m). */
export const SIM_RELEASE = 17_000;
/** At most this many train entities at once (the nearest). */
export const SIM_MAX = 12;
/** How often the set of train entities is reviewed (s). */
const REVIEW_PERIOD = 0.5;
/** A wholly underground train's entity sits this far below the track (out of sight, out of reach). */
const UNDERGROUND_DEPTH = 40;

const _st: UnitState = { path: null!, s: 0, v: 0, x: 0, z: 0 };
const _a = { x: 0, z: 0 };
const _b = { x: 0, z: 0 };

export class TrainTraffic {
  service: TrainService | null = null;
  /** Live train entities by unit id. */
  readonly bound = new Map<number, GroundTargetEntity>();
  /** Every train entity spawned this sortie (wrecks included). */
  readonly spawned: GroundTargetEntity[] = [];
  private nextReview = 0;
  private readonly cand: { u: TrainUnit; d: number }[] = [];

  constructor(private readonly s: MissionState) {}

  setup(): void {
    const world = this.s.world;
    this.service = new TrainService({ timeOfDay: this.s.def.timeOfDay, seed: this.s.def.seed ?? 1, height: (x, z) => world.terrain.heightAt(x, z) });
    world.trains = this.service;
    this.nextReview = -1;
    this.update();
  }

  /** Every sim step: pose the train entities, and now and then review which trains are entities. */
  update(): void {
    const svc = this.service;
    const world = this.s.world;
    if (!svc || !world || world.trains !== svc) return;
    const t = world.time;
    for (const [unit, e] of this.bound) {
      if (!e.alive) {
        // destroyed: it stays where it stopped, and the timetable skips it from now on
        svc.wreck(unit, e.train!.cars);
        this.bound.delete(unit);
        continue;
      }
      this.pose(e, svc.units[unit], t);
    }
    if (t >= this.nextReview) {
      this.nextReview = t + REVIEW_PERIOD;
      this.review(t);
    }
  }

  private review(t: number): void {
    const svc = this.service!;
    const world = this.s.world;
    const p = this.s.player ?? world.player;
    if (!p) return;
    const px = p.position.x;
    const pz = p.position.z;
    const cand = this.cand;
    cand.length = 0;
    for (const u of svc.units) {
      if (svc.isWrecked(u.id)) continue;
      svc.state(u, t, _st);
      const d = Math.hypot(_st.x - px, _st.z - pz);
      const range = this.bound.has(u.id) ? SIM_RELEASE : SIM_RANGE;
      if (d > range || this.underground(u, _st)) continue;
      cand.push({ u, d });
    }
    cand.sort((a, b) => a.d - b.d);
    if (cand.length > SIM_MAX) cand.length = SIM_MAX;
    // release the ones no longer wanted (unless the player is working one)
    for (const [unit, e] of this.bound) {
      if (cand.some((c) => c.u.id === unit) || this.pinned(e)) continue;
      e.despawn = true;
      this.bound.delete(unit);
    }
    for (const { u } of cand) if (!this.bound.has(u.id) && this.bound.size < SIM_MAX) this.spawn(u, t);
  }

  /** The whole consist is in a tunnel (its front, middle and back). */
  private underground(u: TrainUnit, st: UnitState): boolean {
    const h = u.length / 2;
    return inTunnel(st.path, st.s) && inTunnel(st.path, st.s + h) && inTunnel(st.path, st.s - h);
  }

  /** Designated by the player, or a weapon in flight at it: keep it in the world. */
  private pinned(e: GroundTargetEntity): boolean {
    const world = this.s.world;
    const p = world.player;
    if (p && (p.radar.designatedId === e.id || p.radar.lockedId === e.id)) return true;
    for (const m of world.missiles) if (m.alive && m.targetId === e.id) return true;
    return false;
  }

  private spawn(u: TrainUnit, t: number): void {
    const world = this.s.world;
    const svc = this.service!;
    svc.state(u, t, _st);
    const e = world.spawnGround({
      type: 'train',
      team: 'neutral',
      position: new Vector3(_st.x, 0, _st.z),
      name: u.name,
      groupId: 'civil-train',
      // drawn by the train renderer (render/traffic/Trains.ts), with every other train of the timetable
      scenery: true,
    });
    e.known = false; // no intel picture: only the player's own EOTS / radar ground map show them
    e.radius = u.length / 2 + 4;
    e.train = { unit: u.id, cars: [] };
    this.pose(e, u, t);
    this.bound.set(u.id, e);
    this.spawned.push(e);
  }

  /** Cars, position (the middle of the cars above ground), heading and velocity from the timetable. */
  private pose(e: GroundTargetEntity, u: TrainUnit, t: number): void {
    const svc = this.service!;
    svc.state(u, t, _st);
    const cars = svc.cars(u, _st, e.train!.cars);
    let n = 0;
    let x = 0;
    let y = 0;
    let z = 0;
    for (const c of cars) {
      if (c.hidden) continue;
      x += c.x;
      y += c.y;
      z += c.z;
      n++;
    }
    if (n > 0) e.position.set(x / n, y / n, z / n);
    else e.position.set(_st.x, svc.railY(_st.x, _st.z) - UNDERGROUND_DEPTH, _st.z);
    pointAt(_st.path, _st.s + 2, _a);
    pointAt(_st.path, _st.s - 2, _b);
    const dx = _a.x - _b.x;
    const dz = _a.z - _b.z;
    const l = Math.hypot(dx, dz) || 1;
    setQuatFromHPR(e.quaternion, Math.atan2(dx, -dz), 0, 0);
    e.velocity.set((dx / l) * _st.v, 0, (dz / l) * _st.v);
    e.speed = _st.v;
  }
}
