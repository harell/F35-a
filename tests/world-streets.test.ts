/**
 * LINZ phase 2a: the Auckland CBD on its real streets (LINZ road centrelines), real motorways and
 * arterials, and the hand-over to the procedural suburbs (issue #1).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { allFeatures } from '../src/world/scenery/Scenery';
import { bakeColorRows } from '../src/world/terrain/bake';
import { reduceView } from '../src/world/terrain/parallel';
import { createVegetation } from '../src/world/terrain/vegetation';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';
import { LightList } from '../src/world/scenery/builders';
import { buildCBD, buildCentres, type Footprint } from '../src/world/scenery/auckland';
import { aucklandRoadPaths, RoadNetwork } from '../src/world/scenery/motorways';
import { ColorMapSampler, HouseSource, onStreet, TreeSource } from '../src/world/scenery/sources';
import { aucklandRoads, decodeRoads, encodeRoads, ROAD_ARTERIAL, ROAD_MOTORWAY, ROAD_STREET, setAucklandRoads } from '../src/world/scenery/aucklandRoads';
import { aucklandStreets, CBD_PARKS, FOOTPATH, type CbdStreets } from '../src/world/scenery/cbdStreets';
import { districtAt, ROAD_HALF, type District } from '../src/world/scenery/urbanGrid';
import { AKL_CBD_GRID, aucklandCbd, terrainStyle } from '../src/world/config';
import { streetUniforms } from '../src/world/terrain/TerrainRenderer';
import { terrainFragmentShader } from '../src/world/terrain/terrainShader';
import { aucklandLinz, linzIsLand } from '../src/world/terrain/theaters/aucklandLinz';
import { AKL } from '../src/core/auckland';
import { ROADS_BYTES, ROADS_GZ } from './linz-setup';

const st = aucklandStreets() as CbdStreets;
const cbd = aucklandCbd();
const roads = new RoadNetwork(aucklandRoadPaths());
const linz = aucklandLinz()!;
const scratch = {} as District;

/** Points along the region border every `step` m. */
function borderSamples(step: number): { x: number; z: number; nx: number; nz: number }[] {
  const g = st.region;
  const n = g.length / 2;
  const out: { x: number; z: number; nx: number; nz: number }[] = [];
  for (let i = 0; i < n; i++) {
    const ax = g[i * 2];
    const az = g[i * 2 + 1];
    const bx = g[((i + 1) % n) * 2];
    const bz = g[((i + 1) % n) * 2 + 1];
    const len = Math.hypot(bx - ax, bz - az);
    for (let s = 0; s < len; s += step) out.push({ x: ax + ((bx - ax) * s) / len, z: az + ((bz - az) * s) / len, nx: -(bz - az) / len, nz: (bx - ax) / len });
  }
  return out;
}

/** Points covering a footprint every ≤ 2 m (edges included). */
function footprintPoints(f: Footprint): [number, number][] {
  const c = Math.cos(f.angle);
  const s = Math.sin(f.angle);
  const na = Math.max(1, Math.ceil(f.w / 2));
  const nb = Math.max(1, Math.ceil(f.d / 2));
  const out: [number, number][] = [];
  for (let a = 0; a <= na; a++)
    for (let b = 0; b <= nb; b++) {
      const u = (a / na - 0.5) * f.w;
      const v = (b / nb - 0.5) * f.d;
      out.push([f.x + c * u - s * v, f.z + s * u + c * v]);
    }
  return out;
}

const lineLength = (p: Float32Array) => {
  let l = 0;
  for (let i = 2; i < p.length; i += 2) l += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return l;
};

describe('LINZ road data (auckland-roads.bin)', () => {
  it('is small enough for phones (< 100 kB gzip) and round-trips through the encoder', () => {
    expect(ROADS_GZ.length).toBeLessThan(100 * 1024);
    const d = decodeRoads(ROADS_BYTES);
    expect(encodeRoads(d, 0.5)).toEqual(ROADS_BYTES);
    expect(() => decodeRoads(ROADS_BYTES.subarray(0, ROADS_BYTES.length - 3))).toThrow();
  });

  it('holds the CBD streets, the motorway carriageways of the theatre and the main arterials', () => {
    const d = aucklandRoads()!;
    const of = (k: number) => d.lines.filter((l) => l.kind === k);
    const km = (k: number) => of(k).reduce((s, l) => s + lineLength(l.pts), 0) / 1000;
    expect(of(ROAD_STREET).length).toBeGreaterThan(300);
    expect(km(ROAD_STREET)).toBeGreaterThan(35);
    expect(km(ROAD_MOTORWAY)).toBeGreaterThan(250); // one line per carriageway / ramp
    expect(km(ROAD_ARTERIAL)).toBeGreaterThan(35);
    const names = new Set(d.lines.map((l) => l.name));
    for (const n of ['Queen Street', 'Karangahape Road', 'Customs Street East', 'Symonds Street', 'Albert Street', 'Quay Street', 'Fanshawe Street']) expect(names).toContain(n);
    for (const n of ['Dominion Rd', 'Great North Rd', 'Lake Rd', 'Onewa Rd']) expect(names).toContain(n);
  });
});

describe('CBD region (real streets instead of the procedural grid)', () => {
  it('covers the city centre and the waterfront, not the suburbs or the port around it', () => {
    for (const id of ['skytower', 'cbd', 'britomart', 'viaduct', 'wynyard']) expect(st.inRegion(AKL[id].x, AKL[id].z), id).toBe(true);
    for (const id of ['ponsonby', 'parnell', 'newmarket', 'domain', 'port', 'bridge_s']) expect(st.inRegion(AKL[id].x, AKL[id].z), id).toBe(false);
    // the shader's region test agrees with the polygon away from its border
    for (const id of ['skytower', 'britomart', 'ponsonby', 'parnell']) expect(st.regionSD(AKL[id].x, AKL[id].z) > 0).toBe(st.inRegion(AKL[id].x, AKL[id].z));
  });

  it('its border runs under a motorway, along a real street or over water: no seam across a block', () => {
    let water = 0;
    let motorway = 0;
    let street = 0;
    let other = 0;
    for (const p of borderSamples(5)) {
      if (!linzIsLand(linz, p.x, p.z)) water += 5;
      else if (roads.edgeDistance(p.x, p.z) < 1) motorway += 5; // under a carriageway ribbon
      else if (st.kerbDistance(p.x, p.z) < 0) street += 5; // on a real street
      else other += 5;
    }
    expect(motorway).toBeGreaterThan(3000); // SH1 / SH16 round the west, south and east
    expect(street).toBeGreaterThan(600); // Stanley St, Beach Rd, Quay St
    expect(water).toBeGreaterThan(2000);
    // only the short crossings at Westhaven Dr and the root of the port's wharf
    expect(other).toBeLessThan(300);
  });

  it('just outside the border the procedural grid ends on a street (no half blocks against the CBD)', () => {
    let n = 0;
    for (const p of borderSamples(25)) {
      // 2 m outside (the polygon is counter-clockwise on the map: −normal points out)
      for (const sgn of [1, -1]) {
        const x = p.x + p.nx * 2 * sgn;
        const z = p.z + p.nz * 2 * sgn;
        if (st.inRegion(x, z) || st.regionSD(x, z) > -1) continue;
        const d = districtAt(x, z, undefined, scratch, cbd);
        expect(d.real).toBe(false);
        expect(d.border).toBeLessThan(ROAD_HALF);
        expect(onStreet(x, z, cbd, scratch)).toBe(true);
        n++;
      }
    }
    expect(n).toBeGreaterThan(200);
  });

  it('inside, there is no procedural grid: districts are "real" and onStreet follows the real streets', () => {
    let n = 0;
    for (let z = st.bounds.minZ; z < st.bounds.maxZ; z += 37)
      for (let x = st.bounds.minX; x < st.bounds.maxX; x += 37) {
        if (st.regionSD(x, z) < 1) continue;
        n++;
        expect(districtAt(x, z, undefined, scratch, cbd).real).toBe(true);
        expect(onStreet(x, z, cbd, scratch)).toBe(st.streetSD(x, z) < 2);
      }
    expect(n).toBeGreaterThan(1500);
  });
});

describe('CBD streets painted by the terrain shader', () => {
  it('match the LINZ centrelines: the shader lookup (4 m texels) vs the exact vectors', () => {
    let n = 0;
    let off = 0;
    let wrongSide = 0;
    for (let z = st.bounds.minZ; z < st.bounds.maxZ; z += 3.7)
      for (let x = st.bounds.minX; x < st.bounds.maxX; x += 3.3) {
        if (!st.inRegion(x, z)) continue;
        const exact = st.kerbDistance(x, z);
        // kerbs and footpaths: where it shows (inside narrow lanes the 4 m texels round off the
        // bottom of the V-shaped field, which is asphalt either way)
        if (exact < -1.5 || exact > FOOTPATH + 1.5) continue;
        const painted = st.streetSD(x, z);
        n++;
        if (Math.abs(painted - exact) > 0.75) off++;
        // street ends and corners round off by up to ≈ 1.3 m
        if (Math.abs(exact) > 1.5 && painted < 0 !== exact < 0) wrongSide++;
      }
    expect(n).toBeGreaterThan(20_000);
    expect(off / n).toBeLessThan(0.02);
    expect(wrongSide).toBe(0);
  });

  it('Queen St, K Rd, Customs St … are painted along their whole length', () => {
    for (const name of ['Queen Street', 'Karangahape Road', 'Customs Street West', 'Symonds Street', 'Albert Street', 'Hobson Street']) {
      const lines = st.streets.filter((l) => l.name === name);
      expect(lines.length, name).toBeGreaterThan(0);
      let n = 0;
      for (const l of lines)
        for (let i = 0; i < l.pts.length; i += 2) {
          if (st.regionSD(l.pts[i], l.pts[i + 1]) < 1) continue;
          expect(st.streetSD(l.pts[i], l.pts[i + 1]), name).toBeLessThan(-2);
          n++;
        }
      expect(n, name).toBeGreaterThan(2);
    }
  });

  it('matches real Auckland: the Sky Tower stands on Victoria St / Federal St / Hobson St, Queen St runs ≈ 18° east of north', () => {
    const names = new Set<string>();
    for (let a = 0; a < Math.PI * 2; a += 0.2)
      for (const r of [20, 40, 60]) {
        const q = st.nearest(Math.cos(a) * r, Math.sin(a) * r);
        if (q && q.kerb < 20) names.add(q.line.name);
      }
    for (const n of ['Victoria Street West', 'Federal Street', 'Hobson Street']) expect(names).toContain(n);
    // Queen St from the waterfront to K Rd: ≈ 1.7 km, bearing ≈ 18° (the old grid was 8° west of south)
    const q = st.streets.filter((l) => l.name === 'Queen Street' && l.width > 15).flatMap((l) => Array.from(l.pts));
    let n0 = { x: 0, z: Infinity };
    let s0 = { x: 0, z: -Infinity };
    for (let i = 0; i < q.length; i += 2) {
      if (!st.inRegion(q[i], q[i + 1])) continue;
      if (q[i + 1] < n0.z) n0 = { x: q[i], z: q[i + 1] };
      if (q[i + 1] > s0.z) s0 = { x: q[i], z: q[i + 1] };
    }
    const len = Math.hypot(n0.x - s0.x, n0.z - s0.z);
    const bearing = (Math.atan2(n0.x - s0.x, s0.z - n0.z) * 180) / Math.PI;
    expect(len).toBeGreaterThan(1500);
    expect(len).toBeLessThan(1900);
    expect(bearing).toBeGreaterThan(12);
    expect(bearing).toBeLessThan(24);
  });

  it('parks (Albert, Victoria, Myers) are painted as parks', () => {
    for (const p of CBD_PARKS) {
      const cx = p.pts.reduce((s, q) => s + q[0], 0) / p.pts.length;
      const cz = p.pts.reduce((s, q) => s + q[1], 0) / p.pts.length;
      expect(st.park(cx, cz), p.name).toBeGreaterThan(0.9);
    }
    expect(st.park(AKL.skytower.x, AKL.skytower.z)).toBe(0);
  });

  it('the shader reads the same map: uniforms span the texture, urbanPattern hands the region to cbdPattern', () => {
    const tex = { isTexture: true } as never;
    const u = streetUniforms(st, tex, {} as never);
    expect(u.uStreets.value).toBe(tex);
    expect(u.uStreetRect.value.x).toBe(st.x0);
    expect(u.uStreetRect.value.y).toBe(st.z0);
    expect(u.uStreetRect.value.z).toBeCloseTo(1 / (st.cols * st.cell), 12);
    expect(u.uStreetRect.value.w).toBeCloseTo(1 / (st.rows * st.cell), 12);
    expect(streetUniforms(null, null, tex).uStreetRect.value.z).toBe(0); // disabled
    expect(terrainFragmentShader).toContain('if (sm.y > 0.0) return cbdPattern(wp, mpp, sm, emissive);');
    expect(terrainFragmentShader).toContain('dist.w = min(dist.w, -sm.y);');
    // the texture's edge texels are 'outside' (CLAMP_TO_EDGE repeats them beyond the rect)
    for (let i = 0; i < st.cols; i += 7) expect(st.data[i * 4 + 1]).toBe(0);
    // texel = 4 m, small enough for phones
    expect(st.cols * st.rows * 4).toBeLessThan(2.5e6);
  });
});

describe('CBD buildings on the real streets (procedural towers: the fallback without the LINZ buildings)', () => {
  const features = allFeatures('auckland', [{ type: 'airbase', x: AKL.whenuapai.x, z: AKL.whenuapai.z, rotation: 30 }]);
  const hf = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 1024, features, pads: [] }));
  const height = (x: number, z: number) => hf.meshHeightAt(x, z);
  const lights = new LightList();
  const stats = buildCBD(new GeometryBuilder(), lights, height, 0.7, cbd, roads);

  it('a skyline like the real one: 60–120 towers, tallest ≈ 187 m, dense mid-rise blocks', () => {
    expect(stats.towers).toBeGreaterThanOrEqual(60);
    expect(stats.towers).toBeLessThanOrEqual(120);
    expect(stats.tallest).toBeGreaterThanOrEqual(175);
    expect(stats.tallest).toBeLessThan(200);
    expect(stats.heights.filter((h) => h >= 100).length).toBeGreaterThanOrEqual(15);
    expect(stats.heights.filter((h) => h >= 60 && h <= 140).length).toBeGreaterThanOrEqual(45);
    expect(stats.footprints.length).toBeGreaterThan(1500);
  });

  it('no tower or building stands on a street, a footpath, a motorway, a park or in the water', { timeout: 60_000 }, () => {
    for (const f of stats.footprints) {
      for (const [x, z] of footprintPoints(f)) {
        expect(st.inRegion(x, z)).toBe(true);
        expect(st.kerbDistance(x, z)).toBeGreaterThan(FOOTPATH - 1.5); // ≥ 1.5 m behind the kerb
        expect(st.streetSD(x, z)).toBeGreaterThan(0); // nor on the painted carriageway
        expect(roads.edgeDistance(x, z)).toBeGreaterThan(0);
        expect(st.park(x, z)).toBeLessThan(0.5);
      }
      expect(height(f.x, f.z)).toBeGreaterThan(1);
    }
  });

  it('the named towers stand near their real positions, turned to their street', () => {
    // hand-placed points (≈ ±50 m: PwC Tower's falls on Customs St, Metropolis' in Albert Park)
    for (const [x, z, h] of [[650, -300, 187], [392, -433, 180], [445, -277, 170], [440, -10, 155], [294, -144, 143], [560, -180, 130]]) {
      const f = stats.footprints.find((q) => q.h === h)!;
      expect(f, `${h} m tower`).toBeDefined();
      expect(Math.hypot(f.x - x, f.z - z), `${h} m tower`).toBeLessThan(75);
      const n = st.nearest(f.x, f.z)!;
      expect(Math.abs(Math.sin(2 * (f.angle - Math.atan2(n.dz, n.dx))))).toBeLessThan(0.01);
    }
  });

  it('buildings line up with the streets they face', () => {
    let aligned = 0;
    for (const f of stats.footprints) {
      const n = st.nearest(f.x, f.z)!;
      const a = Math.atan2(n.dz, n.dx);
      if (Math.abs(Math.sin(2 * (f.angle - a))) < 0.05) aligned++;
    }
    expect(aligned / stats.footprints.length).toBeGreaterThan(0.8);
  });

  it('street lamps line the CBD streets, on the footpaths', () => {
    expect(lights.count).toBeGreaterThan(800);
    let n = 0;
    lights.forEach((x, y, z, r, g, b, size) => {
      if (size !== 3.6) return; // the street lamps (towers carry red obstruction lights)
      n++;
      expect(st.inRegion(x, z)).toBe(true);
      const k = st.kerbDistance(x, z);
      expect(k).toBeGreaterThan(0);
      expect(k).toBeLessThan(FOOTPATH);
    });
    expect(n).toBeGreaterThan(800);
  });

  it('town centres leave the CBD region to buildCBD', () => {
    const before = new GeometryBuilder();
    const n = buildCentres(before, new LightList(), height, 0.7, cbd, roads);
    expect(n).toBeGreaterThan(300);
  });

  describe('3D houses and trees in and around the CBD', () => {
    const m = 512;
    const color = new Uint8Array(m * m * 4);
    bakeColorRows(reduceView(hf, m), { theater: 'auckland', seed: 1840, features }, m, 0, m, color);
    const cmap = new ColorMapSampler(color, m, hf.origin, hf.extent);
    const tiles = (gen: (x: number, z: number, out: { data: number[][] }) => void, kinds: number) => {
      const out = { data: Array.from({ length: kinds }, () => [] as number[]) };
      for (let z = st.bounds.minZ - 600; z < st.bounds.maxZ + 600; z += 300) for (let x = st.bounds.minX - 600; x < st.bounds.maxX + 600; x += 300) gen(x, z, out);
      return out.data;
    };

    it('no house inside the CBD region (its buildings follow the real streets), nor on its border street', () => {
      const src = new HouseSource(hf, cmap, height, cbd, (x, z, mm) => roads.near(x, z, mm));
      let n = 0;
      for (const arr of tiles((x, z, out) => src.generate(x, z, 300, out), 2))
        for (let i = 0; i < arr.length; i += 11) {
          n++;
          expect(st.inRegion(arr[i], arr[i + 2])).toBe(false);
          // ≥ 5 m clear of the street the procedural grid paints along the region border
          expect(st.regionSD(arr[i], arr[i + 2])).toBeLessThan(-ROAD_HALF - 1.5);
          expect(roads.edgeDistance(arr[i], arr[i + 2])).toBeGreaterThan(5);
        }
      expect(n).toBeGreaterThan(300);
    });

    it('trees in the CBD region only grow in the parks', () => {
      const veg = createVegetation('auckland', 1840, features);
      const src = new TreeSource(hf, cmap, veg, 'auckland', 1840, 14, (x, z, mm) => roads.near(x, z, mm), cbd);
      let inPark = 0;
      for (const arr of tiles((x, z, out) => src.generate(x, z, 300, out), 3))
        for (let i = 0; i < arr.length; i += 11) {
          if (!st.inRegion(arr[i], arr[i + 2])) continue;
          expect(st.park(arr[i], arr[i + 2])).toBeGreaterThanOrEqual(0.6);
          expect(st.kerbDistance(arr[i], arr[i + 2])).toBeGreaterThan(0);
          inPark++;
        }
      expect(inPark).toBeGreaterThan(20);
    });
  });
});

describe('motorways and arterials from LINZ', () => {
  const paths = aucklandRoadPaths();
  const motorways = paths.filter((p) => p.kind === 'motorway');

  it('SH1 lands on both Harbour Bridge abutments; no ribbon over the harbour beside the bridge model', () => {
    const ends = motorways.flatMap((p) => [[p.x[0], p.z[0]], [p.x[p.x.length - 1], p.z[p.z.length - 1]]]);
    for (const id of ['bridge_s', 'bridge_n']) expect(Math.min(...ends.map(([x, z]) => Math.hypot(x - AKL[id].x, z - AKL[id].z))), id).toBeLessThan(90);
    const S = AKL.bridge_s;
    const N = AKL.bridge_n;
    const L = Math.hypot(N.x - S.x, N.z - S.z);
    for (const p of motorways)
      for (let i = 0; i < p.x.length; i++) {
        const t = ((p.x[i] - S.x) * (N.x - S.x) + (p.z[i] - S.z) * (N.z - S.z)) / (L * L);
        const off = Math.abs((p.x[i] - S.x) * (N.z - S.z) - (p.z[i] - S.z) * (N.x - S.x)) / L;
        if (t > 0.1 && t < 0.9) expect(off, p.name).toBeGreaterThan(60);
      }
  });

  it('the Waterview tunnel is a tunnel (no ribbon over Alan Wood Reserve); Victoria Park keeps its viaduct', () => {
    const tun = motorways.filter((p) => p.tunnel.every((t) => t === 1));
    expect(tun.length).toBeGreaterThanOrEqual(1);
    let len = 0;
    for (const p of tun) {
      expect(p.name).toBe('South-Western Motorway');
      for (let i = 1; i < p.x.length; i++) len += Math.hypot(p.x[i] - p.x[i - 1], p.z[i] - p.z[i - 1]);
    }
    expect(len).toBeGreaterThan(1500); // portal to portal ≈ 2.4 km, less the open approach cuttings
    // no motorway ribbon over the reserve between the portals (Great North Rd crosses above it)
    for (const p of motorways)
      for (let i = 0; i < p.x.length; i++) {
        const mid = Math.hypot(p.x[i] + 5340, p.z[i] - 4100) < 450;
        if (mid) expect(p.tunnel[i], `${p.name} at ${p.x[i].toFixed(0)}, ${p.z[i].toFixed(0)}`).toBe(1);
      }
    // the address data has one SH1 line past Victoria Park: the (surface) viaduct
    expect(roads.edgeDistance(-805, -150)).toBeLessThan(0);
  });

  it('Spaghetti Junction: a dozen carriageways and ramps meet south of K Rd; the old hand-traced SH1 was ≈ 100 m off', () => {
    const near = (x: number, z: number, r: number) => motorways.filter((p) => Array.from(p.x).some((px, i) => Math.hypot(px - x, p.z[i] - z) < r));
    expect(near(-303, 1331, 250).length).toBeGreaterThanOrEqual(10);
    // Victoria Park viaduct (SH1 along the CBD's west edge) runs at x ≈ −800 m, not through Freemans Bay
    expect(near(-805, -150, 15).length).toBeGreaterThan(0);
    setAucklandRoads(null);
    try {
      const hand = aucklandRoadPaths().find((p) => p.name === 'SH1 CBD')!;
      let best = Infinity;
      for (let i = 0; i < hand.x.length; i++) best = Math.min(best, Math.hypot(hand.x[i] + 805, hand.z[i] + 150));
      expect(best).toBeGreaterThan(80);
    } finally {
      setAucklandRoads(ROADS_BYTES);
    }
  });

  it('Great North Rd runs from K Rd out past the Whau to New Lynn, on land', () => {
    const gn = paths.filter((p) => p.name === 'Great North Rd');
    expect(gn.length).toBeGreaterThan(0);
    const xs = gn.flatMap((p) => Array.from(p.x));
    expect(Math.min(...xs)).toBeLessThan(-8000); // New Lynn (the hand-traced road stopped at Waterview, x ≈ −5.9 km)
    expect(Math.max(...xs)).toBeGreaterThan(-1200); // from Karangahape Rd
    let wet = 0;
    for (const p of gn) for (let i = 1; i < p.x.length; i++) if (!linzIsLand(linz, p.x[i], p.z[i])) wet += Math.hypot(p.x[i] - p.x[i - 1], p.z[i] - p.z[i - 1]);
    expect(wet).toBeLessThan(300);
  });
});

describe('road ribbons render', () => {
  it('every ribbon triangle faces up (the road material is front-side only; the old winding culled them all)', () => {
    const r = new RoadNetwork(aucklandRoadPaths());
    const g = r.buildRibbons(() => 10, new GeometryBuilder(), new LightList(), false);
    const p = g.attributes.position.array as Float32Array;
    const ix = g.index!.array;
    expect(ix.length).toBeGreaterThan(10_000);
    let down = 0;
    for (let t = 0; t < ix.length; t += 3) {
      const a = ix[t] * 3;
      const b = ix[t + 1] * 3;
      const c = ix[t + 2] * 3;
      // y of (b − a) × (c − a): > 0 = counter-clockwise seen from above = front face
      const ny = (p[b + 2] - p[a + 2]) * (p[c] - p[a]) - (p[b] - p[a]) * (p[c + 2] - p[a + 2]);
      if (ny < 0) down++;
    }
    // only the inner edge of the tightest ramp curves folds over (radius < half the carriageway)
    expect(down / (ix.length / 3)).toBeLessThan(0.002);
  });

  it('the CBD paints grassy verges beside its motorways, not paving', () => {
    // Grafton Gully (SH16) and the SH1 viaduct past Victoria Park
    let n = 0;
    for (const p of aucklandRoadPaths().filter((q) => q.kind === 'motorway'))
      for (let i = 0; i < p.x.length; i++) {
        if (st.regionSD(p.x[i], p.z[i]) < 12) continue;
        n++;
        expect(st.verge(p.x[i], p.z[i])).toBeGreaterThan(0.5);
      }
    expect(n).toBeGreaterThan(20);
    expect(st.verge(AKL.skytower.x, AKL.skytower.z)).toBe(0);
    expect(terrainFragmentShader).toContain('float verge = smoothstep(0.35, 0.65, sm.w) * off;');
  });
});

describe('fallback without the LINZ road data', () => {
  afterAll(() => setAucklandRoads(ROADS_BYTES));

  it('hand-traced motorways, the fixed CBD grid, and no street map', () => {
    setAucklandRoads(null);
    expect(aucklandStreets()).toBeNull();
    expect(aucklandCbd()).toBe(AKL_CBD_GRID);
    expect(terrainStyle('auckland').cbd).toBe(AKL_CBD_GRID);
    const names = aucklandRoadPaths().map((p) => p.name);
    expect(names).toContain('SH1 CBD');
    expect(names).toContain('Dominion Rd');
    // the circle grid is used again (no 'real' districts)
    expect(districtAt(0, 0, undefined, scratch, AKL_CBD_GRID).real).toBe(false);
    setAucklandRoads(ROADS_BYTES);
    expect(aucklandStreets()).not.toBeNull();
    expect(aucklandStreets()).toBe(aucklandStreets()); // built once per install
  });
});
