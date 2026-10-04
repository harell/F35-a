/**
 * F35-A — SAM end-game: per-missile miss distance (and with it the proximity-fuze outcome).
 *
 * Before this model every SAM round flew perfect proportional navigation into the jet, so the
 * proximity fuze always fired at ~0 m: a non-defending target took 100 % of the missiles and one
 * chaff roll decided a whole salvo. Now each missile gets its own end-game miss distance, rolled
 * one step before closest approach and applied as a lateral offset of the missile (perpendicular
 * to the relative velocity, so the time of closest approach is unchanged; far too late for the
 * autopilot to take it out). The fuze in weapons/flight.ts then decides the outcome as usual:
 * no detonation beyond fuze reach (a miss), otherwise a proximity burst whose blast damage falls
 * off with the miss distance (so hits are no longer all full-warhead direct hits).
 *
 *   miss ~ Rayleigh(σ),   σ = reach · s_diff · F_man · F_track · e^(0.3·z)
 *   reach   = fuseRadius · fuzeScale(difficulty) + target.radius / 2       (same as flight.ts)
 *   s_diff  from the no-defence Pk table (Pk₀ = 1 − e^(−1/(2 s²)))  recruit … ace
 *   F_man   = 1 + 0.16 · max(0, a_T/g − 1) · (0.35 + 0.65 · sin aspect) · 25 / missile maxG
 *             (target lateral acceleration, smoothed over the last ~0.8 s, as seen across the LOS)
 *   F_track = 1 + 0.9 · notch (radar sites: smoothed Doppler-notch depth of the target as seen
 *             by the fire-control radar) + 0.8 · chaff_in_gate · (0.2 + 0.8 · beam)
 *   z       = √ρ · z_salvo + √(1 − ρ) · z_missile, ρ = 0.45  (correlated salvo term: rounds of one
 *             salvo share the fire-control radar's error, but are not identical)
 * Chaff: in addition every radar-guided round rolls its own seduction when chaff is in the
 * fire-control radar's gate (recent chaff exposure, beam geometry, k_cm, chaff resistance, the
 * same correlated z) — a seduced round's final correction walks onto the chaff (≥ 35 m miss).
 */
import { Vector3 } from 'three';
import { G, clamp } from '../../core/math';
import type { AircraftEntity, SamSiteEntity } from '../entities';
import type { CombatCtx } from '../weapons/context';
import { gaussian } from '../weapons/context';
import { cmFactor, notchDepth, radialSpeed } from '../weapons/ew';
import { isCombatMissile, type CombatMissile } from '../weapons/missile';

/** Probability that an undefended, non-manoeuvring jet is hit (fuzed on), per difficulty. */
export const ENDGAME_PK: Record<string, number> = { recruit: 0.66, pilot: 0.8, veteran: 0.87, ace: 0.93 };
/** Salvo correlation of the end-game error (0 = independent rounds, 1 = identical). */
export const SALVO_RHO = 0.45;
/** Log-sigma of the per-round miss-distance multiplier. */
const Z_SIGMA = 0.3;
/** Target-acceleration smoothing time constant (s). */
const ACC_TAU = 0.8;
/** Notch smoothing time constant (s). */
const NOTCH_TAU = 1.2;

/** Per-missile end-game bookkeeping (allocated once at launch). */
export interface EndgameState {
  /** Correlated salvo / per-round error sample (standard normal). */
  z: number;
  /** Smoothed target lateral acceleration (m/s²) and the previous target velocity. */
  acc: number;
  prevVel: Vector3;
  hasPrev: boolean;
  /** Smoothed Doppler-notch depth of the target at the guiding radar. */
  notch: number;
  /** Miss distance already applied (−1 = not yet). */
  applied: number;
  /** Rolled seduction onto chaff. */
  seduced: boolean;
}

const states = new WeakMap<CombatMissile, EndgameState>();
const _r = new Vector3();
const _v = new Vector3();
const _c = new Vector3();
const _a = new Vector3();

/** No-defence scale s (σ / reach) for a difficulty id / enemy missile skill. */
export function difficultyScale(ctx: CombatCtx): number {
  const d = ctx.world.difficulty;
  let pk = ENDGAME_PK[d.id as string];
  if (pk === undefined) pk = clamp(0.62 + 0.4 * (d.enemyMissileSkill - 0.55), 0.55, 0.93);
  return 1 / Math.sqrt(2 * Math.log(1 / (1 - pk)));
}

/** Fuze reach against an aircraft exactly as weapons/flight.ts computes it (m). */
export function fuzeReach(ctx: CombatCtx, m: CombatMissile, ac: AircraftEntity): number {
  let fuse = m.cdef.fuseRadius;
  if (m.team !== (ctx.world.player?.team ?? 'blue')) fuse *= clamp(0.75 + 0.25 * ctx.world.difficulty.enemyMissileSkill, 0.8, 1.1);
  return fuse + ac.radius * 0.5;
}

/** Register a freshly launched SAM round; `salvoZ` is the salvo's shared error sample. */
export function registerRound(ctx: CombatCtx, m: CombatMissile, salvoZ: number): void {
  const z = Math.sqrt(SALVO_RHO) * salvoZ + Math.sqrt(1 - SALVO_RHO) * gaussian(ctx.rng);
  states.set(m, { z, acc: 0, prevVel: new Vector3(), hasPrev: false, notch: 0, applied: -1, seduced: false });
}

/** End-game state of a round (tests / debug). */
export function endgameState(m: CombatMissile): EndgameState | undefined {
  return states.get(m);
}

/**
 * σ of the miss distance (m) for this round against `ac` now. `chaffGate` 0..1 = chaff in the
 * fire-control radar's gate (0 for IR rounds).
 */
export function missSigma(ctx: CombatCtx, m: CombatMissile, ac: AircraftEntity, st: EndgameState, sinAspect: number, chaffGate: number): number {
  const reach = fuzeReach(ctx, m, ac);
  const gT = st.acc / G;
  const fMan = 1 + 0.16 * Math.max(0, gT - 1) * (0.35 + 0.65 * sinAspect) * (25 / Math.max(10, m.cdef.maxG));
  const radarGuided = m.cdef.guidance !== 'ir';
  const fTrack = radarGuided ? 1 + 0.9 * st.notch + 0.8 * chaffGate : 1;
  return reach * difficultyScale(ctx) * fMan * fTrack * Math.exp(Z_SIGMA * st.z);
}

/**
 * Step the end-game model of every round `site` is guiding (runs before weapons/flight.ts moves
 * the missiles this step). `chaff` = the site radar's chaff bookkeeping. `list` = the rounds to step
 * (default the radar-guided ones; the AD boat's SA-18 rounds are kept apart, SamSystem manpads).
 */
export function updateEndgame(
  ctx: CombatCtx,
  site: SamSiteEntity,
  chaff: { chaffExposure: number; lastChaffRoll: number },
  dt: number,
  list: number[] = site.guidedMissiles,
): void {
  for (let i = 0; i < list.length; i++) {
    const m = ctx.world.getEntity(list[i]);
    if (!m || !m.alive || m.kind !== 'missile' || !isCombatMissile(m)) continue;
    const st = states.get(m);
    if (!st || st.applied >= 0) continue;
    const t = ctx.world.getEntity(m.targetId);
    if (!t || !t.alive || t.kind !== 'aircraft' || m.trackBroken || m.decoyed) continue;
    stepRound(ctx, site, m, t, st, chaff, dt);
  }
}

function stepRound(
  ctx: CombatCtx,
  site: SamSiteEntity,
  m: CombatMissile,
  t: AircraftEntity,
  st: EndgameState,
  chaff: { chaffExposure: number; lastChaffRoll: number },
  dt: number,
): void {
  // relative geometry in the fuze's frame (flight.ts sweeps the target from pos − vel·dt)
  _r.subVectors(m.position, t.position).addScaledVector(t.velocity, dt);
  _v.subVectors(m.velocity, t.velocity);
  const vv = _v.lengthSq();
  const range = _r.length();
  // target lateral acceleration across the line of sight (what the missile has to follow)
  if (st.hasPrev && dt > 0) {
    _a.subVectors(t.velocity, st.prevVel).divideScalar(dt); // kinematic: 0 in level flight
    if (range > 1) _a.addScaledVector(_r, -_a.dot(_r) / (range * range));
    const k = 1 - Math.exp(-dt / ACC_TAU);
    st.acc += (Math.min(_a.length(), 12 * G) - st.acc) * k;
  }
  st.prevVel.copy(t.velocity);
  st.hasPrev = true;
  const radarGuided = m.cdef.guidance !== 'ir';
  if (radarGuided) {
    const k = 1 - Math.exp(-dt / NOTCH_TAU);
    st.notch += (notchDepth(ctx, site.position, t) - st.notch) * k;
  }
  if (vv < 1) return;
  const tca = -_r.dot(_v) / vv;
  if (tca < 0) return;
  const vrel = Math.sqrt(vv);
  const reach = fuzeReach(ctx, m, t);
  if (tca > Math.max(2.5 * dt, (0.5 * reach) / vrel)) return;
  if (m.age + dt < m.cdef.armTime) return;

  // ── roll the end-game miss distance of this round ──
  const vs = t.velocity.length();
  _c.copy(_r).divideScalar(Math.max(1, range));
  const cosA = vs > 1 ? t.velocity.dot(_c) / vs : 1;
  const sinAspect = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  let gate = 0;
  let beam = 0;
  if (radarGuided) {
    // chaff in the fire-control radar's range/Doppler gate: recent exposure (5 s memory); only a
    // beaming target makes the (near-stationary) chaff Doppler-indistinguishable from the jet
    const age = ctx.time - chaff.lastChaffRoll;
    gate = age < 4 ? clamp(chaff.chaffExposure * Math.exp(-age / 2.5), 0, 1.5) / 1.5 : 0;
    beam = 1 - clamp((radialSpeed(site.position, t) - 40) / 160, 0, 1);
  }
  const sigma = missSigma(ctx, m, t, st, sinAspect, gate * (0.2 + 0.8 * beam));
  let miss = sigma * Math.sqrt(-2 * Math.log(Math.max(1e-9, 1 - ctx.rng())));
  if (gate > 0) {
    // per-round seduction: this round's final correction walks onto the chaff cloud
    const kcm = cmFactor(ctx, m.team, t);
    const p = clamp(0.4 * gate * (0.15 + 0.85 * beam) * (1 - m.cdef.chaffResistance) * Math.pow(kcm, 1.2) * Math.exp(0.35 * st.z), 0, 0.85);
    if (ctx.rng() < p) {
      st.seduced = true;
      miss = Math.max(miss, reach + 20 + 60 * ctx.rng());
    }
  }
  applyMiss(ctx, m, tca, miss);
  st.applied = miss;
}

/** Offset the missile so its closest approach to the target becomes √(natural² + miss²). */
function applyMiss(ctx: CombatCtx, m: CombatMissile, tca: number, miss: number): void {
  _c.copy(_r).addScaledVector(_v, tca); // current closest-approach vector (⊥ relative velocity)
  const natural = _c.length();
  const want = Math.sqrt(natural * natural + miss * miss);
  if (natural > 0.5) _c.divideScalar(natural);
  else {
    // no natural miss: pick a random direction perpendicular to the relative velocity
    const vl = _v.length();
    _a.set(ctx.rng() - 0.5, ctx.rng() - 0.5, ctx.rng() - 0.5);
    _a.addScaledVector(_v, -_a.dot(_v) / (vl * vl));
    const l = _a.length();
    if (l < 1e-6) return;
    _c.copy(_a).divideScalar(l);
  }
  m.position.addScaledVector(_c, want - natural);
}
