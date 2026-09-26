/**
 * F35-A audio — aircraft engines in the world.
 *
 *  - the player's F135: cockpit mix in cockpit/hud views, full external mix otherwise
 *    (chase / orbit / flyby / target / missile / tactical / death cam)
 *  - the few nearest other aircraft (wingmen, bandits, bombers) — quality-scaled pool,
 *    re-assigned every 0.25 s, each with Doppler, pan, air absorption and flyby lag
 *  - afterburner light-off "whump"
 *  - sonic booms: a supersonic jet's Mach cone sweeping over the listener
 */
import { Vector3 } from 'three';
import type { FrameContext } from '../../core/contracts';
import type { AircraftEntity } from '../../sim/entities';
import { distanceGain, SPEED_OF_SOUND } from '../acoustics';
import { CANOPY_GAIN, makeLocated, type Listener, type Located } from '../core/Listener';
import type { SynthEnv } from '../synth/build';
import { ENGINE_PROFILES, JetEngineVoice, makeEngineDrive, type EngineDrive } from '../synth/JetEngineVoice';
import type { NoiseBank } from '../synth/NoiseBank';
import { abLightOff, sonicBoom } from '../synth/recipes';

const _fwd = new Vector3();
const _rel = new Vector3();
const REASSIGN = 0.25;

export class JetSounds {
  private readonly player: JetEngineVoice;
  private readonly ai: JetEngineVoice[] = [];
  private readonly aiTarget: (AircraftEntity | null)[] = [];
  private readonly loc: Located = makeLocated();
  private readonly drive: EngineDrive = makeEngineDrive();
  private reassignIn = 0;
  private prevAb = 0;
  /** Per aircraft: was the listener inside its Mach cone last frame (supersonic only). */
  private readonly heard = new Map<number, boolean>();
  private readonly cand: AircraftEntity[] = [];
  private readonly candD: number[] = [];
  private boomCooldown = 0;

  constructor(
    private readonly env: SynthEnv,
    noise: NoiseBank,
    quality: 'low' | 'medium' | 'high',
  ) {
    const dest = env.mixer.bus.engine;
    this.player = new JetEngineVoice(env.ctx, noise.set(0), dest, quality);
    // the ~3 nearest other aircraft (1 on low quality); AI voices use the lighter layer set
    const n = quality === 'low' ? 1 : 3;
    for (let i = 0; i < n; i++) {
      this.ai.push(new JetEngineVoice(env.ctx, noise.set(1), dest, quality === 'high' ? 'medium' : 'low'));
      this.aiTarget.push(null);
    }
  }

  update(now: number, dt: number, ctx: FrameContext, L: Listener): void {
    const world = ctx.world;
    const p = ctx.player;
    this.updatePlayer(now, ctx, L, p);

    // other aircraft
    this.reassignIn -= dt;
    if (this.reassignIn <= 0) {
      this.reassignIn = REASSIGN;
      this.assign(world.aircraft, p, L);
    }
    for (let i = 0; i < this.ai.length; i++) {
      const ac = this.aiTarget[i];
      const v = this.ai[i];
      v.gate(now, !!ac && ac.alive);
      if (!ac || !ac.alive) {
        v.silence(now, 0.15);
        this.aiTarget[i] = null;
        continue;
      }
      const prof = ENGINE_PROFILES[ac.type] ?? ENGINE_PROFILES.f35a;
      const loc = this.loc;
      if (!L.locateMoving(ac.position, ac.velocity, loc)) {
        v.silence(now, 0.03);
        continue;
      }
      const d = this.drive;
      d.profile = prof;
      d.rpm = ac.flight.engineRpm;
      d.ab = ac.flight.afterburner;
      d.speed = ac.flight.tas;
      d.interior = false;
      d.gain = distanceGain(loc.distance, prof.ref, prof.maxDist * (1 + 0.35 * d.ab), 1) * (L.interior ? CANOPY_GAIN : 1) * 1.1;
      d.pan = loc.pan;
      d.cutoff = L.cutoffFor(loc);
      d.doppler = loc.doppler;
      this.directivity(ac, loc, d);
      v.update(now, d);
    }

    // sonic booms (Mach cone passing over the listener)
    this.boomCooldown -= dt;
    for (const ac of world.aircraft) {
      if (!ac.alive) continue;
      const own = ac === p;
      if (own && L.interior) continue;
      const spd = ac.velocity.length();
      if (spd < SPEED_OF_SOUND * 1.01) {
        this.heard.delete(ac.id);
        continue;
      }
      const dist = ac.position.distanceTo(L.pos);
      if (dist > 12000) continue;
      const inside = L.locateMoving(ac.position, ac.velocity, this.loc);
      const was = this.heard.get(ac.id);
      this.heard.set(ac.id, inside);
      // a boom is the shock sweeping over the listener: not for a camera co-moving with the jet
      // (orbit / chase slowly crossing the cone boundary)
      const relSq = _rel.subVectors(ac.velocity, L.vel).lengthSq();
      if (was === false && inside && this.boomCooldown <= 0 && relSq > SPEED_OF_SOUND * SPEED_OF_SOUND) {
        this.boomCooldown = 0.4;
        const g = distanceGain(this.loc.distance, 150, 12000, 0.7) * (L.interior ? CANOPY_GAIN : 1);
        if (g > 0.01) sonicBoom(this.env, this.env.ctx.currentTime + 0.01, { gain: g, pan: this.loc.pan, cutoff: L.cutoffFor(this.loc) });
      }
    }
    if (this.heard.size > 64) this.heard.clear();
  }

  private updatePlayer(now: number, ctx: FrameContext, L: Listener, p: AircraftEntity | null): void {
    const v = this.player;
    v.gate(now, !!p);
    if (!p) {
      v.silence(now);
      return;
    }
    const d = this.drive;
    d.profile = ENGINE_PROFILES[p.type] ?? ENGINE_PROFILES.f35a;
    d.rpm = p.flight.engineRpm;
    d.ab = p.flight.afterburner;
    d.speed = p.flight.tas;
    // wreck: fade out a couple of seconds after destruction; crashed = silent
    let life = 1;
    if (!p.alive) {
      const since = p.destroyedAt >= 0 ? ctx.time - p.destroyedAt : 0;
      life = p.crashed ? 0 : Math.max(0, 1 - since / 3);
      d.ab = 0;
    }
    if (L.interior) {
      d.interior = true;
      d.gain = life;
      d.pan = 0;
      d.cutoff = 6500;
      d.doppler = 1;
      d.front = d.aft = 0;
      d.side = 1;
    } else {
      d.interior = false;
      const loc = this.loc;
      if (!L.locateMoving(p.position, p.velocity, loc)) {
        v.silence(now, 0.02);
        this.prevAb = d.ab;
        return;
      }
      d.gain = life * distanceGain(loc.distance, d.profile.ref, d.profile.maxDist * (1 + 0.35 * d.ab), 1);
      d.pan = loc.pan;
      d.cutoff = L.cutoffFor(loc);
      d.doppler = loc.doppler;
      this.directivity(p, loc, d);
    }
    v.update(now, d);

    // afterburner light-off
    if (d.ab > 0.04 && this.prevAb <= 0.04 && p.alive) {
      const t = this.env.ctx.currentTime + 0.01;
      if (L.interior) abLightOff(this.env, t, 0.9);
      else if (d.gain > 0.02) abLightOff(this.env, t, 1, { gain: d.gain, pan: d.pan, cutoff: d.cutoff });
    }
    this.prevAb = d.ab;
  }

  /** Front / aft / side weights from the jet's nose vs the direction to the listener. */
  private directivity(ac: AircraftEntity, loc: Located, d: EngineDrive): void {
    _fwd.set(0, 0, -1).applyQuaternion(ac.quaternion);
    const a = _fwd.x * loc.ux + _fwd.y * loc.uy + _fwd.z * loc.uz;
    d.front = a > 0 ? a : 0;
    d.aft = a < 0 ? -a : 0;
    d.side = 1 - Math.abs(a);
  }

  /** Pick the nearest other aircraft for the pooled voices (keeps existing assignments). */
  private assign(list: readonly AircraftEntity[], p: AircraftEntity | null, L: Listener): void {
    const cand = this.cand;
    const cd = this.candD;
    cand.length = 0;
    cd.length = 0;
    for (const ac of list) {
      if (!ac.alive || ac === p) continue;
      const prof = ENGINE_PROFILES[ac.type] ?? ENGINE_PROFILES.f35a;
      const dist = ac.position.distanceTo(L.pos);
      if (dist > prof.maxDist * 1.2) continue;
      // insertion into a short sorted list
      let i = cd.length;
      while (i > 0 && cd[i - 1] > dist) i--;
      if (i >= this.ai.length) continue;
      cand.splice(i, 0, ac);
      cd.splice(i, 0, dist);
      if (cand.length > this.ai.length) {
        cand.length = this.ai.length;
        cd.length = this.ai.length;
      }
    }
    // keep voices whose aircraft are still wanted
    for (let i = 0; i < this.aiTarget.length; i++) {
      const cur = this.aiTarget[i];
      if (cur && cand.indexOf(cur) < 0) this.aiTarget[i] = null;
    }
    for (const ac of cand) {
      if (this.aiTarget.indexOf(ac) >= 0) continue;
      const free = this.aiTarget.indexOf(null);
      if (free < 0) break;
      this.aiTarget[free] = ac;
    }
  }

  silence(now: number): void {
    this.player.silence(now, 0.02);
    for (const v of this.ai) v.silence(now, 0.02);
    this.aiTarget.fill(null);
  }

  dispose(): void {
    this.player.dispose();
    for (const v of this.ai) v.dispose();
    this.ai.length = 0;
  }
}
