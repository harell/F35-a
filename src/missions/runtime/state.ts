/**
 * F35-A — mission runtime state shared by the MissionRunner and its helper modules
 * (spawner, conditions, objectives, AWACS, hints, callouts, survival).
 *
 * Plain data + tiny helpers; all logic lives in the helper modules.
 */
import type { EventBus } from '../../core/events';
import type { MissionDef, ObjectiveStatus, Waypoint } from '../../core/contracts';
import type { Difficulty, DifficultyParams, Team } from '../../core/types';
import type { CreateAiBrain, SimWorld } from '../../sim/api';
import type { AircraftEntity, AnyEntity } from '../../sim/entities';
import type { AircraftGroupDef, Condition, GroundTargetDef, MissionScript, ObjectiveDef, SamSiteDef, TaskDef, TriggerDef, WaypointDef } from '../schema';
import { RadioQueue } from './radio';

export interface RunnerDeps {
  createAi: CreateAiBrain;
  difficulty: DifficultyParams;
  events: EventBus;
}

/** Runtime of a mission group (aircraft flight, SAM battery, target compound…). */
export interface GroupRt {
  id: string;
  team: Team;
  /** Aircraft group definition (null for SAM / ground groups). */
  air: AircraftGroupDef | null;
  /** Members expected once everything has spawned (after difficulty scaling / filtering). */
  expected: number;
  /** Spawned entities (kept after death — check `alive`). */
  members: AnyEntity[];
  /** Sim time of the first spawn, -1 = not spawned yet. */
  spawnedAt: number;
  /** AWACS bookkeeping. */
  announced: boolean;
  threatCalled: boolean;
  /** GCI has vectored this group onto the player. */
  committed?: boolean;
  /** Current mission task (spawn task, then the latest re-task). */
  task?: TaskDef;
  /** Entity id of the member currently leading the group (-1 = none yet). */
  leadId?: number;
}

export interface ObjectiveRt {
  def: ObjectiveDef;
  /** Live status object (exposed through MissionRunnerApi.objectives). */
  status: ObjectiveStatus;
  /** Survive: seconds accumulated. */
  accum: number;
  /** Intercept: raid has turned back. */
  aborted: boolean;
  /** Destroy: members credited as driven off rather than killed (reduced bonus). */
  drivenOff: number;
}

export interface TriggerRt {
  def: TriggerDef;
  /** Sim time the condition first became true (-1 = not yet). */
  since: number;
  fired: boolean;
  nextRepeat: number;
}

export type PendingSite = { kind: 'sam'; def: SamSiteDef; when: Condition } | { kind: 'ground'; def: GroundTargetDef; when: Condition };

export interface WaypointRt {
  def: WaypointDef;
  wp: Waypoint;
}

/** What happened during the sortie (debrief tips and medals). */
export interface SortieStats {
  /** Munition / weapon of the last hit the player took, and what fired it. */
  lastHitWeapon: string | null;
  lastHitBy: 'sam' | 'aircraft' | 'ground' | null;
  lastHitType: string | null;
  /** How the player went down (player:down reason). */
  downReason: string | null;
  /** Player air-to-air missiles fired / fired before the SHOOT cue (outside the calibrated range). */
  aamShots: number;
  longShots: number;
  /** Player missiles that ended decoyed / self-destructed / in the dirt. */
  misses: number;
  /** Player went Winchester / was rearmed at Whenuapai. */
  winchester: number;
  rearms: number;
  /** Flew under the Harbour Bridge. */
  bridge: boolean;
  /** Player gun kills. */
  gunKills: number;
  /** Enemy aircraft driven off (credited, not killed). */
  drivenOff: number;
  /** Lowest AGL (m) while a live SA-10 was within 45 km (masking discipline). */
  sa10Exposed: number;
}

export function newSortieStats(): SortieStats {
  return {
    lastHitWeapon: null,
    lastHitBy: null,
    lastHitType: null,
    downReason: null,
    aamShots: 0,
    longShots: 0,
    misses: 0,
    winchester: 0,
    rearms: 0,
    bridge: false,
    gunKills: 0,
    drivenOff: 0,
    sa10Exposed: 0,
  };
}

const DIFF_ORDER: Difficulty[] = ['recruit', 'pilot', 'veteran', 'ace'];
/** True if `current` is at least `min` (undefined min = always). */
export function difficultyAtLeast(current: Difficulty, min: Difficulty | undefined): boolean {
  return !min || DIFF_ORDER.indexOf(current) >= DIFF_ORDER.indexOf(min);
}

export class MissionState {
  readonly script: MissionScript;
  world!: SimWorld;
  player: AircraftEntity | null = null;

  readonly groups = new Map<string, GroupRt>();
  /** Aircraft groups waiting for their spawn condition. */
  readonly pendingAir: GroupRt[] = [];
  /** SAM sites / ground targets waiting for their spawn condition. */
  readonly pendingSites: PendingSite[] = [];

  readonly objectives: ObjectiveRt[] = [];
  readonly objectiveById = new Map<string, ObjectiveRt>();
  readonly triggers: TriggerRt[] = [];
  readonly firedTriggers = new Set<string>();
  readonly waypoints: WaypointRt[] = [];
  readonly waypointsReached = new Set<string>();
  waypointIndex = 0;

  readonly radio: RadioQueue;

  /** Player-credited kills. */
  readonly kills = { air: 0, sam: 0, ground: 0 };
  /** Friendly (blue, non-player) aircraft lost. */
  friendlyLosses = 0;
  /** Hostile entities spawned so far (for the grade's kill share). */
  enemiesSpawned = 0;
  /** A SAM / AAA site has shot at the player. */
  samEngaged = false;
  /** Stunt bonus points (Harbour Bridge). */
  bonus = 0;
  /** Survival waves cleared. */
  waves = 0;
  /** A scripted 'strike' action is applying damage (its own radio covers it: no kill callouts). */
  scriptedStrike = false;

  /** Ending. */
  state: 'running' | 'success' | 'failed' = 'running';
  endReason = '';
  endTime = -1;
  /** Player died (for progress totals). */
  playerDied = false;

  /** Enemy aircraft credited as driven off (bugged out / withdrawn) — count as defeated for 'destroy' objectives. */
  readonly withdrawn = new Set<number>();
  /** Sim time each enemy aircraft started withdrawing (BUGOUT / RTB). */
  readonly withdrawSince = new Map<number, number>();
  /** Debrief bookkeeping (tips / medals). */
  readonly stats: SortieStats = newSortieStats();
  /** The runner has been disposed (mission torn down): every update is a no-op. */
  disposed = false;

  constructor(
    readonly def: MissionDef,
    readonly deps: RunnerDeps,
  ) {
    this.script = def.script;
    this.radio = new RadioQueue(deps.events);
  }

  get events(): EventBus {
    return this.deps.events;
  }

  get difficulty(): DifficultyParams {
    return this.deps.difficulty;
  }

  get time(): number {
    return this.world ? this.world.time : 0;
  }

  get callsign(): string {
    return this.script.playerCallsign ?? 'Viper 1';
  }

  /** Speaker label of the AWACS controller ("DARKSTAR"). */
  get awacsCallsign(): string {
    return this.script.awacs?.callsign ?? 'DARKSTAR';
  }

  /** The controller's callsign as spoken inside a call ("Darkstar"). */
  get awacsSpoken(): string {
    const c = this.awacsCallsign.toLowerCase();
    return c.charAt(0).toUpperCase() + c.slice(1);
  }

  group(id: string): GroupRt | undefined {
    return this.groups.get(id);
  }

  hud(text: string, tone: 'info' | 'good' | 'bad' | 'warn' = 'info', duration = 3): void {
    this.events.emit('hud:message', { text, tone, duration });
  }
}

/** Live members of a group. */
export function aliveCount(g: GroupRt): number {
  let n = 0;
  for (let i = 0; i < g.members.length; i++) if (g.members[i].alive) n++;
  return n;
}

/** Destroyed members of a group. */
export function deadCount(g: GroupRt): number {
  let n = 0;
  for (let i = 0; i < g.members.length; i++) if (!g.members[i].alive) n++;
  return n;
}

/** Members credited as driven off (alive, withdrawn from the fight). */
export function drivenOffCount(s: MissionState, g: GroupRt): number {
  if (s.withdrawn.size === 0) return 0;
  let n = 0;
  for (let i = 0; i < g.members.length; i++) {
    const m = g.members[i];
    if (m.alive && s.withdrawn.has(m.id)) n++;
  }
  return n;
}

/** Destroyed or driven-off members of a group ("defeated"). */
export function defeatedCount(s: MissionState, g: GroupRt): number {
  return deadCount(g) + drivenOffCount(s, g);
}

/** First live member (group lead), or null. */
export function firstAlive(g: GroupRt | undefined): AnyEntity | null {
  if (!g) return null;
  for (let i = 0; i < g.members.length; i++) if (g.members[i].alive) return g.members[i];
  return null;
}
