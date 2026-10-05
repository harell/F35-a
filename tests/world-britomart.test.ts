/**
 * Britomart (Waitematā) station, the hero (core/britomart.ts): the Glasshouse replaces its LINZ block at its LiDAR roof,
 * the CPO's domes stand on its corner pavilions, the skylight cones stand in the open square, and the scenery builds
 * all of it in the CBD's merged mesh.
 */
import { describe, expect, it } from 'vitest';
import { CPO_DOMES, CPO_FLAGPOLE, CPO_ROW, GLASSHOUSE, GLASSHOUSE_ROW, TAKUTAI_CONES } from '../src/core/britomart';
import { towerSkin } from '../src/core/cbdTowerSkins';
import { aucklandBuildings, KIT_TOWERS } from '../src/world/scenery/aucklandBuildings';
import { buildCpoCrowns, buildGlasshouseCanopy, buildTakutaiCones } from '../src/world/scenery/britomart';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';

const inRing = (r: ArrayLike<number>, x: number, z: number) => {
  let c = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
};

describe('Britomart station (hero)', () => {
  const bs = aucklandBuildings()!;
  const cpo = KIT_TOWERS.find((t) => t.n === CPO_ROW)!;

  it('the Glasshouse is a kit landmark that replaced its LINZ block, at its LiDAR roof', () => {
    const b = bs.find((u) => u.tower === GLASSHOUSE)!;
    expect(b).toBeDefined();
    const [x, z] = GLASSHOUSE.replaces[0];
    expect(bs.filter((u) => !u.hero && u.prisms[0] && inRing(u.prisms[0].ring, x, z))).toEqual([]);
    for (const [, , h] of GLASSHOUSE.spots) expect(Math.abs(b.prisms[0].h - h)).toBeLessThan(1);
    // it stands beside the CPO, not inside it
    expect(inRing(cpo.outline, x, z)).toBe(false);
  });

  it('the CPO has its stone skin and the Glasshouse its sign on the east face', () => {
    expect(towerSkin(CPO_ROW)!.zones.some((z) => z.finish === 'stone')).toBe(true);
    const s = towerSkin(GLASSHOUSE_ROW)!.signs!;
    expect(s.map((g) => g.logo)).toEqual(['waitemata']);
    expect(s[0].face).toBe(107);
  });

  it('the domes and the flagpole stand on the CPO, the domes on its crown terraces', () => {
    for (const d of CPO_DOMES) {
      expect(inRing(cpo.outline, d.x, d.z)).toBe(true);
      const crowns = cpo.parts.filter((p) => p.kind === 'crown' && 'ring' in p && inRing(p.ring, d.x, d.z));
      expect(crowns.length).toBeGreaterThan(0);
      for (const c of crowns) expect(c.h).toBeGreaterThan(d.base - 1);
      expect(Math.abs(d.top - d.base - d.r)).toBeLessThan(0.5);
    }
    expect(inRing(cpo.outline, CPO_FLAGPOLE.x, CPO_FLAGPOLE.z)).toBe(true);
  });

  it('the cones stand in the open, outside every building', () => {
    for (const [x, z] of TAKUTAI_CONES) expect(bs.some((b) => b.prisms.some((p) => inRing(p.ring, x, z))), `${x}, ${z}`).toBe(false);
  });

  it('builds its geometry', () => {
    const B = new GeometryBuilder();
    buildCpoCrowns(B, 3, 1);
    buildGlasshouseCanopy(B, 3);
    buildTakutaiCones(B, () => 3, 1);
    expect(B.triangleCount).toBeGreaterThan(200);
    expect(B.triangleCount).toBeLessThan(2000);
  });
});
