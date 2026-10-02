/**
 * Polish 5/5 (#61): the road and railway ribbons sit where the rendered terrain is. No railway viaduct
 * over the open sea past the land model in the far north, no raised rail deck over the land at Ōrākei.
 */
import { describe, expect, it } from 'vitest';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { allFeatures } from '../src/world/scenery/Scenery';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';
import { LightList } from '../src/world/scenery/builders';
import { aucklandRailPaths, clipRailToLand, RAIL_CAUSEWAY_Y, RoadNetwork } from '../src/world/scenery/motorways';

// the medium tier's terrain (1024², the tier the playtest found both glitches on)
const features = allFeatures('auckland', []);
const hf = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 1024, features, pads: [] }));
const height = (x: number, z: number) => hf.meshHeightAt(x, z);

/** Every rail ribbon vertex as [x, y, z, rendered ground]. */
function railVertices(clip: boolean): [number, number, number, number][] {
  const paths = clip ? clipRailToLand(aucklandRailPaths(), height) : aucklandRailPaths();
  const g = new RoadNetwork(paths).buildRibbons(height, new GeometryBuilder(), new LightList(), false);
  const pos = g.getAttribute('position');
  const out: [number, number, number, number][] = [];
  for (let i = 0; i < pos.count; i++) out.push([pos.getX(i), pos.getY(i), pos.getZ(i), height(pos.getX(i), pos.getZ(i))]);
  return out;
}

describe('railway ribbons follow the rendered terrain (#61)', () => {
  const clipped = railVertices(true);

  it('no rail vertex more than 15 m above the rendered terrain (no known rail bridge is that high)', () => {
    expect(clipped.length).toBeGreaterThan(5000);
    let worst = 0;
    for (const [, y, , g] of clipped) worst = Math.max(worst, y - g);
    expect(worst).toBeLessThan(15);
  });

  it('railways lie on the ground or on a low causeway just above the water, never on a raised deck', () => {
    for (const [x, y, z, g] of clipped) {
      const top = Math.max(g + 0.45, RAIL_CAUSEWAY_Y);
      if (Math.abs(y - top) > 0.01) expect.fail(`rail vertex at (${x.toFixed(0)}, ${z.toFixed(0)}) is ${(y - g).toFixed(1)} m above the ground`);
    }
  });

  it('the far north: no rail over the open sea past the land model (x −18487…−17369, z −43996…−41122)', () => {
    const inBox = ([x, , z]: [number, number, number, number]) => x > -18600 && x < -17300 && z > -44000 && z < -41100;
    expect(clipped.filter(inBox).filter(([, , , g]) => g < -4)).toHaveLength(0);
    // the line still runs on the land south of there
    expect(clipped.some(([x, , z, g]) => x > -19000 && x < -16000 && z > -41000 && z < -36000 && g > 1)).toBe(true);
  });

  it('Ōrākei: the Eastern Line keeps its Hobson Bay causeway, at most a couple of metres above the ground', () => {
    const near = clipped.filter(([x, , z]) => Math.hypot(x - 3751, z - 1185) < 250);
    expect(near.length).toBeGreaterThan(10);
    for (const [, y, , g] of near) expect(y - Math.max(g, 0)).toBeLessThan(2);
  });

  it('without the clipping, the far-north line would run over the open sea (the test can fail)', () => {
    const raw = railVertices(false);
    expect(raw.some(([x, , z, g]) => x > -18600 && x < -17300 && z > -44000 && z < -41100 && g < -20)).toBe(true);
  });
});
