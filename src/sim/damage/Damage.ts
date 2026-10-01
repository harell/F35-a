/**
 * F35-A — damage model (SIM-CORE): difficulty scaling for the player, subsystem damage
 * (engine / hydraulics / fuel leak / fire / avionics), fire damage-over-time, overstress,
 * destruction (wrecks, explosions), kill credit and the related events.
 *
 * Stats: `attacker.kills` is credited here (hostile kills only). `attacker.hits` is counted
 * by the CombatSystem per shot (missile / gun burst) so that accuracy = hits / shotsFired.
 */
import { Quaternion, Vector3 } from 'three';
import type { EventBus } from '../../core/events';
import { isHostile, type DifficultyParams, type MunitionId, type WeaponId } from '../../core/types';
import { AircraftEntity, type AnyEntity, type GroundTargetEntity, type SamSiteEntity } from '../entities';
import { ensureSimState, makeWreck } from '../flight/FlightModel';
import { GROUND_TARGET_DATA, SAM_SITE_DATA, aircraftExplosion } from './tables';

export type DamageWeapon = WeaponId | MunitionId | 'gun' | 'collision' | 'flak';
export type DownReason = 'crash' | 'shot' | 'collision' | 'fuel';

/** What the damage model needs from the world. */
export interface DamageHost {
  readonly events: EventBus;
  readonly difficulty: DifficultyParams;
  readonly time: number;
  getEntity(id: number | null | undefined): AnyEntity | null;
  /** Called whenever an entity transitions alive → dead (cache invalidation). */
  onEntityDestroyed(e: AnyEntity): void;
}

/** Hit points per second lost to an uncontained fire. */
const FIRE_DPS = 1.3;
/** Engine damage per second while burning. */
const FIRE_ENGINE_RATE = 0.012;
/** A crash within this many seconds of being hit is credited to the attacker (manoeuvring kill). */
const CRASH_CREDIT_WINDOW = 15;

const NON_MUNITION = new Set<string>(['gun', 'collision', 'flak']);
const _pos = new Vector3();
const _dir = new Vector3();
const _local = new Vector3();

export class DamageSystem {
  constructor(private readonly host: DamageHost) {}

  /** Entry point for SimWorld.applyDamage. */
  apply(target: AnyEntity, amount: number, attackerId: number | null, weapon: DamageWeapon, hitPoint?: Vector3): void {
    if (!target || !target.alive || !(amount > 0)) return;
    switch (target.kind) {
      case 'aircraft':
        this.damageAircraft(target, amount, attackerId, weapon, hitPoint);
        break;
      case 'sam':
      case 'ground':
        this.damageStructure(target, amount, attackerId, weapon);
        break;
      case 'missile': {
        target.health -= amount;
        if (target.health <= 0) {
          target.health = 0;
          target.alive = false;
          this.explode(target.position, 'small', 'air');
          this.host.onEntityDestroyed(target);
        }
        break;
      }
      case 'decoy':
        target.alive = false;
        this.host.onEntityDestroyed(target);
        break;
    }
  }

  /* ───────────────────────────── Aircraft ───────────────────────────── */

  private damageAircraft(ac: AircraftEntity, amount: number, attackerId: number | null, weapon: DamageWeapon, hitPoint?: Vector3): void {
    const d = this.host.difficulty;
    const isMunition = !NON_MUNITION.has(weapon);
    let dmg = amount;
    if (ac.isPlayer) {
      dmg *= d.playerDamageScale;
      const hits = d.playerMissileHitsToKill;
      if (isMunition && hits >= 2) {
        // A single missile can take at most ~1/N of the airframe, and never kills from full health.
        dmg = Math.min(dmg, (ac.maxHealth / hits) * 1.15);
        if (ac.health >= ac.maxHealth * 0.95) dmg = Math.min(dmg, ac.health - 5);
      }
    }
    if (!(dmg > 0)) return;

    const st = ensureSimState(ac);
    if (weapon !== 'collision') this.damageSubsystems(ac, dmg / ac.maxHealth, isMunition, weapon === 'gun', hitPoint);

    ac.health -= dmg;
    ac.lastDamageTime = this.host.time;
    if (attackerId != null) ac.lastAttackerId = attackerId;
    st.lastWeapon = weapon;

    // NOTE: attacker.hits is counted by the CombatSystem (one per missile / gun burst that
    // damages a hostile, consistent with its shotsFired) — not here, to avoid double counting.
    const ev = this.host.events;
    ev.emit('damage', { target: ac, amount: dmg, attackerId, weapon });
    if (ac.isPlayer) {
      let direction: Vector3 | null = null;
      if (hitPoint) {
        _dir.subVectors(hitPoint, ac.position);
        if (_dir.lengthSq() > 1e-6) direction = _dir.normalize();
      }
      ev.emit('player:hit', { amount: dmg, direction });
    }
    if (ac.health <= 0) this.destroyAircraft(ac, attackerId, weapon, weapon === 'collision' ? 'collision' : 'shot');
  }

  /** Spread a hit over the jet's systems. `frac` = damage / max health. */
  private damageSubsystems(ac: AircraftEntity, frac: number, isMunition: boolean, isGun: boolean, hitPoint?: Vector3): void {
    const st = ensureSimState(ac);
    const r = st.rng;
    const dmg = ac.damage;
    let rear = false;
    if (hitPoint) {
      _local.subVectors(hitPoint, ac.position);
      _local.applyQuaternion(_invQuat(ac));
      rear = _local.z > 0; // body +Z is aft
    }
    const k = isMunition ? 1 : isGun ? 0.7 : 0.5;
    if (r() < (rear ? 0.8 : 0.45)) dmg.engine = Math.min(1, dmg.engine + frac * (0.5 + r()) * 1.2 * k);
    if (r() < 0.4) dmg.hydraulics = Math.min(1, dmg.hydraulics + frac * (0.4 + r()) * 1.2 * k);
    if (r() < 0.35) dmg.fuelLeak = Math.min(1, dmg.fuelLeak + frac * (0.3 + r()) * k);
    if (r() < 0.3) dmg.avionics = Math.min(1, dmg.avionics + frac * (0.3 + r()) * k);
    const pFire = Math.min(0.85, frac * (isMunition ? 2.2 : 1) * (rear ? 1.5 : 1));
    if (!dmg.fire && r() < pFire) {
      dmg.fire = true;
      st.fireTimer = 8 + r() * 14;
    }
  }

  /**
   * Destroy an aircraft: wreck state (tumbling, burning), explosion, kill credit, events.
   * `surface` = where it blew up ('ground' / 'water' when destroyed by impact).
   */
  destroyAircraft(
    ac: AircraftEntity,
    attackerId: number | null,
    weapon: DamageWeapon | null,
    reason: DownReason,
    surface: 'air' | 'ground' | 'water' = 'air',
  ): void {
    if (!ac.alive) return;
    const host = this.host;
    ac.alive = false;
    ac.health = 0;
    ac.destroyedAt = host.time;
    makeWreck(ac);
    this.explode(ac.position, aircraftExplosion(ac.type), surface);

    const attacker = host.getEntity(attackerId);
    if (attacker instanceof AircraftEntity && attacker !== ac && isHostile(attacker.team, ac.team)) attacker.kills++;
    host.events.emit('destroyed', { entity: ac, attackerId, weapon });
    if (ac.isPlayer) host.events.emit('player:down', { reason });
    host.onEntityDestroyed(ac);
  }

  /** Terrain / sea impact of a flying aircraft (alive → crash, wreck → final impact). */
  crashAircraft(ac: AircraftEntity, water: boolean): void {
    const st = ensureSimState(ac);
    const host = this.host;
    const surface = water ? 'water' : 'ground';
    if (ac.alive) {
      const recent = ac.lastAttackerId != null && host.time - ac.lastDamageTime < CRASH_CREDIT_WINDOW;
      const attackerId = recent ? ac.lastAttackerId : null;
      const reason: DownReason = st.fuelExhausted ? 'fuel' : 'crash';
      this.destroyAircraft(ac, attackerId, 'collision', reason, surface);
    } else {
      this.explode(ac.position, aircraftExplosion(ac.type), surface);
    }
    ac.crashed = true;
    st.crashTime = host.time;
    ac.velocity.set(0, 0, 0);
    ac.rates.set(0, 0, 0);
    ac.gcasActive = false;
    // A wreck in the sea sinks; on land it keeps burning.
    ac.damage.fire = !water;
  }

  /** Mid-air collision between two aircraft. */
  collide(a: AircraftEntity, b: AircraftEntity): void {
    const aliveA = a.alive;
    const aliveB = b.alive;
    if (aliveA) this.destroyAircraft(a, null, 'collision', 'collision');
    if (aliveB) this.destroyAircraft(b, null, 'collision', 'collision');
  }

  /* ───────────────────────────── SAM sites / ground targets ───────────────────────────── */

  private damageStructure(t: SamSiteEntity | GroundTargetEntity, amount: number, attackerId: number | null, weapon: DamageWeapon): void {
    const host = this.host;
    t.health -= amount;
    const attacker = host.getEntity(attackerId);
    const hostileAttacker = attacker instanceof AircraftEntity && attacker.team !== t.team;
    host.events.emit('damage', { target: t, amount, attackerId, weapon });
    if (t.health > 0) return;

    t.health = 0;
    t.alive = false;
    t.velocity.set(0, 0, 0);
    let size: 'large' | 'huge' = 'large';
    let surface: 'ground' | 'water' = 'ground';
    if (t.kind === 'sam') {
      t.state = 'off';
      t.radarOn = false;
      t.trackedTargetId = null;
      size = SAM_SITE_DATA[t.type].explosion === 'huge' ? 'huge' : 'large';
    } else {
      t.speed = 0;
      const data = GROUND_TARGET_DATA[t.type];
      size = data.explosion === 'huge' ? 'huge' : 'large';
      if (data.naval) surface = 'water';
    }
    this.explode(t.position, size, surface);
    if (hostileAttacker) (attacker as AircraftEntity).kills++;
    host.events.emit('destroyed', { entity: t, attackerId, weapon });
    host.onEntityDestroyed(t);
  }

  /* ───────────────────────────── Per-step effects ───────────────────────────── */

  /** Fire damage-over-time, fires burning out, pending overstress damage. */
  update(aircraft: readonly AircraftEntity[], dt: number): void {
    const host = this.host;
    for (let i = 0; i < aircraft.length; i++) {
      const ac = aircraft[i];
      if (!ac.alive) continue;
      const st = ensureSimState(ac);

      if (st.pendingStructuralDamage > 0) {
        const amount = st.pendingStructuralDamage;
        st.pendingStructuralDamage = 0;
        this.overstress(ac, amount);
        if (!ac.alive) continue;
      }

      if (ac.damage.fire) {
        const scale = ac.isPlayer ? host.difficulty.playerDamageScale : 1;
        ac.health -= FIRE_DPS * scale * dt;
        ac.damage.engine = Math.min(1, ac.damage.engine + FIRE_ENGINE_RATE * dt);
        st.fireTimer -= dt;
        if (st.fireTimer <= 0) {
          if (st.rng() < 0.5) ac.damage.fire = false;
          else st.fireTimer = 6 + st.rng() * 10;
        }
        if (ac.health <= 0) {
          const w = (st.lastWeapon ?? null) as DamageWeapon | null;
          this.destroyAircraft(ac, ac.lastAttackerId, w, 'shot');
        }
      }
    }
  }

  /** Structural damage from exceeding the g limit (unassisted flight). */
  private overstress(ac: AircraftEntity, amount: number): void {
    const host = this.host;
    ac.health -= amount;
    ac.damage.hydraulics = Math.min(1, ac.damage.hydraulics + Math.min(0.5, amount / 100));
    ac.lastDamageTime = host.time;
    host.events.emit('damage', { target: ac, amount, attackerId: null, weapon: 'collision' });
    if (ac.isPlayer) {
      host.events.emit('hud:message', { text: 'OVERSTRESS', duration: 2, tone: 'bad' });
      host.events.emit('player:hit', { amount, direction: null });
    }
    if (ac.health <= 0) this.destroyAircraft(ac, null, 'collision', 'crash');
  }

  private explode(position: Vector3, size: 'tiny' | 'small' | 'medium' | 'large' | 'huge', surface: 'air' | 'ground' | 'water'): void {
    _pos.copy(position);
    this.host.events.emit('explosion', { position: _pos, size, surface });
  }
}

const _iq = new Quaternion();
/** Inverse attitude (scratch) — world → body. */
function _invQuat(ac: AircraftEntity): Quaternion {
  return _iq.copy(ac.quaternion).invert();
}
