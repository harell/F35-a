/**
 * The low tier's road and railway ribbons (#275): two vertices across, with no crown vertex down the middle. Half the
 * triangles of the 870 km of LINZ motorways, arterials and railways, with the same edges and texture span.
 */
import { describe, expect, it } from 'vitest';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';
import { LightList } from '../src/world/scenery/builders';
import { aucklandRailPaths, aucklandRoadPaths, RoadNetwork } from '../src/world/scenery/motorways';

const height = (x: number, z: number) => 20 + 5 * Math.sin(x / 300) * Math.cos(z / 400);
const roads = new RoadNetwork([...aucklandRoadPaths(), ...aucklandRailPaths()]);
const build = (flat: boolean, only: Parameters<RoadNetwork['buildRibbons']>[4]) => roads.buildRibbons(height, new GeometryBuilder(), new LightList(), false, only, { flat });

describe('flat ribbons on the low tier (#275)', () => {
  for (const [name, only] of [
    ['motorways and arterials', (p: { kind: string }) => p.kind !== 'rail' && p.kind !== 'local'],
    ['railways', (p: { kind: string }) => p.kind === 'rail'],
  ] as const) {
    it(`${name}: half the triangles, the same edges and texture span`, () => {
      const full = build(false, only);
      const flat = build(true, only);
      expect(full.index!.count).toBeGreaterThan(10_000);
      expect(flat.index!.count * 2).toBe(full.index!.count);
      const fp = full.getAttribute('position');
      const lp = flat.getAttribute('position');
      const fu = full.getAttribute('uv');
      const lu = flat.getAttribute('uv');
      expect(lp.count * 3).toBe(fp.count * 2);
      // vertex k of a flat cross-section is vertex 2k of the crowned one: the same edge, the same u
      for (let i = 0; i < lp.count; i += 97) {
        const j = (i >> 1) * 3 + (i & 1) * 2;
        expect(lp.getX(i)).toBeCloseTo(fp.getX(j), 3);
        expect(lp.getY(i)).toBeCloseTo(fp.getY(j), 3);
        expect(lp.getZ(i)).toBeCloseTo(fp.getZ(j), 3);
        expect(lu.getX(i)).toBeCloseTo(fu.getX(j), 5);
        expect(lu.getY(i)).toBeCloseTo(fu.getY(j), 5);
      }
    });
  }

  it('local roads were already two across: flat changes nothing', () => {
    const only = (p: { kind: string }) => p.kind === 'local';
    expect(build(true, only).index!.count).toBe(build(false, only).index!.count);
  });
});
