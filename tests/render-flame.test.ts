import { describe, expect, it } from 'vitest';
import { DataTexture, Mesh, RepeatWrapping, ShaderMaterial } from 'three';
import { AB_PALETTE, AB_POP, Flame, flameNoiseTexture, popEnvelope } from '../src/render/models/flame';
import { AIRCRAFT_SPECS } from '../src/render/models/specs';

const spec = AIRCRAFT_SPECS.f35a;
const R = spec.engines[0].radius;

function part(f: Flame, name: string): Mesh {
  const m = f.group.getObjectByName(`flame:${name}`) as Mesh | undefined;
  if (!m) throw new Error(`missing flame:${name}`);
  return m;
}
const uni = (f: Flame, name: string) => (part(f, name).material as ShaderMaterial).uniforms;
const lengthOf = (f: Flame) => part(f, 'outer').scale.z;

/** Steps a flame at 60 Hz through an ab(t) schedule; returns the outer length per frame. */
function run(f: Flame, t0: number, t1: number, ab: (t: number) => number, rpm = 1): number[] {
  const out: number[] = [];
  for (let t = t0; t <= t1 + 1e-9; t += 1 / 60) {
    f.update(t, ab(t), rpm);
    out.push(lengthOf(f));
  }
  return out;
}

describe('afterburner flame (B1–B5)', () => {
  it('B1: by day the plume stays below clipping and is paler than at night', () => {
    const day = new Flame(R, spec.abLength, 'afterburner', 1);
    const night = new Flame(R, spec.abLength, 'afterburner', 1);
    night.night = true;
    day.update(10, 1, 1);
    night.update(10, 1, 1);
    const dc = uni(day, 'core');
    // brightest core colour channel × intensity: well below 1 so diamonds have headroom over the sky
    const dayPeak = Math.max(...dc.uColorA.value.toArray()) * dc.uIntensity.value;
    expect(dayPeak).toBeLessThan(0.6);
    // ...but not so dim that a lit AB disappears on a sunlit screen
    expect(dayPeak).toBeGreaterThan(0.3);
    expect(dc.uDiamonds.value).toBeGreaterThan(0.9);
    const nc = uni(night, 'core');
    expect(nc.uIntensity.value).toBeGreaterThan(dc.uIntensity.value * 2);
    // night is orange: red well above blue in the outer plume
    const no = uni(night, 'outer').uColorA.value;
    expect(no.x - no.z).toBeGreaterThan(0.6);
    // palettes are actually what the flame uses
    expect(no.toArray()).toEqual(AB_PALETTE.night.outerA);
  });

  it('B2: noise texture is small, tiling and seamless; uniforms carry flow and plume length', () => {
    const t = flameNoiseTexture() as DataTexture;
    expect(t.image.width).toBe(64);
    expect(t.wrapS).toBe(RepeatWrapping);
    expect(t.wrapT).toBe(RepeatWrapping);
    const d = t.image.data as Uint8Array;
    const S = 64;
    const at = (x: number, y: number, c: number) => d[(y * S + x) * 4 + c];
    // wrap-around neighbours differ no more than ordinary neighbours do (no seam)
    let maxSeam = 0;
    let maxInner = 0;
    for (let y = 0; y < S; y++)
      for (let c = 0; c < 2; c++) {
        maxSeam = Math.max(maxSeam, Math.abs(at(S - 1, y, c) - at(0, y, c)), Math.abs(at(y, S - 1, c) - at(y, 0, c)));
        maxInner = Math.max(maxInner, Math.abs(at(30, y, c) - at(31, y, c)));
      }
    expect(maxSeam).toBeLessThanOrEqual(maxInner + 2);
    // both octaves have real contrast
    let min = 255;
    let max = 0;
    for (let i = 0; i < S * S; i++) {
      min = Math.min(min, d[i * 4]);
      max = Math.max(max, d[i * 4]);
    }
    expect(max - min).toBeGreaterThan(120);

    const f = new Flame(R, spec.abLength, 'afterburner', 3);
    f.update(5, 1, 1);
    const u = uni(f, 'outer');
    expect(u.uNoise.value).toBe(t); // shared, not a per-instance copy
    expect(u.uFlow.value).toBeGreaterThan(0);
    expect(u.uLength.value).toBeCloseTo(lengthOf(f), 6);
    // shader programs stay shared: every instance uses identical shader source
    const g = new Flame(R, spec.abLength, 'afterburner', 9);
    expect((part(g, 'outer').material as ShaderMaterial).fragmentShader).toBe((part(f, 'outer').material as ShaderMaterial).fragmentShader);
  });

  it('B3: light-off gives a short flash and length overshoot, steady AB does not', () => {
    expect(popEnvelope(-0.1)).toBe(0);
    expect(popEnvelope(0)).toBe(0);
    expect(popEnvelope(AB_POP.tau)).toBeCloseTo(1, 6);
    expect(popEnvelope(0.3)).toBeLessThan(0.05);

    // sim-like ramp: AB lights at t=1 and rises at +2.5/s
    const ramp = (t: number) => Math.max(0, Math.min(1, (t - 1) * 2.5));
    const lit = new Flame(R, spec.abLength, 'afterburner', 1);
    const steady = new Flame(R, spec.abLength, 'afterburner', 1);
    run(lit, 0, 0.99, ramp);
    run(steady, 0, 0.99, ramp);
    lit.update(1.02, 0.05, 1); // rising edge
    lit.update(1.05, ramp(1.05) + 0, 1);
    const popped = lengthOf(lit);
    const coreFlash = uni(lit, 'core').uIntensity.value;
    // the same ab without an edge (fresh flame starting lit) has no pop
    const ref = new Flame(R, spec.abLength, 'afterburner', 1);
    ref.update(1.0, 0.05, 1);
    ref.update(1.05, ramp(1.05), 1);
    expect(popped).toBeGreaterThan(lengthOf(ref) * 1.3);
    expect(coreFlash).toBeGreaterThan(uni(ref, 'core').uIntensity.value * 1.2);
    // transient is gone within ~0.3 s
    lit.update(1.5, ramp(1.5), 1);
    ref.update(1.5, ramp(1.5), 1);
    expect(lengthOf(lit)).toBeCloseTo(lengthOf(ref), 3);
    // no repeat pop while AB stays lit
    run(steady, 1, 1.6, ramp);
    const lens = run(steady, 1.6, 3, () => 1);
    expect(Math.max(...lens) / Math.min(...lens)).toBeLessThan(1.08);
  });

  it('B3: on cut the plume retracts faster than the AB level falls', () => {
    const f = new Flame(R, spec.abLength, 'afterburner', 1);
    const g = new Flame(R, spec.abLength, 'afterburner', 1);
    f.update(10, 1, 1);
    f.update(10.1, 0.5, 1); // falling
    g.update(10.1, 0.5, 1); // same level, no history
    expect(lengthOf(f)).toBeLessThan(lengthOf(g) * 0.85);
    f.update(10.2, 0, 1);
    expect(part(f, 'outer').visible).toBe(true); // MIL heat plume remains
    expect(lengthOf(f)).toBeLessThan(spec.abLength * 0.2);
  });

  it('B4: nozzle interior glows dull red at MIL, orange in AB, brighter at night, off when idle/far', () => {
    const f = new Flame(R, spec.abLength, 'afterburner', 1);
    const inner = part(f, 'interior');
    const h = uni(f, 'interior');
    f.update(1, 0, 1);
    expect(inner.visible).toBe(true);
    const milK = h.uIntensity.value;
    const milCol = h.uColor.value.clone();
    expect(milCol.x).toBeGreaterThan(milCol.y * 4); // dull red
    f.update(2, 1, 1);
    expect(h.uIntensity.value).toBeGreaterThan(milK * 2);
    expect(h.uColor.value.y).toBeGreaterThan(milCol.y * 3); // toward orange
    f.night = true;
    f.update(3, 0, 1);
    expect(h.uIntensity.value).toBeGreaterThan(milK * 1.5);
    f.update(4, 0, 0.3); // idle
    expect(inner.visible).toBe(false);
    f.update(5, 1, 1, true, true); // far LOD
    expect(inner.visible).toBe(false);
    // missiles have no nozzle interior
    expect(new Flame(0.1, 2, 'motor').group.getObjectByName('flame:interior')).toBeUndefined();
  });

  it('B5: glow is a camera-facing sprite that grows with AB level', () => {
    const f = new Flame(R, spec.abLength, 'afterburner', 1);
    const glow = part(f, 'glow');
    const mat = glow.material as ShaderMaterial;
    // billboarded in the vertex shader (view-space offset), so it never goes edge-on
    expect(mat.vertexShader).toMatch(/c\.xy \+= position\.xy/);
    f.update(1, 0, 1);
    const milSize = mat.uniforms.uSize.value;
    const milK = mat.uniforms.uIntensity.value;
    f.update(2, 1, 1);
    expect(mat.uniforms.uSize.value).toBeGreaterThan(milSize * 2);
    expect(mat.uniforms.uIntensity.value).toBeGreaterThan(milK * 2);
    expect(glow.visible).toBe(true);
    f.update(3, 1, 1, false);
    expect(mat.uniforms.uIntensity.value).toBe(0);
  });
});
