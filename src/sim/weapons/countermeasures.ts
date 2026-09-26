/**
 * F35-A — countermeasures: flare & chaff dispense programs, decoy physics and seduction.
 *
 * Programs: the rising edge of input.flare releases a salvo of 2 flares 0.15 s apart; holding
 * the button repeats the salvo every 0.6 s. Chaff works the same way. AI uses the same inputs.
 *
 * Seduction is rolled once per salvo per missile (at release):
 *  - flares vs IR missiles: flare/target IR ratio, beam geometry, range, flareResistance,
 *    difficulty (countermeasureEffectiveness vs the player, enemyMissileSkill for enemy missiles)
 *  - chaff vs radar-guided missiles: only really works together with a beam (Doppler-notch)
 *    manoeuvre; chaffResistance; the illuminating radar is seduced too.
 */
import { Vector3 } from 'three';
import { G, clamp } from '../../core/math';
import { DecoyEntity, type AircraftEntity } from '../entities';
import type { AcCombatState, CombatCtx } from './context';
import { breakGuiderTrack, cmScale, inGimbal, notchDepth } from './guidance';
import { isCombatMissile, type CombatMissile } from './missile';
import { irIntensity } from '../sensors/signatures';

export const FLARE_LIFE = 3.5;
export const CHAFF_LIFE = 5;
/** Flare IR intensity (same scale as irIntensity: 1 = fighter at MIL, tail aspect). */
export const FLARE_INTENSITY = 2.6;
/** Chaff bloom radar return (m²). */
export const CHAFF_RCS = 40;

const SALVO = 2;
const SALVO_GAP = 0.15;
const REPEAT = 0.6;

const _v = new Vector3();
const _w = new Vector3();

/** Run an aircraft's flare/chaff programs for this step. */
export function updateCountermeasurePrograms(ctx: CombatCtx, ac: AircraftEntity, st: AcCombatState, dt: number): void {
  const inp = ac.input;
  // ── flares ──
  if (inp.flare && !st.prevFlare) {
    st.flareLeft = SALVO;
    st.flareTimer = 0;
    st.flareRepeat = REPEAT;
  } else if (inp.flare) {
    st.flareRepeat -= dt;
    if (st.flareRepeat <= 0 && st.flareLeft === 0) {
      st.flareLeft = SALVO;
      st.flareTimer = 0;
      st.flareRepeat = REPEAT;
    }
  }
  if (st.flareLeft > 0) {
    st.flareTimer -= dt;
    if (st.flareTimer <= 0) {
      st.flareLeft = ac.flares > 0 ? st.flareLeft - 1 : 0;
      st.flareTimer = SALVO_GAP;
      if (ac.flares > 0) dispense(ctx, ac, 'flare', st.flareLeft === SALVO - 1);
    }
  }
  // ── chaff ──
  if (inp.chaff && !st.prevChaff) {
    st.chaffLeft = SALVO;
    st.chaffTimer = 0;
    st.chaffRepeat = REPEAT;
  } else if (inp.chaff) {
    st.chaffRepeat -= dt;
    if (st.chaffRepeat <= 0 && st.chaffLeft === 0) {
      st.chaffLeft = SALVO;
      st.chaffTimer = 0;
      st.chaffRepeat = REPEAT;
    }
  }
  if (st.chaffLeft > 0) {
    st.chaffTimer -= dt;
    if (st.chaffTimer <= 0) {
      st.chaffLeft = ac.chaff > 0 ? st.chaffLeft - 1 : 0;
      st.chaffTimer = SALVO_GAP;
      if (ac.chaff > 0) dispense(ctx, ac, 'chaff', st.chaffLeft === SALVO - 1);
    }
  }
  st.prevFlare = inp.flare;
  st.prevChaff = inp.chaff;
}

/** Release one decoy. `firstOfSalvo` triggers the seduction rolls. */
export function dispense(ctx: CombatCtx, ac: AircraftEntity, type: 'flare' | 'chaff', firstOfSalvo: boolean): DecoyEntity {
  const world = ctx.world;
  if (type === 'flare') ac.flares--;
  else ac.chaff--;
  const d = new DecoyEntity(world.nextId(), type, ac.team, ac.id, type === 'flare' ? FLARE_LIFE : CHAFF_LIFE, type === 'flare' ? FLARE_INTENSITY : CHAFF_RCS);
  d.radius = type === 'flare' ? 1 : 12;
  // dispensers under the rear fuselage: eject down and slightly sideways
  _v.set((ctx.rng() - 0.5) * 2, -1.2, 3.5).applyQuaternion(ac.quaternion);
  d.position.copy(ac.position).add(_v);
  _w.set((ctx.rng() - 0.5) * 16, -22, 6).applyQuaternion(ac.quaternion);
  d.velocity.copy(ac.velocity).multiplyScalar(type === 'flare' ? 0.85 : 0.7).add(_w);
  d.quaternion.copy(ac.quaternion);
  world.addDecoy(d);
  world.events.emit('countermeasure', { decoy: d, ownerId: ac.id });
  if (firstOfSalvo) {
    if (type === 'flare') rollFlares(ctx, ac, d);
    else rollChaff(ctx, ac, d);
  }
  return d;
}

function rollFlares(ctx: CombatCtx, ac: AircraftEntity, flare: DecoyEntity): void {
  for (const m of ctx.world.missiles) {
    if (!m.alive || !isCombatMissile(m) || m.targetId !== ac.id || m.cdef.guidance !== 'ir' || m.trackBroken) continue;
    if (ctx.time - m.lastFlareRoll < 0.4) continue;
    m.lastFlareRoll = ctx.time;
    const dist = m.position.distanceTo(ac.position);
    if (!inGimbal(m, flare.position, m.cdef.gimbalLimit)) continue;
    // flare vs target IR as seen by the seeker
    const tI = irIntensity(ac, m.position);
    const ratio = FLARE_INTENSITY / (FLARE_INTENSITY + tI);
    // beam geometry: the flare separates quickly across the seeker FOV
    _v.subVectors(ac.position, m.position).normalize();
    const vs = ac.velocity.length();
    const sinAspect = vs > 1 ? Math.sqrt(Math.max(0, 1 - (ac.velocity.dot(_v) / vs) ** 2)) : 0;
    const geometry = 0.55 + 0.45 * sinAspect;
    // too late when the missile is already in the fuze envelope; weak before the seeker sees clearly
    const timing = dist < 300 ? 0.25 : dist > m.cdef.seekerRange ? 0.5 : 1;
    const p = clamp(0.6 * ratio * geometry * timing * (1 - m.cdef.flareResistance) * cmScale(ctx, m, ac), 0, 0.92);
    if (ctx.rng() < p) seduce(m, flare);
  }
}

function rollChaff(ctx: CombatCtx, ac: AircraftEntity, chaff: DecoyEntity): void {
  for (const m of ctx.world.missiles) {
    if (!m.alive || !isCombatMissile(m) || m.targetId !== ac.id || m.trackBroken) continue;
    const g = m.cdef.guidance;
    // only radars that are tracking the target right now can be seduced
    const tracking = (g === 'active_radar' && m.seekerLocked) || g === 'semi_active' || g === 'command';
    if (!tracking) continue;
    if (ctx.time - m.lastChaffRoll < 0.4) continue;
    m.lastChaffRoll = ctx.time;
    let radarPos = m.position;
    if (g !== 'active_radar') {
      const guider = ctx.world.getEntity(m.guiderId);
      if (!guider) continue;
      radarPos = guider.position;
    }
    // chaff alone is filtered by the Doppler gate; together with a beam turn it works
    const depth = notchDepth(ctx, radarPos, ac);
    _v.subVectors(ac.position, radarPos);
    const range = _v.length();
    const vr = range > 1 ? Math.abs(ac.velocity.dot(_v) / range) : 0;
    const beam = 1 - clamp(vr / 150, 0, 1);
    const p = clamp((0.06 + 0.5 * beam + 0.25 * depth) * (1 - m.cdef.chaffResistance) * cmScale(ctx, m, ac), 0, 0.9);
    if (ctx.rng() < p) {
      seduce(m, chaff);
      if (g !== 'active_radar') breakGuiderTrack(ctx, m, ac.id);
    }
  }
}

function seduce(m: CombatMissile, decoy: DecoyEntity): void {
  m.targetId = decoy.id;
  m.decoyed = true;
  m.estPos.copy(decoy.position);
  m.estVel.copy(decoy.velocity);
}

/** Decoy physics: flares burn and fall (~3.5 s), chaff blooms and drifts (~5 s). */
export function updateDecoys(ctx: CombatCtx, dt: number): void {
  const world = ctx.world;
  for (const d of world.decoys) {
    if (!d.alive) continue;
    d.age += dt;
    if (d.age >= d.life) {
      d.alive = false;
      continue;
    }
    const f = d.age / d.life;
    if (d.type === 'flare') {
      d.velocity.multiplyScalar(Math.exp(-1.6 * dt));
      d.velocity.y -= G * dt;
      d.strength = FLARE_INTENSITY * (1 - f * f);
    } else {
      d.velocity.multiplyScalar(Math.exp(-3 * dt));
      d.velocity.y += (-2.5 - d.velocity.y) * (1 - Math.exp(-2 * dt));
      d.strength = CHAFF_RCS * (f < 0.15 ? f / 0.15 : 1 - (f - 0.15) / 0.85);
      d.radius = 6 + 18 * Math.min(1, f * 3);
    }
    d.position.addScaledVector(d.velocity, dt);
    const ground = world.terrain.surfaceHeightAt(d.position.x, d.position.z);
    if (d.position.y < ground) {
      d.position.y = ground;
      if (d.type === 'flare') d.alive = false;
      else d.velocity.set(0, 0, 0);
    }
  }
}
