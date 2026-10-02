/**
 * Polish 5/5 (#61 item 4): the Wiri oil terminal stands on a concrete hardstand inside a bund wall,
 * not in the terrain's procedural housing grid.
 */
import { describe, expect, it } from 'vitest';
import { WIRI_TANKS } from '../src/core/sites';
import { buildWiriTerminal, siteLayout, wiriBund, wiriHardstand } from '../src/world/scenery/aucklandSites';
import { pointInRing } from '../src/world/scenery/aucklandOsm';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';
import { DecalBuilder, LightList } from '../src/world/scenery/builders';

const flat = () => 20;

/** True when (x, z) lies on one of the geometry's triangles (seen from above). */
function covered(pos: ArrayLike<number>, idx: ArrayLike<number> | null, x: number, z: number): boolean {
  const n = idx ? idx.length : pos.length / 3;
  const v = (k: number) => (idx ? idx[k] : k) * 3;
  for (let t = 0; t + 2 < n; t += 3) {
    const a = v(t);
    const b = v(t + 1);
    const c = v(t + 2);
    const d1 = (x - pos[b]) * (pos[a + 2] - pos[b + 2]) - (pos[a] - pos[b]) * (z - pos[b + 2]);
    const d2 = (x - pos[c]) * (pos[b + 2] - pos[c + 2]) - (pos[b] - pos[c]) * (z - pos[c + 2]);
    const d3 = (x - pos[a]) * (pos[c + 2] - pos[a + 2]) - (pos[c] - pos[a]) * (z - pos[a + 2]);
    if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) return true;
  }
  return false;
}

describe('the Wiri oil terminal (#61)', () => {
  for (const [name, layout] of [['OSM depot outline', siteLayout()], ['no OSM data', null]] as const) {
    it(`every tank stands on the concrete hardstand (${name})`, () => {
      const ring = wiriHardstand(layout);
      for (const t of WIRI_TANKS)
        for (let a = 0; a < 8; a++) expect(pointInRing(ring, t.x + Math.cos(a) * t.r, t.z + Math.sin(a) * t.r)).toBe(true);
      const pad = new DecalBuilder();
      buildWiriTerminal(new GeometryBuilder(), new LightList(), flat, layout, pad);
      const g = pad.build()!;
      expect(g).not.toBeNull();
      const pos = g.getAttribute('position').array;
      const idx = g.getIndex()?.array ?? null;
      for (const t of WIRI_TANKS) expect(covered(pos, idx, t.x, t.z)).toBe(true);
    });
  }

  it('a bund wall rings the fuel tanks, inside the hardstand', () => {
    const [x0, z0, x1, z1] = wiriBund();
    for (const t of WIRI_TANKS.filter((tk) => tk.fuel)) {
      expect(t.x - t.r - x0).toBeGreaterThanOrEqual(4);
      expect(x1 - t.x - t.r).toBeGreaterThanOrEqual(4);
      expect(t.z - t.r - z0).toBeGreaterThanOrEqual(4);
      expect(z1 - t.z - t.r).toBeGreaterThanOrEqual(4);
    }
    const ring = wiriHardstand(siteLayout());
    for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) expect(pointInRing(ring, x, z)).toBe(true);
  });
});
