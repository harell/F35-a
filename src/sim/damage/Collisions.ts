/**
 * F35-A — collision detection (SIM-CORE): aircraft vs terrain / sea (crash, wreck impact),
 * mid-air collisions between aircraft (swept closest-approach test over the last step) and
 * aircraft vs landmarks (the Sky Tower: crashes the aircraft; the player's jet is also a hit on the
 * tower, which burns where it went in and comes down on a second hit, like a drone's, #113) and
 * aircraft vs the CBD's skyscrapers (sim/buildings.ts, #128: crashes the aircraft and collapses the building).
 */
import { Vector3 } from 'three';
import type { EventBus } from '../../core/events';
import type { TerrainQuery } from '../api';
import type { AircraftEntity } from '../entities';
import type { BuildingIndex } from '../buildings';
import { firstLandmarkHit, hitLandmark, type LandmarkEntity } from '../landmarks';
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
    /** Events and clock for a jet's hit on a landmark (none: landmarks are never hurt). */
    private readonly host: { readonly events: EventBus; readonly time: number } | null = null,
  ) {}

  update(aircraft: readonly AircraftEntity[], dt: number, landmarks?: readonly LandmarkEntity[], buildings?: BuildingIndex | null): void {
    this.terrainImpacts(aircraft, dt);
    this.midAir(aircraft, dt);
    if (landmarks?.length) this.landmarkImpacts(aircraft, dt, landmarks);
    if (buildings) this.buildingImpacts(aircraft, dt, buildings);
  }

  /**
   * Flying into a CBD skyscraper (#128): any aircraft (the player's jet, AI, drones) is destroyed with
   * its wreck dropping from the impact, and the building collapses ('building:collapsed'). The
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
      buildings.collapse(hit.index);
      this.damage.destroyAircraft(ac, null, 'collision', ac.isPlayer ? 'building' : 'crash');
      ac.velocity.multiplyScalar(-0.08);
      this.host?.events.emit('building:collapsed', {
        building: hit.building.id,
        aircraftId: ac.id,
        isPlayer: ac.isPlayer,
        position: ac.position.clone(),
        x: hit.building.x,
        z: hit.building.z,
        ground: hit.building.ground,
        top: hit.building.top,
      });
    }
  }

  /**
   * Flying into a standing landmark: the aircraft is destroyed (a wreck tumbles down from there). The
   * player's jet is also a hit on the structure (burning at the impact; the second hit brings it
   * down), so a crash into the shaft doesn't leave an unmarked tower; its down reason is 'structure'.
   * (AI aircraft and drones keep the old rule: a drone's warhead is its own hit, drone:impact.)
   */
  private landmarkImpacts(aircraft: readonly AircraftEntity[], dt: number, landmarks: readonly LandmarkEntity[]): void {
    for (let i = 0; i < aircraft.length; i++) {
      const ac = aircraft[i];
      if (!ac.alive || ac.crashed) continue;
      _mid.copy(ac.position).addScaledVector(ac.velocity, -dt);
      const hit = firstLandmarkHit(landmarks, _mid, ac.position, ac.radius * LANDMARK_FACTOR);
      if (!hit) continue;
      ac.position.lerpVectors(_mid, ac.position, hit.s);
      this.damage.destroyAircraft(ac, null, 'collision', ac.isPlayer ? 'structure' : 'crash');
      // the structure stops it dead: the wreck drops from the impact point
      ac.velocity.multiplyScalar(-0.08);
      if (ac.isPlayer && this.host) hitLandmark(hit.landmark, this.host.events, this.host.time, { attackerId: ac.id, point: ac.position });
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
