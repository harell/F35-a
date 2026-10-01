/**
 * Ship motion — pure maths shared by the ship visual (SiteVisuals.GroundVisual) and the effects
 * (funnel smoke, the fires on a sinking hull), so smoke and flames stay glued to the animated hull.
 *
 *  - swell: a gentle pitch / roll / heave (a few tenths of a degree, 8–13 s periods);
 *  - anchor swing: a ship at anchor yaws slowly (±~4°, a 3–4 min period) about its bow, where the
 *    cable is;
 *  - sinking: fire on deck, a slow list to one side, the bow or the stern settling first, the whole
 *    hull under after 60–90 s (sinkPose).
 *
 * Everything is a function of the entity (id, pose, destroyedAt) and sim time only: deterministic,
 * allocation-free, no three.js scene objects (unit tested in tests/render-ships.test.ts).
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { VesselClass } from '../../core/types';

const DEG = Math.PI / 180;

/** Hull length / beam / highest point above the waterline (m) and funnel top (local, bow at -Z). */
export interface ShipDims {
  length: number;
  beam: number;
  /** Top of the superstructure / mast above the waterline. */
  height: number;
  /** Main deck height above the waterline (freeboard). */
  deck: number;
  /** Funnel top (local x, y, z). */
  funnel: readonly [number, number, number] | null;
}

/** Model dimensions (render/models/ground.ts builds the hulls from these). */
export const SHIP_DIMS: Record<VesselClass | 'corvette', ShipDims> = {
  container: { length: 270, beam: 34, height: 48, deck: 12, funnel: [0, 36, 111] },
  cruise: { length: 290, beam: 36, height: 50, deck: 14, funnel: [0, 50.8, 60] },
  corvette: { length: 72, beam: 10.4, height: 27, deck: 4.4, funnel: null },
};

export function shipDims(vessel: VesselClass | null | undefined): ShipDims {
  return SHIP_DIMS[vessel ?? 'corvette'];
}

/** The entity fields the motion needs (a GroundTargetEntity of type 'ship'). */
export interface ShipLike {
  readonly id: number;
  readonly position: Vector3;
  readonly quaternion: Quaternion;
  readonly alive: boolean;
  readonly vessel: VesselClass | null;
  readonly anchored: boolean;
  /** Sim time of the kill (-1 = alive). */
  readonly destroyedAt: number;
}

/** Stable per-ship pseudo-random number in [0, 1) (both the visual and the effects use it). */
export function shipSeed(id: number): number {
  let h = Math.imul(id ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Swell amplitudes (rad / m). */
export const SWELL = { pitch: 0.25 * DEG, roll: 0.45 * DEG, heave: 0.3 };
/** Anchor swing amplitude (rad). */
export const ANCHOR_SWING = 4 * DEG;

export interface SinkPose {
  /** Vertical offset of the waterline origin (m, ≤ 0). */
  dy: number;
  /** Trim (rad, about the beam axis): < 0 = bow down. */
  pitch: number;
  /** List (rad, about the keel axis). */
  roll: number;
  /** 0..1 progress; 1 = fully under. */
  progress: number;
  /** Time (s) the hull takes to go under. */
  duration: number;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Time (s) a ship takes to sink: 60–90 s, per ship. */
export function sinkDuration(seed: number): number {
  return 60 + 30 * ((seed * 7.31) % 1);
}

/**
 * Sinking pose `t` seconds after the kill: a list to one side that builds over the first half and
 * steepens in the final plunge, one end (bow or stern, per ship) settling first, and a slow then
 * accelerating descent until the highest point of the tilted hull is under water.
 */
export function sinkPose(t: number, seed: number, dims: ShipDims, out: SinkPose): SinkPose {
  const dur = sinkDuration(seed);
  const u = Math.max(0, Math.min(1, t / dur));
  const side = seed < 0.5 ? 1 : -1;
  const bowFirst = (seed * 3.7) % 1 < 0.6; // most settle by the bow (where the hits usually tear the hull)
  const maxList = (12 + 10 * ((seed * 5.13) % 1)) * DEG;
  const maxTrim = (5 + 4 * ((seed * 2.91) % 1)) * DEG;
  out.roll = side * (maxList * smoothstep(0, 0.6, u) + 8 * DEG * smoothstep(0.7, 1, u));
  // rotateX(+θ) lifts the bow (-Z): bow first = negative trim
  out.pitch = (bowFirst ? -1 : 1) * maxTrim * Math.pow(smoothstep(0.08, 1, u), 1.2);
  // fully under: the raised end and the superstructure top below the surface, plus a margin
  const depth = dims.height + (dims.length / 2) * Math.sin(maxTrim) + 6;
  // settles a few metres early on (flooding), then goes under faster and faster
  const k = 0.12 * smoothstep(0, 0.3, u) + 0.88 * Math.pow(smoothstep(0.25, 1, u), 1.6);
  out.dy = -depth * k;
  out.progress = u;
  out.duration = dur;
  return out;
}

const _sink: SinkPose = { dy: 0, pitch: 0, roll: 0, progress: 0, duration: 75 };
const _q = new Quaternion();
const _qa = new Quaternion();
const _ax = new Vector3();
const _p = new Vector3();
const _one = new Vector3(1, 1, 1);
const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);

/** Anchor swing yaw (rad) of a ship at sim time `time`. */
export function anchorYaw(seed: number, time: number): number {
  const w1 = (2 * Math.PI) / (190 + 60 * seed);
  const w2 = (2 * Math.PI) / (83 + 20 * seed);
  return ANCHOR_SWING * (0.75 * Math.sin(time * w1 + seed * 40) + 0.25 * Math.sin(time * w2 + seed * 17));
}

/**
 * Model matrix of a ship's visual at sim time `time`: the entity pose, plus the anchor swing about
 * the bow, the swell, and the sinking pose once destroyed.
 * @returns the sink pose (progress 0 while afloat) — read-only, reused by the next call
 */
export function shipMatrix(g: ShipLike, time: number, out: Matrix4): Readonly<SinkPose> {
  const seed = shipSeed(g.id);
  const dims = shipDims(g.vessel);
  const dead = !g.alive;
  const since = dead ? Math.max(0, g.destroyedAt >= 0 ? time - g.destroyedAt : 0) : 0;
  // the swing freezes at the kill (the cable parts / the ship takes on water); the swell dies down
  const tSwing = dead && g.destroyedAt >= 0 ? g.destroyedAt : time;
  const yaw = g.anchored ? anchorYaw(seed, tSwing) : 0;
  const calm = dead ? Math.max(0.25, 1 - since / 20) : 1;
  const ph = seed * 100;
  const pitch = SWELL.pitch * calm * Math.sin(time * ((2 * Math.PI) / 9.5) + ph);
  const roll = SWELL.roll * calm * Math.sin(time * ((2 * Math.PI) / 12.3) + ph * 1.7);
  const heave = SWELL.heave * calm * Math.sin(time * ((2 * Math.PI) / 8.1) + ph * 2.3);
  if (dead) sinkPose(since, seed, dims, _sink);
  else {
    _sink.dy = _sink.pitch = _sink.roll = _sink.progress = 0;
    _sink.duration = sinkDuration(seed);
  }
  // rotation: entity · yaw · pitch · roll (local axes; bow at -Z)
  _q.copy(g.quaternion);
  if (yaw !== 0) _q.multiply(_qa.setFromAxisAngle(Y, yaw));
  _q.multiply(_qa.setFromAxisAngle(X, pitch + _sink.pitch));
  _q.multiply(_qa.setFromAxisAngle(Z, roll + _sink.roll));
  // position: the swing turns the hull about the anchor at the bow (local z = -L/2), so the centre
  // moves sideways while the bow stays put
  _p.copy(g.position);
  if (yaw !== 0) {
    const hb = dims.length / 2;
    // bow in the entity frame stays at -hb; the yawed hull's centre = bow + R(yaw)·(0,0,hb)
    _ax.set(Math.sin(yaw) * hb, 0, -hb + Math.cos(yaw) * hb).applyQuaternion(g.quaternion);
    _p.add(_ax);
  }
  _p.y += heave + _sink.dy;
  out.compose(_p, _q, _one);
  return _sink;
}
