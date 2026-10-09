/**
 * F35-A — contextual HUD hints: scripted HintDefs plus built-in "auto hints" that react to what
 * the player is doing (training + early campaign) and always-on ones (Winchester / bingo).
 *
 * The weapon hints follow the SELECTED weapon and the real stores (names from WEAPON_INFO):
 *  - AMRAAM: tap the TD box (or TGT) to lock → point the nose (±30° lock cone) → wait for SHOOT
 *    → fire → crank 50°;
 *  - AIM-9X / gun: seeker tone / pipper;
 *  - AARGM: designate an emitting SAM, fire on SHOOT (never sent to a bomb while an AARGM cue is up);
 *  - SDB / JDAM: designate with TGT, release IN RANGE;
 *  - an A/A weapon selected while a surface objective is near: which A/G store to select.
 * Texts stay short; the HUD decides visibility (Settings.hints).
 */
import { WEAPON_INFO } from '../../core/data';
import { isHostile, type WeaponId } from '../../core/types';
import type { AircraftEntity, AnyEntity } from '../../sim/entities';
import { stallSpeedIas } from '../../sim/flight/performance';
import { evalCondition } from './conditions';
import { controlPrefsVersion, formatControls, savedControlPrefs, withActiveScheme } from './controlsText';
import { aircraftHudName } from './names';
import type { MissionState } from './state';
import type { WinchesterWatch } from './winchester';

interface AutoHint {
  id: string;
  /** Shown even when the mission has no autoHints (critical guidance): no show limit. */
  always?: boolean;
  /** Seconds before the rule may show again (default COOLDOWN; 0 = continuous). */
  cooldown?: number;
  /** Returns the hint text when it applies, else null. */
  test(p: AircraftEntity, s: MissionState, h: HintSystem): string | null;
}

const SHOW_TIME = 6;
const COOLDOWN = 25;
const MAX_SHOWS = 3;
const COS_LOCK_CONE = Math.cos((30 * Math.PI) / 180);

function remaining(p: AircraftEntity, w: WeaponId): number {
  if (w === 'gun') return p.gunAmmo;
  let n = 0;
  for (const st of p.stores) if (st.weapon === w) n += st.count;
  return n;
}

function hostileDesignated(p: AircraftEntity, s: MissionState): AnyEntity | null {
  const e = s.world.getEntity(p.radar.lockedId ?? p.radar.designatedId);
  return e && e.alive && isHostile(p.team, e.team) ? e : null;
}

/** Range (m) inside which flying slow behind a designated air target is a gun pass, not a mistake. */
export const SLOW_PASS_RANGE = 2_000;

/**
 * Slow on purpose: a hostile aircraft designated within SLOW_PASS_RANGE (a gun pass on a ~100 kt
 * Shahed) and the IAS still 10 % above the 1 g stall, not stalled. The "Too slow" hint keeps quiet then
 * (playtest: it fired through every g01 gun pass); the SPEED warning itself still sounds.
 */
export function slowGunPass(p: AircraftEntity, s: MissionState): boolean {
  if (p.warnings.has('stall') || p.flight.stalled || p.flight.ias < stallSpeedIas(p) * 1.1) return false;
  const e = hostileDesignated(p, s);
  return !!e && e.kind === 'aircraft' && e.position.distanceTo(p.position) < SLOW_PASS_RANGE;
}

/** Target within ±30° of the nose (the player's lock cone). */
function inLockCone(p: AircraftEntity, e: AnyEntity): boolean {
  const dx = e.position.x - p.position.x;
  const dy = e.position.y - p.position.y;
  const dz = e.position.z - p.position.z;
  const d = Math.hypot(dx, dy, dz);
  if (d < 1) return true;
  // body nose = -Z rotated by the aircraft quaternion
  const q = p.quaternion;
  const fx = -2 * (q.x * q.z + q.w * q.y);
  const fy = -2 * (q.y * q.z - q.w * q.x);
  const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
  return (fx * dx + fy * dy + fz * dz) / d >= COS_LOCK_CONE;
}

/** Radar SAM that is emitting (or known) — an AARGM target. */
function armTargetable(e: AnyEntity): boolean {
  return e.kind === 'sam' && e.type !== 'zsu23' && (e.radarOn || e.known);
}

/** Nearest live hostile surface target of an active PRIMARY objective within `within` m. */
function surfaceObjectiveTarget(s: MissionState, p: AircraftEntity, within: number): AnyEntity | null {
  let best: AnyEntity | null = null;
  let bestD = within;
  for (const o of s.objectives) {
    if (o.status.state !== 'active' || !o.def.primary) continue;
    const d = o.def;
    if (d.kind === 'destroy') {
      for (const id of d.groups) {
        const g = s.groups.get(id);
        if (!g || g.air) continue;
        for (const m of g.members) {
          if (!m.alive) continue;
          const r = m.position.distanceTo(p.position);
          if (r < bestD) {
            bestD = r;
            best = m;
          }
        }
      }
    } else if (d.kind === 'destroy_sams') {
      for (const site of s.world.sams) {
        if (!site.alive || site.team === p.team || Math.hypot(site.position.x - d.x, site.position.z - d.z) > d.radius) continue;
        const r = site.position.distanceTo(p.position);
        if (r < bestD) {
          bestD = r;
          best = site;
        }
      }
    }
  }
  return best;
}

/** SDB releases beyond this (m) glide so long and arrive so slow that point defences eat them. */
export const SDB_PRESS_RANGE = 22_000;

/** Best air-to-ground store for a target (AARGM for radars, then SDB II, then JDAM). */
function agWeaponFor(p: AircraftEntity, t: AnyEntity): WeaponId | null {
  if (armTargetable(t) && remaining(p, 'aargm') > 0) return 'aargm';
  if (remaining(p, 'gbu53') > 0) return 'gbu53';
  if (remaining(p, 'gbu31') > 0) return 'gbu31';
  return null;
}

/** Built-in hints, in priority order. */
const AUTO: AutoHint[] = [
  {
    id: 'defend',
    test(p, s) {
      if (p.incoming.length === 0) return null;
      const inc = p.incoming[0];
      const ir = inc.guidance === 'ir';
      const m = s.world.getEntity(inc.missileId);
      const shooter = m && m.kind === 'missile' ? s.world.getEntity(m.shooterId) : null;
      // short enough for one page: it must not page away while the missile flies
      // A SAM's round, measured against the SA-6, the Tor and the AD boat (2026-10-08): beam + chaff a few
      // seconds apart is the defence, and a dive after the launch adds nothing to the beam (the round
      // arrives in ~10 s). Against the boat's heat-seeker (real flight model, 48 rounds each): a hard turn
      // across it + CMS late 3 hit, CMS alone 5, the turn alone 12, nothing 15, a break INTO it 29 (head-on,
      // the end game's worst aspect). A fighter's missile (not measured; a longer flight) keeps the old advice.
      if (shooter && shooter.kind === 'sam') return ir ? 'IR MISSILE! Beam it hard, AB off, CMS late' : 'MISSILE! Beam it 90°, CMS every 2–3 s';
      return ir ? 'IR MISSILE! CMS, break into it, AB off' : 'MISSILE! Beam it 90°, dive, CMS late';
    },
  },
  {
    id: 'winchester',
    always: true,
    cooldown: 20,
    test(p, _s, h) {
      const w = h.winchester;
      if (!w) return null;
      // no rearming (issue #63): what's left is the gun and the wingmen
      if (w.current === 'winchester') return p.gunAmmo > 0 ? 'WINCHESTER: missiles and bombs gone — the gun is all you have left' : 'WINCHESTER: no weapons left — stay clear of the threats';
      if (w.current === 'bingo') return 'BINGO FUEL: finish the job before the tanks run dry';
      return null;
    },
  },
  {
    id: 'speed',
    test(p, s) {
      if (!p.warnings.has('speed_low') && !p.warnings.has('stall')) return null;
      return slowGunPass(p, s) ? null : 'Too slow — push the THROTTLE forward and ease off the stick';
    },
  },
  {
    id: 'aa',
    test(p, s, h) {
      const w = p.selectedWeapon;
      if (w !== 'aim120' && w !== 'aim9x' && w !== 'gun') return null;
      const e = hostileDesignated(p, s);
      if (!e || e.kind !== 'aircraft') {
        for (const c of p.radar.contacts) {
          if (!isHostile(p.team, c.team)) continue;
          const t = s.world.getEntity(c.id);
          if (t && t.alive && t.kind === 'aircraft') return `Tap the TD box (or TGT) to lock the ${aircraftHudName(t.type)}`;
        }
        return null;
      }
      const r = e.position.distanceTo(p.position);
      if (w === 'aim9x') return r < 8_000 ? 'Look at the bandit: fire the AIM-9X on the lock TONE' : null;
      if (w === 'gun') return r < 1_500 ? 'GUNS: pipper on the bandit, fire inside 1,200 m' : null;
      // AMRAAM: supporting a shot in flight → crank
      for (const m of s.world.missiles) {
        if (m.alive && m.shooterId === p.id && m.targetId === e.id && m.def.id === 'aim120') return 'Crank 50° off the bandit — keep it on the radar until the missile goes PITBULL';
      }
      if (p.radar.lockedId !== e.id && !inLockCone(p, e)) return 'Point the nose at the TD box: the lock builds inside 30°';
      const z = h.zone(p, s);
      if (z && z.shoot) return 'SHOOT — fire the AMRAAM, then crank 50°';
      if (z && z.range <= z.rMax && z.range >= z.rMin) return 'IN RANGE — wait for SHOOT: closer shots hit';
      return p.radar.lockedId === e.id ? 'Locked. Close in until SHOOT flashes' : null;
    },
  },
  {
    id: 'ag',
    test(p, s, h) {
      const w = p.selectedWeapon;
      const name = WEAPON_INFO[w].short;
      if (w === 'aargm') {
        const e = hostileDesignated(p, s);
        if (!e || !armTargetable(e)) return 'AARGM homes on radars: designate an emitting SAM with TGT, then fire';
        const z = h.zone(p, s);
        if (z && z.shoot) return 'SHOOT — fire the AARGM: it keeps homing even if the radar shuts down';
        return 'Close in: fire the AARGM when SHOOT shows';
      }
      if (w === 'gbu31' || w === 'gbu53') {
        const b = s.world.combat.bombImpactPoint(p, s.world);
        if (!p.radar.groundPoint) return `Tap TGT to designate a ground target for the ${name}`;
        if (b && b.inRange) {
          // an SDB lobbed from its 30 km maximum glides for 3+ minutes and arrives slow — easy
          // meat for a Tor / Osa: press in to ~20 km first
          const gp = p.radar.groundPoint;
          if (w !== 'gbu31' && Math.hypot(gp.x - p.position.x, gp.z - p.position.z) > SDB_PRESS_RANGE) return `IN RANGE — press in to 20 km: a max-range ${name} arrives slow and gets shot down`;
          return `IN RANGE — release the ${name}, it flies itself to the target`;
        }
        return `Fly toward the target and release the ${name} when the range cue shows IN RANGE`;
      }
      // A/A weapon selected with a surface objective ahead and no bandit to worry about
      const e = hostileDesignated(p, s);
      if (e && e.kind === 'aircraft') return null;
      const t = surfaceObjectiveTarget(s, p, 30_000);
      if (!t) return null;
      const ag = agWeaponFor(p, t);
      if (!ag) return null;
      return `Tap WPN to select the ${WEAPON_INFO[ag].short}, then TGT to designate the target`;
    },
  },
];

/** Built-in rule by id (allocation-free lookup; evaluated at 10 Hz). */
function ruleById(id: string): AutoHint | null {
  for (let i = 0; i < AUTO.length; i++) if (AUTO[i].id === id) return AUTO[i];
  return null;
}

/** Minimal launch-zone shape used by the hints (CombatLaunchZone carries rShoot too). */
interface ZoneLike {
  shoot: boolean;
  range: number;
  rMin: number;
  rMax: number;
}

export class HintSystem {
  /** Current text (MissionRunnerApi.hint). */
  current: string | null = null;
  private currentId = '';
  private shownAt = -999;
  private currentDuration = SHOW_TIME;
  private readonly lastShown = new Map<string, number>();
  private readonly shows = new Map<string, number>();
  private readonly scriptedDone = new Set<string>();
  /** A trigger-pushed hint (overrides everything until it expires). */
  private forced: { text: string; raw: string; until: number } | null = null;
  /** The current hint before its {controls}-style tokens were filled. */
  private currentRaw = '';
  private zoneCache: ZoneLike | null = null;
  private zoneAt = -1;

  /** Saved control scheme / handedness for {controls}-style tokens (read once per mission). */
  private readonly savedPrefs = savedControlPrefs();
  /** controlPrefsVersion() the texts were last formatted for (the live scheme can change mid-mission). */
  private prefsVersion = controlPrefsVersion();

  constructor(
    private readonly s: MissionState,
    /** Winchester / bingo state (always-on hints). */
    readonly winchester: WinchesterWatch | null = null,
  ) {}

  /** Launch zone of the selected weapon vs the designation (cached per evaluation). */
  zone(p: AircraftEntity, s: MissionState): ZoneLike | null {
    if (this.zoneAt !== s.time) {
      this.zoneAt = s.time;
      this.zoneCache = s.world.combat.launchZone(p, s.world);
    }
    return this.zoneCache;
  }

  /** Trigger action: show a hint now. */
  force(text: string, duration = 8): void {
    this.forced = { text: this.format(text), raw: text, until: this.s.time + duration };
  }

  /** Fill the {controls}-style tokens for the scheme the player is flying right now. */
  private format(text: string): string {
    return formatControls(text, withActiveScheme(this.savedPrefs));
  }

  /** Tilt fell back to the stick (or came back): re-word the hints already on screen. */
  private followScheme(): void {
    const v = controlPrefsVersion();
    if (v === this.prefsVersion) return;
    this.prefsVersion = v;
    if (this.forced) this.forced.text = this.format(this.forced.raw);
    if (this.current && this.currentRaw && this.currentId.startsWith('script:')) this.current = this.format(this.currentRaw);
  }

  clear(): void {
    this.current = null;
    this.forced = null;
    this.zoneCache = null;
  }

  update(): void {
    const s = this.s;
    const t = s.time;
    const p = s.player;
    if (s.state !== 'running' || !p || !p.alive) {
      this.current = null;
      return;
    }
    this.followScheme();
    if (this.forced) {
      if (t < this.forced.until) {
        this.current = this.forced.text;
        return;
      }
      this.forced = null;
    }

    // always-on hints (Winchester / bingo) pre-empt scripted and weapon hints
    const cur = ruleById(this.currentId);
    if (!cur?.always && this.tryAuto(p, true)) return;

    // keep the current hint on screen for its duration while it still applies (text may evolve)
    if (this.current && t - this.shownAt < this.currentDuration) {
      if (this.currentId.startsWith('script:')) return;
      const rule = ruleById(this.currentId);
      const text = rule?.test(p, s, this);
      if (text) {
        this.current = text;
        // a higher-priority always-on / defend hint may pre-empt a weapon hint
        if (!this.preempted(rule!, p)) return;
      }
    }
    this.current = null;
    this.currentId = '';

    // scripted hints, then auto hints
    for (const h of s.script.hints ?? []) {
      if (this.scriptedDone.has(h.id)) continue;
      if (h.until && evalCondition(h.until, s)) {
        this.scriptedDone.add(h.id);
        continue;
      }
      if (evalCondition(h.when, s)) {
        this.scriptedDone.add(h.id);
        this.show(`script:${h.id}`, h.text, h.duration ?? 8);
        return;
      }
    }
    if (!s.script.autoHints) return;
    this.tryAuto(p, false);
  }

  /** A more urgent rule (defend / Winchester) applies while `rule` is showing. */
  private preempted(rule: AutoHint, p: AircraftEntity): boolean {
    const idx = AUTO.indexOf(rule);
    for (let i = 0; i < idx; i++) {
      const r = AUTO[i];
      if (!r.always && !(r.id === 'defend' && this.s.script.autoHints)) continue;
      if (r.test(p, this.s, this)) return true;
    }
    return false;
  }

  private tryAuto(p: AircraftEntity, alwaysOnly: boolean): boolean {
    const s = this.s;
    const t = s.time;
    for (const rule of AUTO) {
      if (alwaysOnly && !rule.always) continue;
      if (!alwaysOnly && rule.always) continue;
      if (!rule.always && (this.shows.get(rule.id) ?? 0) >= MAX_SHOWS) continue;
      if (t - (this.lastShown.get(rule.id) ?? -999) < (rule.cooldown ?? COOLDOWN)) continue;
      const text = rule.test(p, s, this);
      if (!text) continue;
      this.shows.set(rule.id, (this.shows.get(rule.id) ?? 0) + 1);
      this.show(rule.id, text, SHOW_TIME);
      return true;
    }
    return false;
  }

  private show(id: string, text: string, duration: number): void {
    this.currentRaw = text;
    this.current = this.format(text);
    this.currentId = id;
    this.shownAt = this.s.time;
    this.currentDuration = duration;
    this.lastShown.set(id, this.s.time);
  }
}
