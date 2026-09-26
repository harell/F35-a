/**
 * F35-A — missile defence (reaction to MAWS / RWR launch warnings).
 *
 *  Radar missiles  NOTCH: turn to put the radar (the missile's own seeker for active missiles,
 *                  the illuminating launcher for semi-active/command ones) on the beam, dive for
 *                  ground clutter (below ~1,500 m AGL the Doppler notch works best), chaff while
 *                  beaming. Long shots from behind: DRAG (run cold, AB, descend) to defeat the
 *                  missile kinematically.
 *  IR missiles     beam the missile, chop the throttle (AB triples the IR signature), flare
 *                  salvos once the seeker can be decoyed (inside ~4 km).
 *  Last ditch      at ~2–3 s time-to-impact: max-g break perpendicular to the missile's flight
 *                  path + chaff and flares.
 * Skill scales everything: notch heading accuracy, whether/when to dive, countermeasure timing
 * (rookies dump them early and run dry), whether the last-ditch break happens at all.
 */
import { Vector3 } from 'three';
import type { IncomingMissile } from '../../sim/entities';
import { AB_DETENT } from '../../core/types';
import { clampN, dirWithElevation, rotateHorizontal } from '../geom';
import type { AnyMissile, TickCtx } from './context';

const _beam = new Vector3();
const _tmp = new Vector3();

export class MissileDefense {
  private missileId = -1;
  private side = 0;
  private beamErr = 0;
  private lastDitch = false;
  private ditchSide = 0;
  private dragMode = false;
  /** Pilot gets the last-ditch timing right (rolled per missile). */
  private ditchOk = true;

  /** Currently defending against this missile id (−1 = none). */
  get activeMissile(): number {
    return this.missileId;
  }

  reset(): void {
    this.missileId = -1;
  }

  /**
   * Fly the defence against `inc`. Returns the state label, or null when the missile is gone.
   */
  run(c: TickCtx, inc: IncomingMissile): string | null {
    const { ac, world, it, skill, rng } = c;
    const m = world.getEntity(inc.missileId) as AnyMissile | null;
    if (!m || !m.alive || m.kind !== 'missile') return null;
    const def = skill.defense;
    if (inc.missileId !== this.missileId) {
      this.missileId = inc.missileId;
      this.side = 0;
      this.ditchSide = 0;
      this.lastDitch = false;
      this.dragMode = false;
      this.beamErr = (rng() - 0.5) * 2 * (1 - def) * 0.7;
      this.ditchOk = rng() < 0.35 + 0.65 * def;
    }
    const radar = inc.guidance === 'radar';
    const pos = ac.position;
    const vel = ac.velocity;
    const V = Math.max(1, vel.length());

    // Radar to notch against: the illuminator for semi-active / command guidance.
    let ref = m.position;
    if (radar && m.def.guidance !== 'active_radar' && m.guiderId !== undefined) {
      const g = world.getEntity(m.guiderId);
      if (g && g.alive) ref = g.position;
    }
    let lx = pos.x - ref.x;
    let lz = pos.z - ref.z;
    const ll = Math.hypot(lx, lz) || 1;
    lx /= ll;
    lz /= ll;

    const tti = inc.timeToImpact;
    const d = inc.distance;
    const agl = ac.flight.agl;

    /* ── last ditch ── */
    const ditchT = (radar ? 2.0 : 1.5) + 1.2 * def;
    if (!this.lastDitch && this.ditchOk && tti < ditchT && d < 4_000) this.lastDitch = true;
    if (this.lastDitch) {
      // break perpendicular to the missile's flight path, on the side we're already turning
      const mv = m.velocity;
      const mh = Math.hypot(mv.x, mv.z) || 1;
      const px = -mv.z / mh;
      const pz = mv.x / mh;
      if (this.ditchSide === 0) this.ditchSide = px * vel.x + pz * vel.z >= 0 ? 1 : -1;
      _beam.set(px * this.ditchSide, 0, pz * this.ditchSide);
      dirWithElevation(_beam, agl > 900 ? -0.25 : 0.05, it.dir);
      it.gMax = skill.maxG;
      it.gain = 3;
      it.allowInverted = false;
      it.throttle = radar ? 1 : 0.35;
      c.flares(0.3);
      if (radar) c.chaff(0.3);
      return 'DEFENSIVE';
    }

    /* ── radar missile ── */
    if (radar) {
      // missile coming from behind at long range: drag it out of energy (skilled pilots)
      _tmp.subVectors(pos, m.position);
      const fromBehind = _tmp.dot(vel) > 0.5 * _tmp.length() * V;
      if (!this.dragMode && d > 12_000 && fromBehind && def > 0.55) this.dragMode = true;
      if (this.dragMode && d < 7_000) this.dragMode = false;
      if (this.dragMode) {
        _beam.set(lx, 0, lz);
        dirWithElevation(_beam, agl > 1_200 ? -0.12 : 0, it.dir);
        it.throttle = 1;
        it.gMax = Math.min(5, skill.maxG);
        it.gain = 1.4;
        return 'DEFENSIVE';
      }
      this.beamHeading(lx, lz, vel);
      const gamma = agl > 1_300 && def > 0.3 ? -0.18 - 0.12 * def : agl < skill.minAgl * 2.5 ? 0.02 : 0;
      dirWithElevation(_beam, gamma, it.dir);
      it.gMax = Math.min(skill.maxG, 7.5);
      it.gain = 1.5;
      it.allowAb = true;
      it.speed = Math.max(300, V);
      // chaff: skilled pilots dispense while in the beam and inside the missile's seeker range;
      // rookies start early and keep pumping it out
      _tmp.set(vel.x, 0, vel.z);
      const radial = Math.abs(_tmp.x * lx + _tmp.z * lz);
      if (def > 0.5) {
        if (d < 12_000 && radial < 90) c.chaff(1.3 - 0.4 * def);
      } else if (d < 22_000) c.chaff(0.9 + rng() * 0.6);
      return 'NOTCH';
    }

    /* ── IR missile ── */
    this.beamHeading(lx, lz, vel);
    dirWithElevation(_beam, agl > 1_000 ? -0.08 : 0.02, it.dir);
    it.gMax = Math.min(skill.maxG, 7);
    it.gain = 1.6;
    // kill the afterburner plume; skilled pilots chop to idle close in
    it.throttle = d < 6_000 && def > 0.4 ? 0.2 : Math.min(AB_DETENT - 0.05, ac.input.throttle);
    const flareStart = def > 0.5 ? 4_500 : 7_500;
    if (d < flareStart) c.flares(clampN(0.9 - 0.3 * def, 0.55, 0.9));
    return 'DEFENSIVE';
  }

  /** Beam heading (⟂ to the radar LOS), side latched, with the pilot's heading error. */
  private beamHeading(lx: number, lz: number, vel: Vector3): void {
    const bx = -lz;
    const bz = lx;
    if (this.side === 0) this.side = bx * vel.x + bz * vel.z >= 0 ? 1 : -1;
    _beam.set(bx * this.side, 0, bz * this.side);
    if (this.beamErr !== 0) rotateHorizontal(_beam, this.beamErr, _beam);
  }
}
