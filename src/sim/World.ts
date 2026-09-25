/**
 * STUB SimWorld — to be replaced by the SIM-CORE agent.
 * Keeps the exported factory name `createSimWorld`.
 */
import { Vector3 } from 'three';
import type { AircraftSpawn, CreateSimWorld, GroundSpawn, SamSpawn, SimWorld, SimWorldOptions } from './api';
import { AircraftEntity, DecoyEntity, GroundTargetEntity, MissileEntity, SamSiteEntity, type AnyEntity, type Projectile } from './entities';
import { quatFromHPR, forwardOf } from '../core/math';
import type { Team } from '../core/types';

class StubWorld implements SimWorld {
  events; terrain; difficulty; combat;
  time = 0;
  aircraft: AircraftEntity[] = [];
  missiles: MissileEntity[] = [];
  sams: SamSiteEntity[] = [];
  ground: GroundTargetEntity[] = [];
  decoys: DecoyEntity[] = [];
  projectiles: Projectile[] = [];
  player: AircraftEntity | null = null;
  private idSeq = 1;
  constructor(o: SimWorldOptions) {
    this.events = o.events; this.terrain = o.terrain; this.difficulty = o.difficulty; this.combat = o.combat;
  }
  nextId() { return this.idSeq++; }
  getEntity(id: number | null | undefined): AnyEntity | null {
    if (id == null) return null;
    return (this.aircraft.find((e) => e.id === id) ?? this.missiles.find((e) => e.id === id) ?? this.sams.find((e) => e.id === id) ?? this.ground.find((e) => e.id === id) ?? this.decoys.find((e) => e.id === id)) || null;
  }
  hostilesOf(team: Team): AnyEntity[] {
    return [...this.aircraft, ...this.sams, ...this.ground].filter((e) => e.alive && e.team !== team);
  }
  spawnAircraft(s: AircraftSpawn) {
    const ac = new AircraftEntity(this.nextId(), s.type, s.team, { name: s.name, callsign: s.callsign });
    ac.position.copy(s.position);
    quatFromHPR(s.heading, 0, 0, ac.quaternion);
    ac.velocity.copy(forwardOf(ac.quaternion)).multiplyScalar(s.speed);
    ac.isPlayer = !!s.isPlayer; ac.ai = s.ai ?? null; ac.groupId = s.groupId ?? '';
    if (s.loadout) this.combat.applyLoadout(ac, s.loadout); else this.combat.applyDefaultLoadout(ac);
    this.aircraft.push(ac);
    if (ac.isPlayer) this.player = ac;
    return ac;
  }
  spawnSam(s: SamSpawn) {
    const e = new SamSiteEntity(this.nextId(), s.type, s.team, { name: s.name });
    e.position.set(s.position.x, this.terrain.heightAt(s.position.x, s.position.z), s.position.z);
    this.sams.push(e); return e;
  }
  spawnGround(s: GroundSpawn) {
    const e = new GroundTargetEntity(this.nextId(), s.type, s.team, { name: s.name });
    e.position.set(s.position.x, this.terrain.heightAt(s.position.x, s.position.z), s.position.z);
    this.ground.push(e); return e;
  }
  addMissile(m: MissileEntity) { this.missiles.push(m); }
  addDecoy(d: DecoyEntity) { this.decoys.push(d); }
  allocProjectile(): Projectile | null { return null; }
  applyDamage(target: AnyEntity, amount: number) { target.health -= amount; if (target.health <= 0) target.alive = false; }
  step(dt: number) {
    this.time += dt;
    for (const ac of this.aircraft) {
      const v = new Vector3();
      forwardOf(ac.quaternion, v).multiplyScalar(220);
      ac.velocity.copy(v);
      ac.position.addScaledVector(ac.velocity, dt);
      ac.flight.altitude = ac.position.y;
      ac.flight.tas = ac.flight.ias = 220;
    }
    this.combat.update(this, dt);
  }
  dispose() { this.aircraft.length = 0; }
}

export const createSimWorld: CreateSimWorld = (o) => new StubWorld(o);
