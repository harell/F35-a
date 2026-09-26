/**
 * F35-A — countermeasures: flare & chaff dispense programs, decoy physics and seduction.
 *
 * Programs: the rising edge of input.flare releases a salvo of 2 flares 0.15 s apart; holding
 * the button repeats the salvo every 0.6 s. Chaff works the same way. AI uses the same inputs.
 *
 * Seduction is rolled once per salvo per missile (at release):
 *  - flares vs IR missiles: flare/target IR ratio, beam geometry, range, flareResistance,
 *    k_cm (ew.ts: difficulty for the human player, the defending pilot's skill for AI)
 *  - chaff vs radar-guided missiles: see rollChaff — beam geometry, end-game timing, resistance,
 *    k_cm and diminishing returns; a seduced SAM/fighter fire-control radar loses its track.
 */
import { Vector3 } from 'three';
import { G, clamp, smoothstep } from '../../core/math';
import { DecoyEntity, type AircraftEntity } from '../entities';
import type { AcCombatState, CombatCtx } from './context';
import { breakGuiderTrack, inGimbal } from './guidance';
import { cmFactor, notchDepth, radialSpeed } from './ew';
import { isCombatMissile, type CombatMissile } from './missile';
import { irIntensity } from '../sensors/signatures';
import { siteEw } from '../sam/SamSystem';

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

/** Auto-CMDS (Recruit): bit 1 = flares (enemy IR missile inside this range, m), bit 2 = chaff. */
export const AUTO_FLARE_RANGE = 4_000;
/** Auto-CMDS: chaff when an enemy radar missile's time to impact drops below this (s). */
export const AUTO_CHAFF_TTI = 8;

/**
 * Automatic countermeasure dispenser program for the human player on Recruit (the F-35's CMDS
 * can run automatic programs cued by the MAWS / RWR): a new pilot who does not defend yet still
 * gets flares against IR missiles inside 4 km and chaff against radar missiles in the last ~8 s.
 * Air-to-air missiles only (defeating SAMs stays a skill to learn). Returns bit 1 for flares, bit 2
 * for chaff.
 */
export function autoCms(ctx: CombatCtx, ac: AircraftEntity): number {
  if (!ac.isPlayer || ctx.world.difficulty.id !== 'recruit') return 0;
  let out = 0;
  for (const m of ctx.world.missiles) {
    if (!m.alive || m.targetId !== ac.id || m.team === ac.team || !isCombatMissile(m) || m.trackBroken || m.cdef.category !== 'aam') continue;
    const dx = m.position.x - ac.position.x;
    const dy = m.position.y - ac.position.y;
    const dz = m.position.z - ac.position.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (m.cdef.guidance === 'ir') {
      if (d < AUTO_FLARE_RANGE) out |= 1;
    } else if (m.cdef.guidance === 'active_radar' || m.cdef.guidance === 'semi_active' || m.cdef.guidance === 'command') {
      const vc = d > 1 ? -((m.velocity.x - ac.velocity.x) * dx + (m.velocity.y - ac.velocity.y) * dy + (m.velocity.z - ac.velocity.z) * dz) / d : 0;
      if (vc > 50 && d / vc < AUTO_CHAFF_TTI) out |= 2;
    }
  }
  return out;
}

/** Run an aircraft's flare/chaff programs for this step. */
export function updateCountermeasurePrograms(ctx: CombatCtx, ac: AircraftEntity, st: AcCombatState, dt: number): void {
  const inp = ac.input;
  const auto = ac.isPlayer ? autoCms(ctx, ac) : 0;
  const flareIn = inp.flare || (auto & 1) !== 0;
  const chaffIn = inp.chaff || (auto & 2) !== 0;
  // ── flares ──
  if (flareIn && !st.prevFlare) {
    st.flareLeft = SALVO;
    st.flareTimer = 0;
    st.flareRepeat = REPEAT;
  } else if (flareIn) {
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
  if (chaffIn && !st.prevChaff) {
    st.chaffLeft = SALVO;
    st.chaffTimer = 0;
    st.chaffRepeat = REPEAT;
  } else if (chaffIn) {
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
  st.prevFlare = flareIn;
  st.prevChaff = chaffIn;
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
    const p = clamp(0.6 * ratio * geometry * timing * (1 - m.cdef.flareResistance) * cmFactor(ctx, m.team, ac), 0, 0.92);
    if (ctx.rng() < p) seduce(m, flare);
  }
}

/** Chaff seduction probability scale (per salvo, perfect geometry and timing, no resistance). */
export const CHAFF_BASE = 0.33;
/** Diminishing returns: each full-timing salvo already seen by the same radar multiplies p by this. */
export const CHAFF_DIMINISH = 0.68;
/** The tracker's adaptation to chaff fades with this time constant (s). */
export const CHAFF_MEMORY = 5;
const _rolledGuiders = new Set<number>();

/**
 * Chaff vs radar-guided missiles. One roll per salvo per tracking radar (the missile's own seeker
 * for active missiles, the illuminating / commanding radar for SARH / command guidance):
 *   p = CHAFF_BASE · geometry · timing · (1 − chaffResistance) · k_cm^1.5 · CHAFF_DIMINISH^exposure
 *   geometry = 0.08·k + (1 − 0.08·k)·beam, beam = 1 − smoothstep(|v_radial|, 40·√k, 180·√k)
 *              (chaff hangs at ~0 radial speed: only a beaming target makes it Doppler-
 *              indistinguishable; easier difficulties forgive a sloppier beam)
 *   timing   = 1 in the last ~6 s before impact, 0.25 early (ramp 6–10 s), or the notch depth
 *   exposure = Σ earlier salvos' timing² against the same radar, fading with a 5 s memory — the
 *              tracker adapts (diminishing returns), so spamming chaff early is weak and holding the
 *              button never guarantees a break.
 */
function rollChaff(ctx: CombatCtx, ac: AircraftEntity, chaff: DecoyEntity): void {
  const world = ctx.world;
  _rolledGuiders.clear();
  for (const m of world.missiles) {
    if (!m.alive || !isCombatMissile(m) || m.targetId !== ac.id || m.trackBroken) continue;
    const g = m.cdef.guidance;
    // only radars that are tracking the target right now can be seduced: the active seeker once
    // locked or searching its basket, and — in the datalink midcourse — the LAUNCHER's radar
    let midcourse: AircraftEntity | null = null;
    if (g === 'active_radar' && !m.seekerLocked && !m.everLocked && m.cdef.datalink) {
      const l = world.getEntity(m.shooterId);
      if (l && l.kind === 'aircraft' && l.alive && l.type !== 'f35a') midcourse = l;
    }
    const tracking = (g === 'active_radar' && (m.seekerLocked || midcourse !== null || inBasket(m, ac))) || g === 'semi_active' || g === 'command';
    if (!tracking) continue;
    let radarPos = m.position;
    let ew: { chaffExposure: number; lastChaffRoll: number } = m;
    if (midcourse) radarPos = midcourse.position;
    else if (g !== 'active_radar') {
      const guider = world.getEntity(m.guiderId);
      if (!guider || !guider.alive) continue;
      radarPos = guider.position;
      if (guider.kind === 'sam') {
        if (_rolledGuiders.has(guider.id)) continue; // one roll per fire-control radar per salvo
        _rolledGuiders.add(guider.id);
        ew = siteEw(ctx, guider);
      }
    }
    if (ctx.time - ew.lastChaffRoll < 0.3) continue;
    ew.chaffExposure *= Math.exp(-(ctx.time - ew.lastChaffRoll) / CHAFF_MEMORY);
    ew.lastChaffRoll = ctx.time;
    // Doppler geometry — the easier the difficulty (k_cm), the more a sloppy beam is forgiven
    const kcm = cmFactor(ctx, m.team, ac);
    const wide = Math.sqrt(clamp(kcm, 0.5, 3));
    const beam = 1 - smoothstep(radialSpeed(radarPos, ac), 40 * wide, 180 * wide);
    const geometry = 0.08 * Math.min(2, kcm) + (1 - 0.08 * Math.min(2, kcm)) * beam;
    // timing: time to impact of this missile
    _v.subVectors(ac.position, m.position);
    const dist = _v.length();
    _w.subVectors(m.velocity, ac.velocity);
    const closing = dist > 1 ? _w.dot(_v) / dist : 0;
    const tti = dist / Math.max(50, closing);
    let timing = tti <= 6 ? 1 : tti >= 10 ? 0.25 : 1 - (0.75 * (tti - 6)) / 4;
    timing = Math.max(timing, notchDepth(ctx, radarPos, ac));
    const f = geometry * timing;
    const k = Math.pow(kcm, 1.5);
    const p = clamp(CHAFF_BASE * f * (1 - m.cdef.chaffResistance) * k * Math.pow(CHAFF_DIMINISH, ew.chaffExposure), 0, 0.9);
    ew.chaffExposure += timing * timing;
    if (ctx.rng() < p) {
      if (midcourse) {
        // the launcher's range/Doppler gates walk off onto the chaff: the uplinked track drifts
        // (seeker basket in the wrong place) — the missile flies on, but blind to the real target
        m.dlNotch = Math.max(m.dlNotch, 3);
      } else if (g === 'active_radar') seduce(m, chaff);
      else {
        // the fire-control radar's range/Doppler gate walked off onto the chaff: its track is
        // gone (every missile it guides loses the uplink) and this missile is defeated
        m.decoyed = true;
        m.trackBroken = true;
        breakGuiderTrack(ctx, m, ac.id);
      }
    }
  }
}

/** Active seeker (not yet locked) already searching its basket around the target (pitbull range). */
function inBasket(m: CombatMissile, ac: AircraftEntity): boolean {
  return m.position.distanceTo(ac.position) < m.cdef.activeRange && m.position.distanceTo(ac.position) < m.cdef.seekerRange * 0.5;
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
