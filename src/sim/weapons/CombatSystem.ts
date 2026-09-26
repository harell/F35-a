/**
 * F35-A — CombatSystem: weapons, sensors, electronic warfare and SAM sites.
 *
 * Implements CombatSystemApi (src/sim/api.ts). SimWorld calls update() once per 60 Hz step after
 * the flight model. Order inside a step:
 *   weapon-bay sequencing + pickle edge → countermeasure programs → sensors (10 Hz staggered:
 *   radar/DAS/EOTS/IRST/datalink, designation, lock, RWR, MAWS, IR seeker) → SAM sites →
 *   missiles & bombs → gun rounds (move/hit) → gun triggers (spawn) → decoys.
 *
 * Module map:
 *   weapons/defs.ts            munition + gun database
 *   weapons/missile.ts         CombatMissile + launch
 *   weapons/guidance.ts        seekers, datalink, illumination, notching, PN / loft / glide laws
 *   weapons/flight.ts          kinematics, fuzing, warheads, termination
 *   weapons/countermeasures.ts flare/chaff programs, decoys, seduction
 *   weapons/gun.ts             guns, projectiles, LCOS
 *   weapons/release.ts         release rules, bay doors, brevity calls
 *   weapons/loadouts.ts        loadouts, stations, weapon selection
 *   weapons/dlz.ts             launch zones, GPS envelopes, CCIP
 *   sensors/*                  signatures, radar/fusion, RWR, MAWS, IR seeker
 *   sam/*                      SAM data, state machine, AAA
 */
import { Vector3 } from 'three';
import { mulberry32 } from '../../core/math';
import type { MunitionId, WeaponId } from '../../core/types';
import type { CombatSystemApi, CreateCombatSystem, LaunchZone, SimWorld } from '../api';
import type { MunitionDef } from '../entities';
import type { CombatCtx } from './context';
import { acState } from './context';
import { MUNITIONS } from './defs';
import { updateCountermeasurePrograms, updateDecoys } from './countermeasures';
import { ccipPoint, gpsMaxRange, launchZoneFor, munitionForRelease, type CombatLaunchZone, type ZoneHooks } from './dlz';
import { updateMissiles } from './flight';
import { gunLeadPoint, updateAircraftGun, updateProjectiles } from './gun';
import * as loadouts from './loadouts';
import { BAY_OPEN_TIME, fire, handleReleaseInput, updateBay } from './release';
import {
  createSensorShared,
  cycleTarget,
  designate,
  designateNearestTo,
  setRadarEmitting,
  updateSensors,
} from '../sensors/Sensors';
import { irSeekerSees } from '../sensors/irSeeker';
import { updateSams } from '../sam/SamSystem';

/** A fresh zone object (CombatLaunchZone: LaunchZone + the calibrated SHOOT range `rShoot`). */
function emptyZone(weapon: WeaponId, targetId: number | null): LaunchZone {
  const z: CombatLaunchZone = { weapon, targetId, range: 0, rMin: 0, rNe: 0, rMax: 0, shoot: false, closure: 0, timeOfFlight: 0, rShoot: 0 };
  return z;
}

/**
 * In-game combat system: a fresh random seed per sortie, so every attempt at a mission rolls
 * different countermeasure / seeker / fuze outcomes AND (via `aiSalt`, mixed into every AI
 * brain's seed on its first tick) different enemy doctrine rolls — retries are never identical.
 * Tests and replays use createCombatSystemSeeded(seed) and stay deterministic.
 */
export const createCombatSystem: CreateCombatSystem = () => createCombatSystemSeeded(sessionSeed());

function sessionSeed(): number {
  try {
    const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
    if (c?.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0] >>> 0;
  } catch {
    /* fall through */
  }
  return (Math.random() * 0x1_0000_0000) >>> 0;
}

/** Per-combat-system salt the AI mixes into its brain seeds (duck-typed: not part of the contract). */
export function aiSaltFor(seed: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Same as createCombatSystem with an explicit RNG seed (tests / replays). */
export function createCombatSystemSeeded(seed: number): CombatSystemApi {
  const ctx: CombatCtx = {
    world: null as unknown as SimWorld,
    time: 0,
    tick: 0,
    rng: mulberry32(seed),
    defs: MUNITIONS,
    chatter: { friendly: -999, sam: -999 },
    impactBudget: 10,
    flakBudget: 6,
  };
  const sensors = createSensorShared();

  const hooks: ZoneHooks = {
    irLockedOn(ac, id) {
      // the player's cue follows the displayed seeker; AI asks the seeker directly (any weapon selected)
      const st = acState(ac);
      if (ac.isPlayer && ac.selectedWeapon === 'aim9x') return st.ir.state === 'locked' && st.ir.targetId === id;
      const t = ctx.world.getEntity(id);
      if (!t || t.kind !== 'aircraft') return false;
      const def = ctx.defs[munitionForRelease(ac, 'aim9x', false)];
      return irSeekerSees(ctx, def, ac, t, Math.cos(def.gimbalLimit)) > -2;
    },
  };

  /** Point the context at the world an API call came from (outside update()). */
  const bind = (world: SimWorld | null | undefined): void => {
    if (world && ctx.world !== world) {
      ctx.world = world;
      ctx.time = world.time;
    }
  };

  const bombResult = { point: new Vector3(), inRange: false, timeToRelease: 0 };

  const api: CombatSystemApi & { aiSalt: number } = {
    aiSalt: aiSaltFor(seed),
    munitions: MUNITIONS as Record<MunitionId, MunitionDef>,

    update(world, dt) {
      ctx.world = world;
      ctx.time = world.time;
      ctx.tick++;
      const list = world.aircraft;
      for (let i = 0; i < list.length; i++) {
        const ac = list[i];
        if (!ac.alive) continue;
        const st = acState(ac);
        updateBay(ctx, ac, st, dt);
        handleReleaseInput(ctx, ac, st, hooks);
        updateCountermeasurePrograms(ctx, ac, st, dt);
      }
      updateSensors(ctx, sensors, dt);
      updateSams(ctx, dt);
      updateMissiles(ctx, dt);
      updateProjectiles(ctx, dt);
      // Gun triggers after the projectile pass so fresh rounds are not moved twice.
      // (Edge detection uses the combat module's own latches; SimWorld latches ac.prevInput at cleanup.)
      for (let i = 0; i < list.length; i++) {
        const ac = list[i];
        if (ac.alive || ac.gunFiring) updateAircraftGun(ctx, ac, acState(ac), dt);
      }
      updateDecoys(ctx, dt);
    },

    applyLoadout(ac, loadout) {
      loadouts.applyLoadout(ac, loadout, ctx.world);
    },
    applyDefaultLoadout(ac) {
      loadouts.applyDefaultLoadout(ac, ctx.world);
    },

    cycleWeapon(ac, world) {
      bind(world);
      loadouts.cycleWeapon(ac, world);
    },
    selectWeapon(ac, weapon, world) {
      bind(world);
      loadouts.selectWeapon(ac, weapon, world);
    },
    cycleTarget(ac, world) {
      bind(world);
      cycleTarget(ctx, ac);
    },
    designateNearestTo(ac, dir, world) {
      bind(world);
      designateNearestTo(ctx, ac, dir);
    },
    designate(ac, targetId, world) {
      bind(world);
      designate(ctx, ac, targetId);
    },
    setRadarEmitting(ac, emitting, world) {
      bind(world);
      setRadarEmitting(ctx, ac, emitting);
    },

    remaining(ac, weapon) {
      return loadouts.remaining(ac, weapon);
    },

    launchZone(ac, world) {
      bind(world);
      const id = ac.selectedWeapon === 'aim9x' && acState(ac).ir.state === 'locked' ? acState(ac).ir.targetId : (ac.radar.lockedId ?? ac.radar.designatedId);
      const target = world.getEntity(id);
      if (!target || !target.alive || target.team === ac.team) return null;
      const air = target.kind === 'aircraft';
      const w = ac.selectedWeapon;
      const aaWeapon = w === 'aim120' || w === 'aim9x' || w === 'gun';
      if (air !== aaWeapon) return null;
      if (w === 'aargm' && target.kind !== 'sam' && !(target.kind === 'ground' && target.emitter)) return null;
      return launchZoneFor(ctx, ac, w, target, hooks, emptyZone(w, target.id));
    },

    launchZoneFor(ac, weapon, target, world) {
      bind(world);
      return launchZoneFor(ctx, ac, weapon, target, hooks, emptyZone(weapon, target.id));
    },

    fire(ac, world, weapon, targetId) {
      bind(world);
      return fire(ctx, ac, hooks, weapon, targetId);
    },

    irSeekerState(ac) {
      return acState(ac).ir;
    },

    gunLeadPoint(ac, world) {
      bind(world);
      return gunLeadPoint(ctx, ac);
    },

    bombImpactPoint(ac, world) {
      bind(world);
      const w = ac.selectedWeapon;
      if ((w !== 'gbu31' && w !== 'gbu39') || loadouts.remaining(ac, w) <= 0) return null;
      const def = ctx.defs[w];
      const gp = ac.radar.groundPoint;
      const r = bombResult;
      if (gp) {
        const dx = gp.x - ac.position.x;
        const dz = gp.z - ac.position.z;
        const horiz = Math.hypot(dx, dz);
        const rMax = gpsMaxRange(def, ac.position.y - gp.y, ac.velocity.length(), gp.y);
        const pad = ac.isPlayer && world.difficulty.generousShootCues ? 1.1 : 1;
        r.point.copy(gp);
        r.inRange = horiz <= rMax * pad;
        const gs = horiz > 1 ? (ac.velocity.x * dx + ac.velocity.z * dz) / horiz : 0;
        r.timeToRelease = r.inRange ? 0 : gs > 5 ? (horiz - rMax * pad) / gs : -1;
        return r;
      }
      // an internal release waits for the bay doors: aim for where the jet will be then
      const st = loadouts.pickStation(ac, w);
      const delay = st >= 0 && ac.stores[st].internal && ac.isPlayer ? Math.max(0, 0.9 - ac.bayDoors) * BAY_OPEN_TIME : 0;
      if (!ccipPoint(world, ac, def, r.point, delay)) return null;
      r.inRange = ac.position.y - r.point.y > 60;
      r.timeToRelease = 0;
      return r;
    },
  };
  return api;
}

/** Re-export for other modules (HUD/AI) that want the typed munition table or station info. */
export { MUNITIONS } from './defs';
export type { CombatLaunchZone } from './dlz';
export { stationMunition } from './loadouts';
