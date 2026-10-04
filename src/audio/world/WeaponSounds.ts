/**
 * F35-A audio — guns, missiles and countermeasures.
 *
 *  - GAU-22 "brrrt" for the player (cockpit or external), pooled remote guns (enemy GSh-30,
 *    ZSU-23-4 Shilka bursts) placed in the world
 *  - internal weapons bay: hydraulic whirr + clunks driven by player.bayDoors
 *  - release: pneumatic eject thunk (bay AMRAAM), rack clunk (bombs), motor ignition
 *    crack/whoosh when the motor lights (polled after the eject delay)
 *  - motor roar voices following the nearest burning missiles (own shots departing, SAMs
 *    climbing at you, missiles whooshing past)
 *  - flare / chaff cartridges
 */
import type { FrameContext } from '../../core/contracts';
import type { GameEventMap } from '../../core/events';
import type { AircraftEntity, MissileEntity } from '../../sim/entities';
import { distanceGain } from '../acoustics';
import type { GunKind } from '../core/buffers';
import { CANOPY_GAIN, makeLocated, type Listener, type Located } from '../core/Listener';
import type { SynthEnv } from '../synth/build';
import { GunVoice } from '../synth/GunVoice';
import { MotorVoice } from '../synth/MotorVoice';
import type { NoiseBank } from '../synth/NoiseBank';
import { bayWhirr, chaffPop, clunk, ejectThunk, flarePop, gunTail, motorIgnition, sonicBoom } from '../synth/recipes';
import { SPEED_OF_SOUND } from '../acoustics';

const GUN_RANGE: Record<GunKind, number> = { gau22: 4000, gsh301: 3500, zsu23: 4500 };
const GUN_LEVEL: Record<GunKind, number> = { gau22: 1, gsh301: 0.9, zsu23: 0.85 };
const BIG_MOTORS = new Set(['m_3m9', 'm_9m330', 'aargm']);

interface Watch {
  missile: MissileEntity;
  t0: number;
}

export class WeaponSounds {
  private readonly playerGun: GunVoice;
  private readonly remote: GunVoice[] = [];
  private readonly motors: MotorVoice[] = [];
  private readonly loc: Located = makeLocated();
  private readonly watch: Watch[] = [];
  private motorAssignIn = 0;
  private prevBay = 0;
  private bayState: 'idle' | 'opening' | 'closing' = 'idle';
  private lastPop = { flare: -1, chaff: -1 };
  private readonly candM: MissileEntity[] = [];
  private readonly candD: number[] = [];

  constructor(
    private readonly env: SynthEnv,
    noise: NoiseBank,
    quality: 'low' | 'medium' | 'high',
  ) {
    const sfx = env.mixer.bus.sfx;
    this.playerGun = new GunVoice(env.ctx, env.buffers, noise.set(0), sfx, 'gau22');
    for (let i = 0; i < (quality === 'low' ? 1 : 2); i++) this.remote.push(new GunVoice(env.ctx, env.buffers, noise.set(1), sfx, 'gsh301'));
    const nm = quality === 'low' ? 2 : quality === 'medium' ? 3 : 4;
    for (let i = 0; i < nm; i++) this.motors.push(new MotorVoice(env.ctx, noise.set(i % 2), sfx));
  }

  /* ───────────── events ───────────── */

  onGunState(e: GameEventMap['gun:state'], ctx: FrameContext, L: Listener): void {
    const now = this.env.ctx.currentTime;
    const p = ctx.player;
    if (p && e.shooterId === p.id) {
      if (e.firing) this.playerGun.start(now, L.interior);
      else {
        this.playerGun.stop(now);
        const t = now + 0.02;
        if (L.interior) gunTail(this.env, t, 1, true);
        else {
          L.locate(p.position, this.loc);
          const g = distanceGain(this.loc.distance, 30, 4000);
          if (g > 0.02) gunTail(this.env, t, 1, false, { gain: g, pan: this.loc.pan, cutoff: L.cutoffFor(this.loc) });
        }
      }
      return;
    }
    const kind: GunKind = e.weapon;
    if (e.firing) {
      L.locate(e.position, this.loc);
      if (this.loc.distance > GUN_RANGE[kind]) return;
      let v = this.remote.find((r) => !r.firing) ?? null;
      if (!v) {
        // steal the farthest if the new shooter is closer
        let far = -1;
        let farD = this.loc.distance;
        for (let i = 0; i < this.remote.length; i++) {
          const s = ctx.world.getEntity(this.remote[i].shooterId);
          const d = s ? s.position.distanceTo(L.pos) : Infinity;
          if (d > farD) {
            farD = d;
            far = i;
          }
        }
        if (far < 0) return;
        v = this.remote[far];
        v.kill(now);
      }
      v.kind = kind;
      v.shooterId = e.shooterId;
      v.start(now, false);
    } else {
      for (const v of this.remote) if (v.shooterId === e.shooterId && v.firing) v.stop(now);
    }
  }

  onLaunch(e: GameEventMap['munition:launch'], ctx: FrameContext, L: Listener): void {
    const p = ctx.player;
    if (!p || e.shooter.id !== p.id) return;
    const m = e.missile;
    const t = this.env.ctx.currentTime + 0.005;
    // ejector / rack is only audible near the jet; the ignition may still be heard (missile cam)
    const sp = L.interior ? undefined : this.spatialAt(p, L, 25, 1500);
    if (sp !== null) {
      if (m.def.launch === 'eject') ejectThunk(this.env, t, L.interior ? 0.9 : 1, sp);
      else if (m.def.launch === 'drop') clunk(this.env, t, L.interior ? 1 : 1.2, sp);
    }
    if (m.def.category !== 'bomb') this.watch.push({ missile: m, t0: t });
    if (this.watch.length > 8) this.watch.shift();
  }

  onCountermeasure(e: GameEventMap['countermeasure'], ctx: FrameContext, L: Listener): void {
    const now = this.env.ctx.currentTime;
    const type = e.decoy.type;
    const own = !!ctx.player && e.ownerId === ctx.player.id;
    if (now - this.lastPop[type] < 0.045) return;
    let sp;
    if (own && L.interior) sp = { gain: 0.75, pan: 0, cutoff: 9000 };
    else {
      L.locate(e.decoy.position, this.loc);
      const g = distanceGain(this.loc.distance, 20, own ? 900 : 600) * (L.interior ? CANOPY_GAIN : 1);
      if (g < 0.02) return;
      sp = { gain: g, pan: this.loc.pan, cutoff: L.cutoffFor(this.loc) };
    }
    this.lastPop[type] = now;
    if (type === 'flare') flarePop(this.env, now + 0.005, sp);
    else chaffPop(this.env, now + 0.005, sp);
  }

  /* ───────────── per frame ───────────── */

  update(now: number, dt: number, ctx: FrameContext, L: Listener): void {
    const p = ctx.player;
    const world = ctx.world;

    // player gun placement
    this.playerGun.gate(now, this.playerGun.busy(now));
    if (this.playerGun.busy(now)) {
      if (!p || !p.alive) this.playerGun.stop(now);
      if (L.interior) this.playerGun.update(now, 1.4, -0.18, 7000);
      else if (p) {
        L.locate(p.position, this.loc);
        this.playerGun.update(now, 1.3 * distanceGain(this.loc.distance, 30, GUN_RANGE.gau22, 0.9), this.loc.pan, L.cutoffFor(this.loc));
      }
    }

    // remote guns follow their shooters
    for (const v of this.remote) {
      v.gate(now, v.shooterId >= 0 || v.busy(now));
      if (v.shooterId < 0) continue;
      const s = world.getEntity(v.shooterId);
      if (!s || !s.alive) {
        v.kill(now);
        continue;
      }
      L.locate(s.position, this.loc);
      const g = distanceGain(this.loc.distance, 40, GUN_RANGE[v.kind], 0.85) * GUN_LEVEL[v.kind] * (L.interior ? CANOPY_GAIN : 1);
      v.update(now, g, this.loc.pan, L.cutoffFor(this.loc));
      if (!v.firing && now - v.startedAt > 3) v.shooterId = -1;
    }

    this.updateBay(now, p, L);
    this.updateIgnitions(now, L);
    this.updateMotors(now, dt, world.missiles, L);
  }

  private updateBay(now: number, p: AircraftEntity | null, L: Listener): void {
    if (!p) return;
    const b = p.bayDoors;
    const prev = this.prevBay;
    this.prevBay = b;
    const g = L.interior ? 1 : distanceGain(p.position.distanceTo(L.pos), 15, 350);
    if (g < 0.02) {
      this.bayState = b > prev ? 'opening' : b < prev ? 'closing' : 'idle';
      return;
    }
    const t = this.env.ctx.currentTime + 0.005;
    if (b > prev + 1e-4 && this.bayState !== 'opening') {
      this.bayState = 'opening';
      bayWhirr(this.env, t, true, g);
    } else if (b < prev - 1e-4 && this.bayState !== 'closing') {
      this.bayState = 'closing';
      bayWhirr(this.env, t, false, g);
    }
    if (this.bayState === 'opening' && b >= 0.999) {
      this.bayState = 'idle';
      clunk(this.env, t, 0.7 * g);
    } else if (this.bayState === 'closing' && b <= 0.001) {
      this.bayState = 'idle';
      clunk(this.env, t, 0.8 * g);
    }
  }

  /** Motor ignition crack for the player's own missiles (after the eject / drop delay). */
  private updateIgnitions(now: number, L: Listener): void {
    for (let i = this.watch.length - 1; i >= 0; i--) {
      const w = this.watch[i];
      const m = w.missile;
      if (!m.alive || now - w.t0 > 4) {
        this.watch.splice(i, 1);
        continue;
      }
      if (!m.motorBurning) continue;
      this.watch.splice(i, 1);
      L.locate(m.position, this.loc);
      const g = distanceGain(this.loc.distance, 20, 3000) * (L.interior ? 1 : 1.2);
      if (g > 0.02) motorIgnition(this.env, now + 0.005, BIG_MOTORS.has(m.def.id), { gain: g, pan: this.loc.pan, cutoff: L.interior ? 2500 : L.cutoffFor(this.loc) });
    }
  }

  private updateMotors(now: number, dt: number, missiles: readonly MissileEntity[], L: Listener): void {
    this.motorAssignIn -= dt;
    if (this.motorAssignIn <= 0) {
      this.motorAssignIn = 0.2;
      const cand = this.candM;
      const cd = this.candD;
      cand.length = 0;
      cd.length = 0;
      const n = this.motors.length;
      for (const m of missiles) {
        if (!m.alive || !m.motorBurning) continue;
        const big = BIG_MOTORS.has(m.def.id) || m.def.category === 'sam';
        const d = m.position.distanceTo(L.pos);
        if (d > (big ? 7000 : 4000)) continue;
        let i = cd.length;
        while (i > 0 && cd[i - 1] > d) i--;
        if (i >= n) continue;
        cand.splice(i, 0, m);
        cd.splice(i, 0, d);
        if (cand.length > n) {
          cand.length = n;
          cd.length = n;
        }
      }
      // release voices whose missile dropped out, then give free voices to new candidates
      for (const v of this.motors) {
        if (v.missileId >= 0 && !hasMissile(cand, v.missileId)) v.silence(now, 0.08);
      }
      for (const m of cand) {
        let taken = false;
        let free: MotorVoice | null = null;
        for (const v of this.motors) {
          if (v.missileId === m.id) taken = true;
          else if (v.missileId < 0 && !free) free = v;
        }
        if (!taken && free) free.missileId = m.id;
      }
    }
    for (const v of this.motors) {
      v.gate(now, v.missileId >= 0);
      if (v.missileId < 0) continue;
      const m = findMissile(missiles, v.missileId);
      if (!m || !m.alive || !m.motorBurning) {
        v.silence(now, 0.12);
        continue;
      }
      const big = BIG_MOTORS.has(m.def.id) || m.def.category === 'sam';
      const heard = L.locateMoving(m.position, m.velocity, this.loc);
      // supersonic near miss: the missile's shock wave cracks past the listener
      if (heard && v.heard === false && this.loc.distance < 450 && m.velocity.lengthSq() > SPEED_OF_SOUND * SPEED_OF_SOUND) {
        const g = 0.7 * distanceGain(this.loc.distance, 40, 450) * (L.interior ? CANOPY_GAIN : 1);
        if (g > 0.02) sonicBoom(this.env, now + 0.005, { gain: g, pan: this.loc.pan, cutoff: L.cutoffFor(this.loc) });
      }
      v.heard = heard;
      if (!heard) {
        v.update(now, 0, 0, 1000, 1, big);
        continue;
      }
      const g = distanceGain(this.loc.distance, big ? 30 : 16, big ? 7000 : 4000) * (big ? 1.3 : 1.1) * (L.interior ? CANOPY_GAIN : 1);
      v.update(now, g, this.loc.pan, L.cutoffFor(this.loc), this.loc.doppler, big);
    }
  }

  private spatialAt(ac: AircraftEntity, L: Listener, ref: number, max: number): { gain: number; pan: number; cutoff: number } | null {
    L.locate(ac.position, this.loc);
    const g = distanceGain(this.loc.distance, ref, max);
    if (g < 0.02) return null;
    return { gain: g, pan: this.loc.pan, cutoff: L.cutoffFor(this.loc) };
  }

  silence(now: number): void {
    this.playerGun.kill(now);
    for (const v of this.remote) v.kill(now);
    for (const v of this.motors) v.silence(now, 0.02);
    this.watch.length = 0;
    this.prevBay = 0;
    this.bayState = 'idle';
  }

  dispose(): void {
    this.playerGun.dispose();
    for (const v of this.remote) v.dispose();
    for (const v of this.motors) v.dispose();
  }
}

function hasMissile(list: readonly MissileEntity[], id: number): boolean {
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return true;
  return false;
}

function findMissile(list: readonly MissileEntity[], id: number): MissileEntity | null {
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}
