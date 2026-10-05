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
 *   route:<r>   (#198) the jet flies a fixed route a player could try (ROUTE_PROBES: the straight line,
 *               a detour, high above everything, or the intended way through with its AARGM shots),
 *               then the mission bot takes over for the attack at the end. A missile inbound is the
 *               bot's to defend (beam, chaff) wherever the route is. `--route=killall` instead attacks
 *               every hostile SAM site it can, nearest first, before the bot goes for the objective.
 *
 * Pinning the jet's position each step can trip the flight model's overstress like any scripted pin
 * would; health is restored every step, so the park probes never die of it.
 */
import { Vector3 } from 'three';
import type { MissionDef } from '../src/core/contracts';
import type { SimWorld } from '../src/sim/api';
import type { AircraftEntity, SamSiteEntity } from '../src/sim/entities';
import type { MissionBot } from './missions-bot';

export type ProbeSpec = { kind: 'park'; at: 'start' | 'far' } | { kind: 'gunonly' } | { kind: 'route'; route: string };

/**
 * One leg of a route probe: fly to (x, z) at `alt` m MSL (`minAgl`: how low the autopilot may go,
 * default 150 m), in burner when `ab`; `shoot` fires an AARGM at that SAM site (its mission id) on
 * the way, and the leg isn't done until the missile is off (or the site is dead or out of reach).
 */
export interface RouteLeg {
  x: number;
  z: number;
  alt: number;
  minAgl?: number;
  /** m/s (default 250, or flat out in burner). */
  speed?: number;
  ab?: boolean;
  shoot?: string;
  /** Fire the leg's AARGM only inside this range of the site (m; default: on the launch-zone cue). */
  within?: number;
  /** Attack this SAM site (mission id) as the bot attacks a target, with whatever it carries for it, until a weapon is off at it or it is dead. */
  attack?: string;
}

/** The pseudo-route that attacks every SAM site instead of flying a path. */
export const KILL_ALL = 'killall';

/**
 * Route probes (#198), by mission id then route name. g03's are the ways a player could try to reach
 * the Onetangi nest (tests/missions-g03.test.ts checks the same routes' rings on the map):
 *  - straight: the direct line at 10,000 ft, nothing clever;
 *  - north / south: round the defences low over the water, either side of the islands;
 *  - wide: round Waiheke's east end in burner, outside every ring until the end;
 *  - high: above every SAM ceiling (43,000 ft) to overhead the nest;
 *  - golden: the intended way through: out of the harbour and down the Tāmaki Strait as low as the jet
 *    goes (the Motuihe SA-6 sees down it but can't engage under its 80 m floor; the Tor stands 8 km off),
 *    an AARGM at the strait's patrol boat, a second at the airstrip SA-6 from inside 7 km (fired from
 *    far out it only silences the radar for seconds), then the attack from under the cloud at one of the
 *    stoat's stops (#200: the bot holds off while it runs);
 *  - golden_north: the same idea round the north (AARGMs at the two northern boats), slower and less sure.
 */
export const ROUTE_PROBES: Record<string, Record<string, RouteLeg[]>> = {
  g03: {
    straight: [{ x: 22_000, z: -6_500, alt: 3_000 }],
    north: [
      { x: 5_000, z: -11_000, alt: 300 },
      { x: 20_000, z: -13_000, alt: 300 },
      { x: 25_000, z: -9_500, alt: 300 },
    ],
    south: [
      { x: 12_000, z: 3_000, alt: 300 },
      { x: 26_000, z: 3_000, alt: 300 },
      { x: 27_000, z: -2_500, alt: 600 },
    ],
    wide: [
      { x: 12_000, z: 3_000, alt: 300, ab: true },
      { x: 36_500, z: 3_000, alt: 300, ab: true },
      { x: 36_500, z: -9_000, alt: 300, ab: true },
      { x: 32_000, z: -8_500, alt: 300, ab: true },
    ],
    high: [{ x: 28_250, z: -6_700, alt: 13_000, ab: true }],
    golden: [
      { x: -4_000, z: -2_000, alt: 150, speed: 320 },
      { x: 4_000, z: -1_000, alt: 45, minAgl: 25, speed: 260 },
      { x: 11_000, z: 1_500, alt: 45, minAgl: 25, speed: 260 },
      { x: 16_000, z: 3_700, alt: 45, minAgl: 25, speed: 260, shoot: 'ad_s' },
      { x: 22_000, z: 3_500, alt: 45, minAgl: 25, speed: 260 },
      { x: 26_000, z: -1_000, alt: 45, minAgl: 25, speed: 260, shoot: 'strip_sa6', within: 7_000 },
    ],
    golden_north: [
      { x: -4_000, z: -2_000, alt: 150, speed: 320 },
      { x: 4_500, z: -6_000, alt: 60, minAgl: 40, speed: 320 },
      { x: 5_000, z: -10_000, alt: 60, minAgl: 40, speed: 320 },
      { x: 9_000, z: -11_000, alt: 150, minAgl: 40, speed: 300, shoot: 'ad_n1' },
      { x: 16_000, z: -11_500, alt: 60, minAgl: 40, speed: 320 },
      { x: 21_000, z: -10_500, alt: 150, minAgl: 40, speed: 300, shoot: 'ad_n2' },
      { x: 25_000, z: -8_500, alt: 60, minAgl: 40, speed: 300 },
    ],
  },
};

/** The routes a mission has probes for (with `killall`, which every mission has). */
export function routeNames(missionId: string): string[] {
  return [...Object.keys(ROUTE_PROBES[missionId] ?? {}), KILL_ALL];
}

/** Where `--park=far` parks the player: the playtest exploit charter's spot. */
export const PARK_FAR = { x: -35_000, y: 13_000, z: 35_000 };

/**
 * The probe asked for on a bot-sweep command line (parsed `--name=value` args): `--park` (= start),
 * `--park=start`, `--park=far`, `--gunonly`; null for the plain bot. Throws on a bad value or both.
 */
export function parseProbe(args: Record<string, string>): ProbeSpec | null {
  const park = 'park' in args;
  const gun = 'gunonly' in args;
  const route = 'route' in args;
  if (park && gun) throw new Error('--park and --gunonly are separate probes: pick one');
  if (route && (park || gun)) throw new Error('--route is a probe of its own: drop --park / --gunonly');
  if (route) {
    if (!args.route) throw new Error('--route=<name>: a route of ROUTE_PROBES (tests/missions-probes.ts) or killall');
    return { kind: 'route', route: args.route };
  }
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
  if (spec.kind === 'route') return `route:${spec.route}`;
  return spec.kind === 'park' ? `park:${spec.at}` : 'gunonly';
}

const _pt = new Vector3();

/** One run's probe: runPlaythrough calls it around every sim step. */
export class Probe {
  /** Gun rounds the player fired. */
  gunRounds = 0;
  private readonly at: { x: number; y: number; z: number };
  private readonly fuel: number;
  private ammo: number;
  /** Route probe: its legs (empty for killall) and the next one to fly. */
  private readonly legs: RouteLeg[] = [];
  private leg = 0;
  /** Route probe: SAM sites already shot at by a leg (entity ids). */
  private readonly shotAt = new Set<number>();

  constructor(
    readonly spec: ProbeSpec,
    private readonly world: SimWorld,
    private readonly p: AircraftEntity,
    private readonly bot: MissionBot,
    private readonly def: MissionDef | null = null,
  ) {
    this.at = spec.kind === 'park' && spec.at === 'far' ? PARK_FAR : { x: p.position.x, y: p.position.y, z: p.position.z };
    this.fuel = p.flight.fuel;
    this.ammo = p.gunAmmo;
    if (spec.kind === 'route' && spec.route !== KILL_ALL) {
      const legs = def ? ROUTE_PROBES[def.id]?.[spec.route] : undefined;
      if (!legs) throw new Error(`--route=${spec.route}: no such route for ${def?.id ?? 'this mission'} (${def ? routeNames(def.id).join(', ') : 'none'})`);
      this.legs = legs;
    }
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
    } else if (this.spec.kind === 'gunonly') for (const s of p.stores) s.count = 0;
  }

  /** After each world step: count the gun rounds. */
  afterStep(): void {
    this.gunRounds += Math.max(0, this.ammo - this.p.gunAmmo);
    this.ammo = this.p.gunAmmo;
  }

  /**
   * The bot's turn (every 3rd step): true when the probe flew the jet itself (parked: nothing at all;
   * gun-only: the air-to-air bot, never going home Winchester; a route: its legs), false to let the
   * mission bot fly.
   */
  fly(dt: number): boolean {
    if (this.spec.kind === 'park') {
      this.bot.mode = 'PARKED';
      return true;
    }
    if (this.spec.kind === 'route') return this.spec.route === KILL_ALL ? this.killAll(dt) : this.route(dt);
    const air = this.bot.air;
    this.bot.mode = 'GUNONLY';
    air.opts.rtbWhenWinchester = false;
    air.update(this.p, this.world, dt);
    return true;
  }

  /** Fly the route's legs; the mission bot defends against missiles and takes over after the last leg. */
  private route(dt: number): boolean {
    const p = this.p;
    if (this.leg >= this.legs.length) {
      this.bot.defenceAgl = 120;
      return false;
    }
    const leg = this.legs[this.leg];
    // a missile inbound is the bot's to defend, as low as the leg flies
    this.bot.defenceAgl = Math.max(40, Math.min(120, (leg.minAgl ?? 150) + 20));
    if (p.incoming.length > 0) return false;
    if (leg.attack) {
      const site = this.site(leg.attack);
      const busy = !!site && this.world.missiles.some((m) => m.alive && m.shooterId === p.id && m.targetId === site.id && m.def.category === 'bomb');
      if (!site || !site.alive || busy) {
        this.leg++;
        return this.route(dt);
      }
      this.bot.attack(site, dt);
      this.bot.mode = `ROUTE${this.leg + 1}:ATTACK`;
      return true;
    }
    const d = Math.hypot(leg.x - p.position.x, leg.z - p.position.z);
    const site = leg.shoot ? this.site(leg.shoot) : null;
    const shooting = !!site && site.alive && !this.shotAt.has(site.id);
    // a leg ends at its point, or (a shooting leg) as soon as its shot is away: no turning back for the point
    if ((!shooting && d < 1_500) || (leg.shoot && !shooting)) {
      this.leg++;
      return this.route(dt);
    }
    this.bot.navTo(_pt.set(leg.x, 0, leg.z), leg.alt, `ROUTE${this.leg + 1}`, dt, !!leg.ab, leg.minAgl ?? 150, leg.speed);
    if (shooting && site) {
      if (this.shoot(site, leg.within ?? Infinity) || d < 1_500) this.shotAt.add(site.id); // fired, or the leg ran out: move on
    }
    return true;
  }

  /**
   * An AARGM at `site` on the way: select it, designate the site when it is a contact, fire on the
   * launch-zone cue. True once our missile is off at it.
   */
  private shoot(site: SamSiteEntity, within: number): boolean {
    const p = this.p;
    const w = this.world;
    const c = w.combat;
    for (const m of w.missiles) if (m.alive && m.shooterId === p.id && m.targetId === site.id) return true;
    if (c.remaining(p, 'aargm') <= 0) return true;
    if (p.selectedWeapon !== 'aargm') c.selectWeapon(p, 'aargm', w);
    if (p.radar.designatedId !== site.id) c.designate(p, site.id, w);
    const z = c.launchZone(p, w);
    if (p.radar.designatedId === site.id && z && z.targetId === site.id && z.shoot && site.position.distanceTo(p.position) <= within) p.input.fireWeapon = true;
    return false;
  }

  /** The live SAM entity of a mission site id: the one standing (or sailing) nearest its briefed spot. */
  private site(id: string): SamSiteEntity | null {
    const def = this.def?.script.sams.find((s) => s.id === id);
    if (!def) throw new Error(`route probe: no SAM site "${id}" in ${this.def?.id}`);
    let best: SamSiteEntity | null = null;
    let bd = Infinity;
    for (const s of this.world.sams) {
      if (s.type !== def.type || s.groupId !== def.group) continue;
      const dd = Math.hypot(s.position.x - def.x, s.position.z - def.z);
      if (dd < bd) {
        bd = dd;
        best = s;
      }
    }
    return best;
  }

  /** killall: attack every live hostile SAM site, nearest first, while there is anything to attack with. */
  private killAll(dt: number): boolean {
    const p = this.p;
    if (p.incoming.length > 0) return false;
    const c = this.world.combat;
    if (c.remaining(p, 'aargm') + c.remaining(p, 'gbu53') + c.remaining(p, 'gbu31') <= 0) return false;
    let best: SamSiteEntity | null = null;
    let bd = Infinity;
    for (const s of this.world.sams) {
      if (!s.alive || s.team === p.team) continue;
      const dd = s.position.distanceTo(p.position);
      if (dd < bd) {
        bd = dd;
        best = s;
      }
    }
    if (!best) return false;
    this.bot.attack(best, dt);
    this.bot.mode = `KILLALL:${best.type}`;
    return true;
  }
}
