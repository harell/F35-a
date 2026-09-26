/**
 * F35-A — electronic-warfare helpers shared by missiles, fighter radars and SAM radars:
 * ground clutter, Doppler-notch depth, sustained-notch track loss, and the countermeasure
 * effectiveness factor (difficulty for the human player, pilot skill for AI defenders).
 *
 * Model (one continuous function everywhere — no altitude switches):
 *   clutter  = max(c_look, c_graze) · (1 − smoothstep(AGL, 2,500 m, 6,000 m) · (1 − c_look))
 *              c_look  = smoothstep(sin depression, 0, 0.15)     (look-down: ground behind the target)
 *              c_graze = 1 − smoothstep(sin elevation, 0.015, 0.07)  (look-up radar whose beam still
 *                        grazes the ground: a target low relative to its range — ~500 m at 16 km,
 *                        ~150 m at 5 km — sits in the clutter; the same height close in does not)
 *   beam     = 1 − smoothstep(|v_radial|, 0.3 W, W)              (W = notch width ≈ 45 m/s)
 *   depth    = beam × clutter                                     (0..1)
 * A radar loses a track only after the target has been held in the notch long enough:
 *   accum += depth·dt (decays 0.7/s outside the notch), lost when accum ≥ need,
 *   need  = (0.8 + 2.6·notchResistance) · U(0.8, 1.25) / k_cm, and with probability
 *           0.55·notchResistance / k_cm the tracker is not fooled at all (need = ∞) — a
 *           sustained notch is strong but never a guaranteed win.
 */
import type { Vector3 } from 'three';
import { clamp, smoothstep } from '../../core/math';
import type { Team } from '../../core/types';
import type { AircraftEntity, AnyEntity } from '../entities';
import type { CombatCtx } from './context';
import { playerTeam } from './context';

/** Doppler notch half-width (m/s radial velocity). */
export const NOTCH_WIDTH = 45;
/** Notch accumulator decay outside the notch (per second). */
export const NOTCH_DECAY = 0.7;

/** Ground-clutter factor 0..1 behind a target seen from `radarPos`. */
export function clutterFactor(ctx: CombatCtx, radarPos: Vector3, target: Vector3): number {
  const dx = target.x - radarPos.x;
  const dy = target.y - radarPos.y;
  const dz = target.z - radarPos.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 1) return 0;
  const sinEl = dy / dist;
  const cLook = smoothstep(-sinEl, 0, 0.15);
  const cGraze = 1 - smoothstep(sinEl, 0.015, 0.07);
  const agl = target.y - ctx.world.terrain.surfaceHeightAt(target.x, target.z);
  const high = smoothstep(agl, 2_500, 6_000) * (1 - cLook);
  return Math.max(cLook, cGraze) * (1 - high);
}

/** 1 when the target's radial velocity (relative to the ground) is ~0 as seen from radarPos. */
export function beamFactor(radarPos: Vector3, target: AircraftEntity, width = NOTCH_WIDTH): number {
  const dx = target.position.x - radarPos.x;
  const dy = target.position.y - radarPos.y;
  const dz = target.position.z - radarPos.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 1) return 0;
  const vr = Math.abs((target.velocity.x * dx + target.velocity.y * dy + target.velocity.z * dz) / dist);
  return 1 - smoothstep(vr, 0.3 * width, width);
}

/** Radial speed (m/s, absolute) of the target as seen from radarPos. */
export function radialSpeed(radarPos: Vector3, target: AircraftEntity): number {
  const dx = target.position.x - radarPos.x;
  const dy = target.position.y - radarPos.y;
  const dz = target.position.z - radarPos.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist < 1) return 0;
  return Math.abs((target.velocity.x * dx + target.velocity.y * dy + target.velocity.z * dz) / dist);
}

/** Doppler-notch depth 0..1 of `target` as seen by a radar at `radarPos` (beam × clutter). */
export function notchDepth(ctx: CombatCtx, radarPos: Vector3, target: AircraftEntity): number {
  const b = beamFactor(radarPos, target);
  if (b <= 0) return 0;
  return b * clutterFactor(ctx, radarPos, target.position);
}

/**
 * Defensive skill 0..1 of an AI pilot (reads the AI brain's derived skill when available;
 * otherwise blends the spawn skill with the difficulty like src/ai/skill.ts).
 */
export function defenderSkill(ctx: CombatCtx, ac: AircraftEntity): number {
  const ai = ac.ai as unknown as { skill?: { defense?: unknown; level?: unknown }; spawnSkill?: unknown } | null;
  if (ai) {
    const s = ai.skill;
    if (s && typeof s.defense === 'number') return clamp(s.defense, 0, 1);
    if (typeof ai.spawnSkill === 'number') {
      const sp = clamp(ai.spawnSkill, 0, 1);
      return ac.team === 'blue' ? clamp(0.45 + 0.5 * sp, 0.3, 0.95) : clamp(0.5 * sp + 0.5 * ctx.world.difficulty.aiSkill, 0.05, 1);
    }
  }
  return ac.team === playerTeam(ctx.world) ? 0.7 : ctx.world.difficulty.aiSkill;
}

/**
 * Countermeasure / notch effectiveness multiplier k for a defender against a weapon of
 * `attackerTeam`:
 *  - the human player: difficulty.countermeasureEffectiveness / enemyMissileSkill^0.6
 *    (recruit ≈ 2.3, pilot 1.37, veteran 1.0, ace 0.76)
 *  - AI pilots: their defensive skill, 0.3 + 0.9·skill (a recruit-level MiG ≈ 0.55, an ace ≈ 1.2),
 *    divided by √enemyMissileSkill when an enemy (red) missile is chasing a friendly AI.
 */
export function cmFactor(ctx: CombatCtx, attackerTeam: Team, target: AnyEntity): number {
  if (target.kind !== 'aircraft') return 1;
  const d = ctx.world.difficulty;
  const pTeam = playerTeam(ctx.world);
  if (target.isPlayer) return clamp(d.countermeasureEffectiveness / Math.pow(Math.max(0.3, d.enemyMissileSkill), 0.6), 0.3, 3.5);
  let k = 0.3 + 0.9 * defenderSkill(ctx, target);
  if (attackerTeam !== pTeam) k /= Math.sqrt(Math.max(0.3, d.enemyMissileSkill));
  return k;
}

/** Seconds of sustained notch a radar with `notchResistance` needs before losing the track. */
export function rollNotchNeed(ctx: CombatCtx, notchResistance: number, k: number): number {
  const kk = Math.max(0.2, k);
  if (ctx.rng() < clamp((0.55 * notchResistance) / kk, 0, 0.85)) return Infinity;
  return ((0.8 + 2.6 * notchResistance) * (0.8 + 0.45 * ctx.rng())) / kk;
}

/**
 * Advance a notch accumulator. Returns the new accumulated value (the caller compares it with
 * its `need`). Depth below 0.05 counts as out of the notch (decay).
 */
export function stepNotch(accum: number, depth: number, dt: number): number {
  if (depth > 0.05) return accum + depth * dt;
  return Math.max(0, accum - NOTCH_DECAY * dt);
}
