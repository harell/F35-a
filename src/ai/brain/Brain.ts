/**
 * F35-A — base class of every AI brain.
 *
 * Owns the per-pilot machinery shared by all roles: skill (derived lazily once the aircraft's
 * team/type are known), deterministic RNG, the Autopilot (hands), the current task, a readable
 * state label (→ ac.aiState), countermeasure button pulses and navigation helpers (patrol
 * race-track, route, RTB orbit).
 *
 * Tick: begin intent → subclass `think()` fills the intent and weapon/CM triggers →
 * Autopilot applies the safety layer and writes stick/throttle. SimWorld calls update() at 20 Hz.
 */
import { Vector3 } from 'three';
import { mulberry32 } from '../../core/math';
import { atmosphere, type AtmosphereSample } from '../../core/atmosphere';
import type { AiBrain, AiRole, AiTask, SimWorld, WingmanOrders } from '../../sim/api';
import type { AircraftEntity } from '../../sim/entities';
import { AIRCRAFT_PERF } from '../../sim/flight/aircraftData';
import { deriveSkill, type PilotSkill } from '../skill';
import { Autopilot, gammaForAltitude, type FlightIntent } from '../pilot/Autopilot';
import { RadioOperator } from '../radio';
import { clampN, dirWithElevation, headingDir } from '../geom';

let seedCounter = 1;

const _to = new Vector3();
const _p = new Vector3();
const _atm: AtmosphereSample = { temperature: 288, pressure: 101_325, density: 1.225, speedOfSound: 340, sigma: 1 };

/** True airspeed (m/s) for an indicated airspeed at an altitude. */
export function tasForIas(ias: number, altitude: number): number {
  return ias / Math.sqrt(Math.max(0.05, atmosphere(altitude, _atm).sigma));
}

export interface BrainOptions {
  skill: number;
  task?: AiTask;
  seed?: number;
  /** Friendly wingman's standing orders (FighterBrain 'wingman' only). */
  orders?: WingmanOrders;
}

export abstract class Brain implements AiBrain {
  readonly role: AiRole;
  protected readonly pilot = new Autopilot();
  protected readonly radio = new RadioOperator();
  protected readonly rng: () => number;
  /** The mission's 0..1 skill for this pilot (public: the combat model duck-types it). */
  readonly spawnSkill: number;
  protected task: AiTask | null;
  /** Derived on the first update (needs team, type and world difficulty). */
  private derivedSkill!: PilotSkill;
  protected initialised = false;
  /** Sim time of the current tick. */
  protected now = 0;
  /** Spawn position (default RTB / patrol centre). */
  protected readonly home = new Vector3();
  protected homeHeading = 0;
  protected homeAlt = 3000;
  /** Current behaviour label (mirrored into ac.aiState). */
  protected state = '';
  protected stateSince = 0;

  /* countermeasure pulses */
  private lastFlare = -99;
  private lastChaff = -99;
  private wantFlare = false;
  private wantChaff = false;

  /* navigation */
  private routeIndex = 0;
  private patrolLeg = 0;

  constructor(role: AiRole, opts: BrainOptions) {
    this.role = role;
    this.spawnSkill = opts.skill;
    this.task = opts.task ?? null;
    this.baseSeed = (opts.seed ?? seedCounter++ * 7919 + 17) >>> 0;
    this.rngImpl = mulberry32(this.baseSeed);
    this.rng = () => this.rngImpl();
  }

  private readonly baseSeed: number;
  private rngImpl: () => number;

  /**
   * The pilot's derived skill (reaction, g, aim, defence…). Public and stable: the combat model
   * reads `skill.defense` for countermeasure / notch effectiveness against this pilot.
   * Undefined until the brain's first update.
   */
  get skill(): PilotSkill {
    return this.derivedSkill;
  }

  update(ac: AircraftEntity, world: SimWorld, dt: number): void {
    this.now = world.time;
    if (!this.initialised) this.init(ac, world);
    const inp = ac.input;
    inp.fireGun = false;
    inp.fireWeapon = false;
    this.wantFlare = false;
    this.wantChaff = false;
    const it = this.pilot.begin(ac, this.skill.minAgl);
    this.think(ac, world, dt, it);
    this.pilot.fly(ac, world, dt);
    inp.flare = this.wantFlare;
    inp.chaff = this.wantChaff;
    if (this.pilot.safety.recovery) ac.aiState = 'PULL UP';
    else ac.aiState = this.state;
  }

  setTask(task: AiTask): void {
    this.task = task;
    this.routeIndex = 0;
    this.patrolLeg = 0;
    this.onTask(task);
  }

  /** Subclasses fill the flight intent and trigger weapons / countermeasures. */
  protected abstract think(ac: AircraftEntity, world: SimWorld, dt: number, it: FlightIntent): void;

  /** Hook: a new task arrived. */
  protected onTask(_task: AiTask): void {}

  /** Hook: first update. */
  protected onInit(_ac: AircraftEntity, _world: SimWorld): void {}

  private init(ac: AircraftEntity, world: SimWorld): void {
    this.initialised = true;
    // per-sortie variation: the combat system's salt (random per in-game sortie, derived from the
    // seed in seeded tests / replays) re-seeds the doctrine RNG, so a retried mission's enemies
    // roll different shot ranges, trigger delays, beam errors and jinks
    const salt = (world.combat as unknown as { aiSalt?: unknown }).aiSalt;
    if (typeof salt === 'number' && salt !== 0) this.rngImpl = mulberry32((this.baseSeed ^ salt) >>> 0);
    this.derivedSkill = deriveSkill(world.difficulty, this.spawnSkill, ac.team, ac.type);
    this.home.copy(ac.position);
    this.homeHeading = ac.flight.heading;
    this.homeAlt = ac.position.y;
    this.stateSince = this.now;
    this.onInit(ac, world);
  }

  protected setState(s: string): void {
    if (s !== this.state) {
      this.state = s;
      this.stateSince = this.now;
    }
  }

  protected timeInState(): number {
    return this.now - this.stateSince;
  }

  /* ───────────────────────── countermeasures ───────────────────────── */

  /** Request one flare salvo if `interval` s passed since the last (rising edge → 2 flares). */
  protected flares(ac: AircraftEntity, interval: number): void {
    if (ac.flares <= 0 || this.now - this.lastFlare < interval) return;
    this.lastFlare = this.now;
    this.wantFlare = true;
  }

  /** Request one chaff salvo if `interval` s passed since the last. */
  protected chaff(ac: AircraftEntity, interval: number): void {
    if (ac.chaff <= 0 || this.now - this.lastChaff < interval) return;
    this.lastChaff = this.now;
    this.wantChaff = true;
  }

  /* ───────────────────────── navigation ───────────────────────── */

  protected perfOf(ac: AircraftEntity) {
    return AIRCRAFT_PERF[ac.type];
  }

  /** Fly towards a point at an altitude (m MSL). Returns the horizontal distance. */
  protected flyToPoint(ac: AircraftEntity, it: FlightIntent, point: Vector3, altitude: number, maxGamma = 0.3, tau = 6): number {
    _to.set(point.x - ac.position.x, 0, point.z - ac.position.z);
    const d = _to.length();
    const gamma = gammaForAltitude(ac, altitude, maxGamma, tau);
    if (d < 1) headingDir(ac.flight.heading, _to);
    dirWithElevation(_to, gamma, it.dir);
    return d;
  }

  /**
   * Race-track patrol around `center` (legs of `length` m along `axisHeading`), at `altitude`.
   * The jet shuttles between the two ends; the turns fall out naturally.
   */
  protected flyRacetrack(ac: AircraftEntity, it: FlightIntent, center: Vector3, length: number, axisHeading: number, altitude: number, speed: number): void {
    headingDir(axisHeading, _to);
    const half = length * 0.5;
    const sign = this.patrolLeg === 0 ? 1 : -1;
    // offset the two ends laterally so the turns are one-way (a proper race-track)
    _p.set(center.x + _to.x * half * sign - _to.z * 1500 * sign, 0, center.z + _to.z * half * sign + _to.x * 1500 * sign);
    const d = this.flyToPoint(ac, it, _p, altitude, 0.2, 8);
    if (d < 2_500) this.patrolLeg ^= 1;
    it.speed = speed;
    it.gMax = Math.min(2.5, this.skill.maxG);
    it.gain = 0.7;
    it.allowInverted = false;
  }

  /**
   * Follow a route. Waypoint y = altitude (m MSL; ≤ 0 → keep current). Returns false when the
   * (non-looping) route is finished.
   */
  protected flyRoute(ac: AircraftEntity, it: FlightIntent, wps: Vector3[], loop: boolean, speed: number, gMax = 2.5): boolean {
    if (wps.length === 0) return false;
    if (this.routeIndex >= wps.length) {
      if (!loop) return false;
      this.routeIndex = 0;
    }
    const wp = wps[this.routeIndex];
    const alt = wp.y > 0 ? wp.y : ac.position.y;
    const d = this.flyToPoint(ac, it, wp, alt, 0.15, 10);
    // passed: close enough, or abeam and moving away
    const dx = wp.x - ac.position.x;
    const dz = wp.z - ac.position.z;
    const ahead = dx * ac.velocity.x + dz * ac.velocity.z;
    if (d < 1_500 || (d < 4_000 && ahead < 0)) {
      this.routeIndex++;
      if (this.routeIndex >= wps.length && loop) this.routeIndex = 0;
    }
    it.speed = speed;
    it.gMax = Math.min(gMax, this.skill.maxG);
    it.gain = 0.6;
    it.allowInverted = false;
    return true;
  }

  /** Current route waypoint index (for tests / debugging). */
  get waypointIndex(): number {
    return this.routeIndex;
  }

  /** Orbit a point (circle of ~radius) at altitude — used at the end of RTB. */
  protected orbit(ac: AircraftEntity, it: FlightIntent, center: Vector3, radius: number, altitude: number, speed: number): void {
    _to.set(ac.position.x - center.x, 0, ac.position.z - center.z);
    const d = Math.max(1, _to.length());
    _to.multiplyScalar(1 / d);
    // tangent (clockwise seen from above) + radial correction
    const tx = -_to.z;
    const tz = _to.x;
    const corr = clampN((d - radius) / radius, -1, 1);
    _p.set(tx - _to.x * corr * 1.5, 0, tz - _to.z * corr * 1.5);
    dirWithElevation(_p, gammaForAltitude(ac, altitude, 0.15, 8), it.dir);
    it.speed = speed;
    it.gMax = 2.5;
    it.gain = 0.7;
    it.allowInverted = false;
  }
}
