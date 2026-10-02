/**
 * Polish 5/5 (#61): the road and railway ribbons sit where the rendered terrain is. No railway viaduct
 * over the open sea past the land model in the far north, no raised rail deck over the land at Ōrākei.
 */
import { describe, expect, it } from 'vitest';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { allFeatures } from '../src/world/scenery/Scenery';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';
import { LightList } from '../src/world/scenery/builders';
import { aucklandRailPaths, aucklandRoadPaths, clipRailToLand, RAIL_CAUSEWAY_Y, RoadNetwork } from '../src/world/scenery/motorways';
import { bakeColorRows } from '../src/world/terrain/bake';
import { reduceView } from '../src/world/terrain/parallel';
import { ColorMapSampler, HouseSource } from '../src/world/scenery/sources';
import { LOT_CLEARANCE, LOT_MASK_CELL, LotMask, urbanBounds } from '../src/world/scenery/lotMask';
import { AKL_CBD_GRID } from '../src/world/config';
import { terrainFragmentShader } from '../src/world/terrain/terrainShader';

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

  it('the causeways stand on an embankment of fill (no piers, no gap under the raised track)', () => {
    const B = new GeometryBuilder();
    new RoadNetwork(clipRailToLand(aucklandRailPaths(), height)).buildRibbons(height, B, new LightList(), false);
    const g = B.build()!;
    const pos = g.getAttribute('position');
    // fill near Ōrākei reaches from the sea bed to just under the track
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < pos.count; i++)
      if (Math.hypot(pos.getX(i) - 3751, pos.getZ(i) - 1185) < 600) {
        lo = Math.min(lo, pos.getY(i));
        hi = Math.max(hi, pos.getY(i));
      }
    expect(lo).toBeLessThan(-1);
    expect(hi).toBeCloseTo(RAIL_CAUSEWAY_Y - 0.3, 1);
  });

  it('without the clipping, the far-north line would run over the open sea (the test can fail)', () => {
    const raw = railVertices(false);
    expect(raw.some(([x, , z, g]) => x > -18600 && x < -17300 && z > -44000 && z < -41100 && g < -20)).toBe(true);
  });
});

describe('the suburbs leave a corridor along the road and railway ribbons (#61 items 3 and 8)', () => {
  const m = 512;
  const color = new Uint8Array(m * m * 4);
  bakeColorRows(reduceView(hf, m), { theater: 'auckland', seed: 1840, features }, m, 0, m, color);
  const cmap = new ColorMapSampler(color, m, hf.origin, hf.extent);
  // the game's network: roads plus the clipped railways
  const network = new RoadNetwork([...aucklandRoadPaths(), ...clipRailToLand(aucklandRailPaths(), height)]);
  const urban = urbanBounds(color, m, hf.origin, hf.extent)!;
  const mask = LotMask.fromSegments(network.segments, urban);
  // the playtest's views: Kingsland, Mt Albert (arterials and motorway), Newmarket and the Penrose wye (railways)
  const places: [string, number, number][] = [
    ['Kingsland', -1617, 2700],
    ['Mt Albert', -4126, 3800],
    ['Newmarket', 1500, 2200],
    ['Penrose', 4740, 6880],
  ];

  /** Every house the terrain paints (HouseSource without the scenery's own blocker) around (x, z). */
  function paintedHouses(x: number, z: number, lots: LotMask | null): number[] {
    const src = new HouseSource(hf, cmap, height, AKL_CBD_GRID, null, lots);
    const out = { data: [[], []] as number[][] };
    for (let dz = -600; dz < 600; dz += 300) for (let dx = -600; dx < 600; dx += 300) src.generate(x + dx, z + dz, 300, out);
    return [...out.data[0], ...out.data[1]];
  }
  /** Houses (records of 11) whose footprint reaches onto a ribbon. */
  function onRibbon(recs: number[]): number {
    let n = 0;
    for (let i = 0; i < recs.length; i += 11) if (network.edgeDistance(recs[i], recs[i + 2]) < Math.hypot(recs[i + 4], recs[i + 6]) / 2) n++;
    return n;
  }

  it('covers the built-up area in a compact texture (< 3 MB)', () => {
    expect(urban.x1 - urban.x0).toBeGreaterThan(20_000);
    expect(mask.data.length).toBeLessThan(3 * 1024 * 1024);
    expect(mask.count).toBeGreaterThan(10_000);
    expect(LOT_CLEARANCE).toBeGreaterThan(17 + LOT_MASK_CELL * Math.SQRT1_2);
  });

  it('no painted or 3D house reaches onto a motorway, arterial or railway ribbon', () => {
    for (const [name, x, z] of places) {
      const recs = paintedHouses(x, z, mask);
      expect(recs.length / 11, name).toBeGreaterThan(100);
      expect(onRibbon(recs), name).toBe(0);
    }
  });

  it('without the corridor, houses stood on the ribbons there (the test can fail)', () => {
    for (const [name, x, z] of places) expect(onRibbon(paintedHouses(x, z, null)), name).toBeGreaterThan(0);
  });

  it('the shader only fetches the mask where a lot can still show (below 40 m/px)', () => {
    expect(terrainFragmentShader).toContain('if (built > 0.0 && mpp < 40.0) built *= 1.0 - lotMasked(');
    // past 40 m/px the urban colour is the far average alone, which does not read `built`
    expect(terrainFragmentShader).toContain('mix(mix(mid, far, 0.4), far, smoothstep(16.0, 40.0, mpp))');
  });

  it('the shader decodes the same bits (a port of lotMasked() in terrainShader.ts)', () => {
    const f = Math.fround;
    const glsl = (x: number, z: number): boolean => {
      const gx = Math.floor(f(f(x - mask.x0) / mask.cell));
      const gz = Math.floor(f(f(z - mask.z0) / mask.cell));
      const tx = Math.floor(gx / 8);
      const tz = Math.floor(gz / 4);
      if (tx < 0 || tz < 0 || tx >= mask.texW || tz >= mask.texH) return false;
      const k = (tz * mask.texW + tx) * 4;
      const v = [0, 1, 2, 3].map((c) => mask.data[k + c]);
      const byte = v[gz - tz * 4];
      return Math.floor(byte / 2 ** (gx - tx * 8)) % 2 === 1;
    };
    let set = 0;
    for (let i = 0; i < 20_000; i++) {
      const x = urban.x0 - 500 + ((i * 7919) % 997) / 997 * (urban.x1 - urban.x0 + 1000);
      const z = urban.z0 - 500 + ((i * 104729) % 991) / 991 * (urban.z1 - urban.z0 + 1000);
      expect(glsl(x, z)).toBe(mask.masked(x, z));
      if (mask.masked(x, z)) set++;
    }
    // and along a ribbon every point is in the corridor
    const s = network.segments;
    for (let o = 0; o < s.length; o += 5 * 97) {
      const x = (s[o] + s[o + 2]) / 2;
      const z = (s[o + 1] + s[o + 3]) / 2;
      if (x > urban.x0 && x < urban.x1 && z > urban.z0 && z < urban.z1) expect(mask.masked(x, z)).toBe(true);
    }
    expect(set).toBeGreaterThan(0);
  });
});
