/**
 * F35-A — SAM site behaviour.
 *
 *   search ─detect─▶ track (trackProgress over samReactionTime) ─in envelope─▶ launch (salvo)
 *      ▲                 │ lost > 2 s / notch / chaff                            │
 *      └─────────────────┘◀──────── guiding (command / SARH missiles in flight) ◀┘
 *                                    └─ out of missiles ─▶ reload ─▶ search
 *   emcon: radar silent — pop-up ambush (wakes when a hostile is inside 60 % of the engagement
 *   range) or a defensive shutdown timed against an inbound anti-radiation missile (then back on).
 *
 * Detection uses the radar equation (stealthy targets are seen late), a smooth low-altitude
 * detection loss, the radar horizon, terrain masking and the Doppler notch (a target holding
 * the notch can't be acquired). A fire-control track is only lost to the notch after it has been
 * held long enough (ew.ts: continuous clutter, sustained-notch accumulator); chaff or a notch
 * break forces a full re-acquisition (trackProgress from 0 over the reaction time), so missiles
 * in flight lose their uplink / illumination. MANPADS acquire visually/IR (no radar, no RWR), AAA
 * has an optical backup. Launcher / turret azimuth + elevation slew for the visuals.
 *
 * SEAD depth: the SA-15 shoots down anti-radiation missiles and GPS bombs aimed at
 * them or at co-located sites (point defence, probability based, limited fire channels), and
 * crews time their EMCON shutdown to the ARM's approach — a disciplined crew goes quiet 6–16 s
 * before impact (the AARGM then flies to a degraded memory point), a sloppy one too late or never.
 */
import { Vector3 } from 'three';
import { clamp, smoothstep, wrapPi } from '../../core/math';
import type { AircraftEntity, MissileEntity, SamSiteEntity } from '../entities';
import type { CombatCtx } from '../weapons/context';
import { gaussian, radio } from '../weapons/context';
import { kinematicZone, type ZoneGeometry } from '../weapons/dlz';
import { cmFactor, notchDepth, rollNotchNeed, stepNotch } from '../weapons/ew';
import { isCombatMissile, launchMunition } from '../weapons/missile';
import type { LaunchZone } from '../api';
import { aircraftRcs, irIntensity, rcsRangeFactor } from '../sensors/signatures';
import { lineOfSight } from '../sensors/los';
import { DAS_LAUNCH_RANGE } from '../sensors/Sensors';
import { SAM_DATA, VISUAL_RANGE, type SamTypeData } from './samData';
import { updateAaa, type AaaState } from './aaa';
import { registerRound, updateEndgame } from './endgame';
import { isHostile } from '../../core/types';

/** Seconds between detection scans. */
export const SCAN_PERIOD = 0.2;
/** Seconds without detection before a track is dropped. */
const TRACK_MEMORY = 2;
/** Radar horizon (4/3 earth): d ≈ 4,120·(√h_antenna + √h_target) m. */
const HORIZON_K = 4_120;
/** Radar cross-sections of munitions for point-defence detection (m²). */
const MUNITION_RCS: Record<string, number> = { aargm: 0.1, gbu31: 0.3, kab500: 0.25, gbu53: 0.05 };

interface PdTrack {
  /** Sim time first seen / last seen by the site radar. */
  first: number;
  last: number;
  /** Interceptors fired at it and the earliest time of the next one. */
  shots: number;
  nextShot: number;
}

interface SamInternal extends AaaState {
  scanTimer: number;
  /** Time of the last scan (s). */
  lastScan: number;
  lostTimer: number;
  salvoLeft: number;
  salvoTimer: number;
  refireTimer: number;
  emconTimer: number;
  ambush: boolean;
  /** Anti-radiation missile handling: id seen, time the crew notices it, shutdown TTI (−1 never). */
  armSeen: number;
  armNoticeAt: number;
  armShutTti: number;
  armShutdown: boolean;
  wasAlive: boolean;
  /** Tracked target inside the engagement envelope (evaluated on scans). */
  engageable: boolean;
  /** Sustained-notch accumulator of the fire-control track and its break threshold (−1 = not rolled). */
  notchAccum: number;
  notchNeed: number;
  /** Chaff exposure of the current fire-control track (diminishing returns) + last roll time. */
  chaffExposure: number;
  lastChaffRoll: number;
  /** Point-defence tracks on incoming munitions (id → track). */
  pdTracks: Map<number, PdTrack>;
  /** Shared (correlated) end-game error sample of the current salvo (endgame.ts). */
  salvoZ: number;
  /** Shoulder-launched SA-18s (SamTypeData.manpads): rounds left, seconds to the next shot, seconds a target has been in reach, rounds in flight. */
  mpRounds: number;
  mpTimer: number;
  mpAcquire: number;
  mpMissiles: number[];
}

const internals = new WeakMap<SamSiteEntity, SamInternal>();
const _eye = new Vector3();
const _rel = new Vector3();
const _dir = new Vector3();
const _zone: LaunchZone = { weapon: 'aim120', targetId: null, range: 0, rMin: 0, rNe: 0, rMax: 0, shoot: false, closure: 0, timeOfFlight: 0 };
const _geom: ZoneGeometry = { shooterPos: new Vector3(), shooterVel: new Vector3(), shooterFwd: null, targetPos: new Vector3(), targetVel: new Vector3() };

function internal(ctx: CombatCtx, s: SamSiteEntity): SamInternal {
  let si = internals.get(s);
  if (!si) {
    const data = SAM_DATA[s.type];
    const scale = ctx.world.difficulty.samRangeScale;
    si = {
      scanTimer: ctx.rng() * SCAN_PERIOD,
      lastScan: -1,
      lostTimer: 0,
      salvoLeft: 0,
      salvoTimer: 0,
      refireTimer: 0,
      emconTimer: 0,
      ambush: false,
      armSeen: -1,
      armNoticeAt: 0,
      armShutTti: -1,
      armShutdown: false,
      wasAlive: true,
      engageable: false,
      notchAccum: 0,
      notchNeed: -1,
      chaffExposure: 0,
      lastChaffRoll: -999,
      pdTracks: new Map(),
      salvoZ: 0,
      mpRounds: data.manpads?.rounds ?? 0,
      mpTimer: 0,
      mpAcquire: 0,
      mpMissiles: [],
      burstOn: false,
      burstTimer: 0,
      gunAccum: 0,
      rounds: 0,
      ammo: data.ammo,
      firing: false,
      aimErr: new Vector3(),
      aimErrTimer: 0,
    };
    internals.set(s, si);
    s.missilesMax = data.missiles;
    s.missilesReady = data.missiles;
    s.engageRange = data.engageMax * scale;
    s.detectRange = data.detectRange * scale;
    // yaw of the site → initial launcher azimuth
    _dir.set(0, 0, -1).applyQuaternion(s.quaternion);
    s.launcherAzimuth = Math.atan2(_dir.x, -_dir.z);
    s.radarAzimuth = ctx.rng() * Math.PI * 2;
    if (!data.radar) {
      s.radarOn = false;
      if (s.state === 'emcon') s.state = 'search';
    } else if (s.state === 'emcon' || !s.radarOn) {
      // spawned silent: pop-up ambush
      si.ambush = true;
      s.state = 'emcon';
      s.radarOn = false;
    }
  }
  return si;
}

/* ───────────────────────── Queries used by missile guidance / countermeasures ───────────────────────── */

/**
 * The site holds a fire-control-quality track on `targetId` right now (full track, detected on
 * the last scan) — command / semi-active missiles need it for their uplink / illumination.
 * Also true for point-defence tracks on incoming munitions.
 */
export function siteTracks(s: SamSiteEntity, targetId: number): boolean {
  const si = internals.get(s);
  if (!si || !s.alive) return false;
  if (s.trackedTargetId === targetId) return s.trackProgress >= 1 && si.lostTimer <= 1e-6;
  const pd = si.pdTracks.get(targetId);
  return !!pd && pd.last >= si.lastScan - 1e-6;
}

/**
 * Chaff walked the fire-control radar's range/Doppler gate off `targetId` (weapons/
 * countermeasures.ts, after a successful roll — the round that rolled is already defeated).
 * Not every salvo is lost with it: a skilled crew may catch the gate walk-off within one scan
 * (manual re-lock) — then the track only blinks (< 1 scan, shorter than the rounds' uplink
 * memory) and the other rounds of the salvo keep guiding, each still facing its own end-game
 * roll with chaff in the gate. Otherwise (and always while the target sits in the notch) the
 * track is dropped and must be re-acquired from scratch.
 */
export function breakSiteTrack(ctx: CombatCtx, s: SamSiteEntity, targetId: number): void {
  if (s.trackedTargetId !== targetId) return;
  const si = internal(ctx, s);
  const t = ctx.world.getEntity(targetId);
  if (t && t.kind === 'aircraft' && s.radarOn && s.trackProgress >= 1 && liveGuided(ctx, s) > 0) {
    _eye.copy(s.position);
    _eye.y += SAM_DATA[s.type].mastHeight;
    if (ctx.rng() < quickRelockChance(ctx.world.difficulty.aiSkill, notchDepth(ctx, _eye, t))) {
      si.lostTimer = 1e-3; // uplink blinks until the next scan re-confirms the track
      return;
    }
  }
  loseSiteTrack(s, si);
}

/** Chance that the crew re-locks within one scan after a chaff gate walk-off (0 in the notch). */
export function quickRelockChance(aiSkill: number, notch: number): number {
  const k = clamp(aiSkill, 0, 1);
  return 0.6 * k * k * (1 - clamp(notch * 1.5, 0, 1));
}

/** Drop the fire-control track and force a full re-acquisition (search → track over the reaction time). */
function loseSiteTrack(s: SamSiteEntity, si: SamInternal): void {
  s.trackedTargetId = null;
  s.trackProgress = 0;
  si.lostTimer = 0;
  si.notchAccum = 0;
  si.notchNeed = -1;
  if (s.state === 'track' || s.state === 'launch' || s.state === 'guiding') s.state = 'search';
}

/** Countermeasure bookkeeping of the site's fire-control track (chaff diminishing returns). */
export function siteEw(ctx: CombatCtx, s: SamSiteEntity): { chaffExposure: number; lastChaffRoll: number } {
  return internal(ctx, s);
}

/* ───────────────────────── Detection / engagement ───────────────────────── */

/**
 * Can the site see this aircraft right now (radar / visual / IR)? `tracking` = maintaining an
 * existing track (a notching target can still be held — see the notch accumulator — but it can't
 * be acquired).
 */
function detects(ctx: CombatCtx, s: SamSiteEntity, data: SamTypeData, t: AircraftEntity, tracking: boolean): boolean {
  const world = ctx.world;
  const d = t.position.distanceTo(s.position);
  const agl = t.position.y - world.terrain.surfaceHeightAt(t.position.x, t.position.z);
  _eye.copy(s.position);
  _eye.y += data.mastHeight;
  if (data.radar && s.radarOn) {
    let R = (s.detectRange ?? data.detectRange) * rcsRangeFactor(aircraftRcs(t, s.position));
    // low-altitude detection loss (multipath / clutter), smooth from 600 m down to 50 m AGL
    R *= 1 - (1 - data.lowAltFactor) * (1 - smoothstep(agl, 50, 600));
    if (tracking) R *= 1.15;
    const horizon = HORIZON_K * (Math.sqrt(Math.max(0, _eye.y)) + Math.sqrt(Math.max(0, t.position.y)));
    if (d <= R && d <= horizon && agl >= data.altMin * 0.5 && (tracking || notchDepth(ctx, _eye, t) < 0.5)) {
      if (lineOfSight(world.terrain, _eye, t.position)) return true;
    }
  }
  // close-in cue that ignores stealth shaping (the AD boat's EO tracker: SamTypeData.closeCue, or the site's own)
  const cue = s.closeCue !== undefined ? s.closeCue : data.closeCue;
  if (cue && agl >= data.altMin * 0.5) {
    const scale = ctx.world.difficulty.samRangeScale;
    const bay = tracking || t.bayDoors > 0.05;
    const k = s.noHarass ? 0 : ctx.world.difficulty.adBoatHarass;
    const r = bay ? (data.harass && k > 0 ? Math.max(cue.bayRange, data.harass.cueRange * k) : cue.bayRange) : cue.range;
    if (d <= r * scale && lineOfSight(world.terrain, _eye, t.position)) return true;
  }
  if (!data.radar) {
    // MANPADS team: eyes + seeker
    const R = (s.detectRange ?? data.detectRange) * clamp(Math.sqrt(irIntensity(t, s.position)), 0.6, 1.4);
    if (d <= R && agl < data.altMax + 500 && lineOfSight(world.terrain, _eye, t.position)) return true;
  } else if (data.gun && d <= VISUAL_RANGE && lineOfSight(world.terrain, _eye, t.position)) {
    return true; // AAA optical sight
  }
  return false;
}

/** Target inside the engagement envelope (range, altitude, missile kinematics / IR lock). */
function canEngage(ctx: CombatCtx, s: SamSiteEntity, data: SamTypeData, t: AircraftEntity): boolean {
  const scale = ctx.world.difficulty.samRangeScale;
  const d = t.position.distanceTo(s.position);
  const agl = t.position.y - ctx.world.terrain.surfaceHeightAt(t.position.x, t.position.z);
  const k = s.noHarass ? 0 : ctx.world.difficulty.adBoatHarass;
  const harassReach = data.harass && k > 0 ? data.harass.reach * k : 0;
  if (d < data.engageMin || d > Math.max(data.engageMax, harassReach) * scale) return false;
  if (agl < data.altMin) return false;
  if (data.gun) return t.position.y - s.position.y <= data.altMax;
  if (t.position.y > data.altMax) return false;
  if (!data.missile) return false;
  const def = ctx.defs[data.missile];
  if (def.guidance === 'ir') return d <= def.seekerRange * Math.sqrt(irIntensity(t, s.position));
  // the harassing boat fires outside its envelope: a long shot to make the jet turn, or to catch one that doesn't
  if (harassReach > 0 && d > data.engageMax * scale) return true;
  _geom.shooterPos.copy(s.position);
  _geom.shooterPos.y += 4;
  _geom.shooterVel.set(0, 0, 0);
  _geom.targetPos.copy(t.position);
  _geom.targetVel.copy(t.velocity);
  kinematicZone(def, _geom, _zone);
  return d <= Math.min(data.engageMax * scale, _zone.rMax * launchRangeFraction(ctx.world.difficulty.aiSkill));
}

/**
 * Fraction of the missile's kinematic max range (vs the target's current track) at which the
 * crew launches: a green crew fires at max range (a target that turns away outruns the round),
 * a disciplined one waits for a shot the target can't simply out-run — so difficulty maps to
 * lethality monotonically instead of harder sites wasting long shots.
 */
export function launchRangeFraction(aiSkill: number): number {
  return 0.95 - 0.25 * clamp(aiSkill, 0, 1);
}

/** Pick the best target the site can see (closest, engageable first). */
function acquire(ctx: CombatCtx, s: SamSiteEntity, data: SamTypeData): AircraftEntity | null {
  let best: AircraftEntity | null = null;
  let bestScore = Infinity;
  const maxR = Math.max(s.detectRange ?? data.detectRange, VISUAL_RANGE) * 1.05;
  for (const t of ctx.world.aircraft) {
    if (!t.alive || !isHostile(s.team, t.team)) continue;
    const d = t.position.distanceTo(s.position);
    if (d > maxR) continue;
    if (!detects(ctx, s, data, t, false)) continue;
    const score = d * (canEngage(ctx, s, data, t) ? 0.5 : 1) * (t.isPlayer ? 0.9 : 1);
    if (score < bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

/** Live missiles this site is guiding (compacts the list in place). */
function liveGuided(ctx: CombatCtx, s: SamSiteEntity): number {
  const list = s.guidedMissiles;
  let n = 0;
  for (let i = 0; i < list.length; i++) {
    const m = ctx.world.getEntity(list[i]);
    if (m && m.alive) list[n++] = list[i];
  }
  list.length = n;
  return n;
}

/** Shortest time to impact of this site's guided missiles on aircraft (s), Infinity if none. */
function guidedArrival(ctx: CombatCtx, s: SamSiteEntity): number {
  let best = Infinity;
  for (let i = 0; i < s.guidedMissiles.length; i++) {
    const m = ctx.world.getEntity(s.guidedMissiles[i]);
    if (!m || !m.alive || m.kind !== 'missile') continue;
    const t = ctx.world.getEntity(m.targetId);
    if (!t || t.kind !== 'aircraft') continue;
    const tti = m.position.distanceTo(t.position) / Math.max(300, m.velocity.length());
    if (tti < best) best = tti;
  }
  return best;
}

/** Inbound anti-radiation missile targeting this site (closest), or null. */
const _arm = { id: -1, tti: 0 };
function inboundArm(ctx: CombatCtx, s: SamSiteEntity): { id: number; tti: number } | null {
  let found = false;
  for (const m of ctx.world.missiles) {
    if (!m.alive || m.targetId !== s.id || m.def.guidance !== 'anti_radiation' || !isCombatMissile(m)) continue;
    const d = m.position.distanceTo(s.position);
    if (d > 35_000) continue;
    const tti = d / Math.max(100, m.speed);
    if (!found || tti < _arm.tti) {
      _arm.id = m.id;
      _arm.tti = tti;
      found = true;
    }
  }
  return found ? _arm : null;
}

function slewLauncher(s: SamSiteEntity, data: SamTypeData, t: AircraftEntity | null, dt: number): boolean {
  const rate = data.slewRate * dt;
  if (data.vertical) {
    const up = s.state === 'track' || s.state === 'launch' || s.state === 'guiding';
    const target = up ? Math.PI / 2 : 0;
    s.launcherElevation += clamp(target - s.launcherElevation, -rate, rate);
    if (t) {
      _rel.subVectors(t.position, s.position);
      const az = Math.atan2(_rel.x, -_rel.z);
      s.launcherAzimuth = wrapPi(s.launcherAzimuth + clamp(wrapPi(az - s.launcherAzimuth), -rate, rate));
    }
    return s.launcherElevation > 1.45;
  }
  if (!t) {
    s.launcherElevation += clamp(0.15 - s.launcherElevation, -rate, rate);
    return false;
  }
  _rel.subVectors(t.position, s.position);
  const az = Math.atan2(_rel.x, -_rel.z);
  const el = clamp(Math.atan2(_rel.y, Math.hypot(_rel.x, _rel.z)) + 0.25, 0.3, 1.1);
  const daz = wrapPi(az - s.launcherAzimuth);
  s.launcherAzimuth = wrapPi(s.launcherAzimuth + clamp(daz, -rate, rate));
  s.launcherElevation += clamp(el - s.launcherElevation, -rate, rate);
  return Math.abs(wrapPi(az - s.launcherAzimuth)) < 0.12 && Math.abs(el - s.launcherElevation) < 0.12;
}

function fireMissile(ctx: CombatCtx, s: SamSiteEntity, data: SamTypeData, si: SamInternal, t: AircraftEntity): void {
  if (!data.missile) return;
  const def = ctx.defs[data.missile];
  if (def.launch !== 'vertical') {
    const ce = Math.cos(s.launcherElevation);
    _dir.set(Math.sin(s.launcherAzimuth) * ce, Math.sin(s.launcherElevation), -Math.cos(s.launcherAzimuth) * ce);
  }
  const m = launchMunition(ctx, s, data.missile, t, { launchDir: def.launch === 'vertical' ? null : _dir });
  s.missilesReady--;
  s.guidedMissiles.push(m.id);
  s.lastLaunchTime = ctx.time;
  registerRound(ctx, m, si.salvoZ);
  revealLaunch(ctx, s);
  // AWACS / EW only call launches they can see: a radiating fire-control radar (a passive
  // MANPADS shot is invisible to them — the DAS/MAWS warns instead). Priority 2 = not an urgent
  // call: Betty's MISSILE warning is never held behind it (VoicePlayer defers Betty only ≥ 3).
  if (t.isPlayer && data.radar && s.radarOn && def.guidance !== 'ir' && ctx.time - ctx.chatter.sam > 8) {
    ctx.chatter.sam = ctx.time;
    radio(ctx, 'DARKSTAR', 'SAM launch, SAM launch!', 'a_sam_launch', t.team, SAM_LAUNCH_PRIORITY);
  }
}

/** Radio priority of the DARKSTAR SAM-launch call (below VoicePlayer's urgent threshold of 3). */
export const SAM_LAUNCH_PRIORITY = 2;

/** DAS sees the launch plume → the site is revealed on the TSD. */
function revealLaunch(ctx: CombatCtx, s: SamSiteEntity): void {
  for (const a of ctx.world.aircraft) {
    if (a.alive && a.team !== s.team && a.type === 'f35a' && a.position.distanceTo(s.position) < DAS_LAUNCH_RANGE) {
      s.known = true;
      break;
    }
  }
}

function dropTrack(s: SamSiteEntity, si: SamInternal): void {
  s.trackedTargetId = null;
  s.trackProgress = 0;
  si.notchAccum = 0;
  si.notchNeed = -1;
}

/** Update every SAM / AAA site. */
export function updateSams(ctx: CombatCtx, dt: number): void {
  for (const s of ctx.world.sams) updateSite(ctx, s, dt);
}

function updateSite(ctx: CombatCtx, s: SamSiteEntity, dt: number): void {
  const world = ctx.world;
  const data = SAM_DATA[s.type];
  const si = internal(ctx, s);

  if (!s.alive) {
    if (si.wasAlive) {
      si.wasAlive = false;
      s.state = 'off';
      s.radarOn = false;
      dropTrack(s, si);
      si.pdTracks.clear();
      if (si.firing) updateAaa(ctx, s, data, si, null, dt); // stops the gun
    }
    return;
  }
  if (s.radarOn) s.radarAzimuth = (s.radarAzimuth + data.radarSpin * dt) % (Math.PI * 2);
  if (si.refireTimer > 0) si.refireTimer -= dt;

  // ── periodic scan: ARM reaction, ambush wake-up, track maintenance, acquisition, point defence ──
  si.scanTimer -= dt;
  const scanNow = si.scanTimer <= 0;
  if (scanNow) {
    si.scanTimer += SCAN_PERIOD;
    si.lastScan = ctx.time;
    if (data.radar) handleEmcon(ctx, s, data, si);
    if (s.state !== 'emcon' && s.state !== 'reload' && s.state !== 'off') {
      const tracked = world.getEntity(s.trackedTargetId);
      if (s.trackedTargetId !== null) {
        if (!tracked || !tracked.alive || tracked.kind !== 'aircraft') {
          dropTrack(s, si);
          if (s.state !== 'guiding') s.state = 'search';
        } else if (detects(ctx, s, data, tracked, true)) {
          si.lostTimer = 0;
          maintainAgainstNotch(ctx, s, data, si, tracked);
        } else {
          si.lostTimer += SCAN_PERIOD;
          if (si.lostTimer > TRACK_MEMORY) {
            dropTrack(s, si);
            if (s.state !== 'guiding') s.state = 'search';
          }
        }
      }
      if (s.state === 'search' || (s.state === 'guiding' && s.trackedTargetId === null && liveGuided(ctx, s) === 0)) {
        const t = acquire(ctx, s, data);
        if (t) {
          if (t.id !== s.trackedTargetId) si.chaffExposure = 0;
          s.trackedTargetId = t.id;
          s.trackProgress = 0;
          si.lostTimer = 0;
          si.notchAccum = 0;
          si.notchNeed = -1;
          s.state = 'track';
        }
      }
    }
    if (data.pointDefense) pointDefense(ctx, s, data, si);
  }
  if (data.manpads) updateManpads(ctx, s, data, si, dt, scanNow);

  const target = world.getEntity(s.trackedTargetId);
  const tgt = target && target.alive && target.kind === 'aircraft' ? target : null;
  // envelope check (integrates the missile's energy profile) only on scans
  if (scanNow || !tgt) si.engageable = !!tgt && canEngage(ctx, s, data, tgt);
  // AAA turrets are slewed by the gun fire-control (aaa.ts)
  const aligned = data.gun ? false : slewLauncher(s, data, tgt, dt);

  // ── AAA ──
  if (data.gun) {
    updateAaa(ctx, s, data, si, tgt && s.state !== 'emcon' ? tgt : null, dt);
    if (s.state === 'reload') {
      s.reloadTimer -= dt;
      if (s.reloadTimer <= 0) {
        si.ammo = data.ammo;
        s.state = 'search';
      }
    } else if (tgt && (s.state === 'track' || s.state === 'launch')) {
      if (s.state === 'track') {
        s.trackProgress = Math.min(1, s.trackProgress + dt / Math.max(0.1, world.difficulty.samReactionTime * data.reaction));
        if (s.trackProgress >= 1) s.state = 'launch';
      }
      if (si.ammo <= 0) {
        s.state = 'reload';
        s.reloadTimer = data.reloadTime;
      }
    }
    return;
  }

  // ── missile sites ──
  // per-round end-game miss distance (before weapons/flight.ts moves the missiles this step)
  if (s.guidedMissiles.length > 0) updateEndgame(ctx, s, si, dt);
  switch (s.state) {
    case 'track': {
      // an empty launcher with nothing in flight reloads: a site whose track was broken (chaff, the
      // notch) while it guided its last rounds re-acquires straight into 'track' with none left, and
      // without this sat there for good (found by t05's drills: a boat silent after four rounds)
      if (s.missilesReady <= 0 && liveGuided(ctx, s) === 0) {
        s.state = 'reload';
        s.reloadTimer = data.reloadTime;
        dropTrack(s, si);
        break;
      }
      if (!tgt) break;
      s.trackProgress = Math.min(1, s.trackProgress + dt / Math.max(0.1, world.difficulty.samReactionTime * data.reaction));
      if (s.trackProgress >= 1 && si.refireTimer <= 0 && s.missilesReady > 0 && si.engageable && !s.holdFire && !s.irOnly && liveGuided(ctx, s) < data.channels) {
        s.state = 'launch';
        si.salvoLeft = Math.min(data.salvo, s.missilesReady, data.channels - liveGuided(ctx, s));
        si.salvoTimer = 0;
        si.salvoZ = gaussian(ctx.rng);
      }
      break;
    }
    case 'launch': {
      if (!tgt || !si.engageable || s.trackProgress < 1) {
        s.state = liveGuided(ctx, s) > 0 ? 'guiding' : 'track';
        break;
      }
      si.salvoTimer -= dt;
      if (si.salvoTimer <= 0 && aligned && si.salvoLeft > 0 && s.missilesReady > 0) {
        fireMissile(ctx, s, data, si, tgt);
        si.salvoLeft--;
        si.salvoTimer = data.salvoInterval;
      }
      if (si.salvoLeft <= 0 || s.missilesReady <= 0) s.state = 'guiding';
      break;
    }
    case 'guiding': {
      if (liveGuided(ctx, s) === 0) {
        si.refireTimer = data.refireDelay;
        if (s.missilesReady <= 0) {
          s.state = 'reload';
          s.reloadTimer = data.reloadTime;
          dropTrack(s, si);
        } else if (tgt) {
          s.state = 'track';
        } else {
          s.state = 'search';
        }
      }
      break;
    }
    case 'reload': {
      s.reloadTimer -= dt;
      if (s.reloadTimer <= 0) {
        s.missilesReady = s.missilesMax;
        s.state = 'search';
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Shoulder-launched SA-18s besides the site's main weapon (the IRGC Navy AD boat): a MANPADS team
 * that, independently of the radar, fires at the closest hostile aircraft its IR seeker can see
 * inside reach, after the difficulty's reaction time, one round every `refire` s. Passive: no RWR
 * warning, no AWACS call (the DAS/MAWS warns). Its rounds get the same end-game model as any SAM.
 */
function updateManpads(ctx: CombatCtx, s: SamSiteEntity, data: SamTypeData, si: SamInternal, dt: number, scanNow: boolean): void {
  const mp = data.manpads!;
  if (si.mpMissiles.length) {
    let n = 0;
    for (const id of si.mpMissiles) {
      const m = ctx.world.getEntity(id);
      if (m && m.alive) si.mpMissiles[n++] = id;
    }
    si.mpMissiles.length = n;
    if (n) updateEndgame(ctx, s, si, dt, si.mpMissiles);
  }
  if (si.mpTimer > 0) si.mpTimer -= dt;
  if (si.mpRounds <= 0 || si.mpTimer > 0 || s.holdFire) return;
  if (!scanNow) {
    return;
  }
  const def = ctx.defs[mp.missile];
  const reach = mp.range * ctx.world.difficulty.samRangeScale;
  let best: AircraftEntity | null = null;
  let bestD = Infinity;
  _eye.copy(s.position);
  _eye.y += data.mastHeight;
  for (const t of ctx.world.aircraft) {
    if (!t.alive || !isHostile(s.team, t.team)) continue;
    const d = t.position.distanceTo(s.position);
    if (d < mp.minRange || d > reach || d >= bestD) continue;
    if (t.position.y - ctx.world.terrain.surfaceHeightAt(t.position.x, t.position.z) < 10) continue;
    if (d > def.seekerRange * Math.sqrt(irIntensity(t, s.position))) continue;
    if (!lineOfSight(ctx.world.terrain, _eye, t.position)) continue;
    best = t;
    bestD = d;
  }
  if (!best) {
    si.mpAcquire = 0;
    return;
  }
  si.mpAcquire += SCAN_PERIOD;
  if (si.mpAcquire < ctx.world.difficulty.samReactionTime) return;
  _dir.subVectors(best.position, s.position).normalize();
  const m = launchMunition(ctx, s, mp.missile, best, { launchDir: _dir });
  registerRound(ctx, m, gaussian(ctx.rng));
  si.mpMissiles.push(m.id);
  si.mpRounds--;
  si.mpTimer = mp.refire;
  si.mpAcquire = 0;
  s.lastLaunchTime = ctx.time;
  revealLaunch(ctx, s);
}

/**
 * Sustained Doppler notch against the fire-control radar: the track survives short notches but
 * is lost once the target has held the notch (beam + ground clutter) long enough — then the
 * site must re-acquire from scratch.
 */
function maintainAgainstNotch(ctx: CombatCtx, s: SamSiteEntity, data: SamTypeData, si: SamInternal, t: AircraftEntity): void {
  if (!data.radar || !data.missile || !s.radarOn) return;
  const def = ctx.defs[data.missile];
  if (si.notchNeed < 0) si.notchNeed = rollNotchNeed(ctx, def.notchResistance, cmFactor(ctx, s.team, t));
  si.notchAccum = stepNotch(si.notchAccum, notchDepth(ctx, _eye, t), SCAN_PERIOD);
  if (si.notchAccum >= si.notchNeed) loseSiteTrack(s, si);
}

/* ───────────────────────── EMCON vs anti-radiation missiles ───────────────────────── */

/** Pop-up ambush and a defensive radar shutdown timed against anti-radiation missiles. */
function handleEmcon(ctx: CombatCtx, s: SamSiteEntity, data: SamTypeData, si: SamInternal): void {
  const world = ctx.world;
  if (si.ambush) {
    const wake = (s.engageRange ?? data.engageMax) * 0.6;
    for (const t of world.aircraft) {
      if (t.alive && isHostile(s.team, t.team) && t.position.distanceTo(s.position) < wake) {
        si.ambush = false;
        s.radarOn = true;
        s.state = 'search';
        break;
      }
    }
    return;
  }
  const now = ctx.time;
  const skill = world.difficulty.aiSkill;
  const arm = inboundArm(ctx, s);
  if (arm && si.armSeen !== arm.id) {
    // a new ARM: the crew notices it after a skill-dependent delay and plans when to go quiet
    si.armSeen = arm.id;
    si.armNoticeAt = now + (0.5 + 3 * (1 - skill)) * (0.6 + 0.8 * ctx.rng());
    const disciplined = ctx.rng() < data.armDiscipline * (0.5 + 0.5 * skill);
    if (data.pointDefense && s.missilesReady > 0) si.armShutTti = disciplined ? 2 : -1; // fight it; hide only at the last moment
    else if (disciplined) si.armShutTti = (6 + 10 * skill) * (0.75 + 0.5 * ctx.rng());
    else si.armShutTti = ctx.rng() < 0.5 ? -1 : 1 + 2 * ctx.rng(); // panics too late (or never)
    // a range target (t04's AARGM drill): it stays on the air
    if (s.noArmShutdown) si.armShutTti = -1;
  }
  if (arm && s.radarOn && !si.armShutdown && now >= si.armNoticeAt && si.armShutTti > 0 && arm.tti <= si.armShutTti) {
    // keep guiding missiles that arrive well before the ARM, as long as it is not about to hit
    const busy = liveGuided(ctx, s) > 0 && guidedArrival(ctx, s) < arm.tti - 1 && arm.tti > 3;
    if (!busy) {
      s.radarOn = false;
      s.state = 'emcon';
      si.armShutdown = true;
      si.emconTimer = 3 + 5 * ctx.rng();
      dropTrack(s, si);
      si.pdTracks.clear();
    }
  }
  if (s.state === 'emcon' && si.armShutdown) {
    if (arm) si.emconTimer = Math.max(si.emconTimer, 3 + 2 * skill);
    else si.emconTimer -= SCAN_PERIOD;
    if (!arm && si.emconTimer <= 0) {
      s.radarOn = true;
      s.state = 'search';
      si.armShutdown = false;
    }
  }
}

/* ───────────────────────── Point defence ───────────────────────── */

/** Where an incoming munition is going to hit (GPS aim point / ARM target estimate). */
function munitionAimPoint(m: MissileEntity): Vector3 {
  return m.targetPoint;
}

/**
 * SA-15: track incoming anti-radiation missiles and GPS bombs aimed at (or near) the
 * site and engage them with interceptors (kill probability rolled when the interceptor fuzes).
 */
function pointDefense(ctx: CombatCtx, s: SamSiteEntity, data: SamTypeData, si: SamInternal): void {
  const pd = data.pointDefense;
  const world = ctx.world;
  if (!pd || !data.missile || !s.radarOn || s.state === 'emcon' || s.state === 'reload' || s.state === 'off') {
    if (si.pdTracks.size) si.pdTracks.clear();
    return;
  }
  const now = ctx.time;
  const range = pd.range * world.difficulty.samRangeScale;
  _eye.copy(s.position);
  _eye.y += data.mastHeight;
  for (const m of world.missiles) {
    if (!m.alive || m.team === s.team || !isCombatMissile(m) || m.ended) continue;
    const cat = m.cdef.category;
    if (cat !== 'agm' && cat !== 'bomb') continue;
    const d = m.position.distanceTo(s.position);
    if (d > range) continue;
    const aim = munitionAimPoint(m);
    if (Math.hypot(aim.x - s.position.x, aim.z - s.position.z) > pd.protect) continue;
    const agl = m.position.y - world.terrain.surfaceHeightAt(m.position.x, m.position.z);
    if (agl < Math.max(15, data.altMin)) continue;
    const rcs = MUNITION_RCS[m.cdef.id] ?? 0.1;
    if (d > (s.detectRange ?? data.detectRange) * rcsRangeFactor(rcs)) continue;
    if (!lineOfSight(world.terrain, _eye, m.position)) continue;
    let tr = si.pdTracks.get(m.id);
    if (!tr) {
      tr = { first: now, last: now, shots: 0, nextShot: now + world.difficulty.samReactionTime * data.reaction * 0.4 };
      si.pdTracks.set(m.id, tr);
    }
    tr.last = now;
  }
  _pd.ctx = ctx;
  _pd.s = s;
  _pd.data = data;
  _pd.si = si;
  _pd.now = now;
  si.pdTracks.forEach(prunePdTrack);
  si.pdTracks.forEach(engagePdTrack);
}

/* point-defence iteration state (Map.forEach callbacks: no per-scan closures / entry tuples) */
const _pd = { ctx: null as unknown as CombatCtx, s: null as unknown as SamSiteEntity, data: null as unknown as SamTypeData, si: null as unknown as SamInternal, now: 0 };

function prunePdTrack(tr: PdTrack, id: number): void {
  const m = _pd.ctx.world.getEntity(id);
  if (!m || !m.alive || tr.last < _pd.now - 1) _pd.si.pdTracks.delete(id);
}

function engagePdTrack(tr: PdTrack, id: number): void {
  const { ctx, s, data, si, now } = _pd;
  const pd = data.pointDefense;
  if (!pd || !data.missile || tr.last < now - 1e-6 || now < tr.nextShot) return;
  const m = ctx.world.getEntity(id);
  if (!m || m.kind !== 'missile' || !isCombatMissile(m)) return;
  const maxShots = m.cdef.category === 'bomb' ? 1 : 2;
  if (tr.shots >= maxShots || interceptorInFlight(ctx, s, id)) return;
  if (s.missilesReady <= 0 || liveGuided(ctx, s) >= data.channels) return;
  if (m.position.distanceTo(s.position) < pd.minRange) return;
  const def = ctx.defs[data.missile];
  if (def.launch !== 'vertical') {
    _dir.subVectors(m.position, s.position).normalize();
    _dir.y = Math.max(_dir.y, 0.35);
    _dir.normalize();
    s.launcherAzimuth = Math.atan2(_dir.x, -_dir.z);
    s.launcherElevation = Math.asin(_dir.y);
  }
  const im = launchMunition(ctx, s, data.missile, m, { launchDir: def.launch === 'vertical' ? null : _dir });
  im.loft = false;
  s.missilesReady--;
  s.guidedMissiles.push(im.id);
  s.lastLaunchTime = now;
  revealLaunch(ctx, s);
  tr.shots++;
  tr.nextShot = now + 1.5;
  void si;
}

function interceptorInFlight(ctx: CombatCtx, s: SamSiteEntity, munitionId: number): boolean {
  for (let i = 0; i < s.guidedMissiles.length; i++) {
    const m = ctx.world.getEntity(s.guidedMissiles[i]);
    if (m && m.alive && m.kind === 'missile' && m.targetId === munitionId) return true;
  }
  return false;
}

/** Point-defence kill probability of an interceptor from `site` against munition category. */
export function pointDefensePk(site: SamSiteEntity, category: 'aam' | 'sam' | 'agm' | 'bomb'): number {
  const pd = SAM_DATA[site.type].pointDefense;
  if (!pd) return 0.5;
  return category === 'bomb' ? pd.pkBomb : pd.pkAgm;
}
