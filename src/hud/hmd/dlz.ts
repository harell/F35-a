/**
 * Dynamic launch zone (DLZ) scale mapping — pure, unit tested.
 *
 * The HMD draws a vertical range scale: bottom = 0, top = `scaleMax` (a "nice" value in nautical
 * miles chosen so Rmax and the target both fit). Rmin/Rne/Rmax and the target caret are mapped to
 * screen y between `bottom` and `top`.
 */
import { NM } from '../../core/math';

/** Nice DLZ scale tops (nm). */
export const DLZ_SCALES_NM = [1, 2, 3, 5, 8, 10, 15, 20, 25, 30, 40, 50, 60, 80] as const;

export interface DlzGeometry {
  /** Scale top (m). */
  scaleMax: number;
  /** Scale top (nm) — label. */
  scaleNm: number;
  yMin: number;
  yNe: number;
  yMax: number;
  /** Target range caret y (clamped to the scale). */
  yRange: number;
  /** Target is beyond the scale top. */
  clamped: boolean;
  /** Target inside [rMin, rMax]. */
  inRange: boolean;
  /** Target inside [rMin, rNe] (no-escape zone). */
  inNez: boolean;
}

export function makeDlzGeometry(): DlzGeometry {
  return { scaleMax: 1, scaleNm: 1, yMin: 0, yNe: 0, yMax: 0, yRange: 0, clamped: false, inRange: false, inNez: false };
}

/** Smallest nice scale (m) ≥ both 1.15·Rmax and 1.05·range (capped at the largest scale). */
export function dlzScaleMax(rMax: number, range: number): number {
  const need = Math.max(rMax * 1.15, range * 1.05, 0) / NM;
  for (const s of DLZ_SCALES_NM) if (s >= need) return s * NM;
  return DLZ_SCALES_NM[DLZ_SCALES_NM.length - 1] * NM;
}

/** Map a range (m) to y on a scale spanning bottom (0) → top (scaleMax). */
export function dlzY(r: number, scaleMax: number, top: number, bottom: number): number {
  const f = Math.max(0, Math.min(1, r / Math.max(1, scaleMax)));
  return bottom - f * (bottom - top);
}

/**
 * Lay out the DLZ scale. The scale top is sticky (`prevScale`) so it does not jump back and forth as
 * the target range crosses a boundary: it only grows when needed and shrinks when the content fits in
 * less than 70 % of a smaller scale.
 */
export function dlzLayout(
  zone: { range: number; rMin: number; rNe: number; rMax: number },
  top: number,
  bottom: number,
  out: DlzGeometry,
  prevScale = 0,
): DlzGeometry {
  let scale = dlzScaleMax(zone.rMax, zone.range);
  if (prevScale > 0) {
    const need = Math.max(zone.rMax * 1.15, zone.range * 1.05);
    if (prevScale >= need && need > prevScale * 0.55) scale = prevScale;
  }
  out.scaleMax = scale;
  out.scaleNm = Math.round(scale / NM);
  out.yMin = dlzY(zone.rMin, scale, top, bottom);
  out.yNe = dlzY(Math.max(zone.rMin, zone.rNe), scale, top, bottom);
  out.yMax = dlzY(zone.rMax, scale, top, bottom);
  out.clamped = zone.range > scale;
  out.yRange = dlzY(zone.range, scale, top, bottom);
  out.inRange = zone.range >= zone.rMin && zone.range <= zone.rMax;
  out.inNez = zone.range >= zone.rMin && zone.range <= zone.rNe;
  return out;
}
