/**
 * F35-A audio — one-way attack drones (Shahed-136) in the world: the buzz of the nearest few,
 * from a small pool of PistonBuzzVoices re-assigned every 0.25 s (the jet engine pool in
 * JetSounds leaves drones out). Wrecks fall silent.
 */
import type { FrameContext } from '../../core/contracts';
import type { AircraftEntity } from '../../sim/entities';
import { distanceGain } from '../acoustics';
import { CANOPY_GAIN, makeLocated, type Listener, type Located } from '../core/Listener';
import type { SynthEnv } from '../synth/build';
import type { NoiseBank } from '../synth/NoiseBank';
import { BUZZ_MAX_DIST, BUZZ_REF, PistonBuzzVoice } from '../synth/PistonBuzzVoice';

const REASSIGN = 0.25;

/** Aircraft that buzz instead of roaring (piston engine + propeller). */
export function isBuzzing(ac: AircraftEntity): boolean {
  return ac.type === 'shahed136';
}

export class DroneSounds {
  private readonly voices: PistonBuzzVoice[] = [];
  private readonly target: (AircraftEntity | null)[] = [];
  private readonly loc: Located = makeLocated();
  private reassignIn = 0;

  constructor(env: SynthEnv, noise: NoiseBank, quality: 'low' | 'medium' | 'high') {
    const n = quality === 'low' ? 1 : 2;
    for (let i = 0; i < n; i++) {
      this.voices.push(new PistonBuzzVoice(env.ctx, noise.set(i % 2), env.mixer.bus.engine));
      this.target.push(null);
    }
  }

  update(now: number, dt: number, ctx: FrameContext, L: Listener): void {
    this.reassignIn -= dt;
    if (this.reassignIn <= 0) {
      this.reassignIn = REASSIGN;
      this.assign(ctx.world.aircraft, L);
    }
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      const ac = this.target[i];
      v.gate(now, !!ac && ac.alive);
      if (!ac || !ac.alive) {
        v.silence(now, 0.15);
        this.target[i] = null;
        continue;
      }
      if (!L.locateMoving(ac.position, ac.velocity, this.loc)) {
        v.silence(now, 0.03);
        continue;
      }
      const loc = this.loc;
      const gain = distanceGain(loc.distance, BUZZ_REF, BUZZ_MAX_DIST, 1) * (L.interior ? CANOPY_GAIN : 1);
      v.targetId = ac.id;
      v.update(now, gain, loc.pan, L.cutoffFor(loc), loc.doppler);
    }
  }

  /** The nearest drones within earshot get the voices (existing assignments are kept). */
  private assign(list: readonly AircraftEntity[], L: Listener): void {
    const n = this.voices.length;
    const best: AircraftEntity[] = [];
    const bestD: number[] = [];
    for (const ac of list) {
      if (!ac.alive || !isBuzzing(ac)) continue;
      const d = ac.position.distanceTo(L.pos);
      if (d > BUZZ_MAX_DIST * 1.2) continue;
      let i = bestD.length;
      while (i > 0 && bestD[i - 1] > d) i--;
      if (i >= n) continue;
      best.splice(i, 0, ac);
      bestD.splice(i, 0, d);
      best.length = Math.min(best.length, n);
      bestD.length = Math.min(bestD.length, n);
    }
    for (let i = 0; i < n; i++) {
      const cur = this.target[i];
      if (cur && best.indexOf(cur) < 0) this.target[i] = null;
    }
    for (const ac of best) {
      if (this.target.indexOf(ac) >= 0) continue;
      const free = this.target.indexOf(null);
      if (free < 0) break;
      this.target[free] = ac;
    }
  }

  silence(now: number): void {
    for (const v of this.voices) v.silence(now, 0.02);
    this.target.fill(null);
  }

  dispose(): void {
    for (const v of this.voices) v.dispose();
    this.voices.length = 0;
  }
}
