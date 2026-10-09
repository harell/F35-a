/**
 * Regression tests for the i1 render review: F-35A proportions ('fat', deep, blunt forebody),
 * RNZAF markings instead of USAF, and air-kill readability at BVR ranges.
 */
import { describe, expect, it } from 'vitest';
import { Box3, type BufferGeometry, type Mesh, Vector3, type Object3D } from 'three';
import { getAircraftPrototype } from '../src/render/models/aircraft';
import { AIR_KILL, LAUNCH_FX, motorGlow } from '../src/render/effects/Effects';
import type { SpriteBatch } from '../src/render/effects/SpriteBatch';
import { MissileEntity } from '../src/sim/entities';
import { MUNITIONS } from '../src/sim/weapons/defs';
import liverySrc from '../src/render/models/aircraft/liveries.ts?raw';

/** Vertical extent (m) of the model's vertices with |x| < xMax inside the z slab [z0, z1]. */
function depthAt(root: Object3D, z0: number, z1: number, xMax: number): number {
  let lo = Infinity;
  let hi = -Infinity;
  const v = new Vector3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh || !o.visible) return;
    const pos = (m.geometry as BufferGeometry).getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      if (v.z < z0 || v.z > z1 || Math.abs(v.x) > xMax) continue;
      lo = Math.min(lo, v.y);
      hi = Math.max(hi, v.y);
    }
  });
  return hi - lo;
}

describe('F-35A proportions (reviewer: nose too long/pointed, fuselage too slender)', () => {
  const p = getAircraftPrototype('f35a');
  const box = new Box3().setFromObject(p.lod1);
  const size = box.getSize(new Vector3());
  const nose = box.min.z;

  it('matches the real jet: length 15.7 m, span 10.7 m (±4%)', () => {
    expect(size.z).toBeGreaterThan(15.7 * 0.96);
    expect(size.z).toBeLessThan(15.7 * 1.04);
    expect(size.x).toBeGreaterThan(10.7 * 0.96);
    expect(size.x).toBeLessThan(10.7 * 1.04);
  });

  it('has a deep, blunt forebody: >= 1.2 m deep 2 m aft of the nose, >= 0.9 m at 1 m', () => {
    expect(depthAt(p.lod1, nose + 1.9, nose + 2.1, 0.3)).toBeGreaterThan(1.2);
    expect(depthAt(p.lod1, nose + 0.9, nose + 1.1, 0.3)).toBeGreaterThan(0.9);
  });

  it("has the 'chunky' mid-body: fuselage >= 1.9 m deep behind the canopy (spine hump)", () => {
    // s = 7.4..8.4 m aft of the nose, centreline (excludes fins and canopy)
    expect(depthAt(p.lod1, nose + 7.6, nose + 8.2, 0.25)).toBeGreaterThan(1.9);
  });

  it('is wide at the intakes: >= 27% of the span (was ~25%)', () => {
    // widest point of the fuselage/intakes between s = 6.5 and 7.5 m (ahead of the wing root)
    let w = 0;
    const v = new Vector3();
    p.lod1.updateMatrixWorld(true);
    p.lod1.traverse((o) => {
      const m = o as Mesh;
      if (!m.isMesh) return;
      const pos = (m.geometry as BufferGeometry).getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        if (v.z > nose + 5.6 && v.z < nose + 6.2) w = Math.max(w, Math.abs(v.x) * 2);
      }
    });
    expect(w / size.x).toBeGreaterThan(0.27);
  });
});

describe('RNZAF livery (reviewer: USAF / HL / star-and-bar in an RNZAF campaign)', () => {
  const src = liverySrc;
  const f35 = src.slice(src.indexOf('function paintF35'), src.indexOf('function kiwi'));
  it('paints RNZAF, NZ tail code and kiwi roundels; no USAF markings', () => {
    expect(f35).toContain("'RNZAF'");
    expect(f35).toContain("'NZ'");
    expect(f35).toMatch(/kiwi\(ctx/);
    expect(f35).not.toContain('USAF');
    expect(f35).not.toContain("'HL'");
    expect(f35).not.toMatch(/AtlasPainter\.star/);
  });
});

describe('air kill readability (reviewer: 16 m explosion = 1-3 px at 3-8 km)', () => {
  const pxPerM = (distM: number, screenH = 375, fovDeg = 60) => screenH / (2 * Math.tan((fovDeg * Math.PI) / 360) * distM);
  it('flash never smaller than ~24 CSS px (device px at DPR 2) for 0.3 s', () => {
    expect(AIR_KILL.flashMinPx).toBeGreaterThanOrEqual(48);
    expect(AIR_KILL.glowMinPx).toBeGreaterThanOrEqual(24);
  });
  it('fireball is 2-3x bigger than the old medium explosion and still visible at 5 km', () => {
    const S = AIR_KILL.scale(17.3); // MiG-29
    expect(S).toBeGreaterThan(16 * 2.5);
    // natural size at 5 km on a 375 px phone screen would be ~3-4 px; the min-pixel clamp keeps it readable
    expect(Math.max(S * 1.1 * pxPerM(5000), AIR_KILL.fireballMinPx)).toBeGreaterThanOrEqual(10);
    expect(AIR_KILL.secondaries).toBeGreaterThanOrEqual(3);
  });
});

describe('an AMRAAM launch reads from the cockpit (playtest r1 1.2-b)', () => {
  /** The motor glow's [world size, min CSS px] for a missile of `id` at `age` s after release. */
  const glow = (id: 'aim120' | 'm_3m9', age: number) => {
    const m = new MissileEntity(7, MUNITIONS[id], 'blue', 1, 2);
    m.age = age;
    const out: number[][] = [];
    motorGlow({ add: (...a: number[]) => (out.push(a), true) } as unknown as Pick<SpriteBatch, 'add'>, m, new Vector3(), 0, 1);
    expect(out.length).toBe(1);
    return [out[0][7], out[0][8]];
  };
  const pxPerM = (distM: number, screenH = 390, fovDeg = 60) => screenH / (2 * Math.tan((fovDeg * Math.PI) / 360) * distM);

  it('its motor is a big bright dot for its first 1–2 s, easing back to the usual 6 px', () => {
    const [s0, px0] = glow('aim120', 0.6);
    expect(px0).toBe(LAUNCH_FX.glowMinPx);
    expect(px0).toBeGreaterThanOrEqual(16);
    // 1.5 s out the AMRAAM is ~250 m ahead of the jet: its natural size there is ~3 px; the glow keeps ≥ 12
    const [s15, px15] = glow('aim120', 1.5);
    expect(Math.max(px15, s15 * pxPerM(250))).toBeGreaterThanOrEqual(12);
    expect(s0).toBeGreaterThan(glow('aim120', 3)[0]);
    expect(glow('aim120', 3)[1]).toBe(6);
    // a SAM's glow is untouched (it is seen from the target's side, already 9 px)
    expect(glow('m_3m9', 0.5)[1]).toBe(9);
  });

  it('the ignition flash is bigger than a kill fireball\'s minimum and lasts long enough to catch', () => {
    expect(LAUNCH_FX.flashMinPx).toBeGreaterThan(AIR_KILL.fireballMinPx);
    expect(LAUNCH_FX.flashLife).toBeGreaterThanOrEqual(0.25);
    expect(LAUNCH_FX.glowS).toBeGreaterThanOrEqual(1.5);
  });
});
