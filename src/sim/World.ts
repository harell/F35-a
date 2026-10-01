/**
 * F35-A — simulation world (SIM-CORE). Implements the SimWorld contract (src/sim/api.ts).
 *
 * Owns every entity list, the id → entity map, the projectile pool, spawning, damage,
 * collisions, ground movers and the player's ICAWS warnings. Step order (fixed 60 Hz):
 *
 *   AI brains (20 Hz, staggered) → flight model (120 Hz sub-steps) → combat.update →
 *   ground movers → collisions (+ landmark collapses) → damage over time → warnings → cleanup
 */
import { Vector3 } from 'three';
import type { EventBus } from '../core/events';
import { AIRCRAFT_INFO, SAM_INFO } from '../core/data';
import type { DifficultyParams, GroundTargetType, Team } from '../core/types';
import type {
  AircraftSpawn,
  CombatSystemApi,
  CreateSimWorld,
  GroundSpawn,
  SamSpawn,
  SimWorld,
  SimWorldOptions,
  TerrainQuery,
} from './api';
import {
  AircraftEntity,
  GroundTargetEntity,
  SamSiteEntity,
  type AnyEntity,
  type DecoyEntity,
  type MissileEntity,
  type Projectile,
} from './entities';
import { AIRCRAFT_PERF } from './flight/aircraftData';
import { setQuatFromHPR } from './flight/attitude';
import type { FlightEnv } from './flight/env';
import { ensureSimState, initFlight, stepFlight } from './flight/FlightModel';
import { CollisionSystem } from './damage/Collisions';
import { DamageSystem, type DamageWeapon } from './damage/Damage';
import { GROUND_TARGET_DATA, SAM_SITE_DATA } from './damage/tables';
import { WarningSystem } from './Warnings';
import { stepCivil } from './civil/route';
import { stepLandmarks, type LandmarkEntity } from './landmarks';

/** Size of the pooled bullet / shell array. */
export const PROJECTILE_POOL_SIZE = 800;
/** AI brains run at 20 Hz. */
const AI_INTERVAL = 1 / 20;
/** Wrecks are removed this long after hitting the ground (s)… */
const WRECK_GROUND_TIME = 20;
/** …or this long after destruction if they never land (s). */
const WRECK_MAX_TIME = 120;
/** Aircraft never spawn lower than this above the surface (m). */
const MIN_SPAWN_AGL = 60;
/** Default driving speeds (m/s) for ground movers without an explicit speed. */
const DEFAULT_MOVER_SPEED: Partial<Record<GroundTargetType, number>> = { truck: 12, tank: 7, ship: 8 };
const GROUND_NAMES: Record<GroundTargetType, string> = {
  ewr: 'EW Radar',
  bunker: 'Command Bunker',
  fuel: 'Fuel Depot',
  hangar: 'Hangar',
  parked_jet: 'Parked Jet',
  truck: 'Truck',
  tank: 'Tank',
  ship: 'Corvette',
  factory: 'Factory',
  bridge: 'Bridge',
};

function createProjectile(): Projectile {
  return {
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
    calibre: 0.025,
  };
}

class SimWorldImpl implements SimWorld {
  readonly events: EventBus;
  readonly terrain: TerrainQuery;
  readonly difficulty: DifficultyParams;
  readonly combat: CombatSystemApi;
  time = 0;

  readonly aircraft: AircraftEntity[] = [];
  readonly missiles: MissileEntity[] = [];
  readonly sams: SamSiteEntity[] = [];
  readonly ground: GroundTargetEntity[] = [];
  readonly decoys: DecoyEntity[] = [];
  readonly landmarks: LandmarkEntity[] = [];
  readonly projectiles: Projectile[] = [];
  player: AircraftEntity | null = null;

  private idSeq = 1;
  private readonly byId = new Map<number, AnyEntity>();
  private readonly env: FlightEnv;
  private readonly damage: DamageSystem;
  private readonly collisions: CollisionSystem;
  private readonly warnings = new WarningSystem();
  /** Entities seen dead by the previous cleanup (removed on the next one). */
  private readonly deadSeen = new WeakSet<object>();
  private projCursor = 0;
  private spawnCount = 0;
  private errorCount = 0;

  /** hostilesOf() cache, double-buffered so a caller iterating the old array stays safe. */
  private hostileDirty = true;
  private hostileFlip = 0;
  private readonly hostileBuf: [AnyEntity[], AnyEntity[], AnyEntity[], AnyEntity[]] = [[], [], [], []];
  private hostileOfBlue: AnyEntity[] = this.hostileBuf[0];
  private hostileOfRed: AnyEntity[] = this.hostileBuf[1];

  constructor(o: SimWorldOptions) {
    this.events = o.events;
    this.terrain = o.terrain;
    this.difficulty = o.difficulty;
    this.combat = o.combat;
    this.env = { terrain: o.terrain, difficulty: o.difficulty, events: o.events, time: 0 };
    const self = this;
    this.damage = new DamageSystem({
      events: o.events,
      difficulty: o.difficulty,
      get time() {
        return self.time;
      },
      getEntity: (id) => this.getEntity(id),
      onEntityDestroyed: () => {
        this.hostileDirty = true;
      },
    });
    this.collisions = new CollisionSystem(o.terrain, this.damage);
    for (let i = 0; i < PROJECTILE_POOL_SIZE; i++) this.projectiles.push(createProjectile());
  }

  /* ───────────────────────────── Queries ───────────────────────────── */

  nextId(): number {
    return this.idSeq++;
  }

  getEntity(id: number | null | undefined): AnyEntity | null {
    if (id == null) return null;
    return this.byId.get(id) ?? null;
  }

  /**
   * Live aircraft, SAM sites and ground targets hostile to `team`. The returned array is a
   * shared cache (rebuilt each step / on spawn or destruction) — do not mutate or keep it.
   */
  hostilesOf(team: Team): AnyEntity[] {
    if (this.hostileDirty) this.rebuildHostiles();
    if (team === 'neutral') return [];
    return team === 'blue' ? this.hostileOfBlue : this.hostileOfRed;
  }

  private rebuildHostiles(): void {
    this.hostileDirty = false;
    this.hostileFlip ^= 1;
    const ofBlue = this.hostileBuf[this.hostileFlip * 2];
    const ofRed = this.hostileBuf[this.hostileFlip * 2 + 1];
    ofBlue.length = 0;
    ofRed.length = 0;
    this.sortByTeam(this.aircraft, ofBlue, ofRed);
    this.sortByTeam(this.sams, ofBlue, ofRed);
    this.sortByTeam(this.ground, ofBlue, ofRed);
    this.hostileOfBlue = ofBlue;
    this.hostileOfRed = ofRed;
  }

  /** Append live entities to the list of the team they are hostile to (neutrals: neither). */
  private sortByTeam(list: readonly AnyEntity[], ofBlue: AnyEntity[], ofRed: AnyEntity[]): void {
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.alive) continue;
      if (e.team === 'red') ofBlue.push(e);
      else if (e.team === 'blue') ofRed.push(e);
    }
  }

  /* ───────────────────────────── Spawning ───────────────────────────── */

  spawnAircraft(spec: AircraftSpawn): AircraftEntity {
    const perf = AIRCRAFT_PERF[spec.type];
    const ac = new AircraftEntity(this.nextId(), spec.type, spec.team, {
      name: spec.name ?? AIRCRAFT_INFO[spec.type].name,
      callsign: spec.callsign,
      radius: perf.radius,
      rcs: perf.rcs,
      ir: perf.ir,
    });
    ac.isPlayer = !!spec.isPlayer;
    ac.ai = spec.ai ?? null;
    ac.leaderId = spec.leaderId ?? null;
    ac.groupId = spec.groupId ?? '';
    ac.position.copy(spec.position);
    const surface = this.terrain.surfaceHeightAt(ac.position.x, ac.position.z);
    if (!(ac.position.y >= surface + MIN_SPAWN_AGL)) ac.position.y = surface + Math.max(150, MIN_SPAWN_AGL);

    try {
      if (spec.loadout) this.combat.applyLoadout(ac, spec.loadout);
      else this.combat.applyDefaultLoadout(ac);
    } catch (err) {
      this.reportError('loadout', err);
    }
    if (spec.loadout && ac.loadout == null) ac.loadout = spec.loadout;

    const st = ensureSimState(ac);
    st.aiTimer = -(this.spawnCount % 3) / 60; // stagger AI updates over frames
    this.spawnCount++;
    initFlight(ac, { heading: spec.heading, speed: Math.max(50, spec.speed), fuelFraction: spec.fuel ?? 0.8 }, this.env);
    Object.assign(ac.prevInput, ac.input);

    this.aircraft.push(ac);
    this.byId.set(ac.id, ac);
    if (ac.isPlayer) this.player = ac;
    this.hostileDirty = true;
    return ac;
  }

  spawnSam(spec: SamSpawn): SamSiteEntity {
    const data = SAM_SITE_DATA[spec.type];
    const e = new SamSiteEntity(this.nextId(), spec.type, spec.team, {
      name: spec.name ?? SAM_INFO[spec.type].nato,
      radius: data.radius,
      missiles: data.missiles,
    });
    e.health = e.maxHealth = data.health;
    const x = spec.position.x;
    const z = spec.position.z;
    e.position.set(x, this.terrain.surfaceHeightAt(x, z), z);
    const heading = spec.heading ?? 0;
    setQuatFromHPR(e.quaternion, heading, 0, 0);
    e.radarAzimuth = heading;
    e.launcherAzimuth = heading;
    e.groupId = spec.groupId ?? '';
    e.known = !!spec.known;
    if (spec.emcon) {
      e.radarOn = false;
      e.state = 'emcon';
    }
    this.sams.push(e);
    this.byId.set(e.id, e);
    this.hostileDirty = true;
    return e;
  }

  spawnGround(spec: GroundSpawn): GroundTargetEntity {
    const data = GROUND_TARGET_DATA[spec.type];
    const e = new GroundTargetEntity(this.nextId(), spec.type, spec.team, {
      name: spec.name ?? GROUND_NAMES[spec.type],
      radius: data.radius,
      health: spec.health ?? data.health,
    });
    e.emitter = data.emitter;
    e.groupId = spec.groupId ?? '';
    const x = spec.position.x;
    const z = spec.position.z;
    e.position.set(x, data.naval ? 0 : this.terrain.surfaceHeightAt(x, z), z);
    if (spec.path && spec.path.length > 0) {
      e.path = spec.path.map((p) => p.clone());
      e.pathIndex = 0;
      e.speed = spec.speed ?? DEFAULT_MOVER_SPEED[spec.type] ?? 8;
      e.loopPath = !!spec.loopPath;
    } else if (spec.speed) e.speed = spec.speed;
    let heading = spec.heading ?? 0;
    if (spec.heading === undefined && e.path) {
      const t = e.path[0];
      if (Math.hypot(t.x - x, t.z - z) > 1) heading = Math.atan2(t.x - x, -(t.z - z));
    }
    setQuatFromHPR(e.quaternion, heading, 0, 0);
    this.ground.push(e);
    this.byId.set(e.id, e);
    this.hostileDirty = true;
    return e;
  }

  addMissile(m: MissileEntity): void {
    this.missiles.push(m);
    this.byId.set(m.id, m);
  }

  addDecoy(d: DecoyEntity): void {
    this.decoys.push(d);
    this.byId.set(d.id, d);
  }

  allocProjectile(): Projectile | null {
    const pool = this.projectiles;
    const n = pool.length;
    for (let k = 0; k < n; k++) {
      const i = (this.projCursor + k) % n;
      const p = pool[i];
      if (p.active) continue;
      this.projCursor = (i + 1) % n;
      p.active = true;
      p.age = 0;
      p.life = 0;
      p.damage = 0;
      p.tracer = false;
      p.flak = false;
      p.shooterId = 0;
      p.velocity.set(0, 0, 0);
      return p;
    }
    return null;
  }

  /* ───────────────────────────── Damage ───────────────────────────── */

  applyDamage(target: AnyEntity, amount: number, attackerId: number | null, weapon: DamageWeapon, hitPoint?: Vector3): void {
    this.damage.apply(target, amount, attackerId, weapon, hitPoint);
  }

  /* ───────────────────────────── Step ───────────────────────────── */

  step(dt: number): void {
    if (!(dt > 0)) return;
    this.time += dt;
    this.env.time = this.time;
    this.hostileDirty = true;
    const aircraft = this.aircraft;

    // 1. AI pilots (20 Hz, staggered; they get the accumulated dt)
    for (let i = 0; i < aircraft.length; i++) {
      const ac = aircraft[i];
      if (!ac.alive || !ac.ai) continue;
      const st = ensureSimState(ac);
      st.aiTimer += dt;
      if (st.aiTimer < AI_INTERVAL - 1e-6) continue;
      const acc = st.aiTimer;
      st.aiTimer = 0;
      try {
        ac.ai.update(ac, this, acc);
      } catch (err) {
        this.reportError('ai', err);
      }
    }

    // 2. Flight model (player, AI and falling wrecks); live civil traffic flies its scripted profile
    for (let i = 0; i < aircraft.length; i++) {
      const ac = aircraft[i];
      if (ac.civil && ac.alive) stepCivil(ac, dt, this.terrain, this.player);
      else stepFlight(ac, dt, this.env);
    }

    // 3. Weapons, sensors, SAMs
    try {
      this.combat.update(this, dt);
    } catch (err) {
      this.reportError('combat', err);
    }

    // 4. Ground movers
    this.updateMovers(dt);

    // 5. Collisions (terrain / sea, mid-air, landmarks) and landmark collapses
    this.collisions.update(aircraft, dt, this.landmarks);
    if (this.landmarks.length) stepLandmarks(this.landmarks, this.time, this.events, (x, z) => this.terrain.surfaceHeightAt(x, z));

    // 6. Fire damage over time, overstress
    this.damage.update(aircraft, dt);

    // 7. Player ICAWS
    this.warnings.update(this, dt);

    // 8. Cleanup
    this.cleanup();
  }

  private updateMovers(dt: number): void {
    const terrain = this.terrain;
    for (let i = 0; i < this.ground.length; i++) {
      const g = this.ground[i];
      const path = g.path;
      if (!g.alive || !path || g.pathIndex >= path.length || g.speed <= 0) {
        g.velocity.set(0, 0, 0);
        continue;
      }
      const naval = GROUND_TARGET_DATA[g.type].naval;
      const pos = g.position;
      const target = path[g.pathIndex];
      const dx = target.x - pos.x;
      const dz = target.z - pos.z;
      const dist = Math.hypot(dx, dz);
      const stepLen = g.speed * dt;
      const oldY = pos.y;
      let hx = dist > 1e-3 ? dx / dist : 0;
      let hz = dist > 1e-3 ? dz / dist : -1;
      if (dist <= stepLen + 0.25) {
        pos.x = target.x;
        pos.z = target.z;
        g.pathIndex++;
        if (g.pathIndex >= path.length && g.loopPath) g.pathIndex = 0;
      } else {
        pos.x += hx * stepLen;
        pos.z += hz * stepLen;
      }
      if (dist <= 1e-3) {
        // standing on the waypoint: keep facing the way we were going
        hx = -2 * (g.quaternion.x * g.quaternion.z + g.quaternion.w * g.quaternion.y);
        hz = -(1 - 2 * (g.quaternion.x * g.quaternion.x + g.quaternion.y * g.quaternion.y));
      }
      pos.y = naval ? 0 : terrain.surfaceHeightAt(pos.x, pos.z);
      g.velocity.set(hx * g.speed, (pos.y - oldY) / dt, hz * g.speed);
      if (g.pathIndex >= path.length) g.velocity.set(0, 0, 0);
      const heading = Math.atan2(hx, -hz);
      let pitch = 0;
      if (!naval) {
        const ahead = terrain.surfaceHeightAt(pos.x + hx * 4, pos.z + hz * 4);
        const behind = terrain.surfaceHeightAt(pos.x - hx * 4, pos.z - hz * 4);
        pitch = Math.atan2(ahead - behind, 8);
      }
      setQuatFromHPR(g.quaternion, heading, pitch, 0);
    }
  }

  private cleanup(): void {
    const aircraft = this.aircraft;
    // Latch this step's inputs for rising-edge detection (idempotent if COMBAT also does it).
    for (let i = 0; i < aircraft.length; i++) {
      const a = aircraft[i];
      const pi = a.prevInput;
      const ci = a.input;
      pi.pitch = ci.pitch;
      pi.roll = ci.roll;
      pi.yaw = ci.yaw;
      pi.throttle = ci.throttle;
      pi.airbrake = ci.airbrake;
      pi.fireGun = ci.fireGun;
      pi.fireWeapon = ci.fireWeapon;
      pi.flare = ci.flare;
      pi.chaff = ci.chaff;
    }
    this.compactDead(this.missiles);
    this.compactDead(this.decoys);

    // Wrecks: keep them around (burning) for a while after impact, then remove.
    let w = 0;
    for (let i = 0; i < aircraft.length; i++) {
      const a = aircraft[i];
      // civil traffic that landed and vacated / left the area
      let remove = a.alive && !!a.civil?.despawn;
      if (!a.alive && !a.isPlayer) {
        const st = a.sim;
        const landed = a.crashed && st && st.crashTime >= 0 && this.time - st.crashTime > WRECK_GROUND_TIME;
        remove = landed || this.time - a.destroyedAt > WRECK_MAX_TIME;
      }
      if (remove) {
        this.byId.delete(a.id);
        this.hostileDirty = true;
      } else aircraft[w++] = a;
    }
    aircraft.length = w;
  }

  /** Remove entities that were already dead at the previous cleanup (one step of grace). */
  private compactDead<T extends MissileEntity | DecoyEntity>(list: T[]): void {
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.alive) {
        if (this.deadSeen.has(e)) {
          this.byId.delete(e.id);
          continue;
        }
        this.deadSeen.add(e);
      }
      list[w++] = e;
    }
    list.length = w;
  }

  private reportError(where: string, err: unknown): void {
    this.errorCount++;
    if (this.errorCount <= 5) console.error(`[SimWorld] ${where} update threw`, err);
  }

  dispose(): void {
    this.aircraft.length = 0;
    this.missiles.length = 0;
    this.sams.length = 0;
    this.ground.length = 0;
    this.decoys.length = 0;
    this.landmarks.length = 0;
    for (const p of this.projectiles) p.active = false;
    this.byId.clear();
    this.player = null;
    this.warnings.reset();
    for (const b of this.hostileBuf) b.length = 0;
    this.hostileDirty = true;
  }
}

export const createSimWorld: CreateSimWorld = (o) => new SimWorldImpl(o);
