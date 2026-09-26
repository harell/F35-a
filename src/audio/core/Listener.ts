/**
 * F35-A audio — the listener (camera) and spatialisation of world sounds.
 *
 * Positions come from the camera's world matrix; the listener velocity (for Doppler) is the
 * velocity of what the camera follows (player in cockpit/chase/orbit/target, the missile in
 * missile-cam, zero for the fixed flyby camera) — exact, no jitter from frame-time noise.
 * In the tactical map view the "ears" sit on the player's jet.
 *
 * `interior` = the listener sits inside the player's cockpit (cockpit / hud views): external
 * sounds are muffled by the canopy, the player's own engine uses the cockpit mix.
 */
import { Vector3 } from 'three';
import type { FrameContext } from '../../core/contracts';
import type { CameraMode } from '../../core/types';
import {
  airAbsorptionCutoff,
  dopplerFactor,
  distanceGain,
  retardedTime,
  SPEED_OF_SOUND,
  stereoPan,
} from '../acoustics';

/** Result of locating a sound source (reused objects — copy what you keep). */
export interface Located {
  /** Distance from the (emission) position to the listener (m). */
  distance: number;
  /** −1..1 */
  pan: number;
  /** 1 = straight behind the listener's head, 0 = in front. */
  behind: number;
  /** Doppler ratio (1 for static sources). */
  doppler: number;
  /** Unit vector from the emission point to the listener. */
  ux: number;
  uy: number;
  uz: number;
  /** Retarded time (s) for moving sources; −1 = not audible yet (ahead of the Mach cone). */
  tau: number;
}

export function makeLocated(): Located {
  return { distance: 0, pan: 0, behind: 0, doppler: 1, ux: 0, uy: 0, uz: 1, tau: 0 };
}

/** Canopy transmission for external sounds heard from inside the cockpit. */
export const CANOPY_GAIN = 0.7;
export const CANOPY_CUTOFF = 1400;

export class Listener {
  readonly pos = new Vector3();
  readonly vel = new Vector3();
  readonly right = new Vector3(1, 0, 0);
  readonly fwd = new Vector3(0, 0, -1);
  interior = false;
  mode: CameraMode = 'cockpit';
  /** Seconds since the view mode changed (for crossfades). */
  modeAge = 0;
  valid = false;

  private readonly e = new Vector3();

  update(ctx: FrameContext): void {
    const cam = ctx.camera;
    const p = ctx.player;
    this.valid = !!cam;
    if (!cam) return;
    if (ctx.viewMode !== this.mode) {
      this.mode = ctx.viewMode;
      this.modeAge = 0;
    } else this.modeAge += ctx.dt;
    const m = cam.matrixWorld.elements;
    this.right.set(m[0], m[1], m[2]).normalize();
    this.fwd.set(-m[8], -m[9], -m[10]).normalize();
    const alive = !!p && p.alive;
    this.interior = alive && (ctx.viewMode === 'cockpit' || ctx.viewMode === 'hud');
    if (ctx.viewMode === 'tactical' && p) {
      // top-down map: listen from just above the player's jet
      this.pos.set(p.position.x, p.position.y + 40, p.position.z);
      this.vel.copy(p.velocity);
      return;
    }
    this.pos.set(m[12], m[13], m[14]);
    switch (ctx.viewMode) {
      case 'flyby':
        this.vel.set(0, 0, 0);
        break;
      case 'missile': {
        const f = ctx.world?.getEntity(ctx.focusId);
        if (f && f.alive) this.vel.copy(f.velocity);
        else this.vel.set(0, 0, 0);
        break;
      }
      default:
        if (p && p.alive) this.vel.copy(p.velocity);
        else this.vel.set(0, 0, 0);
    }
  }

  /** Static source (explosion, SAM site…). */
  locate(p: Readonly<{ x: number; y: number; z: number }>, out: Located): Located {
    const dx = this.pos.x - p.x;
    const dy = this.pos.y - p.y;
    const dz = this.pos.z - p.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    out.distance = d;
    out.doppler = 1;
    out.tau = d / SPEED_OF_SOUND;
    this.direction(dx, dy, dz, d, out);
    return out;
  }

  /**
   * Moving source with retarded-time propagation (flyby lag, Doppler, Mach cone).
   * Returns false (and out.tau = −1) when the sound has not reached the listener yet.
   */
  locateMoving(p: Vector3, v: Vector3, out: Located): boolean {
    const dx = this.pos.x - p.x;
    const dy = this.pos.y - p.y;
    const dz = this.pos.z - p.z;
    const tau = retardedTime(dx, dy, dz, v.x, v.y, v.z);
    out.tau = tau;
    if (tau < 0) {
      out.distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      out.doppler = 1;
      this.direction(dx, dy, dz, out.distance, out);
      return false;
    }
    // emission point = p − v·τ → vector emission→listener = D + v·τ
    const ex = dx + v.x * tau;
    const ey = dy + v.y * tau;
    const ez = dz + v.z * tau;
    const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
    out.distance = d;
    this.direction(ex, ey, ez, d, out);
    out.doppler = dopplerFactor(out.ux, out.uy, out.uz, v.x, v.y, v.z, this.vel.x, this.vel.y, this.vel.z);
    return true;
  }

  /** Emission point of the last locateMoving (world). */
  emissionPoint(p: Vector3, v: Vector3, tau: number): Vector3 {
    return this.e.copy(p).addScaledVector(v, -Math.max(0, tau));
  }

  private direction(dx: number, dy: number, dz: number, d: number, out: Located): void {
    if (d > 1e-4) {
      out.ux = dx / d;
      out.uy = dy / d;
      out.uz = dz / d;
    } else {
      out.ux = 0;
      out.uy = 0;
      out.uz = 1;
    }
    // direction listener → source is −u
    const dotR = -(out.ux * this.right.x + out.uy * this.right.y + out.uz * this.right.z);
    const dotF = -(out.ux * this.fwd.x + out.uy * this.fwd.y + out.uz * this.fwd.z);
    out.pan = stereoPan(dotR, d);
    out.behind = dotF < 0 ? -dotF : 0;
  }

  /** Gain for a located external source, incl. canopy transmission when inside the cockpit. */
  gainFor(loc: Located, ref: number, maxDist: number, exponent = 1): number {
    const g = distanceGain(loc.distance, ref, maxDist, exponent);
    return this.interior ? g * CANOPY_GAIN : g;
  }

  /** Low-pass cutoff for a located external source (air absorption, head shadow, canopy). */
  cutoffFor(loc: Located): number {
    let c = airAbsorptionCutoff(loc.distance) * (1 - 0.35 * loc.behind);
    if (this.interior) c = Math.min(c, CANOPY_CUTOFF);
    return c;
  }
}
