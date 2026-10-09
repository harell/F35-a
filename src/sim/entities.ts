/**
 * F35-A — simulation entity data classes.
 *
 * OWNERSHIP: orchestrator. These are plain data holders shared by every subsystem.
 * Logic lives in systems (FlightModel, CombatSystem, AI brains, ...).
 * Module agents must NOT change existing fields. The SIM-CORE and COMBAT agents may
 * append new optional fields at the marked "EXTENSION" spots if strictly required.
 *
 * See core/types.ts for coordinate conventions (nose = local -Z, world -Z = north).
 */
import { Quaternion, Vector3 } from 'three';
import type {
  AircraftType,
  ControlInput,
  GroundTargetType,
  LoadoutId,
  MunitionId,
  SamType,
  Team,
  VesselClass,
  WarningId,
  WeaponId,
} from '../core/types';
import { neutralControls } from '../core/types';
import type { AiBrain } from './api';

export type EntityKind = 'aircraft' | 'missile' | 'sam' | 'ground' | 'decoy';

/** Common fields for everything that can be targeted, rendered or collided with. */
export interface Entity {
  readonly id: number;
  readonly kind: EntityKind;
  team: Team;
  name: string;
  position: Vector3;
  velocity: Vector3;
  quaternion: Quaternion;
  /** Bounding radius used for hits, proximity fuzes and picking (m). */
  radius: number;
  alive: boolean;
  health: number;
  maxHealth: number;
}

/* ───────────────────────────── Aircraft ───────────────────────────── */

/** State produced by the flight model each step. All SI units unless noted. */
export interface FlightState {
  /** Angle of attack (rad). */
  alpha: number;
  /** Sideslip (rad). */
  beta: number;
  /** True airspeed (m/s). */
  tas: number;
  /** Indicated / calibrated airspeed (m/s) — what the HMD shows (converted to knots). */
  ias: number;
  mach: number;
  /** Normal load factor felt by the pilot (G). 1 in level flight. */
  gLoad: number;
  /** Highest |G| in the last second (for over-G & visuals). */
  gPeak: number;
  /** Altitude above mean sea level (m). */
  altitude: number;
  /** Height above the ground/sea directly below (m). */
  agl: number;
  /** Vertical speed (m/s, + = climbing). */
  verticalSpeed: number;
  /** Heading 0..2π (0 = north, clockwise). */
  heading: number;
  /** Pitch -π/2..π/2 (+ = nose up). */
  pitch: number;
  /** Roll -π..π (+ = right wing down). */
  roll: number;
  /** Current engine thrust (N). */
  thrust: number;
  /** Engine core speed 0..1.05 (spools towards commanded). */
  engineRpm: number;
  /** Afterburner intensity 0..1 (0 = dry). */
  afterburner: number;
  /** Fuel remaining (kg). */
  fuel: number;
  /** Fuel flow (kg/s). */
  fuelFlow: number;
  /** Total mass incl. fuel and stores (kg). */
  mass: number;
  /** Aircraft departed / stalled this step. */
  stalled: boolean;
  /** The free-flight under-speed autothrottle is holding the speed floor (HMD 'A/T'). */
  autoThrottle: boolean;
  /** Control surface deflections for visuals, -1..1. Positive = trailing edge down (elevator: nose-down input => positive). */
  surfaces: { elevator: number; aileron: number; rudder: number; flaps: number; airbrake: number };
  /** Accumulated over-stress 0..1 (1 = structural damage threshold reached). */
  overstress: number;
  /** Supersonic flag (for vapor cone / boom effects). */
  supersonic: boolean;
}

export interface StoreStation {
  weapon: Exclude<WeaponId, 'gun'>;
  count: number;
  /** Internal weapons bay (stealthy) vs external pylon (beast mode). */
  internal: boolean;
}

export type RadarMode = 'search' | 'acm' | 'ground';

export interface RadarContact {
  id: number;
  /** Sim time this contact was last refreshed (s). */
  lastSeen: number;
  /** Last known position/velocity (may be stale). */
  position: Vector3;
  velocity: Vector3;
  team: Team;
  /** Which sensor currently holds the track. */
  source: 'radar' | 'eots' | 'das' | 'datalink';
}

export interface RadarState {
  mode: RadarMode;
  /** Radar transmitting. The F-35 can run passive (EMCON) — then SAMs/RWRs can't see our radar. */
  emitting: boolean;
  /** Current max display range (m). */
  range: number;
  /** Currently fused tracks. */
  contacts: RadarContact[];
  /** Target selected with the target-cycle button (TD box), not necessarily locked. */
  designatedId: number | null;
  /** Hard lock (STT). Required for semi-active weapons, improves AMRAAM/AIM-9X shots. */
  lockedId: number | null;
  /** 0..1 progress towards lock on designated target. */
  lockProgress: number;
  /** Ground point designated for GPS weapons (JDAM/SDB) — set when a ground target is designated. */
  groundPoint: Vector3 | null;
}

export type RwrThreatKind = 'fighter' | 'sam' | 'aaa' | 'missile';

export interface RwrContact {
  /** Emitting entity id (aircraft, SAM site, missile with active seeker). */
  sourceId: number;
  kind: RwrThreatKind;
  /** Short symbol drawn on the RWR scope: '29', '27', '35', '57', 'S6', '10', '8', '15', 'A', 'M', 'EW'... */
  symbol: string;
  /** Bearing relative to our nose (rad, + = right, range -π..π). */
  bearing: number;
  /** 0..1, 1 = very strong/close. */
  strength: number;
  state: 'search' | 'track' | 'launch';
  /** Seconds since first detected (new contacts flash). */
  age: number;
}

export interface IncomingMissile {
  missileId: number;
  bearing: number; // relative, rad, + = right
  elevation: number; // relative, rad, + = above
  distance: number; // m
  timeToImpact: number; // s (estimate)
  guidance: 'radar' | 'ir';
}

export class AircraftEntity implements Entity {
  readonly kind = 'aircraft' as const;
  name: string;
  callsign: string;
  isPlayer = false;

  position = new Vector3();
  velocity = new Vector3();
  quaternion = new Quaternion();
  /** Body rates (rad/s): x = p (roll, + right), y = q (pitch, + up), z = r (yaw, + right). */
  rates = new Vector3();

  input: ControlInput = neutralControls();
  /** Previous frame input — used by CombatSystem for edge detection. */
  prevInput: ControlInput = neutralControls();

  flight: FlightState;

  radius: number;
  alive = true;
  health = 100;
  maxHealth = 100;
  /** Sim time of destruction, -1 while alive. */
  destroyedAt = -1;
  /** Hit the ground/sea. */
  crashed = false;
  /** Subsystem damage 0..1 (1 = destroyed). Degrades thrust / control authority. */
  damage = { engine: 0, hydraulics: 0, fuelLeak: 0, fire: false, avionics: 0 };
  lastDamageTime = -999;
  lastAttackerId: number | null = null;
  /**
   * Practice rounds (training, MissionScript.practiceRounds): weapons that hit this jet do no damage;
   * each hit is reported as 'practice:hit' instead. Flying into the ground still kills.
   */
  practiceRounds = false;

  loadout: LoadoutId | null = null;
  stores: StoreStation[] = [];
  selectedWeapon: WeaponId = 'aim120';
  gunAmmo = 0;
  gunMaxAmmo = 0;
  flares = 0;
  chaff = 0;
  /** Internal bay door opening 0..1 (animated by CombatSystem on release of internal stores). */
  bayDoors = 0;
  /** Gun firing this frame (for muzzle flash / sound). */
  gunFiring = false;

  /** Base frontal RCS (m²): F-35 ~0.001, Su-57 ~0.1, MiG-29 ~5, bombers ~50. */
  rcsBase: number;
  /** Infra-red signature scale (1 = normal fighter at MIL). */
  irBase: number;

  radar: RadarState = {
    mode: 'search',
    emitting: true,
    range: 40_000,
    contacts: [],
    designatedId: null,
    lockedId: null,
    lockProgress: 0,
    groundPoint: null,
  };
  /** RWR contacts (computed for every aircraft; the player's is displayed). */
  rwr: RwrContact[] = [];
  /** Missile approach warning (F-35 DAS). */
  incoming: IncomingMissile[] = [];
  /** ICAWS warnings (player). */
  warnings = new Set<WarningId>();

  /** AI pilot (null for the human player). */
  ai: AiBrain | null = null;
  /** Free-form AI state label for debugging/HUD ("INTERCEPT", "DEFENSIVE", ...). */
  aiState = '';
  /** Formation / flight lead (for wingmen). */
  leaderId: number | null = null;
  /** Mission group this aircraft belongs to (for objectives). */
  groupId = '';
  /**
   * (player) Civil traffic shown: CIV boxes on the HMD, TSD and map, and TGT steps through it. Key I toggles
   * it; the mission runner sets it at the start (off, on in free flight). See civilHidden().
   */
  civilShown = true;
  /** Civil traffic a protect objective covers (kept by the mission runner): shown even with civilShown off. */
  missionCivil = false;

  /** Stats */
  kills = 0;
  shotsFired = 0;
  hits = 0;

  // EXTENSION (sim-core / combat agents may append optional fields below this line)
  /** (combat) Radar cross-section multiplier from external stores (LOADOUTS.rcsMultiplier); 1 = clean. */
  rcsMultiplier?: number;
  /** (sim-core) Private flight-model / world bookkeeping (engine spool, FBW filters, Auto-GCAS, AI timer, wreck). Opaque to other modules. */
  sim?: import('./flight/state').AircraftSimState;
  /** (missions) Short HMD tag of the jet's mission role (AircraftGroupDef.tag, e.g. 'STRK' for a strike package). */
  hudTag?: string;
  /** (sim-core) Auto-GCAS currently has control of the jet (HUD may show the GCAS chevrons / "AUTO GCAS"). */
  gcasActive?: boolean;
  /** (sim-core) Airframe buffet 0..1 (high AoA, departure, transonic high-g) — for camera shake / haptics. */
  buffet?: number;
  /** (civil) Landing gear extension 0 (up) .. 1 (down) — airliners animate it; others leave it unset. */
  gear?: number;
  /**
   * (civil) Scripted civil flight (neutral airliner traffic, see sim/civil). While alive the jet
   * follows its route kinematically instead of running the flight model; once destroyed it becomes
   * an ordinary falling wreck.
   */
  civil?: import('./civil/route').CivilFlight;
  /**
   * (civil) Scripted civil helicopter flight (rescue, police, sightseeing; sim/civil/heli.ts). Like `civil`: flown
   * kinematically while alive, a falling wreck once destroyed.
   */
  heli?: import('./civil/heli').HeliFlight;
  /**
   * (drone) One-way attack drone route (Shahed-136, see sim/drone/oneWay.ts). While alive the drone
   * flies it kinematically (no flight model, no AI) and dives into its target; once destroyed it is
   * an ordinary falling wreck. `oneWay.impacted` tells a drone that reached its target from one
   * that was shot down.
   */
  oneWay?: import('./drone/oneWay').OneWayFlight;

  constructor(
    readonly id: number,
    readonly type: AircraftType,
    public team: Team,
    opts: { name?: string; callsign?: string; radius?: number; rcs?: number; ir?: number } = {},
  ) {
    this.name = opts.name ?? type.toUpperCase();
    this.callsign = opts.callsign ?? this.name;
    this.radius = opts.radius ?? 8;
    this.rcsBase = opts.rcs ?? 5;
    this.irBase = opts.ir ?? 1;
    this.flight = {
      alpha: 0,
      beta: 0,
      tas: 0,
      ias: 0,
      mach: 0,
      gLoad: 1,
      gPeak: 1,
      altitude: 0,
      agl: 0,
      verticalSpeed: 0,
      heading: 0,
      pitch: 0,
      roll: 0,
      thrust: 0,
      engineRpm: 0.8,
      afterburner: 0,
      fuel: 0,
      fuelFlow: 0,
      mass: 0,
      stalled: false,
      autoThrottle: false,
      surfaces: { elevator: 0, aileron: 0, rudder: 0, flaps: 0, airbrake: 0 },
      overstress: 0,
      supersonic: false,
    };
  }
}

/* ───────────────────────────── Missiles & bombs ───────────────────────────── */

export type Guidance = 'active_radar' | 'semi_active' | 'ir' | 'command' | 'gps' | 'anti_radiation' | 'tri_mode';

/** Static munition definition (data lives in sim/weapons/defs.ts, owned by the COMBAT agent). */
export interface MunitionDef {
  id: MunitionId;
  /** Display name, e.g. "AIM-120D". */
  name: string;
  /** HUD short code, e.g. "AMRAAM", "9X", "JDAM". */
  short: string;
  category: 'aam' | 'sam' | 'agm' | 'bomb';
  guidance: Guidance;
  /** Launch style (visual + initial motion). */
  launch: 'rail' | 'eject' | 'drop' | 'vertical' | 'canted';
  mass: number;
  /** Motor: boost phase then sustain phase (accelerations along body axis, m/s²). 0 for bombs. */
  boostTime: number;
  boostAccel: number;
  sustainTime: number;
  sustainAccel: number;
  /** Lumped drag coefficient: deceleration = drag * rho * v² (per unit mass). */
  drag: number;
  /** Glide lift-to-drag for bombs/glide weapons (0 = ballistic). */
  glideRatio: number;
  maxG: number;
  /** Seeker half-angle field of view (rad). */
  seekerFov: number;
  /** Seeker gimbal limit (rad). */
  gimbalLimit: number;
  /** Range at which the seeker can acquire/track a typical target (m). */
  seekerRange: number;
  /** Proportional navigation constant. */
  navConstant: number;
  /** Nominal launch envelope vs a co-altitude non-maneuvering target (m). */
  minRange: number;
  maxRange: number;
  /** Proximity fuse radius (m). */
  fuseRadius: number;
  /** Warhead damage (hit points at the centre). */
  damage: number;
  /** Blast radius (m) — damage falls off linearly. */
  blastRadius: number;
  /** Self destruct after (s). */
  maxFlightTime: number;
  /** 0..1 resistance to flares / chaff / beam-notching. */
  flareResistance: number;
  chaffResistance: number;
  notchResistance: number;
  /** Visible smoke trail (SA-6/SA-10: heavy, AIM-120: light, bombs: none). 0..1 */
  smoke: number;
  /** Visuals. */
  length: number;
  diameter: number;
  // EXTENSION (combat agent may append optional fields)
}

export class MissileEntity implements Entity {
  readonly kind = 'missile' as const;
  team: Team;
  name: string;
  position = new Vector3();
  velocity = new Vector3();
  quaternion = new Quaternion();
  radius: number;
  alive = true;
  health = 1;
  maxHealth = 1;

  /** Entity id of launcher (aircraft or SAM site). */
  shooterId: number;
  /** Current target entity id (may switch to a decoy id). */
  targetId: number | null;
  /** Aim point for GPS weapons / last known target position. */
  targetPoint = new Vector3();
  age = 0;
  /** Motor currently burning (for flame + smoke visuals). */
  motorBurning = false;
  /** Seeker has the target (for active radar: "pitbull"). */
  seekerLocked = false;
  /** Guidance phase for HUD/debug. */
  phase: 'launch' | 'boost' | 'midcourse' | 'terminal' | 'ballistic' = 'launch';
  /** Decoyed by a flare/chaff (target now a decoy or lost). */
  decoyed = false;
  /** Closest approach to target so far (m) — for miss detection. */
  closestApproach = Infinity;

  // EXTENSION (combat agent may append optional fields)
  /** Shot down by a SAM site's point-defence interceptor: that site's entity id (set before 'munition:end'). */
  interceptedBy?: number;

  constructor(
    readonly id: number,
    readonly def: MunitionDef,
    team: Team,
    shooterId: number,
    targetId: number | null,
  ) {
    this.team = team;
    this.name = def.name;
    this.radius = Math.max(1, def.length * 0.5);
    this.shooterId = shooterId;
    this.targetId = targetId;
  }
}

/* ───────────────────────────── SAM sites ───────────────────────────── */

export type SamState = 'off' | 'search' | 'track' | 'launch' | 'guiding' | 'reload' | 'emcon';

export class SamSiteEntity implements Entity {
  readonly kind = 'sam' as const;
  team: Team;
  name: string;
  /** Ground position (y = terrain height at site). */
  position = new Vector3();
  velocity = new Vector3();
  /** Site orientation (yaw only). */
  quaternion = new Quaternion();
  radius: number;
  alive = true;
  health = 100;
  maxHealth = 100;

  state: SamState = 'search';
  /** Radar emitting (visible on RWR, attackable by AARGM). */
  radarOn = true;
  /** Search radar antenna azimuth (rad) — animated. */
  radarAzimuth = 0;
  /** Launcher azimuth/elevation (rad, world yaw/pitch) — animated. */
  launcherAzimuth = 0;
  launcherElevation = 0;
  trackedTargetId: number | null = null;
  /** Track quality 0..1 (reaches 1 => can launch). */
  trackProgress = 0;
  missilesReady: number;
  missilesMax: number;
  reloadTimer = 0;
  /** Missiles in flight being guided by this site. */
  guidedMissiles: number[] = [];
  lastLaunchTime = -999;
  /** Revealed on the player's TSD (known threat ring). */
  known = false;
  /** Mission group for objectives. */
  groupId = '';
  /**
   * A target of an active primary objective (kept by the mission runner): A/G auto-designation and
   * TGT cycling rank it above every other surface target.
   */
  objective = false;
  // EXTENSION (combat agent may append optional fields)
  /** (combat) Current max engagement range (m, difficulty-scaled) — TSD threat ring radius. */
  engageRange?: number;
  /** (combat) Search/acquisition range vs a 5 m² fighter (m, difficulty-scaled). */
  detectRange?: number;
  /** (sim-core) A moving SAM on a fast boat (the IRGC Navy AD boat, sim/boats.ts sails it); absent = a fixed site. */
  boat?: import('./boats').BoatState;
  /**
   * (combat) This site's close-in cue (an electro-optical tracker that stealth shaping doesn't beat), in place
   * of its type's SamTypeData.closeCue: a mission can give a fixed site the AD boat's tracker (g03's island SAMs).
   */
  closeCue?: { range: number; bayRange: number } | null;
  /**
   * The AD boat's long harassing shots (SamTypeData.harass, DifficultyParams.adBoatHarass) are off for
   * this site: a training boat (t05) fires only inside its real envelope.
   */
  noHarass?: boolean;
  /**
   * The crew never shuts its radar down against an inbound anti-radiation missile (SamTypeData.armDiscipline
   * is ignored): a range target, so the AARGM drill (t04) is passed by the rule it teaches.
   */
  noArmShutdown?: boolean;
  /**
   * Only the site's shoulder-launched heat-seekers (SamTypeData.manpads) fire: its radar SAM tracks but holds
   * (t05's heat-seeker drill, which grades only those).
   */
  irOnly?: boolean;
  /** Cease fire: the site tracks but launches nothing more (mission action 'hold_fire': a training boat whose drill is done). */
  holdFire?: boolean;

  constructor(
    readonly id: number,
    readonly type: SamType,
    team: Team,
    opts: { name?: string; radius?: number; missiles?: number } = {},
  ) {
    this.team = team;
    this.name = opts.name ?? type.toUpperCase();
    this.radius = opts.radius ?? 40;
    this.missilesMax = opts.missiles ?? 4;
    this.missilesReady = this.missilesMax;
  }
}

/* ───────────────────────────── Ground targets ───────────────────────────── */

export class GroundTargetEntity implements Entity {
  readonly kind = 'ground' as const;
  team: Team;
  name: string;
  position = new Vector3();
  velocity = new Vector3();
  quaternion = new Quaternion();
  radius: number;
  alive = true;
  health = 100;
  maxHealth = 100;
  /** Optional path to drive/sail along (world XZ; y is resolved to terrain/sea). */
  path: Vector3[] | null = null;
  pathIndex = 0;
  /** Movement speed along path (m/s). */
  speed = 0;
  /** Loops the path when reaching the end. */
  loopPath = false;
  groupId = '';
  known = true;
  /** A target of an active primary objective (as on SamSiteEntity): A/G designation ranks it first. */
  objective = false;
  /** Civil traffic a protect objective covers (g02's tanker): shown even with the player's civilShown off. */
  missionCivil = false;
  /**
   * Civil merchant ship ('ship' type, neutral team): container ship or cruise liner. Its hull is a
   * capsule along the heading (sim/civil/vessels.ts), and one bomb / missile hit sinks it.
   */
  vessel: VesselClass | null = null;
  /**
   * Bomb / missile hits a civil ship takes before it sinks (#19's rule is 1). Only a mission can
   * raise it (GroundTargetDef.hitsToSink: the escorted tanker takes 2); Damage counts `hits`.
   */
  hitsToSink = 1;
  /** Hits taken so far (bombs, missiles, a suicide boat's ram; civil ship with hitsToSink > 1): burning and slower once hit. */
  hits = 0;
  /** Riding at anchor (civil ship): the visual swings slowly about the bow. */
  anchored = false;
  /** Sim time it was destroyed (-1 = alive): paces the sinking / collapse animation. */
  destroyedAt = -1;
  /**
   * Drawn by the world scenery (a Wiri oil-terminal tank): the entity renderer adds no model, the
   * kill effects (fire, smoke column) still play at its position.
   */
  scenery = false;
  /**
   * A IRGC Navy fast boat (suicide / missile boat): sim/boats.ts sails it (chase, strike countdown,
   * route), not the ground-mover path above. Absent on every other ground target.
   */
  boat?: import('./boats').BoatState;
  /** g03's stoat (#200) and t07's rats: sim/runner.ts runs them (route, stops, alert, bolting, swimming), not the ground-mover path. */
  runner?: import('./runner').RunnerState;
  /**
   * A civil train ('train', #146): its unit in the sortie's timetable and its cars, posed every step by
   * the mission's TrainTraffic (missions/runtime/trains.ts); hit tests run along the cars (sim/civil/vessels.ts).
   */
  train?: TrainBody;
  /** Removed from the world at the next cleanup while alive (a civil train leaving the player's area). */
  despawn = false;

  constructor(
    readonly id: number,
    readonly type: GroundTargetType,
    team: Team,
    opts: { name?: string; radius?: number; health?: number } = {},
  ) {
    this.team = team;
    this.name = opts.name ?? type.toUpperCase();
    this.radius = opts.radius ?? 12;
    this.health = this.maxHealth = opts.health ?? 100;
  }
}

/** A civil train entity's consist (GroundTargetEntity.train). */
export interface TrainBody {
  /** TrainUnit.id in the sortie's TrainService (world.trains). */
  unit: number;
  /** Its line (rail.ts RAIL_LINES id; LINE_FREIGHT for the KiwiRail freight). */
  line: number;
  /** Its cars, refreshed every step while alive (frozen where it stopped once destroyed). */
  cars: import('./civil/rail').CarPose[];
}

/* ───────────────────────────── Decoys ───────────────────────────── */

export class DecoyEntity implements Entity {
  readonly kind = 'decoy' as const;
  team: Team;
  name: string;
  position = new Vector3();
  velocity = new Vector3();
  quaternion = new Quaternion();
  radius = 1;
  alive = true;
  health = 1;
  maxHealth = 1;
  age = 0;

  constructor(
    readonly id: number,
    readonly type: 'flare' | 'chaff',
    team: Team,
    public ownerId: number,
    /** Burn/bloom time (s). */
    public life: number,
    /** Decoy strength (IR intensity or radar return), decays over life. */
    public strength: number,
  ) {
    this.team = team;
    this.name = type;
  }
}

/* ───────────────────────────── Projectiles (bullets / shells) ───────────────────────────── */

/** Pooled; not an Entity (not targetable). Rendered as tracers. */
export interface Projectile {
  active: boolean;
  position: Vector3;
  velocity: Vector3;
  /** Position last step (for swept hit tests and tracer streaks). */
  prevPosition: Vector3;
  age: number;
  life: number;
  team: Team;
  shooterId: number;
  damage: number;
  /** Every Nth round is a tracer. */
  tracer: boolean;
  /** AAA flak shell that bursts at end of life. */
  flak: boolean;
  /** Visual calibre (m) — 0.025 for GAU-22, 0.023 for ZSU/GSh. */
  calibre: number;
}

export type AnyEntity = AircraftEntity | MissileEntity | SamSiteEntity | GroundTargetEntity | DecoyEntity;

/**
 * `e` is civil traffic the viewer has hidden (AircraftEntity.civilShown off): no box, no map symbol, and
 * TGT skips it. Civil traffic a protect objective covers (`missionCivil`) is never hidden.
 */
export function civilHidden(viewer: AircraftEntity, e: AnyEntity): boolean {
  if (e.team !== 'neutral' || viewer.civilShown) return false;
  return !((e.kind === 'aircraft' || e.kind === 'ground') && e.missionCivil);
}
