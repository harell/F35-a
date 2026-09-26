/**
 * F35-A audio — the pilot's environment: airflow / buffet / ECS ambience, G-suit, and the
 * breathing rhythm in the oxygen mask (calm → fast under threat, AGSM strain above ~5.5 G).
 */
import type { FrameContext } from '../../core/contracts';
import type { Listener } from '../core/Listener';
import type { SynthEnv } from '../synth/build';
import { BreathingScheduler, CockpitAmbience, type AmbienceDrive } from '../synth/CockpitAmbience';
import type { NoiseBank } from '../synth/NoiseBank';
import { breath, gsuitDeflate } from '../synth/recipes';

export class CockpitSounds {
  private readonly amb: CockpitAmbience;
  private readonly breathing = new BreathingScheduler();
  private readonly drive: AmbienceDrive = { interior: true, alive: true, ias: 0, tas: 0, alpha: 0, mach: 0, gLoad: 1, buffet: 0, stress: 0 };
  private clock = 0;
  private gPeak = 1;
  private stress = 0;

  constructor(
    private readonly env: SynthEnv,
    noise: NoiseBank,
  ) {
    this.amb = new CockpitAmbience(env.ctx, noise.set(0), env.mixer.bus.engine);
    this.breathing.reset(0);
  }

  update(now: number, dt: number, ctx: FrameContext, L: Listener, threat: number): void {
    const p = ctx.player;
    const d = this.drive;
    if (!p) {
      this.amb.silence(now);
      return;
    }
    const f = p.flight;
    d.interior = L.interior;
    d.alive = p.alive && !p.crashed;
    d.ias = p.alive ? f.ias : 0;
    d.tas = f.tas;
    d.alpha = f.alpha;
    d.mach = f.mach;
    d.gLoad = f.gLoad;
    // prefer the flight model's buffet; otherwise derive it from AoA / stall
    d.buffet = p.buffet ?? (f.stalled ? 0.8 : Math.max(0, Math.min(1, (f.alpha - 0.3) / 0.25)) * Math.min(1, f.ias / 120));
    this.stress += (threat - this.stress) * Math.min(1, dt * (threat > this.stress ? 4 : 0.3));
    d.stress = this.stress;
    this.amb.update(now, dt, d);

    // pilot: G-suit dump + breathing (cockpit views only, alive)
    this.clock += dt;
    if (!L.interior || !d.alive) {
      this.gPeak = 1;
      return;
    }
    const g = f.gLoad;
    if (g > this.gPeak) this.gPeak = g;
    if (this.gPeak > 4.5 && g < 2.5) {
      gsuitDeflate(this.env, now + 0.01, Math.min(1, (this.gPeak - 3) / 5));
      this.gPeak = g;
    } else if (g < 2) this.gPeak = Math.min(this.gPeak, 2);
    // approaching G-LOC (Ace): the pilot strains hard (anti-G straining grunts) as a warning
    const gEff = (p.gloc ?? 0) > 0.7 ? Math.max(g, 9.5) : g;
    const b = this.breathing.update(this.clock, gEff, this.stress);
    if (b) breath(this.env, now + 0.01, b, b === 'strain' ? 0.5 : 0.28 + 0.12 * this.stress);
  }

  silence(now: number): void {
    this.amb.silence(now);
  }

  dispose(): void {
    this.amb.dispose();
  }
}
