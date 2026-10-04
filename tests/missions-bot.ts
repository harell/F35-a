/**
 * MISSIONS — a scripted "competent player" that can fly every mission type end to end with the
 * REAL SimWorld / CombatSystem / AI / MissionRunner (winnability checks, the soft-lock hunt and
 * going home when Winchester — there is no rearming):
 *
 *  - air-to-air: the simai team's calibrated PlayerBot (tests/ai-playerbot.ts) — taps the TD box,
 *    fires on the calibrated SHOOT cue, cranks, defends on the MAWS after a human reaction time;
 *  - air-to-ground: picks the next live target of an active objective (primary first; a Tor
 *    guarding it goes first), selects AARGM against emitters / SDB II / SDB / JDAM, designates it
 *    with the sensors a human has (the target must be a contact), releases on the launch-zone cue
 *    (the StormBreaker is flown like the SDB: same glide envelope, it just also follows a mover);
 *  - navigation: follows the mission's steering cue (runner.currentWaypoint) at its altitude;
 *  - Winchester / low fuel: there is no rearming (issue #63), so it flies home to Whenuapai
 *    (homeBase()) and circles the field, out of the fight, until the mission ends.
 *
 * Flying is delegated to the AI Autopilot (the same "hands" the AI uses).
 */
import { Vector3 } from 'three';
import { AKL } from '../src/core/auckland';
import { DIFFICULTIES } from '../src/core/data';
import { EventBus } from '../src/core/events';
import type { MissionDef, MissionResult, MissionRunnerApi } from '../src/core/contracts';
import { isHostile, type Difficulty, type LoadoutId, type WeaponId } from '../src/core/types';
import type { SimWorld, TerrainQuery } from '../src/sim/api';
import type { AircraftEntity, AnyEntity, MissileEntity } from '../src/sim/entities';
import { isBoat } from '../src/sim/boats';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createAiBrain } from '../src/ai';
import { Autopilot, gammaForAltitude } from '../src/ai/pilot/Autopilot';
import { dirWithElevation } from '../src/ai/geom';
import { createMissionRunner, missionById, missionDifficulty } from '../src/missions';
import { AIRCRAFT_PERF } from '../src/sim/flight/aircraftData';
import { mulberry32 } from '../src/core/math';
import { Probe, type ProbeSpec } from './missions-probes';
import { PlayerBot } from './ai-playerbot';
import { SDB_PRESS_RANGE } from '../src/missions/runtime/hints';
import { spawnFloor } from '../src/missions/runtime/spawner';

const _h = new Vector3();
const _q = new Vector3();

type AgWeapon = 'aargm' | 'gbu53' | 'gbu39' | 'gbu31';
/** In order of preference (as the game's hints: AARGM for emitters, then SDB II, SDB, JDAM). */
const AG: AgWeapon[] = ['aargm', 'gbu53', 'gbu39', 'gbu31'];

/** SDB-class glide bombs (GBU-39, GBU-53/B): same envelope, pressed in to SDB_PRESS_RANGE. */
const isSdb = (w: AgWeapon): boolean => w === 'gbu39' || w === 'gbu53';

/** Order a boat swarm is bombed in: the shortest clock first (a suicide boat, then a missile boat, then an AD boat). */
const boatRank = (t: AnyEntity): number => (t.kind === 'ground' && t.type === 'suicide_boat' ? 0 : t.kind === 'ground' && t.type === 'missile_boat' ? 1 : 2);

export const WHENUAPAI = new Vector3(AKL.whenuapai.x, 0, AKL.whenuapai.z);

/**
 * Limit a horizontal steering direction to at most `maxDeg` off the current track (same side),
 * so a reversal is flown as a level turn instead of a loop / climb.
 */
function turnLimited(p: AircraftEntity, h: Vector3, maxDeg = 100): Vector3 {
  const vx = p.velocity.x;
  const vz = p.velocity.z;
  const vl = Math.hypot(vx, vz);
  const hl = Math.hypot(h.x, h.z);
  if (vl < 1 || hl < 1e-6) return h;
  const cos = (vx * h.x + vz * h.z) / (vl * hl);
  const max = (maxDeg * Math.PI) / 180;
  if (Math.acos(Math.max(-1, Math.min(1, cos))) <= max) return h;
  // side: sign of the cross product (track × desired), turn by `max` that way
  const side = vx * h.z - vz * h.x >= 0 ? 1 : -1;
  const a = Math.atan2(vz, vx) + side * max;
  return h.set(Math.cos(a), 0, Math.sin(a));
}

/**
 * Where the bot goes when it is out of weapons or fuel (x, z m): Whenuapai (Auckland is the only
 * theatre, issue #73).
 */
export function homeBase(_def: MissionDef): { x: number; z: number; name: string } {
  return { x: AKL.whenuapai.x, z: AKL.whenuapai.z, name: 'Whenuapai' };
}

/** Below this share of its max health the jet is crippled: it can't hold speed (playtest 2.1-d: 14 hp, 98 → 64 m/s, crashed). */
export const CRIPPLED_FRACTION = 0.25;
/** Out of the fight (Winchester, bingo, crippled): a bandit inside this range is dealt with before the bot turns for home (m). */
export const OUT_THREAT_RANGE = 25_000;
/**
 * Out of missiles with a bandit inside this range and in front of the nose: take the gun shot (m).
 * (3 km in any aspect started gun fights with Su-27s that ended crippled and crashed: ia_defend Pilot 3/6.)
 */
export const OUT_GUN_RANGE = 1_500;
/**
 * Out of missiles: a bandit inside this range is run from low (m). (12 km, or any hot bandit, kept
 * the bot running in burner from a chasing Su-27 until it flamed out: ia_defend Pilot 3/6.)
 */
export const OUT_EXTEND_RANGE = 6_000;
/** Missiles left (an AIM-9X when the AMRAAMs are gone): a bandit inside this range, or closing fast, is shot (m). */
export const OUT_SHOOT_RANGE = 14_000;

/**
 * What the bot does once it is out of the fight (Winchester, bingo, or a crippled jet) with the
 * nearest bandit on the scope `banditD` m away (null: none). Playtest 2.1-i: with no AMRAAMs left
 * the bot flew home in a straight line while a MiG-29 closed to guns range, and was killed.
 *  - 'air':    missiles left (the AIM-9X) and the bandit close or hot: shoot it (PlayerBot);
 *  - 'guns':   no missiles, rounds left, the bandit inside OUT_GUN_RANGE in front of the nose: gun it;
 *  - 'extend': no missiles and the bandit close or hot: run from it low and fast, bent towards home;
 *  - 'home':   nothing close: fly home and circle the field.
 */
export type OutAction = 'air' | 'guns' | 'extend' | 'home';
export function outOfFightAction(o: { aa: number; gunAmmo: number; banditD: number | null; hot: boolean; noseOn?: boolean }): OutAction {
  const d = o.banditD;
  if (d === null || d > OUT_THREAT_RANGE) return 'home';
  if (o.aa > 0) return d < OUT_SHOOT_RANGE || o.hot ? 'air' : 'home';
  if (o.gunAmmo > 0 && d < OUT_GUN_RANGE && o.noseOn) return 'guns';
  return d < OUT_EXTEND_RANGE ? 'extend' : 'home';
}

/**
 * Crippled (health below CRIPPLED_FRACTION): stop attacking and egress, so a sweep measures the
 * mission and not a bot flying a wreck into the defences. There is no rearm or repair to go home
 * for: the wingmen finish the job, or nobody does (the run then fails or hangs, not "Crashed").
 */
export function shouldEgress(p: AircraftEntity): boolean {
  return p.health < CRIPPLED_FRACTION * p.maxHealth;
}

export interface MissionBotOptions {
  /** MAWS reaction time (s). */
  reaction?: number;
  /** Go home when Winchester or bingo (default true). */
  rtb?: boolean;
}

export class MissionBot {
  readonly air: PlayerBot;
  readonly pilot = new Autopilot();
  mode = 'NAV';
  private lastRelease = -99;
  private lastCm = -99;
  private beamSide = 0;
  private orbitSign = 1;
  private readonly ips = new Map<number, Vector3>();
  private readonly runIn = new Set<number>();
  private readonly opts: Required<MissionBotOptions>;
  /** The briefed loadout carries air-to-ground stores. */
  private readonly agLoadout: boolean;
  /** Home base (y = 0): where we go when out of weapons or fuel. */
  readonly home: Vector3;

  constructor(
    private readonly runner: MissionRunnerApi,
    private readonly world: SimWorld,
    private readonly p: AircraftEntity,
    opts: MissionBotOptions = {},
  ) {
    this.opts = { reaction: 0.8, rtb: true, ...opts };
    this.agLoadout = this.agLeft() > 0;
    const h = homeBase(runner.def);
    this.home = new Vector3(h.x, 0, h.z);
    const wp = runner.currentWaypoint;
    this.air = new PlayerBot({ home: this.home.clone().setY(3000), cap: wp ? wp.position.clone() : null, reaction: this.opts.reaction, rtbWhenWinchester: true });
    this.air.attach(world, p);
  }

  private aaLeft(): number {
    const c = this.world.combat;
    return c.remaining(this.p, 'aim120') + c.remaining(this.p, 'aim9x');
  }

  private agLeft(): number {
    let n = 0;
    for (const w of AG) n += this.world.combat.remaining(this.p, w);
    return n;
  }

  /** Live hostile entities the active objectives want dead (primary objectives first). */
  private objectiveTargets(kind: 'air' | 'surface'): AnyEntity[] {
    const out: AnyEntity[] = [];
    const def = this.runner.def;
    const w = this.world;
    for (const pass of [true, false]) {
      for (const st of this.runner.objectives) {
        if (st.state !== 'active' || st.primary !== pass) continue;
        const o = def.script.objectives.find((x) => x.id === st.id);
        if (!o) continue;
        let groups: string[] = [];
        if (o.kind === 'destroy' || o.kind === 'intercept') groups = o.groups;
        if (kind === 'surface' && o.kind === 'destroy_sams') {
          for (const s of w.sams) if (s.alive && s.team !== this.p.team && Math.hypot(s.position.x - o.x, s.position.z - o.z) <= o.radius) out.push(s);
          continue;
        }
        const list: (AnyEntity & { groupId?: string })[] = kind === 'air' ? w.aircraft : [...w.sams, ...w.ground];
        for (const e of list) if (e.alive && e.team !== this.p.team && e.groupId && groups.includes(e.groupId)) out.push(e);
      }
      if (out.length > 0) return out;
    }
    return out;
  }

  /** Best A/G weapon we carry for a target (null = none suitable). */
  private weaponFor(t: AnyEntity): AgWeapon | null {
    const c = this.world.combat;
    for (const w of AG) {
      if (c.remaining(this.p, w) <= 0) continue;
      if (w === 'aargm' && !(t.kind === 'sam' && (t.radarOn || t.known) && t.type !== 'zsu23')) continue;
      return w;
    }
    return null;
  }

  /**
   * One of our bombs is already flying at `t`, or at a target close enough to `t` that its blast
   * takes `t` too (a JDAM on one of a pair of parked jets 60 m apart).
   */
  private bombInbound(t: AnyEntity): boolean {
    for (const m of this.world.missiles) {
      if (!m.alive || m.shooterId !== this.p.id || m.def.category !== 'bomb') continue;
      if (m.targetId === t.id) return true;
      const aim = this.world.getEntity(m.targetId);
      if (aim && aim.alive && Math.hypot(aim.position.x - t.position.x, aim.position.z - t.position.z) <= m.def.blastRadius) return true;
    }
    return false;
  }

  /**
   * Next surface target: nearest live objective target we can hit; a live Tor guarding it goes first.
   * SDB-class glide bombs (SDB, StormBreaker): with one already on its way to a target the next is
   * preferred, so they are rippled onto the targets like a human does instead of one 2-minute glide
   * at a time (issue #65: StormBreaker runs over 600 s). Not JDAMs (a JDAM rippled from inside the
   * run-in overflew its target in t03).
   * Fast boats (a swarm on a clock, IRGC g02) are bombed one bomb per boat, rippled: a boat with our
   * bomb already on the way is left to it while another one is free, and the shortest clock goes
   * first (suicide boats, then missile boats, then the rest), as the briefing tells a human.
   */
  private surfaceTarget(): AnyEntity | null {
    const p = this.p;
    let best: AnyEntity | null = null;
    let bestD = Infinity;
    let bestBusy = true;
    for (const t of this.objectiveTargets('surface')) {
      const wt = this.weaponFor(t);
      if (!wt) continue; // e.g. only AARGMs left and a silent / optical site
      // a moving boat is only covered by a bomb aimed at it, not by a blast meant for its neighbour
      const boat = isBoat(t);
      const busy = isSdb(wt) && (boat ? this.bombOnTheWay(t) : this.bombInbound(t));
      let d = t.position.distanceTo(p.position);
      if (boat) d += boatRank(t) * 1e6 + (this.bombOnTheWay(t) ? 1e7 : 0);
      if ((bestBusy && !busy) || (busy === bestBusy && d < bestD)) {
        bestD = d;
        best = t;
        bestBusy = busy;
      }
    }
    if (!best) return null;
    // SEAD: a Tor guarding the target swats AARGMs / SDBs — kill it first when we carry ARMs
    if (this.world.combat.remaining(p, 'aargm') > 0) {
      for (const s of this.world.sams) {
        if (!s.alive || s.team === p.team || s.type !== 'sa15' || s === best) continue;
        if (s.position.distanceTo(best.position) < 3_500 && this.weaponFor(s) === 'aargm') return s;
      }
    }
    return best;
  }

  /** One of our weapons is in flight at `t`. */
  private bombOnTheWay(t: AnyEntity): boolean {
    for (const m of this.world.missiles) if (m.alive && m.shooterId === this.p.id && m.targetId === t.id) return true;
    return false;
  }

  /** Nearest hostile aircraft on the scope; `fighters`: only those that can shoot back (no drone, bomber or AWACS). */
  private nearestBandit(fighters = false): { e: AircraftEntity; d: number } | null {
    let best: AircraftEntity | null = null;
    let bestD = Infinity;
    for (const c of this.p.radar.contacts) {
      if (!isHostile(this.p.team, c.team)) continue;
      const e = this.world.getEntity(c.id);
      if (!e || e.kind !== 'aircraft' || !e.alive) continue;
      if (fighters && (e.oneWay || e.ai?.role === 'bomber')) continue;
      const d = c.position.distanceTo(this.p.position);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best ? { e: best, d: bestD } : null;
  }

  /** Call at ~20 Hz; writes p.input. */
  update(dt: number): void {
    const p = this.p;
    if (!p.alive) return;
    const aa = this.aaLeft();
    const ag = this.agLeft();
    const bandit = this.nearestBandit();
    const fuelLow = p.flight.fuel < AIRCRAFT_PERF[p.type].internalFuel * 0.18;

    // 1. missile inbound: a SAM shot is defended against; everything else: the calibrated air-to-air bot
    if (p.incoming.length > 0) {
      if (this.samShot()) return this.samDefence(dt);
      return this.fight('DEFEND', dt);
    }

    this.beamSide = 0;
    // 2. mission over: go home
    if (this.runner.state !== 'running') return this.nav(this.home, 2500, 'HOME', dt);

    const surface = ag > 0 ? this.surfaceTarget() : null;
    // surface objectives are ours only when we brought air-to-ground stores (else a package's job)
    const surfaceNeeded = this.agLoadout && this.objectiveTargets('surface').length > 0;
    const airNeeded = this.objectiveTargets('air').length > 0;
    // 2b. Winchester against one-way drones (Shaheds, unarmed): a gun pass risks nothing but the
    //     warhead, so a competent pilot presses on with the gun instead of going home (IRGC g01)
    const guns = !fuelLow && this.gunWork(aa);
    this.air.opts.rtbWhenWinchester = !guns;
    if (guns) return bandit ? this.fight('GUNS', dt) : this.huntDrone(dt);

    // a hot bandit (closing fast — DARKSTAR's "threat … hot" call)
    const isHot = (b: { e: AircraftEntity; d: number } | null): boolean => {
      if (!b || b.d >= 22_000) return false;
      _q.subVectors(p.position, b.e.position);
      return _q.dot(b.e.velocity) - _q.dot(p.velocity) > 60 * b.d;
    };
    const hot = isHot(bandit);

    // 3. Winchester / bingo / crippled: out of the fight, home (there is no rearming, #63). A bandit
    //    close by is dealt with first — shot with what's left, gunned in a merge, or run from low —
    //    instead of turning a straight back on it (playtest 2.1-i). A crippled jet stops attacking and
    //    egresses, leaving the job to the wingmen (2.1-d)
    const agUseless = ag === 0 || (surfaceNeeded && !surface);
    const out = (aa === 0 && (airNeeded || (bandit && bandit.d < OUT_THREAT_RANGE))) || (surfaceNeeded && agUseless && aa === 0) || (surfaceNeeded && ag === 0 && !airNeeded);
    const crippled = shouldEgress(p);
    if (this.opts.rtb && (out || fuelLow || crippled)) {
      // (only a fighter is a threat: a drone, bomber or AWACS left behind is no reason to turn round)
      const threat = this.nearestBandit(true);
      let noseOn = false;
      if (threat) {
        _h.subVectors(threat.e.position, p.position);
        _q.set(0, 0, -1).applyQuaternion(p.quaternion);
        noseOn = _q.dot(_h) > 0.85 * _h.length();
      }
      const act = outOfFightAction({ aa, gunAmmo: p.gunAmmo, banditD: threat ? threat.d : null, hot: isHot(threat), noseOn });
      if (act === 'air') return this.fight('AIR', dt);
      if (act === 'guns') {
        this.air.opts.rtbWhenWinchester = false;
        return this.fight('GUNS', dt);
      }
      if (act === 'extend' && threat && !fuelLow) return this.extendLow(threat.e, dt);
      return this.homeLeg(dt, crippled);
    }

    // 3b. a raid to stop (intercept objective): bombers first, fighters only when on top of us
    const raider = aa > 0 ? this.raidTarget() : null;
    let fighterNear = false;
    for (const c of p.radar.contacts) {
      if (!isHostile(p.team, c.team)) continue;
      const e = this.world.getEntity(c.id);
      if (e && e.alive && e.kind === 'aircraft' && e.ai?.role !== 'bomber' && c.position.distanceTo(p.position) < 20_000) fighterNear = true;
    }
    if (raider && !fighterNear) return this.intercept(raider, dt);

    // 4. air threat close by, or the air objective: fight; a hot bandit is met with AMRAAMs from 22 km
    if (bandit && aa > 0 && (bandit.d < 14_000 || hot || !surface)) return this.fight('AIR', dt);

    // 5. surface attack — flying the briefed route (nav / IP steering points) first, like a human
    //    following the steering cue, unless the target is already close
    if (surface) {
      const wp = this.runner.currentWaypoint;
      const R = surface.position.distanceTo(p.position);
      const w0 = this.weaponFor(surface);
      const rel0 = w0 ? this.releaseRange(w0) : 0;
      // once the attack has been planned (IP chosen) the run is flown to the end: no flip-flopping
      // between the route and the IP leg (the IP can lie further out than the route reach)
      const inReach = R < Math.max(12_000, rel0 + 3_000) || (this.ips.has(surface.id) && R < rel0 + 15_000);
      if (wp && (wp.kind === 'nav' || wp.kind === 'ip') && !inReach) return this.nav(wp.position, Math.max(wp.position.y, 50), 'ROUTE', dt);
      return this.strike(surface, dt);
    }

    // 6. air objective not on the scope yet: head for it
    if (aa > 0 && airNeeded) {
      const targets = this.objectiveTargets('air');
      let best = targets[0];
      let bd = Infinity;
      for (const t of targets) {
        const d = t.position.distanceTo(p.position);
        if (d < bd) {
          bd = d;
          best = t;
        }
      }
      if (best) return this.nav(best.position, Math.max(3000, Math.min(8000, best.position.y)), 'HUNT', dt);
    }

    // 7. steering cue
    const wp = this.runner.currentWaypoint;
    if (wp) return this.nav(wp.position, wp.kind === 'target' ? Math.max(4_000, wp.position.y) : wp.position.y > 10 ? wp.position.y : 1500, 'NAV', dt);
    this.nav(this.home, 2500, 'HOME', dt);
  }

  /** Nearest live aircraft of an active primary 'intercept' objective (the raid), or null. */
  private raidTarget(): AircraftEntity | null {
    const p = this.p;
    let best: AircraftEntity | null = null;
    let bestD = 60_000;
    for (const st of this.runner.objectives) {
      if (st.state !== 'active' || !st.primary) continue;
      const o = this.runner.def.script.objectives.find((x) => x.id === st.id);
      if (!o || o.kind !== 'intercept') continue;
      for (const a of this.world.aircraft) {
        if (!a.alive || !isHostile(p.team, a.team) || !a.groupId || !o.groups.includes(a.groupId)) continue;
        const d = a.position.distanceTo(p.position);
        if (d < bestD) {
          bestD = d;
          best = a;
        }
      }
    }
    return best;
  }

  /** Bomber intercept: nose on, lock, fire on SHOOT, one missile in flight per bomber. */
  private intercept(t: AircraftEntity, dt: number): void {
    const p = this.p;
    const w = this.world;
    const c = w.combat;
    this.mode = 'INTERCEPT';
    this.clearTriggers();
    const R = t.position.distanceTo(p.position);
    const want = c.remaining(p, 'aim9x') > 0 && R < 7_000 && c.remaining(p, 'aim120') === 0 ? 'aim9x' : c.remaining(p, 'aim120') > 0 ? 'aim120' : 'aim9x';
    if (p.selectedWeapon !== want) c.selectWeapon(p, want, w);
    const onScope = p.radar.contacts.some((k) => k.id === t.id);
    if (onScope && (p.radar.designatedId !== t.id || p.radar.lockedId === null)) c.designate(p, t.id, w);
    const it = this.pilot.begin(p, 150);
    _h.set(t.position.x - p.position.x, 0, t.position.z - p.position.z);
    const los = Math.atan2(t.position.y - p.position.y, Math.max(1, _h.length()));
    dirWithElevation(_h, Math.max(-0.3, Math.min(0.3, los)), it.dir);
    it.speed = 300;
    it.allowAb = R > 20_000;
    it.gMax = 5;
    it.gain = 1.2;
    this.pilot.fly(p, w, dt);
    let inFlight = false;
    for (const m of w.missiles) if (m.alive && m.shooterId === p.id && m.targetId === t.id) inFlight = true;
    if (inFlight || w.time - this.lastRelease < 2) return;
    const z = c.launchZone(p, w);
    if (z && z.targetId === t.id && z.shoot) {
      p.input.fireWeapon = true;
      this.lastRelease = w.time;
    }
  }

  /** The most urgent inbound missile was fired by a SAM site. */
  private samShot(): boolean {
    let best = this.p.incoming[0];
    for (const m of this.p.incoming) if (m.timeToImpact < best.timeToImpact) best = m;
    const m = this.world.getEntity(best.missileId);
    if (!m || m.kind !== 'missile') return false;
    const shooter = this.world.getEntity(m.shooterId);
    return !!shooter && shooter.kind === 'sam';
  }

  /**
   * SAM defence as taught in T03: beam it (turn 90° to the launching site's radar), descend into
   * the ground clutter, CHAFF in the last seconds (FLARES against IR missiles), last-ditch break.
   */
  private samDefence(dt: number): void {
    const p = this.p;
    const w = this.world;
    this.mode = 'SAMDEF';
    this.clearTriggers();
    let urgent = p.incoming[0];
    for (const m of p.incoming) if (m.timeToImpact < urgent.timeToImpact) urgent = m;
    const m = w.getEntity(urgent.missileId);
    const site = m && m.kind === 'missile' ? w.getEntity(m.shooterId) : null;
    const ref = site ? site.position : m ? m.position : p.position;
    const ground = p.position.y - p.flight.agl;
    const it = this.pilot.begin(p, 60);
    // beam: perpendicular to the radar line of sight, on the side we are already turning to
    _q.set(p.position.x - ref.x, 0, p.position.z - ref.z).normalize();
    _h.set(-_q.z, 0, _q.x);
    if (this.beamSide === 0) this.beamSide = _h.x * p.velocity.x + _h.z * p.velocity.z >= 0 ? 1 : -1;
    _h.multiplyScalar(this.beamSide);
    turnLimited(p, _h, 100);
    it.allowInverted = false;
    dirWithElevation(_h, gammaForAltitude(p, ground + 120, 0.3, 3), it.dir);
    it.speed = 290;
    it.allowAb = urgent.guidance !== 'ir';
    it.gMax = urgent.timeToImpact < 2.5 ? 9 : 7;
    it.gain = 1.6;
    this.pilot.fly(p, w, dt);
    const now = w.time;
    if (urgent.timeToImpact < 6 && now - this.lastCm > 0.6) {
      if (urgent.guidance === 'radar') p.input.chaff = p.chaff > 0;
      else p.input.flare = p.flares > 0;
      if (urgent.timeToImpact < 2.5) p.input.flare = p.flares > 0;
      this.lastCm = now;
    }
  }

  /** Out of missiles, rounds left, and every air target an active objective wants is a one-way drone. */
  private gunWork(aa: number): boolean {
    if (aa > 0 || this.p.gunAmmo <= 0) return false;
    const targets = this.objectiveTargets('air');
    return targets.length > 0 && targets.every((t) => t.kind === 'aircraft' && !!t.oneWay);
  }

  /** No drone on the scope yet (gun work): head for the nearest one at its height. */
  private huntDrone(dt: number): void {
    let best: AnyEntity | null = null;
    let bd = Infinity;
    for (const t of this.objectiveTargets('air')) {
      const d = t.position.distanceTo(this.p.position);
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    if (best) this.nav(best.position, Math.max(600, best.position.y + 300), 'HUNT', dt);
  }

  private fight(mode: string, dt: number): void {
    this.mode = mode;
    const wp = this.runner.currentWaypoint;
    this.air.opts.cap = wp ? wp.position.clone() : null;
    this.air.update(this.p, this.world, dt);
  }

  private clearTriggers(): void {
    const inp = this.p.input;
    inp.fireGun = false;
    inp.fireWeapon = false;
    inp.flare = false;
    inp.chaff = false;
  }

  /** Fly to a point at an altitude (m MSL). */
  private nav(point: Vector3, altitude: number, mode: string, dt: number): void {
    const p = this.p;
    this.mode = mode;
    this.clearTriggers();
    const ground = p.position.y - p.flight.agl;
    const it = this.pilot.begin(p, 150);
    _h.set(point.x - p.position.x, 0, point.z - p.position.z);
    // energy first: a jet that came out of a fight at 150 kt noses over before it climbs
    const V = p.velocity.length();
    let gamma = gammaForAltitude(p, Math.max(altitude, ground + 200), 0.2, 6);
    if (V < 180 && p.flight.agl > 400) gamma = Math.min(gamma, V < 130 ? -0.15 : 0);
    dirWithElevation(_h, gamma, it.dir);
    it.speed = 250;
    it.allowAb = V < 220;
    it.gMax = 4;
    it.gain = 1;
    this.pilot.fly(p, this.world, dt);
  }

  /** Fly home and circle the field; `crippled`: no climb (the jet can't hold its speed), mode CRIPPLED. */
  private homeLeg(dt: number, crippled = false): void {
    const p = this.p;
    const home = this.home;
    this.clearTriggers();
    const d = Math.hypot(p.position.x - home.x, p.position.z - home.z);
    const ground = p.position.y - p.flight.agl;
    const it = this.pilot.begin(p, 150);
    if (d > 3_500) {
      // head home; start down early
      _h.set(home.x - p.position.x, 0, home.z - p.position.z);
      turnLimited(p, _h, 70);
      const alt = d > 20_000 && !crippled ? Math.max(3_000, ground + 1_000) : ground + 600;
      dirWithElevation(_h, gammaForAltitude(p, alt, 0.2, 6), it.dir);
      it.speed = 260;
      it.gMax = 4;
    } else {
      // circle the field
      _h.set(p.position.x - home.x, 0, p.position.z - home.z).normalize();
      const tx = -_h.z * this.orbitSign;
      const tz = _h.x * this.orbitSign;
      const corr = Math.max(-1, Math.min(1, (d - 1_200) / 1_200));
      _q.set(tx - _h.x * corr * 1.5, 0, tz - _h.z * corr * 1.5);
      dirWithElevation(_q, gammaForAltitude(p, ground + 500, 0.15, 6), it.dir);
      it.speed = 200;
      it.gMax = 3;
    }
    it.gain = 1;
    this.mode = crippled ? 'CRIPPLED' : 'RTB';
    this.pilot.fly(p, this.world, dt);
  }

  /**
   * Out of missiles with a bandit close or closing: run from it low and fast, bent towards home
   * (descend into the clutter, burner), flares while its nose is on us inside heater range.
   */
  private extendLow(bandit: AircraftEntity, dt: number): void {
    const p = this.p;
    const w = this.world;
    this.mode = 'EXTEND';
    this.clearTriggers();
    const it = this.pilot.begin(p, 60);
    _h.set(this.home.x - p.position.x, 0, this.home.z - p.position.z).normalize();
    _q.set(p.position.x - bandit.position.x, 0, p.position.z - bandit.position.z).normalize();
    _h.add(_q.multiplyScalar(1.5));
    turnLimited(p, _h, 80);
    const ground = p.position.y - p.flight.agl;
    dirWithElevation(_h, gammaForAltitude(p, ground + 150, 0.25, 5), it.dir);
    it.throttle = 1;
    it.gMax = 6;
    it.gain = 1.4;
    _q.set(0, 0, -1).applyQuaternion(bandit.quaternion);
    _h.subVectors(p.position, bandit.position);
    const R = _h.length();
    if (R < 8_000 && _q.dot(_h) > 0.85 * R && w.time - this.lastCm > 0.8 && p.flares > 0) {
      p.input.flare = true;
      this.lastCm = w.time;
    }
    this.pilot.fly(p, w, dt);
  }

  /** Release range the bot plans with (m) for a weapon from strike altitude. */
  private releaseRange(weapon: AgWeapon): number {
    return weapon === 'gbu31' ? 9_500 : isSdb(weapon) ? 21_000 : 28_000;
  }

  /**
   * Initial point for an attack: a run-in bearing whose release point stays furthest from the
   * other live SAM sites (a human reads the TSD rings and comes in from the quiet side).
   */
  private planIp(t: AnyEntity, weapon: AgWeapon): Vector3 {
    const cached = this.ips.get(t.id);
    if (cached) return cached;
    const rel = this.releaseRange(weapon);
    let best = 0;
    let bestScore = -Infinity;
    for (let k = 0; k < 24; k++) {
      const b = (k / 24) * Math.PI * 2;
      const rx = t.position.x + Math.sin(b) * rel;
      const rz = t.position.z - Math.cos(b) * rel;
      let score = 0;
      for (const s of this.world.sams) {
        if (!s.alive || s.team === this.p.team || s === t) continue;
        const d = Math.hypot(s.position.x - rx, s.position.z - rz);
        const reach = s.type === 'sa6' ? 14_000 : s.type === 'sa15' ? 10_000 : 4_000;
        score -= Math.max(0, reach - d);
      }
      // prefer run-ins from our side of the target
      const toUs = Math.hypot(this.p.position.x - rx, this.p.position.z - rz);
      score -= toUs * 0.05;
      if (score > bestScore) {
        bestScore = score;
        best = b;
      }
    }
    const ip = new Vector3(t.position.x + Math.sin(best) * (rel + 7_000), 0, t.position.z - Math.cos(best) * (rel + 7_000));
    this.ips.set(t.id, ip);
    return ip;
  }

  private strike(t: AnyEntity, dt: number): void {
    const p = this.p;
    const w = this.world;
    const c = w.combat;
    this.mode = 'STRIKE';
    this.clearTriggers();
    const weapon = this.weaponFor(t);
    if (!weapon) return this.nav(t.position, 5000, 'STRIKE-NAV', dt);
    if (p.selectedWeapon !== weapon) c.selectWeapon(p, weapon as WeaponId, w);
    if (p.radar.designatedId !== t.id) c.designate(p, t.id, w);
    const ground = p.position.y - p.flight.agl;
    const R = Math.hypot(t.position.x - p.position.x, t.position.z - p.position.z);
    const rel = this.releaseRange(weapon);
    const ip = this.planIp(t, weapon);
    // weapons in flight at this target: egress (turn away, keep the height) until they land
    let inFlight = 0;
    for (const m of w.missiles) if (m.alive && m.shooterId === p.id && m.targetId === t.id) inFlight++;
    if (inFlight > 0 && R > 30_000) {
      // stand-off weapon on its way: hold (a gentle orbit) where we are
      const it2 = this.pilot.begin(p, 150);
      const V1 = p.velocity.length();
      // a wide, gentle turn that keeps the energy (a tight orbit at 25,000 ft bleeds it all)
      _h.set(p.velocity.x - p.velocity.z * 0.25, 0, p.velocity.z + p.velocity.x * 0.25);
      dirWithElevation(_h, V1 < 220 ? -0.04 : gammaForAltitude(p, Math.max(p.position.y, ground + 3_000), 0.1, 8), it2.dir);
      it2.speed = 260;
      it2.allowAb = V1 < 200;
      it2.gMax = 1.5;
      it2.gain = 0.4;
      it2.allowInverted = false;
      this.mode = 'HOLD';
      this.pilot.fly(p, w, dt);
      return;
    }
    if (inFlight > 0) {
      const it2 = this.pilot.begin(p, 150);
      // turn away
      _h.set(p.position.x - t.position.x, 0, p.position.z - t.position.z);
      turnLimited(p, _h, 70);
      it2.allowInverted = false;
      const V2 = p.velocity.length();
      dirWithElevation(_h, V2 < 220 ? -0.05 : gammaForAltitude(p, Math.min(p.position.y, ground + 7_000), 0.2, 6), it2.dir);
      it2.speed = 280;
      it2.allowAb = V2 < 220;
      it2.gMax = 5;
      it2.gain = 1.2;
      this.mode = 'EGRESS';
      this.runIn.delete(t.id);
      this.pilot.fly(p, w, dt);
      return;
    }
    const it = this.pilot.begin(p, 150);
    // leg 1: to the IP unless we are already inside the run-in
    const ipD = Math.hypot(ip.x - p.position.x, ip.z - p.position.z);
    const runIn = this.runIn.has(t.id) || ipD < 3_000 || R < rel + 2_000;
    if (runIn) this.runIn.add(t.id);
    const aim = runIn ? t.position : ip;
    _h.set(aim.x - p.position.x, 0, aim.z - p.position.z);
    const alt = Math.min(8_500, Math.max(ground + 7_000, t.position.y + 7_000));
    // energy first: no climbing while slow (a stalled climb at 30,000 ft is a sitting duck)
    const V = p.velocity.length();
    let gamma = gammaForAltitude(p, alt, 0.2, 8);
    if (V < 230) gamma = Math.min(gamma, V < 200 ? -0.05 : 0.02);
    dirWithElevation(_h, gamma, it.dir);
    it.speed = 270;
    it.allowAb = V < 220 || p.position.y < alt - 1_500;
    it.gMax = 5;
    it.gain = 1.1;
    this.pilot.fly(p, w, dt);
    // release on the launch-zone cue (only once designated: the target must be a sensor contact),
    // with some speed on the jet (a glide bomb dropped at 250 kt falls short)
    if (p.radar.designatedId !== t.id || w.time - this.lastRelease < 2.5 || p.velocity.length() < 210) return;
    let ok: boolean;
    if (weapon === 'aargm') {
      const z = c.launchZone(p, w);
      ok = !!z && z.shoot;
    } else {
      const b = c.bombImpactPoint(p, w);
      // like the hint says: an SDB (I or II) is pressed in to ~20 km (a max-range glide arrives slow)
      ok = !!b && b.inRange && (!isSdb(weapon) || R <= SDB_PRESS_RANGE);
    }
    if (ok) {
      p.input.fireWeapon = true;
      this.lastRelease = w.time;
    }
  }
}

/* ───────────────────────── full playthrough ───────────────────────── */

export interface PlaythroughResult {
  mission: string;
  /** The difficulty asked for (a training lesson flies at Pilot whatever it is: missionDifficulty). */
  diff: Difficulty;
  seed: number;
  state: 'running' | 'success' | 'failed';
  reason: string;
  t: number;
  alive: boolean;
  playerKills: number;
  friendlyLost: number;
  objectives: string;
  result: MissionResult | null;
  /** Seconds the bot spent in each mode. */
  modes: Record<string, number>;
  events: string[];
  /** The player's weapon launches in order: time, weapon, target entity id and mission group. */
  launches: { t: number; weapon: string; targetId: number | null; group: string | null }[];
  /** The probe flown instead of the plain bot (opts.probe; tests/missions-probes.ts) and the gun rounds fired in it. */
  probe?: { label: string; gunRounds: number };
}

export function runPlaythrough(
  missionIdOrDef: string | MissionDef,
  diff: Difficulty,
  seed: number,
  terrain: TerrainQuery,
  opts: { loadout?: LoadoutId; maxT?: number; bot?: MissionBotOptions; log?: boolean; jitter?: boolean; probe?: ProbeSpec | null } = {},
): PlaythroughResult {
  const def = typeof missionIdOrDef === 'string' ? missionById(missionIdOrDef) : missionIdOrDef;
  if (!def) throw new Error(`no mission ${String(missionIdOrDef)}`);
  const events = new EventBus();
  // like the game (Game.runSession): training flies at Pilot whatever `diff` asks for
  const d = DIFFICULTIES[missionDifficulty(def, diff)];
  const world = createSimWorld({ terrain, difficulty: d, events, combat: createCombatSystemSeeded(seed) });
  const runner = createMissionRunner({ ...def, seed: def.seed + seed * 101 }, { createAi: createAiBrain, difficulty: d, events });
  runner.setup(world, opts.loadout ?? def.recommendedLoadout);
  const p = world.player!;
  // seeded jitter: every run samples a slightly different geometry (player start ±600 m, enemy
  // aircraft ±2.5 km / ±400 m as they appear), like different human players would
  const jit = mulberry32(seed * 7919 + 13);
  if (opts.jitter !== false) {
    p.position.x += (jit() - 0.5) * 1_200;
    p.position.z += (jit() - 0.5) * 1_200;
  }
  const jittered = new Set<number>();
  const jitterRed = () => {
    if (opts.jitter === false) return;
    for (const a of world.aircraft) {
      if (!isHostile(p.team, a.team) || jittered.has(a.id)) continue; // (civil traffic flies its own profile)
      if (a.oneWay) continue; // one-way drones fly the mission's route (no spawn jitter either: spawner.ts)
      jittered.add(a.id);
      a.position.x += (jit() - 0.5) * 5_000;
      a.position.z += (jit() - 0.5) * 5_000;
      // never inside or just above a hill (the Waitākere and Hunua ranges reach 474 / 688 m)
      const v = Math.hypot(a.velocity.x, a.velocity.z) || 1;
      a.position.y = Math.max(a.position.y + (jit() - 0.5) * 800, 600, spawnFloor(terrain, a.position.x, a.position.z, a.velocity.x / v, a.velocity.z / v) + 50);
    }
  };
  jitterRed();
  const bot = new MissionBot(runner, world, p, opts.bot);
  // park / gun-only probe (#118): it flies (or pins) the jet instead of the mission bot
  const probe = opts.probe ? new Probe(opts.probe, world, p, bot) : null;
  const log: string[] = [];
  const T = () => world.time.toFixed(0).padStart(3);
  if (opts.log && probe) log.push(`${T()} PROBE ${probe.label}`);
  let friendlyLost = 0;
  let playerKills = 0;
  const launches: PlaythroughResult['launches'] = [];
  events.on('munition:launch', (e) => {
    if (e.shooter !== p) return;
    const tgt = world.getEntity(e.targetId);
    launches.push({ t: world.time, weapon: e.missile.def.id, targetId: e.targetId, group: (tgt as { groupId?: string } | undefined)?.groupId ?? null });
  });
  events.on('hud:message', (e) => {
    if (opts.log) log.push(`${T()} HUD ${e.text}`);
  });
  events.on('destroyed', (e) => {
    const ent = e.entity;
    if (ent.kind === 'missile' || ent.kind === 'decoy') return;
    if (e.attackerId === p.id && isHostile(p.team, ent.team)) playerKills++;
    if (ent.kind === 'aircraft' && ent.team === p.team && ent !== p) friendlyLost++;
    if (opts.log) log.push(`${T()} DESTROYED ${ent.kind === 'aircraft' ? ent.callsign : (ent as { type: string }).type} by ${e.attackerId === p.id ? 'PLAYER' : e.attackerId}`);
  });
  if (opts.log) {
    events.on('objective', (e) => log.push(`${T()} OBJ ${e.id} ${e.state}`));
    events.on('radio', (e) => log.push(`${T()} RADIO ${e.from}: ${e.text}`));
    events.on('munition:launch', (e) => {
      const tgt = world.getEntity(e.targetId);
      const who = e.shooter === p ? 'PLAYER' : e.shooter.kind === 'aircraft' ? e.shooter.callsign : e.shooter.kind;
      log.push(`${T()} LAUNCH ${e.missile.def.id} ${who} -> ${tgt ? (tgt.kind === 'aircraft' ? tgt.callsign : tgt.kind) : '-'} ${tgt ? (tgt.position.distanceTo(e.shooter.position) / 1000).toFixed(1) + 'km' : ''}`);
    });
  }
  const modes: Record<string, number> = {};
  const dt = 1 / 60;
  const maxT = opts.maxT ?? 900;
  for (let i = 0; i < maxT * 60 && runner.state === 'running'; i++) {
    probe?.beforeStep();
    if (i % 3 === 0 && p.alive) {
      if (!probe?.fly(dt * 3)) bot.update(dt * 3);
      modes[bot.mode] = (modes[bot.mode] ?? 0) + dt * 3;
    }
    world.step(dt);
    runner.update(world, dt);
    probe?.afterStep();
    if (i % 30 === 0) jitterRed();
    if (opts.log && i % 300 === 0 && p.alive) {
      const des = world.getEntity(p.radar.designatedId);
      const reds = world.aircraft.filter((a) => a.alive && a.team !== p.team).map((a) => `${a.callsign}:${a.aiState}@${(a.position.distanceTo(p.position) / 1000).toFixed(0)}km/${a.stores.reduce((n, x) => n + x.count, 0)}m`).join(' ');
      log.push(`${T()} RED ${reds}`);
      const blues = world.aircraft.filter((a) => a.alive && a.team === p.team && a !== p).map((a) => `${a.callsign}:${a.aiState}(${(a.position.x / 1000).toFixed(1)},${(a.position.z / 1000).toFixed(1)})y${Math.round(a.position.y)}v${Math.round(a.velocity.length())}`).join(' ');
      if (blues) log.push(`${T()} BLUE ${blues}`);
      const mine = world.missiles.filter((m) => m.alive && m.shooterId === p.id).map((m) => {
        const tg = world.getEntity(m.targetId);
        const toT = tg ? ` tgt${(Math.hypot(tg.position.x - m.position.x, tg.position.z - m.position.z) / 1000).toFixed(1)}km` : '';
        // guided bombs: how far the midcourse estimate is off the target, and the terminal seeker lock
        const cm = m as MissileEntity & { estPos?: Vector3; estVel?: Vector3; estTime?: number; seekerLocked?: boolean };
        const est =
          tg && cm.estPos && m.def.category === 'bomb'
            ? ` est${Math.round(Math.hypot(cm.estPos.x + (cm.estVel?.x ?? 0) * (world.time - (cm.estTime ?? world.time)) - tg.position.x, cm.estPos.z + (cm.estVel?.z ?? 0) * (world.time - (cm.estTime ?? world.time)) - tg.position.z))}m${cm.seekerLocked ? ' LK' : ''}`
            : '';
        return `${m.def.id}->${m.targetId}@${Math.round(m.position.distanceTo(p.position) / 100) / 10}km v${Math.round(m.velocity.length())} y${Math.round(m.position.y)}${toT}${est} (${(m.position.x / 1000).toFixed(1)},${(m.position.z / 1000).toFixed(1)})`;
      });
      if (mine.length) log.push(`${T()} MSL ${mine.join(' ')}`);
      log.push(`${T()} BOT ${bot.mode} pos=(${(p.position.x / 1000).toFixed(1)},${(p.position.z / 1000).toFixed(1)})km alt=${Math.round(p.position.y)} agl=${Math.round(p.flight.agl)} spd=${Math.round(p.velocity.length())} wpn=${p.selectedWeapon} des=${des ? des.kind + ':' + ((des as { type?: string }).type ?? '') : '-'} stores=${p.stores.map((x) => x.weapon + x.count).join(',')} hp=${Math.round(p.health)} fuel=${Math.round(p.flight.fuel)}`);
    }
  }
  const result = runner.state !== 'running' ? runner.result(world) : null;
  const r: PlaythroughResult = {
    mission: def.id,
    diff,
    seed,
    state: runner.state,
    reason: result?.reason ?? '',
    t: Math.round(world.time),
    alive: p.alive,
    playerKills,
    friendlyLost,
    objectives: runner.objectives.map((o) => `${o.primary ? 'P' : 'b'}:${o.id}=${o.state}${o.progress ? ` ${o.progress.done}/${o.progress.total}` : ''}`).join(' '),
    result,
    modes: Object.fromEntries(Object.entries(modes).map(([k, v]) => [k, Math.round(v)])),
    events: log,
    launches,
    ...(probe ? { probe: { label: probe.label, gunRounds: probe.gunRounds } } : {}),
  };
  runner.dispose?.();
  return r;
}
