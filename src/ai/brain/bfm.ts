/**
 * F35-A — basic fighter manoeuvres (within-visual-range dogfight steering).
 *
 * Geometry each tick: range R, our ATA (nose/velocity to bandit), the bandit's aspect AA
 * (0 = we're at its six), its ATA on us, closure, our energy vs corner speed.
 *
 *  DEFENSIVE  bandit behind us with its nose on us → break turn into it (max g), jink out of
 *             plane inside gun range, pre-emptive flares vs IR shots (skilled pilots)
 *  pursuit    LEAD to close / for guns, PURE to point for a missile, LAG when closure is high
 *             and we'd overshoot (with a HIGH YO-YO out of plane), LOW YO-YO (dive inside the
 *             bandit's turn) when too slow to keep up
 *  energy     skilled pilots fly the corner (rate fight): throttle back / speed brake when fast,
 *             cap g when slow; thrust-vectoring Flankers (Su-35/Su-57) prefer slow, tight
 *             "radius" fights; rookies just pull max g with the burner on and bleed out
 */
import { Vector3 } from 'three';
import { AIRCRAFT_PERF } from '../../sim/flight/aircraftData';
import { specificExcessPower } from '../../sim/flight/performance';
import type { AircraftEntity } from '../../sim/entities';
import { angleBetween, aspectOf, clampN, closureRate, dirTo } from '../geom';
import type { Bandit } from './awareness';
import type { TickCtx } from './context';

const DEG = Math.PI / 180;

const _los = new Vector3();
const _vh = new Vector3();
const _p = new Vector3();
const _rel = new Vector3();
const _bf = new Vector3();

/** Load factor (g) the jet can sustain right now in afterburner (Ps ≈ 0), by bisection. */
export function sustainableG(ac: AircraftEntity, gMax: number): number {
  if (specificExcessPower(ac, gMax, true) >= 0) return gMax;
  let lo = 1;
  let hi = gMax;
  if (specificExcessPower(ac, lo, true) < 0) return 1;
  for (let i = 0; i < 6; i++) {
    const mid = 0.5 * (lo + hi);
    if (specificExcessPower(ac, mid, true) >= 0) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Height above ground below which dogfights stop going downhill (m). */
const HARD_DECK = 700;

/**
 * Energy & hard-deck rules applied to every close-in manoeuvre (BFM, guns, defensive break):
 *  - the slower the jet (vs corner speed), the less it may point its velocity upwards
 *    (no zoom climbs into a hover), and really slow jets go nose-low to regain speed;
 *  - below ~90 % corner, g is held near what the jet can sustain (skilled pilots early,
 *    everyone once really slow; thrust-vectoring slow fights get more slack);
 *  - below the hard deck the fight is not allowed to go further downhill.
 * `gunsOrTvc` loosens the g rule (committed gun track / TVC slow fight).
 */
export function applyEnergyLimits(c: TickCtx, gunsOrTvc: boolean): void {
  const { ac, it, skill } = c;
  const perf = AIRCRAFT_PERF[ac.type];
  const e = ac.flight.ias / perf.cornerSpeed;
  const maxY = clampN((e - 0.55) * 1.2, -0.05, 0.7);
  if (it.dir.y > maxY) it.dir.y = maxY;
  const deck = HARD_DECK + skill.minAgl;
  const agl = ac.flight.agl;
  if (agl < deck) it.dir.y = Math.max(it.dir.y, ((deck - agl) / deck) * 0.3);
  it.dir.normalize();
  if (e < 0.9 && (skill.energy > 0.4 || e < 0.6)) {
    const nSus = sustainableG(ac, it.gMax);
    const slack = gunsOrTvc ? 1.6 : 1.05 + 0.5 * clampN((e - 0.6) / 0.3, 0, 1);
    it.gMax = Math.max(2, Math.min(it.gMax, nSus * slack));
  }
}

export class Bfm {
  private jinkUntil = 0;
  private jinkUp = 1;
  private yoyo = 0;
  /** Last manoeuvre name (debug). */
  mode = '';

  run(c: TickCtx, b: Bandit): string {
    const { ac, it, skill, rng, now } = c;
    const perf = AIRCRAFT_PERF[ac.type];
    const pos = ac.position;
    const vel = ac.velocity;
    const V = Math.max(1, vel.length());
    _vh.copy(vel).multiplyScalar(1 / V);
    const R = dirTo(pos, b.pos, _los);
    const ata = Math.acos(clampN(_vh.dot(_los), -1, 1));
    const aa = aspectOf(b.pos, b.vel, pos);
    _rel.subVectors(pos, b.pos);
    _bf.set(0, 0, -1).applyQuaternion(b.ent.quaternion);
    const banditAta = angleBetween(_bf, _rel);
    const vc = closureRate(pos, vel, b.pos, b.vel);
    const ias = ac.flight.ias;
    const corner = perf.cornerSpeed;
    const energy = skill.energy;
    const agl = ac.flight.agl;
    it.gMax = skill.maxG;
    it.allowInverted = true;
    it.gain = 1.6 + 0.6 * skill.level;
    it.throttle = 1;

    /* ── defensive: bandit at our six with its nose on us ── */
    if (b.fighter && banditAta < 35 * DEG && ata > 100 * DEG && R < 5_000) {
      this.mode = 'break';
      _p.copy(_los);
      // keep the break roughly in the horizontal (don't dive into the ground / zoom out of energy)
      _p.y = clampN(_p.y, -0.35, 0.35);
      if (R < 1_500 && banditAta < 12 * DEG && skill.level > 0.3) {
        // guns jink: flip the out-of-plane component every 0.6–1.2 s
        if (now > this.jinkUntil) {
          this.jinkUntil = now + 0.6 + 0.6 * rng();
          this.jinkUp = rng() < 0.5 ? -1 : 1;
        }
        _p.y += 0.6 * this.jinkUp;
      }
      it.dir.copy(_p).normalize();
      it.gain = 3;
      it.throttle = ias > corner * 1.15 && energy > 0.4 ? 0.85 : 1;
      if (R < 4_000 && banditAta < 20 * DEG && skill.defense > 0.4) c.flares(1.4);
      applyEnergyLimits(c, false);
      return 'DEFENSIVE';
    }

    /* ── offensive / neutral ── */
    const tLead = clampN(R / Math.max(250, V), 0.2, 1.6);
    const overshoot = aa < 80 * DEG && R < 2_500 && vc > 50 + 0.03 * R;
    const slow = ias < corner * 0.7;
    const tvcSlowFight = perf.tvc && skill.level > 0.35 && R < 2_500 && aa > 45 * DEG;

    if (R > 3_500) {
      this.mode = 'lead';
      _p.copy(b.pos).addScaledVector(b.vel, tLead);
    } else if (overshoot) {
      this.mode = 'lag';
      const sp = b.vel.length();
      const lag = clampN(R * 0.35, 150, 700);
      _p.copy(b.pos);
      if (sp > 1) _p.addScaledVector(b.vel, -lag / sp);
      if (energy > 0.35 && agl > 800) this.yoyo = 1;
      if (vc > 110 && energy > 0.4) {
        it.throttle = 0.15;
        it.brake = true;
      } else it.throttle = energy > 0.4 ? 0.6 : 1;
    } else if (slow && energy > 0.4 && agl > 1_500 && !perf.tvc) {
      this.mode = 'lowyoyo';
      _p.copy(b.pos).addScaledVector(b.vel, tLead);
      this.yoyo = -1;
    } else {
      // rate fight: lead for the guns when close to the nose, pure pursuit otherwise
      this.mode = ata < 60 * DEG ? 'lead' : 'pure';
      _p.copy(b.pos);
      if (ata < 60 * DEG) _p.addScaledVector(b.vel, tLead * 0.6);
      this.yoyo = 0;
    }
    if (this.mode !== 'lag' && this.mode !== 'lowyoyo') this.yoyo = 0;

    it.dir.subVectors(_p, pos).normalize();
    if (this.yoyo > 0) it.dir.y += 0.35;
    else if (this.yoyo < 0) it.dir.y -= 0.3;
    it.dir.normalize();
    it.track = R < 3_000 && ata < 50 * DEG;

    /* ── energy management ── */
    if (energy > 0.5) {
      if (tvcSlowFight) {
        // Flanker with TVC: slow, tight radius fight
        it.throttle = ias > corner * 0.85 ? 0.35 : 1;
      } else if (ias > corner * 1.3 && ata > 40 * DEG && this.mode !== 'lag') {
        it.throttle = 0.6; // bleed down to the corner for max turn rate
      }
    }
    applyEnergyLimits(c, tvcSlowFight);
    return 'BFM';
  }
}
