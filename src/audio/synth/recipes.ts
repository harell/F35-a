/**
 * F35-A audio — one-shot sound recipes, all synthesised from noise buffers and oscillators.
 *
 * Conventions: `when` is AudioContext time; `sp` (optional) carries distance gain / pan /
 * low-pass for world sounds. Recipes allocate their nodes through the one-shot pool so the
 * number of simultaneous transients stays bounded.
 */
import type { ExplosionSize, WeaponId } from '../../core/types';
import type { SpatialShot } from '../core/OneShots';
import type { BusId } from '../core/Mixer';
import { beep, burst, tone, type SynthEnv } from './build';

const bus = (env: SynthEnv, id: BusId) => env.mixer.bus[id];

/* ───────────────────────── Explosions ───────────────────────── */

interface ExplosionShape {
  crack: number; // crack gain
  crackTau: number;
  boomLp: number; // boom low-pass start (Hz)
  boomTau: number;
  subHz: number;
  subTau: number;
  debrisTau: number;
  dur: number;
}

const SHAPE: Record<ExplosionSize, ExplosionShape> = {
  tiny: { crack: 0.5, crackTau: 0.006, boomLp: 900, boomTau: 0.07, subHz: 110, subTau: 0.04, debrisTau: 0, dur: 0.5 },
  small: { crack: 0.6, crackTau: 0.01, boomLp: 520, boomTau: 0.25, subHz: 75, subTau: 0.12, debrisTau: 0.35, dur: 1.6 },
  medium: { crack: 0.7, crackTau: 0.014, boomLp: 380, boomTau: 0.45, subHz: 60, subTau: 0.24, debrisTau: 0.7, dur: 2.6 },
  large: { crack: 0.8, crackTau: 0.018, boomLp: 300, boomTau: 0.7, subHz: 52, subTau: 0.38, debrisTau: 1.1, dur: 3.6 },
  huge: { crack: 0.9, crackTau: 0.022, boomLp: 240, boomTau: 1.0, subHz: 44, subTau: 0.6, debrisTau: 1.6, dur: 5 },
};

/**
 * Explosion: sharp crack (lost with distance), deep boom, sub-bass thump, debris rumble;
 * far away it becomes a low rolling thunder with echoes. Water adds a splash, ground a patter.
 */
export function explosion(
  env: SynthEnv,
  when: number,
  size: ExplosionSize,
  surface: 'air' | 'ground' | 'water',
  distance: number,
  sp: SpatialShot,
): void {
  const s = SHAPE[size];
  const far = Math.min(1, distance / 2500); // 0 close … 1 far
  const shot = env.pool.begin(bus(env, 'sfx'), when, s.dur + far * 1.5, size === 'tiny' ? 1 : 3, { ...sp, reverb: size === 'tiny' ? 0.15 : 0.45 });
  const near = 1 - far;
  const jitter = 0.9 + Math.random() * 0.2;
  // crack (high frequencies die first with distance)
  if (near > 0.05) {
    burst(env, shot, when, { buf: 'white', type: 'highpass', f: 1400, gain: 1.3 * s.crack * near * near, attack: 0.0008, tau: s.crackTau });
    burst(env, shot, when, { buf: 'pink', type: 'bandpass', f: 2200 * jitter, q: 0.6, gain: 0.7 * s.crack * near, attack: 0.001, tau: s.crackTau * 2.5 });
  }
  // boom body
  burst(env, shot, when, { buf: 'brown', type: 'lowpass', f: s.boomLp * jitter * (1 + near), fEnd: s.boomLp * 0.35, q: 0.9, gain: 1.8, attack: 0.004, tau: s.boomTau });
  burst(env, shot, when, { buf: 'pink', type: 'lowpass', f: 900 * jitter, fEnd: 200, gain: 0.5 * (0.4 + near), attack: 0.003, tau: s.boomTau * 0.5 });
  // sub-bass thump (chest punch)
  tone(env, shot, when, { type: 'sine', f: s.subHz * jitter, fEnd: s.subHz * 0.45, gain: 1.1, attack: 0.004, tau: s.subTau });
  // debris / rolling rumble
  if (s.debrisTau > 0) {
    burst(env, shot, when, { buf: 'brown', type: 'bandpass', f: 180 * jitter, q: 0.8, gain: 0.8, attack: 0.08, tau: s.debrisTau, delay: 0.06 });
    if (surface === 'ground' && near > 0.2)
      burst(env, shot, when, { buf: 'crackle', type: 'bandpass', f: 1800, q: 0.7, gain: 0.35 * near, attack: 0.05, tau: s.debrisTau * 0.6, delay: 0.25 });
  }
  if (surface === 'water' && size !== 'tiny') {
    burst(env, shot, when, { buf: 'white', type: 'highpass', f: 1200, fEnd: 700, gain: 0.3 * (0.3 + near), attack: 0.03, tau: 0.35 + s.boomTau * 0.4, delay: 0.05 });
  }
  // distant rolling thunder: delayed, darker repeats (terrain / sea echoes)
  if (far > 0.3 && size !== 'tiny') {
    burst(env, shot, when, { buf: 'brown', type: 'lowpass', f: 220, gain: 0.45 * far, attack: 0.1, tau: s.boomTau * 1.4, delay: 0.35 + 0.3 * Math.random() });
    burst(env, shot, when, { buf: 'brown', type: 'lowpass', f: 160, gain: 0.3 * far, attack: 0.2, tau: s.boomTau * 1.8, delay: 0.9 + 0.6 * Math.random() });
  } else if (size === 'large' || size === 'huge') {
    burst(env, shot, when, { buf: 'brown', type: 'lowpass', f: 260, gain: 0.35, attack: 0.05, tau: s.boomTau, delay: 0.5 });
  }
}

/** Sonic boom: the double "N-wave" crack-boom of a supersonic jet passing. */
export function sonicBoom(env: SynthEnv, when: number, sp: SpatialShot): void {
  const shot = env.pool.begin(bus(env, 'sfx'), when, 2.2, 3, { ...sp, reverb: 0.5 });
  for (const dt of [0, 0.11]) {
    burst(env, shot, when, { buf: 'white', type: 'lowpass', f: 5000, gain: 0.9, attack: 0.0005, tau: 0.012, delay: dt });
    burst(env, shot, when, { buf: 'brown', type: 'lowpass', f: 420, fEnd: 120, gain: 1.7, attack: 0.002, tau: 0.16, delay: dt });
    tone(env, shot, when, { type: 'sine', f: 55, fEnd: 30, gain: 1.2, attack: 0.002, tau: 0.12, delay: dt });
  }
  burst(env, shot, when, { buf: 'brown', type: 'bandpass', f: 140, q: 0.7, gain: 0.6, attack: 0.1, tau: 0.6, delay: 0.2 });
}

/* ───────────────────────── Hits & impacts ───────────────────────── */

const METAL = [1170, 1730, 2310, 2950, 3620, 4480];

/** Rounds / fragments hitting the player's airframe: metallic clangs + crunch, scaled by damage. */
export function airframeHit(env: SynthEnv, when: number, intensity: number, sp?: SpatialShot): void {
  const k = Math.min(1, Math.max(0.15, intensity));
  const shot = env.pool.begin(bus(env, 'sfx'), when, 0.9, 2, sp);
  const n = 2 + Math.round(k * 4);
  for (let i = 0; i < n; i++) {
    const t = Math.random() * 0.07 * (1 + k);
    const f = METAL[Math.floor(Math.random() * METAL.length)] * (0.92 + Math.random() * 0.16);
    burst(env, shot, when, { buf: 'white', type: 'bandpass', f, q: 14, gain: 0.9 * k, attack: 0.0005, tau: 0.05 + 0.06 * Math.random(), delay: t });
    tone(env, shot, when, { type: 'triangle', f: f * 0.51, gain: 0.12 * k, attack: 0.001, tau: 0.09, delay: t });
  }
  // crunch / tearing skin
  burst(env, shot, when, { buf: 'crackle', type: 'bandpass', f: 1500, q: 0.8, gain: 0.8 * k, attack: 0.002, tau: 0.08 + 0.1 * k });
  burst(env, shot, when, { buf: 'brown', type: 'lowpass', f: 600, gain: 0.8 * k, attack: 0.002, tau: 0.09 });
}

/** Single bullet strike (ping on metal / thud on dirt / plip in water). */
export function bulletImpact(env: SynthEnv, when: number, surface: 'air' | 'ground' | 'water' | 'target', sp: SpatialShot): void {
  const shot = env.pool.begin(bus(env, 'sfx'), when, 0.35, 0, sp);
  if (surface === 'target' || surface === 'air') {
    const f = METAL[Math.floor(Math.random() * METAL.length)];
    burst(env, shot, when, { buf: 'white', type: 'bandpass', f, q: 10, gain: 0.7, attack: 0.0005, tau: 0.035 });
  } else if (surface === 'water') {
    burst(env, shot, when, { buf: 'white', type: 'bandpass', f: 1800, fEnd: 900, q: 1.2, gain: 0.5, attack: 0.002, tau: 0.06 });
  } else {
    burst(env, shot, when, { buf: 'pink', type: 'lowpass', f: 700, gain: 0.8, attack: 0.001, tau: 0.04 });
    burst(env, shot, when, { buf: 'crackle', type: 'highpass', f: 1500, gain: 0.3, attack: 0.001, tau: 0.05, delay: 0.01 });
  }
}

/** "Hit confirmed" feedback tick when the player's rounds strike an enemy (juice, not physics). */
export function hitConfirm(env: SynthEnv, when: number): void {
  const shot = env.pool.begin(bus(env, 'warn'), when, 0.12, 0);
  burst(env, shot, when, { buf: 'white', type: 'bandpass', f: 3200, q: 6, gain: 0.35, attack: 0.0005, tau: 0.02 });
  tone(env, shot, when, { type: 'triangle', f: 2400, gain: 0.08, attack: 0.001, tau: 0.02 });
}

/* ───────────────────────── Countermeasures ───────────────────────── */

/** Flare cartridge: sharp squib pop + low kick + burning fizz. */
export function flarePop(env: SynthEnv, when: number, sp?: SpatialShot): void {
  const shot = env.pool.begin(bus(env, 'sfx'), when, 0.8, 1, sp);
  burst(env, shot, when, { buf: 'white', type: 'bandpass', f: 2600, q: 1.2, gain: 0.8, attack: 0.0005, tau: 0.008 });
  tone(env, shot, when, { type: 'sine', f: 140, fEnd: 70, gain: 0.55, attack: 0.001, tau: 0.03 });
  burst(env, shot, when, { buf: 'white', type: 'highpass', f: 3800, gain: 0.08, attack: 0.02, tau: 0.25, delay: 0.02 });
}

/** Chaff cartridge: softer thump + paper-like rustle. */
export function chaffPop(env: SynthEnv, when: number, sp?: SpatialShot): void {
  const shot = env.pool.begin(bus(env, 'sfx'), when, 0.6, 1, sp);
  burst(env, shot, when, { buf: 'pink', type: 'bandpass', f: 900, q: 1, gain: 0.7, attack: 0.001, tau: 0.02 });
  tone(env, shot, when, { type: 'sine', f: 110, fEnd: 60, gain: 0.4, attack: 0.001, tau: 0.03 });
  burst(env, shot, when, { buf: 'crackle', type: 'highpass', f: 2500, gain: 0.25, attack: 0.02, tau: 0.12, delay: 0.015 });
}

/* ───────────────────────── Weapons release ───────────────────────── */

/** Weapons-bay door hydraulics: servo whine + flow hiss (opening rises, closing falls). */
export function bayWhirr(env: SynthEnv, when: number, opening: boolean, gain: number): void {
  const shot = env.pool.begin(bus(env, 'sfx'), when, 0.6, 1);
  const [a, b] = opening ? [330, 520] : [500, 300];
  tone(env, shot, when, { type: 'sawtooth', f: a, fEnd: b, glideDur: 0.32, gain: 0.12 * gain, attack: 0.02, tau: 0.12, lp: 1400 });
  tone(env, shot, when, { type: 'sine', f: a * 2.01, fEnd: b * 2.01, glideDur: 0.32, gain: 0.05 * gain, attack: 0.02, tau: 0.1 });
  burst(env, shot, when, { buf: 'white', type: 'bandpass', f: 2600, q: 0.9, gain: 0.12 * gain, attack: 0.03, tau: 0.12 });
}

/** Door hitting its stop / uplock: metallic clunk. */
export function clunk(env: SynthEnv, when: number, gain: number, sp?: SpatialShot): void {
  const shot = env.pool.begin(bus(env, 'sfx'), when, 0.35, 1, sp);
  burst(env, shot, when, { buf: 'pink', type: 'bandpass', f: 380, q: 1.5, gain: 0.8 * gain, attack: 0.001, tau: 0.04 });
  burst(env, shot, when, { buf: 'white', type: 'bandpass', f: 1900, q: 5, gain: 0.35 * gain, attack: 0.0005, tau: 0.03 });
  tone(env, shot, when, { type: 'sine', f: 95, fEnd: 60, gain: 0.5 * gain, attack: 0.001, tau: 0.05 });
}

/** Pneumatic ejector (AMRAAM kicked out of the bay): heavy thunk + gas hiss. */
export function ejectThunk(env: SynthEnv, when: number, gain: number, sp?: SpatialShot): void {
  const shot = env.pool.begin(bus(env, 'sfx'), when, 0.5, 2, sp);
  tone(env, shot, when, { type: 'sine', f: 85, fEnd: 45, gain: 0.9 * gain, attack: 0.001, tau: 0.07 });
  burst(env, shot, when, { buf: 'pink', type: 'lowpass', f: 700, gain: 0.9 * gain, attack: 0.001, tau: 0.05 });
  burst(env, shot, when, { buf: 'white', type: 'bandpass', f: 3000, q: 0.8, gain: 0.25 * gain, attack: 0.005, tau: 0.08, delay: 0.01 });
  burst(env, shot, when, { buf: 'white', type: 'bandpass', f: 2100, q: 6, gain: 0.3 * gain, attack: 0.0005, tau: 0.03 });
}

/** Rocket motor ignition: crack + tearing whoosh (the sustained roar is a MotorVoice). */
export function motorIgnition(env: SynthEnv, when: number, big: boolean, sp: SpatialShot): void {
  const shot = env.pool.begin(bus(env, 'sfx'), when, big ? 2.4 : 1.4, 2, { ...sp, reverb: 0.3 });
  burst(env, shot, when, { buf: 'white', type: 'highpass', f: 1800, gain: 0.7, attack: 0.001, tau: 0.02 });
  burst(env, shot, when, { buf: 'pink', type: 'bandpass', f: 900, fEnd: 2200, q: 0.6, gain: 1.3, attack: 0.015, tau: big ? 0.5 : 0.3 });
  burst(env, shot, when, { buf: 'brown', type: 'lowpass', f: big ? 260 : 380, gain: big ? 1.5 : 1.1, attack: 0.01, tau: big ? 0.6 : 0.35 });
  burst(env, shot, when, { buf: 'crackle', type: 'highpass', f: 1200, gain: 0.5, attack: 0.01, tau: big ? 0.4 : 0.2 });
}

/** SAM launch heard from a distance: booster thump, then a long ripping roar. */
export function samLaunch(env: SynthEnv, when: number, heavy: boolean, sp: SpatialShot): void {
  const shot = env.pool.begin(bus(env, 'sfx'), when, heavy ? 4 : 3, 3, { ...sp, reverb: 0.5 });
  tone(env, shot, when, { type: 'sine', f: heavy ? 50 : 65, fEnd: 30, gain: 0.8, attack: 0.003, tau: 0.25 });
  burst(env, shot, when, { buf: 'brown', type: 'lowpass', f: 500, fEnd: 180, gain: 1, attack: 0.005, tau: 0.35 });
  burst(env, shot, when, { buf: 'pink', type: 'bandpass', f: 700, fEnd: 400, q: 0.6, gain: 0.7, attack: 0.08, tau: heavy ? 0.9 : 0.6, delay: 0.05 });
  burst(env, shot, when, { buf: 'crackle', type: 'bandpass', f: 1200, q: 0.5, gain: 0.45, attack: 0.1, tau: heavy ? 0.8 : 0.5, delay: 0.05 });
}

/** Afterburner light-off: deep "whump". */
export function abLightOff(env: SynthEnv, when: number, gain: number, sp?: SpatialShot): void {
  const shot = env.pool.begin(bus(env, 'engine'), when, 0.8, 1, sp);
  tone(env, shot, when, { type: 'sine', f: 62, fEnd: 36, gain: 0.8 * gain, attack: 0.01, tau: 0.14 });
  burst(env, shot, when, { buf: 'brown', type: 'lowpass', f: 320, fEnd: 140, gain: 0.9 * gain, attack: 0.01, tau: 0.16 });
  burst(env, shot, when, { buf: 'pink', type: 'bandpass', f: 600, q: 0.7, gain: 0.3 * gain, attack: 0.02, tau: 0.12 });
}

/** End of a gun burst: barrel spin-down whine + the "rrr" echoing away. */
export function gunTail(env: SynthEnv, when: number, gain: number, interior: boolean, sp?: SpatialShot): void {
  const shot = env.pool.begin(bus(env, 'sfx'), when, 1.2, 1, sp ? { ...sp, reverb: 0.4 } : undefined);
  if (interior) tone(env, shot, when, { type: 'sawtooth', f: 440, fEnd: 90, glideDur: 0.7, gain: 0.05 * gain, attack: 0.005, tau: 0.25, lp: 1600 });
  burst(env, shot, when, { buf: 'brown', type: 'lowpass', f: 420, gain: 0.35 * gain, attack: 0.01, tau: 0.22 });
  burst(env, shot, when, { buf: 'pink', type: 'bandpass', f: 700, q: 0.7, gain: 0.12 * gain, attack: 0.05, tau: 0.3, delay: 0.1 });
}

/** Mach 1 from inside the cockpit: a soft pressure thump (no boom for the pilot). */
export function transonicThump(env: SynthEnv, when: number): void {
  const shot = env.pool.begin(bus(env, 'engine'), when, 0.6, 0);
  tone(env, shot, when, { type: 'sine', f: 40, fEnd: 28, gain: 0.35, attack: 0.03, tau: 0.12 });
  burst(env, shot, when, { buf: 'brown', type: 'lowpass', f: 200, gain: 0.25, attack: 0.03, tau: 0.1 });
}

/* ───────────────────────── Cockpit / pilot ───────────────────────── */

/** Pilot breathing in the oxygen mask. kind: calm inhale/exhale, or the anti-G "hook" strain. */
export function breath(env: SynthEnv, when: number, kind: 'in' | 'out' | 'strain', gain: number): void {
  const shot = env.pool.begin(bus(env, 'engine'), when, kind === 'strain' ? 0.6 : 1.6, 0);
  if (kind === 'in') {
    // mask valve click + airy inhale
    burst(env, shot, when, { buf: 'white', type: 'bandpass', f: 3500, q: 4, gain: 0.25 * gain, attack: 0.0005, tau: 0.006 });
    burst(env, shot, when, { buf: 'white', type: 'bandpass', f: 1500, fEnd: 2200, q: 0.9, gain: 0.5 * gain, attack: 0.35, tau: 0.18, delay: 0.02 });
  } else if (kind === 'out') {
    burst(env, shot, when, { buf: 'pink', type: 'bandpass', f: 900, fEnd: 600, q: 0.8, gain: 0.55 * gain, attack: 0.08, tau: 0.3 });
    burst(env, shot, when, { buf: 'white', type: 'bandpass', f: 3200, q: 3, gain: 0.15 * gain, attack: 0.0005, tau: 0.008, delay: 0.7 });
  } else {
    // AGSM: short forced exhale "hk!" then a quick gasp
    burst(env, shot, when, { buf: 'pink', type: 'bandpass', f: 1100, q: 1.4, gain: 0.8 * gain, attack: 0.01, tau: 0.05 });
    tone(env, shot, when, { type: 'sawtooth', f: 125, fEnd: 105, gain: 0.07 * gain, attack: 0.01, tau: 0.06, lp: 900 });
    burst(env, shot, when, { buf: 'white', type: 'bandpass', f: 1900, q: 1, gain: 0.45 * gain, attack: 0.05, tau: 0.07, delay: 0.16 });
  }
}

/** G-suit dumping pressure when the G comes off. */
export function gsuitDeflate(env: SynthEnv, when: number, gain: number): void {
  const shot = env.pool.begin(bus(env, 'engine'), when, 0.8, 0);
  burst(env, shot, when, { buf: 'white', type: 'bandpass', f: 2400, fEnd: 1500, q: 0.8, gain: 0.35 * gain, attack: 0.01, tau: 0.16 });
}

/* ───────────────────────── Avionics tones ───────────────────────── */

/** RWR "new guy": a short burst of beeps — pitch by threat class. */
export function rwrNew(env: SynthEnv, when: number, kind: string): void {
  const f = kind === 'sam' ? 980 : kind === 'aaa' ? 1650 : 1320;
  const shot = env.pool.begin(bus(env, 'warn'), when, 0.5, 1);
  for (let i = 0; i < 3; i++) beep(env, shot, when + i * 0.075, 'square', f, 0.045, 0.22, 3200);
}

/** Own radar lock (STT) confirmation: three rising beeps. */
export function lockConfirm(env: SynthEnv, when: number): void {
  const shot = env.pool.begin(bus(env, 'warn'), when, 0.45, 1);
  [1500, 1800, 2150].forEach((f, i) => beep(env, shot, when + i * 0.07, 'triangle', f, 0.055, 0.35, 6000));
}

/** Lock lost: a single falling blip. */
export function lockLost(env: SynthEnv, when: number): void {
  const shot = env.pool.begin(bus(env, 'warn'), when, 0.3, 0);
  tone(env, shot, when, { type: 'triangle', f: 1400, fEnd: 700, glideDur: 0.12, gain: 0.25, attack: 0.004, tau: 0.05 });
}

/** Master caution: two-tone soft chime (precedes the Betty call for cautions). */
export function cautionChime(env: SynthEnv, when: number): void {
  const shot = env.pool.begin(bus(env, 'warn'), when, 0.9, 2);
  for (const [f, dt] of [
    [1046, 0],
    [784, 0.17],
  ] as const) {
    tone(env, shot, when, { type: 'sine', f, gain: 0.35, attack: 0.004, tau: 0.16, delay: dt });
    tone(env, shot, when, { type: 'sine', f: f * 2.76, gain: 0.06, attack: 0.002, tau: 0.06, delay: dt });
  }
}

/** Weapon release refused: low double "bonk". */
export function denied(env: SynthEnv, when: number): void {
  const shot = env.pool.begin(bus(env, 'warn'), when, 0.35, 0);
  beep(env, shot, when, 'square', 330, 0.07, 0.2, 1400);
  beep(env, shot, when + 0.1, 'square', 262, 0.09, 0.2, 1400);
}

const WEAPON_BEEP: Record<WeaponId, number> = { gun: 600, aim9x: 900, aim120: 1200, gbu31: 750, gbu53: 860, aargm: 1050 };

/** Weapon selector detent click + a short identifying beep. */
export function weaponSelect(env: SynthEnv, when: number, weapon: WeaponId): void {
  const shot = env.pool.begin(bus(env, 'warn'), when, 0.25, 0);
  burst(env, shot, when, { buf: 'white', type: 'bandpass', f: 3200, q: 3, gain: 0.5, attack: 0.0005, tau: 0.006 });
  burst(env, shot, when, { buf: 'white', type: 'bandpass', f: 2000, q: 3, gain: 0.35, attack: 0.0005, tau: 0.006, delay: 0.035 });
  beep(env, shot, when + 0.06, 'sine', WEAPON_BEEP[weapon] ?? 1000, 0.06, 0.18, 5000);
}

/** Target designation (TD box moved): soft tick. */
export function designateTick(env: SynthEnv, when: number): void {
  const shot = env.pool.begin(bus(env, 'warn'), when, 0.1, 0);
  tone(env, shot, when, { type: 'sine', f: 2600, gain: 0.12, attack: 0.001, tau: 0.015 });
}

/** Menu click (UI bus — works while paused). */
export function uiClick(env: SynthEnv, when: number): void {
  const shot = env.pool.begin(bus(env, 'ui'), when, 0.1, 0);
  burst(env, shot, when, { buf: 'white', type: 'bandpass', f: 2800, q: 2, gain: 0.45, attack: 0.0005, tau: 0.006 });
  tone(env, shot, when, { type: 'sine', f: 1850, gain: 0.12, attack: 0.001, tau: 0.018 });
}

/* ───────────────────────── Radio ───────────────────────── */

/** Radio key-up: click + a breath of static before the voice. */
export function squelchKey(env: SynthEnv, when: number, gain = 1): void {
  const shot = env.pool.begin(bus(env, 'voice'), when, 0.2, 1);
  burst(env, shot, when, { buf: 'white', type: 'bandpass', f: 1800, q: 1.2, gain: 0.3 * gain, attack: 0.001, tau: 0.03 });
  burst(env, shot, when, { buf: 'white', type: 'bandpass', f: 3000, q: 6, gain: 0.25 * gain, attack: 0.0005, tau: 0.004 });
}

/** Text-only radio call: key click + a burst of carrier static (no voice clip). */
export function radioStatic(env: SynthEnv, when: number): void {
  const shot = env.pool.begin(bus(env, 'voice'), when, 0.5, 0);
  squelchKey(env, when, 0.7);
  burst(env, shot, when, { buf: 'crackle', type: 'bandpass', f: 1600, q: 0.8, gain: 0.18, attack: 0.02, tau: 0.08, delay: 0.05 });
  burst(env, shot, when, { buf: 'white', type: 'bandpass', f: 1700, q: 0.8, gain: 0.12, attack: 0.005, tau: 0.04, delay: 0.3 });
}

/** Missile defeated (notched / decoyed / guidance lost): quick rising major arpeggio — relief, not alarm. */
export function missileDefeated(env: SynthEnv, when: number): void {
  const shot = env.pool.begin(bus(env, 'warn'), when, 0.8, 2);
  [880, 1109, 1319, 1760].forEach((f, i) => {
    tone(env, shot, when, { type: 'sine', f, gain: 0.26, attack: 0.004, tau: i === 3 ? 0.22 : 0.07, delay: i * 0.065 });
    tone(env, shot, when, { type: 'triangle', f: f * 2, gain: 0.04, attack: 0.002, tau: 0.04, delay: i * 0.065 });
  });
}
