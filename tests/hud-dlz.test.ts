import { describe, expect, it } from 'vitest';
import { NM } from '../src/core/math';
import { DLZ_SCALES_NM, dlzLayout, dlzScaleMax, dlzY, makeDlzGeometry } from '../src/hud/hmd/dlz';

describe('hud DLZ scale', () => {
  it('chooses the smallest nice scale that fits Rmax and the target', () => {
    expect(dlzScaleMax(30_000, 20_000) / NM).toBe(20); // 30 km * 1.15 = 18.6 nm
    expect(dlzScaleMax(6_000, 3_000) / NM).toBe(5); // AIM-9X
    expect(dlzScaleMax(30_000, 60_000) / NM).toBe(40); // far target drives the scale
    expect(dlzScaleMax(1e9, 0) / NM).toBe(DLZ_SCALES_NM[DLZ_SCALES_NM.length - 1]);
  });

  it('maps ranges linearly bottom → top and clamps', () => {
    expect(dlzY(0, 1000, 100, 300)).toBe(300);
    expect(dlzY(1000, 1000, 100, 300)).toBe(100);
    expect(dlzY(500, 1000, 100, 300)).toBe(200);
    expect(dlzY(5000, 1000, 100, 300)).toBe(100);
    expect(dlzY(-5, 1000, 100, 300)).toBe(300);
  });

  it('lays out Rmin < Rne < Rmax with the target caret and flags', () => {
    const g = makeDlzGeometry();
    dlzLayout({ range: 15_000, rMin: 1_500, rNe: 12_000, rMax: 30_000 }, 100, 300, g);
    expect(g.yMin).toBeGreaterThan(g.yNe);
    expect(g.yNe).toBeGreaterThan(g.yRange);
    expect(g.yRange).toBeGreaterThan(g.yMax);
    expect(g.yMax).toBeGreaterThanOrEqual(100);
    expect(g.inRange).toBe(true);
    expect(g.inNez).toBe(false);
    expect(g.clamped).toBe(false);
    dlzLayout({ range: 8_000, rMin: 1_500, rNe: 12_000, rMax: 30_000 }, 100, 300, g);
    expect(g.inNez).toBe(true);
    dlzLayout({ range: 500, rMin: 1_500, rNe: 12_000, rMax: 30_000 }, 100, 300, g);
    expect(g.inRange).toBe(false);
  });

  it('keeps a sticky scale to avoid jumping, but grows when needed', () => {
    const g = makeDlzGeometry();
    dlzLayout({ range: 25_000, rMin: 1_500, rNe: 12_000, rMax: 30_000 }, 100, 300, g);
    const s = g.scaleMax;
    dlzLayout({ range: 20_000, rMin: 1_500, rNe: 12_000, rMax: 28_000 }, 100, 300, g, s);
    expect(g.scaleMax).toBe(s);
    dlzLayout({ range: 90_000, rMin: 1_500, rNe: 12_000, rMax: 30_000 }, 100, 300, g, s);
    expect(g.scaleMax).toBeGreaterThan(s);
    expect(g.clamped).toBe(false);
  });
});
