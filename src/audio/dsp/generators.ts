/**
 * F35-A audio — pure sample generators for the procedural buffers (no Web Audio; unit-tested).
 *
 * Everything the synth needs is generated once when the AudioContext appears:
 *  white / pink / brown noise loops, a sparse "crackle" (afterburner popcorn, debris), and
 *  gun loops (one period per round: sharp transient + low thump + body) for the GAU-22 (55 rds/s),
 *  GSh-30-1 and ZSU-23-4. Loops are made seamless by cross-fading the tail into the head.
 */

export type Rng = () => number;

/** Small deterministic PRNG (mulberry32) so buffers are identical on every run. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform white noise in [−1, 1). */
export function fillWhite(out: Float32Array, rng: Rng): Float32Array {
  for (let i = 0; i < out.length; i++) out[i] = rng() * 2 - 1;
  return out;
}

/** Pink (−3 dB/oct) noise — Paul Kellet's refined filter, normalised to peak 0.95. */
export function fillPink(out: Float32Array, rng: Rng): Float32Array {
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    b3 = 0,
    b4 = 0,
    b5 = 0,
    b6 = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rng() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
  }
  return normalizePeak(out, 0.95);
}

/** Brown (−6 dB/oct) noise: leaky integrated white noise, DC-free, normalised to peak 0.95. */
export function fillBrown(out: Float32Array, rng: Rng): Float32Array {
  let last = 0;
  for (let i = 0; i < out.length; i++) {
    const w = rng() * 2 - 1;
    last = (last + 0.02 * w) / 1.02;
    out[i] = last;
  }
  removeDc(out);
  return normalizePeak(out, 0.95);
}

/**
 * Sparse crackle: random impulses (density per second) with short exponential decays and
 * random polarity/amplitude — afterburner "popcorn", debris patter, radio static.
 */
export function fillCrackle(out: Float32Array, sampleRate: number, rng: Rng, density = 90): Float32Array {
  out.fill(0);
  const n = out.length;
  const count = Math.max(1, Math.round((density * n) / sampleRate));
  for (let k = 0; k < count; k++) {
    const start = Math.floor(rng() * n);
    const amp = (0.25 + 0.75 * rng() * rng()) * (rng() < 0.5 ? -1 : 1);
    const decay = sampleRate * (0.0006 + 0.0025 * rng()); // 0.6..3 ms
    const len = Math.min(n - start, Math.ceil(decay * 5));
    for (let i = 0; i < len; i++) {
      const env = Math.exp(-i / decay);
      out[start + i] += amp * env * (rng() * 2 - 1);
    }
  }
  return normalizePeak(out, 0.95);
}

export interface GunLoopStyle {
  /** Rounds per second. */
  rate: number;
  /** Number of rounds in the loop (loop length = rounds / rate). */
  rounds: number;
  /** Low "thump" start/end frequency (Hz). */
  thumpHz: number;
  /** Thump decay time constant (s). */
  thumpDecay: number;
  /** Bright transient (muzzle crack) decay time constant (s). */
  crackDecay: number;
  /** Mix of thump vs crack (0..1 = all thump). */
  thumpMix: number;
  /** Random amplitude jitter per round (0..1). */
  jitter: number;
}

/** GAU-22/A: 4 barrels, 3,300 rds/min = 55 rds/s — the "brrrt". */
export const GAU22_STYLE: GunLoopStyle = { rate: 55, rounds: 22, thumpHz: 95, thumpDecay: 0.011, crackDecay: 0.0022, thumpMix: 0.55, jitter: 0.12 };
/** GSh-30-1: single barrel 30 mm, ~1,650 rds/min — slower, heavier bangs. */
export const GSH301_STYLE: GunLoopStyle = { rate: 27.5, rounds: 11, thumpHz: 70, thumpDecay: 0.018, crackDecay: 0.003, thumpMix: 0.65, jitter: 0.1 };
/** ZSU-23-4 Shilka: four 23 mm barrels, bursts of ~57 rds/s with an uneven beat. */
export const ZSU23_STYLE: GunLoopStyle = { rate: 57, rounds: 20, thumpHz: 80, thumpDecay: 0.014, crackDecay: 0.0028, thumpMix: 0.6, jitter: 0.25 };

/**
 * Gun loop: one period per round, each round = bright noise crack + pitched-down thump
 * + a short band-limited "body". Timing jitter keeps it from sounding like a pure buzz.
 */
export function fillGunLoop(out: Float32Array, sampleRate: number, rng: Rng, style: GunLoopStyle): Float32Array {
  out.fill(0);
  const n = out.length;
  const period = sampleRate / style.rate;
  let lp = 0;
  for (let r = 0; r < style.rounds; r++) {
    const jitterT = (rng() - 0.5) * 0.06 * period;
    const start = Math.max(0, Math.floor(r * period + jitterT));
    const amp = 1 - style.jitter * rng();
    const crackTau = style.crackDecay * sampleRate;
    const thumpTau = style.thumpDecay * sampleRate;
    const len = Math.min(n - start, Math.ceil(period * 1.6));
    let phase = rng() * Math.PI * 2;
    for (let i = 0; i < len; i++) {
      const t = i / sampleRate;
      // crack: white noise, fast decay, crude one-pole high-pass for brightness
      const w = rng() * 2 - 1;
      lp += 0.35 * (w - lp);
      const crack = (w - lp) * Math.exp(-i / crackTau);
      // thump: sine gliding down one octave
      const f = style.thumpHz * (1 - 0.5 * Math.min(1, t / (style.thumpDecay * 4)));
      phase += (2 * Math.PI * f) / sampleRate;
      const thump = Math.sin(phase) * Math.exp(-i / thumpTau);
      // body: mid noise with medium decay
      const body = lp * Math.exp(-i / (thumpTau * 0.6));
      const idx = (start + i) % n; // wrap into the head so the loop stays continuous
      out[idx] += amp * (style.thumpMix * thump + (1 - style.thumpMix) * (0.9 * crack + 0.5 * body));
    }
  }
  removeDc(out);
  return normalizePeak(out, 0.95);
}

/** Cross-fade the last `fade` samples into the first ones so a loop has no click at the seam. */
export function makeLoopable(src: Float32Array, fade: number): Float32Array {
  const n = src.length - fade;
  if (n <= fade || fade <= 0) return src;
  const out = new Float32Array(n);
  out.set(src.subarray(0, n));
  for (let i = 0; i < fade; i++) {
    const a = i / fade; // head fades in, tail fades out
    const ga = Math.sin(a * Math.PI * 0.5);
    const gb = Math.cos(a * Math.PI * 0.5);
    out[i] = src[i] * ga + src[n + i] * gb;
  }
  return out;
}

export function removeDc(buf: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i];
  const m = sum / Math.max(1, buf.length);
  for (let i = 0; i < buf.length; i++) buf[i] -= m;
  return buf;
}

export function normalizePeak(buf: Float32Array, peak: number): Float32Array {
  let mx = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > mx) mx = a;
  }
  if (mx > 1e-9) {
    const g = peak / mx;
    for (let i = 0; i < buf.length; i++) buf[i] *= g;
  }
  return buf;
}

export function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, buf.length));
}
