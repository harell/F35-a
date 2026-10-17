/**
 * Splitting one city-wide mesh into square tiles (#275), so each tile can be frustum-culled and hidden by distance on
 * its own. The low tier draws the motorway ribbons and the waterfront (port and marinas) this way: one mesh each across
 * the whole city was drawn in full whenever any part of it was on screen.
 *
 * The tiles share the source geometry's vertex attributes (one GPU buffer each) and get their own index: each triangle
 * goes to the tile that holds its centroid. A tile's bounds are its own vertices', so a triangle that crosses a tile
 * edge is culled with the tile it went to.
 */
import { Box3, BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three';

/**
 * The tiles' size (m). With the LANDMARK_FAR cut-off a tile is drawn out to 8–13.7 km; on the low tier's 844 px phone
 * screen a 30 m motorway is under 3 px across there, and seen at a glancing angle under one px tall. Smaller tiles cut
 * more but cost more draw calls: at 4 km, the 15 missions of #275 drew a median of 6 more (62 → 68) on the low tier.
 */
export const CITY_TILE = 4000;

export interface GeometryTile {
  geo: BufferGeometry;
  /** The tile's square: x0 ≤ x < x0 + size, z0 ≤ z < z0 + size (the triangles' centroids). */
  x0: number;
  z0: number;
}

export function splitByTile(geo: BufferGeometry, size: number): GeometryTile[] {
  const pos = geo.getAttribute('position');
  const index = geo.index;
  const n = index ? index.count : pos.count;
  const at = (k: number) => (index ? index.getX(k) : k);
  const tiles = new Map<string, { i: number; j: number; idx: number[] }>();
  for (let k = 0; k + 2 < n; k += 3) {
    const a = at(k);
    const b = at(k + 1);
    const c = at(k + 2);
    const i = Math.floor((pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3 / size);
    const j = Math.floor((pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3 / size);
    const key = `${i}_${j}`;
    let t = tiles.get(key);
    if (!t) tiles.set(key, (t = { i, j, idx: [] }));
    t.idx.push(a, b, c);
  }
  const out: GeometryTile[] = [];
  const v = new Vector3();
  for (const t of tiles.values()) {
    const g = new BufferGeometry();
    for (const name of Object.keys(geo.attributes)) g.setAttribute(name, geo.getAttribute(name));
    g.setIndex(new BufferAttribute(pos.count > 65535 ? new Uint32Array(t.idx) : new Uint16Array(t.idx), 1));
    // (computeBoundingBox/Sphere would read every vertex of the shared attributes, not only the tile's)
    const box = new Box3();
    for (const k of t.idx) box.expandByPoint(v.fromBufferAttribute(pos, k));
    g.boundingBox = box;
    const sphere = new Sphere();
    box.getCenter(sphere.center);
    let r2 = 0;
    for (const k of t.idx) r2 = Math.max(r2, sphere.center.distanceToSquared(v.fromBufferAttribute(pos, k)));
    sphere.radius = Math.sqrt(r2);
    g.boundingSphere = sphere;
    out.push({ geo: g, x0: t.i * size, z0: t.j * size });
  }
  return out;
}
