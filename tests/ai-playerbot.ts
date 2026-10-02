/**
 * A scripted "competent human" F-35 pilot for balance measurements (tests/ai-balance.test.ts and
 * e2e/review/dev-simai-balance.ts). It only uses what a human sees and does:
 *
 *  - picks the nearest hostile fighter on the HMD/TSD, taps it (designate → lock command),
 *  - fires one AMRAAM per target when the calibrated SHOOT cue shows, then cranks ~50° until the
 *    missile ends (the game's own hint), and re-commits,
 *  - AIM-9X when the seeker tone is locked (beast loadout), gun inside ~900 m on the LCOS pipper,
 *  - defends on the MAWS (DAS) warning after a human reaction time: long-range shots are dragged
 *    cold in afterburner; closer radar missiles are beamed against the launching radar with a
 *    descent into the clutter and chaff in the last seconds; IR missiles are beamed with the
 *    throttle out of afterburner and flares inside ~4 km; last-ditch break at ~2 s to go,
 *  - Winchester: turns for home.
 *
 * Flying is delegated to the AI Autopilot (the same "hands" the AI uses), so the bot's airmanship
 * is steady and the measured differences come from tactics and the difficulty settings.
 */
import { Vector3 } from 'three';
import type { SimWorld, TerrainQuery } from '../src/sim/api';
import { EventBus } from '../src/core/events';
import { DIFFICULTIES } from '../src/core/data';
import { isHostile, type Difficulty, type LoadoutId } from '../src/core/types';
import { createSimWorld } from '../src/sim/World';
import { createCombatSystemSeeded } from '../src/sim/weapons/CombatSystem';
import { createAiBrain } from '../src/ai';
import { createMissionRunner, missionById } from '../src/missions';
import { mulberry32 } from '../src/core/math';
import type { AircraftEntity, IncomingMissile } from '../src/sim/entities';
import { Autopilot, gammaForAltitude } from '../src/ai/pilot/Autopilot';
import { dirWithElevation, rotateHorizontal, signedHorizAngle } from '../src/ai/geom';

export interface PlayerBotOptions {
  /** Seconds before the pilot reacts to a new MAWS warning. */
  reaction: number;
  /** Defend at all (false = a passive pilot who only fights). */
  defend: boolean;
  /** Shoot only on SHOOT (calibrated) — the taught doctrine. */
  shootDiscipline: boolean;
  /** Winchester (missiles gone): true = turn cold and go home, false = press on with the gun. */
  rtbWhenWinchester: boolean;
  /** Unarmed survival tests: fly at the nearest bandit until the first missile is defended, then turn cold. */
  aggressor: boolean;
  /** Never command a lock: fire from the silent TWS track the radar auto-designates. */
  tws: boolean;
  /** Home point for RTB (x, z) and the CAP point to fly to when nothing is on the scope. */
  home: Vector3;
  cap: Vector3 | null;
}

const _h = new Vector3();
const _q = new Vector3();
const _p = new Vector3();
const _fwd = new Vector3();
const _aim = new Vector3();
const _vh = new Vector3();

/** The bot pulls the trigger only inside this range (m) with the LCOS pipper on the bandit. */
const GUN_FIRE_RANGE = 900;
/** Firing position the bot holds behind a bandit in a tail chase (m). */
const GUN_TRAIL = 450;
/** Bandit within this angle off the nose (rad): track it with the pipper (the AI's gunnery cone). */
const GUN_TRACK_CONE = 0.6;

export class PlayerBot {
  readonly pilot = new Autopilot();
  readonly opts: PlayerBotOptions;
  state = 'CAP';
  /** Missiles launched by the bot (id → target id). */
  private readonly shots = new Map<number, number>();
  private readonly seenAt = new Map<number, number>();
  private lastFlare = -99;
  private lastChaff = -99;
  private beamSide = 0;
  private defendingId = -1;
  private crankSide = 0;
  private lastShot = -99;
  /** Has defended at least one missile (an unarmed aggressor turns cold after that). */
  private defended = false;

  constructor(opts: Partial<PlayerBotOptions> & { home: Vector3 }) {
    this.opts = { reaction: 0.8, defend: true, shootDiscipline: true, rtbWhenWinchester: true, aggressor: false, tws: false, cap: null, ...opts };
  }

  /** Register on the world's event bus so launched missiles are tracked. */
  attach(world: SimWorld, p: AircraftEntity): void {
    world.events.on('munition:launch', (e) => {
      if (e.shooter === p) this.shots.set(e.missile.id, e.targetId ?? -1);
    });
  }

  /** Call at ~20 Hz; writes p.input (stick, throttle, triggers). */
  update(p: AircraftEntity, world: SimWorld, dt: number): void {
    const inp = p.input;
    inp.fireGun = false;
    inp.fireWeapon = false;
    inp.flare = false;
    inp.chaff = false;
    if (!p.alive) return;
    const it = this.pilot.begin(p, 250);
    const now = world.time;
    // prune finished shots
    for (const id of this.shots.keys()) {
      const m = world.getEntity(id);
      if (!m || !m.alive) this.shots.delete(id);
    }
    const inc = this.opts.defend ? this.threat(p, now) : null;
    if (inc) {
      this.defend(p, world, inc, now);
      this.defended = true;
    }
    else {
      this.defendingId = -1;
      this.beamSide = 0;
      this.offense(p, world, now);
    }
    this.pilot.fly(p, world, dt);
    void it;
  }

  /** Most urgent MAWS warning the pilot has had time to react to. */
  private threat(p: AircraftEntity, now: number): IncomingMissile | null {
    let best: IncomingMissile | null = null;
    for (const m of p.incoming) {
      if (!this.seenAt.has(m.missileId)) this.seenAt.set(m.missileId, now);
      if (now - this.seenAt.get(m.missileId)! < this.opts.reaction) continue;
      if (!best || m.timeToImpact < best.timeToImpact) best = m;
    }
    return best;
  }

  private defend(p: AircraftEntity, world: SimWorld, inc: IncomingMissile, now: number): void {
    const it = this.pilot.intent;
    const m = world.getEntity(inc.missileId);
    if (!m || m.kind !== 'missile') return;
    if (inc.missileId !== this.defendingId) {
      this.defendingId = inc.missileId;
      this.beamSide = 0;
    }
    const radar = inc.guidance === 'radar';
    // the radar to beam: the launcher's (RWR launch strobe) for semi-active / command shots
    let ref = m.position;
    const g = (m as unknown as { guiderId?: number }).guiderId;
    if (radar && m.def.guidance !== 'active_radar' && g !== undefined) {
      const guider = world.getEntity(g);
      if (guider && guider.alive) ref = guider.position;
    }
    _h.set(p.position.x - ref.x, 0, p.position.z - ref.z).normalize(); // away from the radar
    const tti = inc.timeToImpact;
    const d = inc.distance;
    const agl = p.flight.agl;
    const ground = p.position.y - agl;
    // last ditch: break perpendicular to the missile's flight path
    if (tti < 2.2 && d < 3_500) {
      _q.set(-m.velocity.z, 0, m.velocity.x).normalize();
      if (_q.x * p.velocity.x + _q.z * p.velocity.z < 0) _q.negate();
      dirWithElevation(_q, agl > 800 ? -0.2 : 0.05, it.dir);
      it.gMax = 9;
      it.gain = 3;
      it.throttle = radar ? 1 : 0.85;
      this.pulse(p, now, radar, true);
      this.state = 'BREAK';
      return;
    }
    if (radar && d > 11_000 && tti > 11) {
      // long shot: turn cold and drag it out of energy
      dirWithElevation(_h, gammaForAltitude(p, ground + 2_500, 0.2, 6), it.dir);
      it.throttle = 1;
      it.gMax = 6;
      it.gain = 1.5;
      this.state = 'DRAG';
      return;
    }
    // beam: perpendicular to the radar line of sight, on the side we're already turning to
    const bx = -_h.z;
    const bz = _h.x;
    if (this.beamSide === 0) this.beamSide = bx * p.velocity.x + bz * p.velocity.z >= 0 ? 1 : -1;
    _q.set(bx * this.beamSide, 0, bz * this.beamSide);
    if (radar) {
      dirWithElevation(_q, gammaForAltitude(p, ground + 1_000, 0.3, 5), it.dir);
      it.speed = 280;
      it.allowAb = true;
      it.gMax = 7;
      it.gain = 1.6;
      if (tti < 7) this.pulse(p, now, true, false);
      this.state = 'NOTCH';
    } else {
      dirWithElevation(_q, agl > 1_000 ? -0.08 : 0.02, it.dir);
      it.throttle = 0.85; // out of afterburner
      it.gMax = 7;
      it.gain = 1.6;
      if (d < 4_000) this.pulse(p, now, false, false);
      this.state = 'BEAM';
    }
  }

  /** Countermeasure button presses (rising edges). */
  private pulse(p: AircraftEntity, now: number, radar: boolean, both: boolean): void {
    const gap = both ? 0.35 : 0.8;
    if ((radar || both) && now - this.lastChaff > gap && p.chaff > 0) {
      p.input.chaff = true;
      this.lastChaff = now;
    }
    if ((!radar || both) && now - this.lastFlare > gap && p.flares > 0) {
      p.input.flare = true;
      this.lastFlare = now;
    }
  }

  private offense(p: AircraftEntity, world: SimWorld, now: number): void {
    const it = this.pilot.intent;
    const combat = world.combat;
    // nearest hostile aircraft on the scope
    let tgt: AircraftEntity | null = null;
    let best = Infinity;
    for (const c of p.radar.contacts) {
      if (!isHostile(p.team, c.team)) continue; // a competent pilot never engages civil traffic
      const e = world.getEntity(c.id);
      if (!e || e.kind !== 'aircraft' || !e.alive) continue;
      const d = c.position.distanceTo(p.position);
      if (d < best) {
        best = d;
        tgt = e;
      }
    }
    const missiles = combat.remaining(p, 'aim120') + combat.remaining(p, 'aim9x');
    // Winchester: a gun against an armed fighter is a losing trade — turn cold and go home unless
    // the bandit is already sitting in front of the nose
    let gunOnly = false;
    if (tgt && missiles === 0) {
      _fwd.set(0, 0, -1).applyQuaternion(p.quaternion);
      _p.subVectors(tgt.position, p.position);
      gunOnly = p.gunAmmo > 0 && (!this.opts.rtbWhenWinchester || (best < 1_500 && _fwd.dot(_p) > 0.8 * _p.length()));
    }
    const aggressor = this.opts.aggressor && !this.defended;
    if (!tgt || (missiles === 0 && !gunOnly && !aggressor)) {
      const dest = !tgt && this.opts.cap && (missiles > 0 || aggressor) ? this.opts.cap : this.opts.home;
      _h.set(dest.x - p.position.x, 0, dest.z - p.position.z);
      if (tgt && best < 25_000) {
        // run away from the bandit, bent towards home
        _q.set(p.position.x - tgt.position.x, 0, p.position.z - tgt.position.z).normalize();
        _h.normalize().add(_q.multiplyScalar(1.5));
        it.throttle = 1;
      } else it.speed = 250;
      dirWithElevation(_h, gammaForAltitude(p, Math.max(dest.y, 3_000), 0.2, 8), it.dir);
      it.gMax = tgt ? 5 : 3;
      this.state = missiles === 0 ? 'RTB' : 'CAP';
      return;
    }
    // tap the TD box: designate + command the lock (re-commanded while it isn't locked); in TWS
    // mode the pilot leaves the radar's auto-designated track alone (no STT, no RWR spike)
    if (!this.opts.tws && (p.radar.designatedId !== tgt.id || p.radar.lockedId === null)) combat.designate(p, tgt.id, world);
    if (this.opts.tws && p.radar.designatedId !== null) {
      const d = world.getEntity(p.radar.designatedId);
      if (d && d.kind === 'aircraft') tgt = d;
    }
    const R = tgt.position.distanceTo(p.position);
    // weapon choice
    const ir = combat.irSeekerState(p);
    let want: 'aim120' | 'aim9x' | 'gun' = 'gun';
    if (R > 1_600 && combat.remaining(p, 'aim120') > 0) want = 'aim120';
    if (combat.remaining(p, 'aim9x') > 0 && R < 8_000 && R > 900 && (ir.state === 'locked' || combat.remaining(p, 'aim120') === 0)) want = 'aim9x';
    if (p.selectedWeapon !== want) combat.selectWeapon(p, want, world);

    // our missile at this target still flying → crank (support it, stay out of its zone)
    let supporting = false;
    for (const [id, t] of this.shots) {
      if (t !== tgt.id) continue;
      const m = world.getEntity(id);
      if (m && m.alive && m.kind === 'missile' && !m.decoyed) supporting = true;
    }
    if (supporting && R > 4_000) {
      _h.set(tgt.position.x - p.position.x, 0, tgt.position.z - p.position.z).normalize();
      if (this.crankSide === 0) this.crankSide = signedHorizAngle(_h, p.velocity) >= 0 ? 1 : -1;
      rotateHorizontal(_h, this.crankSide * 50 * (Math.PI / 180), _q);
      dirWithElevation(_q, gammaForAltitude(p, Math.max(p.position.y, 2_500), 0.15, 8), it.dir);
      it.speed = 250;
      it.gMax = 4;
      this.state = 'CRANK';
      return;
    }
    this.crankSide = 0;

    if (want === 'gun' && R < 2_500) {
      _fwd.set(0, 0, -1).applyQuaternion(p.quaternion);
      _p.subVectors(tgt.position, p.position).normalize();
      _vh.copy(p.velocity).normalize();
      const lp = combat.gunLeadPoint(p, world);
      // lead pursuit on the LCOS pipper once the bandit is near the nose; until then pull the
      // nose round onto it (pure pursuit)
      const tracking = !!lp && _fwd.dot(_p) > Math.cos(GUN_TRACK_CONE);
      if (lp && tracking) {
        _aim.subVectors(lp, p.position).normalize();
        // move the pipper onto the bandit: the nose has to swing by (bandit − pipper). The
        // autopilot flies the VELOCITY vector, so the correction is added to the velocity
        // direction and the nose keeps its angle-of-attack offset above the flight path.
        // (Adding it to the nose instead left the pipper an AoA, 2–3°, off the bandit: never
        // inside the gate, 0 rounds in the playtest's gun-only runs.)
        it.dir.copy(_vh).add(_p).sub(_aim).normalize();
        const err = Math.acos(Math.max(-1, Math.min(1, _aim.dot(_p))));
        if (R < GUN_FIRE_RANGE && err < Math.max(0.012, (0.6 * tgt.radius) / R)) p.input.fireGun = true;
      } else it.dir.copy(_p);
      it.track = true;
      it.gain = 2.2;
      it.gMax = 9;
      // closure: tracking a bandit flying away from us (tail chase), hold a firing position
      // ~GUN_TRAIL m behind it instead of flying through it; otherwise keep the energy up
      const away = tgt.velocity.dot(_p);
      if (tracking && away > 0.7 * tgt.velocity.length()) {
        it.throttle = -1;
        it.speed = Math.max(170, Math.min(340, away + (R - GUN_TRAIL) * 0.15));
        it.allowAb = true;
        it.allowBrake = true;
      } else it.throttle = 1;
      this.state = 'GUNS';
      return;
    }
    // intercept: nose on the bandit, a little above its altitude
    _h.set(tgt.position.x - p.position.x, 0, tgt.position.z - p.position.z);
    const los = Math.atan2(tgt.position.y + 300 - p.position.y, Math.max(1, _h.length()));
    dirWithElevation(_h, Math.max(-0.35, Math.min(0.35, los)), it.dir);
    it.speed = R < 12_000 ? 300 : 260;
    // IR discipline: the afterburner plume is what an IRST sees — MIL until the merge
    it.allowAb = R < 3_000;
    it.gMax = R < 4_000 ? 9 : R < 15_000 ? 5 : 3;
    it.gain = R < 4_000 ? 2 : 1.2;
    it.track = R < 4_000;
    this.state = R < 4_000 ? 'BFM' : 'INTERCEPT';

    const z = combat.launchZone(p, world);
    if (!z || now - this.lastShot < 2) return;
    let shoot = z.shoot;
    if (!this.opts.shootDiscipline) shoot = z.range <= z.rMax && z.range >= z.rMin;
    if (shoot && !supporting) {
      p.input.fireWeapon = true;
      this.lastShot = now;
    }
  }
}

/* ───────────────────────── mission-level balance runs ───────────────────────── */

/** 'bot' = competent pilot who goes home when Winchester, 'committed' = presses on with the gun. */
export type BalanceStrategy = 'bot' | 'committed' | 'passive' | 'autopilot';

export interface BalanceResult {
  mission: string;
  diff: Difficulty;
  seed: number;
  /** 'rtb' = Winchester and back home (the engagement is over for the player). */
  state: 'running' | 'success' | 'failed' | 'rtb';
  /** Player alive at the end (mission over or time limit). */
  survived: boolean;
  t: number;
  playerKills: number;
  wingKills: number;
  redTotal: number;
  redLost: number;
  /** Sim time of the player's first missile launch / of the first red launch at the player (−1 = none). */
  playerFirstShot: number;
  redFirstShotAtPlayer: number;
  /** Range (m) at which a red aircraft first held the player on its own sensors (−1 = never). */
  redFirstDetect: number;
  /** Range (m) at which the player first held a red fighter on its own sensors. */
  playerFirstDetect: number;
  redShotsAtPlayer: number;
  redHitsOnPlayer: number;
  playerShots: number;
  /** Gun rounds the player fired. */
  gunRounds: number;
}

/**
 * Fly a mission with the real World / Combat / AI / MissionRunner and a scripted player.
 * `terrain` lets tests use a flat sea (fast); the e2e harness passes the real Auckland terrain.
 */
export function runBalanceMission(
  missionId: string,
  diff: Difficulty,
  seed: number,
  terrain: TerrainQuery,
  opts: {
    strategy?: BalanceStrategy;
    loadout?: LoadoutId;
    maxT?: number;
    reaction?: number;
    /** Randomise red spawn positions (default true). */
    jitter?: boolean;
    /**
     * Gun-only probe: the player's stores are emptied every step (so a mission rearm adds no
     * missiles), the pilot presses on with the gun (as 'committed') and the run doesn't end as
     * 'rtb' at home. Answers "is the gun useless or dominant" with a sweep.
     */
    gunOnly?: boolean;
    onStep?: (world: SimWorld, p: AircraftEntity, bot: PlayerBot) => void;
  } = {},
): BalanceResult {
  const def = missionById(missionId);
  if (!def) throw new Error(`no mission ${missionId}`);
  const events = new EventBus();
  const d = DIFFICULTIES[diff];
  const world = createSimWorld({ terrain, difficulty: d, events, combat: createCombatSystemSeeded(seed) });
  const runner = createMissionRunner({ ...def, seed: (def.seed ?? 1) + seed } as typeof def, { createAi: createAiBrain, difficulty: d, events });
  runner.setup(world, opts.loadout ?? def.recommendedLoadout);
  const p = world.player!;
  const strategy = opts.strategy ?? 'bot';
  const home = p.position.clone();
  const wp = runner.waypoints[0];
  const gunOnly = !!opts.gunOnly;
  const emptyStores = () => {
    if (gunOnly) for (const s of p.stores) s.count = 0;
  };
  emptyStores();
  const bot = new PlayerBot({ home, cap: wp ? wp.position.clone() : null, reaction: opts.reaction ?? 0.8, rtbWhenWinchester: strategy !== 'committed' && !gunOnly });
  bot.attach(world, p);
  if (strategy === 'autopilot') p.ai = createAiBrain('fighter', { skill: 0.9 });
  const r: BalanceResult = {
    mission: missionId, diff, seed, state: 'running', survived: true, t: 0, playerKills: 0, wingKills: 0, redTotal: 0, redLost: 0,
    playerFirstShot: -1, redFirstShotAtPlayer: -1, redFirstDetect: -1, playerFirstDetect: -1, redShotsAtPlayer: 0, redHitsOnPlayer: 0, playerShots: 0, gunRounds: 0,
  };
  events.on('munition:launch', (e) => {
    if (e.shooter === p) {
      r.playerShots++;
      if (r.playerFirstShot < 0) r.playerFirstShot = world.time;
    } else if (e.shooter.team === 'red' && e.targetId === p.id) {
      r.redShotsAtPlayer++;
      if (r.redFirstShotAtPlayer < 0) r.redFirstShotAtPlayer = world.time;
    }
  });
  events.on('munition:end', (e) => {
    if (e.missile.team === 'red' && e.targetId === p.id && (e.reason === 'hit' || e.reason === 'proximity')) r.redHitsOnPlayer++;
  });
  events.on('destroyed', (e) => {
    const ent = e.entity;
    if (ent.kind !== 'aircraft' || ent.team !== 'red') return;
    r.redLost++;
    if (e.attackerId === p.id) r.playerKills++;
    else if (e.attackerId != null) r.wingKills++;
  });
  const dt = 1 / 60;
  const maxT = opts.maxT ?? 420;
  const redSeen = new Set<number>();
  // geometry jitter (seeded): each red jet appears up to ±3 km / ±500 m away from its scripted spot,
  // so the runs sample different aspects and timings of the same engagement
  const jit = mulberry32(seed * 7919 + 13);
  const jittered = new Set<number>();
  const jitter = () => {
    if (opts.jitter === false) return;
    for (const a of world.aircraft) {
      if (a.team !== 'red' || jittered.has(a.id)) continue;
      jittered.add(a.id);
      a.position.x += (jit() - 0.5) * 6_000;
      a.position.z += (jit() - 0.5) * 6_000;
      a.position.y = Math.max(a.position.y + (jit() - 0.5) * 1_000, 800);
    }
  };
  jitter();
  for (let i = 0; i < maxT * 60 && runner.state === 'running' && p.alive; i++) {
    if (strategy !== 'autopilot' && i % 3 === 0) {
      if (strategy === 'passive') {
        p.input.pitch = 0;
        p.input.roll = 0;
        p.input.throttle = 0.85;
      } else bot.update(p, world, dt * 3);
    }
    const ammo = p.gunAmmo;
    world.step(dt);
    r.gunRounds += Math.max(0, ammo - p.gunAmmo);
    runner.update(world, dt);
    emptyStores();
    if (i % 30 === 0) jitter();
    opts.onStep?.(world, p, bot);
    // Winchester and home (≤ 6 km, nothing inbound): the engagement is over for the player
    if (!gunOnly && i % 30 === 0 && p.alive && p.incoming.length === 0 && world.combat.remaining(p, 'aim120') + world.combat.remaining(p, 'aim9x') === 0) {
      if (Math.hypot(p.position.x - home.x, p.position.z - home.z) < 6_000) {
        r.state = 'rtb';
        break;
      }
    }
    if (i % 6 === 0) {
      for (const a of world.aircraft) {
        if (a.team !== 'red' || !a.alive) continue;
        redSeen.add(a.id);
        if (r.redFirstDetect < 0) {
          const c = a.radar.contacts.find((k) => k.id === p.id);
          if (c && c.source !== 'datalink' && c.lastSeen >= world.time - 0.3) r.redFirstDetect = a.position.distanceTo(p.position);
        }
        if (r.playerFirstDetect < 0) {
          const c = p.radar.contacts.find((k) => k.id === a.id);
          if (c && c.source !== 'datalink') r.playerFirstDetect = a.position.distanceTo(p.position);
        }
      }
    }
  }
  if (r.state !== 'rtb') r.state = runner.state;
  r.survived = p.alive;
  r.t = world.time;
  r.redTotal = redSeen.size;
  runner.dispose?.();
  return r;
}

/* ───────────────────────── 1v1 duels ───────────────────────── */

export interface DuelResult {
  survived: boolean;
  redKilled: boolean;
  redShots: number;
  redHits: number;
  playerShots: number;
  /** Range (m) at which the red jet first held the player on its own sensors (−1 = never). */
  redDetect: number;
  /** Who fired first: 'player' | 'red' | 'none'. */
  firstShot: 'player' | 'red' | 'none';
  t: number;
  /** Red launches / hits by munition id. */
  byMunition: Record<string, { n: number; hit: number }>;
}

/**
 * Head-on 1v1 at `range` m: the scripted player (competent bot) vs one red fighter flown by the
 * real AI at the difficulty's skill. `playerArmed: false` strips the player's weapons (pure
 * survival against the red jet's full load, like the reviewers' redpk harness, but with a proper
 * notch-and-chaff defence).
 */
export function runDuel(
  diff: Difficulty,
  seed: number,
  terrain: TerrainQuery,
  opts: { redType?: 'mig29' | 'su27' | 'su35' | 'su57'; playerArmed?: boolean; loadout?: LoadoutId; alt?: number; range?: number; maxT?: number; skillOffset?: number; tws?: boolean } = {},
): DuelResult {
  const events = new EventBus();
  const d = DIFFICULTIES[diff];
  const world = createSimWorld({ terrain, difficulty: d, events, combat: createCombatSystemSeeded(seed) });
  const alt = opts.alt ?? 5_000;
  const R0 = opts.range ?? 30_000;
  const jit = mulberry32(seed * 131 + 7);
  const p = world.spawnAircraft({ type: 'f35a', team: 'blue', isPlayer: true, position: new Vector3(0, alt, 0), heading: 0, speed: 250, loadout: opts.loadout ?? 'a2a_stealth', fuel: 0.7 });
  const skill = Math.max(0, Math.min(1, d.aiSkill + (opts.skillOffset ?? 0)));
  const red = world.spawnAircraft({
    type: opts.redType ?? 'mig29',
    team: 'red',
    position: new Vector3((jit() - 0.5) * 8_000, alt + (jit() - 0.5) * 2_000, -R0),
    heading: Math.PI + (jit() - 0.5) * 0.6,
    speed: 250,
    fuel: 0.7,
    ai: createAiBrain('fighter', { skill, seed }),
  });
  if (opts.playerArmed === false) {
    p.stores.length = 0;
    p.gunAmmo = 0;
  }
  const bot = new PlayerBot({ home: new Vector3(0, alt, 30_000), cap: new Vector3(0, alt, -R0), aggressor: opts.playerArmed === false, tws: !!opts.tws });
  bot.attach(world, p);
  const r: DuelResult = { survived: true, redKilled: false, redShots: 0, redHits: 0, playerShots: 0, redDetect: -1, firstShot: 'none', t: 0, byMunition: {} };
  events.on('munition:launch', (e) => {
    if (e.shooter === p) {
      r.playerShots++;
      if (r.firstShot === 'none') r.firstShot = 'player';
    } else if (e.shooter === red) {
      r.redShots++;
      if (r.firstShot === 'none') r.firstShot = 'red';
      (r.byMunition[e.missile.def.id] ??= { n: 0, hit: 0 }).n++;
    }
  });
  events.on('munition:end', (e) => {
    if (e.missile.shooterId === red.id && e.targetId === p.id && (e.reason === 'hit' || e.reason === 'proximity')) {
      r.redHits++;
      (r.byMunition[e.missile.def.id] ??= { n: 0, hit: 0 }).hit++;
    }
  });
  const dt = 1 / 60;
  const maxT = opts.maxT ?? 200;
  for (let i = 0; i < maxT * 60 && p.alive && red.alive; i++) {
    if (i % 3 === 0) bot.update(p, world, dt * 3);
    world.step(dt);
    if (r.redDetect < 0 && i % 6 === 0) {
      const c = red.radar.contacts.find((k) => k.id === p.id);
      if (c && c.source !== 'datalink' && c.lastSeen >= world.time - 0.3) r.redDetect = red.position.distanceTo(p.position);
    }
    // the red jet ran away / gave up and nobody is shooting any more
    if (i % 60 === 0 && world.time > 60 && world.missiles.every((m) => !m.alive) && red.position.distanceTo(p.position) > 30_000) break;
  }
  // let missiles in flight finish
  for (let i = 0; i < 60 * 40 && world.missiles.some((m) => m.alive); i++) world.step(dt);
  r.survived = p.alive;
  r.redKilled = !red.alive;
  r.t = world.time;
  return r;
}
