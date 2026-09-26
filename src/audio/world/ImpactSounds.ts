/**
 * F35-A audio — explosions, launches heard from afar, hits and bullet impacts.
 *
 * World one-shots travel at the speed of sound: they wait in a DelayQueue until the sound
 * front reaches the listener, then play with distance gain, air-absorption low-pass and pan
 * computed at arrival (close = sharp crack + boom; far = late, dark rolling thunder).
 */
import type { FrameContext } from '../../core/contracts';
import type { GameEventMap } from '../../core/events';
import type { ExplosionSize } from '../../core/types';
import {
  distanceGain,
  explosionLoudness,
  explosionRange,
  explosionRefDistance,
  SPEED_OF_SOUND,
} from '../acoustics';
import { CANOPY_GAIN, makeLocated, type Listener, type Located } from '../core/Listener';
import type { SynthEnv } from '../synth/build';
import { airframeHit, bulletImpact, explosion, hitConfirm, motorIgnition, samLaunch, transonicThump } from '../synth/recipes';
import { DelayQueue } from './DelayQueue';

type PendingKind = 'explosion' | 'sam' | 'launch';

interface Pending {
  kind: PendingKind;
  size: ExplosionSize;
  surface: 'air' | 'ground' | 'water';
  heavy: boolean;
  x: number;
  y: number;
  z: number;
}

const HEAVY_SAM = new Set(['m_48n6', 'm_3m9']);

export class ImpactSounds {
  private readonly queue = new DelayQueue<Pending>(24, () => ({ kind: 'explosion', size: 'small', surface: 'air', heavy: false, x: 0, y: 0, z: 0 }));
  private readonly loc: Located = makeLocated();
  private lastHit = -1;
  private lastImpact = -1;
  private lastConfirm = -1;
  private lastTiny = -1;
  /** Listener for the pre-bound arrival callback (no per-frame closure). */
  private L: Listener | null = null;
  private readonly arrive = (p: Pending): void => {
    if (this.L) this.play(p, this.L);
  };

  constructor(private readonly env: SynthEnv) {}

  /* ───────────── events ───────────── */

  onExplosion(e: GameEventMap['explosion'], ctx: FrameContext, L: Listener): void {
    const range = explosionRange(e.size);
    L.locate(e.position, this.loc);
    if (this.loc.distance > range) return;
    const p = this.enqueue('explosion', e.position.x, e.position.y, e.position.z, ctx.time, range);
    p.size = e.size;
    p.surface = e.surface;
  }

  onLaunch(e: GameEventMap['munition:launch'], ctx: FrameContext, L: Listener): void {
    const shooter = e.shooter;
    if (ctx.player && shooter.id === ctx.player.id) return;
    const m = e.missile;
    L.locate(m.position, this.loc);
    if (shooter.kind === 'sam') {
      if (this.loc.distance > 15000) return;
      const p = this.enqueue('sam', m.position.x, m.position.y, m.position.z, ctx.time, 15000);
      p.heavy = HEAVY_SAM.has(m.def.id);
    } else if (shooter.kind === 'aircraft') {
      if (this.loc.distance > 6000) return;
      this.enqueue('launch', m.position.x, m.position.y, m.position.z, ctx.time, 6000);
    }
  }

  onPlayerHit(e: GameEventMap['player:hit'], ctx: FrameContext, L: Listener): void {
    const now = this.env.ctx.currentTime;
    if (now - this.lastHit < 0.06) return;
    this.lastHit = now;
    const k = Math.min(1, 0.25 + e.amount / 40);
    const p = ctx.player;
    if (L.interior || !p) airframeHit(this.env, now + 0.005, k);
    else {
      L.locate(p.position, this.loc);
      const g = distanceGain(this.loc.distance, 25, 1500);
      if (g > 0.02) airframeHit(this.env, now + 0.005, k, { gain: g, pan: this.loc.pan, cutoff: L.cutoffFor(this.loc) });
    }
  }

  onGunImpact(e: GameEventMap['gun:impact'], ctx: FrameContext, L: Listener): void {
    const now = this.env.ctx.currentTime;
    const p = ctx.player;
    if (p && e.targetId === p.id) {
      // rounds striking our own airframe
      if (now - this.lastHit < 0.07) return;
      this.lastHit = now;
      if (L.interior) airframeHit(this.env, now + 0.005, 0.4);
      return;
    }
    // "hit confirm" when our rounds strike a hostile
    if (e.surface === 'target' && p && p.gunFiring && e.targetId != null) {
      const t = ctx.world.getEntity(e.targetId);
      if (t && t.team !== p.team && now - this.lastConfirm > 0.08) {
        this.lastConfirm = now;
        hitConfirm(this.env, now + 0.005);
      }
    }
    L.locate(e.position, this.loc);
    if (this.loc.distance > 280 || now - this.lastImpact < 0.04) return;
    this.lastImpact = now;
    const g = distanceGain(this.loc.distance, 15, 300) * (L.interior ? CANOPY_GAIN : 1);
    if (g > 0.03) bulletImpact(this.env, now + 0.005, e.surface, { gain: g, pan: this.loc.pan, cutoff: L.cutoffFor(this.loc) });
  }

  onTransonic(e: GameEventMap['transonic'], ctx: FrameContext, L: Listener): void {
    if (L.interior && ctx.player && e.aircraft === ctx.player && e.supersonic) transonicThump(this.env, this.env.ctx.currentTime + 0.01);
  }

  /* ───────────── per frame ───────────── */

  update(ctx: FrameContext, L: Listener): void {
    this.flush(ctx, L);
  }

  private enqueue(kind: PendingKind, x: number, y: number, z: number, t0: number, range: number): Pending {
    const p = this.queue.push(x, y, z, t0, range / SPEED_OF_SOUND + 1);
    p.kind = kind;
    p.heavy = false;
    p.x = x;
    p.y = y;
    p.z = z;
    return p;
  }

  private flush(ctx: FrameContext, L: Listener): void {
    this.L = L;
    this.queue.update(ctx.time, L.pos.x, L.pos.y, L.pos.z, this.arrive);
  }

  private play(p: Pending, L: Listener): void {
    const env = this.env;
    const when = env.ctx.currentTime + 0.005;
    const loc = this.loc;
    L.locate(p, loc);
    const cutoff = L.cutoffFor(loc);
    const canopy = L.interior ? CANOPY_GAIN : 1;
    if (p.kind === 'explosion') {
      if (p.size === 'tiny') {
        // flak / cannon shells: rate-limit so a Shilka burst doesn't eat the pool
        if (when - this.lastTiny < 0.05) return;
        this.lastTiny = when;
      }
      const g = explosionLoudness(p.size) * distanceGain(loc.distance, explosionRefDistance(p.size), explosionRange(p.size), 0.85) * canopy;
      if (g < 0.004) return;
      explosion(env, when, p.size, p.surface, loc.distance, { gain: g, pan: loc.pan, cutoff });
    } else if (p.kind === 'sam') {
      const g = 2 * distanceGain(loc.distance, 150, 15000, 0.6) * canopy;
      if (g > 0.004) samLaunch(env, when, p.heavy, { gain: g, pan: loc.pan, cutoff });
    } else {
      const g = distanceGain(loc.distance, 25, 6000, 0.9) * canopy * 0.8;
      if (g > 0.004) motorIgnition(env, when, false, { gain: g, pan: loc.pan, cutoff });
    }
  }

  clear(): void {
    this.queue.clear();
  }
}
