/**
 * F35-A — cheap terrain line-of-sight for sensors.
 *
 * terrain.lineOfSight() marches the ray, which is costly over 60 km. When both ends are above
 * the highest terrain in the world (sampled once per terrain on a coarse grid, plus margin),
 * the ray can't be blocked and we skip the march.
 */
import type { Vector3 } from 'three';
import type { TerrainQuery } from '../api';

const maxHeights = new WeakMap<TerrainQuery, number>();
const MARGIN = 250;

/** Highest terrain elevation (m, conservative). */
export function terrainCeiling(terrain: TerrainQuery): number {
  let h = maxHeights.get(terrain);
  if (h === undefined) {
    h = 0;
    const n = 64;
    const size = terrain.size || 80_000;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        const x = (i / n - 0.5) * size;
        const z = (j / n - 0.5) * size;
        const y = terrain.heightAt(x, z);
        if (y > h) h = y;
      }
    }
    h += MARGIN;
    maxHeights.set(terrain, h);
  }
  return h;
}

/** Terrain doesn't block the line a→b. */
export function lineOfSight(terrain: TerrainQuery, a: Vector3, b: Vector3): boolean {
  const top = terrainCeiling(terrain);
  if (a.y > top && b.y > top) return true;
  return terrain.lineOfSight(a, b);
}
