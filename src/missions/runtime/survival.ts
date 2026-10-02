/**
 * F35-A — Instant Action "survival": endless waves of bandits, each bigger and sharper than the
 * last, until the player goes down. Score = waves cleared. Optional rearm between waves.
 */
import { clamp, mulberry32 } from '../../core/math';
import { AIRCRAFT_PERF } from '../../sim/flight/aircraftData';
import type { AircraftGroupDef } from '../schema';
import { armMissionGun } from './gunAmmo';
import { spawnAirGroup } from './spawner';
import { aliveCount, drivenOffCount, type GroupRt, type MissionState } from './state';
import { aircraftHudName } from './names';

export class SurvivalDirector {
  private wave = 0;
  private current: GroupRt | null = null;
  private nextAt = 6;
  private readonly rng: () => number;

  constructor(private readonly s: MissionState) {
    this.rng = mulberry32((s.def.seed ^ 0x5eed) >>> 0);
  }

  get wavesCleared(): number {
    return this.s.waves;
  }

  update(): void {
    const s = this.s;
    const cfg = s.script.survival;
    const p = s.player;
    if (!cfg || s.state !== 'running' || !p || !p.alive) return;
    const t = s.time;

    if (this.current) {
      // a wave is cleared when every bandit is dead or driven off (a crippled MiG running home
      // must not hold the next wave back forever)
      if (this.current.members.length > 0 && aliveCount(this.current) - drivenOffCount(s, this.current) <= 0) {
        s.waves++;
        this.current = null;
        this.nextAt = t + cfg.interWaveDelay;
        s.hud(`WAVE ${this.wave} CLEARED`, 'good', 3);
        s.radio.push({ from: s.awacsCallsign, text: `${s.callsign}, ${s.awacsSpoken}, wave ${this.wave} destroyed. Stand by for the next group.`, voice: 'a_good_kill', priority: 2 });
        if (cfg.rearm) this.rearm();
      }
      return;
    }
    if (t < this.nextAt) return;
    this.spawnWave();
  }

  private rearm(): void {
    const s = this.s;
    const p = s.player!;
    if (p.loadout) {
      s.world.combat.applyLoadout(p, p.loadout);
      armMissionGun(p, s.def, s.difficulty.id);
    }
    p.health = Math.min(p.maxHealth, p.health + 20);
    p.damage.fire = false;
    // top the tanks up to at least half
    const cap = AIRCRAFT_PERF[p.type].internalFuel;
    p.flight.fuel = Math.max(p.flight.fuel, cap * 0.5);
    s.hud('REARMED — +20 HP', 'info', 2.5);
  }

  private spawnWave(): void {
    const s = this.s;
    const cfg = s.script.survival!;
    const p = s.player!;
    this.wave++;
    const n = Math.min(cfg.maxCount, Math.floor(cfg.baseCount + cfg.growth * (this.wave - 1)));
    // modern types join as the waves get sharper: MiG-29 / Su-27 first, Su-35 from wave 4,
    // Su-57 from wave 7 (a single-type choice is used as is)
    const pool = cfg.types.length > 1 ? cfg.types.filter((t) => (t !== 'su35' || this.wave >= 4) && (t !== 'su57' || this.wave >= 7)) : cfg.types;
    const types = pool.length > 0 ? pool : cfg.types;
    const type = types[Math.floor(this.rng() * types.length) % types.length];
    // spawn ahead-ish of the player (±70°), facing them
    const bearing = Math.atan2(p.velocity.x, -p.velocity.z) + (this.rng() - 0.5) * 2.4;
    const lim = 34_000;
    const x = clamp(p.position.x + Math.sin(bearing) * cfg.spawnDistance, -lim, lim);
    const z = clamp(p.position.z - Math.cos(bearing) * cfg.spawnDistance, -lim, lim);
    const altitude = clamp(p.position.y + (this.rng() - 0.3) * 2500, 1500, 9000);
    const heading = (Math.atan2(p.position.x - x, -(p.position.z - z)) * 180) / Math.PI;
    const def: AircraftGroupDef = {
      id: `wave${this.wave}`,
      type,
      team: 'red',
      count: n,
      fixedCount: true,
      formation: n >= 4 ? 'box' : 'pair',
      x,
      z,
      altitude,
      heading: (heading + 360) % 360,
      speed: 240,
      role: this.wave % 3 === 0 ? 'interceptor' : 'fighter',
      skill: clamp(cfg.skillStart + cfg.skillStep * (this.wave - 1), 0, 1),
      task: { kind: 'attack_player' },
    };
    const g: GroupRt = { id: def.id, team: 'red', air: def, expected: n, members: [], spawnedAt: -1, announced: false, threatCalled: false };
    s.groups.set(g.id, g);
    spawnAirGroup(s, g);
    this.current = g;
    s.hud(`WAVE ${this.wave}: ${n} × ${aircraftHudName(type)}`, 'warn', 3);
  }
}
