import { describe, expect, it } from 'vitest';
import { G_EFFECTS, greyTarget, hitFlash, makeGEffectState, redTarget, stepGEffects, vignetteParams } from '../src/hud/hmd/gEffects';

function run(g: number, seconds: number, enabled = true, s = makeGEffectState()) {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) stepGEffects(s, g, dt, enabled);
  return s;
}

describe('hud G effects', () => {
  it('targets: nothing below ~6.5 g, noticeable at 7.5 g, near full at 9+ g', () => {
    expect(greyTarget(1)).toBe(0);
    expect(greyTarget(6.4)).toBe(0);
    expect(greyTarget(7.5)).toBeGreaterThan(0.25);
    expect(greyTarget(9.5)).toBe(1);
    expect(redTarget(-1)).toBe(0);
    expect(redTarget(-3.5)).toBe(1);
  });

  it('builds up only with sustained G (onset lag) and is monotonic', () => {
    const s = makeGEffectState();
    let prev = 0;
    for (let i = 0; i < 300; i++) {
      stepGEffects(s, 9, 1 / 60, true);
      expect(s.grey).toBeGreaterThanOrEqual(prev);
      prev = s.grey;
    }
    // after 0.5 s at 9 g it is still mild, after 5 s it is strong
    expect(run(9, 0.5).grey).toBeLessThan(0.25);
    expect(run(9, 5).grey).toBeGreaterThan(0.6);
    expect(run(9, 30).grey).toBeLessThanOrEqual(G_EFFECTS.maxGrey);
    // 7.5 g sustained → moderate
    const m = run(7.5, 8).grey;
    expect(m).toBeGreaterThan(0.2);
    expect(m).toBeLessThan(0.45);
  });

  it('recovers faster than it builds', () => {
    const s = run(9.5, 6);
    const peak = s.grey;
    run(1, 1, true, s);
    expect(s.grey).toBeLessThan(peak * 0.45);
    run(1, 6, true, s);
    expect(s.grey).toBe(0);
  });

  it('red-out under negative G, disabled on easy difficulty, hit flash decays', () => {
    expect(run(-3.2, 3).red).toBeGreaterThan(0.5);
    const d = run(9.5, 5, false);
    expect(d.grey).toBe(0);
    hitFlash(d, 40);
    expect(d.flash).toBeGreaterThan(0.5);
    run(1, 1, false, d);
    expect(d.flash).toBe(0);
  });

  it('vignette parameters tighten with grey-out', () => {
    const v = { scale: 0, alpha: 0, greyAlpha: 0 };
    vignetteParams({ grey: 0, red: 0, flash: 0 }, v);
    expect(v.alpha).toBe(0);
    const s0 = v.scale;
    vignetteParams({ grey: 0.8, red: 0, flash: 0 }, v);
    expect(v.scale).toBeLessThan(s0);
    expect(v.alpha).toBeGreaterThan(0.8);
    expect(v.greyAlpha).toBeGreaterThan(0);
  });
});
