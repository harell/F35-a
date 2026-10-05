/**
 * Effects — all combat "juice": missile smoke trails (ribbons + puffs) and motor glows, explosions
 * (flash, fireball, smoke, sparks, debris, ground shockwave, water splash columns), burning wrecks &
 * tall smoke columns, falling-wreck fire trails, gun tracers, muzzle flashes, bullet impacts, flares
 * (burning cores + smoke arcs), chaff glitter, contrails, wingtip vortices, LEX vapour, transonic
 * vapour cones, damage smoke, ship funnel exhaust, the fires riding a sinking hull down and the fire
 * burning on a damaged Sky Tower.
 *
 * Budgets: particle capacities and emission rates scale with QualitySettings.particleScale and with
 * distance to the camera. Everything is pooled; the per-frame path allocates nothing.
 */
import { HB_DIR } from '../../core/harbourBridge';
import { COLLAPSE_DELAY, buildingCollapseTime } from '../../sim/buildings';
import { Color, Group, Matrix4, Vector3 } from 'three';
import type { CreateEffects, EffectsApi, FrameContext } from '../../core/contracts';
import type { ExplosionSize } from '../../core/types';
import type { AircraftEntity, GroundTargetEntity, MissileEntity, MunitionDef } from '../../sim/entities';
import { shipDims, shipMatrix } from '../visuals/shipMotion';
import { AIRCRAFT_SPECS, type AircraftSpec } from '../models/specs';
import { GpuParticles, resetSpawn, spawnParams, type ParticleSpawn } from './GpuParticles';
import { Ribbons, type RibbonStyle } from './Ribbons';
import { SpriteBatch, pixelScale } from './SpriteBatch';
import { Debris, Pulses, VaporCones } from './Props';
import { COLLAPSE } from '../../core/skyTower';
import { fireTexture, glowTexture, smokeTexture } from './textures';
import { Craters } from './Craters';

/* ───────────────────────── colours & styles ───────────────────────── */

type RGB = [number, number, number];
const lin = (hex: number): RGB => {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
};
const C = {
  smokeDark: lin(0x2b2926),
  smokeMid: lin(0x55524e),
  smokeGrey: lin(0x86837f),
  smokeLight: lin(0xe9e9e6),
  dust: lin(0x9b8a6c),
  dustLight: lin(0xb9ab8f),
  water: lin(0xeef3f5),
  steam: lin(0xd9dee0),
};

const ribbon = (hex: number, width: number, growth: number, life: number, alpha: number, formDelay: number, spacing: number, interval: number): RibbonStyle => {
  const [r, g, b] = lin(hex);
  return { width, growth, life, alpha, r, g, b, formDelay, spacing, interval };
};
const CONTRAIL = ribbon(0xf4f6f8, 1.3, 1.0, 16, 0.5, 0.35, 70, 0.25);
const VORTEX = ribbon(0xffffff, 0.4, 0.55, 0.9, 0.5, 0, 14, 0.05);
const DAMAGE_SMOKE = ribbon(0x4d4a47, 1.6, 2.4, 7, 0.6, 0, 22, 0.08);
const WRECK_SMOKE = ribbon(0x1f1d1b, 5.5, 5.0, 26, 0.9, 0, 18, 0.07);
const FLARE_SMOKE = ribbon(0xe2e2e0, 1.2, 2.0, 5, 0.7, 0, 5, 0.06);

const SIZE_M: Record<ExplosionSize, number> = { tiny: 3, small: 9, medium: 16, large: 30, huge: 55 };

/**
 * A damaged landmark (the Sky Tower after an enemy hit, sim/landmarks.ts hitLandmark): flames on its
 * face at the hit height and a thick dark plume drifting downwind, readable from 10+ km, for as long
 * as it stands damaged (the collapse brings its own fires). Rates per second (× particleScale × LOD,
 * never below `minLod`, so the plume is not thinned out at range); minimum sizes in device pixels.
 */
export const LANDMARK_FIRE = {
  flamesPerSec: 34,
  smokePerSec: 6,
  minLod: 0.5,
  flameMinPx: 2.5,
  smokeMinPx: 3,
};

/**
 * Air-kill payoff tuning (i1 review: kills were 1-3 px at BVR ranges). Minimum on-screen sizes are
 * in device pixels; `scale` is the fireball size in metres for an aircraft of the given length.
 */
export const AIR_KILL = {
  flashMinPx: 64,
  glowMinPx: 36,
  fireballMinPx: 10,
  coreMinPx: 8,
  smokeMinPx: 5,
  secondaries: 3,
  scale: (length: number) => Math.max(36, length * 2.8),
};

function trailStyleFor(def: MunitionDef): RibbonStyle | null {
  if (def.category === 'bomb' || def.smoke <= 0.01) return null;
  const sam = def.category === 'sam';
  const ir = def.guidance === 'ir';
  const dia = Math.min(2.4, Math.max(0.5, (def.diameter || 0.2) / 0.2));
  const hex = sam ? 0xf3f3f0 : ir ? 0xb9b8b4 : def.id === 'r27' ? 0xe6e6e2 : 0xd9d9d6;
  const width = (sam ? 3.6 : ir ? 1.8 : 1.4) * (0.6 + 0.4 * dia);
  const growth = sam ? 3.0 : ir ? 1.7 : 1.4;
  const life = sam ? 24 : ir ? 11 : 8;
  const alpha = Math.min(0.92, 0.45 + 0.5 * def.smoke);
  return ribbon(hex, width, growth, life, alpha, 0, sam ? 16 : 22, 0.05);
}

/* ───────────────────────── pooled trackers ───────────────────────── */

interface MissileFx {
  seen: number;
  ribbon: number;
  motor: boolean;
  style: RibbonStyle | null;
  sam: boolean;
}
interface AircraftFx {
  seen: number;
  contrail: number[];
  vortex: number[];
  damage: number;
  wreck: number;
  crashed: boolean;
  gunAcc: number;
  coneBoost: number;
}
interface DecoyFx {
  seen: number;
  ribbon: number;
  sparkAcc: number;
}
interface FireFx {
  active: boolean;
  pos: Vector3;
  t0: number;
  dur: number;
  size: number;
  fAcc: number;
  sAcc: number;
}
/** A sinking ship: fires on its deck that ride the hull down (shipMotion.shipMatrix). */
interface ShipFx {
  ship: GroundTargetEntity | null;
  /** Fire points (local, bow at -Z) and their sizes. */
  pts: Vector3[];
  sizes: number[];
  fAcc: number;
  sAcc: number;
}
interface Delayed {
  active: boolean;
  t: number;
  pos: Vector3;
  size: ExplosionSize;
  surface: 'air' | 'ground' | 'water';
}
interface Pending {
  active: boolean;
  pos: Vector3;
  size: ExplosionSize;
  surface: 'air' | 'ground' | 'water';
  t: number;
}

const _v = new Vector3();
const _sm = new Matrix4();
/** Funnel exhaust: puffs per second per ship (× particleScale × distance LOD), drawn out to this range (m). */
const FUNNEL_SMOKE_RATE = 1.6;
const FUNNEL_SMOKE_FAR = 8000;
const _w = new Vector3();
const _f = new Vector3();

/** Radius of the crater a StormBreaker leaves where it killed the stoat (m): about 6 m across. */
export const STOAT_CRATER_RADIUS = 3;

export const createEffects: CreateEffects = (scene, world, events, env, quality) => {
  const ps = Math.min(1.5, Math.max(0.2, quality.particleScale));
  const root = new Group();
  root.name = 'effects';
  scene.add(root);

  const smoke = new GpuParticles(Math.round(6000 * ps), 'normal', smokeTexture(), 10);
  const fire = new GpuParticles(Math.round(4000 * ps), 'additive', fireTexture(), 11);
  const ribbons = new Ribbons(Math.round(5000 * ps), 96, 9);
  const sprites = new SpriteBatch(1200, glowTexture(), 12);
  const debris = new Debris(Math.round(80 * ps));
  const pulses = new Pulses(8, 4);
  const cones = new VaporCones(3);
  // impact craters (#201): g03's stoat leaves nothing but the hole the bomb dug
  const craters = new Craters();
  root.add(ribbons.mesh, smoke.mesh, fire.mesh, sprites.mesh, debris.mesh, pulses.group, cones.group, craters.group);

  const wind = new Vector3(4.5, 0, 1.8);
  const cam = new Vector3(0, 1000, 0);
  const P: ParticleSpawn = spawnParams();
  const rnd = Math.random;
  let frame = 0;
  let night = env.isNight;

  const missileFx = new Map<number, MissileFx>();
  const missilePool: MissileFx[] = [];
  const aircraftFx = new Map<number, AircraftFx>();
  const decoyFx = new Map<number, DecoyFx>();
  const decoyPool: DecoyFx[] = [];
  const fires: FireFx[] = Array.from({ length: 28 }, () => ({ active: false, pos: new Vector3(), t0: 0, dur: 0, size: 1, fAcc: 0, sAcc: 0 }));
  const delayed: Delayed[] = Array.from({ length: 24 }, () => ({ active: false, t: 0, pos: new Vector3(), size: 'small' as ExplosionSize, surface: 'ground' as const }));
  const pending: Pending[] = Array.from({ length: 24 }, () => ({ active: false, pos: new Vector3(), size: 'small' as ExplosionSize, surface: 'air' as const, t: 0 }));
  const recent: { pos: Vector3; t: number }[] = Array.from({ length: 16 }, () => ({ pos: new Vector3(), t: -99 }));
  let recentHead = 0;
  const aaa = new Map<number, { firing: boolean; pos: Vector3 }>();
  const shipFx: ShipFx[] = Array.from({ length: 8 }, () => ({ ship: null, pts: [new Vector3(), new Vector3(), new Vector3()], sizes: [0, 0, 0], fAcc: 0, sAcc: 0 }));
  /** Funnel smoke emission accumulators (per live ship id). */
  const funnelAcc = new Map<number, number>();
  /** Damaged-landmark fire emission accumulators (flames, smoke). */
  const landmarkAcc = new Map<object, { f: number; s: number }>();
  /** Fire / smoke accumulators of a hit ship still afloat (per ship id: the escorted tanker after its first hit). */
  const burnAcc = new Map<number, { f: number; s: number }>();
  const trailStyles = new Map<string, RibbonStyle | null>();

  const now = () => world.time;
  const distCam = (x: number, y: number, z: number) => Math.sqrt((x - cam.x) ** 2 + (y - cam.y) ** 2 + (z - cam.z) ** 2);
  /** Emission multiplier by distance (small on screen → fewer particles). */
  const lodK = (d: number) => (d < 1500 ? 1 : d < 5000 ? 0.6 : d < 12000 ? 0.35 : 0.2);
  const count = (n: number, d: number) => Math.max(n > 0 ? 1 : 0, Math.round(n * ps * lodK(d)));
  const groundAt = (x: number, z: number) => world.terrain.surfaceHeightAt(x, z);

  function col0(p: ParticleSpawn, c: RGB, a: number, k = 1): void {
    p.r0 = c[0] * k;
    p.g0 = c[1] * k;
    p.b0 = c[2] * k;
    p.a0 = a;
  }
  function col1(p: ParticleSpawn, c: RGB, a: number, k = 1): void {
    p.r1 = c[0] * k;
    p.g1 = c[1] * k;
    p.b1 = c[2] * k;
    p.a1 = a;
  }
  /** Random unit vector into _w (optionally hemisphere-biased upward). */
  function randDir(up = 0): Vector3 {
    let x: number;
    let y: number;
    let z: number;
    let l: number;
    do {
      x = rnd() * 2 - 1;
      y = rnd() * 2 - 1;
      z = rnd() * 2 - 1;
      l = x * x + y * y + z * z;
    } while (l > 1 || l < 1e-4);
    l = Math.sqrt(l);
    _w.set(x / l, y / l + up, z / l);
    return _w.normalize();
  }

  /* ───────────── recipes ───────────── */

  function explode(x: number, y: number, z: number, size: ExplosionSize, surface: 'air' | 'ground' | 'water'): void {
    const t = now();
    const S = SIZE_M[size];
    const d = distCam(x, y, z);
    const big = size === 'large' || size === 'huge';
    const up = surface === 'air' ? 0 : 0.6;
    const r = recent[recentHead];
    r.pos.set(x, y, z);
    r.t = t;
    recentHead = (recentHead + 1) % recent.length;

    // flash
    resetSpawn(P);
    P.x = x;
    P.y = y + (surface === 'air' ? 0 : S * 0.2);
    P.z = z;
    P.life = 0.12 + S * 0.004;
    P.size0 = S * 2.2;
    P.size1 = S * 3.4;
    col0(P, [1, 0.9, 0.7], 1, 3);
    col1(P, [1, 0.55, 0.2], 0, 1.5);
    P.minPx = 26;
    fire.spawn(P, t);

    if (surface === 'water') {
      waterSplash(x, y, z, S, d, t);
    } else {
      // fireball
      const nf = count(size === 'tiny' ? 2 : size === 'small' ? 6 : size === 'medium' ? 10 : size === 'large' ? 14 : 20, d);
      for (let i = 0; i < nf; i++) {
        resetSpawn(P);
        randDir(up);
        const rr = S * 0.3 * rnd();
        P.x = x + _w.x * rr;
        P.y = y + _w.y * rr + (surface === 'ground' ? S * 0.25 : 0);
        P.z = z + _w.z * rr;
        const sp = S * (0.8 + rnd());
        P.vx = _w.x * sp;
        P.vy = _w.y * sp + (surface === 'ground' ? S * 0.4 : 0);
        P.vz = _w.z * sp;
        P.drag = 3.2;
        P.grav = 3;
        P.size0 = S * 0.45;
        P.size1 = S * (1.0 + rnd() * 0.6);
        P.sizeCurve = 3;
        P.life = (0.7 + rnd() * 0.6) * (0.6 + S / 45);
        P.rot = rnd() * 6.28;
        P.rotSpeed = (rnd() - 0.5) * 2;
        P.variant = 2 + (rnd() < 0.5 ? 1 : 0);
        col0(P, [1, 0.58, 0.2], 0.85, 1.35);
        col1(P, [0.85, 0.18, 0.03], 0, 1.0);
        P.fadeIn = 0.03;
        fire.spawn(P, t);
      }
      // smoke
      const ns = count(size === 'tiny' ? 2 : size === 'small' ? 8 : size === 'medium' ? 14 : size === 'large' ? 22 : 34, d);
      const sc1 = surface === 'ground' ? C.smokeMid : C.smokeGrey;
      for (let i = 0; i < ns; i++) {
        resetSpawn(P);
        randDir(up * 0.8);
        const rr = S * 0.4 * rnd();
        P.x = x + _w.x * rr;
        P.y = y + Math.abs(_w.y) * rr + (surface === 'ground' ? S * 0.3 : 0);
        P.z = z + _w.z * rr;
        const sp = S * (0.4 + rnd() * 0.5);
        P.vx = _w.x * sp;
        P.vy = _w.y * sp + S * 0.25;
        P.vz = _w.z * sp;
        P.drag = 1.1;
        P.grav = 2.5 + rnd() * 2;
        P.size0 = S * 0.55;
        P.size1 = S * (2.0 + rnd() * 1.2);
        P.sizeCurve = 2.4;
        P.life = (3.5 + rnd() * 3) * (0.8 + S / 40);
        P.rot = rnd() * 6.28;
        P.rotSpeed = (rnd() - 0.5) * 0.4;
        P.variant = (rnd() * 4) | 0;
        // ground blasts: dark smoke core mixed with lighter dust
        col0(P, surface === 'ground' && i % 3 === 2 ? C.dust : C.smokeDark, 0.92);
        col1(P, sc1, 0);
        P.fadeIn = 0.05;
        smoke.spawn(P, t);
      }
    }
    // sparks
    const nsp = count(size === 'tiny' ? 5 : size === 'small' ? 16 : size === 'medium' ? 24 : size === 'large' ? 34 : 50, d);
    for (let i = 0; i < nsp; i++) {
      resetSpawn(P);
      randDir(surface === 'air' ? 0 : 0.8);
      const sp = (30 + rnd() * 70) * Math.sqrt(S / 10);
      P.x = x;
      P.y = y + (surface === 'air' ? 0 : 1);
      P.z = z;
      P.vx = _w.x * sp;
      P.vy = _w.y * sp;
      P.vz = _w.z * sp;
      P.drag = 0.7;
      P.grav = -9.8;
      P.size0 = 0.35 + rnd() * 0.4;
      P.size1 = 0.15;
      P.life = 0.6 + rnd() * 1.2;
      P.streak = 0.035;
      P.variant = 1;
      P.minPx = 1.6;
      col0(P, [1, 0.7, 0.35], 1, 4);
      col1(P, [1, 0.3, 0.05], 0, 2);
      fire.spawn(P, t);
    }
    // debris
    if (size !== 'tiny' && size !== 'small' && surface !== 'water') {
      const nd = Math.round((size === 'medium' ? 5 : size === 'large' ? 9 : 14) * ps * (d < 4000 ? 1 : 0.4));
      for (let i = 0; i < nd; i++) {
        randDir(surface === 'ground' ? 1.2 : 0.3);
        const sp = S * (1.2 + rnd() * 1.6);
        debris.spawn(x, y + 1, z, _w.x * sp, _w.y * sp, _w.z * sp, 0.4 + rnd() * S * 0.04, 4 + rnd() * 5, 1.2 + rnd() * 2);
      }
    }
    // ground shockwave / air shock
    if (surface === 'ground' && (big || size === 'medium')) {
      pulses.fire('ring', x, groundAt(x, z) + 0.6, z, S * 0.3, S * (big ? 5 : 3), big ? 1.1 : 0.8, DUST_COL, 0.55);
      const nr = count(big ? 16 : 8, d);
      for (let i = 0; i < nr; i++) {
        resetSpawn(P);
        const a = (i / nr) * 6.283 + rnd() * 0.3;
        const sp = S * (1.2 + rnd() * 0.8);
        P.x = x + Math.cos(a) * S * 0.3;
        P.y = groundAt(x, z) + S * 0.1;
        P.z = z + Math.sin(a) * S * 0.3;
        P.vx = Math.cos(a) * sp;
        P.vz = Math.sin(a) * sp;
        P.vy = 1;
        P.drag = 1.4;
        P.grav = 0.5;
        P.size0 = S * 0.35;
        P.size1 = S * 1.4;
        P.sizeCurve = 2;
        P.life = 3 + rnd() * 2.5;
        P.variant = (rnd() * 4) | 0;
        P.rot = rnd() * 6;
        col0(P, C.dust, 0.6);
        col1(P, C.dustLight, 0);
        smoke.spawn(P, t);
      }
    } else if (surface === 'air' && big) {
      pulses.fire('sphere', x, y, z, S * 0.4, S * 3.2, 0.35, SHOCK_COL, 0.5);
    }
  }

  const DUST_COL = new Color(0x9b8a6c);
  const FIREBALL_CORE: RGB = [1, 0.5, 0.12];
  const SHOCK_COL = new Color(0xfff2d8);
  const FOAM_COL = new Color(0xf0f4f5);

  function waterSplash(x: number, y: number, z: number, S: number, d: number, t: number): void {
    const n = count(Math.round(10 + S * 0.8), d);
    for (let i = 0; i < n; i++) {
      resetSpawn(P);
      const a = rnd() * 6.283;
      const rr = rnd() * S * 0.25;
      P.x = x + Math.cos(a) * rr;
      P.y = 0.5;
      P.z = z + Math.sin(a) * rr;
      const upv = S * (1.2 + rnd() * 1.8);
      P.vx = Math.cos(a) * S * 0.3 * rnd();
      P.vz = Math.sin(a) * S * 0.3 * rnd();
      P.vy = upv;
      P.drag = 0.35;
      P.grav = -9.8;
      P.size0 = S * 0.25;
      P.size1 = S * 0.8;
      P.sizeCurve = 1.5;
      P.life = 1.6 + rnd() * 1.6 + S * 0.03;
      P.variant = (rnd() * 4) | 0;
      P.rot = rnd() * 6;
      col0(P, C.water, 0.95);
      col1(P, C.steam, 0);
      smoke.spawn(P, t);
    }
    // mist ring
    const nm = count(8, d);
    for (let i = 0; i < nm; i++) {
      resetSpawn(P);
      const a = (i / nm) * 6.283;
      P.x = x;
      P.y = 1;
      P.z = z;
      P.vx = Math.cos(a) * S * 0.9;
      P.vz = Math.sin(a) * S * 0.9;
      P.drag = 1.5;
      P.grav = 0.3;
      P.size0 = S * 0.3;
      P.size1 = S * 1.2;
      P.life = 2.5 + rnd();
      P.variant = (rnd() * 4) | 0;
      col0(P, C.steam, 0.5);
      col1(P, C.steam, 0);
      smoke.spawn(P, t);
    }
    pulses.fire('ring', x, 0.3, z, S * 0.2, S * 2.5, 2.5, FOAM_COL, 0.55);
    void y;
  }

  function smallPuff(x: number, y: number, z: number, vx: number, vy: number, vz: number, c: RGB, a: number, s0: number, s1: number, life: number): void {
    resetSpawn(P);
    P.x = x;
    P.y = y;
    P.z = z;
    P.vx = vx + (rnd() - 0.5) * 2;
    P.vy = vy + (rnd() - 0.5) * 2;
    P.vz = vz + (rnd() - 0.5) * 2;
    P.drag = 1.3;
    P.grav = 0.6;
    P.size0 = s0;
    P.size1 = s1;
    P.sizeCurve = 2;
    P.life = life;
    P.rot = rnd() * 6.28;
    P.rotSpeed = (rnd() - 0.5) * 0.6;
    P.variant = (rnd() * 4) | 0;
    col0(P, c, a);
    col1(P, c, 0, 1.15);
    P.fadeIn = 0.04;
    smoke.spawn(P, now());
  }

  function fireLick(x: number, y: number, z: number, vx: number, vy: number, vz: number, s: number, life: number, k = 1, minPx = 0): void {
    resetSpawn(P);
    P.x = x;
    P.y = y;
    P.z = z;
    P.vx = vx;
    P.vy = vy;
    P.vz = vz;
    P.drag = 1.5;
    P.grav = 4;
    P.size0 = s;
    P.size1 = s * 0.35;
    P.life = life;
    P.rot = rnd() * 6.28;
    P.rotSpeed = (rnd() - 0.5) * 3;
    P.variant = 2 + (rnd() < 0.5 ? 1 : 0);
    P.flicker = 0.25;
    col0(P, [1, 0.55, 0.18], 1, 1.8 * k);
    col1(P, [0.9, 0.18, 0.03], 0, 1);
    P.fadeIn = 0.1;
    P.minPx = minPx;
    fire.spawn(P, now());
  }

  function sparks(x: number, y: number, z: number, n: number, speed: number): void {
    const t = now();
    for (let i = 0; i < n; i++) {
      resetSpawn(P);
      randDir(0.2);
      const sp = speed * (0.4 + rnd());
      P.x = x;
      P.y = y;
      P.z = z;
      P.vx = _w.x * sp;
      P.vy = _w.y * sp;
      P.vz = _w.z * sp;
      P.drag = 1;
      P.grav = -9.8;
      P.size0 = 0.3;
      P.size1 = 0.1;
      P.life = 0.3 + rnd() * 0.5;
      P.streak = 0.03;
      P.variant = 1;
      P.minPx = 1.4;
      col0(P, [1, 0.75, 0.4], 1, 4);
      col1(P, [1, 0.3, 0.05], 0, 2);
      fire.spawn(P, t);
    }
  }

  function startFire(x: number, y: number, z: number, size: number, dur: number): void {
    let slot = fires.find((f) => !f.active);
    if (!slot) slot = fires.reduce((a, b) => (a.t0 < b.t0 ? a : b));
    slot.active = true;
    slot.pos.set(x, y, z);
    slot.t0 = now();
    slot.dur = dur;
    slot.size = size;
    slot.fAcc = slot.sAcc = 0;
  }

  /**
   * Air kill: a readable, dramatic payoff from 1–5 km. Big distance-compensated flash (never smaller
   * than ~48 px for 0.35 s), a fuel fireball carried along the flight path (min pixel size so it
   * reads at BVR ranges), a dark smoke cloud, 3 secondary explosions along the falling wreck's
   * path, and burning debris with smoke trails. The burning, tumbling wreck itself is drawn by the
   * aircraft scan (thick smoke ribbon + fire licks).
   */
  function airKill(p: Vector3, vel: Vector3, length: number): void {
    const t = now();
    const d = distCam(p.x, p.y, p.z);
    const S = AIR_KILL.scale(length); // fireball scale (m): ~45-50 m for a fighter
    // flash + lingering glow
    resetSpawn(P);
    P.x = p.x;
    P.y = p.y;
    P.z = p.z;
    P.life = 0.35;
    P.size0 = S * 2.6;
    P.size1 = S * 4;
    col0(P, [1, 0.92, 0.75], 1, 4);
    col1(P, [1, 0.5, 0.15], 0, 2);
    P.minPx = AIR_KILL.flashMinPx;
    fire.spawn(P, t);
    resetSpawn(P);
    P.x = p.x;
    P.y = p.y;
    P.z = p.z;
    P.vx = vel.x * 0.5;
    P.vy = vel.y * 0.5;
    P.vz = vel.z * 0.5;
    P.drag = 1.2;
    P.life = 1.1;
    P.size0 = S * 1.6;
    P.size1 = S * 2.2;
    col0(P, [1, 0.6, 0.22], 0.9, 2.2);
    col1(P, [0.9, 0.25, 0.05], 0, 1);
    P.minPx = AIR_KILL.glowMinPx;
    fire.spawn(P, t);
    // fuel fireball, carried forward with the wreck's momentum
    const nf = Math.max(8, count(22, d));
    for (let i = 0; i < nf; i++) {
      resetSpawn(P);
      randDir(0.1);
      const rr = S * 0.35 * rnd();
      P.x = p.x + _w.x * rr;
      P.y = p.y + _w.y * rr;
      P.z = p.z + _w.z * rr;
      const sp = S * (0.5 + rnd() * 0.8);
      P.vx = vel.x * 0.55 + _w.x * sp;
      P.vy = vel.y * 0.55 + _w.y * sp;
      P.vz = vel.z * 0.55 + _w.z * sp;
      P.drag = 2.2;
      P.grav = 2;
      P.size0 = S * 0.5;
      P.size1 = S * (1.1 + rnd() * 0.7);
      P.sizeCurve = 3;
      P.life = 1.3 + rnd() * 1.0;
      P.rot = rnd() * 6.28;
      P.rotSpeed = (rnd() - 0.5) * 2;
      P.variant = 2 + (rnd() < 0.5 ? 1 : 0);
      col0(P, [1, 0.5, 0.14], 0.9, 1.05);
      col1(P, [0.8, 0.16, 0.03], 0, 0.9);
      P.fadeIn = 0.03;
      P.minPx = AIR_KILL.fireballMinPx;
      fire.spawn(P, t);
    }
    // opaque (normal-blended) fireball core so the burst reads against a bright daytime sky, where
    // additive fire washes out: orange → dark smoke
    const nc = Math.max(5, count(12, d));
    for (let i = 0; i < nc; i++) {
      resetSpawn(P);
      randDir(0.1);
      const rr = S * 0.3 * rnd();
      P.x = p.x + _w.x * rr;
      P.y = p.y + _w.y * rr;
      P.z = p.z + _w.z * rr;
      const sp = S * (0.4 + rnd() * 0.6);
      P.vx = vel.x * 0.5 + _w.x * sp;
      P.vy = vel.y * 0.5 + _w.y * sp;
      P.vz = vel.z * 0.5 + _w.z * sp;
      P.drag = 2;
      P.grav = 1.5;
      P.size0 = S * 0.6;
      P.size1 = S * (1.4 + rnd() * 0.6);
      P.sizeCurve = 2.5;
      P.life = 1.6 + rnd() * 1.2;
      P.rot = rnd() * 6.28;
      P.variant = (rnd() * 4) | 0;
      col0(P, FIREBALL_CORE, 1, 1.4);
      col1(P, C.smokeDark, 0.2);
      P.fadeIn = 0.02;
      P.minPx = AIR_KILL.coreMinPx;
      smoke.spawn(P, t);
    }
    // dark smoke cloud left hanging where the jet died
    const ns = Math.max(6, count(18, d));
    for (let i = 0; i < ns; i++) {
      resetSpawn(P);
      randDir(0.2);
      const rr = S * 0.4 * rnd();
      P.x = p.x + _w.x * rr;
      P.y = p.y + _w.y * rr;
      P.z = p.z + _w.z * rr;
      const sp = S * (0.3 + rnd() * 0.4);
      P.vx = vel.x * 0.3 + _w.x * sp;
      P.vy = vel.y * 0.3 + _w.y * sp;
      P.vz = vel.z * 0.3 + _w.z * sp;
      P.drag = 1.4;
      P.grav = 1.5;
      P.size0 = S * 0.6;
      P.size1 = S * (2.2 + rnd() * 1.4);
      P.sizeCurve = 2.2;
      P.life = 7 + rnd() * 5;
      P.rot = rnd() * 6.28;
      P.rotSpeed = (rnd() - 0.5) * 0.3;
      P.variant = (rnd() * 4) | 0;
      col0(P, C.smokeDark, 0.95);
      col1(P, C.smokeMid, 0);
      P.fadeIn = 0.15;
      P.minPx = AIR_KILL.smokeMinPx;
      smoke.spawn(P, t);
    }
    sparks(p.x, p.y, p.z, count(30, d), 55);
    // secondaries along the falling wreck's (ballistic) path
    for (let i = 0; i < AIR_KILL.secondaries; i++) {
      const dl = 0.3 + i * 0.45 + rnd() * 0.25;
      schedule(
        dl,
        p.x + vel.x * dl * 0.85 + (rnd() - 0.5) * 12,
        p.y + vel.y * dl * 0.85 - 4.9 * dl * dl + (rnd() - 0.5) * 8,
        p.z + vel.z * dl * 0.85 + (rnd() - 0.5) * 12,
        i === 0 ? 'large' : 'medium',
        'air',
      );
    }
    // burning debris with smoke trails
    const nd = Math.max(4, Math.round(12 * ps));
    for (let i = 0; i < nd; i++) {
      randDir(0.35);
      const sp = 25 + rnd() * 45;
      debris.spawn(p.x, p.y, p.z, vel.x * 0.6 + _w.x * sp, vel.y * 0.6 + _w.y * sp, vel.z * 0.6 + _w.z * sp, 0.6 + rnd() * 1.1, 7 + rnd() * 4, 2.5 + rnd() * 2.5);
    }
  }

  /**
   * The Sky Tower's pod hitting the ground: a dust wall rolling out along the fall line and the cross
   * street (most of it channelled by the CBD's street canyons), plus a long-lived smoke column.
   */
  function collapseDust(x: number, gy: number, z: number, heading: number): void {
    const t = now();
    const d = distCam(x, gy, z);
    const ux = Math.sin(heading);
    const uz = -Math.cos(heading);
    const n = count(140, d);
    for (let i = 0; i < n; i++) {
      resetSpawn(P);
      // four street directions: along the fall line (both ways) and across it
      const k = i % 4;
      const ax = k < 2 ? ux : -uz;
      const az = k < 2 ? uz : ux;
      const sgn = k % 2 === 0 ? 1 : -1;
      const along = (rnd() - 0.2) * 160;
      const side = (rnd() - 0.5) * 30;
      P.x = x + ax * along * (k < 2 ? 1 : 0.4) + -az * side;
      P.z = z + az * along * (k < 2 ? 1 : 0.4) + ax * side;
      P.y = gy + 4 + rnd() * 18;
      const sp = 14 + rnd() * 26;
      P.vx = ax * sgn * sp + (rnd() - 0.5) * 6;
      P.vz = az * sgn * sp + (rnd() - 0.5) * 6;
      P.vy = 3 + rnd() * 9;
      P.drag = 0.45;
      P.grav = 0.8;
      P.size0 = 14 + rnd() * 10;
      P.size1 = 55 + rnd() * 45;
      P.sizeCurve = 1.6;
      P.life = 9 + rnd() * 8;
      P.rot = rnd() * 6.28;
      P.rotSpeed = (rnd() - 0.5) * 0.3;
      P.variant = (rnd() * 4) | 0;
      col0(P, i % 3 === 0 ? C.dust : C.dustLight, 0.9);
      col1(P, C.smokeGrey, 0);
      P.fadeIn = 0.06;
      P.minPx = 4;
      smoke.spawn(P, t);
    }
    startFire(x, gy, z, 3.2, 220);
    groundPillar(x, gy, z, 1.8);
  }

  /** SAM / ground kill: a rising fire pillar that seeds the tall smoke column. */
  function groundPillar(x: number, gy: number, z: number, k: number): void {
    const t = now();
    const d = distCam(x, gy, z);
    const n = Math.max(6, count(Math.round(18 * k), d));
    for (let i = 0; i < n; i++) {
      resetSpawn(P);
      P.x = x + (rnd() - 0.5) * 8 * k;
      P.y = gy + 2 + rnd() * 6;
      P.z = z + (rnd() - 0.5) * 8 * k;
      P.vx = (rnd() - 0.5) * 6;
      P.vy = (35 + rnd() * 45) * k;
      P.vz = (rnd() - 0.5) * 6;
      P.drag = 1.1;
      P.grav = 3;
      P.size0 = 9 * k;
      P.size1 = (20 + rnd() * 14) * k;
      P.sizeCurve = 2;
      P.life = 1.4 + rnd() * 1.2;
      P.rot = rnd() * 6.28;
      P.rotSpeed = (rnd() - 0.5) * 2;
      P.variant = 2 + (rnd() < 0.5 ? 1 : 0);
      col0(P, [1, 0.6, 0.22], 0.95, 1.6);
      col1(P, [0.8, 0.2, 0.04], 0, 1);
      P.fadeIn = 0.05;
      P.minPx = 5;
      fire.spawn(P, t);
    }
    for (let i = 0; i < Math.max(4, count(Math.round(12 * k), d)); i++) {
      resetSpawn(P);
      P.x = x + (rnd() - 0.5) * 10 * k;
      P.y = gy + 6 + rnd() * 10;
      P.z = z + (rnd() - 0.5) * 10 * k;
      P.vx = (rnd() - 0.5) * 4;
      P.vy = (25 + rnd() * 30) * k;
      P.vz = (rnd() - 0.5) * 4;
      P.drag = 0.6;
      P.grav = 2;
      P.size0 = 12 * k;
      P.size1 = (50 + rnd() * 40) * k;
      P.sizeCurve = 1.8;
      P.life = 14 + rnd() * 8;
      P.rot = rnd() * 6.28;
      P.variant = (rnd() * 4) | 0;
      col0(P, C.smokeDark, 0.9);
      col1(P, C.smokeMid, 0);
      P.fadeIn = 0.08;
      P.minPx = 4;
      smoke.spawn(P, t);
    }
  }

  /**
   * Ship kill: a fire pillar off the deck, secondaries along the hull, then fires on the fore deck,
   * amidships and aft that keep burning (and feed one tall smoke column) while the hull lists,
   * settles and goes under (updateShips). A burning oil slick marks the spot afterwards.
   */
  function shipKill(g: GroundTargetEntity): void {
    const dims = shipDims(g.vessel);
    const L = dims.length;
    const k = Math.max(0.6, Math.min(1.6, L / 180));
    shipMatrix(g, now(), _sm);
    _v.set(0, dims.deck, 0).applyMatrix4(_sm);
    groundPillar(_v.x, _v.y, _v.z, 1.6 * k);
    for (let i = 0; i < 4; i++) {
      _v.set((rnd() - 0.5) * dims.beam * 0.6, dims.deck + 2, (rnd() - 0.5) * L * 0.8).applyMatrix4(_sm);
      schedule(0.5 + rnd() * 2.5 * (i + 1), _v.x, _v.y, _v.z, i === 0 ? 'huge' : i === 1 ? 'large' : 'medium', 'ground');
    }
    funnelAcc.delete(g.id);
    burnAcc.delete(g.id);
    const fx = shipFx.find((f) => !f.ship) ?? shipFx[0];
    fx.ship = g;
    fx.fAcc = fx.sAcc = 0;
    fx.pts[0].set(0, dims.deck + 2, -L * 0.28);
    fx.pts[1].set(dims.beam * 0.15, dims.deck + 4, L * 0.02);
    fx.pts[2].set(0, dims.deck + 6, L * 0.3);
    fx.sizes[0] = 2.2 * k;
    fx.sizes[1] = 1.8 * k;
    fx.sizes[2] = 2.6 * k;
  }

  function updateShips(t: number, dt: number): void {
    // sinking ships
    for (const fx of shipFx) {
      const g = fx.ship;
      if (!g) continue;
      const sink = shipMatrix(g, t, _sm);
      if (sink.progress >= 1) {
        // gone: a last gasp of steam and a burning slick where she went down
        _v.set(0, 0, 0).applyMatrix4(_sm);
        for (let i = 0; i < count(10, distCam(_v.x, 0, _v.z)); i++)
          smallPuff(_v.x + (rnd() - 0.5) * 60, 1, _v.z + (rnd() - 0.5) * 60, 0, 6 + rnd() * 6, 0, C.steam, 0.6, 8, 40, 7);
        startFire(g.position.x, 0.3, g.position.z, 1.3, 60);
        fx.ship = null;
        continue;
      }
      const flame = 1 - smooth(0.6, 0.95, sink.progress);
      for (let i = 0; i < fx.pts.length; i++) {
        _v.copy(fx.pts[i]).applyMatrix4(_sm);
        const d = distCam(_v.x, _v.y, _v.z);
        const size = fx.sizes[i];
        if (_v.y < 0.6) {
          // flooded: steam where the fire meets the sea
          if (_v.y > -8 && rnd() < dt * 2 * ps) smallPuff(_v.x, 1, _v.z, 0, 4, 0, C.steam, 0.5, 5, 26, 5);
          continue;
        }
        fx.fAcc += dt * 14 * size * flame * ps * lodK(d);
        while (fx.fAcc >= 1) {
          fx.fAcc -= 1;
          const r = 3 * size;
          fireLick(_v.x + (rnd() - 0.5) * r * 2, _v.y + rnd() * 2, _v.z + (rnd() - 0.5) * r * 2, (rnd() - 0.5) * 2, 3 + rnd() * 5, (rnd() - 0.5) * 2, (3 + rnd() * 3.5) * size, 0.7 + rnd() * 0.5, 1, 2);
        }
      }
      // one tall smoke column from amidships (fed by all the fires)
      _v.copy(fx.pts[1]).applyMatrix4(_sm);
      if (_v.y < 0) _v.y = 0;
      const d = distCam(_v.x, _v.y, _v.z);
      const k = fx.sizes[1];
      fx.sAcc += dt * (1.6 + 1.6 * k) * ps * Math.max(0.5, lodK(d)) * (0.4 + 0.6 * flame);
      while (fx.sAcc >= 1) {
        fx.sAcc -= 1;
        resetSpawn(P);
        P.x = _v.x + (rnd() - 0.5) * 30;
        P.y = _v.y + 4 + rnd() * 6;
        P.z = _v.z + (rnd() - 0.5) * 30;
        P.vx = (rnd() - 0.5) * 3;
        P.vy = 9 + rnd() * 6;
        P.vz = (rnd() - 0.5) * 3;
        P.drag = 0.28;
        P.grav = 4.2;
        P.size0 = 9 * k;
        P.size1 = (45 + rnd() * 40) * k;
        P.sizeCurve = 1.6;
        P.life = 20 + rnd() * 10;
        P.rot = rnd() * 6.28;
        P.rotSpeed = (rnd() - 0.5) * 0.15;
        P.variant = (rnd() * 4) | 0;
        col0(P, flame > 0.3 ? C.smokeDark : C.smokeMid, 0.85 * (0.5 + 0.5 * flame));
        col1(P, C.smokeGrey, 0);
        P.fadeIn = 0.04;
        P.minPx = 3;
        smoke.spawn(P, t);
      }
    }
    // living ships: a thin plume from the funnel (low rate, scaled by particleScale and distance)
    for (const g of world.ground) {
      if (g.type !== 'ship' || !g.alive || !g.vessel) continue;
      if (g.hits > 0) burnHitShip(g, t, dt);
      const funnel = shipDims(g.vessel).funnel;
      if (!funnel) continue; // a harbour ferry: no funnel
      const d = distCam(g.position.x, 40, g.position.z);
      if (d > FUNNEL_SMOKE_FAR) {
        funnelAcc.delete(g.id);
        continue;
      }
      let acc = (funnelAcc.get(g.id) ?? rnd()) + dt * FUNNEL_SMOKE_RATE * ps * lodK(d);
      if (acc >= 1) {
        shipMatrix(g, t, _sm);
        _v.set(funnel[0], funnel[1] + 1.5, funnel[2]).applyMatrix4(_sm);
        const v = g.velocity;
        while (acc >= 1) {
          acc -= 1;
          resetSpawn(P);
          P.x = _v.x + (rnd() - 0.5) * 2;
          P.y = _v.y;
          P.z = _v.z + (rnd() - 0.5) * 2;
          P.vx = v.x * 0.8 + (rnd() - 0.5);
          P.vy = 3 + rnd() * 2;
          P.vz = v.z * 0.8 + (rnd() - 0.5);
          P.drag = 0.5;
          P.grav = 1;
          P.size0 = 3.5;
          P.size1 = 22 + rnd() * 12;
          P.sizeCurve = 1.6;
          P.life = 9 + rnd() * 4;
          P.rot = rnd() * 6.28;
          P.rotSpeed = (rnd() - 0.5) * 0.3;
          P.variant = (rnd() * 4) | 0;
          col0(P, C.smokeMid, 0.42);
          col1(P, C.smokeGrey, 0);
          P.fadeIn = 0.15;
          P.minPx = 1.5;
          smoke.spawn(P, t);
        }
      }
      funnelAcc.set(g.id, acc);
    }
  }

  /**
   * A ship that took a hit and is still afloat (hitsToSink > 1): a fire on the fore deck, bigger with
   * each hit, and a dark smoke column leaning with her way, until she is hit again or sinks
   * (shipKill takes over then).
   */
  function burnHitShip(g: GroundTargetEntity, t: number, dt: number): void {
    const dims = shipDims(g.vessel);
    const k = Math.max(0.6, Math.min(1.6, dims.length / 180)) * (0.7 + 0.3 * g.hits);
    shipMatrix(g, t, _sm);
    _v.set(dims.beam * 0.12, dims.deck + 1, -dims.length * 0.18).applyMatrix4(_sm);
    const d = distCam(_v.x, _v.y, _v.z);
    let acc = burnAcc.get(g.id);
    if (!acc) burnAcc.set(g.id, (acc = { f: 0, s: 0 }));
    acc.f += dt * 16 * k * ps * lodK(d);
    while (acc.f >= 1) {
      acc.f -= 1;
      const r = 5 * k;
      fireLick(_v.x + (rnd() - 0.5) * r * 2, _v.y + rnd() * 2, _v.z + (rnd() - 0.5) * r * 2, (rnd() - 0.5) * 2, 3 + rnd() * 5, (rnd() - 0.5) * 2, (3 + rnd() * 3.5) * k, 0.7 + rnd() * 0.5, 1, 2);
    }
    acc.s += dt * (1.2 + 1.2 * k) * ps * Math.max(0.5, lodK(d));
    const v = g.velocity;
    while (acc.s >= 1) {
      acc.s -= 1;
      resetSpawn(P);
      P.x = _v.x + (rnd() - 0.5) * 12;
      P.y = _v.y + 4 + rnd() * 4;
      P.z = _v.z + (rnd() - 0.5) * 12;
      P.vx = v.x * 0.6 + (rnd() - 0.5) * 3;
      P.vy = 8 + rnd() * 5;
      P.vz = v.z * 0.6 + (rnd() - 0.5) * 3;
      P.drag = 0.3;
      P.grav = 4;
      P.size0 = 8 * k;
      P.size1 = (35 + rnd() * 30) * k;
      P.sizeCurve = 1.6;
      P.life = 16 + rnd() * 8;
      P.rot = rnd() * 6.28;
      P.rotSpeed = (rnd() - 0.5) * 0.15;
      P.variant = (rnd() * 4) | 0;
      col0(P, C.smokeDark, 0.8);
      col1(P, C.smokeGrey, 0);
      P.fadeIn = 0.04;
      P.minPx = 3;
      smoke.spawn(P, t);
    }
  }

  function schedule(delay: number, x: number, y: number, z: number, size: ExplosionSize, surface: 'air' | 'ground' | 'water'): void {
    const d = delayed.find((e) => !e.active);
    if (!d) return;
    d.active = true;
    d.t = now() + delay;
    d.pos.set(x, y, z);
    d.size = size;
    d.surface = surface;
  }

  /* ───────────── events ───────────── */

  const offs: (() => void)[] = [];
  offs.push(
    events.on('explosion', ({ position, size, surface }) => explode(position.x, position.y, position.z, size, surface)),
    events.on('munition:launch', ({ missile, shooter }) => {
      const p = missile.position;
      const t = now();
      if (shooter.kind === 'sam' || shooter.kind === 'ground') {
        // ground launch: dust cloud blasting outward + booster flash
        const gy = groundAt(p.x, p.z);
        const d = distCam(p.x, p.y, p.z);
        const n = count(16, d);
        for (let i = 0; i < n; i++) {
          resetSpawn(P);
          const a = rnd() * 6.283;
          const sp = 6 + rnd() * 14;
          P.x = p.x;
          P.y = gy + 1.5;
          P.z = p.z;
          P.vx = Math.cos(a) * sp;
          P.vz = Math.sin(a) * sp;
          P.vy = 1 + rnd() * 3;
          P.drag = 0.9;
          P.grav = 0.8;
          P.size0 = 3;
          P.size1 = 12 + rnd() * 8;
          P.sizeCurve = 2;
          P.life = 4 + rnd() * 4;
          P.variant = (rnd() * 4) | 0;
          P.rot = rnd() * 6;
          col0(P, C.dustLight, 0.7);
          col1(P, C.smokeGrey, 0);
          smoke.spawn(P, t);
        }
        resetSpawn(P);
        P.x = p.x;
        P.y = p.y;
        P.z = p.z;
        P.life = 0.35;
        P.size0 = 8;
        P.size1 = 14;
        col0(P, [1, 0.8, 0.5], 1, 5);
        col1(P, [1, 0.4, 0.1], 0, 2);
        P.minPx = 16;
        fire.spawn(P, t);
      } else if (missile.def.category !== 'bomb') {
        // rail launch puff
        const v = shooter.velocity;
        smallPuff(p.x, p.y, p.z, v.x * 0.9, v.y * 0.9, v.z * 0.9, C.smokeGrey, 0.5, 1.2, 5, 1.5);
      }
    }),
    events.on('munition:end', ({ missile, position, reason }) => {
      const fx = missileFx.get(missile.id);
      if (fx && fx.ribbon >= 0) {
        ribbons.release(fx.ribbon, now());
        fx.ribbon = -1;
      }
      if (reason === 'decoyed') return;
      const slot = pending.find((q) => !q.active);
      if (!slot) return;
      slot.active = true;
      slot.pos.copy(position);
      slot.t = now();
      const cat = missile.def.category;
      slot.size = cat === 'bomb' ? (missile.def.id === 'gbu31' ? 'large' : 'medium') : cat === 'sam' ? 'medium' : cat === 'agm' ? 'medium' : 'small';
      slot.surface = reason === 'water' ? 'water' : reason === 'ground' ? 'ground' : 'air';
    }),
    events.on('destroyed', ({ entity }) => {
      const p = entity.position;
      if (entity.kind === 'aircraft') {
        const spec = AIRCRAFT_SPECS[(entity as AircraftEntity).type];
        airKill(p, entity.velocity, spec ? spec.length : 17);
      } else if (entity.kind === 'ground' && entity.type === 'ship') {
        shipKill(entity);
      } else if (entity.kind === 'ground' && entity.type === 'stoat') {
        // the stoat (#201): no fire, no smoke column, no model; the bomb's own blast throws the sand,
        // and the crater it dug stays
        craters.add(p.x, p.z, STOAT_CRATER_RADIUS, groundAt);
      } else if (entity.kind === 'sam' || entity.kind === 'ground') {
        const type = (entity as { type: string }).type;
        const bigFire = type === 'fuel';
        const gy = groundAt(p.x, p.z);
        // tall, long-lived fire + smoke column readable from several km
        startFire(p.x, gy, p.z, bigFire ? 2.8 : 1.7, bigFire ? 170 : 120);
        groundPillar(p.x, gy, p.z, bigFire ? 1.6 : 1);
        const n = bigFire ? 4 : 3;
        for (let i = 0; i < n; i++)
          schedule(0.5 + rnd() * 2.5 * (i + 1), p.x + (rnd() - 0.5) * 24, gy + 2, p.z + (rnd() - 0.5) * 24, i === 0 ? (bigFire ? 'huge' : 'large') : i === 1 ? 'medium' : 'small', 'ground');
      }
    }),
    events.on('landmark:destroyed', ({ landmark }) => {
      // the broken shaft keeps burning over the stump
      const b = landmark.base;
      startFire(b.x, b.y + COLLAPSE.breakHeight - 6, b.z, 1.4, 90);
    }),
    events.on('landmark:impact', ({ position: p, heading }) => collapseDust(p.x, p.y, p.z, heading)),
    // a CBD skyscraper an aircraft flew into (#128): the fireball at the impact, then the dust wall
    // where it comes down, and the stump burning
    // A hero landmark (the player's jet into Spark Arena or the Museum) goes the same way, louder: charges
    // go off round it while it still stands, then it drops (world/scenery/cbdCollapse.ts) onto ground blasts.
    events.on('building:collapsed', ({ position: p, x, z, ground, top, radius, hero }) => {
      schedule(0, p.x, p.y, p.z, 'huge', 'air');
      if (hero?.id === 'harbour_bridge') {
        // a span of the Harbour Bridge (world/scenery/bridgeCollapse.ts): charges along the deck by the impact, then
        // the steel hits the water in a row of splashes along the span (nothing is left up there to burn)
        for (let i = 0; i < 6; i++) schedule(0.15 + (i / 6) * COLLAPSE_DELAY, p.x + (rnd() - 0.5) * 60, p.y - rnd() * 10, p.z + (rnd() - 0.5) * 60, i % 2 ? 'medium' : 'large', 'air');
        const fall = Math.sqrt((2 * Math.max(10, p.y)) / 9.8) + COLLAPSE_DELAY;
        for (let i = 0; i < 7; i++) {
          const u = (i / 6 - 0.5) * radius * 1.6 + (rnd() - 0.5) * 20;
          schedule(fall + rnd() * 0.8, x + HB_DIR[0] * u, 0.5, z + HB_DIR[1] * u, i % 2 ? 'huge' : 'large', 'water');
        }
        return;
      }
      collapseDust(x, ground, z, rnd() * Math.PI * 2);
      startFire(x, ground + 6, z, 1.6, 90);
      if (!hero) return;
      const h = top - ground;
      const r = Math.max(10, radius * 0.8);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + rnd() * 0.6;
        schedule(0.15 + (i / 8) * COLLAPSE_DELAY + rnd() * 0.1, x + Math.sin(a) * r, ground + h * (0.2 + rnd() * 0.6), z - Math.cos(a) * r, i % 3 ? 'medium' : 'large', 'air');
      }
      const down = buildingCollapseTime(h);
      for (let i = 0; i < 4; i++) {
        const a = rnd() * Math.PI * 2;
        schedule(down - 0.4 + i * 0.25, x + Math.sin(a) * r * 0.6, ground + 2, z - Math.cos(a) * r * 0.6, i ? 'large' : 'huge', 'ground');
      }
      startFire(x + r * 0.4, ground + 4, z, 1.4, 120);
    }),
    events.on('damage', ({ target, weapon }) => {
      if (target.kind !== 'aircraft' || weapon === 'gun') return;
      const p = target.position;
      sparks(p.x, p.y, p.z, count(10, distCam(p.x, p.y, p.z)), 25);
    }),
    events.on('gun:impact', ({ position: p, surface }) => {
      const d = distCam(p.x, p.y, p.z);
      if (d > 6000) return;
      const t = now();
      if (surface === 'water') {
        for (let i = 0; i < count(5, d); i++) {
          resetSpawn(P);
          P.x = p.x + (rnd() - 0.5);
          P.y = 0.3;
          P.z = p.z + (rnd() - 0.5);
          P.vx = (rnd() - 0.5) * 3;
          P.vz = (rnd() - 0.5) * 3;
          P.vy = 10 + rnd() * 10;
          P.drag = 0.4;
          P.grav = -9.8;
          P.size0 = 0.6;
          P.size1 = 2.2;
          P.life = 1.4 + rnd() * 0.6;
          P.variant = (rnd() * 4) | 0;
          col0(P, C.water, 0.9);
          col1(P, C.steam, 0);
          smoke.spawn(P, t);
        }
      } else if (surface === 'ground') {
        smallPuff(p.x, p.y + 0.5, p.z, 0, 3, 0, C.dust, 0.75, 1.2, 5, 2.2);
        for (let i = 0; i < count(3, d); i++) {
          resetSpawn(P);
          P.x = p.x;
          P.y = p.y + 0.3;
          P.z = p.z;
          P.vx = (rnd() - 0.5) * 6;
          P.vz = (rnd() - 0.5) * 6;
          P.vy = 6 + rnd() * 8;
          P.drag = 0.5;
          P.grav = -9.8;
          P.size0 = 0.5;
          P.size1 = 1.2;
          P.life = 1.0 + rnd() * 0.5;
          P.variant = (rnd() * 4) | 0;
          col0(P, C.smokeMid, 0.9);
          col1(P, C.dust, 0);
          smoke.spawn(P, t);
        }
        sparks(p.x, p.y + 0.3, p.z, count(2, d), 12);
      } else {
        sparks(p.x, p.y, p.z, count(7, d), 22);
        resetSpawn(P);
        P.x = p.x;
        P.y = p.y;
        P.z = p.z;
        P.life = 0.08;
        P.size0 = 1.5;
        P.size1 = 2.5;
        col0(P, [1, 0.8, 0.5], 1, 5);
        col1(P, [1, 0.4, 0.1], 0, 2);
        P.minPx = 5;
        fire.spawn(P, t);
      }
    }),
    events.on('gun:state', ({ shooterId, firing, position, weapon }) => {
      if (weapon !== 'zsu23') return;
      let e = aaa.get(shooterId);
      if (!e) aaa.set(shooterId, (e = { firing, pos: new Vector3() }));
      e.firing = firing;
      e.pos.copy(position);
    }),
    events.on('countermeasure', ({ decoy }) => {
      const p = decoy.position;
      const d = distCam(p.x, p.y, p.z);
      if (decoy.type === 'chaff') {
        const t = now();
        const v = decoy.velocity;
        const n = count(36, d);
        for (let i = 0; i < n; i++) {
          resetSpawn(P);
          randDir();
          P.x = p.x;
          P.y = p.y;
          P.z = p.z;
          P.vx = v.x * 0.3 + _w.x * 9;
          P.vy = v.y * 0.3 + _w.y * 9;
          P.vz = v.z * 0.3 + _w.z * 9;
          P.drag = 2.4;
          P.grav = -0.6;
          P.size0 = 0.35;
          P.size1 = 0.25;
          P.life = 3 + rnd() * 2.5;
          P.variant = 1;
          P.minPx = 1.3;
          P.flicker = 0.95;
          col0(P, [1, 1, 1.05], 1, 1.8);
          col1(P, [1, 1, 1], 0, 1);
          fire.spawn(P, t);
        }
        for (let i = 0; i < 3; i++) smallPuff(p.x, p.y, p.z, v.x * 0.3, v.y * 0.3, v.z * 0.3, C.smokeGrey, 0.18, 2, 12, 4);
      } else {
        smallPuff(p.x, p.y, p.z, decoy.velocity.x * 0.5, decoy.velocity.y * 0.5, decoy.velocity.z * 0.5, C.smokeLight, 0.35, 0.6, 3, 0.8);
      }
    }),
    events.on('transonic', ({ aircraft }) => {
      const fx = aircraftFx.get(aircraft.id);
      if (fx) fx.coneBoost = now();
    }),
  );

  /* ───────────── per-frame scans ───────────── */

  function missileTail(m: MissileEntity, out: Vector3): Vector3 {
    _f.set(0, 0, 1).applyQuaternion(m.quaternion);
    return out.copy(m.position).addScaledVector(_f, (m.def.length || 3) * 0.5);
  }

  function scanMissiles(t: number): void {
    for (const m of world.missiles) {
      let fx = missileFx.get(m.id);
      if (!fx) {
        fx = missilePool.pop() ?? { seen: 0, ribbon: -1, motor: false, style: null, sam: false };
        fx.ribbon = -1;
        fx.motor = false;
        let st = trailStyles.get(m.def.id);
        if (st === undefined) trailStyles.set(m.def.id, (st = trailStyleFor(m.def)));
        fx.style = st;
        fx.sam = m.def.category === 'sam';
        missileFx.set(m.id, fx);
      }
      fx.seen = frame;
      if (!m.alive) {
        if (fx.ribbon >= 0) ribbons.release(fx.ribbon, t);
        fx.ribbon = -1;
        continue;
      }
      const burning = m.motorBurning;
      const tail = missileTail(m, _v);
      const d = distCam(tail.x, tail.y, tail.z);
      if (burning && !fx.motor) {
        // motor ignition flash
        resetSpawn(P);
        P.x = tail.x;
        P.y = tail.y;
        P.z = tail.z;
        P.life = 0.15;
        P.size0 = 3;
        P.size1 = 5;
        col0(P, [1, 0.85, 0.6], 1, 5);
        col1(P, [1, 0.5, 0.2], 0, 2);
        P.minPx = AIR_KILL.fireballMinPx;
        fire.spawn(P, t);
      }
      if (burning && fx.style) {
        if (fx.ribbon < 0 || !ribbons.isActive(fx.ribbon)) fx.ribbon = ribbons.alloc(fx.style);
        ribbons.emit(fx.ribbon, tail.x, tail.y, tail.z, t);
        // volumetric puffs close to the camera (ribbons collapse when seen end-on, e.g. chase view)
        if (d < 2500 && rnd() < (d < 900 ? 1 : 0.5) * Math.max(0.5, ps)) {
          const s = fx.style;
          smallPuff(tail.x, tail.y, tail.z, m.velocity.x * 0.03, m.velocity.y * 0.03, m.velocity.z * 0.03, [s.r, s.g, s.b], Math.min(0.85, s.alpha * 0.8), s.width * 1.5, s.width * 3.5 + s.growth * s.life * 0.35, s.life * 0.5);
        }
        // exhaust tongue
        if (d < 700) {
          resetSpawn(P);
          P.x = tail.x;
          P.y = tail.y;
          P.z = tail.z;
          P.vx = m.velocity.x * 0.75;
          P.vy = m.velocity.y * 0.75;
          P.vz = m.velocity.z * 0.75;
          P.drag = 0.01;
          P.life = 0.07;
          P.size0 = (m.def.diameter || 0.2) * 5;
          P.size1 = (m.def.diameter || 0.2) * 2;
          P.variant = 2;
          col0(P, [1, 0.75, 0.4], 1, 3);
          col1(P, [1, 0.4, 0.1], 0, 1);
          fire.spawn(P, t);
        }
      } else if (!burning && fx.ribbon >= 0) {
        ribbons.release(fx.ribbon, t);
        fx.ribbon = -1;
      }
      fx.motor = burning;
    }
    missileFx.forEach(sweepMissile);
  }
  const sweepMissile = (fx: MissileFx, id: number) => {
    if (fx.seen === frame) return;
    if (fx.ribbon >= 0) ribbons.release(fx.ribbon, now());
    fx.ribbon = -1;
    missileFx.delete(id);
    if (missilePool.length < 64) missilePool.push(fx);
  };

  function worldPoint(ac: AircraftEntity, p: readonly number[], out: Vector3): Vector3 {
    return out.set(p[0], p[1], p[2]).applyQuaternion(ac.quaternion).add(ac.position);
  }

  function ensure(ids: number[], n: number, style: RibbonStyle): void {
    for (let i = 0; i < n; i++) if (ids[i] === undefined || ids[i] < 0 || !ribbons.isActive(ids[i])) ids[i] = ribbons.alloc(style);
  }
  function releaseAll(ids: number[], t: number): void {
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] >= 0) ribbons.release(ids[i], t);
      ids[i] = -1;
    }
  }

  function scanAircraft(t: number, dt: number): void {
    cones.begin();
    for (const ac of world.aircraft) {
      let fx = aircraftFx.get(ac.id);
      if (!fx) {
        fx = { seen: 0, contrail: [], vortex: [], damage: -1, wreck: -1, crashed: false, gunAcc: 0, coneBoost: -99 };
        aircraftFx.set(ac.id, fx);
      }
      fx.seen = frame;
      const spec: AircraftSpec = AIRCRAFT_SPECS[ac.type] ?? AIRCRAFT_SPECS.f35a;
      const pos = ac.position;
      const d = distCam(pos.x, pos.y, pos.z);
      const fl = ac.flight;
      if (ac.alive) {
        // contrails above ~8 km
        const ck = smooth(7800, 8700, pos.y) * (1 - smooth(16000, 17000, pos.y));
        if (ck > 0.02 && d < 30000) {
          ensure(fx.contrail, spec.engines.length, CONTRAIL);
          for (let i = 0; i < spec.engines.length; i++) {
            worldPoint(ac, spec.engines[i].pos, _v);
            ribbons.emit(fx.contrail[i], _v.x, _v.y, _v.z, t, ck);
          }
        } else if (fx.contrail.length) releaseAll(fx.contrail, t);
        // wingtip vortices at high G / AoA
        const vk = Math.max(clamp01((fl.gLoad - 4.5) / 3), clamp01((fl.alpha - 0.24) / 0.15)) * (fl.tas > 90 ? 1 : 0);
        if (vk > 0.05 && d < 3000) {
          ensure(fx.vortex, 2, VORTEX);
          for (let i = 0; i < 2; i++) {
            worldPoint(ac, spec.wingtips[i], _v);
            ribbons.emit(fx.vortex[i], _v.x, _v.y, _v.z, t, vk);
          }
        } else if (fx.vortex.length) releaseAll(fx.vortex, t);
        // LEX / wing-root vapour at high AoA
        if (fl.alpha > 0.26 && fl.tas > 110 && d < 500 && spec.lex.length) {
          const k = clamp01((fl.alpha - 0.26) / 0.12);
          for (let i = 0; i < spec.lex.length; i++) {
            if (rnd() > 0.7 * ps) continue;
            worldPoint(ac, spec.lex[i], _v);
            smallPuff(_v.x, _v.y + 0.3, _v.z, ac.velocity.x * 0.93, ac.velocity.y * 0.93, ac.velocity.z * 0.93, C.water, 0.18 * k, 1.2, 3.5, 0.28);
          }
        }
        // damage smoke / fire
        const hf = ac.health / Math.max(1, ac.maxHealth);
        if ((hf < 0.5 || ac.damage.fire) && d < 20000) {
          if (fx.damage < 0 || !ribbons.isActive(fx.damage)) fx.damage = ribbons.alloc(DAMAGE_SMOKE);
          worldPoint(ac, spec.engines[0].pos, _v);
          ribbons.emit(fx.damage, _v.x, _v.y, _v.z, t, 0.4 + (0.5 - Math.min(0.5, hf)) * 1.2);
          if ((hf < 0.25 || ac.damage.fire) && d < 3000 && rnd() < 0.8 * ps)
            fireLick(_v.x, _v.y, _v.z, ac.velocity.x * 0.85, ac.velocity.y * 0.85, ac.velocity.z * 0.85, 1.4, 0.25 + rnd() * 0.2);
        } else if (fx.damage >= 0) {
          ribbons.release(fx.damage, t);
          fx.damage = -1;
        }
        // transonic vapour cone
        const mk = 1 - Math.abs(fl.mach - 1) / 0.055;
        const boost = Math.max(0, 1 - (t - fx.coneBoost) / 1.2);
        const ak = Math.max(mk, boost);
        if (ak > 0.05 && d < 3000) cones.add(pos, ac.quaternion, spec.length / 15.7, Math.min(1, ak) * 0.55, t);
        // gun smoke
        if (ac.gunFiring && spec.gun && d < 1500) {
          fx.gunAcc += dt;
          if (fx.gunAcc > 0.07) {
            fx.gunAcc = 0;
            worldPoint(ac, spec.gun, _v);
            smallPuff(_v.x, _v.y, _v.z, ac.velocity.x * 0.9, ac.velocity.y * 0.9, ac.velocity.z * 0.9, C.smokeGrey, 0.3, 0.6, 3, 0.8);
          }
        }
      } else {
        if (fx.contrail.length) releaseAll(fx.contrail, t);
        if (fx.vortex.length) releaseAll(fx.vortex, t);
        if (fx.damage >= 0) {
          ribbons.release(fx.damage, t);
          fx.damage = -1;
        }
        if (!fx.crashed) {
          if (ac.crashed) {
            fx.crashed = true;
            if (fx.wreck >= 0) ribbons.release(fx.wreck, t);
            fx.wreck = -1;
            if (world.terrain.isWater(pos.x, pos.z)) waterSplash(pos.x, 0, pos.z, 14, d, t);
            else startFire(pos.x, groundAt(pos.x, pos.z), pos.z, 1.2, 90);
          } else {
            // falling, burning wreck: thick smoke trail + fire
            if (fx.wreck < 0 || !ribbons.isActive(fx.wreck)) fx.wreck = ribbons.alloc(WRECK_SMOKE);
            ribbons.emit(fx.wreck, pos.x, pos.y, pos.z, t);
            // burning, tumbling wreck: big fire licks (min 4 px so the fire reads at BVR range),
            // puffs of dark smoke and the occasional secondary pop
            const n = d < 2000 ? 4 : 2;
            for (let i = 0; i < n; i++) {
              if (rnd() > ps + 0.3) continue;
              fireLick(pos.x + (rnd() - 0.5) * 4, pos.y + (rnd() - 0.5) * 3, pos.z + (rnd() - 0.5) * 4, ac.velocity.x * 0.8, ac.velocity.y * 0.8, ac.velocity.z * 0.8, 5.5, 0.45 + rnd() * 0.35, 1.4, 4);
            }
            if (rnd() < 0.3) smallPuff(pos.x, pos.y, pos.z, ac.velocity.x * 0.2, ac.velocity.y * 0.2, ac.velocity.z * 0.2, C.smokeDark, 0.8, 4, 16, 6);
            if (rnd() < 0.15) sparks(pos.x, pos.y, pos.z, 2, 15);
          }
        }
      }
    }
    aircraftFx.forEach(sweepAircraft);
    cones.end();
  }
  const sweepAircraft = (fx: AircraftFx, id: number) => {
    if (fx.seen === frame) return;
    const t = now();
    releaseAll(fx.contrail, t);
    releaseAll(fx.vortex, t);
    if (fx.damage >= 0) ribbons.release(fx.damage, t);
    if (fx.wreck >= 0) ribbons.release(fx.wreck, t);
    aircraftFx.delete(id);
  };

  function scanDecoys(t: number, dt: number): void {
    for (const dc of world.decoys) {
      if (dc.type !== 'flare') continue;
      let fx = decoyFx.get(dc.id);
      if (!fx) {
        fx = decoyPool.pop() ?? { seen: 0, ribbon: -1, sparkAcc: 0 };
        fx.ribbon = -1;
        decoyFx.set(dc.id, fx);
      }
      fx.seen = frame;
      const p = dc.position;
      if (dc.alive) {
        if (fx.ribbon < 0 || !ribbons.isActive(fx.ribbon)) fx.ribbon = ribbons.alloc(FLARE_SMOKE);
        ribbons.emit(fx.ribbon, p.x, p.y, p.z, t);
        if (distCam(p.x, p.y, p.z) < 1200 && rnd() < 0.8 * Math.max(0.5, ps))
          smallPuff(p.x, p.y, p.z, dc.velocity.x * 0.1, dc.velocity.y * 0.1, dc.velocity.z * 0.1, C.smokeLight, 0.55, 1.2, 4.5, 2.5);
        fx.sparkAcc += dt;
        if (fx.sparkAcc > 0.12 && distCam(p.x, p.y, p.z) < 2500) {
          fx.sparkAcc = 0;
          sparks(p.x, p.y, p.z, 1, 6);
        }
      } else if (fx.ribbon >= 0) {
        ribbons.release(fx.ribbon, t);
        fx.ribbon = -1;
      }
    }
    decoyFx.forEach(sweepDecoy);
  }
  const sweepDecoy = (fx: DecoyFx, id: number) => {
    if (fx.seen === frame) return;
    if (fx.ribbon >= 0) ribbons.release(fx.ribbon, now());
    decoyFx.delete(id);
    if (decoyPool.length < 64) decoyPool.push(fx);
  };

  function updateFires(t: number, dt: number): void {
    for (const f of fires) {
      if (!f.active) continue;
      const age = t - f.t0;
      if (age > f.dur) {
        f.active = false;
        continue;
      }
      const flame = 1 - smooth(f.dur * 0.5, f.dur * 0.85, age);
      const d = distCam(f.pos.x, f.pos.y, f.pos.z);
      const lod = lodK(d);
      // flames
      f.fAcc += dt * 16 * f.size * flame * ps * lod;
      while (f.fAcc >= 1) {
        f.fAcc -= 1;
        const r = 2.2 * f.size;
        fireLick(f.pos.x + (rnd() - 0.5) * r * 2, f.pos.y + rnd() * 1.5, f.pos.z + (rnd() - 0.5) * r * 2, (rnd() - 0.5) * 2, 3 + rnd() * 4, (rnd() - 0.5) * 2, (2.5 + rnd() * 3) * f.size, 0.7 + rnd() * 0.5);
      }
      // tall smoke column (visible from far away: never fully culled)
      f.sAcc += dt * (1.2 + 1.3 * f.size) * ps * Math.max(0.5, lod) * (0.45 + 0.55 * flame);
      while (f.sAcc >= 1) {
        f.sAcc -= 1;
        resetSpawn(P);
        P.x = f.pos.x + (rnd() - 0.5) * 4 * f.size;
        P.y = f.pos.y + 3 + rnd() * 3;
        P.z = f.pos.z + (rnd() - 0.5) * 4 * f.size;
        P.vx = (rnd() - 0.5) * 3;
        P.vy = 8 + rnd() * 5;
        P.vz = (rnd() - 0.5) * 3;
        P.drag = 0.28;
        P.grav = 4.2;
        P.size0 = 7 * f.size;
        P.size1 = (40 + rnd() * 35) * f.size;
        P.sizeCurve = 1.6;
        P.life = 18 + rnd() * 9;
        P.rot = rnd() * 6.28;
        P.rotSpeed = (rnd() - 0.5) * 0.15;
        P.variant = (rnd() * 4) | 0;
        const dark = flame > 0.3 ? C.smokeDark : C.smokeMid;
        col0(P, dark, 0.85 * (0.5 + 0.5 * flame));
        col1(P, C.smokeGrey, 0);
        P.fadeIn = 0.04;
        smoke.spawn(P, t);
      }
    }
  }

  /** Fire and smoke on every damaged, still standing landmark (driven by the sim state, not a pooled fire slot). */
  function updateLandmarkDamage(t: number, dt: number): void {
    const list = world.landmarks;
    if (!list?.length) return;
    for (const lm of list) {
      if (!lm.alive || lm.hits <= 0) continue;
      let acc = landmarkAcc.get(lm);
      if (!acc) landmarkAcc.set(lm, (acc = { f: 0, s: 0 }));
      const p = lm.damagePoint;
      // outward normal of the face that was hit
      let nx = p.x - lm.base.x;
      let nz = p.z - lm.base.z;
      const nl = Math.sqrt(nx * nx + nz * nz) || 1;
      nx /= nl;
      nz /= nl;
      const lod = Math.max(LANDMARK_FIRE.minLod, lodK(distCam(p.x, p.y, p.z)));
      acc.f += dt * LANDMARK_FIRE.flamesPerSec * ps * lod;
      while (acc.f >= 1) {
        acc.f -= 1;
        const out = 0.5 + rnd() * 3;
        const side = (rnd() - 0.5) * 10;
        fireLick(p.x + nx * out - nz * side, p.y + (rnd() - 0.6) * 7, p.z + nz * out + nx * side, nx * 2.5, 3 + rnd() * 5, nz * 2.5, 3.5 + rnd() * 4, 0.7 + rnd() * 0.6, 1, LANDMARK_FIRE.flameMinPx);
      }
      acc.s += dt * LANDMARK_FIRE.smokePerSec * ps * lod;
      while (acc.s >= 1) {
        acc.s -= 1;
        resetSpawn(P);
        P.x = p.x + nx * (2 + rnd() * 4) + (rnd() - 0.5) * 6;
        P.y = p.y + 2 + rnd() * 4;
        P.z = p.z + nz * (2 + rnd() * 4) + (rnd() - 0.5) * 6;
        P.vx = nx * 3 + (rnd() - 0.5) * 2;
        P.vy = 6 + rnd() * 5;
        P.vz = nz * 3 + (rnd() - 0.5) * 2;
        P.drag = 0.3;
        P.grav = 3.6;
        P.size0 = 10;
        P.size1 = 70 + rnd() * 50;
        P.sizeCurve = 1.6;
        P.life = 22 + rnd() * 10;
        P.rot = rnd() * 6.28;
        P.rotSpeed = (rnd() - 0.5) * 0.15;
        P.variant = (rnd() * 4) | 0;
        col0(P, C.smokeDark, 0.9);
        col1(P, C.smokeMid, 0);
        P.fadeIn = 0.04;
        P.minPx = LANDMARK_FIRE.smokeMinPx;
        smoke.spawn(P, t);
      }
    }
  }

  function runDelayed(t: number): void {
    for (const e of delayed) {
      if (!e.active || t < e.t) continue;
      e.active = false;
      explode(e.pos.x, e.pos.y, e.pos.z, e.size, e.surface);
    }
  }

  function resolvePending(): void {
    for (const pnd of pending) {
      if (!pnd.active) continue;
      pnd.active = false;
      let covered = false;
      for (const r of recent) {
        if (Math.abs(r.t - pnd.t) < 0.3 && r.pos.distanceToSquared(pnd.pos) < 90 * 90) {
          covered = true;
          break;
        }
      }
      if (!covered) explode(pnd.pos.x, pnd.pos.y, pnd.pos.z, pnd.size, pnd.surface);
    }
  }

  /* ───────────── sprite pass (glows, tracers, flashes) ───────────── */

  function drawSprites(ctx: FrameContext): void {
    const t = ctx.time;
    sprites.begin(pixelScale(ctx.camera.fov, ctx.screen.height));
    const nightK = night ? 1.6 : 1;
    // missile motor glows (visible as bright dots from far away)
    for (const m of world.missiles) {
      if (!m.alive || !m.motorBurning) continue;
      missileTail(m, _v);
      const fl = 0.85 + 0.15 * Math.sin(t * 60 + m.id);
      const s = Math.max(1.2, (m.def.diameter || 0.2) * 9);
      sprites.add(_v.x, _v.y, _v.z, 4 * fl * nightK, 3.1 * fl * nightK, 1.9 * fl * nightK, 1, s, m.def.category === 'sam' ? 9 : 6);
    }
    // flares: blinding cores
    for (const dc of world.decoys) {
      if (dc.type !== 'flare' || !dc.alive) continue;
      const k = Math.max(0.3, Math.min(1, dc.life > 0 ? 1 - dc.age / dc.life : 1));
      const fl = 0.8 + 0.2 * Math.sin(t * 45 + dc.id * 3);
      sprites.add(dc.position.x, dc.position.y, dc.position.z, 5 * k * fl * nightK, 4.4 * k * fl * nightK, 3.8 * k * fl * nightK, 1, 3.2, night ? 14 : 9);
    }
    // tracers
    for (const pr of world.projectiles) {
      if (!pr.active || !pr.tracer) continue;
      const v = pr.velocity;
      const blue = pr.team === 'blue';
      const k = nightK;
      sprites.add(pr.position.x, pr.position.y, pr.position.z, (blue ? 4 : 4.2) * k, (blue ? 3.2 : 1.6) * k, (blue ? 1.3 : 0.5) * k, 1, 0.5, 2.2, -v.x * 0.035, -v.y * 0.035, -v.z * 0.035);
    }
    // muzzle flashes (aircraft gun + AAA)
    for (const ac of world.aircraft) {
      if (!ac.alive || !ac.gunFiring) continue;
      const spec = AIRCRAFT_SPECS[ac.type];
      if (!spec?.gun) continue;
      worldPoint(ac, spec.gun, _v);
      const k = 0.6 + rnd() * 0.6;
      _f.set(0, 0, -1).applyQuaternion(ac.quaternion);
      sprites.add(_v.x, _v.y, _v.z, 5 * k, 3.4 * k, 1.4 * k, 1, 1.9, 5);
      sprites.add(_v.x, _v.y, _v.z, 3 * k, 2 * k, 0.8 * k, 1, 0.8, 3, _f.x * 3, _f.y * 3, _f.z * 3);
    }
    aaa.forEach(drawAaa);
    // ground fires glow (strong at night)
    for (const f of fires) {
      if (!f.active) continue;
      const age = t - f.t0;
      const flame = 1 - smooth(f.dur * 0.5, f.dur * 0.85, age);
      if (flame < 0.05) continue;
      const k = flame * (night ? 1 : 0.35) * (0.85 + 0.15 * Math.sin(t * 13 + f.t0));
      sprites.add(f.pos.x, f.pos.y + 9 * f.size, f.pos.z, 3.5 * k, 1.5 * k, 0.4 * k, 1, 13 * f.size, night ? 8 : 3);
    }
    // a damaged landmark's fire glow
    for (const lm of world.landmarks ?? []) {
      if (!lm.alive || lm.hits <= 0) continue;
      const p = lm.damagePoint;
      const k = (night ? 1 : 0.4) * (0.85 + 0.15 * Math.sin(t * 11));
      sprites.add(p.x, p.y, p.z, 3.5 * k, 1.5 * k, 0.4 * k, 1, 26, night ? 9 : 4);
    }
    sprites.end();
  }
  const drawAaa = (e: { firing: boolean; pos: Vector3 }) => {
    if (!e.firing) return;
    const k = 0.5 + rnd() * 0.8;
    sprites.add(e.pos.x, e.pos.y + 2.5, e.pos.z, 5 * k, 3 * k, 1.2 * k, 1, 2.2, 5);
  };

  function debrisTrail(p: Vector3, burning: number): void {
    if (distCam(p.x, p.y, p.z) > 6000) return;
    if (burning > 0.05) fireLick(p.x, p.y, p.z, 0, 0, 0, 1.6 + burning * 2.2, 0.3 + burning * 0.35, burning, burning > 0.3 ? 2 : 0);
    smallPuff(p.x, p.y, p.z, 0, 0, 0, burning > 0.3 ? C.smokeDark : C.smokeMid, 0.6, 1.2, 5.5, 2.8);
  }

  const api: EffectsApi & { stats(): string } = {
    /** Debug counters (dev labs). */
    stats() {
      return `smoke=${smoke.spawned} fire=${fire.spawned} seg=${ribbons.committed} spr=${sprites.count}`;
    },
    update(ctx: FrameContext) {
      frame++;
      cam.copy(ctx.camera.position);
      night = env.isNight;
      const t = ctx.time;
      const dt = ctx.paused ? 0 : ctx.dt;
      if (!ctx.paused) {
        resolvePending();
        runDelayed(t);
        scanMissiles(t);
        scanAircraft(t, dt);
        scanDecoys(t, dt);
        updateFires(t, dt);
        updateLandmarkDamage(t, dt);
        updateShips(t, dt);
        debris.update(dt, groundAt, debrisTrail);
        pulses.update(dt);
      }
      drawSprites(ctx);
      const sunY = env.sunDirection.y;
      const light = night ? 0.2 : Math.min(1, Math.max(0.35, 0.4 + sunY * 1.1));
      const px = pixelScale(ctx.camera.fov, ctx.screen.height);
      smoke.update(t, wind, px, light);
      fire.update(t, wind, px, 1);
      ribbons.update(t, wind, light, px);
    },
    dispose() {
      offs.forEach((o) => o());
      smoke.dispose();
      fire.dispose();
      ribbons.dispose();
      sprites.dispose();
      debris.dispose();
      pulses.dispose();
      cones.dispose();
      craters.dispose();
      root.removeFromParent();
    },
  };
  return api;
};

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
function smooth(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

