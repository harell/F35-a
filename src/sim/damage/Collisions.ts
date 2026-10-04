/**
 * F35-A — collision detection (SIM-CORE): aircraft vs terrain / sea (crash, wreck impact),
 * mid-air collisions between aircraft (swept closest-approach test over the last step) and
 * aircraft vs landmarks and buildings (sim/landmarks.ts, sim/buildings.ts).
 *
 * The rule for the 3D-modelled landmarks (the Sky Tower, Spark Arena, the Auckland Museum): the player's
 * jet flying into one crashes and brings it down at once; it explodes and collapses, and the world
 * records the strike (SimWorld.structureStrike: the death cam frames it, the outro waits for it, the HUD
 * names it). Anybody else's aircraft crashes on it and it stands (a Shahed's warhead is its own hit on
 * the Sky Tower: drone:impact, two bring it down). A CBD skyscraper collapses under any aircraft (#128);
 * the port's cranes never do.
 */
import { Vector3 } from 'three';
import type { EventBus } from '../../core/events';
import { COLLAPSE, headingDir } from '../../core/skyTower';
import type { StructureStrike, TerrainQuery } from '../api';
import type { AircraftEntity } from '../entities';
import { buildingCollapseTime, type BuildingIndex } from '../buildings';
import { destroyLandmark, firstLandmarkHit, type LandmarkEntity } from '../landmarks';
import type { DamageSystem } from './Damage';

/** Height of the aircraft centre above the surface at which it touches down (m). */
const CONTACT_HEIGHT = 1.5;
/** Fraction of the summed bounding radii that counts as a collision (radii are generous). */
const MIDAIR_FACTOR = 0.55;
/** Fraction of an aircraft's bounding radius that pads a landmark's hit volume. */
const LANDMARK_FACTOR = 0.4;

const _mid = new Vector3();
const _p = new Vector3();
const _v = new Vector3();

export class CollisionSystem {
  constructor(
    private readonly terrain: TerrainQuery,
    private readonly damage: DamageSystem,
    /** Events, clock and the strike record for the player's jet bringing a structure down (none: structures are never hurt). */
    private readonly host: { readonly events: EventBus; readonly time: number; structureStrike: StructureStrike | null } | null = null,
  ) {}

  update(aircraft: readonly AircraftEntity[], dt: number, landmarks?: readonly LandmarkEntity[], buildings?: BuildingIndex | null): void {
    this.terrainImpacts(aircraft, dt);
    this.midAir(aircraft, dt);
    if (landmarks?.length) this.landmarkImpacts(aircraft, dt, landmarks);
    if (buildings) this.buildingImpacts(aircraft, dt, buildings);
  }

  /**
   * Flying into a building: the aircraft is destroyed with its wreck dropping from the impact. A CBD
   * skyscraper (#128) collapses under any aircraft; a hero landmark (Spark Arena, the Auckland Museum)
   * only under the player's jet; the port's cranes never. A collapse emits 'building:collapsed'. The
   * player's down reason is 'building'. Live civil traffic flies a scripted airport profile and is
   * exempt, as it is from the terrain.
   */
  private buildingImpacts(aircraft: readonly AircraftEntity[], dt: number, buildings: BuildingIndex): void {
    for (let i = 0; i < aircraft.length; i++) {
      const ac = aircraft[i];
      if (!ac.alive || ac.crashed || ac.civil) continue;
      _mid.copy(ac.position).addScaledVector(ac.velocity, -dt);
      const hit = buildings.firstHit(_mid, ac.position);
      if (!hit) continue;
      ac.position.lerpVectors(_mid, ac.position, hit.s);
      const b = hit.building;
      const collapses = !b.fixed && (!b.hero || ac.isPlayer);
      const time = this.host?.time ?? 0;
      if (collapses) {
        buildings.collapse(hit.index, time);
        // (before the jet's player:down, so the mission names the building in its end reason)
        if (ac.isPlayer && this.host) {
          const h = b.top - b.ground;
          this.host.structureStrike = {
            name: b.hero?.name ?? null,
            label: b.hero?.label ?? null,
            time,
            duration: buildingCollapseTime(h),
            center: new Vector3(b.x, b.ground + h * 0.45, b.z),
            radius: Math.max(b.radius, h * 0.6) + 15,
          };
        }
      }
      this.damage.destroyAircraft(ac, null, 'collision', ac.isPlayer ? 'building' : 'crash');
      ac.velocity.multiplyScalar(-0.08);
      if (!collapses) continue;
      this.host?.events.emit('building:collapsed', {
        building: b.id,
        aircraftId: ac.id,
        isPlayer: ac.isPlayer,
        position: ac.position.clone(),
        x: b.x,
        z: b.z,
        ground: b.ground,
        top: b.top,
        radius: b.radius,
        hero: b.hero ?? null,
      });
    }
  }

  /**
   * Flying into a standing landmark: the aircraft is destroyed (a wreck tumbles down from there). The
   * player's jet brings the Sky Tower down at once (cause 'player', falling away from the jet); its
   * down reason is 'structure'. AI aircraft and drones crash on it and it stands (a drone's warhead is
   * its own hit, drone:impact).
   */
  private landmarkImpacts(aircraft: readonly AircraftEntity[], dt: number, landmarks: readonly LandmarkEntity[]): void {
    for (let i = 0; i < aircraft.length; i++) {
      const ac = aircraft[i];
      if (!ac.alive || ac.crashed) continue;
      _mid.copy(ac.position).addScaledVector(ac.velocity, -dt);
      const hit = firstLandmarkHit(landmarks, _mid, ac.position, ac.radius * LANDMARK_FACTOR);
      if (!hit) continue;
      ac.position.lerpVectors(_mid, ac.position, hit.s);
      const lm = hit.landmark;
      const host = this.host;
      const strike: StructureStrike | null =
        ac.isPlayer && host
          ? { name: `the ${lm.name}`, label: lm.name.toUpperCase(), time: host.time, duration: COLLAPSE.ruinsAt, center: lm.base.clone(), radius: lm.height * 0.7 }
          : null;
      if (strike && host) host.structureStrike = strike;
      _p.copy(_mid);
      this.damage.destroyAircraft(ac, null, 'collision', ac.isPlayer ? 'structure' : 'crash');
      // the structure stops it dead: the wreck drops from the impact point
      ac.velocity.multiplyScalar(-0.08);
      if (!strike || !host) continue;
      destroyLandmark(lm, host.events, host.time, ac.position.clone(), ac.id, null, _p);
      // frame the fall: the standing tower and where it lands, from 40 % along it and a third of the way up
      const [ux, uz] = headingDir(lm.fallHeading);
      strike.center.set(lm.base.x + ux * lm.height * 0.4, lm.base.y + lm.height * 0.35, lm.base.z + uz * lm.height * 0.4);
    }
  }

  private terrainImpacts(aircraft: readonly AircraftEntity[], dt: number): void {
    const terrain = this.terrain;
    for (let i = 0; i < aircraft.length; i++) {
      const ac = aircraft[i];
      // live civil traffic flies a scripted profile (incl. the landing roll on its gear)
      if (ac.crashed || (ac.civil && ac.alive)) continue;
      const pos = ac.position;
      let ground = terrain.surfaceHeightAt(pos.x, pos.z);
      let hit = pos.y - ground <= CONTACT_HEIGHT;
      // Fast movers: also test the middle of the last step so thin ridges are not tunnelled.
      if (!hit) {
        const travel = ac.velocity.length() * dt;
        if (travel > 15) {
          _mid.copy(pos).addScaledVector(ac.velocity, -0.5 * dt);
          const gm = terrain.surfaceHeightAt(_mid.x, _mid.z);
          if (_mid.y - gm <= CONTACT_HEIGHT) {
            pos.copy(_mid);
            ground = gm;
            hit = true;
          }
        }
      }
      if (!hit) continue;
      pos.y = ground + 0.5;
      const water = ground <= 0.05 && terrain.isWater(pos.x, pos.z);
      this.damage.crashAircraft(ac, water);
    }
  }

  private midAir(aircraft: readonly AircraftEntity[], dt: number): void {
    const n = aircraft.length;
    for (let i = 0; i < n; i++) {
      const a = aircraft[i];
      if (a.crashed) continue;
      for (let j = i + 1; j < n; j++) {
        const b = aircraft[j];
        if (b.crashed || (!a.alive && !b.alive)) continue;
        // drones of one swarm converge on the same target: they never collide with each other
        if (a.oneWay && b.oneWay) continue;
        const reach = (a.radius + b.radius) * MIDAIR_FACTOR;
        _p.subVectors(a.position, b.position);
        _v.subVectors(a.velocity, b.velocity);
        const sweep = _v.length() * dt + reach;
        if (Math.abs(_p.x) > sweep || Math.abs(_p.y) > sweep || Math.abs(_p.z) > sweep) continue;
        // closest approach during the last step (t ∈ [−dt, 0])
        const vv = _v.lengthSq();
        let t = vv > 1e-9 ? -_p.dot(_v) / vv : 0;
        if (t > 0) t = 0;
        else if (t < -dt) t = -dt;
        const dx = _p.x + _v.x * t;
        const dy = _p.y + _v.y * t;
        const dz = _p.z + _v.z * t;
        if (dx * dx + dy * dy + dz * dz > reach * reach) continue;
        this.damage.collide(a, b);
      }
    }
  }
}
