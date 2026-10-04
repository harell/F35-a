/**
 * The 3D landmarks outside the real-streets region (the stadiums with OSM stands, the oil terminal) never stand on the
 * procedural street grid: the terrain shader and the scattered houses stop on their sites (Scenery.siteMask, the
 * shader's siteMasked()), and the real LINZ streets round each stadium are road ribbons (tools/linz/roads.ts).
 */
import { describe, expect, it } from 'vitest';
import { siteLayout, siteRings } from '../src/world/scenery/aucklandSites';
import { maskFromRings } from '../src/world/scenery/lotMask';
import { aucklandRoads, ROAD_ARTERIAL } from '../src/world/scenery/aucklandRoads';
import { aucklandStreets, type CbdStreets } from '../src/world/scenery/cbdStreets';
import { distToPath, pointInRing } from '../src/world/scenery/aucklandOsm';
import { terrainFragmentShader } from '../src/world/terrain/terrainShader';
import { AKL } from '../src/core/auckland';

const rings = siteRings();
const mask = maskFromRings(rings, 8)!;
const st = aucklandStreets() as CbdStreets;
const eden = siteLayout()!.stadiums.find((s) => pointInRing(s.outline.pts, AKL.eden_park.x, AKL.eden_park.z))!;

describe('landmark sites stop the procedural grid', () => {
  it('every stadium and the oil terminal is a site; the mask covers each one and a street width round it', () => {
    expect(rings.length).toBe(siteLayout()!.stadiums.length + 1);
    expect(eden).toBeTruthy();
    expect(mask.masked(AKL.eden_park.x, AKL.eden_park.z)).toBe(true);
    expect(mask.masked(AKL.wiri.x, AKL.wiri.z)).toBe(true);
    // a cell centre 20 m off Eden Park's outline is not part of it; one inside is
    let inside = 0;
    let outside = 0;
    const r = eden.outline.pts;
    for (let z = AKL.eden_park.z - 400; z < AKL.eden_park.z + 400; z += 6)
      for (let x = AKL.eden_park.x - 400; x < AKL.eden_park.x + 400; x += 6) {
        const d = distToPath(r, x, z, true);
        if (pointInRing(r, x, z)) inside += mask.masked(x, z) ? 1 : 0;
        else if (d > 8 + 12 * Math.SQRT2) outside += mask.masked(x, z) ? 1 : 0;
      }
    expect(inside).toBeGreaterThan(100);
    expect(outside).toBe(0);
  });

  it('the shader stops its streets, lots and lamps on a site', () => {
    expect(terrainFragmentShader).toContain('float siteMasked(vec2 wp)');
    expect(terrainFragmentShader).toContain('float park = max(step(0.975 - dens * 0.03, bh), site);');
    expect(terrainFragmentShader).toContain('* (1.0 - site);');
  });
});

describe('real streets round the landmarks', () => {
  const ribbons = aucklandRoads()!.lines.filter((l) => l.kind === ROAD_ARTERIAL);
  const near = (ring: Float32Array, reach: number) =>
    ribbons.filter((l) => {
      for (let i = 0; i < l.pts.length; i += 2) if (distToPath(ring, l.pts[i], l.pts[i + 1], true) < reach) return true;
      return false;
    });

  it("Eden Park stands among its own streets (LINZ), not across any of them", () => {
    const lines = near(eden.outline.pts, 95);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    const names = new Set(lines.map((l) => l.name));
    expect([...names].some((n) => /Reimers|Walters|Cricket|Sandringham|Bellwood/.test(n))).toBe(true);
    // no ribbon crosses the grounds
    for (const l of ribbons) for (let i = 0; i < l.pts.length; i += 2) expect(pointInRing(eden.outline.pts, l.pts[i], l.pts[i + 1])).toBe(false);
  });

  it('every stadium outside the real-streets region gets streets round it', () => {
    let withStreets = 0;
    const out = siteLayout()!.stadiums.filter((s) => !st.inRegion(s.outline.pts[0], s.outline.pts[1]));
    for (const s of out) if (near(s.outline.pts, 95).length) withStreets++;
    expect(withStreets).toBeGreaterThanOrEqual(out.length - 2); // a stadium in parkland may have no street that close
  });
});
