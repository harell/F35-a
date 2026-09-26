/**
 * Shared per-frame drawing context for the HMD modules + the HUD's persistent transient state
 * (flashes, feeds, sticky scales). One instance of each lives for the lifetime of the HUD; the frame
 * object is refreshed in place every update (no per-frame allocation).
 */
import { Vector3 } from 'three';
import type { FrameContext } from '../../core/contracts';
import type { LaunchZone, SimWorld } from '../../sim/api';
import type { AircraftEntity, AnyEntity } from '../../sim/entities';
import { KillFeed, MessageQueue, RadioQueue } from './feeds';
import { makeGEffectState, type GEffectState } from './gEffects';
import type { HudLayout } from './layout';
import type { Palette } from './palette';
import type { Pen } from './pen';
import type { PickRegistry } from './picking';
import { makeScreenPoint, type Projector, type ScreenPoint } from './projector';

export type HudMode = 'hmd' | 'external' | 'tactical';

export interface HitMark {
  x: number;
  y: number;
  /** Entity to follow (screen position refreshed each frame when visible). */
  id: number;
  age: number;
  kill: boolean;
  active: boolean;
}

export class HudState {
  /** Animation clock (s) — keeps running while paused so flashing stays alive. */
  clock = 0;
  /** Seconds since the last player lock (large = none). */
  lockAge = 99;
  lockId: number | null = null;
  deniedText = '';
  deniedAge = 99;
  weaponAge = 99;
  brevity = '';
  brevityAge = 99;
  /** Seconds since a new warning appeared (master warning flash). */
  warnAge = 99;
  /** Seconds left to show the objective summary. */
  objShow = 8;
  /** Sticky DLZ scale (m). */
  dlzScale = 0;
  readonly radio = new RadioQueue();
  readonly messages = new MessageQueue();
  readonly kills = new KillFeed();
  readonly g: GEffectState = makeGEffectState();
  readonly hits: HitMark[] = Array.from({ length: 6 }, () => ({ x: 0, y: 0, id: -1, age: 99, kill: false, active: false }));
  playerId: number | null = null;
  /** Last hit time per entity (to suppress repeated gun hit markers). */
  lastHitAt = 0;

  addHit(id: number, kill: boolean): void {
    // refresh an existing marker on the same target
    for (const h of this.hits) {
      if (h.active && h.id === id) {
        h.age = 0;
        h.kill = h.kill || kill;
        return;
      }
    }
    let slot = this.hits[0];
    for (const h of this.hits) {
      if (!h.active) {
        slot = h;
        break;
      }
      if (h.age > slot.age) slot = h;
    }
    slot.active = true;
    slot.id = id;
    slot.age = 0;
    slot.kill = kill;
    slot.x = NaN;
    slot.y = NaN;
  }

  step(dt: number, paused: boolean): void {
    this.clock += dt;
    if (paused) return;
    this.lockAge += dt;
    this.deniedAge += dt;
    this.weaponAge += dt;
    this.brevityAge += dt;
    this.warnAge += dt;
    this.objShow = Math.max(0, this.objShow - dt);
    this.radio.update(dt);
    this.messages.update(dt);
    this.kills.update(dt);
    for (const h of this.hits) {
      if (!h.active) continue;
      h.age += dt;
      if (h.age > (h.kill ? 0.9 : 0.45)) h.active = false;
    }
  }

  /** Per-player state reset (new mission / respawn). Keeps the text feeds queued during mission setup. */
  resetPlayer(): void {
    this.lockAge = 99;
    this.deniedAge = 99;
    this.weaponAge = 99;
    this.brevityAge = 99;
    this.warnAge = 99;
    this.objShow = 8;
    this.dlzScale = 0;
    this.g.grey = this.g.red = this.g.flash = 0;
    for (const h of this.hits) h.active = false;
  }

  /** Full reset (session teardown): also clears radio, messages and the kill feed. */
  reset(): void {
    this.lockAge = 99;
    this.deniedAge = 99;
    this.weaponAge = 99;
    this.brevityAge = 99;
    this.warnAge = 99;
    this.objShow = 8;
    this.dlzScale = 0;
    this.radio.clear();
    this.messages.clear();
    this.kills.clear();
    this.g.grey = this.g.red = this.g.flash = 0;
    for (const h of this.hits) h.active = false;
  }
}

/** Everything a draw function needs for this frame. */
export interface HudFrame {
  pen: Pen;
  pal: Palette;
  L: HudLayout;
  proj: Projector;
  picks: PickRegistry;
  st: HudState;
  ctx: FrameContext;
  world: SimWorld;
  p: AircraftEntity;
  mode: HudMode;
  /** True in cockpit view (3D cockpit visible below the HMD). */
  cockpit: boolean;
  /** Designated (or locked) hostile target entity, alive, or null. */
  target: AnyEntity | null;
  locked: boolean;
  /** Current launch zone of the selected weapon (null if n/a). */
  zone: LaunchZone | null;
  /** Flight path marker screen position (valid when fpm.front). */
  fpm: ScreenPoint;
  /** Velocity heading / pitch (rad). */
  vHeading: number;
  vPitch: number;
  /** Scratch vectors for draw modules (never keep references across calls). */
  v1: Vector3;
  v2: Vector3;
  v3: Vector3;
  sp: ScreenPoint;
  sp2: ScreenPoint;
}

export function makeFrame(pen: Pen, proj: Projector, picks: PickRegistry, st: HudState, L: HudLayout, pal: Palette): HudFrame {
  return {
    pen,
    pal,
    L,
    proj,
    picks,
    st,
    ctx: null as unknown as FrameContext,
    world: null as unknown as SimWorld,
    p: null as unknown as AircraftEntity,
    mode: 'hmd',
    cockpit: false,
    target: null,
    locked: false,
    zone: null,
    fpm: makeScreenPoint(),
    vHeading: 0,
    vPitch: 0,
    v1: new Vector3(),
    v2: new Vector3(),
    v3: new Vector3(),
    sp: makeScreenPoint(),
    sp2: makeScreenPoint(),
  };
}

/** Square-wave blink helper (true during the "on" half). */
export function blink(f: HudFrame, hz: number, duty = 0.5): boolean {
  const t = f.st.clock * hz;
  return t - Math.floor(t) < duty;
}
