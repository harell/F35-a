/**
 * MISSIONS — sweep probes (#118): "what if the player does X" runs of runPlaythrough() that the
 * playtests used to hand-write (bot-sweep `--park` / `--gunonly`).
 *
 *   park:start  the jet stays at its start (after the run's jitter), at the start's height: no input,
 *               no shot, kept unhurt and fuelled, so only the friendlies and the enemy act. Can a
 *               mission be won (or its objectives credited) by waiting?
 *   park:far    the same, parked where the exploit charter parks (35 km south-west of the city, 13 km
 *               up; `FAR` in tests/missions-balance.test.ts): out of the fight entirely.
 *   gunonly     the player's stores are emptied every step (nothing can add missiles or bombs back)
 *               and the air-to-air bot presses on with the gun instead of going home (the gun-only
 *               probe of runBalanceMission, tests/ai-playerbot.ts). Counts the rounds fired.
 *
 * Pinning the jet's position each step can trip the flight model's overstress like any scripted pin
 * would; health is restored every step, so the park probes never die of it.
 */
import type { SimWorld } from '../src/sim/api';
import type { AircraftEntity } from '../src/sim/entities';
import type { MissionBot } from './missions-bot';

export type ProbeSpec = { kind: 'park'; at: 'start' | 'far' } | { kind: 'gunonly' };

/** Where `--park=far` parks the player: the playtest exploit charter's spot. */
export const PARK_FAR = { x: -35_000, y: 13_000, z: 35_000 };

/**
 * The probe asked for on a bot-sweep command line (parsed `--name=value` args): `--park` (= start),
 * `--park=start`, `--park=far`, `--gunonly`; null for the plain bot. Throws on a bad value or both.
 */
export function parseProbe(args: Record<string, string>): ProbeSpec | null {
  const park = 'park' in args;
  const gun = 'gunonly' in args;
  if (park && gun) throw new Error('--park and --gunonly are separate probes: pick one');
  if (gun) {
    if (args.gunonly) throw new Error(`--gunonly takes no value (got ${args.gunonly})`);
    return { kind: 'gunonly' };
  }
  if (!park) return null;
  const at = args.park || 'start';
  if (at !== 'start' && at !== 'far') throw new Error(`--park=${at}: start or far`);
  return { kind: 'park', at };
}

/** The probe's name in sweep rows and logs: 'park:start', 'park:far', 'gunonly', or 'bot' (none). */
export function probeLabel(spec: ProbeSpec | null | undefined): string {
  if (!spec) return 'bot';
  return spec.kind === 'park' ? `park:${spec.at}` : 'gunonly';
}

/** One run's probe: runPlaythrough calls it around every sim step. */
export class Probe {
  /** Gun rounds the player fired. */
  gunRounds = 0;
  private readonly at: { x: number; y: number; z: number };
  private readonly fuel: number;
  private ammo: number;

  constructor(
    readonly spec: ProbeSpec,
    private readonly world: SimWorld,
    private readonly p: AircraftEntity,
    private readonly bot: MissionBot,
  ) {
    this.at = spec.kind === 'park' && spec.at === 'far' ? PARK_FAR : { x: p.position.x, y: p.position.y, z: p.position.z };
    this.fuel = p.flight.fuel;
    this.ammo = p.gunAmmo;
    this.beforeStep();
  }

  get label(): string {
    return probeLabel(this.spec);
  }

  /** Before each world step: the parked jet is pinned (unhurt, fuelled); gun-only empties the stores. */
  beforeStep(): void {
    const p = this.p;
    if (this.spec.kind === 'park') {
      p.position.set(this.at.x, this.at.y, this.at.z);
      p.health = p.maxHealth;
      p.flight.fuel = this.fuel;
    } else for (const s of p.stores) s.count = 0;
  }

  /** After each world step: count the gun rounds. */
  afterStep(): void {
    this.gunRounds += Math.max(0, this.ammo - this.p.gunAmmo);
    this.ammo = this.p.gunAmmo;
  }

  /**
   * The bot's turn (every 3rd step): true when the probe flew the jet itself (parked: nothing at all;
   * gun-only: the air-to-air bot, never going home Winchester), false to let the mission bot fly.
   */
  fly(dt: number): boolean {
    if (this.spec.kind === 'park') {
      this.bot.mode = 'PARKED';
      return true;
    }
    const air = this.bot.air;
    this.bot.mode = 'GUNONLY';
    air.opts.rtbWhenWinchester = false;
    air.update(this.p, this.world, dt);
    return true;
  }
}
