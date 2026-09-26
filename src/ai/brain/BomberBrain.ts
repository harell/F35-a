/**
 * F35-A — bomber brain (Tu-22M3 raids): fly the route at altitude, straight and steady.
 *
 *  ROUTE      waypoint route (task 'route'; y = altitude), or straight on the spawn heading
 *  JINK       hostile fighter close: mild heading weaves, full power, pre-emptive flares when
 *             a fighter sits behind inside IR-missile range
 *  DEFENSIVE  missile inbound: stronger weave, chaff vs radar missiles, flares vs IR (and close in)
 *  RTB        route finished (non-looping) or task 'rtb': head home and orbit
 * Heavies never roll inverted and keep the g low (the autopilot caps by airframe limits).
 */
import { Vector3 } from 'three';
import type { AiTask, SimWorld } from '../../sim/api';
import type { AircraftEntity } from '../../sim/entities';
import type { FlightIntent } from '../pilot/Autopilot';
import { dirWithElevation, headingDir, rotateHorizontal } from '../geom';
import { Brain, type BrainOptions } from './Brain';
import { Awareness } from './awareness';
import { FormationKeeper, type FormationSlot } from '../pilot/formation';

const DEG = Math.PI / 180;
const _p = new Vector3();
/** Heavy bomber element: wide echelon right, slightly stepped down. */
const SLOT_BOMBER: FormationSlot = { right: 700, back: 500, up: -60 };

export class BomberBrain extends Brain {
  private readonly aw = new Awareness();
  private readonly form = new FormationKeeper();
  private phase = 0;
  private readonly farPoint = new Vector3();
  /** Passed over the 'attack' target. */
  private attackDone = false;

  constructor(opts: BrainOptions) {
    super('bomber', opts);
  }

  protected override onInit(ac: AircraftEntity): void {
    this.phase = this.rng() * Math.PI * 2;
    headingDir(ac.flight.heading, _p);
    this.farPoint.copy(ac.position).addScaledVector(_p, 200_000);
  }

  protected override onTask(_task: AiTask): void {
    this.attackDone = false;
  }

  protected think(ac: AircraftEntity, world: SimWorld, dt: number, it: FlightIntent): void {
    this.aw.update(ac, world, this.skill, this.rng);
    const perf = this.perfOf(ac);
    const cruise = ac.type === 'a50' ? 190 : 250;
    const task = this.task;

    // navigation: bomber elements fly a wide echelon on their lead
    let label = 'ROUTE';
    const lead = world.getEntity(ac.leaderId);
    if (lead && lead.kind === 'aircraft' && lead.alive && lead !== ac && lead.team === ac.team) {
      this.form.fly(it, ac, lead, SLOT_BOMBER, dt, this.skill.level, perf.maxG * 0.8);
      label = 'FORM';
    } else if (task?.kind === 'route') {
      if (!this.flyRoute(ac, it, task.waypoints, task.loop, cruise, 1.8)) label = this.goHome(ac, it, this.home);
    } else if (task?.kind === 'rtb') {
      label = this.goHome(ac, it, task.point);
    } else if (task?.kind === 'attack') {
      // raid: run in on the target at altitude, then turn for home
      const t = world.getEntity(task.targetId);
      if (t && t.alive && !this.attackDone) {
        const d = this.flyToPoint(ac, it, t.position, this.homeAlt, 0.1, 12);
        it.speed = cruise;
        if (d < 2_500) this.attackDone = true;
        label = 'ATTACK';
      } else label = this.goHome(ac, it, this.home);
    } else if (task?.kind === 'patrol') {
      this.flyRacetrack(ac, it, task.center, Math.max(20_000, task.radius * 2), this.homeHeading + Math.PI / 2, task.altitude, cruise);
      label = 'PATROL';
    } else {
      this.flyToPoint(ac, it, this.farPoint, this.homeAlt, 0.1, 12);
      it.speed = cruise;
    }
    // heavies turn at ≤ ~45° of bank (1.4 g), gently
    it.gMax = Math.min(it.gMax, 1.4, perf.maxG * 0.8);
    it.gain = Math.min(it.gain, 0.5);
    it.allowInverted = false;

    // threats
    const inc = this.aw.threatMissile(this.now, ac.incoming);
    const fighter = this.aw.closest(true);
    let amp = 0;
    if (inc) {
      amp = 14 * DEG;
      label = 'DEFENSIVE';
      if (inc.guidance === 'ir') {
        if (inc.distance < 5_500) this.flares(ac, 0.7);
      } else {
        if (inc.distance < 12_000) this.chaff(ac, 0.9);
        if (inc.distance < 3_000) this.flares(ac, 0.6);
      }
      it.throttle = 1;
    } else if (fighter && fighter.range < 12_000) {
      amp = 7 * DEG;
      label = 'JINK';
      it.throttle = 1;
      // fighter in our rear hemisphere inside IR range: pre-emptive flares
      _p.subVectors(fighter.pos, ac.position);
      if (fighter.range < 4_000 && _p.dot(ac.velocity) < 0) this.flares(ac, 3);
    }
    if (amp > 0) {
      this.phase += dt * (2 * Math.PI) / 7;
      rotateHorizontal(it.dir, Math.sin(this.phase) * amp, it.dir);
      it.gain = Math.max(it.gain, 0.8);
    }
    this.setState(label);
  }

  private goHome(ac: AircraftEntity, it: FlightIntent, point: Vector3): string {
    const d = this.flyToPoint(ac, it, point, this.homeAlt, 0.1, 12);
    if (d < 8_000) this.orbit(ac, it, point, 7_000, this.homeAlt, 220);
    else it.speed = 240;
    return 'RTB';
  }
}

/**
 * AWACS brain (A-50): race-track orbit; flees at full power when a hostile aircraft comes
 * within ~25 km (its own 360° radar sees them), returns once clear for 15 s.
 *  ORBIT / FLEE / DEFENSIVE
 */
export class AwacsBrain extends Brain {
  private readonly aw = new Awareness();
  private fleeing = false;
  private clearSince = -1;
  private readonly fleeDir = new Vector3();

  constructor(opts: BrainOptions) {
    super('awacs', opts);
  }

  protected think(ac: AircraftEntity, world: SimWorld, _dt: number, it: FlightIntent): void {
    this.aw.update(ac, world, this.skill, this.rng);
    const task = this.task;
    const center = task?.kind === 'patrol' ? task.center : task?.kind === 'rtb' ? task.point : this.home;
    const alt = task?.kind === 'patrol' ? task.altitude : Math.max(6_000, this.homeAlt);
    const length = task?.kind === 'patrol' ? Math.max(20_000, task.radius * 2) : 25_000;

    // threat picture: nearest hostile aircraft and the centroid of those within 40 km
    let nearest = Infinity;
    _p.set(0, 0, 0);
    let n = 0;
    for (const b of this.aw.bandits) {
      if (b.range < nearest) nearest = b.range;
      if (b.range < 40_000) {
        _p.add(b.pos);
        n++;
      }
    }
    if (!this.fleeing && nearest < 25_000) {
      this.fleeing = true;
      this.clearSince = -1;
    }
    if (this.fleeing) {
      if (n > 0) this.fleeDir.set(ac.position.x - _p.x / n, 0, ac.position.z - _p.z / n).normalize();
      if (nearest > 45_000) {
        if (this.clearSince < 0) this.clearSince = this.now;
        if (this.now - this.clearSince > 15) this.fleeing = false;
      } else this.clearSince = -1;
    }

    const inc = this.aw.threatMissile(this.now, ac.incoming);
    if (this.fleeing || inc) {
      if (this.fleeDir.lengthSq() < 0.5) this.fleeDir.set(ac.position.x - center.x, 0, ac.position.z - center.z).normalize();
      dirWithElevation(this.fleeDir, -0.03, it.dir);
      it.throttle = 1;
      it.gMax = 1.8;
      it.gain = 0.7;
      it.allowInverted = false;
      if (inc) {
        if (inc.guidance === 'ir' || inc.distance < 3_000) this.flares(ac, 0.6);
        if (inc.guidance === 'radar' && inc.distance < 12_000) this.chaff(ac, 0.8);
        this.setState('DEFENSIVE');
      } else this.setState('FLEE');
      return;
    }
    this.flyRacetrack(ac, it, center, length, this.homeHeading + Math.PI / 2, alt, 190);
    it.gMax = 1.6;
    this.setState('ORBIT');
  }
}
