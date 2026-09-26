/**
 * Test harness for the COMBAT module: a small flat-terrain SimWorld with straight-line
 * aircraft motion plus optional per-aircraft controllers (scripted manoeuvres).
 */
import { Vector3 } from 'three';
import { EventBus, type GameEventMap, type GameEventName } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import { G, forwardOf, quatFromHPR, headingOf, elevationOf } from '../src/core/math';
import type { Difficulty, Team } from '../src/core/types';
import type { AircraftSpawn, CombatSystemApi, GroundSpawn, SamSpawn, SimWorld, TerrainQuery } from '../src/sim/api';
import {
  AircraftEntity,
  DecoyEntity,
  GroundTargetEntity,
  MissileEntity,
  SamSiteEntity,
  type AnyEntity,
  type Projectile,
} from '../src/sim/entities';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { TYPE_IR, TYPE_RCS } from '../src/sim/sensors/signatures';

export const DT = 1 / 60;

/** Flat terrain at `height`, optionally with box "walls" (for terrain-masking tests). */
export class FlatTerrain implements TerrainQuery {
  readonly size = 80_000;
  constructor(
    public height = 0,
    public walls: { x0: number; x1: number; z0: number; z1: number; h: number }[] = [],
  ) {}
  heightAt(x: number, z: number): number {
    for (const w of this.walls) if (x >= w.x0 && x <= w.x1 && z >= w.z0 && z <= w.z1) return w.h;
    return this.height;
  }
  surfaceHeightAt(x: number, z: number): number {
    return Math.max(this.heightAt(x, z), 0);
  }
  isWater(): boolean {
    return false;
  }
  lineOfSight(a: Vector3, b: Vector3): boolean {
    const n = 200;
    for (let i = 1; i < n; i++) {
      const f = i / n;
      const x = a.x + (b.x - a.x) * f;
      const y = a.y + (b.y - a.y) * f;
      const z = a.z + (b.z - a.z) * f;
      if (y < this.surfaceHeightAt(x, z)) return false;
    }
    return true;
  }
  raycast(): number {
    return -1;
  }
}

export type Controller = (ac: AircraftEntity, dt: number, world: FakeWorld) => void;

export class FakeWorld implements SimWorld {
  readonly events = new EventBus();
  readonly terrain: TerrainQuery;
  readonly difficulty;
  readonly combat: CombatSystemApi;
  time = 0;
  aircraft: AircraftEntity[] = [];
  missiles: MissileEntity[] = [];
  sams: SamSiteEntity[] = [];
  ground: GroundTargetEntity[] = [];
  decoys: DecoyEntity[] = [];
  projectiles: Projectile[] = [];
  player: AircraftEntity | null = null;
  controllers = new Map<number, Controller>();
  damageLog: { targetId: number; amount: number; attackerId: number | null; weapon: string }[] = [];
  private map = new Map<number, AnyEntity>();
  private seq = 1;
  private steps = 0;

  constructor(opts: { difficulty?: Difficulty; terrain?: TerrainQuery; seed?: number } = {}) {
    this.difficulty = DIFFICULTIES[opts.difficulty ?? 'veteran'];
    this.terrain = opts.terrain ?? new FlatTerrain();
    this.combat = createCombatSystemSeeded(opts.seed ?? 1234);
    for (let i = 0; i < 1500; i++) {
      this.projectiles.push({
        active: false,
        position: new Vector3(),
        velocity: new Vector3(),
        prevPosition: new Vector3(),
        age: 0,
        life: 0,
        team: 'blue',
        shooterId: 0,
        damage: 0,
        tracer: false,
        flak: false,
        calibre: 0.02,
      });
    }
  }

  /** Collect every payload of an event. */
  record<K extends GameEventName>(name: K): GameEventMap[K][] {
    const arr: GameEventMap[K][] = [];
    this.events.on(name, (p) => arr.push(p));
    return arr;
  }

  nextId(): number {
    return this.seq++;
  }
  getEntity(id: number | null | undefined): AnyEntity | null {
    if (id == null) return null;
    return this.map.get(id) ?? null;
  }
  hostilesOf(team: Team): AnyEntity[] {
    return [...this.aircraft, ...this.sams, ...this.ground].filter((e) => e.alive && e.team !== team);
  }

  spawnAircraft(spec: AircraftSpawn): AircraftEntity {
    const ac = new AircraftEntity(this.nextId(), spec.type, spec.team, {
      name: spec.name,
      callsign: spec.callsign,
      rcs: TYPE_RCS[spec.type],
      ir: TYPE_IR[spec.type],
    });
    ac.position.copy(spec.position);
    quatFromHPR(spec.heading, 0, 0, ac.quaternion);
    forwardOf(ac.quaternion, ac.velocity).multiplyScalar(spec.speed);
    ac.isPlayer = !!spec.isPlayer;
    ac.flight.engineRpm = 0.9;
    this.updateFlight(ac);
    if (spec.loadout) this.combat.applyLoadout(ac, spec.loadout);
    else this.combat.applyDefaultLoadout(ac);
    this.aircraft.push(ac);
    this.map.set(ac.id, ac);
    if (ac.isPlayer) this.player = ac;
    return ac;
  }

  spawnSam(spec: SamSpawn): SamSiteEntity {
    const e = new SamSiteEntity(this.nextId(), spec.type, spec.team, { name: spec.name });
    e.position.set(spec.position.x, this.terrain.heightAt(spec.position.x, spec.position.z), spec.position.z);
    if (spec.emcon) {
      e.state = 'emcon';
      e.radarOn = false;
    }
    e.known = !!spec.known;
    this.sams.push(e);
    this.map.set(e.id, e);
    return e;
  }

  spawnGround(spec: GroundSpawn): GroundTargetEntity {
    const e = new GroundTargetEntity(this.nextId(), spec.type, spec.team, { name: spec.name, health: spec.health });
    e.position.set(spec.position.x, this.terrain.heightAt(spec.position.x, spec.position.z), spec.position.z);
    e.emitter = spec.type === 'ewr';
    this.ground.push(e);
    this.map.set(e.id, e);
    return e;
  }

  addMissile(m: MissileEntity): void {
    this.missiles.push(m);
    this.map.set(m.id, m);
  }
  addDecoy(d: DecoyEntity): void {
    this.decoys.push(d);
    this.map.set(d.id, d);
  }
  allocProjectile(): Projectile | null {
    for (const p of this.projectiles) if (!p.active) return p;
    return null;
  }
  applyDamage(target: AnyEntity, amount: number, attackerId: number | null, weapon: string): void {
    this.damageLog.push({ targetId: target.id, amount, attackerId, weapon });
    target.health -= amount;
    if (target.health <= 0 && target.alive) {
      target.alive = false;
      this.events.emit('destroyed', { entity: target, attackerId, weapon: weapon as never });
    }
  }

  private updateFlight(ac: AircraftEntity): void {
    const f = ac.flight;
    f.altitude = ac.position.y;
    f.agl = ac.position.y - this.terrain.surfaceHeightAt(ac.position.x, ac.position.z);
    f.tas = f.ias = ac.velocity.length();
    f.mach = f.tas / 300;
    f.heading = headingOf(ac.velocity);
    f.pitch = elevationOf(ac.velocity);
  }

  step(dt = DT): void {
    this.time += dt;
    this.steps++;
    for (const ac of this.aircraft) {
      if (!ac.alive) continue;
      this.controllers.get(ac.id)?.(ac, dt, this);
      ac.position.addScaledVector(ac.velocity, dt);
      this.updateFlight(ac);
    }
    this.combat.update(this, dt);
    if (this.steps % 120 === 0) {
      this.missiles = this.missiles.filter((m) => m.alive);
      this.decoys = this.decoys.filter((d) => d.alive);
    }
  }

  /** Step until `until()` is true or `seconds` elapse. Returns elapsed seconds. */
  run(seconds: number, until?: () => boolean): number {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      this.step(DT);
      if (until && until()) return (i + 1) * DT;
    }
    return seconds;
  }

  dispose(): void {
    this.aircraft.length = 0;
  }
}

/** Keep an aircraft's orientation aligned with its velocity (wings level). */
export function alignToVelocity(ac: AircraftEntity): void {
  quatFromHPR(headingOf(ac.velocity), elevationOf(ac.velocity), 0, ac.quaternion);
}

const _d = new Vector3();
const _v = new Vector3();

/**
 * Turn the velocity toward a world direction at up to `maxG` (constant speed, optional new speed).
 */
export function steerToward(ac: AircraftEntity, dir: Vector3, maxG: number, dt: number, speed?: number): void {
  const v = speed ?? ac.velocity.length();
  _v.copy(ac.velocity).normalize();
  _d.copy(dir).normalize();
  const angle = Math.acos(Math.max(-1, Math.min(1, _v.dot(_d))));
  const maxTurn = ((maxG * G) / Math.max(50, v)) * dt;
  if (angle > 1e-5) {
    const t = Math.min(1, maxTurn / angle);
    // slerp between directions
    _v.lerp(_d, t).normalize();
    if (angle > 3.1) _v.set(_v.x + 0.01, _v.y, _v.z).normalize();
  }
  ac.velocity.copy(_v).multiplyScalar(v);
  alignToVelocity(ac);
}

export function spawnPair(
  world: FakeWorld,
  shooter: Partial<AircraftSpawn> & Pick<AircraftSpawn, 'type' | 'team' | 'position' | 'heading' | 'speed'>,
  target: Partial<AircraftSpawn> & Pick<AircraftSpawn, 'type' | 'team' | 'position' | 'heading' | 'speed'>,
): { a: AircraftEntity; b: AircraftEntity } {
  const a = world.spawnAircraft(shooter as AircraftSpawn);
  const b = world.spawnAircraft(target as AircraftSpawn);
  return { a, b };
}

export const v3 = (x: number, y: number, z: number) => new Vector3(x, y, z);
