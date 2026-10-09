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
 *  vertical   competent pilots (skill ≥ ~0.45, pilot difficulty and up) also use the vertical:
 *             OBLIQUE turns in the rate fight (nose-high when fast: gravity tightens the turn and
 *             bleeds speed toward the corner; nose-low when slow: gravity gives it back); an
 *             IMMELMANN (half loop, roll out on top) to reverse after a head-on pass instead of a
 *             flat turn; a full LOOP (skill ≥ ~0.55) against an attacker closing too fast behind
 *             (it overshoots underneath) or to kill our own overshoot on a much slower bandit. A loop
 *             or Immelmann is committed (`Bfm.committed`) and flown in the vertical plane of entry
 *             with full afterburner and full g; it needs speed above the corner and height above
 *             the hard deck to start, and is abandoned if the jet runs out of either on the way up.
 *             Rookies keep fighting flat.
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
const _vp = new Vector3();

/** Minimum skill level for the oblique turns, the Immelmann and the loop. */
export const VERTICAL_SKILL = { oblique: 0.4, immelmann: 0.45, loop: 0.55 } as const;
/** Height above the hard deck a loop (its bottom comes back to the entry height) / Immelmann needs (m). */
const LOOP_MARGIN = 1_200;
const IMMELMANN_MARGIN = 600;
/** After a vertical play (or a decision not to fly one) the next one waits this long (s). */
const VERTICAL_COOLDOWN = 8;

type VerticalKind = 'loop' | 'immelmann';

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
  /**
   * A committed loop / Immelmann: the horizontal entry direction, the pitch-up axis of its vertical
   * plane, how far it has got (climbed past 60°, over the top heading the other way, rolling out).
   */
  private vert: { kind: VerticalKind; entry: Vector3; axis: Vector3; climbed: boolean; over: boolean; rollout: boolean; until: number } | null = null;
  private nextVertical = 0;
  /** Loops / Immelmanns started (tests, debug). */
  readonly verticalCount: Record<VerticalKind, number> = { loop: 0, immelmann: 0 };

  /** In a loop or Immelmann: the brain keeps its hands off (no extend at the slow top of it). */
  get committed(): boolean {
    return this.vert !== null;
  }

  /** Start a loop / Immelmann in the vertical plane of the current flight path. */
  private startVertical(kind: VerticalKind, c: TickCtx): void {
    const v = c.ac.velocity;
    const entry = new Vector3(v.x, 0, v.z);
    if (entry.lengthSq() < 1) return;
    entry.normalize();
    // rotating `entry` about entry × up by +θ pitches it up
    const axis = new Vector3().crossVectors(entry, new Vector3(0, 1, 0)).normalize();
    this.vert = { kind, entry, axis, climbed: false, over: false, rollout: false, until: c.now + 45 };
    this.verticalCount[kind]++;
  }

  /**
   * Take the vertical at this opportunity? The situation (speed, height, geometry) is checked by the
   * caller; skill decides how often it's seen and taken: from ~30 % just above `minLevel` to always
   * 0.2 above it (a veteran always does). Decided once per opportunity (then a cooldown).
   */
  private choose(c: TickCtx, minLevel: number): boolean {
    if (c.now < this.nextVertical || c.skill.level < minLevel) return false;
    this.nextVertical = c.now + VERTICAL_COOLDOWN;
    return c.rng() < 0.3 + ((c.skill.level - minLevel) / 0.2) * 0.7;
  }

  /**
   * Fly the committed loop / Immelmann: full afterburner, full g, the nose pulled round in the
   * vertical plane of entry. An Immelmann rolls upright once over the top; a loop carries on round.
   * Returns false when the manoeuvre is over (or abandoned) and normal BFM takes over.
   */
  private flyVertical(c: TickCtx): boolean {
    const v = this.vert!;
    const { ac, it, skill, now } = c;
    const perf = AIRCRAFT_PERF[ac.type];
    const V = Math.max(1, ac.velocity.length());
    _vh.copy(ac.velocity).multiplyScalar(1 / V);
    const gamma = Math.asin(clampN(_vh.y, -1, 1));
    const h = Math.hypot(_vh.x, _vh.z);
    const along = h > 0.17 ? (_vh.x * v.entry.x + _vh.z * v.entry.z) / h : 0;
    if (gamma > 60 * DEG) v.climbed = true;
    if (v.climbed && along < -0.3) v.over = true;
    const deck = HARD_DECK + skill.minAgl;
    const end = () => {
      this.vert = null;
      this.nextVertical = now + VERTICAL_COOLDOWN;
      return false;
    };
    if (now > v.until) return end();
    // ran out of speed on the way up: let the nose fall (normal BFM's energy rules)
    if (!v.over && gamma > 0 && ac.flight.ias < perf.cornerSpeed * 0.4) return end();
    // never carry a loop down through the hard deck
    if (ac.flight.agl < deck && gamma < -10 * DEG) return end();
    if (v.kind === 'immelmann' && v.over && gamma < 25 * DEG) v.rollout = true;
    if (v.rollout) {
      _bf.set(0, 1, 0).applyQuaternion(ac.quaternion);
      if (_bf.y > 0.8) return end();
      // level, the other way: the autopilot rolls upright to get there
      it.dir.copy(v.entry).multiplyScalar(-1);
    } else {
      if (v.kind === 'loop' && v.over && gamma > -15 * DEG && gamma < 30 * DEG && _bf.set(0, 1, 0).applyQuaternion(ac.quaternion).y > 0.5) return end();
      // pull: the flight path in the plane, rotated 80° further round
      _vp.copy(_vh).addScaledVector(v.axis, -_vh.dot(v.axis));
      if (_vp.lengthSq() < 1e-4) _vp.copy(v.entry);
      _vp.normalize().applyAxisAngle(v.axis, 80 * DEG);
      it.dir.copy(_vp);
    }
    it.gMax = skill.maxG;
    it.gain = 3;
    it.throttle = 1;
    it.allowInverted = true;
    it.track = false;
    this.mode = v.rollout ? 'immelmann-rollout' : v.kind;
    return true;
  }

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

    /* ── vertical: a loop / Immelmann in progress ── */
    if (this.vert && this.flyVertical(c)) return 'BFM';
    const deck = HARD_DECK + skill.minAgl;
    const fast = ias > corner * 1.05;

    /* ── defensive: bandit at our six with its nose on us ── */
    // an attacker closing fast from 0.6–3 km: pull a loop and let it overshoot underneath
    if (b.fighter && banditAta < 35 * DEG && ata > 100 * DEG && R > 600 && R < 3_000 && vc > 40 && fast && agl > deck + LOOP_MARGIN && this.choose(c, VERTICAL_SKILL.loop)) {
      this.startVertical('loop', c);
      if (this.vert && this.flyVertical(c)) return 'BFM';
    }
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

    // just past a head-on pass, the bandit behind us going the other way: reverse in the vertical
    // (Immelmann) instead of a flat turn — we stay over its track and arrive above and behind it
    if (ata > 110 * DEG && banditAta > 90 * DEG && R > 400 && R < 3_000 && fast && agl > deck + IMMELMANN_MARGIN && this.choose(c, VERTICAL_SKILL.immelmann)) {
      this.startVertical('immelmann', c);
      if (this.vert && this.flyVertical(c)) return 'BFM';
    }
    // closing far too fast on a much slower bandit ahead (a drone, a helicopter, a jet out of
    // energy): a loop kills the closure, it flies on under us. Against a jet at fighting speed
    // the lag pursuit / high yo-yo below keeps the gun solution instead
    if (overshoot && vc > 150 && b.vel.length() < 0.6 * V && ata < 30 * DEG && fast && agl > deck + LOOP_MARGIN && this.choose(c, VERTICAL_SKILL.loop)) {
      this.startVertical('loop', c);
      if (this.vert && this.flyVertical(c)) return 'BFM';
    }

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
    // oblique (semi-vertical) turns while pulling for the nose: nose-high when fast (gravity
    // tightens the turn and trades speed for height), nose-low when slow (gravity gives it back)
    // (not with the bandit far below / above: then the pull is straight down / up at it anyway)
    else if (ata > 45 * DEG && skill.level >= VERTICAL_SKILL.oblique && !tvcSlowFight) {
      const e = ias / corner;
      if (e > 1.05 && it.dir.y > -0.5) {
        it.dir.y = Math.max(it.dir.y + 0.35, 0.25 + clampN(e - 1.05, 0, 0.3));
        this.mode = 'oblique-high';
      } else if (e < 0.85 && it.dir.y < 0.5 && agl > deck + 500) {
        it.dir.y = Math.min(it.dir.y - 0.25, -0.2);
        this.mode = 'oblique-low';
      }
    }
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
