/**
 * F35-A — mission script schema (MISSIONS module).
 *
 * A MissionDef (core/contracts.ts) carries the briefing/UI data; its `script` field is a
 * MissionScript: everything the MissionRunner needs to populate and drive the mission —
 * aircraft spawn groups, SAM sites, ground targets, objectives, waypoints, triggers
 * (condition → actions), contextual hints, the AWACS controller, the area of operations
 * and (for Instant Action) the endless survival wave generator.
 *
 * Units: metres, seconds, m/s. Positions are world XZ (+X east, −Z north, origin = the Sky
 * Tower in the Auckland theatre). Headings are DEGREES (0 = north, clockwise). Altitudes are
 * metres MSL. Everything must stay within ±36 km of the origin.
 */
import type { AiRole } from '../sim/api';
import type {
  AircraftType,
  Difficulty,
  GroundTargetType,
  LoadoutId,
  SamType,
  Team,
  VoiceId,
} from '../core/types';
import type { WaypointKind } from '../core/contracts';

/** World XZ point (m). */
export interface XZ {
  x: number;
  z: number;
}

/** World XZ point with an altitude (m MSL). */
export interface XZA extends XZ {
  altitude: number;
}

/* ───────────────────────────── Conditions ───────────────────────────── */

/**
 * A boolean predicate over the mission state, evaluated by the runner at ~10 Hz.
 * Used for spawn triggers, objective activation, triggers and hints.
 */
export type Condition =
  /** Always true (mission start). */
  | { kind: 'start' }
  /** Mission time ≥ t seconds. */
  | { kind: 'time'; t: number }
  /** An objective is in the given state. */
  | { kind: 'objective'; id: string; state: 'active' | 'complete' | 'failed' }
  /**
   * Someone is inside a circle. `who` = the player (default) or any live member of a group.
   * Optional altitude band (m MSL) — e.g. `below: 150` for "low level" checks.
   */
  | { kind: 'area'; x: number; z: number; radius: number; who?: 'player' | { group: string }; below?: number; above?: number }
  /** At least `count` members of a group destroyed (default: all of them). The group must have spawned. */
  | { kind: 'group_destroyed'; group: string; count?: number }
  /**
   * At least `count` members of a group destroyed OR driven off (bugged out / withdrawn fighters),
   * default: all of them. The group must have spawned.
   */
  | { kind: 'group_defeated'; group: string; count?: number }
  /** The group has spawned. */
  | { kind: 'group_spawned'; group: string }
  /** The player has reached (captured) a waypoint. */
  | { kind: 'waypoint'; id: string }
  /** The player has destroyed at least `count` targets of a category. */
  | { kind: 'player_kills'; count: number; category?: 'air' | 'sam' | 'ground' | 'any' }
  /** A SAM (or AAA) site has launched at / engaged the player. */
  | { kind: 'sam_engaged' }
  /** A missile is currently tracking the player. */
  | { kind: 'missile_inbound' }
  /** No missile or bomb fired by a member of the group is still in flight. */
  | { kind: 'munitions_clear'; group: string }
  /** Another trigger has fired. */
  | { kind: 'trigger'; id: string }
  /** Player fired at least `count` weapons of any kind. */
  | { kind: 'player_fired'; count?: number }
  /**
   * The player's radar: 'designated' = a hostile aircraft has the TD box but no lock yet,
   * 'locked' = hard (STT) lock on a hostile aircraft.
   */
  | { kind: 'player_radar'; state: 'designated' | 'locked' }
  | { kind: 'all'; of: Condition[] }
  | { kind: 'any'; of: Condition[] }
  | { kind: 'not'; of: Condition };

/* ───────────────────────────── AI tasks ───────────────────────────── */

/** Mission-level AI task (resolved to a sim/api AiTask at spawn / re-task time). */
export type TaskDef =
  | { kind: 'patrol'; x: number; z: number; radius: number; altitude: number }
  | { kind: 'route'; points: XZA[]; loop?: boolean }
  /** Attack the player. */
  | { kind: 'attack_player' }
  /**
   * Attack a group. Air groups: its first live member. Ground / SAM groups: the attackers spread
   * over its live members and move on to another one when theirs is destroyed.
   */
  | { kind: 'attack_group'; group: string }
  /** Escort the first live member of a group (bombers, AWACS, strike package). */
  | { kind: 'escort_group'; group: string }
  /** Fly formation on / cover the player (wingmen). */
  | { kind: 'escort_player' }
  | { kind: 'rtb'; x: number; z: number; altitude: number };

/* ───────────────────────────── Spawns ───────────────────────────── */

/** Formation used to lay out the members of an aircraft group around its spawn point. */
export type Formation =
  | 'single' // everyone at the same point (only sensible for count 1)
  | 'pair' // echelon right, tight (fighter element)
  | 'echelon' // echelon right, looser
  | 'vic' // V
  | 'trail' // in trail (one behind the other)
  | 'wall' // line abreast, wide
  | 'box'; // 2 × 2 box (4-ships)

export interface AircraftGroupDef {
  /** Unique id — also stored in AircraftEntity.groupId (objectives/conditions reference it). */
  id: string;
  type: AircraftType;
  team: Team;
  /** Base size. Red groups are scaled by difficulty.enemyCountScale (rounded, min 1) unless `fixedCount`. */
  count: number;
  fixedCount?: boolean;
  /** Upper bound after scaling. */
  maxCount?: number;
  /**
   * Flown by a lesser type below a difficulty (Instant Action 'mixed': Su-35 / Su-57 only on
   * Veteran and Ace, a MiG-29 / Su-27 below).
   */
  downgrade?: { below: Difficulty; type: AircraftType };
  formation?: Formation;
  /** Distance between elements (m). Default 300 (fighters) / 600 (heavies). */
  spacing?: number;
  /** Lead position (m) + altitude (m MSL), heading (deg), speed (m/s). */
  x: number;
  z: number;
  altitude: number;
  heading: number;
  speed: number;
  role: AiRole;
  /** Absolute AI skill 0..1. Default: difficulty.aiSkill (+ skillOffset) for red, a competent 0.65+ for blue. */
  skill?: number;
  /** Added to the default skill (clamped 0..1). */
  skillOffset?: number;
  task?: TaskDef;
  /** When the group appears (default: at mission start). */
  spawn?: Condition;
  /** Only spawn on this difficulty or harder. */
  minDifficulty?: Difficulty;
  /** Radio callsign stem: "Viper" → "Viper 2", "Viper 3"… (numbering starts at `firstNumber`, default 1). */
  callsign?: string;
  firstNumber?: number;
  /** Plural noun the AWACS uses for this group ("bandits", "Backfires", "bombers"…). */
  noun?: string;
  /** AWACS announces the group when it spawns after the start (default true for red air). */
  announce?: boolean;
  /**
   * Enemy GCI: seconds after spawning before a patrolling fighter / CAP group is vectored onto
   * the player (keeps missions from stalling). Default 150 for red fighter/cap groups; 0 = never.
   */
  commitAfter?: number;
  /** Strip every store and the gun after spawning (training drones). */
  unarmed?: boolean;
  /** Fuel fraction 0..1. */
  fuel?: number;
  /** Friendly F-35 loadout. */
  loadout?: LoadoutId;
  /**
   * Enemy stores: 'strike' arms the jets with KAB-500S guided bombs (and two R-73s) instead of
   * their air-to-air fit. Pair it with an 'attack_group' task on a ground group.
   */
  enemyLoadout?: 'default' | 'strike';
}

export interface SamSiteDef {
  /** Unique id. */
  id: string;
  /** Objective group (several sites may share a group). */
  group: string;
  type: SamType;
  x: number;
  z: number;
  /** Deg. */
  heading?: number;
  /** Radar silent at spawn: pop-up ambush. Default false. */
  emcon?: boolean;
  /** Shown on the TSD / briefing from the start. Default: !emcon. */
  known?: boolean;
  name?: string;
  team?: Team;
  spawn?: Condition;
  minDifficulty?: Difficulty;
  /** Terrain flatten radius override (m). */
  pad?: number;
}

export interface GroundTargetDef {
  id: string;
  group: string;
  type: GroundTargetType;
  x: number;
  z: number;
  /** Deg. */
  heading?: number;
  /** Convoy / ship route (XZ). */
  path?: XZ[];
  speed?: number;
  loop?: boolean;
  name?: string;
  health?: number;
  /** Default 'red'. */
  team?: Team;
  spawn?: Condition;
  minDifficulty?: Difficulty;
  /** Terrain flatten radius override (m). Ships and movers never get a pad. */
  pad?: number;
  /**
   * The world scenery already draws this target (the Wiri tanks, core/sites.ts): no entity model
   * and no terrain pad; kill effects still play.
   */
  scenery?: boolean;
}

/* ───────────────────────────── Objectives ───────────────────────────── */

interface ObjectiveBase {
  id: string;
  /** HUD / briefing label, e.g. "Destroy the SA-6 site". */
  label: string;
  /** Primary objectives must all be completed to win; a failed primary fails the mission. */
  primary: boolean;
  /** Becomes active when this is true (default: active from the start). Pending until then. */
  activeAt?: Condition;
  /** Score bonus override (default 500 primary / 250 secondary). */
  bonus?: number;
  /** Only exists on this difficulty or harder (e.g. objectives about difficulty-gated groups). */
  minDifficulty?: Difficulty;
}

export type ObjectiveDef = ObjectiveBase &
  (
    | /** Destroy every member (or `count`) of the given groups (aircraft, SAMs or ground targets). */
    { kind: 'destroy'; groups: string[]; count?: number }
    | /** Destroy every hostile SAM/AAA site inside a circle. */
    { kind: 'destroy_sams'; x: number; z: number; radius: number }
    | /**
       * Keep a friendly group alive. Fails when fewer than `minSurvivors` (default 1) remain.
       * Completes when `until` is true, or automatically once every other primary is complete.
       */
    { kind: 'protect'; group: string; minSurvivors?: number; until?: Condition; /** Debrief row counting the survivors, e.g. "Fuel tanks saved". */ tally?: string }
    | /**
       * Stop a raid: fails if any live member of the groups gets within `radius` of the point.
       * Completes when they are all destroyed — or once `abortFraction` of them is destroyed,
       * the survivors turn for home.
       */
    { kind: 'intercept'; groups: string[]; x: number; z: number; radius: number; abortFraction?: number; abortTo?: XZA }
    | /** Fly through waypoints (in order). */
    { kind: 'waypoints'; waypoints: string[] }
    | /** Reach a point (optionally in an altitude band). */
    { kind: 'reach'; x: number; z: number; radius: number; below?: number; above?: number }
    | /**
       * Fly under the Harbour Bridge's navigation span (Auckland only). Completes on the same span
       * test as the once-per-mission stunt bonus (MissionRunner.updateBridge, `stats.bridge`), and the
       * stunt pays the points: this objective's default bonus is 0.
       */
    { kind: 'bridge' }
    | /** Stay alive (optionally inside an area) for `seconds` in total. */
    { kind: 'survive'; seconds: number; area?: { x: number; z: number; radius: number } }
    | /** Return to base: only becomes active when every other primary is complete. */
    { kind: 'rtb'; x: number; z: number; radius: number }
  );

/* ───────────────────────────── Waypoints ───────────────────────────── */

export interface WaypointDef {
  id: string;
  label: string;
  kind: WaypointKind;
  x: number;
  z: number;
  /** m MSL (default: 0 for target waypoints resolved to the ground, 1500 otherwise). */
  altitude?: number;
  /** Capture radius (m). Default 2500 (nav/ip/cap/rtb), 1500 (target). */
  radius?: number;
  /**
   * Waypoints tied to an objective only advance when that objective completes (or fails),
   * not on proximity — the steering cue stays on the target until it's dead.
   */
  objective?: string;
}

/* ───────────────────────────── Triggers & actions ───────────────────────────── */

export type Action =
  | { kind: 'radio'; from: string; text: string; voice?: VoiceId; priority?: number; team?: Team }
  | { kind: 'hud'; text: string; tone?: 'info' | 'good' | 'bad' | 'warn'; duration?: number }
  /** Show a HUD hint for `duration` s (default 8). */
  | { kind: 'hint'; text: string; duration?: number }
  | { kind: 'spawn'; group: string }
  | { kind: 'retask'; group: string; task: TaskDef }
  /** Mark SAM sites of a group as known (TSD rings) — e.g. after an intel update. */
  | { kind: 'reveal'; group: string }
  | { kind: 'activate_objective'; id: string }
  | { kind: 'set_waypoint'; id: string }
  /** Scripted strike: destroy all live members of `group`, credited to the first live member of `by`. */
  | { kind: 'strike'; group: string; by?: string }
  /** Darkstar calls the current air picture. */
  | { kind: 'picture' }
  | { kind: 'end'; success: boolean; reason: string };

export interface TriggerDef {
  id: string;
  when: Condition;
  /** Seconds between the condition becoming true and the actions firing. */
  delay?: number;
  /** Re-arm after firing: fires again every `repeat` seconds while the condition holds. */
  repeat?: number;
  actions: Action[];
}

/** A scripted contextual hint (shown on the HUD while `when` holds, until `until`). */
export interface HintDef {
  id: string;
  text: string;
  when: Condition;
  until?: Condition;
  /** Max seconds on screen (default 8). */
  duration?: number;
}

/* ───────────────────────────── AWACS, AO, survival ───────────────────────────── */

export interface AwacsDef {
  /** Default "DARKSTAR". */
  callsign?: string;
  /** 'braa' (bearing/range/altitude/aspect from the player) or 'bullseye' (from a named reference point). */
  style?: 'braa' | 'bullseye';
  bullseye?: { x: number; z: number; name: string };
  /** Seconds after the start for the first picture call (default 4). Negative = no initial call. */
  initialPictureAt?: number;
  /** Periodic picture updates (s, 0 = off). Default 100. */
  pictureInterval?: number;
  /** Disable the controller entirely. */
  silent?: boolean;
}

export interface SurvivalDef {
  /** Enemy types drawn from for each wave. */
  types: AircraftType[];
  /** Aircraft in wave 1; each wave adds `growth` (fractional ok). */
  baseCount: number;
  growth: number;
  maxCount: number;
  /** AI skill of wave 1 and increment per wave (clamped to 1). */
  skillStart: number;
  skillStep: number;
  /** Spawn ring distance from the player (m). */
  spawnDistance: number;
  /** Seconds between a wave being cleared and the next one arriving. */
  interWaveDelay: number;
  /** Rearm the player (stores/flares/some fuel/health) after each wave. */
  rearm: boolean;
}

export interface MissionScript {
  groups: AircraftGroupDef[];
  sams: SamSiteDef[];
  ground: GroundTargetDef[];
  objectives: ObjectiveDef[];
  waypoints: WaypointDef[];
  triggers: TriggerDef[];
  hints?: HintDef[];
  /** Built-in contextual tips (designate, SHOOT cue, notching, low level, JDAM) — training + early campaign. */
  autoHints?: boolean;
  awacs?: AwacsDef;
  /** Area of operations half-size (m). Default 38 km: leaving it → "RETURN TO AO", failure after 30 s. */
  aoHalfSize?: number;
  /** Nominal completion time used for the time bonus (s). Default: timeLimit or 480. */
  parTime?: number;
  /** Radio callsign of the player (default "Viper 1"). */
  playerCallsign?: string;
  /** Endless survival waves (Instant Action). */
  survival?: SurvivalDef;
  /**
   * Scale the TOTAL of the non-fixed red aircraft groups by difficulty.enemyCountScale instead of
   * each group on its own (Instant Action: 4 bandits in pairs → 3 on Recruit, 6 on Ace; per-group
   * rounding would leave pairs unchanged). Groups that lose all members don't spawn.
   */
  scaleEnemyTotal?: boolean;
  /** Opening radio calls at mission start (convenience for a 'start' trigger). */
  opening?: Action[];
  /** Radio line on success (after "Mission complete, RTB"). */
  successText?: string;
  /** Last mission of the campaign: success sets MissionResult.campaignComplete (campaign ending). */
  campaignFinale?: boolean;
}

/** Empty script (helper for builders). */
export function emptyScript(): MissionScript {
  return { groups: [], sams: [], ground: [], objectives: [], waypoints: [], triggers: [] };
}
