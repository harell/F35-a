/**
 * F35-A — SAM site behaviour.
 *
 *   search ─detect─▶ track (trackProgress over samReactionTime) ─in envelope─▶ launch (salvo)
 *      ▲                 │ lost > 2 s                                           │
 *      └─────────────────┘◀──────── guiding (command / SARH missiles in flight) ◀┘
 *                                    └─ out of missiles ─▶ reload ─▶ search
 *   emcon: radar silent — pop-up ambush (wakes when a hostile is inside 60 % of the engagement
 *   range) or defensive shutdown against an inbound anti-radiation missile (then back on).
 *
 * Detection uses the radar equation (stealthy targets are seen late), terrain masking and a
 * low-altitude floor (clutter / radar horizon). MANPADS acquire visually/IR (no radar, no RWR),
 * AAA has an optical backup. Launcher / turret azimuth + elevation slew for the visuals.
 */
import { Vector3 } from 'three';
import { clamp, wrapPi } from '../../core/math';
import type { AircraftEntity, SamSiteEntity } from '../entities';
import type { CombatCtx } from '../weapons/context';
import { radio } from '../weapons/context';
import { kinematicZone, type ZoneGeometry } from '../weapons/dlz';
import { notchDepth } from '../weapons/guidance';
import { isCombatMissile, launchMunition } from '../weapons/missile';
import type { LaunchZone } from '../api';
import { aircraftRcs, irIntensity, rcsRangeFactor } from '../sensors/signatures';
import { lineOfSight } from '../sensors/los';
import { DAS_LAUNCH_RANGE } from '../sensors/Sensors';
import { SAM_DATA, VISUAL_RANGE, type SamTypeData } from './samData';
import { updateAaa, type AaaState } from './aaa';

/** Seconds between detection scans. */
const SCAN_PERIOD = 0.2;
/** Seconds without detection before a track is dropped. */
const TRACK_MEMORY = 2;

interface SamInternal extends AaaState {
  scanTimer: number;
  lostTimer: number;
  salvoLeft: number;
  salvoTimer: number;
  refireTimer: number;
  emconTimer: number;
  ambush: boolean;
  armSeen: number;
  armShutdown: boolean;
  wasAlive: boolean;
  /** Tracked target inside the engagement envelope (evaluated on scans). */
  engageable: boolean;
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
      lostTimer: 0,
      salvoLeft: 0,
      salvoTimer: 0,
      refireTimer: 0,
      emconTimer: 0,
      ambush: false,
      armSeen: -1,
      armShutdown: false,
      wasAlive: true,
      engageable: false,
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

/** Can the site see this aircraft right now (radar / visual / IR)? */
function detects(ctx: CombatCtx, s: SamSiteEntity, data: SamTypeData, t: AircraftEntity): boolean {
  const world = ctx.world;
  const d = t.position.distanceTo(s.position);
  const agl = t.position.y - world.terrain.surfaceHeightAt(t.position.x, t.position.z);
  _eye.copy(s.position);
  _eye.y += data.mastHeight;
  if (data.radar && s.radarOn) {
    let R = (s.detectRange ?? data.detectRange) * rcsRangeFactor(aircraftRcs(t, s.position));
    if (agl < 300) R *= data.lowAltFactor;
    if (d <= R && agl >= data.altMin * 0.5 && !(agl < 1_000 && notchDepth(ctx, _eye, t) > 0.6)) {
      if (lineOfSight(world.terrain, _eye, t.position)) return true;
    }
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
  if (d < data.engageMin || d > data.engageMax * scale) return false;
  if (agl < data.altMin) return false;
  if (data.gun) return t.position.y - s.position.y <= data.altMax;
  if (t.position.y > data.altMax) return false;
  if (!data.missile) return false;
  const def = ctx.defs[data.missile];
  if (def.guidance === 'ir') return d <= def.seekerRange * Math.sqrt(irIntensity(t, s.position));
  _geom.shooterPos.copy(s.position);
  _geom.shooterPos.y += 4;
  _geom.shooterVel.set(0, 0, 0);
  _geom.targetPos.copy(t.position);
  _geom.targetVel.copy(t.velocity);
  kinematicZone(def, _geom, _zone);
  return d <= Math.min(data.engageMax * scale, _zone.rMax * 0.95);
}

/** Pick the best target the site can see (closest, engageable first). */
function acquire(ctx: CombatCtx, s: SamSiteEntity, data: SamTypeData): AircraftEntity | null {
  let best: AircraftEntity | null = null;
  let bestScore = Infinity;
  const maxR = Math.max(s.detectRange ?? data.detectRange, VISUAL_RANGE) * 1.05;
  for (const t of ctx.world.aircraft) {
    if (!t.alive || t.team === s.team) continue;
    const d = t.position.distanceTo(s.position);
    if (d > maxR) continue;
    if (!detects(ctx, s, data, t)) continue;
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

function fireMissile(ctx: CombatCtx, s: SamSiteEntity, data: SamTypeData, t: AircraftEntity): void {
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
  // DAS sees the launch plume → the site is revealed on the TSD
  for (const a of ctx.world.aircraft) {
    if (a.alive && a.team !== s.team && a.type === 'f35a' && a.position.distanceTo(s.position) < DAS_LAUNCH_RANGE) {
      s.known = true;
      break;
    }
  }
  if (t.isPlayer && ctx.time - ctx.chatter.sam > 8) {
    ctx.chatter.sam = ctx.time;
    radio(ctx, 'DARKSTAR', 'SAM launch, SAM launch!', 'a_sam_launch', t.team, 3);
  }
}

function dropTrack(s: SamSiteEntity): void {
  s.trackedTargetId = null;
  s.trackProgress = 0;
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
      dropTrack(s);
      if (si.firing) updateAaa(ctx, s, data, si, null, dt); // stops the gun
    }
    return;
  }
  if (s.radarOn) s.radarAzimuth = (s.radarAzimuth + data.radarSpin * dt) % (Math.PI * 2);
  if (si.refireTimer > 0) si.refireTimer -= dt;

  // ── periodic scan: ARM reaction, ambush wake-up, track maintenance, acquisition ──
  si.scanTimer -= dt;
  const scanNow = si.scanTimer <= 0;
  if (scanNow) {
    si.scanTimer += SCAN_PERIOD;
    if (data.radar) handleEmcon(ctx, s, data, si);
    if (s.state !== 'emcon' && s.state !== 'reload' && s.state !== 'off') {
      const tracked = world.getEntity(s.trackedTargetId);
      if (s.trackedTargetId !== null) {
        if (!tracked || !tracked.alive || tracked.kind !== 'aircraft') {
          dropTrack(s);
          if (s.state !== 'guiding') s.state = 'search';
        } else if (detects(ctx, s, data, tracked)) {
          si.lostTimer = 0;
        } else {
          si.lostTimer += SCAN_PERIOD;
          if (si.lostTimer > TRACK_MEMORY) {
            dropTrack(s);
            if (s.state !== 'guiding') s.state = 'search';
          }
        }
      }
      if (s.state === 'search' || (s.state === 'guiding' && s.trackedTargetId === null && liveGuided(ctx, s) === 0)) {
        const t = acquire(ctx, s, data);
        if (t) {
          s.trackedTargetId = t.id;
          s.trackProgress = 0;
          si.lostTimer = 0;
          s.state = 'track';
        }
      }
    }
  }

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
  switch (s.state) {
    case 'track': {
      if (!tgt) break;
      s.trackProgress = Math.min(1, s.trackProgress + dt / Math.max(0.1, world.difficulty.samReactionTime * data.reaction));
      if (s.trackProgress >= 1 && si.refireTimer <= 0 && s.missilesReady > 0 && si.engageable && liveGuided(ctx, s) < data.channels) {
        s.state = 'launch';
        si.salvoLeft = Math.min(data.salvo, s.missilesReady, data.channels - liveGuided(ctx, s));
        si.salvoTimer = 0;
      }
      break;
    }
    case 'launch': {
      if (!tgt || !si.engageable) {
        s.state = liveGuided(ctx, s) > 0 ? 'guiding' : 'track';
        break;
      }
      si.salvoTimer -= dt;
      if (si.salvoTimer <= 0 && aligned && si.salvoLeft > 0 && s.missilesReady > 0) {
        fireMissile(ctx, s, data, tgt);
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
          dropTrack(s);
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

/** Pop-up ambush and defensive radar shutdown against anti-radiation missiles. */
function handleEmcon(ctx: CombatCtx, s: SamSiteEntity, data: SamTypeData, si: SamInternal): void {
  const world = ctx.world;
  if (si.ambush) {
    const wake = (s.engageRange ?? data.engageMax) * 0.6;
    for (const t of world.aircraft) {
      if (t.alive && t.team !== s.team && t.position.distanceTo(s.position) < wake) {
        si.ambush = false;
        s.radarOn = true;
        s.state = 'search';
        break;
      }
    }
    return;
  }
  const arm = inboundArm(ctx, s);
  if (arm && s.radarOn && si.armSeen !== arm.id) {
    si.armSeen = arm.id;
    si.armShutdown = ctx.rng() < data.armDiscipline * (0.5 + 0.5 * world.difficulty.aiSkill);
  }
  if (si.armShutdown && s.radarOn && arm) {
    // keep guiding missiles that will arrive first; otherwise go silent now
    if (liveGuided(ctx, s) === 0 || arm.tti < 6) {
      s.radarOn = false;
      s.state = 'emcon';
      si.emconTimer = 8 + ctx.rng() * 8;
      dropTrack(s);
    }
  }
  if (s.state === 'emcon') {
    si.emconTimer -= SCAN_PERIOD;
    if (si.emconTimer <= 0 && !arm) {
      s.radarOn = true;
      s.state = 'search';
      si.armShutdown = false;
    }
  }
}
