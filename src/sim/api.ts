/**
 * F35-A — simulation-layer interfaces (contract between SIM-CORE, COMBAT, AI, MISSIONS,
 * WORLD and the presentation layers).
 * OWNERSHIP: orchestrator. Do not edit.
 */
import type { Vector3 } from 'three';
import type { EventBus } from '../core/events';
import type {
  AircraftType,
  DifficultyParams,
  GroundTargetType,
  LoadoutId,
  MunitionId,
  SamType,
  Team,
  VesselClass,
  WeaponId,
} from '../core/types';
import type {
  AircraftEntity,
  AnyEntity,
  DecoyEntity,
  GroundTargetEntity,
  MissileEntity,
  MunitionDef,
  Projectile,
  SamSiteEntity,
} from './entities';
import type { BuildingIndex } from './buildings';
import type { LandmarkEntity } from './landmarks';

/** A structure the player's jet brought down (SimWorld.structureStrike). */
export interface StructureStrike {
  /** In a sentence ("the Sky Tower", "Spark Arena"); null for an unnamed CBD skyscraper. */
  name: string | null;
  /** On the HUD ("SKY TOWER"); null for an unnamed CBD skyscraper. */
  label: string | null;
  /** Sim time of the impact. */
  time: number;
  /** Seconds from the impact until it lies in rubble. */
  duration: number;
  /** A sphere that holds the collapse (world): the death cam frames it. */
  center: Vector3;
  radius: number;
}

/* ───────────────────────── Terrain (implemented by WORLD agent) ───────────────────────── */

/** CPU-side terrain queries. Implemented by world/Terrain (deterministic from the seed). */
export interface TerrainQuery {
  /** World extent (m). Playable area is [-size/2, size/2] on X and Z. */
  readonly size: number;
  /** Ground elevation at (x,z) in metres MSL (may be < 0 for sea floor). */
  heightAt(x: number, z: number): number;
  /** max(heightAt, 0): the surface you would crash into (sea surface at 0). */
  surfaceHeightAt(x: number, z: number): number;
  /** True if (x,z) is water. */
  isWater(x: number, z: number): boolean;
  /** Line of sight between two world points is not blocked by terrain. */
  lineOfSight(a: Vector3, b: Vector3): boolean;
  /**
   * Ray vs terrain. Returns distance along the (normalised) direction to the first hit,
   * or -1 if nothing within maxDist.
   */
  raycast(origin: Vector3, dir: Vector3, maxDist: number): number;
}

/* ───────────────────────── AI (implemented by AI agent) ───────────────────────── */

export type AiRole =
  | 'fighter' // air superiority: patrol → intercept → BVR/BFM → defend
  | 'interceptor' // scrambles towards the player/closest blue, aggressive
  | 'escort' // protects a leader (bombers) and engages threats to it
  | 'bomber' // flies waypoint route at altitude, no air-to-air weapons (may have tail gun)
  | 'wingman' // friendly: follows player/lead in formation, engages on command/opportunity
  | 'cap'; // friendly/enemy combat air patrol around a point

export interface AiBrain {
  readonly role: AiRole;
  /** Called at ~20 Hz by SimWorld. Must write `ac.input` (and may call CombatSystem helpers). */
  update(ac: AircraftEntity, world: SimWorld, dt: number): void;
  /** Optional: mission scripts can re-task an AI (e.g. patrol point, attack target). */
  setTask?(task: AiTask): void;
}

export type AiTask =
  | { kind: 'patrol'; center: Vector3; radius: number; altitude: number }
  | { kind: 'route'; waypoints: Vector3[]; loop: boolean }
  | { kind: 'attack'; targetId: number }
  | { kind: 'escort'; leaderId: number }
  | { kind: 'rtb'; point: Vector3 };

/**
 * Standing orders for a friendly 'wingman' (Instant Action, issue #60: the wingman supports the
 * player, it can't win the mission for a player who never fires).
 */
export interface WingmanOrders {
  /** Weapons hold until the player engages a bandit (a missile at a hostile aircraft, or a hit on one); a stray gun burst doesn't count. */
  holdFireUntilPlayerFires?: boolean;
  /** Never engage these groups (AircraftEntity.groupId), e.g. Defend's strikers: the player's job. */
  ignoreGroups?: string[];
}

/** Factory exported by src/ai/index.ts */
export type CreateAiBrain = (role: AiRole, opts: { skill: number; task?: AiTask; seed?: number; orders?: WingmanOrders }) => AiBrain;

/* ───────────────────────── Combat (implemented by COMBAT agent) ───────────────────────── */

/** Dynamic launch zone for HUD shoot cues (all metres). */
export interface LaunchZone {
  weapon: WeaponId;
  targetId: number | null;
  range: number;
  rMin: number;
  /** No-escape range (target can't outrun even if it turns cold). */
  rNe: number;
  rMax: number;
  /** In range + seeker/lock conditions satisfied → "SHOOT" cue. */
  shoot: boolean;
  /** Closing velocity (m/s, + = closing). */
  closure: number;
  /** Time of flight to target if fired now (s). */
  timeOfFlight: number;
}

/** The bomb release cue (CombatSystemApi.bombImpactPoint). */
export interface BombCue {
  point: Vector3;
  inRange: boolean;
  timeToRelease: number;
  offAxis: boolean;
  /** Way to turn for a target off the release cone: +1 right, −1 left, 0 not off axis. */
  steer: -1 | 0 | 1;
  /** One of the jet's own guided bombs is still flying to the designated target. */
  bombAway: boolean;
}

export interface CombatSystemApi {
  /** Munition database (all player, enemy and SAM munitions). */
  readonly munitions: Record<MunitionId, MunitionDef>;

  /**
   * Main update, called by SimWorld once per sim step AFTER the flight model:
   *  - handles every aircraft's fire inputs (gun, weapon release on rising edge, flares/chaff)
   *  - updates sensors (radar tracks, locks, RWR, missile warning) for all aircraft
   *  - updates missiles/bombs (guidance, kinematics, fuzing), projectiles, decoys
   *  - updates SAM sites (search → track → launch → guide → reload, EMCON)
   *  - applies weapon damage via world.applyDamage
   */
  update(world: SimWorld, dt: number): void;

  /** Equip an aircraft with a loadout (stores, gun ammo, flares/chaff, rcs penalty). */
  applyLoadout(ac: AircraftEntity, loadout: LoadoutId): void;
  /** Equip an AI aircraft with its typical weapons (by aircraft type); 'strike' = air-to-ground stores. */
  applyDefaultLoadout(ac: AircraftEntity, variant?: 'default' | 'strike'): void;

  /** Cycle to the next weapon type that has rounds (gun included). */
  cycleWeapon(ac: AircraftEntity, world: SimWorld): void;
  /** Directly select a weapon (no-op if none left). */
  selectWeapon(ac: AircraftEntity, weapon: WeaponId, world: SimWorld): void;
  /** Cycle designated target among current sensor contacts (air targets in A/A, ground in A/G). */
  cycleTarget(ac: AircraftEntity, world: SimWorld): void;
  /** Designate the contact closest to the given direction (world dir, e.g. HMD look). */
  designateNearestTo(ac: AircraftEntity, dir: Vector3, world: SimWorld): void;
  /** Designate a specific entity (tap on its HUD box / PCD symbol). Ignored if not a sensor contact. */
  designate(ac: AircraftEntity, targetId: number | null, world: SimWorld): void;
  /** Toggle radar emission (EMCON). */
  setRadarEmitting(ac: AircraftEntity, emitting: boolean, world: SimWorld): void;

  /** Count remaining rounds for a weapon type. */
  remaining(ac: AircraftEntity, weapon: WeaponId): number;
  /** Launch zone of the currently selected weapon vs designated target (null if n/a). */
  launchZone(ac: AircraftEntity, world: SimWorld): LaunchZone | null;
  /** Launch zone for a specific weapon/target (AI uses it for shot decisions). */
  launchZoneFor(ac: AircraftEntity, weapon: WeaponId, target: AnyEntity, world: SimWorld): LaunchZone;
  /**
   * Try to release the selected (or given) weapon at the designated (or given) target.
   * Returns the launched missile or null (and emits 'weapon:denied' for the player).
   * AI brains call this; the player path goes through ControlInput.fireWeapon.
   */
  fire(ac: AircraftEntity, world: SimWorld, weapon?: WeaponId, targetId?: number | null): MissileEntity | null;

  /** AIM-9X / R-73 IR seeker status for HUD/audio growl: 'none' | 'search' (growl) | 'locked' (tone). */
  irSeekerState(ac: AircraftEntity): { state: 'off' | 'search' | 'locked'; targetId: number | null; direction: Vector3 | null };
  /** Gun lead point (LCOS pipper) in world space for the gunsight, or null. */
  gunLeadPoint(ac: AircraftEntity, world: SimWorld): Vector3 | null;
  /**
   * CCIP / release cue for bombs: predicted impact point + whether release is valid. GPS / glide
   * bombs: `inRange` only within the reach and with the target where the bomb can turn to,
   * `offAxis` when it is outside the release cone around the ground track (steer toward it: `steer`
   * +1 right, −1 left, 0 when not off axis), `bombAway` while one of `ac`'s own guided bombs is still
   * flying to the designated target.
   */
  bombImpactPoint(ac: AircraftEntity, world: SimWorld): BombCue | null;
}

/* ───────────────────────── Spawning ───────────────────────── */

export interface AircraftSpawn {
  type: AircraftType;
  team: Team;
  position: Vector3;
  /** Heading in radians (0 = north, clockwise). */
  heading: number;
  /** Initial true airspeed (m/s). */
  speed: number;
  name?: string;
  callsign?: string;
  isPlayer?: boolean;
  /** Player/friendly loadout. If omitted, a type-appropriate default is applied. */
  loadout?: LoadoutId;
  /** Without `loadout`: the type's default air-to-air stores, or its strike stores (bombs). */
  enemyLoadout?: 'default' | 'strike';
  /** Fuel fraction 0..1 (default 0.8). */
  fuel?: number;
  ai?: AiBrain | null;
  leaderId?: number | null;
  groupId?: string;
}

export interface SamSpawn {
  type: SamType;
  team: Team;
  /** XZ position; y is resolved to terrain height. */
  position: Vector3;
  heading?: number;
  name?: string;
  groupId?: string;
  /** Radar initially off (pop-up SAM ambush). */
  emcon?: boolean;
  known?: boolean;
  /** A moving SAM on a fast boat ('ad_boat'): its route / escort (sim/boats.ts). Ignored for fixed sites. */
  boat?: BoatSpawn;
  /** Close-in cue overriding the type's SamTypeData.closeCue (SamSiteEntity.closeCue). */
  closeCue?: { range: number; bayRange: number } | null;
}

/**
 * How a IRGC Navy fast boat sails (sim/boats.ts): a suicide boat rams `chaseId`; a missile boat
 * closes to `strike.range` of `strike.targetId`, counts down and fires; an AD boat keeps station on
 * `escortId`. With none of them (or once its target is gone) it sails `path`.
 * The `…Group` / `strike.group` forms name a mission group instead: the boat takes its first live
 * member, looking it up again each step it has no live target (spawn order doesn't matter).
 */
export interface BoatSpawn {
  path?: Vector3[];
  loop?: boolean;
  /** Cruise speed (m/s, default BOAT_SPEED ≈ 45 kt). */
  speed?: number;
  chaseId?: number | null;
  chaseGroup?: string;
  escortId?: number | null;
  escortGroup?: string;
  /** Station on the escorted boat: metres to its right and behind it. */
  escortRight?: number;
  escortAft?: number;
  strike?: { targetId?: number; group?: string; range?: number; countdown?: number; missiles?: number } | null;
  /** Weave amplitude (rad); default BOAT_WEAVE for a chasing boat, 0 otherwise. */
  weave?: number;
}

export interface GroundSpawn {
  type: GroundTargetType;
  team: Team;
  position: Vector3;
  heading?: number;
  name?: string;
  groupId?: string;
  path?: Vector3[];
  speed?: number;
  loopPath?: boolean;
  health?: number;
  /** Civil merchant ship class (type 'ship'): hull size and hit points from VESSEL_DATA. */
  vessel?: VesselClass;
  /** Bomb / missile hits a civil ship takes before it sinks (default 1; GroundTargetEntity.hitsToSink). Neutral ships only: ignored on any other team. */
  hitsToSink?: number;
  /** Riding at anchor (civil ship, no path): the visual swings about the bow. */
  anchored?: boolean;
  /** Drawn by the world scenery (GroundTargetEntity.scenery): no entity model. */
  scenery?: boolean;
  /**
   * Take the id from the world's civil range (a civil train, #146): trains near the player come and go all
   * sortie, and drawing their ids from the shared sequence shifted every later entity's id, and with it
   * seeded behaviour keyed by id (a bot run changed outcome with nothing else different).
   */
  civilId?: boolean;
  /** IRGC Navy fast boat ('suicide_boat' / 'missile_boat'): chase / strike target (sim/boats.ts). `path` and `speed` above still apply. */
  boat?: BoatSpawn;
  /** The stoat ('stoat'): its route, bait stations and clock (sim/stoat.ts). */
  stoat?: import('./stoat').StoatSpawn;
}

/* ───────────────────────── Sim world (implemented by SIM-CORE agent) ───────────────────────── */

export interface SimWorld {
  readonly events: EventBus;
  readonly terrain: TerrainQuery;
  readonly difficulty: DifficultyParams;
  readonly combat: CombatSystemApi;
  /** Seconds since mission start (sim time; stops while paused). */
  readonly time: number;

  readonly aircraft: AircraftEntity[];
  readonly missiles: MissileEntity[];
  readonly sams: SamSiteEntity[];
  readonly ground: GroundTargetEntity[];
  readonly decoys: DecoyEntity[];
  /**
   * Protected structures (the Sky Tower). Not entities: no sensor, AI, objective or score code
   * sees them; weapons, gun rounds and collisions test them (sim/landmarks.ts).
   */
  readonly landmarks: LandmarkEntity[];
  /**
   * The CBD's skyscrapers as obstacles (#128, sim/buildings.ts): flying into one destroys the
   * aircraft and collapses the building. The 3D-modelled landmarks (Spark Arena, the Auckland Museum)
   * collapse only under the player's jet; others crash on them. All standing in a new world.
   */
  readonly buildings?: BuildingIndex | null;
  /**
   * The structure the player's jet flew into and brought down (null until then): the death cam frames
   * its collapse and the end of the mission waits for it to play out. Set before the jet's
   * 'player:down', so the mission can name the building in the end reason.
   */
  readonly structureStrike?: StructureStrike | null;
  /**
   * The sortie's train timetable (Auckland civil traffic, #146; null without it): set by the mission
   * (missions/runtime/trains.ts), read by the entity renderer to draw every train near the camera.
   */
  trains?: import('./civil/rail').TrainService | null;
  /** Pooled projectiles (check `active`). */
  readonly projectiles: Projectile[];
  readonly player: AircraftEntity | null;

  nextId(): number;
  getEntity(id: number | null | undefined): AnyEntity | null;
  /** All live, targetable entities of a team (aircraft, SAMs, ground). */
  hostilesOf(team: Team): AnyEntity[];

  spawnAircraft(spec: AircraftSpawn): AircraftEntity;
  spawnSam(spec: SamSpawn): SamSiteEntity;
  spawnGround(spec: GroundSpawn): GroundTargetEntity;
  /** Used by CombatSystem. */
  addMissile(m: MissileEntity): void;
  addDecoy(d: DecoyEntity): void;
  /** Get a free projectile slot from the pool (null if exhausted). */
  allocProjectile(): Projectile | null;

  /**
   * Apply damage (handles difficulty scaling for the player, subsystem damage, destruction,
   * kill credit, 'damage' / 'destroyed' / 'player:hit' / 'player:down' events).
   */
  applyDamage(
    target: AnyEntity,
    amount: number,
    attackerId: number | null,
    weapon: WeaponId | MunitionId | 'gun' | 'collision' | 'flak',
    hitPoint?: Vector3,
  ): void;

  /**
   * Advance the simulation by dt seconds (Game calls this at a fixed 60 Hz).
   * Order: AI brains (20 Hz) → flight model (sub-stepped) → combat.update → ground movers →
   * collisions (terrain, mid-air) → warnings → cleanup of dead entities (after a delay so
   * visuals can play out).
   */
  step(dt: number): void;

  /** Remove everything (mission restart). */
  dispose(): void;
}

export interface SimWorldOptions {
  terrain: TerrainQuery;
  difficulty: DifficultyParams;
  events: EventBus;
  combat: CombatSystemApi;
}

/** Factory exported by src/sim/World.ts */
export type CreateSimWorld = (opts: SimWorldOptions) => SimWorld;
/** Factory exported by src/sim/weapons/CombatSystem.ts */
export type CreateCombatSystem = () => CombatSystemApi;
