/**
 * The CBD tower kit (issue #156; core/cbdTowers.ts, generated data core/cbdTowersData.ts, aucklandBuildings.ts
 * applyHeroBuildings, auckland.ts buildLinzCBD): every modelled tower replaces its LINZ blocks, stands at the LiDAR
 * heights (spot checks the recipe sampled independently of the terrace medians), and the sim collides with it.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { CBD_TOWERS } from '../src/core/cbdTowersData';
import { spirePrisms } from '../src/core/cbdTowers';
import { BuildingIndex, buildBuildingGeometry, SKYSCRAPER_MIN_HEIGHT } from '../src/sim/buildings';
import { aucklandBuildings, ringArea, roofHeight, type Building } from '../src/world/scenery/aucklandBuildings';

const inRing = (r: ArrayLike<number>, x: number, z: number) => {
  let c = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
};

/** Roof of a building at (x, z): the highest prism over the point (m above its ground), −∞ outside. */
const roofAt = (b: Building, x: number, z: number) => Math.max(-Infinity, ...b.prisms.filter((p) => inRing(p.ring, x, z)).map((p) => roofHeight(p, x, z)));

describe('CBD tower kit (measured)', () => {
  const bs = aucklandBuildings()!;
  const heroes = bs.filter((b) => b.hero === 'tower');

  it('one hero building per modelled tower, rows of #156 once each, every part wound one way', () => {
    expect(CBD_TOWERS.length).toBeGreaterThanOrEqual(60);
    expect(heroes).toHaveLength(CBD_TOWERS.length);
    expect(new Set(CBD_TOWERS.map((t) => t.n)).size).toBe(CBD_TOWERS.length);
    for (const b of heroes) for (const p of b.prisms) expect(ringArea(p.ring)).toBeGreaterThan(0);
  });

  it('replace their LINZ blocks: no LINZ building centred inside a tower outline, no tower inside another', () => {
    for (const b of bs) {
      if (b.hero) continue;
      for (const t of CBD_TOWERS) expect(inRing(t.outline, b.prisms[0].cx, b.prisms[0].cz)).toBe(false);
    }
    // nor an old block left standing over a tower (a concave LINZ footprint's centre falls outside it)
    for (const b of bs) {
      if (b.hero) continue;
      for (const t of CBD_TOWERS) for (const [x, z] of t.spots) expect(b.prisms.some((p) => inRing(p.ring, x, z)), t.name).toBe(false);
    }
    for (const t of CBD_TOWERS) for (const u of CBD_TOWERS) if (t !== u) {
      const p = heroes.find((b) => b.tower === u)!.prisms[0];
      expect(inRing(t.outline, p.cx, p.cz)).toBe(false);
    }
  });

  it('stand at the LiDAR heights: every spot check within ±2 m', () => {
    let spots = 0;
    for (const t of CBD_TOWERS) {
      const b = heroes.find((h) => h.tower === t)!;
      expect(t.spots.length, t.name).toBeGreaterThan(0);
      for (const [x, z, h] of t.spots) {
        expect(Math.abs(roofAt(b, x, z) - h), `${t.name} at ${x}, ${z}`).toBeLessThan(2);
        spots++;
      }
      const top = Math.max(...t.parts.filter((p) => p.kind !== 'spire' && p.kind !== 'plant').map((p) => p.h));
      if (t.tier !== 'L') expect(top).toBeGreaterThan(40); // the landmarks (tier L) can be lower
    }
    expect(spots).toBeGreaterThanOrEqual(CBD_TOWERS.length * 1.5);
  });

  it('spires taper to their measured tip', () => {
    for (const t of CBD_TOWERS)
      for (const p of t.parts)
        if (p.kind === 'spire') {
          const s = spirePrisms(p);
          expect(s[s.length - 1].h).toBeCloseTo(p.h, 5);
          expect(s[0].h).toBeGreaterThan(p.base);
        }
  });

  it('the sim collides with each tower at its spot checks and flies clear over them', () => {
    // (the sim's prisms are flat at the part's height: a sloped part's roof is its centroid's)
    const geo = buildBuildingGeometry(() => 10)!;
    const idx = new BuildingIndex(geo);
    for (const t of CBD_TOWERS) {
      const [x, z, h] = t.spots[0];
      const b = heroes.find((u) => u.tower === t)!;
      // the sim collides with buildings of SKYSCRAPER_MIN_HEIGHT and up, kit or not (a 30 m landmark is flown over)
      if (Math.max(...b.prisms.map((p) => p.h)) < SKYSCRAPER_MIN_HEIGHT) continue;
      const roof = Math.max(...b.prisms.filter((p) => inRing(p.ring, x, z)).map((p) => p.h));
      expect(idx.firstHit(new Vector3(x, 10 + h + 30, z), new Vector3(x, 10 + h - 3, z)), t.name).not.toBeNull();
      expect(idx.firstHit(new Vector3(x, 10 + roof + 30, z), new Vector3(x, 10 + roof + 2, z)), t.name).toBeNull();
    }
  });
});
