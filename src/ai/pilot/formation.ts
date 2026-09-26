/**
 * F35-A — formation keeping (position hold on a slot relative to a leader).
 *
 * The slot is defined in the leader's horizontal velocity frame (right / back / up in metres),
 * predicted a fraction of a second ahead. Lateral and vertical errors become a velocity
 * correction on top of the leader's velocity; the along-track error drives the speed command
 * through a PI loop (the "throttle PID" — the autopilot's own PI loop then tracks that speed).
 * Far from the slot (> REJOIN_DIST) the wingman flies a lead-pursuit rejoin with the afterburner.
 */
import { Vector3 } from 'three';
import type { AircraftEntity } from '../../sim/entities';
import { clampN, interceptPoint } from '../geom';
import type { FlightIntent } from './Autopilot';

export interface FormationSlot {
  /** Metres to the leader's right (negative = left). */
  right: number;
  /** Metres behind the leader. */
  back: number;
  /** Metres above the leader. */
  up: number;
}

export const SLOT_FINGERTIP: FormationSlot = { right: 70, back: 55, up: -5 };
export const SLOT_FIGHTING_WING: FormationSlot = { right: 500, back: 420, up: 120 };
export const SLOT_ESCORT: FormationSlot = { right: 1_600, back: 900, up: 500 };

const REJOIN_DIST = 2_500;
const LOOKAHEAD = 0.6;

const _fwd = new Vector3();
const _right = new Vector3();
const _slot = new Vector3();
const _err = new Vector3();
const _vdes = new Vector3();
const _aim = new Vector3();

export class FormationKeeper {
  private alongI = 0;
  /** Distance to the slot at the last update (m). */
  error = Infinity;
  /** Rejoining from far away. */
  rejoining = false;

  reset(): void {
    this.alongI = 0;
  }

  /** World position of the slot (predicted `lookahead` s ahead), written into `out`. */
  static slotPosition(leader: AircraftEntity, slot: FormationSlot, out: Vector3, lookahead = 0): Vector3 {
    const v = leader.velocity;
    const vh = Math.hypot(v.x, v.z);
    if (vh > 1) _fwd.set(v.x / vh, 0, v.z / vh);
    else _fwd.set(0, 0, -1).applyQuaternion(leader.quaternion).setY(0).normalize();
    _right.set(-_fwd.z, 0, _fwd.x);
    return out
      .copy(leader.position)
      .addScaledVector(v, lookahead)
      .addScaledVector(_fwd, -slot.back)
      .addScaledVector(_right, slot.right)
      .setY(leader.position.y + v.y * lookahead + slot.up);
  }

  /**
   * Fill the intent to hold `slot` on `leader`. `skill` 0..1 scales the correction gains.
   * Returns the distance to the slot (m).
   */
  fly(it: FlightIntent, ac: AircraftEntity, leader: AircraftEntity, slot: FormationSlot, dt: number, skill: number, maxG: number): number {
    // error between where the slot and we will be shortly (relative velocity = damping)
    FormationKeeper.slotPosition(leader, slot, _slot, LOOKAHEAD);
    _err.subVectors(_slot, ac.position).addScaledVector(ac.velocity, -LOOKAHEAD);
    const dist = _err.length();
    this.error = dist;
    const lv = leader.velocity;
    const leaderSpeed = Math.max(80, lv.length());
    it.partnerId = leader.id;

    if (dist > REJOIN_DIST || (this.rejoining && dist > REJOIN_DIST * 0.6)) {
      // Rejoin: lead pursuit on the slot, fast.
      this.rejoining = true;
      const closing = leaderSpeed + clampN(dist * 0.02, 40, 120);
      interceptPoint(ac.position, closing, _slot, lv, _aim, 120);
      it.dir.subVectors(_aim, ac.position).normalize();
      it.speed = closing;
      it.allowAb = true;
      it.gMax = Math.min(4, maxG);
      it.gain = 1;
      this.alongI = 0;
      return dist;
    }
    this.rejoining = false;

    const vh = Math.hypot(lv.x, lv.z);
    if (vh > 1) _fwd.set(lv.x / vh, 0, lv.z / vh);
    else _fwd.set(0, 0, -1);
    const along = _err.dot(_fwd);
    // lateral / vertical: velocity correction proportional to the error (limited)
    const kPos = 0.28 + 0.12 * skill;
    _vdes.copy(lv);
    const latX = _err.x - _fwd.x * along;
    const latZ = _err.z - _fwd.z * along;
    const lim = 70;
    _vdes.x += clampN(latX * kPos, -lim, lim);
    _vdes.z += clampN(latZ * kPos, -lim, lim);
    _vdes.y += clampN(_err.y * kPos, -40, 40);
    it.dir.copy(_vdes).normalize();

    // along-track: PI on the position error → closure-speed command, limited by what the jet
    // can bleed off before reaching the slot (engine spool + drag ≈ 2 m/s², more with the brake)
    if (Math.abs(along) < 150) this.alongI = clampN(this.alongI + along * 0.01 * dt, -12, 12);
    else this.alongI *= 1 - Math.min(1, dt);
    const vStop = Math.sqrt(2 * 2 * Math.abs(along));
    const dv = clampN(along * (0.08 + 0.04 * skill) + this.alongI, -Math.min(60, vStop + 5), Math.min(90, vStop + 5));
    // closure we already have relative to the leader (along its track)
    const closure = (ac.velocity.x - lv.x) * _fwd.x + (ac.velocity.z - lv.z) * _fwd.z;
    it.speed = ac.flight.tas + (dv - closure) * 0.8;
    it.allowAb = true;
    it.allowBrake = true;
    it.brake = dv - closure < -15;
    it.gMax = Math.min(dist < 300 ? 5 : 4, maxG);
    it.gain = dist < 150 ? 1.6 : 1.2;
    it.track = true;
    it.allowInverted = false;
    return dist;
  }
}
