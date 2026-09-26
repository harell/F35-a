/**
 * F35-A — ICAWS (integrated caution & warning system) for the player (SIM-CORE).
 *
 * Evaluated every sim step; each warning has an on-delay and an off-delay (hysteresis) so the
 * Betty voice and HUD cues don't chatter. Changes are published in `player.warnings` and as
 * 'warning' {id, active} events.
 */
import { Vector3 } from 'three';
import { G } from '../core/math';
import type { WarningId } from '../core/types';
import type { SimWorld } from './api';
import type { AircraftEntity } from './entities';
import { AIRCRAFT_PERF } from './flight/aircraftData';
import { alphaLimits, gLimits } from './flight/controlLaws';

interface Rule {
  /** Condition must hold this long before the warning appears (s). */
  on: number;
  /** Condition must be clear this long before the warning goes away (s). */
  off: number;
}

const RULES: Record<WarningId, Rule> = {
  pull_up: { on: 0, off: 0.8 },
  altitude: { on: 0.3, off: 1.0 },
  stall: { on: 0.15, off: 0.6 },
  over_g: { on: 0.1, off: 0.8 },
  bingo: { on: 1, off: 3 },
  fuel_low: { on: 1, off: 3 },
  engine_fire: { on: 0, off: 0.5 },
  engine_fail: { on: 0.2, off: 1 },
  hydraulics: { on: 0.2, off: 1 },
  damage: { on: 0, off: 1 },
  missile: { on: 0, off: 1.5 },
  spike: { on: 0, off: 1.2 },
  flares_low: { on: 0.2, off: 1 },
  chaff_low: { on: 0.2, off: 1 },
  speed_low: { on: 0.6, off: 1 },
};
const IDS = Object.keys(RULES) as WarningId[];

/** Thresholds (exported for tests / HUD documentation). */
export const WARNING_THRESHOLDS = {
  /** Look-ahead for the pull-up cue at the current velocity (s), plus pull-out time in dives. */
  pullUpTime: 4,
  /** 500 ft AGL. */
  altitudeAgl: 152.4,
  bingoFraction: 0.18,
  fuelLowFraction: 0.3,
  /** 140 kt. */
  speedLowIas: 72,
  countermeasuresLow: 4,
};

const _dir = new Vector3();
const _gl = { max: 9, min: -3 };
const _al = { max: 0.5, min: -0.2 };

export class WarningSystem {
  private readonly onTime = {} as Record<WarningId, number>;
  private readonly offTime = {} as Record<WarningId, number>;
  private readonly cond = {} as Record<WarningId, boolean>;
  private maxFlares = 0;
  private maxChaff = 0;
  private probeTimer = 0;
  private pullUpPredicted = false;
  private tracked: AircraftEntity | null = null;

  constructor() {
    this.reset();
  }

  reset(): void {
    for (const id of IDS) {
      this.onTime[id] = 0;
      this.offTime[id] = 0;
      this.cond[id] = false;
    }
    this.maxFlares = 0;
    this.maxChaff = 0;
    this.probeTimer = 0;
    this.pullUpPredicted = false;
    this.tracked = null;
  }

  update(world: SimWorld, dt: number): void {
    const p = world.player;
    if (p !== this.tracked) {
      this.reset();
      this.tracked = p;
    }
    if (!p) return;
    const c = this.cond;
    if (!p.alive) {
      for (let i = 0; i < IDS.length; i++) c[IDS[i]] = false;
      this.applyAll(world, p, dt, true);
      return;
    }
    const f = p.flight;
    const perf = p.sim?.perf ?? AIRCRAFT_PERF[p.type];
    const assisted = world.difficulty.flightAssist;

    this.probeTimer -= dt;
    if (this.probeTimer <= 0) {
      this.probeTimer = 0.05;
      this.pullUpPredicted = this.predictTerrainImpact(world, p);
    }
    c.pull_up = this.pullUpPredicted;
    c.altitude = f.agl < WARNING_THRESHOLDS.altitudeAgl && f.verticalSpeed < -1.5;

    const al = alphaLimits(perf, assisted, _al);
    const aoaLimit = assisted ? al.max : perf.alphaStall;
    c.stall = f.stalled || (f.alpha > aoaLimit - 0.6 * (Math.PI / 180) && f.gLoad < 0.9);

    let heavy = 0;
    for (let i = 0; i < p.stores.length; i++) {
      const s = p.stores[i];
      if (!s.internal && s.weapon === 'gbu31') heavy += s.count;
    }
    const gl = gLimits(perf, heavy, 0, true, _gl);
    c.over_g = f.gLoad > gl.max + 0.3 || f.gLoad < gl.min - 0.3;

    const fuelFrac = f.fuel / perf.internalFuel;
    c.bingo = fuelFrac < WARNING_THRESHOLDS.bingoFraction;
    c.fuel_low = !c.bingo && fuelFrac < WARNING_THRESHOLDS.fuelLowFraction;
    c.engine_fire = p.damage.fire;
    c.engine_fail = p.damage.engine >= 0.9 || f.fuel <= 0 || !!p.sim?.flamedOut;
    c.hydraulics = p.damage.hydraulics > 0.5;
    c.damage = p.health < 0.5 * p.maxHealth;
    c.missile = p.incoming.length > 0;
    let spike = false;
    for (let i = 0; i < p.rwr.length; i++) {
      const s = p.rwr[i].state;
      if (s === 'track' || s === 'launch') {
        spike = true;
        break;
      }
    }
    c.spike = spike;
    if (p.flares > this.maxFlares) this.maxFlares = p.flares;
    if (p.chaff > this.maxChaff) this.maxChaff = p.chaff;
    const low = WARNING_THRESHOLDS.countermeasuresLow;
    c.flares_low = this.maxFlares > low && p.flares <= low;
    c.chaff_low = this.maxChaff > low && p.chaff <= low;
    c.speed_low = f.ias < WARNING_THRESHOLDS.speedLowIas && !f.stalled;

    this.applyAll(world, p, dt, false);
  }

  private applyAll(world: SimWorld, p: AircraftEntity, dt: number, immediateOff: boolean): void {
    const events = world.events;
    for (let i = 0; i < IDS.length; i++) {
      const id = IDS[i];
      const rule = RULES[id];
      const active = p.warnings.has(id);
      if (this.cond[id]) {
        this.offTime[id] = 0;
        if (!active) {
          this.onTime[id] += dt;
          if (this.onTime[id] >= rule.on) {
            p.warnings.add(id);
            events.emit('warning', { id, active: true });
          }
        }
      } else {
        this.onTime[id] = 0;
        if (active) {
          this.offTime[id] += dt;
          if (immediateOff || this.offTime[id] >= rule.off) {
            p.warnings.delete(id);
            this.offTime[id] = 0;
            events.emit('warning', { id, active: false });
          }
        }
      }
    }
  }

  /**
   * Ground collision prediction: ray along the velocity vector, looking ahead 4 s plus the
   * time needed to pull the flight path out of the current dive at ~80 % of the g limit.
   */
  private predictTerrainImpact(world: SimWorld, p: AircraftEntity): boolean {
    const V = p.velocity.length();
    if (V < 30) return false;
    const perf = p.sim?.perf ?? AIRCRAFT_PERF[p.type];
    _dir.copy(p.velocity).multiplyScalar(1 / V);
    const gamma = Math.asin(Math.max(-1, Math.min(1, _dir.y)));
    const nAvail = Math.max(2, 0.8 * perf.maxG);
    const tPull = gamma < 0 ? Math.min(6, (V * -gamma) / (G * (nAvail - 1))) : 0;
    const look = V * (WARNING_THRESHOLDS.pullUpTime + tPull);
    const d = world.terrain.raycast(p.position, _dir, look);
    // (a hit reported exactly at the look-ahead limit is treated as "no hit")
    return d >= 0 && d < look * 0.999;
  }
}
