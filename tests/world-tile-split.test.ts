/**
 * The low tier's motorway and waterfront meshes split into tiles (#275, tileSplit.ts): every triangle in exactly one
 * tile, the vertex attributes shared, and each tile's bounds tight around its own triangles.
 */
import { describe, expect, it } from 'vitest';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';
import { LightList } from '../src/world/scenery/builders';
import { aucklandRoadPaths, RoadNetwork } from '../src/world/scenery/motorways';
import { CITY_TILE, splitByTile } from '../src/world/scenery/tileSplit';

const height = (x: number, z: number) => 20 + 5 * Math.sin(x / 300) * Math.cos(z / 400);
const roads = new RoadNetwork(aucklandRoadPaths());
const geo = roads.buildRibbons(height, new GeometryBuilder(), new LightList(), false, (p) => p.kind !== 'rail' && p.kind !== 'local', { flat: true });

describe('splitting a city-wide mesh into tiles (#275)', () => {
  const tiles = splitByTile(geo, CITY_TILE);

  it('puts every triangle in exactly one tile, the one holding its centroid', () => {
    expect(tiles.length).toBeGreaterThan(8);
    const tris = (idx: ArrayLike<number>) => {
      const s: string[] = [];
      for (let k = 0; k < idx.length; k += 3) s.push(`${idx[k]},${idx[k + 1]},${idx[k + 2]}`);
      return s;
    };
    const all = tiles.flatMap((t) => tris(t.geo.index!.array));
    expect(all.length * 3).toBe(geo.index!.count);
    expect(all.sort()).toEqual(tris(geo.index!.array).sort());
    const pos = geo.getAttribute('position');
    for (const t of tiles) {
      const idx = t.geo.index!.array;
      for (let k = 0; k < idx.length; k += 3 * 31) {
        const cx = (pos.getX(idx[k]) + pos.getX(idx[k + 1]) + pos.getX(idx[k + 2])) / 3;
        const cz = (pos.getZ(idx[k]) + pos.getZ(idx[k + 1]) + pos.getZ(idx[k + 2])) / 3;
        expect(cx).toBeGreaterThanOrEqual(t.x0);
        expect(cx).toBeLessThan(t.x0 + CITY_TILE);
        expect(cz).toBeGreaterThanOrEqual(t.z0);
        expect(cz).toBeLessThan(t.z0 + CITY_TILE);
      }
    }
  });

  it('shares the vertex attributes (one buffer) and bounds each tile by its own triangles', () => {
    const pos = geo.getAttribute('position');
    for (const t of tiles) {
      for (const name of Object.keys(geo.attributes)) expect(t.geo.getAttribute(name)).toBe(geo.getAttribute(name));
      const s = t.geo.boundingSphere!;
      // a tile's triangles stay near its square (ribbon segments are ≤ 30 m), so its sphere is not the city's
      expect(s.radius).toBeLessThan(CITY_TILE);
      const idx = t.geo.index!.array;
      for (let k = 0; k < idx.length; k += 17) {
        const d = Math.hypot(pos.getX(idx[k]) - s.center.x, pos.getY(idx[k]) - s.center.y, pos.getZ(idx[k]) - s.center.z);
        expect(d).toBeLessThanOrEqual(s.radius + 1e-3);
      }
    }
  });
});
