/**
 * Seats a small animal (g03's stoat, t07's rats) on the ground as it is drawn. The sim stands it on the
 * heightfield's bilinear surface (TerrainQuery.heightAt), but the terrain is drawn as triangles between
 * the heightfield's posts (86 m apart on the 1024² Auckland field), up to about a metre off that surface
 * on a slope or a crest: t07's Wallace Street rat started 0.73 m under the drawn street. A 20 cm rat
 * there vanished, and the pod, aimed into the ground, showed a wall of terrain sliding past as the error
 * changed along its run. The entity visual and the pod's aim both take this lift (render only).
 */
import type { TerrainQuery } from '../../sim/api';
import { isPodAnimal } from '../../core/pod';

/** The parts of a ground entity the seat needs. */
export interface Seated {
  readonly kind: string;
  readonly radius: number;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  /** On a roof (sim/entities.ts GroundTargetEntity.roofOf, -1 = none): already on what is drawn. */
  readonly roofOf?: number;
}

/**
 * How far (m) to lift `e`'s visual so it stands on the drawn ground: the drawn mesh minus the sim's surface
 * for a small animal on land standing on the terrain, 0 for anything else (a vehicle, a roof rat, a
 * swimming stoat).
 */
export function seatLift(terrain: TerrainQuery, e: Seated): number {
  if (e.kind !== 'ground' || !isPodAnimal(e.radius) || (e.roofOf ?? -1) >= 0 || !terrain.meshHeightAt) return 0;
  const { x, y, z } = e.position;
  const h = terrain.heightAt(x, z);
  if (h <= 0 || Math.abs(y - h) > 0.05) return 0;
  return terrain.meshHeightAt(x, z) - h;
}
