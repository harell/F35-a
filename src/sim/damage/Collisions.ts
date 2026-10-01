/**
 * F35-A — collision detection (SIM-CORE): aircraft vs terrain / sea (crash, wreck impact),
 * mid-air collisions between aircraft (swept closest-approach test over the last step) and
 * aircraft vs landmarks (the Sky Tower: crashes the aircraft, the tower is unharmed).
 */
import { Vector3 } from 'three';
import type { TerrainQuery } from '../api';
import type { AircraftEntity } from '../entities';
import { firstLandmarkHit, type LandmarkEntity } from '../landmarks';
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
  ) {}

  update(aircraft: readonly AircraftEntity[], dt: number, landmarks?: readonly LandmarkEntity[]): void {
    this.terrainImpacts(aircraft, dt);
    this.midAir(aircraft, dt);
    if (landmarks?.length) this.landmarkImpacts(aircraft, dt, landmarks);
  }

  /** Flying into a standing landmark: the aircraft is destroyed (a wreck tumbles down from there). */
  private landmarkImpacts(aircraft: readonly AircraftEntity[], dt: number, landmarks: readonly LandmarkEntity[]): void {
    for (let i = 0; i < aircraft.length; i++) {
      const ac = aircraft[i];
      if (!ac.alive || ac.crashed) continue;
      _mid.copy(ac.position).addScaledVector(ac.velocity, -dt);
      const hit = firstLandmarkHit(landmarks, _mid, ac.position, ac.radius * LANDMARK_FACTOR);
      if (!hit) continue;
      ac.position.lerpVectors(_mid, ac.position, hit.s);
      this.damage.destroyAircraft(ac, null, 'collision', 'crash');
      // the structure stops it dead: the wreck drops from the impact point
      ac.velocity.multiplyScalar(-0.08);
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
