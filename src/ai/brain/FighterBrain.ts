/**
 * F35-A — fighter pilot brain: roles 'fighter', 'interceptor', 'cap', 'escort' and the friendly
 * 'wingman'. One state machine, parameterised per role (FighterConfig).
 *
 * States (→ ac.aiState):
 *   PATROL / ROUTE / FORM / ESCORT / RTB     idle behaviours (task / role dependent)
 *   INTERCEPT  lead-collision on a bandit known only roughly (datalink / GCI), climbing for energy
 *   BVR        own-sensor track: set up and take the radar-missile shot (skill-based doctrine)
 *   CRANK      after a SARH/active launch: hold the bandit at the edge of the radar gimbal
 *   MERGE      head-on inside ~7 km: offset for turning room, IR shot if the seeker sees it
 *   BFM / GUNS dogfight (bfm.ts) and gun tracking (weapons.ts)
 *   DEFENSIVE / NOTCH   missile defence (defense.ts) or bandit at our six
 *   EXTEND     low energy, not offensive: unload and run to re-engage
 *   BUGOUT     out of weapons / damaged / bingo: run home (RTB once clear)
 *
 * Wingman pairs (ac.leaderId set on an AI jet): the wingman holds fighting wing until the leader
 * commits or it is threatened, then supports the leader's target.
 * Friendly 'wingman': fingertip / fighting wing on the player (or leaderId), engages hostile
 * fighters within 15 km and the player's designated target, radio calls, keeps out of the
 * player's gun line.
 */
import { Vector3 } from 'three';
import { forwardOf } from '../../core/math';
import type { AiRole, AiTask, SimWorld } from '../../sim/api';
import type { AircraftEntity } from '../../sim/entities';
import { isHostile, type WeaponId } from '../../core/types';
import { isStealthy } from '../../sim/sensors/signatures';
import { gammaForAltitude, type FlightIntent } from '../pilot/Autopilot';
import { FormationKeeper, SLOT_ESCORT, SLOT_FIGHTING_WING, SLOT_FINGERTIP } from '../pilot/formation';
import { aspectOf, clampN, dirTo, dirWithElevation, headingDir, interceptPoint, rotateHorizontal, signedHorizAngle } from '../geom';
import { Brain, tasForIas, type BrainOptions } from './Brain';
import { Awareness, type Bandit } from './awareness';
import { MissileDefense } from './defense';
import { WeaponsOfficer, inFrontOf } from './weapons';
import { Bfm, applyEnergyLimits } from './bfm';
import { StrikePlanner } from './strike';
import type { TickCtx } from './context';

const DEG = Math.PI / 180;

export interface FighterConfig {
  /** Commit on bandits within this range of us (m). */
  commitRange: number;
  /** GCI vectors onto the closest hostile even without a sensor contact (scramble). */
  gci: boolean;
  /** Protect a leader (escort). */
  escort: boolean;
  /** Friendly wingman of the player / leader. */
  friendlyWing: boolean;
}

export const FIGHTER_CONFIGS: Record<'fighter' | 'interceptor' | 'cap' | 'escort' | 'wingman', FighterConfig> = {
  fighter: { commitRange: 40_000, gci: false, escort: false, friendlyWing: false },
  interceptor: { commitRange: 70_000, gci: true, escort: false, friendlyWing: false },
  /** CAP with a patrol task commits on bandits within (patrol radius + 25 km) of the station. */
  cap: { commitRange: 35_000, gci: false, escort: false, friendlyWing: false },
  escort: { commitRange: 20_000, gci: false, escort: true, friendlyWing: false },
  wingman: { commitRange: 15_000, gci: false, escort: false, friendlyWing: true },
};

/** States in which a pilot counts as "engaged" (wingmen follow their leader into the fight). */
export const ENGAGED_STATES = new Set(['INTERCEPT', 'BVR', 'CRANK', 'MERGE', 'BFM', 'GUNS', 'DEFENSIVE', 'NOTCH', 'EXTEND']);

const _p = new Vector3();
const _q = new Vector3();
const _h = new Vector3();
const _j = new Vector3();
const _k = new Vector3();

export class FighterBrain extends Brain {
  private readonly cfg: FighterConfig;
  private readonly aw = new Awareness();
  private readonly defense = new MissileDefense();
  private readonly wpn = new WeaponsOfficer();
  private readonly bfm = new Bfm();
  private readonly form = new FormationKeeper();
  private readonly strike = new StrikePlanner();
  private readonly ctx: TickCtx;
  /** Air-to-ground attack task finished (weapons gone / target dead): egress home. */
  private strikeDone = false;
  /**
   * Spawned without any weapons (training target drone, unarmed transport): not "Winchester" —
   * it keeps flying its task (and defends itself) instead of bugging out; only an 'attack' task
   * makes it press in on its target (a harmless merge for gun / AIM-9X practice).
   */
  private unarmed = false;

  private targetId: number | null = null;
  private retargetAt = 0;
  /** Target of the current engagement (engagement start = doctrine roll + radio call). */
  private engagedId: number | null = null;
  /** Sim time the pilot starts acting on the current target (reaction delay). */
  private actAt = 0;
  private extendUntil = -1;
  private readonly extendDir = new Vector3();
  private crankSide = 0;
  private lastKills = 0;
  /** Altitude plan of the current engagement (fixed at commit time: no climbing ladders). */
  private engageAlt = -1;
  /** Player's designation at the last check (friendly wingman support). */
  private lastPlayerDes: number | null = null;
  /** Sim time of the last engagement tick (for quick mid-fight re-targeting). */
  private lastEngageTime = -99;
  /** Tail chase of a cold, non-threatening bandit: since when, and which bandit. */
  private chaseSince = -1;
  private chaseId = -1;
  /** Bandits the pilot gave up chasing (id → sim time until which they are ignored). */
  private readonly ignoreUntil = new Map<number, number>();
  /** Gun defence: since when a hostile gun has been nose-on, current jink leg and its end time. */
  private gunThreatSince = -1;
  private jinkUntil = -1;
  private jinkLegEnd = -1;
  private jinkSide = 1;
  private jinkStart = -1;
  private jinkRestUntil = -1;
  private readonly jinkPerp = new Vector3();

  constructor(role: AiRole, opts: BrainOptions, cfg: FighterConfig) {
    super(role, opts);
    this.cfg = cfg;
    this.ctx = {
      ac: null as unknown as AircraftEntity,
      world: null as unknown as SimWorld,
      it: this.pilot.intent,
      skill: null as unknown as TickCtx['skill'],
      now: 0,
      dt: 0,
      rng: this.rng,
      flares: (i: number) => this.flares(this.ctx.ac, i),
      chaff: (i: number) => this.chaff(this.ctx.ac, i),
    };
  }

  /** Current target id (debug / tests). */
  get target(): number | null {
    return this.targetId;
  }

  protected override onInit(ac: AircraftEntity): void {
    this.lastKills = ac.kills;
    let stores = ac.gunAmmo;
    for (const st of ac.stores) stores += st.count;
    this.unarmed = stores === 0;
  }

  protected override onTask(task: AiTask): void {
    if (task.kind === 'attack') {
      this.targetId = null;
      this.retargetAt = 0;
      this.strikeDone = false;
    }
  }

  protected think(ac: AircraftEntity, world: SimWorld, dt: number, it: FlightIntent): void {
    const c = this.ctx;
    c.ac = ac;
    c.world = world;
    c.it = it;
    c.skill = this.skill;
    c.now = this.now;
    c.dt = dt;
    this.aw.update(ac, world, this.skill, this.rng);

    if (ac.kills > this.lastKills) {
      this.lastKills = ac.kills;
      this.radio.call(world, ac, 'Splash one!', 'p_splash', 3, 'splash', 2);
    }

    // 1. survive: inbound missile the pilot has reacted to
    const inc = this.aw.threatMissile(this.now, ac.incoming);
    if (inc) {
      const label = this.defense.run(c, inc);
      if (label) {
        this.setState(label);
        if (this.radio.ready(world, ac, 'defending', 10)) this.radio.call(world, ac, `${ac.callsign}, defending!`, 'p_defending', 10, 'defending', 2);
        return;
      }
    } else this.defense.reset();

    // 2. out of the fight?
    if (this.shouldBugout(ac)) {
      this.flyBugout(ac, world, it);
      return;
    }
    if (this.unarmed && this.task?.kind !== 'attack') {
      this.idle(ac, world, it, dt);
      return;
    }

    // 3. pick / keep a target
    this.chooseTarget(ac, world);
    const b = this.aw.find(this.targetId);

    // 3b. air-to-ground attack task: press on unless a bandit is close / on us, then egress
    const ground = this.groundTarget(world);
    if (ground && !this.strikeDone) {
      if (!this.strike.hasStores(c)) this.strikeDone = true;
      else if (!(b && (b.threat > 0 || b.range < 8_000))) {
        const label = this.strike.run(c, ground);
        if (label) {
          this.setState(label);
          return;
        }
        this.strikeDone = true;
      }
    }
    if (this.strikeDone && !b) {
      this.rtb(ac, it, this.home);
      this.setState('EGRESS');
      return;
    }

    if (b && this.now >= this.actAt) {
      this.engage(ac, world, it, b);
      return;
    }

    // 4. enemy pairs stay together until one of them has the bandit on its own sensors
    const lead = this.leaderOf(ac, world);
    if (lead && !lead.isPlayer && !this.cfg.escort && !this.cfg.friendlyWing) {
      this.idle(ac, world, it, dt);
      return;
    }
    // interceptors run on GCI vectors until their sensors find the bandit
    if (this.gciChase(ac, world, it)) return;
    // spiked by a fighter radar we can't see: turn to put the RWR strobe on the nose
    if (!this.cfg.friendlyWing && !this.cfg.escort && this.spikeChase(ac, it)) return;

    // 5. idle behaviour
    this.idle(ac, world, it, dt);
  }

  /* ───────────────────────── target selection ───────────────────────── */

  /** Ground / SAM target of an 'attack' task (null for air targets or none). */
  private groundTarget(world: SimWorld) {
    if (this.task?.kind !== 'attack') return null;
    const e = world.getEntity(this.task.targetId);
    if (!e) {
      // target removed from the world: it's been destroyed — mission accomplished
      if (this.strike.released > 0) this.strikeDone = true;
      return null;
    }
    if (e.kind === 'aircraft' || e.kind === 'missile' || e.kind === 'decoy') return null;
    return e;
  }

  private leaderOf(ac: AircraftEntity, world: SimWorld): AircraftEntity | null {
    let id = ac.leaderId;
    if (this.task?.kind === 'escort') id = this.task.leaderId;
    if (this.cfg.friendlyWing && id == null) id = world.player?.id ?? null;
    const e = world.getEntity(id);
    if (!e || e.kind !== 'aircraft' || !e.alive || e === ac || e.team !== ac.team) return null;
    return e;
  }

  private chooseTarget(ac: AircraftEntity, world: SimWorld): void {
    // a wingman re-targets at once when the player calls a new target
    if (this.cfg.friendlyWing) {
      const des = world.player?.radar.designatedId ?? null;
      if (des !== this.lastPlayerDes) {
        this.lastPlayerDes = des;
        this.retargetAt = 0;
      }
    }
    const cur = this.aw.find(this.targetId);
    if (cur && this.now < this.retargetAt) return;
    this.retargetAt = this.now + this.skill.retargetInterval;

    const leader = this.leaderOf(ac, world);
    const cfg = this.cfg;
    const pairWing = !!leader && !cfg.escort && !cfg.friendlyWing && !leader.isPlayer;
    const leaderEngaged = pairWing && ENGAGED_STATES.has(leader!.aiState);
    const playerDes = cfg.friendlyWing ? (world.player?.radar.designatedId ?? null) : null;
    const leaderDes = leader ? leader.radar.designatedId : null;
    const attackId = this.task?.kind === 'attack' ? this.task.targetId : null;
    const rtb = this.task?.kind === 'rtb';
    // CAP defends its station: commit on bandits approaching the patrol area
    const capStation = this.role === 'cap' && this.task?.kind === 'patrol' ? this.task : null;

    let best: Bandit | null = null;
    let bestScore = -Infinity;
    for (const b of this.aw.bandits) {
      // a bandit we gave up chasing stays ignored unless it turns on us or comes close
      const ign = this.ignoreUntil.get(b.id);
      if (ign !== undefined) {
        if (this.now < ign && b.threat === 0 && b.range > 6_000 && aspectOf(b.pos, b.vel, ac.position) < 100 * DEG) continue;
        this.ignoreUntil.delete(b.id);
      }
      let ok: boolean;
      if (b.id === attackId) ok = true;
      else if (cfg.escort && leader) ok = b.pos.distanceTo(leader.position) <= 20_000 || (b.threat > 0 && b.range < 12_000);
      else if (cfg.friendlyWing) ok = (b.fighter && b.range <= 15_000) || (b.id === playerDes && b.range <= 25_000) || (b.threat > 0 && b.range < 12_000);
      else if (pairWing && !leaderEngaged) ok = b.range < 8_000 || b.threat > 0;
      else if (rtb) ok = b.threat > 0 && b.range < 10_000;
      else if (capStation) ok = b.pos.distanceTo(capStation.center) <= capStation.radius + 25_000 || b.threat > 0 || b.range < 10_000;
      else ok = b.range <= cfg.commitRange;
      if (!ok) continue;
      let s = -b.range / 1_000 + b.threat * 8 + (b.own ? 3 : 0) + (b.fighter ? 2 : 0);
      if (b.id === this.targetId) s += 6;
      if (b.id === attackId) s += 30;
      if (b.id === playerDes) s += 20;
      if (b.id === leaderDes) s += 10;
      if (ac.team === 'red' && b.ent.isPlayer) s += 3;
      if (s > bestScore) {
        bestScore = s;
        best = b;
      }
    }
    const newId = best ? best.id : null;
    if (newId !== null && newId !== this.engagedId) {
      // new engagement: the pilot needs a moment to react, then rolls the shot doctrine
      this.engagedId = newId;
      // already fighting (switching targets / after a kill): eyes are out, react quickly
      const hot = this.now - this.lastEngageTime < 5;
      this.actAt = this.now + (hot ? 0.25 : best!.threat > 0 ? 0.5 : 1) * this.skill.reaction;
      this.wpn.newEngagement(this.skill.level, this.rng);
      this.extendUntil = -1;
      this.crankSide = 0;
      const perf = this.perfOf(ac);
      this.engageAlt = clampN(Math.max(ac.position.y, best!.pos.y) + 800 * this.skill.energy, Math.max(1_200, this.skill.minAgl + 600), Math.min(9_000, perf.ceiling - 2_000));
      if (this.radio.ready(world, ac, 'engaged', 12)) this.radio.call(world, ac, `${ac.callsign}, engaged.`, 'p_engaged', 12, 'engaged', 1);
    }
    this.targetId = newId;
  }

  /* ───────────────────────── engagement ───────────────────────── */

  private selectWeapon(ac: AircraftEntity, world: SimWorld, wvr: boolean): void {
    const bvr = this.wpn.bvrLeft(this.ctx);
    const ir = this.wpn.irLeft(this.ctx);
    let want: WeaponId;
    if (wvr) want = ir > 0 ? 'aim9x' : ac.gunAmmo > 0 ? 'gun' : 'aim120';
    else want = bvr > 0 ? 'aim120' : ir > 0 ? 'aim9x' : 'gun';
    if (ac.selectedWeapon !== want) world.combat.selectWeapon(ac, want, world);
  }

  /**
   * Hostile pilots don't chase a cold, non-threatening bandit forever (a fleeing F-35 runs back
   * under its own air defences): after a skill-based time (rookie ≈ 30 s … ace ≈ 85 s) of tail
   * chase they break off and ignore it for a minute unless it turns back or comes close.
   * Returns true when the chase was abandoned.
   */
  private chaseLimit(ac: AircraftEntity, b: Bandit): boolean {
    if (ac.team !== 'red' || this.task?.kind === 'attack') return false;
    const cold = b.threat === 0 && b.range > 3_000 && aspectOf(b.pos, b.vel, ac.position) < 60 * DEG;
    if (!cold) {
      if (this.chaseId === b.id) this.chaseSince = -1;
      return false;
    }
    if (this.chaseId !== b.id || this.chaseSince < 0) {
      this.chaseId = b.id;
      this.chaseSince = this.now;
    }
    if (this.now - this.chaseSince < 20 + 75 * this.skill.level) return false;
    this.ignoreUntil.set(b.id, this.now + 60);
    this.chaseSince = -1;
    this.targetId = null;
    this.engagedId = null;
    return true;
  }

  private engage(ac: AircraftEntity, world: SimWorld, it: FlightIntent, b: Bandit): void {
    const c = this.ctx;
    const skill = this.skill;
    if (this.chaseLimit(ac, b)) {
      this.idle(ac, world, it, c.dt);
      return;
    }
    this.lastEngageTime = this.now;
    if (ac.radar.designatedId !== b.id) world.combat.designate(ac, b.id, world);
    const R = b.range;

    // extending to regain energy
    if (this.extendUntil > this.now) {
      if (R > 10_000 || (b.threat >= 2 && R < 2_500)) this.extendUntil = -1;
      else {
        dirWithElevation(this.extendDir, ac.flight.agl > 1_500 ? -0.1 : 0, it.dir);
        it.throttle = 1;
        it.gMax = 3;
        it.gain = 1;
        this.setState('EXTEND');
        return;
      }
    }

    const mergeR = b.fighter ? 7_000 : 4_000;
    this.selectWeapon(ac, world, R < mergeR);
    if (R > mergeR) {
      const sup = this.wpn.needsSupport(c);
      if (sup && sup.targetId === b.id && b.sensor) {
        this.crank(ac, it, b);
        this.setState('CRANK');
        return;
      }
      this.crankSide = 0;
      const bvrReady = b.own && this.wpn.bvrLeft(c) > 0;
      this.intercept(ac, it, b, bvrReady);
      this.setState(bvrReady ? 'BVR' : 'INTERCEPT');
      if (b.sensor || ac.team === 'blue') this.wpn.tryBvr(c, b);
      this.keepOutOfPlayersWay(ac, world, it);
      return;
    }

    // inside visual / merge range
    this.wpn.tryIr(c, b);
    const aa = aspectOf(b.pos, b.vel, ac.position);
    if (R > 3_000 && aa < 100 * DEG && b.threat < 2) {
      // stern conversion on a bandit that isn't fighting us: sprint in, shoot on the way
      this.intercept(ac, it, b, true);
      this.wpn.tryBvr(c, b);
      this.setState('INTERCEPT');
      this.keepOutOfPlayersWay(ac, world, it);
      return;
    }
    if (b.fighter && R > 2_500 && aa > 120 * DEG) {
      this.merge(ac, it, b);
      if (R > 3_000) this.wpn.tryBvr(c, b);
      this.setState('MERGE');
      this.keepOutOfPlayersWay(ac, world, it);
      return;
    }
    if (this.gunDefense(ac, it, b)) {
      this.setState('DEFENSIVE');
      return;
    }
    let label = this.bfm.run(c, b);
    if (R > 2_000 && this.wpn.irLeft(c) === 0) this.wpn.tryBvr(c, b);
    if (label === 'BFM' && this.wpn.gunnery(c, b)) {
      label = 'GUNS';
      applyEnergyLimits(c, true);
    }
    // losing the fight on energy: extend and come back
    if (label === 'BFM' && skill.energy > 0.55 && b.fighter && R > 1_500 && b.threat < 2 && aa > 90 * DEG && ac.flight.ias < this.perfOf(ac).cornerSpeed * 0.55) {
      this.extendUntil = this.now + 6 + 4 * this.rng();
      this.extendDir.set(ac.position.x - b.pos.x, 0, ac.position.z - b.pos.z).normalize();
      label = 'EXTEND';
    }
    this.setState(label);
    if (label !== 'GUNS') this.keepOutOfPlayersWay(ac, world, it);
  }

  /** Lead-collision intercept with an energy (altitude/speed) plan. */
  private intercept(ac: AircraftEntity, it: FlightIntent, b: Bandit, bvr: boolean): void {
    const skill = this.skill;
    const perf = this.perfOf(ac);
    const fast = skill.energy > 0.5;
    let speed = Math.max(tasForIas(fast ? 250 : 215, ac.position.y), fast ? 290 : 250);
    // tail chase: sprint so the closure (and the missile's rMax) grows
    const tailChase = aspectOf(b.pos, b.vel, ac.position) < 70 * DEG;
    if (tailChase) speed = Math.max(speed, b.vel.length() + 140);
    interceptPoint(ac.position, Math.max(speed, ac.flight.tas), b.pos, b.vel, _p, 240);
    const alt = this.engageAlt > 0 ? this.engageAlt : clampN(b.pos.y + 600 * skill.energy, Math.max(1_200, skill.minAgl + 600), Math.min(9_000, perf.ceiling - 2_000));
    let gamma = gammaForAltitude(ac, alt, 0.3, 6);
    if (b.range < 15_000) {
      // close in: point more directly at the bandit (radar / missile geometry)
      const los = Math.atan2(b.pos.y - ac.position.y, Math.max(1, Math.hypot(b.pos.x - ac.position.x, b.pos.z - ac.position.z)));
      const w = clampN((15_000 - b.range) / 8_000, 0, 1);
      gamma = gamma * (1 - w) + clampN(los, -0.5, 0.5) * w;
    }
    _h.set(_p.x - ac.position.x, 0, _p.z - ac.position.z);
    // about to enter the launch zone: point at the bandit for the shot (missiles hate
    // big off-boresight launches)
    const z = bvr ? this.wpn.recentZone(b.id, this.now) : null;
    if ((z && z.rMax > 0 && z.range < z.rMax * 1.25) || b.range < 7_000) {
      _h.set(b.pos.x - ac.position.x, 0, b.pos.z - ac.position.z);
      gamma = clampN(Math.atan2(b.pos.y - ac.position.y, Math.max(1, Math.hypot(_h.x, _h.z))), -0.5, 0.5);
    }
    dirWithElevation(_h, gamma, it.dir);
    it.speed = speed;
    it.allowAb = fast || tailChase || b.range < 20_000;
    // a clean stealth jet keeps out of afterburner once inside an IRST's reach (the plume is
    // what it sees): MIL inside ~25 km unless chasing a runner
    if (isStealthy(ac) && (ac.rcsMultiplier ?? 1) <= 1.5 && b.range < 25_000 && !tailChase) {
      it.allowAb = false;
      it.speed = Math.min(it.speed, tasForIas(250, ac.position.y));
    }
    it.gMax = Math.min(bvr ? 5 : 4, skill.maxG);
    it.gain = 1.1;
    it.track = b.range < 20_000;
  }

  /** Crank: bandit at ~50° off the nose (edge of the radar gimbal) while our missile flies. */
  private crank(ac: AircraftEntity, it: FlightIntent, b: Bandit): void {
    _h.set(b.pos.x - ac.position.x, 0, b.pos.z - ac.position.z).normalize();
    if (this.crankSide === 0) {
      const s = signedHorizAngle(_h, ac.velocity);
      this.crankSide = s >= 0 ? 1 : -1;
    }
    const ang = (42 + 12 * this.skill.level) * DEG;
    rotateHorizontal(_h, this.crankSide * ang, _q);
    dirWithElevation(_q, ac.flight.agl > 3_000 ? -0.06 : 0, it.dir);
    it.speed = tasForIas(230, ac.position.y);
    it.allowAb = ac.flight.ias < this.perfOf(ac).cornerSpeed * 0.95;
    it.gMax = Math.min(3, this.skill.maxG);
    it.gain = 0.9;
  }

  /**
   * Gun defence reflex (head-on snapshot / guns tracking): a hostile fighter's nose within a few
   * degrees of us inside ~1.7 km and closing → an out-of-plane jink (random direction around the
   * line of sight, re-rolled every 0.45–0.9 s, 2.5–5.5 g by defensive skill). The LCOS solution
   * assumes a constant target velocity, so each new jink leg walks the stream off. Rookies notice
   * later (0.2–1.1 s) and jink softer; aces see the threat in a wider cone and jink hard.
   */
  private gunDefense(ac: AircraftEntity, it: FlightIntent, b: Bandit): boolean {
    const e = b.ent;
    const def = this.skill.defense;
    const R = b.range;
    let threat = false;
    if (b.fighter && e.alive && e.gunAmmo > 0 && R < 1_700 && R > 100) {
      forwardOf(e.quaternion, _j);
      _k.subVectors(ac.position, e.position);
      const cone = (3.5 + 5 * def) * DEG;
      const closing = _k.dot(e.velocity) - _k.dot(ac.velocity) > 0;
      // nose on us (snapshot) — or on our lead point (tracking): in the shooter's frame the
      // rounds fly along its nose while we move with (v_us − v_shooter) for the time of flight
      threat = (closing || R < 900) && _j.dot(_k) > R * Math.cos(cone);
      if (!threat) {
        const tof = R / 1_050;
        _k.addScaledVector(ac.velocity, tof).addScaledVector(e.velocity, -tof);
        threat = _j.dot(_k) > _k.length() * Math.cos(cone);
      }
    }
    // mutual nose-on inside our own gun range: a veteran / ace takes the snapshot instead
    if (threat && this.skill.level >= 0.6 && ac.gunAmmo > 0 && R < this.skill.gunRange * 1.4) {
      forwardOf(ac.quaternion, _j);
      _k.subVectors(e.position, ac.position);
      if (_j.dot(_k) > R * Math.cos(0.12)) return false;
    }
    if (!threat) {
      this.gunThreatSince = -1;
      if (this.now >= this.jinkUntil) {
        this.jinkStart = -1;
        return false;
      }
    } else {
      if (this.now < this.jinkRestUntil) return false; // a rookie "freezes" between jinks
      if (this.gunThreatSince < 0) this.gunThreatSince = this.now;
      if (this.now - this.gunThreatSince < 0.2 + 0.9 * (1 - def)) return false;
      if (this.jinkStart < 0) this.jinkStart = this.now;
      // a gunner already behind us (tracking, same direction) wins in the end: jinks buy time
      // but each one ends in a predictable stretch; head-on, a good pilot jinks until the pass
      const tracking = ac.velocity.dot(e.velocity) > 0;
      const budget = tracking ? 1.2 + 0.8 * def : 1 + 5 * def * def;
      if (this.now - this.jinkStart > budget) {
        // out of ideas (rookie) / reversing: a predictable straight stretch before the next jink
        this.jinkStart = -1;
        this.jinkRestUntil = this.now + (tracking ? 1.5 + 1.5 * (1 - def) : 3.5 * (1 - def));
        this.jinkUntil = -1;
        return false;
      }
      this.jinkUntil = this.now + 0.6 + 0.6 * def; // keep jinking a moment after the nose leaves us
    }
    if (this.now >= this.jinkLegEnd) {
      // new jink leg: pull along the lift vector rotated ±(15–75)° about the flight path,
      // alternating sides (a hard, quick out-of-plane "scissors" the gunner cannot predict)
      _k.copy(ac.velocity).normalize();
      _j.set(0, 1, 0).applyQuaternion(ac.quaternion).addScaledVector(_k, -_j.dot(_k));
      if (_j.lengthSq() < 1e-4) _j.set(0, 1, 0);
      _j.normalize();
      _h.crossVectors(_k, _j);
      this.jinkSide = this.jinkSide >= 0 ? -1 : 1;
      const a = this.jinkSide * (15 + 60 * this.rng()) * DEG;
      this.jinkPerp.copy(_j).multiplyScalar(Math.cos(a)).addScaledVector(_h, Math.sin(a));
      if (ac.flight.agl < 900 && this.jinkPerp.y < 0) this.jinkPerp.y = -this.jinkPerp.y * 0.3;
      this.jinkLegEnd = this.now + 0.45 + 0.45 * this.rng();
    }
    it.dir.copy(ac.velocity).normalize().addScaledVector(this.jinkPerp, 0.7 + 0.5 * def).normalize();
    it.gMax = Math.min(2 + 4.5 * def, this.skill.maxG);
    it.gain = 2;
    it.track = false;
    it.throttle = 1;
    return true;
  }

  /** Head-on merge: aim to pass ~700 m abeam for turning room (lead turn). */
  private merge(ac: AircraftEntity, it: FlightIntent, b: Bandit): void {
    const skill = this.skill;
    dirTo(ac.position, b.pos, _h);
    const side = signedHorizAngle(_h, ac.velocity) >= 0 ? 1 : -1;
    const offset = skill.level > 0.4 ? 700 : 150;
    _p.set(b.pos.x - _h.z * offset * side, b.pos.y, b.pos.z + _h.x * offset * side);
    it.dir.subVectors(_p, ac.position).normalize();
    const corner = this.perfOf(ac).cornerSpeed;
    if (skill.energy > 0.5) {
      it.speed = corner * 1.25 * (ac.flight.tas / Math.max(1, ac.flight.ias));
      it.allowAb = true;
    } else it.throttle = 1;
    it.gMax = Math.min(5, skill.maxG);
    it.gain = 1.4;
  }

  /** Friendly wingmen stay out of the player's gun line / missile boresight. */
  private keepOutOfPlayersWay(ac: AircraftEntity, world: SimWorld, it: FlightIntent): void {
    const p = world.player;
    if (!p || !p.alive || p.team !== ac.team || p === ac) return;
    if (!inFrontOf(p, ac, 12 * DEG, 4_000)) return;
    // push away from the player's boresight line
    _q.set(0, 0, -1).applyQuaternion(p.quaternion);
    _p.subVectors(ac.position, p.position);
    _p.addScaledVector(_q, -_p.dot(_q));
    if (_p.lengthSq() < 1) _p.set(1, 0, 0).applyQuaternion(p.quaternion);
    it.dir.addScaledVector(_p.normalize(), 0.6).normalize();
  }

  /* ───────────────────────── GCI / idle / bugout ───────────────────────── */

  private gciChase(ac: AircraftEntity, world: SimWorld, it: FlightIntent): boolean {
    let target: AircraftEntity | null = null;
    if (this.task?.kind === 'attack') {
      const e = world.getEntity(this.task.targetId);
      if (e && e.kind === 'aircraft' && e.alive) target = e;
    } else if (this.cfg.gci || this.offboardGci(ac)) {
      // scramble / ace-level GCI support: vectors onto the closest hostile aircraft
      let bestD = Infinity;
      for (const e of world.aircraft) {
        if (!e.alive || !isHostile(ac.team, e.team)) continue;
        const d = e.position.distanceToSquared(ac.position);
        if (d < bestD) {
          bestD = d;
          target = e;
        }
      }
      // off-board GCI only talks the pilot onto bandits inside its commit range
      if (!this.cfg.gci && bestD > this.cfg.commitRange * this.cfg.commitRange) target = null;
    }
    if (!target) return false;
    const err = ac.team === 'red' ? 2_500 : 300;
    if (!this.aw.updateGci(target, this.now, 8, err, this.rng)) return false;
    this.aw.gciEstimate(this.now, _p);
    const gciSpeed = Math.max(290, tasForIas(250, ac.position.y));
    interceptPoint(ac.position, gciSpeed, _p, this.aw.gciVel, _q, 240);
    _h.set(_q.x - ac.position.x, 0, _q.z - ac.position.z);
    const alt = clampN(_p.y + 600, Math.max(800, this.skill.minAgl + 500), 10_000);
    dirWithElevation(_h, gammaForAltitude(ac, alt, 0.3, 6), it.dir);
    it.speed = gciSpeed;
    it.allowAb = true;
    it.gMax = Math.min(4, this.skill.maxG);
    it.gain = 1;
    this.selectWeapon(ac, world, false);
    this.setState('INTERCEPT');
    return true;
  }

  /**
   * Ace-level hostile fighters fly with ground-controlled-intercept support (the island radar
   * network / an airborne controller): coarse vectors (±2.5 km, refreshed every 8 s) onto the
   * nearest hostile jet inside their commit range, even a stealthy one they can't see. They still
   * need their own radar / IRST track to shoot, so stealth keeps the first shot — but an Ace
   * enemy does not lose a player who runs.
   */
  private offboardGci(ac: AircraftEntity): boolean {
    return ac.team === 'red' && this.skill.level >= 0.75 && !this.cfg.escort && !this.cfg.friendlyWing;
  }

  /** Turn towards a fighter radar locking us (RWR 'track' / 'launch'). */
  private spikeChase(ac: AircraftEntity, it: FlightIntent): boolean {
    const rwr = ac.rwr;
    let bearing = 0;
    let found = false;
    for (let i = 0; i < rwr.length; i++) {
      const r = rwr[i];
      if (r.kind === 'fighter' && r.state !== 'search') {
        bearing = r.bearing;
        found = true;
        break;
      }
    }
    if (!found) return false;
    headingDir(ac.flight.heading + bearing, _h);
    dirWithElevation(_h, gammaForAltitude(ac, Math.max(ac.position.y, 1_500), 0.2, 6), it.dir);
    it.speed = Math.max(ac.flight.tas, 260);
    it.allowAb = true;
    it.gMax = Math.min(5, this.skill.maxG);
    it.gain = 1.2;
    this.setState('INTERCEPT');
    return true;
  }

  private idle(ac: AircraftEntity, world: SimWorld, it: FlightIntent, dt: number): void {
    const leader = this.leaderOf(ac, world);
    const task = this.task;
    const cruise = 235;
    if (leader) {
      let slot = SLOT_FIGHTING_WING;
      let label = 'FORM';
      if (this.cfg.escort) {
        slot = SLOT_ESCORT;
        label = 'ESCORT';
      } else if (this.cfg.friendlyWing) {
        // close formation in peace, fighting wing when bandits are around
        const b = this.aw.closest(true);
        slot = b && b.range < 40_000 ? SLOT_FIGHTING_WING : SLOT_FINGERTIP;
      }
      this.form.fly(it, ac, leader, slot, dt, this.skill.level, this.skill.maxG);
      if (ac.radar.designatedId !== null && !this.cfg.friendlyWing) world.combat.designate(ac, null, world);
      this.setState(label);
      return;
    }
    if (task?.kind === 'patrol') {
      this.flyRacetrack(ac, it, task.center, Math.max(12_000, task.radius * 1.5), this.homeHeading + Math.PI / 2, task.altitude, cruise);
      this.setState('PATROL');
    } else if (task?.kind === 'route') {
      if (this.flyRoute(ac, it, task.waypoints, task.loop, cruise)) this.setState('ROUTE');
      else this.rtb(ac, it, this.home);
    } else if (task?.kind === 'rtb') {
      this.rtb(ac, it, task.point);
    } else {
      this.flyRacetrack(ac, it, this.home, 20_000, this.homeHeading, Math.max(1_500, this.homeAlt), cruise);
      this.setState('PATROL');
    }
    this.selectWeapon(ac, world, false);
  }

  private rtb(ac: AircraftEntity, it: FlightIntent, point: Vector3): void {
    const alt = point.y > 300 ? point.y : Math.max(2_000, this.homeAlt);
    const d = this.flyToPoint(ac, it, point, alt, 0.2, 8);
    if (d < 6_000) this.orbit(ac, it, point, 5_000, alt, 220);
    else {
      it.speed = 250;
      it.gMax = 3;
      it.gain = 0.8;
    }
    this.setState('RTB');
  }

  private shouldBugout(ac: AircraftEntity): boolean {
    const missiles = this.wpn.bvrLeft(this.ctx) + this.wpn.irLeft(this.ctx);
    // Winchester: hostile pilots defend their airspace with the gun to the end (and stay
    // killable — a mission never stalls on a MiG hiding at home); friendly pilots with only the
    // gun left disengage from missile-armed fighters that have not merged with them yet
    const winchester = !this.unarmed && missiles === 0 && (ac.gunAmmo < 30 || (ac.team !== 'red' && this.gunOnlyVsFighter()));
    const damaged = ac.health < 35 || ac.damage.engine > 0.5 || ac.damage.hydraulics > 0.6;
    const bingo = ac.flight.fuel < this.perfOf(ac).internalFuel * 0.08;
    return winchester || damaged || bingo;
  }

  /**
   * Out of missiles with only the gun, facing a hostile fighter (which presumably still carries
   * IR missiles) that has not merged with us yet: a sound pilot disengages rather than taking a
   * gun into a merge with a missile-armed bandit. Once already in a turning fight (≤ 4 km) turning
   * tail is worse than fighting, so it stays (and a guns solution is always pressed).
   */
  private gunOnlyVsFighter(): boolean {
    const b = this.aw.closest(true);
    return !!b && b.range <= 15_000 && b.range >= 4_000;
  }

  private flyBugout(ac: AircraftEntity, world: SimWorld, it: FlightIntent): void {
    const threat = this.aw.closest(true);
    const home = this.task?.kind === 'rtb' ? this.task.point : this.home;
    if (ac.radar.designatedId !== null) world.combat.designate(ac, null, world);
    if (threat && threat.range < 25_000) {
      // run: away from the threat, bent towards home, low and fast
      _h.set(ac.position.x - threat.pos.x, 0, ac.position.z - threat.pos.z).normalize();
      _q.set(home.x - ac.position.x, 0, home.z - ac.position.z).normalize();
      _h.addScaledVector(_q, 0.5);
      // healthy: run low under the radar; crippled: keep altitude (energy margin, glide home)
      const ground = ac.position.y - ac.flight.agl;
      const damaged = ac.health < 35 || ac.damage.engine > 0.3;
      const alt = damaged ? Math.max(ac.position.y, ground + 1_500) : ground + Math.max(this.skill.minAgl * 3, 500);
      dirWithElevation(_h, gammaForAltitude(ac, alt, damaged ? 0.1 : 0.25, 6), it.dir);
      it.throttle = 1;
      it.gMax = Math.min(5, this.skill.maxG);
      it.gain = 1.2;
      this.setState('BUGOUT');
      return;
    }
    this.rtb(ac, it, home);
  }
}
