/**
 * F35-A — AI low-level flight controller ("the pilot's hands").
 *
 * Brains describe WHAT they want each tick in a FlightIntent (desired velocity direction, g
 * ceiling, speed); the Autopilot turns that into stick / throttle inputs for the fly-by-wire
 * flight model — the only way AI is allowed to move a jet.
 *
 * Steering ("roll the lift vector onto the target, then pull"):
 *   1. angle error between the velocity vector and the desired direction → desired turn
 *      acceleration  a = V · gain · angle  (+ optional line-of-sight-rate feed-forward when
 *      tracking a moving aim point), in the plane perpendicular to the velocity;
 *   2. add the gravity compensation the lift must also provide (G·cosγ "up" in wind axes);
 *   3. the resulting lift vector gives the desired bank (about the velocity vector — the FBW
 *      rolls about the stability axis) and load factor n = |A| / G, capped at intent.gMax
 *      while keeping the gravity share (so a max-g turn is correctly banked);
 *   4. roll stick = P-controller on bank error (gain from the airframe's roll time constant →
 *      ≈ 0.7 damping), pitch stick = stickForG(n) gated by cos²(bank error), so the jet only
 *      pulls once the lift vector points roughly the right way (no pulling in the wrong plane);
 *   5. pushovers are flown by unloading (never below +0.1 g) unless the error is large, when the
 *      jet rolls inverted and pulls (split-S / roll-and-pull), with hysteresis.
 *
 * Speed: PI throttle loop on true airspeed (afterburner only when allowed), speed brake on
 * big overspeeds. Safety (terrain, stall, mid-air, map edge) is applied first — see safety.ts.
 */
import { Vector3 } from 'three';
import { G } from '../../core/math';
import { AB_DETENT } from '../../core/types';
import type { AircraftEntity } from '../../sim/entities';
import type { SimWorld } from '../../sim/api';
import { perfOf, rollRateAvailable, stickForG } from '../../sim/flight/performance';
import { UP, angleBetween, clampN, wrapAngle } from '../geom';
import { applySafety, type SafetyState } from './safety';

/** What a brain asks the pilot to do this tick. Reset every tick by `Autopilot.begin`. */
export interface FlightIntent {
  /** Desired velocity direction (unit world vector). */
  dir: Vector3;
  /** Load-factor ceiling for this manoeuvre (g). */
  gMax: number;
  /** Target true airspeed for the throttle loop (m/s). */
  speed: number;
  /** Direct throttle 0..1 (AB above 0.9), or −1 for speed hold. */
  throttle: number;
  /** Speed hold may light the afterburner. */
  allowAb: boolean;
  /** Speed hold may use the speed brake. */
  allowBrake: boolean;
  /** Force the speed brake out. */
  brake: boolean;
  /** Turn aggressiveness (1/s): angle error → commanded turn rate. */
  gain: number;
  /** Tracking a moving aim point: add line-of-sight-rate feed-forward. */
  track: boolean;
  /** Minimum height above the terrain / sea (m) — the safety layer's floor. */
  minAgl: number;
  /** Allow rolling past 90° to pull down (split-S). */
  allowInverted: boolean;
  /** Steering bank limit (rad, π = none): the g cap alone lets a descending turn bank past it. */
  bankMax: number;
  /** Entity the mid-air avoidance treats as a formation partner (closer spacing allowed). */
  partnerId: number;
}

const KP_THR = 0.02;
const KI_THR = 0.004;

/**
 * Flight-path angle (rad) that captures `targetAlt` smoothly: the altitude error closes with a
 * time constant of `tau` seconds (≈ 6 s fighters, 10 s heavies), limited to ±maxGamma, with a
 * little vertical-speed damping so the capture does not balloon.
 */
export function gammaForAltitude(ac: AircraftEntity, targetAlt: number, maxGamma: number, tau = 6): number {
  const V = Math.max(60, ac.velocity.length());
  const dh = targetAlt - ac.position.y;
  const s = clampN(dh / (V * tau), -Math.sin(maxGamma), Math.sin(maxGamma));
  return Math.asin(s);
}

/* scratch */
const _vh = new Vector3();
const _perp = new Vector3();
const _rightH = new Vector3();
const _upV = new Vector3();
const _bodyR = new Vector3();
const _lift = new Vector3();
const _tmp = new Vector3();
const _aff = new Vector3();

export class Autopilot {
  readonly intent: FlightIntent = {
    dir: new Vector3(0, 0, -1),
    gMax: 3,
    speed: 250,
    throttle: -1,
    allowAb: false,
    allowBrake: true,
    brake: false,
    gain: 1.2,
    track: false,
    minAgl: 150,
    allowInverted: true,
    bankMax: Math.PI,
    partnerId: -1,
  };
  /** What the safety layer did on the last tick (read by brains, e.g. to label 'PULL UP'). */
  readonly safety: SafetyState = { terrain: false, recovery: false, stall: false, avoid: false, boundary: false, floorGamma: -2 };

  /** Throttle PI integrator (−1 = uninitialised → start from the current lever). */
  private thrI = -1;
  /** Direction we are currently rolling in (hysteresis near 180° bank error). */
  private rollSign = 0;
  /** Roll-inverted-and-pull mode latched (hysteresis). */
  private inverted = false;
  private readonly prevDir = new Vector3();
  private hasPrev = false;
  private readonly ff = new Vector3();
  /** Last commanded bank error (rad) — lets brains know the lift vector is not yet on target. */
  bankError = 0;
  /** Angle between velocity and the (post-safety) desired direction (rad). */
  angleError = 0;

  /** Start a tick: default intent = keep flying straight at the current speed. */
  begin(ac: AircraftEntity, minAgl: number): FlightIntent {
    const it = this.intent;
    const V = ac.velocity.length();
    if (V > 1) it.dir.copy(ac.velocity).multiplyScalar(1 / V);
    it.gMax = 3;
    it.speed = Math.max(V, 150);
    it.throttle = -1;
    it.allowAb = false;
    it.allowBrake = true;
    it.brake = false;
    it.gain = 1.2;
    it.track = false;
    it.minAgl = minAgl;
    it.allowInverted = true;
    it.bankMax = Math.PI;
    it.partnerId = -1;
    return it;
  }

  /** Apply safety, then steer and run the throttle loop. Writes ac.input. */
  fly(ac: AircraftEntity, world: SimWorld, dt: number): void {
    const it = this.intent;
    if (!(it.dir.lengthSq() > 1e-9)) it.dir.copy(ac.velocity);
    it.dir.normalize();
    applySafety(this.safety, it, ac, world);
    this.steer(ac, dt);
    this.throttleLoop(ac, dt);
    ac.input.yaw = 0;
  }

  /** Forget filter / integrator state (after a teleport or a long pause). */
  reset(): void {
    this.thrI = -1;
    this.rollSign = 0;
    this.inverted = false;
    this.hasPrev = false;
    this.ff.set(0, 0, 0);
  }

  /* ───────────────────────────── steering ───────────────────────────── */

  private steer(ac: AircraftEntity, dt: number): void {
    const it = this.intent;
    const inp = ac.input;
    const vel = ac.velocity;
    const V = vel.length();
    if (V < 20 || !ac.alive) {
      inp.pitch = 0;
      inp.roll = 0;
      return;
    }
    const perf = perfOf(ac);
    _vh.copy(vel).multiplyScalar(1 / V);
    const dir = it.dir;

    // Line-of-sight-rate feed-forward (smoothed finite difference of the aim direction).
    if (it.track && this.hasPrev && dt > 1e-4) {
      const jump = angleBetween(this.prevDir, dir);
      if (jump < 0.2) {
        _tmp.subVectors(dir, this.prevDir).multiplyScalar(1 / dt);
        if (_tmp.length() > 0.6) _tmp.setLength(0.6);
        this.ff.lerp(_tmp, 0.5);
      } else this.ff.set(0, 0, 0);
    } else this.ff.multiplyScalar(0.5);
    this.prevDir.copy(dir);
    this.hasPrev = true;

    const c = clampN(_vh.dot(dir), -1, 1);
    const ang = Math.acos(c);
    this.angleError = ang;

    // Wind-axis frame: rightH (horizontal, ⟂ V) and upV (vertical plane, ⟂ V).
    _rightH.crossVectors(_vh, UP);
    const rl = _rightH.length();
    _bodyR.set(1, 0, 0).applyQuaternion(ac.quaternion);
    if (rl < 0.05) _rightH.copy(_bodyR).addScaledVector(_vh, -_bodyR.dot(_vh)).normalize();
    else _rightH.multiplyScalar(1 / rl);
    _upV.crossVectors(_rightH, _vh);
    const cosGamma = rl < 0.05 ? 0 : rl;

    // Current lift direction (right wing × velocity) and its bank about the velocity vector.
    _lift.crossVectors(_bodyR, _vh);
    if (_lift.lengthSq() < 1e-6) _lift.set(0, 1, 0).applyQuaternion(ac.quaternion);
    _lift.normalize();
    const bankCur = Math.atan2(_lift.dot(_rightH), _lift.dot(_upV));

    // Direction of the required turn (⟂ V).
    _perp.copy(dir).addScaledVector(_vh, -c);
    const pl = _perp.length();
    if (pl < 1e-5) {
      if (c > 0) _perp.set(0, 0, 0);
      else _perp.copy(_lift); // straight behind: pull through the current lift vector
    } else _perp.multiplyScalar(1 / pl);

    // Turn acceleration components in the (rightH, upV) plane.
    const aTurn = V * it.gain * ang;
    _aff.copy(this.ff).addScaledVector(_vh, -this.ff.dot(_vh)).multiplyScalar(V);
    let aLat = aTurn * _perp.dot(_rightH) + _aff.dot(_rightH);
    let aUpT = aTurn * _perp.dot(_upV) + _aff.dot(_upV);
    const gc = G * cosGamma;

    // Respect the g ceiling while keeping the gravity share.
    const gMax = Math.max(1.05, it.gMax);
    const gm = gMax * G;
    const turn2 = aLat * aLat + aUpT * aUpT;
    if (turn2 > 1e-6 && aLat * aLat + (aUpT + gc) * (aUpT + gc) > gm * gm) {
      const bq = aUpT * gc;
      const k = (-bq + Math.sqrt(Math.max(0, bq * bq - turn2 * (gc * gc - gm * gm)))) / turn2;
      aLat *= k;
      aUpT *= k;
    }
    let aUp = aUpT + gc;

    // Pushovers: unload (≥ +0.1 g) for small corrections; roll inverted & pull for big ones
    // (fighters only — heavies never roll past ~60°).
    if (!it.allowInverted || perf.maxG < 4) this.inverted = false;
    else if (!this.inverted && ang > 25 * (Math.PI / 180) && aUp < 0) this.inverted = true;
    else if (this.inverted && (ang < 12 * (Math.PI / 180) || aUp > 0.3 * G)) this.inverted = false;
    if (!this.inverted && aUp < 0.1 * G) aUp = 0.1 * G;

    let nDes = Math.hypot(aLat, aUp) / G;
    if (nDes > gMax) nDes = gMax;
    let bankDes = Math.atan2(aLat, aUp);
    if (Math.abs(bankDes) > it.bankMax) bankDes = Math.sign(bankDes) * it.bankMax;
    // At very low load the lift direction hardly matters: don't chase it around.
    if (nDes < 0.6) bankDes = bankCur + wrapAngle(bankDes - bankCur) * (nDes / 0.6);

    let err = wrapAngle(bankDes - bankCur);
    // Near 180° keep rolling the way we already are (no left/right dithering).
    if (Math.abs(err) > 2.6 && this.rollSign !== 0 && Math.sign(err) !== this.rollSign) err += this.rollSign * Math.PI * 2;
    this.bankError = err;

    // Roll: P on bank error, gain from the (authority-scaled) roll time constant.
    const qbar = 0.5 * 1.225 * ac.flight.ias * ac.flight.ias;
    const auth = clampN(qbar / perf.qFull, 0.06, 1);
    const tauP = Math.min(1.5, perf.rollTau / auth);
    const kPhi = Math.min(5, 0.45 / tauP);
    const pMax = Math.max(0.05, rollRateAvailable(ac));
    const roll = clampN((kPhi * err) / pMax, -1, 1);
    inp.roll = roll;
    if (Math.abs(roll) > 0.3) this.rollSign = Math.sign(roll);
    else if (Math.abs(err) < 0.3) this.rollSign = 0;

    // Pitch: pull only with the lift vector (roughly) on target.
    const ce = Math.cos(err);
    const w = ce > 0 ? ce * ce : 0;
    inp.pitch = clampN(stickForG(ac, nDes) * w, -1, 1);
  }

  /* ───────────────────────────── throttle ───────────────────────────── */

  private throttleLoop(ac: AircraftEntity, dt: number): void {
    const it = this.intent;
    const inp = ac.input;
    if (this.thrI < 0) this.thrI = Math.min(AB_DETENT, inp.throttle);
    if (it.throttle >= 0) {
      inp.throttle = clampN(it.throttle, 0, 1);
      this.thrI = Math.min(AB_DETENT, inp.throttle);
      inp.airbrake = it.brake;
      return;
    }
    const err = it.speed - ac.flight.tas;
    const maxT = it.allowAb ? 1 : AB_DETENT;
    this.thrI = clampN(this.thrI + KI_THR * err * dt, 0.03, AB_DETENT);
    let t = this.thrI + KP_THR * err;
    t = clampN(t, 0, maxT);
    inp.throttle = t;
    inp.airbrake = it.brake || (it.allowBrake && err < -30 && t < 0.1);
  }
}
