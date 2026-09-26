/**
 * F35-A audio — headset avionics: RWR (new emitter / spike / launch), DAS missile warning,
 * AIM-9X growl, own-radar lock tones, weapon select / designate / denied feedback.
 */
import type { FrameContext } from '../../core/contracts';
import type { GameEventMap } from '../../core/events';
import type { SynthEnv } from '../synth/build';
import type { NoiseBank } from '../synth/NoiseBank';
import { denied, designateTick, lockConfirm, lockLost, rwrNew, weaponSelect } from '../synth/recipes';
import { makeWarningDrive, WarningTones } from '../synth/WarningTones';

export class AvionicsSounds {
  private readonly tones: WarningTones;
  private readonly drive = makeWarningDrive();
  private lastNew = -1;
  private lastDenied = -1;
  private lastDesignate = -1;
  private lastLock = -1;

  constructor(
    private readonly env: SynthEnv,
    noise: NoiseBank,
  ) {
    this.tones = new WarningTones(env.ctx, noise.set(0), env.mixer.bus.warn);
  }

  private t(): number {
    return this.env.ctx.currentTime + 0.005;
  }

  onRwrNew(e: GameEventMap['rwr:new']): void {
    const now = this.env.ctx.currentTime;
    if (now - this.lastNew < 0.35) return;
    this.lastNew = now;
    rwrNew(this.env, this.t(), e.contact.kind);
  }

  onLock(e: GameEventMap['lock'], playerId: number): void {
    if (e.ownerId !== playerId) return;
    const now = this.env.ctx.currentTime;
    if (e.locked) {
      this.lastLock = now;
      lockConfirm(this.env, this.t());
    } else if (e.targetId != null && now - this.lastLock > 0.3) {
      lockLost(this.env, this.t());
    }
  }

  onDesignate(e: GameEventMap['designate'], playerId: number): void {
    if (e.ownerId !== playerId || e.targetId == null) return;
    const now = this.env.ctx.currentTime;
    if (now - this.lastDesignate < 0.12) return;
    this.lastDesignate = now;
    designateTick(this.env, this.t());
  }

  onWeaponSelect(e: GameEventMap['weapon:select'], playerId: number): void {
    if (e.ownerId === playerId) weaponSelect(this.env, this.t(), e.weapon);
  }

  onDenied(e: GameEventMap['weapon:denied'], playerId: number): void {
    if (e.ownerId !== playerId) return;
    const now = this.env.ctx.currentTime;
    if (now - this.lastDenied < 0.4) return;
    this.lastDenied = now;
    denied(this.env, this.t());
  }

  update(now: number, ctx: FrameContext): void {
    const d = this.drive;
    const p = ctx.player;
    d.spike = d.spikeGround = d.launch = false;
    d.mawsTti = -1;
    d.growl = 'off';
    if (p && p.alive) {
      for (let i = 0; i < p.rwr.length; i++) {
        const c = p.rwr[i];
        if (c.state === 'launch') d.launch = true;
        else if (c.state === 'track') {
          d.spike = true;
          if (c.kind === 'sam' || c.kind === 'aaa') d.spikeGround = true;
        }
      }
      for (let i = 0; i < p.incoming.length; i++) {
        const tti = Math.max(0, p.incoming[i].timeToImpact);
        if (d.mawsTti < 0 || tti < d.mawsTti) d.mawsTti = tti;
      }
      if (p.selectedWeapon === 'aim9x') {
        try {
          d.growl = ctx.world.combat.irSeekerState(p).state;
        } catch {
          d.growl = 'off';
        }
      }
    }
    this.tones.update(now, d);
  }

  /** 0..1 threat level (drives the pilot's breathing rate). */
  get stress(): number {
    return this.drive.mawsTti >= 0 ? 1 : this.drive.launch ? 0.8 : this.drive.spike ? 0.45 : 0;
  }

  silence(now: number): void {
    this.tones.silence(now);
  }

  dispose(): void {
    this.tones.dispose();
  }
}
