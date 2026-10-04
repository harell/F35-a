/**
 * F35-A — MissionRunner (implements MissionRunnerApi, core/contracts.ts).
 *
 * setup(): spawns the player ("Viper 1", briefed loadout and fuel), friendlies / wingmen,
 * enemy flights, SAM sites and ground targets.
 * update(): called after every 60 Hz sim step. The radio queue runs every step; the mission
 * logic runs at 10 Hz: delayed spawns → triggers → Harbour Bridge stunt → objectives → waypoint
 * sequencing → AO / time limit → AWACS → hints → win/lose check.
 * result(): score, grade and statistics for the debrief.
 *
 * Helper modules live in ./runtime (state, spawner, conditions, objectives, awacs, hints,
 * callouts, scoring, winchester (out-of-weapons and bingo calls; there is no rearming),
 * withdrawal (bandits that bug out count as driven off), debrief (tips, medals), landmarks (the Sky Tower: an enemy hit
 * damages it, a second or the player's own munition brings it down and fails the mission)).
 * dispose(): detaches every event handler and drops the world / entity references (Game calls it
 * on teardown — restarts must not leak the previous session).
 */
import { Vector3 } from 'three';
import type { CreateMissionRunner, MissionDef, MissionResult, MissionRunnerApi, ObjectiveStatus, Waypoint } from '../core/contracts';
import { AKL, BRIDGE_SPAN_T } from '../core/auckland';
import type { LoadoutId } from '../core/types';
import type { SimWorld } from '../sim/api';
import type { Action } from './schema';
import { AwacsController } from './runtime/awacs';
import { Callouts, sameFlight, type DownReason } from './runtime/callouts';
import type { MissionResultExt, TeamKill } from './runtime/resultExt';
import { evalCondition } from './runtime/conditions';
import { HintSystem } from './runtime/hints';
import { activateObjective, createObjectives, failOpenObjectives, markObjectiveTargets, objectiveSummary, protectTallies, updateObjectives } from './runtime/objectives';
import { URGENT_PRIORITY } from './runtime/radio';
import { REASONS, crashedInto } from './runtime/reasons';
import { computeScore, parTimeFor } from './runtime/scoring';
import { awardMedals, buildTips, deathReason } from './runtime/debrief';
import { WinchesterWatch } from './runtime/winchester';
import { WithdrawalMonitor } from './runtime/withdrawal';
import { attemptSeed, nextAttempt } from './runtime/variation';
import { assignGroundAttack, buildGroups, retaskGroup, spawnAirGroup, spawnGroundTarget, spawnInitial, spawnPlayer, spawnSamSite, updateGroupLead } from './runtime/spawner';
import { MissionState, firstAlive, type RunnerDeps, type TriggerRt, type WaypointRt } from './runtime/state';
import { CivilTraffic } from './runtime/civil';
import { CivilShipping } from './runtime/shipping';
import { LandmarkWatch } from './runtime/landmarks';
import { SightseeingLog } from './runtime/sightseeing';

/** Mission logic evaluation period (s). */
const EVAL_PERIOD = 0.1;
/** Seconds outside the AO before the mission fails. */
const AO_GRACE = 30;
const DEFAULT_AO = 38_000;
/** Free flight has no AO: past this half-size (m, near the edge of the 88 km terrain) a nudge back towards the city. */
const FREE_FLIGHT_EDGE = 42_000;
/** Seconds before a patrolling enemy fighter group is vectored onto the player. */
const DEFAULT_COMMIT = 150;

/**
 * Harbour Bridge navigation span (fraction along the south → north abutment line, ±71 m round its centre:
 * ≥ 48 m clear of the piers either side) and clearance.
 */
const BRIDGE_SPAN = { t0: BRIDGE_SPAN_T - 0.07, t1: BRIDGE_SPAN_T + 0.07, maxAlt: 41, minAlt: 2, bonus: 250 };

/** Seconds the mission-title banner shows on its own before the opening radio call. */
export const OPENING_DELAY = 2.5;

class MissionRunnerImpl implements MissionRunnerApi {
  readonly def: MissionDef;
  readonly objectives: ObjectiveStatus[] = [];
  readonly waypoints: Waypoint[] = [];

  private readonly s: MissionState;
  /** World time at which the opening actions run (-1 = done). */
  private openingAt = -1;
  private readonly awacs: AwacsController;
  private readonly hints: HintSystem;
  private readonly callouts: Callouts;
  private readonly winchester: WinchesterWatch;
  private readonly withdrawal: WithdrawalMonitor;
  /** Neutral airliners in and out of Auckland Airport (Auckland theatre only). */
  private readonly civil: CivilTraffic | null;
  /** Neutral container ships and cruise liners (Auckland theatre only, gated with the airliners). */
  private readonly shipping: CivilShipping | null;
  /** The Sky Tower (Auckland theatre): destroying it fails the mission. */
  private readonly landmarks: LandmarkWatch;
  /** Free flight: tour stops, distance and passes for the debrief. */
  private readonly sightseeing: SightseeingLog | null;
  private finalResult: MissionResult | null = null;
  private evalAcc = 0;
  private outsideAo = 0;
  private aoWarnAt = 0;
  private aoRadioDone = false;
  private timeWarnings = new Set<number>();
  private bridgeDone = false;
  private readonly lastPos = new Vector3();
  private hasLastPos = false;
  private isSetup = false;

  constructor(def: MissionDef, deps: RunnerDeps) {
    this.def = def;
    // retries vary: salted AI seed + jittered hostile spawns (attempt 0 = the designed mission)
    const attempt = nextAttempt(def.id);
    this.s = new MissionState(attempt > 0 ? { ...def, seed: attemptSeed(def.seed, attempt) } : def, deps);
    this.s.attempt = attempt;
    createObjectives(this.s);
    for (const o of this.s.objectives) this.objectives.push(o.status);
    for (const w of def.script.waypoints) {
      const target = w.kind === 'target';
      const wp: Waypoint = {
        id: w.id,
        label: w.label,
        kind: w.kind,
        radius: w.radius ?? (target ? 1500 : 2500),
        position: new Vector3(w.x, w.altitude ?? (target ? 0 : 1500), w.z),
      };
      const rt: WaypointRt = { def: w, wp };
      this.s.waypoints.push(rt);
      this.waypoints.push(wp);
    }
    for (const t of def.script.triggers) this.s.triggers.push({ def: t, since: -1, fired: false, nextRepeat: 0 });
    this.awacs = new AwacsController(this.s);
    this.winchester = new WinchesterWatch(this.s);
    this.withdrawal = new WithdrawalMonitor(this.s);
    this.hints = new HintSystem(this.s, this.winchester);
    this.callouts = new Callouts(this.s, (r) => this.onPlayerDown(r));
    const civilTraffic = def.theater === 'auckland' && deps.civilTraffic !== false;
    this.civil = civilTraffic ? new CivilTraffic(this.s) : null;
    this.shipping = civilTraffic ? new CivilShipping(this.s) : null;
    this.landmarks = new LandmarkWatch(this.s, (reason) => this.fail(reason));
    this.sightseeing = def.script.freeFlight ? new SightseeingLog(this.s) : null;
  }

  /* ───────────────────────────── API ───────────────────────────── */

  get state(): 'running' | 'success' | 'failed' {
    return this.s.state;
  }

  get currentWaypoint(): Waypoint | null {
    const s = this.s;
    if (s.disposed) return null;
    return s.waypoints[s.waypointIndex]?.wp ?? null;
  }

  get hint(): string | null {
    return this.s.disposed ? null : this.hints.current;
  }

  dispose(): void {
    const s = this.s;
    if (s.disposed) return;
    s.disposed = true;
    this.callouts.detach();
    this.landmarks.detach();
    s.radio.clear();
    this.hints.clear();
    s.world = null as unknown as SimWorld;
    s.player = null;
    for (const g of s.groups.values()) g.members.length = 0;
    s.pendingAir.length = 0;
    s.pendingSites.length = 0;
    s.withdrawn.clear();
    s.withdrawSince.clear();
    this.isSetup = false;
  }

  setup(world: SimWorld, loadout: LoadoutId): void {
    const s = this.s;
    s.world = world;
    buildGroups(s);
    const p = spawnPlayer(s, loadout);
    // free flight starts on the gun: with a bomb selected the CCIP blinked PICKLE over the city
    // from the first frame (playtest r3, 3.1-b); WPN still reaches every store
    if (s.script.freeFlight) {
      world.combat.selectWeapon(p, 'gun', world);
      // a calm cockpit (#113): radar off at the start (the player can turn it on); the civil traffic
      // shows as CIV boxes, and a tap or TGT designates it like anything else (owner, 2026-10-04)
      world.combat.setRadarEmitting(p, false, world);
    }
    spawnInitial(s);
    // (before the radar's first picture: A/G auto-designation ranks the primary targets first)
    markObjectiveTargets(s);
    this.civil?.setup();
    this.shipping?.setup();
    this.landmarks.setup();
    this.callouts.attach();
    // ground-level steering for target waypoints without an explicit altitude
    for (const w of s.waypoints) {
      if (w.def.altitude === undefined && w.def.kind === 'target') w.wp.position.y = world.terrain.surfaceHeightAt(w.def.x, w.def.z);
    }
    // sequenced opening (i2 review: title, radio, objectives and hint all landed in the first second
    // and buried the HMD): the title banner shows alone, then the opening radio follows
    s.hud(this.def.title.toUpperCase(), 'info', OPENING_DELAY);
    this.openingAt = world.time + OPENING_DELAY;
    this.isSetup = true;
  }

  update(world: SimWorld, dt: number): void {
    const s = this.s;
    if (!this.isSetup || s.disposed || world !== s.world) return;
    if (this.openingAt >= 0 && world.time >= this.openingAt) {
      this.openingAt = -1;
      for (const a of s.script.opening ?? []) this.runAction(a);
    }
    s.radio.update(world.time);
    this.evalAcc += dt;
    if (this.evalAcc < EVAL_PERIOD - 1e-6) return;
    const edt = this.evalAcc;
    this.evalAcc = 0;

    this.sightseeing?.update(edt);
    if (s.state !== 'running') {
      this.hints.update();
      return;
    }
    this.updateSpawns();
    for (const g of s.groups.values()) {
      if (!g.air || g.spawnedAt < 0) continue;
      updateGroupLead(s, g);
      assignGroundAttack(s, g);
    }
    this.updateCommits();
    this.updateTriggers();
    // before the objectives: a 'bridge' objective completes on the pass that sets stats.bridge
    this.updateBridge();
    updateObjectives(s, edt);
    this.updateWaypoints();
    this.updateBoundary(edt);
    this.updateTimeLimit();
    this.withdrawal.update();
    this.winchester.update();
    this.awacs.update();
    this.civil?.update();
    this.checkEnd();
    this.hints.update();
  }

  result(world: SimWorld): MissionResult {
    const s = this.s;
    if (s.disposed || !s.world) {
      if (this.finalResult) return this.finalResult;
      throw new Error('MissionRunner.result() after dispose()');
    }
    const p = s.player;
    const time = s.endTime >= 0 ? s.endTime : world.time;
    const sum = objectiveSummary(s);
    const shots = p?.shotsFired ?? 0;
    const hits = Math.min(shots, p?.hits ?? 0);
    const damageTaken = p ? (p.alive ? Math.max(0, ((p.maxHealth - p.health) / p.maxHealth) * 100) : 100) : 0;
    const success = s.state === 'success';
    const sc = computeScore({
      success,
      time,
      parTime: parTimeFor(this.def),
      kills: { ...s.kills },
      enemiesSpawned: s.enemiesSpawned,
      objectiveBonus: sum.bonus,
      primaryDone: sum.primaryDone,
      primaryTotal: sum.primaryTotal,
      secondaryDone: sum.secondaryDone,
      secondaryTotal: sum.secondaryTotal,
      shotsFired: shots,
      hits,
      damageTaken,
      friendlyLosses: s.friendlyLosses,
      civilianKills: s.civilianKills,
      bonus: s.bonus,
      scoreMultiplier: s.difficulty.scoreMultiplier,
      flightKills: s.flightKills,
    });
    const finale = success && this.def.kind === 'campaign' && !!s.script.campaignFinale;
    const r: MissionResult = {
      missionId: this.def.id,
      title: this.def.title,
      success,
      reason: s.endReason || (s.state === 'running' ? REASONS.aborted : ''),
      difficulty: s.difficulty.id,
      time,
      score: sc.score,
      grade: sc.grade,
      kills: { ...s.kills },
      friendlyLosses: s.friendlyLosses,
      shotsFired: shots,
      hits,
      accuracy: sc.accuracy,
      damageTaken: Math.round(damageTaken),
      objectives: this.objectives.map((o) => ({ ...o, progress: o.progress ? { ...o.progress } : undefined, threat: o.threat ? { ...o.threat } : undefined })),
    };
    // EXTENSION (not yet in the MissionResult contract): who else scored, for the debrief
    const team: TeamKill[] = [];
    for (const [callsign, n] of s.teamKills) team.push({ callsign, kills: n, flight: sameFlight(callsign, s.callsign) });
    team.sort((a, b) => b.kills - a.kills);
    (r as MissionResultExt).teamKills = team;
    (r as MissionResultExt).playerShare = sc.playerShare;
    if (s.civilianKills > 0) (r as MissionResultExt).civilianKills = s.civilianKills;
    if (s.civilianShipKills > 0) (r as MissionResultExt).civilianShipKills = s.civilianShipKills;
    const saved = protectTallies(s);
    if (saved.length) (r as MissionResultExt).saved = saved;
    // free flight: a crash ends the sortie but isn't a failed mission (no tips, no medals)
    if (s.script.freeFlight) r.freeFlight = true;
    if (this.sightseeing) (r as MissionResultExt).sightseeing = this.sightseeing.result();
    r.tips = r.freeFlight ? [] : buildTips(s, r);
    r.medals = r.freeFlight ? [] : awardMedals(s, r);
    if (finale) r.campaignComplete = true;
    this.finalResult = r;
    return r;
  }

  /* ───────────────────────────── Spawns & triggers ───────────────────────────── */

  private updateSpawns(): void {
    const s = this.s;
    for (let i = s.pendingAir.length - 1; i >= 0; i--) {
      const g = s.pendingAir[i];
      if (g.air?.spawn && evalCondition(g.air.spawn, s)) {
        s.pendingAir.splice(i, 1);
        spawnAirGroup(s, g);
      }
    }
    for (let i = s.pendingSites.length - 1; i >= 0; i--) {
      const ps = s.pendingSites[i];
      if (!evalCondition(ps.when, s)) continue;
      s.pendingSites.splice(i, 1);
      if (ps.kind === 'sam') spawnSamSite(s, ps.def);
      else spawnGroundTarget(s, ps.def);
    }
  }

  /**
   * Enemy GCI: patrolling fighter / CAP groups that have not found the player after a while
   * are vectored onto them, so a stealthy player can't stall a mission by being unseen.
   */
  private updateCommits(): void {
    const s = this.s;
    const p = s.player;
    if (!p || !p.alive) return;
    for (const g of s.groups.values()) {
      const def = g.air;
      if (!def || g.team !== 'red' || g.committed || g.spawnedAt < 0) continue;
      // escorts whose charges are all dead have nothing left to do: commit them at once
      if (def.task?.kind === 'escort_group') {
        const charge = s.groups.get(def.task.group);
        if (charge && charge.spawnedAt >= 0 && charge.members.length >= charge.expected && !firstAlive(charge)) {
          g.committed = true;
          retaskGroup(s, g.id, { kind: 'attack_player' });
        }
        continue;
      }
      if (def.role !== 'fighter' && def.role !== 'cap') continue;
      if (def.task && def.task.kind !== 'patrol') continue;
      const after = def.commitAfter ?? DEFAULT_COMMIT;
      if (after <= 0 || s.time - g.spawnedAt < after) continue;
      g.committed = true;
      retaskGroup(s, g.id, { kind: 'attack_player' });
    }
  }

  /** Spawn a group now (trigger action), whatever its spawn condition. */
  private spawnGroupNow(id: string): void {
    const s = this.s;
    const i = s.pendingAir.findIndex((g) => g.id === id);
    if (i >= 0) {
      const g = s.pendingAir[i];
      s.pendingAir.splice(i, 1);
      spawnAirGroup(s, g);
    }
    for (let k = s.pendingSites.length - 1; k >= 0; k--) {
      const ps = s.pendingSites[k];
      if (ps.def.group !== id) continue;
      s.pendingSites.splice(k, 1);
      if (ps.kind === 'sam') spawnSamSite(s, ps.def);
      else spawnGroundTarget(s, ps.def);
    }
  }

  private updateTriggers(): void {
    const s = this.s;
    const t = s.time;
    for (const tr of s.triggers) {
      if (tr.fired && !tr.def.repeat) continue;
      if (!evalCondition(tr.def.when, s)) {
        tr.since = -1;
        continue;
      }
      if (tr.since < 0) tr.since = t;
      if (t - tr.since < (tr.def.delay ?? 0)) continue;
      if (tr.fired && t < tr.nextRepeat) continue;
      this.fire(tr);
      if (s.state !== 'running') return;
    }
  }

  private fire(tr: TriggerRt): void {
    tr.fired = true;
    this.s.firedTriggers.add(tr.def.id);
    tr.nextRepeat = this.s.time + (tr.def.repeat ?? 0);
    for (const a of tr.def.actions) this.runAction(a);
  }

  private runAction(a: Action): void {
    const s = this.s;
    switch (a.kind) {
      case 'radio':
        s.radio.push({ from: a.from, text: a.text, voice: a.voice, priority: a.priority ?? 2, team: a.team });
        break;
      case 'hud':
        s.hud(a.text, a.tone ?? 'info', a.duration ?? 3);
        break;
      case 'hint':
        this.hints.force(a.text, a.duration ?? 8);
        break;
      case 'spawn':
        this.spawnGroupNow(a.group);
        break;
      case 'retask':
        retaskGroup(s, a.group, a.task);
        break;
      case 'reveal': {
        const g = s.groups.get(a.group);
        for (const m of g?.members ?? []) if (m.kind === 'sam' || m.kind === 'ground') m.known = true;
        break;
      }
      case 'activate_objective':
        activateObjective(s, a.id);
        break;
      case 'set_waypoint': {
        const i = s.waypoints.findIndex((w) => w.def.id === a.id);
        if (i >= 0) s.waypointIndex = i;
        break;
      }
      case 'strike': {
        const g = s.groups.get(a.group);
        const by = a.by ? firstAlive(s.groups.get(a.by)) : null;
        if (a.by && !by) break; // the package didn't make it
        s.scriptedStrike = true;
        try {
          for (const m of g?.members ?? []) {
            if (m.alive) s.world.applyDamage(m, m.maxHealth * 3 + 200, by?.id ?? null, 'gbu31');
          }
        } finally {
          s.scriptedStrike = false;
        }
        break;
      }
      case 'picture':
        this.awacs.callPicture();
        break;
      case 'end':
        if (a.success) this.succeed(a.reason);
        else this.fail(a.reason);
        break;
    }
  }

  /* ───────────────────────────── Navigation ───────────────────────────── */

  private updateWaypoints(): void {
    const s = this.s;
    const p = s.player;
    if (!p || !p.alive || s.waypointIndex >= s.waypoints.length) return;
    // Captures: any waypoint from the current one on can be captured by proximity. A later
    // capture (or a later target's objective completing) means the player has moved on, so
    // earlier plain nav/IP points are skipped. Target points wait for their objective, ring
    // points (part of a 'waypoints' objective) must be flown, and RTB points never count as
    // progress (the player often starts near home).
    let progressedTo = -1;
    for (let j = s.waypointIndex; j < s.waypoints.length; j++) {
      const w = s.waypoints[j];
      const dx = p.position.x - w.def.x;
      const dz = p.position.z - w.def.z;
      if (dx * dx + dz * dz <= w.wp.radius * w.wp.radius) {
        if (j === s.waypointIndex || w.def.kind !== 'rtb') s.waypointsReached.add(w.def.id);
        if (!w.def.objective && w.def.kind !== 'rtb') progressedTo = j;
      }
      if (w.def.objective && this.objectiveDone(w.def.objective)) progressedTo = Math.max(progressedTo, j);
    }
    for (;;) {
      const i = s.waypointIndex;
      const cur = s.waypoints[i];
      if (!cur) break;
      let done: boolean;
      if (cur.def.objective) done = this.objectiveDone(cur.def.objective);
      else if (s.waypointsReached.has(cur.def.id)) done = true;
      else done = i < progressedTo && this.skippable(cur);
      if (!done) break;
      if (s.waypointsReached.has(cur.def.id)) this.announceCapture(cur);
      s.waypointIndex++;
    }
  }

  /** Plain nav / IP / CAP points can be skipped; rings, RTB points and a free-flight tour's stops cannot. */
  private skippable(w: WaypointRt): boolean {
    // the stroll's tour: a detour past a later stop doesn't end the tour (playtest r2, 2.2-3)
    if (w.def.kind === 'rtb' || this.s.script.freeFlight) return false;
    for (const o of this.s.objectives) if (o.def.kind === 'waypoints' && o.def.waypoints.includes(w.def.id)) return false;
    return true;
  }

  private objectiveDone(id: string): boolean {
    const st = this.s.objectiveById.get(id)?.status.state;
    return st === 'complete' || st === 'failed';
  }

  /** HUD tick for ring/waypoint captures that belong to a 'waypoints' objective. */
  private announceCapture(w: WaypointRt): void {
    const s = this.s;
    if (s.script.freeFlight) {
      // the tour: tick each stop off, and say when it's done
      const n = s.waypoints.length;
      const i = s.waypoints.indexOf(w);
      s.hud(i === n - 1 ? 'TOUR COMPLETE' : `${w.def.label.toUpperCase()} ✓  ${i + 1}/${n}`, 'good', i === n - 1 ? 3 : 1.8);
      return;
    }
    for (const o of s.objectives) {
      if (o.def.kind !== 'waypoints' || o.status.state !== 'active') continue;
      const idx = o.def.waypoints.indexOf(w.def.id);
      if (idx >= 0) s.hud(`${w.def.label.toUpperCase()} ✓  ${idx + 1}/${o.def.waypoints.length}`, 'good', 1.8);
    }
  }

  /* ───────────────────────────── AO / time / stunts ───────────────────────────── */

  private updateBoundary(dt: number): void {
    const s = this.s;
    const p = s.player;
    if (!p || !p.alive) return;
    // free flight never fails over the AO: past the edge of the map, a nudge back (no countdown)
    const free = !!s.script.freeFlight;
    const half = free ? FREE_FLIGHT_EDGE : (s.script.aoHalfSize ?? DEFAULT_AO);
    const outside = Math.abs(p.position.x) > half || Math.abs(p.position.z) > half;
    if (!outside) {
      if (this.outsideAo > 0) s.hud(free ? 'BACK OVER AUCKLAND' : 'BACK IN THE AO', 'info', 2);
      this.outsideAo = 0;
      this.aoWarnAt = 0;
      return;
    }
    this.outsideAo += dt;
    if (free) {
      if (this.outsideAo >= this.aoWarnAt) {
        s.hud('EDGE OF THE MAP — TURN BACK', 'info', 2.5);
        this.aoWarnAt += 10;
      }
      return;
    }
    if (!this.aoRadioDone) {
      this.aoRadioDone = true;
      s.radio.push({ from: s.awacsCallsign, text: `${s.callsign}, ${s.awacsSpoken}, you are leaving the area of operations. Turn back now.`, priority: 3 });
    }
    if (this.outsideAo >= this.aoWarnAt) {
      const left = Math.max(0, Math.ceil(AO_GRACE - this.outsideAo));
      s.hud(`RETURN TO AO — ${left} s`, 'warn', 2.5);
      this.aoWarnAt += 5;
    }
    if (this.outsideAo >= AO_GRACE) this.fail(REASONS.ao);
  }

  private updateTimeLimit(): void {
    const s = this.s;
    const limit = this.def.timeLimit;
    if (!limit) return;
    const left = limit - s.time;
    for (const mark of [120, 60, 30]) {
      if (left <= mark && limit > mark + 10 && !this.timeWarnings.has(mark)) {
        this.timeWarnings.add(mark);
        s.hud(mark >= 60 ? `${mark / 60}:00 REMAINING` : `${mark} SECONDS REMAINING`, 'warn', 3);
      }
    }
    if (left <= 0) this.fail(REASONS.time);
  }

  /** Flying under the Harbour Bridge's navigation span: once-per-mission score bonus. */
  private updateBridge(): void {
    const s = this.s;
    const p = s.player;
    if (this.def.theater !== 'auckland' || !p || !p.alive) {
      this.hasLastPos = false;
      return;
    }
    if (this.hasLastPos && !this.bridgeDone) {
      const S = AKL.bridge_s;
      const N = AKL.bridge_n;
      const hit = segmentIntersect(this.lastPos.x, this.lastPos.z, p.position.x, p.position.z, S.x, S.z, N.x, N.z);
      if (hit >= BRIDGE_SPAN.t0 && hit <= BRIDGE_SPAN.t1 && p.position.y < BRIDGE_SPAN.maxAlt && p.position.y > BRIDGE_SPAN.minAlt) {
        this.bridgeDone = true;
        s.stats.bridge = true;
        s.bonus += BRIDGE_SPAN.bonus;
        s.hud(`UNDER THE HARBOUR BRIDGE!  +${BRIDGE_SPAN.bonus}`, 'good', 4);
        s.radio.push({ from: s.awacsCallsign, text: `${s.callsign}... did you just fly under the Harbour Bridge? We did not see that.`, priority: 2 });
      }
    }
    this.lastPos.copy(p.position);
    this.hasLastPos = true;
  }

  /* ───────────────────────────── Ending ───────────────────────────── */

  private checkEnd(): void {
    const s = this.s;
    if (s.state !== 'running') return;
    const sum = objectiveSummary(s);
    if (sum.primaryFailed) {
      this.fail(`Objective failed: ${sum.primaryFailed.def.label}`);
      return;
    }
    if (sum.primaryTotal > 0 && sum.primaryDone === sum.primaryTotal) this.succeed(REASONS.success);
  }

  private succeed(reason: string): void {
    const s = this.s;
    if (s.state !== 'running') return;
    s.state = 'success';
    s.endReason = reason;
    s.endTime = s.time;
    this.hints.clear();
    s.radio.push({ from: s.awacsCallsign, text: `${s.callsign}, ${s.awacsSpoken}. Mission complete, RTB.`, voice: 'a_mission_complete', priority: URGENT_PRIORITY });
    if (s.script.successText) s.radio.push({ from: s.awacsCallsign, text: s.script.successText, priority: 2 });
    s.hud('MISSION COMPLETE', 'good', 5);
    s.events.emit('mission:end', { success: true, reason });
    // steer home if the mission has an RTB waypoint
    const rtb = s.waypoints.findIndex((w) => w.def.kind === 'rtb');
    if (rtb >= 0) s.waypointIndex = rtb;
  }

  private fail(reason: string): void {
    const s = this.s;
    if (s.state !== 'running') return;
    s.state = 'failed';
    s.endReason = reason;
    s.endTime = s.time;
    this.hints.clear();
    failOpenObjectives(s);
    if (s.script.freeFlight) {
      // free flight has no mission to fail: a crash is just the end of the flight (playtest r2, 2.2-4)
      s.hud('FLIGHT OVER', 'info', 5);
    } else {
      s.radio.push({ from: s.awacsCallsign, text: `${s.callsign}, ${s.awacsSpoken}. Mission failed.`, voice: 'a_mission_failed', priority: URGENT_PRIORITY });
      s.hud('MISSION FAILED', 'bad', 5);
    }
    s.events.emit('mission:end', { success: false, reason });
  }

  private onPlayerDown(reason: DownReason): void {
    const s = this.s;
    s.playerDied = true;
    if (s.state !== 'running') return;
    s.radio.push({ from: s.awacsCallsign, text: `${s.callsign}, eject, eject!`, voice: 'a_eject', priority: URGENT_PRIORITY + 1 });
    // a named landmark the jet brought down (Spark Arena, the Auckland Museum: sim/buildings.ts) names itself
    const named = reason === 'building' ? s.world.structureStrike?.name : null;
    this.fail(reason === 'structure' ? REASONS.structure : named ? crashedInto(named) : reason === 'building' ? REASONS.building : deathReason(s, reason));
  }
}

/**
 * Segment AB (player motion) vs segment CD (bridge line): returns the parameter along CD
 * (0..1) of the crossing, or -1.
 */
export function segmentIntersect(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): number {
  const rx = bx - ax;
  const rz = bz - az;
  const sx = dx - cx;
  const sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return -1;
  const qx = cx - ax;
  const qz = cz - az;
  const t = (qx * sz - qz * sx) / den; // along AB
  const u = (qx * rz - qz * rx) / den; // along CD
  if (t < 0 || t > 1 || u < 0 || u > 1) return -1;
  return u;
}

export const createMissionRunner: CreateMissionRunner = (def, deps) => new MissionRunnerImpl(def, deps);
