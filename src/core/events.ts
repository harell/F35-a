/**
 * F35-A — typed event bus + event catalogue.
 * OWNERSHIP: orchestrator. Do not edit (ask the orchestrator for new events).
 *
 * Emitters: sim systems (combat, flight, missions). Listeners: audio, effects, HUD, UI.
 * Payload vectors are live references — clone them if you keep them past the callback.
 */
import type { Vector3 } from 'three';
import type { ExplosionSize, MunitionId, Team, VoiceId, WarningId, WeaponId } from './types';
import type { AircraftEntity, AnyEntity, DecoyEntity, MissileEntity, RwrContact } from '../sim/entities';
import type { LandmarkEntity } from '../sim/landmarks';

export interface GameEventMap {
  /** A missile/bomb left the rail/bay. */
  'munition:launch': { missile: MissileEntity; shooter: AnyEntity; targetId: number | null };
  /** Missile/bomb ended: hit (fuzed near target), miss (self destruct / lost energy), ground impact. */
  'munition:end': {
    missile: MissileEntity;
    position: Vector3;
    reason: 'hit' | 'proximity' | 'ground' | 'water' | 'selfdestruct' | 'decoyed';
    targetId: number | null;
  };
  /** Gun started / stopped firing (continuous sound + muzzle flash). */
  'gun:state': { shooterId: number; firing: boolean; position: Vector3; team: Team; weapon: 'gau22' | 'gsh301' | 'zsu23' };
  /** Bullet/shell impact (sparks on aircraft, dust on ground, splash on water). */
  'gun:impact': { position: Vector3; surface: 'air' | 'ground' | 'water' | 'target'; targetId: number | null };
  /** Any explosion (warheads, bombs, destroyed vehicles, flak bursts). */
  explosion: { position: Vector3; size: ExplosionSize; surface: 'air' | 'ground' | 'water' };
  /** Entity took damage. */
  damage: { target: AnyEntity; amount: number; attackerId: number | null; weapon: WeaponId | MunitionId | 'gun' | 'collision' | 'flak' };
  /** Entity destroyed (aircraft shot down / crashed, SAM site / ground target destroyed). */
  destroyed: { entity: AnyEntity; attackerId: number | null; weapon: WeaponId | MunitionId | 'gun' | 'collision' | 'flak' | null };
  /** Flare/chaff released. */
  countermeasure: { decoy: DecoyEntity; ownerId: number };
  /** Player's (or any aircraft's) hard lock changed. */
  lock: { ownerId: number; targetId: number | null; locked: boolean };
  /** Player's designated target changed (TD box moved). */
  designate: { ownerId: number; targetId: number | null };
  /** Player selected a different weapon. */
  'weapon:select': { ownerId: number; weapon: WeaponId };
  /** Weapon release refused (out of range, no lock, empty) — HUD flashes the reason. */
  'weapon:denied': { ownerId: number; weapon: WeaponId; reason: string };
  /** New RWR emitter for the player (ping tone). */
  'rwr:new': { contact: RwrContact };
  /** Warning appeared/cleared on the player (ICAWS). */
  warning: { id: WarningId; active: boolean };
  /** Radio message / callout. `voice` plays a pre-rendered clip, text is shown as a subtitle. */
  radio: { from: string; text: string; voice?: VoiceId; priority?: number; team?: Team };
  /** Centre-screen HUD message ("TARGET DESTROYED", "MISSION COMPLETE"). */
  'hud:message': { text: string; duration?: number; tone?: 'info' | 'good' | 'bad' | 'warn' };
  /** Aircraft crossed Mach 1 (vapor cone, sonic boom for external observers). */
  transonic: { aircraft: AircraftEntity; supersonic: boolean };
  /** Mission objective state changed. */
  objective: { id: string; label: string; state: 'active' | 'complete' | 'failed' };
  /** Mission finished. */
  'mission:end': { success: boolean; reason: string };
  /** Player took a hit (screen flash, shake, haptics). */
  'player:hit': { amount: number; direction: Vector3 | null };
  /** A protected landmark (the Sky Tower) was destroyed: its collapse starts now. */
  'landmark:destroyed': { landmark: LandmarkEntity; attackerId: number | null; weapon: MunitionId | null; position: Vector3 };
  /** The falling landmark's upper section hit the ground (dust wall, rumble). `heading` = fall heading (rad). */
  'landmark:impact': { landmark: LandmarkEntity; position: Vector3; heading: number };
  /** Player was destroyed (crash / shot down). */
  'player:down': { reason: 'crash' | 'shot' | 'collision' | 'fuel' };
}

export type GameEventName = keyof GameEventMap;
type Handler<K extends GameEventName> = (payload: GameEventMap[K]) => void;

export class EventBus {
  private handlers = new Map<GameEventName, Set<Handler<any>>>();

  on<K extends GameEventName>(name: K, fn: Handler<K>): () => void {
    let set = this.handlers.get(name);
    if (!set) this.handlers.set(name, (set = new Set()));
    set.add(fn);
    return () => this.off(name, fn);
  }

  off<K extends GameEventName>(name: K, fn: Handler<K>): void {
    this.handlers.get(name)?.delete(fn);
  }

  emit<K extends GameEventName>(name: K, payload: GameEventMap[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[events] handler for "${name}" threw`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
