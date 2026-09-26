/**
 * Pilot vision effects from load factor — pure, unit tested.
 *
 *  grey  0..1  tunnel vision / grey-out, builds with SUSTAINED high positive G (onset ~6.5 g, strong
 *              beyond ~7.5 g, full near 9.5 g) with a slow onset and a faster recovery.
 *  red   0..1  red-out under negative G (beyond about -2 g).
 *  flash 0..1  red hit flash (player:hit), decays quickly.
 */

export interface GEffectState {
  grey: number;
  red: number;
  flash: number;
}

export const G_EFFECTS = {
  /** G where the grey-out target starts rising. */
  greyOnsetG: 6.5,
  /** G span from onset to full grey-out. */
  greySpanG: 3,
  /** Time constants (s). */
  greyOnsetTau: 2.2,
  greyRecoverTau: 1.0,
  /** Negative G where red-out starts (magnitude). */
  redOnsetG: 2,
  redSpanG: 1.5,
  redOnsetTau: 1.2,
  redRecoverTau: 0.8,
  /** Hit flash decay (1/s). */
  flashDecay: 1.8,
  /** Never fully black out: the game stays playable (arcade friendly). */
  maxGrey: 0.93,
} as const;

export function makeGEffectState(): GEffectState {
  return { grey: 0, red: 0, flash: 0 };
}

/** Target grey-out level for a given G (0..1). */
export function greyTarget(g: number): number {
  return Math.max(0, Math.min(1, (g - G_EFFECTS.greyOnsetG) / G_EFFECTS.greySpanG));
}

/** Target red-out level for a given G (0..1). */
export function redTarget(g: number): number {
  return Math.max(0, Math.min(1, (-g - G_EFFECTS.redOnsetG) / G_EFFECTS.redSpanG));
}

function approachExp(cur: number, target: number, tauUp: number, tauDown: number, dt: number): number {
  const tau = target > cur ? tauUp : tauDown;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}

/** Advance the effect state by dt at load factor g. With `enabled` false only the hit flash works. */
export function stepGEffects(s: GEffectState, g: number, dt: number, enabled: boolean): GEffectState {
  const gt = enabled ? greyTarget(g) : 0;
  const rt = enabled ? redTarget(g) : 0;
  s.grey = Math.min(G_EFFECTS.maxGrey, approachExp(s.grey, gt, G_EFFECTS.greyOnsetTau, G_EFFECTS.greyRecoverTau, dt));
  s.red = Math.min(0.9, approachExp(s.red, rt, G_EFFECTS.redOnsetTau, G_EFFECTS.redRecoverTau, dt));
  // snap tiny residuals of the exponential decay to zero (invisible, and lets the renderer skip)
  if (s.grey < 0.004 && gt === 0) s.grey = 0;
  if (s.red < 0.004 && rt === 0) s.red = 0;
  s.flash = Math.max(0, s.flash - G_EFFECTS.flashDecay * dt);
  return s;
}

/** Trigger the hit flash (amount = damage points). */
export function hitFlash(s: GEffectState, amount: number): void {
  s.flash = Math.min(1, Math.max(s.flash, 0.35 + amount / 80));
}

/** Vignette parameters derived from the state (for the renderer). */
export function vignetteParams(s: GEffectState, out: { scale: number; alpha: number; greyAlpha: number }): typeof out {
  // tunnel: the clear centre shrinks from beyond the screen corners to ~35 % of the height
  out.scale = 1.35 - 0.95 * s.grey;
  out.alpha = Math.min(1, s.grey * 1.15);
  out.greyAlpha = Math.max(0, s.grey - 0.35) * 0.75;
  return out;
}
