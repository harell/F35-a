/**
 * F35-A — AI flight safety layer, applied to every FlightIntent before steering.
 *
 * Priority (highest last, so it wins):
 *   1. map edge      — turn back inside the playable area
 *   2. mid-air       — closest-point-of-approach check vs every other aircraft; steer away
 *   3. stall         — near the 1 g stall speed: cap g, forbid climbs, full power
 *   4. terrain floor — look ahead along the current and desired track (surface = max(ground, sea))
 *                      and raise the desired flight-path angle so the jet clears
 *                      terrain + minAgl; ceiling cap near the service ceiling
 *   5. recovery      — if a max-performance wings-level pull-up predicted from the current state
 *                      would only just clear the ground (same predictor as Auto-GCAS), take over:
 *                      roll upright, pull hard, power up. Never fly into the ground or the sea.
 */
import { Vector3 } from 'three';
import type { SimWorld } from '../../sim/api';
import type { AircraftEntity } from '../../sim/entities';
import { predictRecoveryClearance } from '../../sim/flight/gcas';
import { availableG, perfOf, stallSpeedIas } from '../../sim/flight/performance';
import { clampN, cpa, dirWithElevation, elevationOfVec } from '../geom';
import type { FlightIntent } from './Autopilot';

export interface SafetyState {
  /** Terrain floor raised the desired flight path. */
  terrain: boolean;
  /** Emergency ground-collision recovery in progress. */
  recovery: boolean;
  /** Stall protection active. */
  stall: boolean;
  /** Mid-air avoidance active. */
  avoid: boolean;
  /** Turning back from the map edge. */
  boundary: boolean;
  /** Minimum flight-path angle the terrain requires (rad). */
  floorGamma: number;
}

const DEG = Math.PI / 180;
/** Look-ahead times along the track (s). */
const LOOK_TIMES = [1, 2, 3.5, 5, 7, 10, 14];
const MAP_MARGIN = 4_000;
const AVOID_HORIZON = 5;

const _h = new Vector3();
const _rel = new Vector3();
const _away = new Vector3();
const _avoid = new Vector3();

/** Stall-speed cache per aircraft (mass changes slowly). */
const stallCache = new WeakMap<AircraftEntity, { t: number; vs: number }>();

function stallSpeed(ac: AircraftEntity, now: number): number {
  let c = stallCache.get(ac);
  if (!c) {
    c = { t: -99, vs: 60 };
    stallCache.set(ac, c);
  }
  if (now - c.t > 2) {
    c.t = now;
    c.vs = stallSpeedIas(ac, 1);
  }
  return c.vs;
}

/** Highest flight-path angle needed to clear terrain along a horizontal direction (rad). */
function floorAlong(ac: AircraftEntity, world: SimWorld, hx: number, hz: number, speedH: number, clearance: number): number {
  const pos = ac.position;
  const terrain = world.terrain;
  let req = -Math.PI / 2;
  for (let i = 0; i < LOOK_TIMES.length; i++) {
    const d = speedH * LOOK_TIMES[i];
    const h = terrain.surfaceHeightAt(pos.x + hx * d, pos.z + hz * d);
    const need = Math.atan2(h + clearance - pos.y, d);
    if (need > req) req = need;
  }
  return req;
}

export function applySafety(s: SafetyState, it: FlightIntent, ac: AircraftEntity, world: SimWorld): void {
  s.terrain = s.recovery = s.stall = s.avoid = s.boundary = false;
  s.floorGamma = -Math.PI / 2;
  const pos = ac.position;
  const vel = ac.velocity;
  const V = vel.length();
  if (V < 20) return;
  const perf = perfOf(ac);
  const dir = it.dir;

  /* 1. map edge */
  const half = world.terrain.size * 0.5 - MAP_MARGIN;
  const ox = Math.abs(pos.x) - half;
  const oz = Math.abs(pos.z) - half;
  if (ox > 0 || oz > 0) {
    // outward if heading further away from the centre
    const outward = pos.x * dir.x + pos.z * dir.z > 0;
    if (outward || ox > 1500 || oz > 1500) {
      s.boundary = true;
      _h.set(-pos.x, 0, -pos.z).normalize();
      const k = clampN(Math.max(ox, oz) / 2_000 + 0.4, 0.4, 1);
      _rel.set(dir.x, 0, dir.z).lerp(_h, k);
      dirWithElevation(_rel, elevationOfVec(dir), dir);
    }
  }

  /* 2. mid-air avoidance */
  _avoid.set(0, 0, 0);
  const list = world.aircraft;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o === ac || !o.alive || o.crashed) continue;
    const dx = o.position.x - pos.x;
    const dy = o.position.y - pos.y;
    const dz = o.position.z - pos.z;
    if (dx * dx + dy * dy + dz * dz > 2_500 * 2_500) continue;
    const t = cpa(pos, vel, o.position, o.velocity, _rel);
    if (t > AVOID_HORIZON) continue;
    const miss = _rel.length();
    const sep = o.id === it.partnerId ? 22 : 70 + 0.2 * (ac.radius + o.radius);
    if (miss >= sep) continue;
    const urgency = (1 - t / AVOID_HORIZON) * (1 - miss / sep) + 0.3;
    if (miss > 1) _away.copy(_rel).multiplyScalar(-1 / miss);
    else _away.set(0, o.position.y > pos.y ? -1 : 1, 0);
    _avoid.addScaledVector(_away, urgency);
  }
  if (_avoid.lengthSq() > 1e-6) {
    s.avoid = true;
    dir.addScaledVector(_avoid, 2.5).normalize();
    if (it.gMax < 4) it.gMax = 4;
    if (it.gain < 2) it.gain = 2;
  }

  /* 3. stall protection */
  const vs = stallSpeed(ac, world.time);
  const ias = ac.flight.ias;
  if (ias < vs * 1.35) {
    s.stall = true;
    const nAv = availableG(ac);
    it.gMax = Math.min(it.gMax, Math.max(1.2, nAv * 0.85));
    const maxGamma = ias < vs * 1.15 ? -6 * DEG : 0;
    if (elevationOfVec(dir) > maxGamma) dirWithElevation(dir, maxGamma, dir);
    it.throttle = 1;
  }

  /* 4. terrain floor + ceiling */
  const vh = Math.hypot(vel.x, vel.z);
  const speedH = Math.max(vh, 120);
  const surfHere = world.terrain.surfaceHeightAt(pos.x, pos.z);
  const agl = pos.y - surfHere;
  const clearance = it.minAgl + Math.max(0, -vel.y) * 1.5;
  let floor = -Math.PI / 2;
  if (vh > 1) floor = Math.max(floor, floorAlong(ac, world, vel.x / vh, vel.z / vh, speedH, clearance));
  const dh = Math.hypot(dir.x, dir.z);
  if (dh > 1e-3) floor = Math.max(floor, floorAlong(ac, world, dir.x / dh, dir.z / dh, speedH, clearance));
  if (agl < it.minAgl) floor = Math.max(floor, clampN((it.minAgl - agl) / (V * 3), 0.03, 0.35));
  floor = Math.min(floor, 40 * DEG);
  s.floorGamma = floor;
  const gDes = elevationOfVec(dir);
  if (gDes < floor) {
    s.terrain = true;
    dirWithElevation(dir, floor, dir);
    // climbing over terrain: don't let a lazy brain gMax make it sluggish
    if (floor - elevationOfVec(vel) > 3 * DEG) {
      if (it.gMax < 4) it.gMax = Math.min(4, perf.maxG);
      if (it.gain < 1.5) it.gain = 1.5;
    }
    it.allowInverted = false;
  }
  if (pos.y > perf.ceiling - 600 && gDes > 0) dirWithElevation(dir, Math.min(gDes, 0), dir);

  /* 5. emergency recovery (predictive, like Auto-GCAS) */
  if (agl < 1_600 + Math.max(0, -vel.y) * 14) {
    const nAvail = availableG(ac);
    const nPull = clampN(Math.min(nAvail, perf.maxG * 0.85), 1.5, 9);
    const roll = Math.abs(ac.flight.roll);
    const tRoll = 0.25 + (roll > 30 * DEG ? (roll - 20 * DEG) / (0.7 * perf.rollRateMax) : 0);
    const buffer = 35 + 0.1 * V + it.minAgl * 0.25;
    const clr = predictRecoveryClearance(ac, world.terrain, nPull, tRoll, buffer - 1);
    if (clr < buffer) {
      s.recovery = true;
      s.terrain = true;
      dirWithElevation(vel.lengthSq() > 1 ? vel : dir, Math.max(20 * DEG, floor), dir);
      it.gMax = Math.max(it.gMax, nPull);
      it.gain = 3;
      it.allowInverted = false;
      it.track = false;
      if (V < 180) it.throttle = 1;
      else if (it.throttle < 0 && it.speed < V) it.speed = V;
    }
  }
}
