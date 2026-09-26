/**
 * F35-A audio — the continuous-sound graph of one mission: shared noise sources, engines,
 * weapons, impacts, avionics tones and cockpit ambience. Built lazily on the first frame of a
 * mission (once audio is unlocked) and torn down by stopAll(), so nothing keeps running
 * (or burning battery) in the menus.
 */
import type { FrameContext } from '../../core/contracts';
import type { QualityLevel } from '../../core/types';
import type { Listener } from '../core/Listener';
import type { SynthEnv } from '../synth/build';
import { NoiseBank } from '../synth/NoiseBank';
import { AvionicsSounds } from './AvionicsSounds';
import { CockpitSounds } from './CockpitSounds';
import { ImpactSounds } from './ImpactSounds';
import { JetSounds } from './JetSounds';
import { WeaponSounds } from './WeaponSounds';

export class SessionSounds {
  readonly noise: NoiseBank;
  readonly jets: JetSounds;
  readonly weapons: WeaponSounds;
  readonly impacts: ImpactSounds;
  readonly avionics: AvionicsSounds;
  readonly cockpit: CockpitSounds;

  constructor(
    env: SynthEnv,
    readonly quality: QualityLevel,
  ) {
    this.noise = new NoiseBank(env.ctx, env.buffers, 2);
    this.jets = new JetSounds(env, this.noise, quality);
    this.weapons = new WeaponSounds(env, this.noise, quality);
    this.impacts = new ImpactSounds(env);
    this.avionics = new AvionicsSounds(env, this.noise);
    this.cockpit = new CockpitSounds(env, this.noise);
  }

  update(now: number, dt: number, ctx: FrameContext, L: Listener): void {
    this.jets.update(now, dt, ctx, L);
    this.weapons.update(now, dt, ctx, L);
    this.impacts.update(ctx, L);
    this.avionics.update(now, ctx);
    this.cockpit.update(now, dt, ctx, L, this.avionics.stress);
  }

  /** Silence continuous voices (pause) without tearing the graph down. */
  silence(now: number): void {
    this.jets.silence(now);
    this.weapons.silence(now);
    this.avionics.silence(now);
    this.cockpit.silence(now);
  }

  dispose(): void {
    this.impacts.clear();
    this.jets.dispose();
    this.weapons.dispose();
    this.avionics.dispose();
    this.cockpit.dispose();
    this.noise.dispose();
  }
}
