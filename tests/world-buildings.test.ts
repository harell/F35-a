/**
 * LINZ phase 2b: the Auckland CBD's real buildings, NZ Building Outlines + 2024 LiDAR heights (issue #2).
 */
import { describe, expect, it } from 'vitest';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { allFeatures } from '../src/world/scenery/Scenery';
import { GeometryBuilder, ROOF_PHOTO, ROOF_Q, ROOF_WALL, WIN_OFFICE } from '../src/world/scenery/GeometryBuilder';
import { LightList } from '../src/world/scenery/builders';
import { buildCBD, simplifyRing } from '../src/world/scenery/auckland';
import { aucklandRoadPaths, RoadNetwork } from '../src/world/scenery/motorways';
import { aucklandBuildings, decodeBuildings, encodeBuildings, ringArea, ringCentroid, roofHeight, roofPhotoOffset, setAucklandBuildings, type BuildingPrism } from '../src/world/scenery/aucklandBuildings';
import { aucklandStreets, pointInRing, type CbdStreets } from '../src/world/scenery/cbdStreets';
import { buildCityLightPoints, buildFacadeLightPoints } from '../src/world/scenery/nightLights';
import { aucklandCbd } from '../src/world/config';
import { AKL } from '../src/core/auckland';
import { airfieldFeature } from '../src/core/airfields';
import { BUILDINGS_BYTES, BUILDINGS_GZ } from './linz-setup';
import SPOT from './fixtures/linz-buildings-spotchecks.json';
import ROOF_SPOT from './fixtures/linz-roof-spotchecks.json';

// the LINZ file's buildings (the hero neighbourhoods' houses joined to the list are tested in world-neighbourhoods)
const bs = aucklandBuildings()!.filter((b) => b.hero !== 'house');
const st = aucklandStreets() as CbdStreets;
const cbd = aucklandCbd();
const roads = new RoadNetwork(aucklandRoadPaths());
const prisms = bs.flatMap((b) => b.prisms);

/** Roof of the baked buildings at a point (the highest prism containing it), −1 when none. */
function roofAt(x: number, z: number): number {
  let h = -1;
  for (const p of prisms) if (pointInRing(p.ring, x, z)) h = Math.max(h, roofHeight(p, x, z));
  return h;
}

/** Points inside a ring on a `step` m lattice. */
function inside(r: Float32Array, step: number): [number, number][] {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    x0 = Math.min(x0, r[i]);
    x1 = Math.max(x1, r[i]);
    z0 = Math.min(z0, r[i + 1]);
    z1 = Math.max(z1, r[i + 1]);
  }
  const out: [number, number][] = [];
  for (let z = z0 + step / 2; z < z1; z += step) for (let x = x0 + step / 2; x < x1; x += step) if (pointInRing(r, x, z)) out.push([x, z]);
  return out;
}

describe('LINZ building data (auckland-buildings.bin)', () => {
  it('is small enough for phones (< 150 kB gzip) and round-trips through the encoder', () => {
    expect(BUILDINGS_GZ.length).toBeLessThan(150 * 1024);
    const d = decodeBuildings(BUILDINGS_BYTES);
    expect(encodeBuildings(d)).toEqual(BUILDINGS_BYTES);
    expect(() => decodeBuildings(BUILDINGS_BYTES.subarray(0, BUILDINGS_BYTES.length - 3))).toThrow();
    const bad = BUILDINGS_BYTES.slice();
    bad[0] = 0;
    expect(() => decodeBuildings(bad)).toThrow();
  });

  it('encodes sloped roofs, LiDAR-traced flags and either quantum exactly', () => {
    const ring = Float32Array.from([0, 0, 0, -20, 30, -20, 30, 0]);
    const [cx, cz] = ringCentroid(ring);
    const src = [{ lidar: true, prisms: [{ h: 12.3, ring, sx: 0.25, sz: -0.4, cx, cz }, { h: 47, ring, sx: 0, sz: 0, cx, cz }] }];
    const back = decodeBuildings(encodeBuildings(src));
    expect(back[0].lidar).toBe(true);
    expect(back[0].prisms[0]).toMatchObject({ h: 12.3, sx: 0.25, sz: -0.4 });
    expect(back[0].prisms[1]).toMatchObject({ h: 47, sx: 0, sz: 0 });
    expect(Array.from(back[0].prisms[0].ring)).toEqual(Array.from(ring));
    expect(roofHeight(back[0].prisms[0], cx + 4, cz)).toBeCloseTo(13.3, 5);
  });

  it('encodes photo-roof offsets (#140) to 0.25 m, and reads version-1 files (no photo roofs)', () => {
    const ring = Float32Array.from([0, 0, 0, -20, 30, -20, 30, 0]);
    const [cx, cz] = ringCentroid(ring);
    const src = [
      { lidar: false, prisms: [{ h: 20, ring, sx: 0, sz: 0, cx, cz }, { h: 40, ring, sx: 0, sz: 0, cx, cz }], roof: { dx: -3.3, dz: 5.1, measured: true } },
      { lidar: true, prisms: [{ h: 10, ring, sx: 0, sz: 0, cx, cz }], roof: { dx: 0.5, dz: 0, measured: false } },
      { lidar: false, prisms: [{ h: 10, ring, sx: 0, sz: 0, cx, cz }] },
    ];
    const back = decodeBuildings(encodeBuildings(src));
    expect(back[0].roof).toEqual({ dx: -3.25, dz: 5, measured: true });
    expect(back[1]).toMatchObject({ lidar: true, roof: { dx: 0.5, dz: 0, measured: false } });
    expect(back[2].roof).toBeUndefined();
    // a lower prism (the podium) leans in proportion to its height
    expect(roofPhotoOffset(back[0], back[0].prisms[0])).toEqual([-1.625, 2.5]);
    expect(roofPhotoOffset(back[0], back[0].prisms[1])).toEqual([-3.25, 5]);
    expect(roofPhotoOffset(back[2], back[2].prisms[0])).toEqual([0, 0]);
    const v1 = encodeBuildings([src[2]]);
    v1[4] = 1;
    expect(decodeBuildings(v1)[0].roof).toBeUndefined();
  });

  // #140: tools/linz/roofs.py registers each LINZ roof on the aerial photo (0.3 m source tiles); the tower kit, the
  // Scene apartments and the hero neighbourhoods keep their own roofs
  it('photo roofs on most CBD buildings, registered by correlation, few fallbacks; heroes keep their own', () => {
    const linz = bs.filter((b) => !b.hero);
    const photo = linz.filter((b) => b.roof);
    const registered = photo.filter((b) => b.roof!.measured);
    expect(photo.length).toBeGreaterThan(linz.length * 0.9);
    expect(registered.length).toBeGreaterThan(linz.length * 0.75);
    const top = (b: (typeof bs)[number]) => Math.max(...b.prisms.map((p) => p.h));
    // a tall roof (≥ 35 m) takes the photo only when registered; the rest keep today's plain roof
    const tall = linz.filter((b) => top(b) >= 35);
    expect(tall.filter((b) => b.roof && !b.roof.measured)).toEqual([]);
    expect(tall.filter((b) => b.roof).length).toBeGreaterThan(tall.length * 0.5);
    for (const b of bs.filter((b) => b.hero)) expect(b.roof).toBeUndefined();
    // physically plausible leans: at most 0.2 m per metre of height (+ 1.5 m)
    for (const b of photo) expect(Math.hypot(b.roof!.dx, b.roof!.dz)).toBeLessThanOrEqual(0.2 * top(b) + 1.5 + 0.5); // (+ the 0.25 m quantum and the NZTM frame's turn)
  });

  it('registered roofs agree with an independent 0.15 m measurement (spot check: the ten tallest)', () => {
    expect(ROOF_SPOT.length).toBe(10);
    const near = (x: number, z: number) => bs.filter((b) => b.roof && !b.hero).sort((a, b) => Math.hypot(a.prisms[0].cx - x, a.prisms[0].cz - z) - Math.hypot(b.prisms[0].cx - x, b.prisms[0].cz - z))[0];
    let within = 0;
    for (const c of ROOF_SPOT) {
      const b = near(c.x, c.z);
      expect(b.roof!.measured).toBe(true);
      const miss = Math.hypot(b.roof!.dx - c.dx, b.roof!.dz - c.dz);
      if (miss < 3) within++;
    }
    // one (#1024, an oval roof between two others) the 0.15 m search puts on a neighbour's edge, 6 m off: the 0.3 m
    // overlay shows the baked offset on the roof (tools/linz/README.md)
    expect(within).toBeGreaterThanOrEqual(9);
  });

  it('holds the CBD region: ≈ 1000 buildings (some traced from the 2024 LiDAR), all inside it, on land', () => {
    expect(bs.length).toBeGreaterThan(900);
    expect(bs.length).toBeLessThan(2000);
    const traced = bs.filter((b) => b.lidar).length;
    expect(traced).toBeGreaterThan(30); // completed since the 2017 outline capture
    expect(traced).toBeLessThan(bs.length * 0.15);
    for (const b of bs) {
      const base = b.prisms[0];
      expect(st.inRegion(base.cx, base.cz)).toBe(true);
      // the footprint first, its towers after it, each inside it
      for (const p of b.prisms) {
        expect(ringArea(p.ring)).toBeGreaterThan(0); // one winding
        expect(Math.abs(ringArea(p.ring))).toBeLessThanOrEqual(Math.abs(ringArea(base.ring)) + 1);
        expect(p.h).toBeGreaterThanOrEqual(2.5);
        expect(p.h).toBeLessThan(200);
      }
    }
    expect(prisms.length).toBeGreaterThan(bs.length);
  });

  it('heights within ±5 m of the LiDAR at the spot-checked buildings', () => {
    expect(SPOT.length).toBeGreaterThanOrEqual(20);
    // (a kit tower, #156, is measured over the ground at its centroid, where the game stands it, not over the local ground
    // these spots use; tests/world-towers.test.ts checks those against the LiDAR to ±2 m)
    const kit = bs.filter((b) => b.hero === 'tower').flatMap((b) => b.prisms);
    for (const s of SPOT) if (!kit.some((p) => pointInRing(p.ring, s.x, s.z))) expect(Math.abs(roofAt(s.x, s.z) - s.lidar), s.name).toBeLessThan(5);
  });

  it('the downtown towers: PwC Tower, Pacifica, Seascape, Voco Hotel, Metropolis at their LiDAR heights', () => {
    const named = Object.fromEntries(SPOT.filter((s) => !s.name.startsWith('outline')).map((s) => [s.name, s]));
    // published heights to the roof / crown: 180, 179, 187, 141, 155 (spire) m. (The points were first labelled Vero
    // Centre, Pacifica and ANZ Centre; their coordinates are #156's Pacifica, Seascape and Voco Hotel.)
    for (const [name, lo, hi] of [['PwC Tower', 160, 185], ['Pacifica', 165, 185], ['Seascape', 180, 195], ['Voco Hotel', 135, 150], ['Metropolis', 125, 160]] as const) {
      const s = named[name];
      expect(s, name).toBeDefined();
      const h = roofAt(s.x, s.z);
      expect(h, name).toBeGreaterThan(lo);
      expect(h, name).toBeLessThan(hi);
    }
  });

  it('keeps tilted roofs as planes (monopitch sheds, sloped crowns), the rest flat', () => {
    const sloped = prisms.filter((p) => p.sx || p.sz);
    expect(sloped.length).toBeGreaterThan(30);
    expect(sloped.length).toBeLessThan(prisms.length * 0.25);
    for (const p of sloped) expect(Math.hypot(p.sx, p.sz)).toBeLessThanOrEqual(1.21);
  });

  it('a skyline like the real one: the tallest cluster downtown, well below the Sky Tower', () => {
    const tops = bs.map((b) => ({ b, h: Math.max(...b.prisms.map((p) => p.h)) })).sort((a, c) => c.h - a.h);
    expect(tops[0].h).toBeGreaterThan(180);
    expect(tops[0].h).toBeLessThan(200);
    expect(tops.filter((t) => t.h >= 100).length).toBeGreaterThanOrEqual(10);
    expect(tops.filter((t) => t.h >= 60).length).toBeGreaterThanOrEqual(40);
    // the ten tallest stand within 650 m of Commercial Bay / Shortland St
    for (const t of tops.slice(0, 10)) expect(Math.hypot(t.b.prisms[0].cx - 400, t.b.prisms[0].cz + 300)).toBeLessThan(650);
    // nothing near the Sky Tower's shaft taller than its podium neighbours (the tower is hand-built)
    for (const p of prisms) if (pointInRing(p.ring, AKL.skytower.x, AKL.skytower.z)) expect(p.h).toBeLessThan(60);
  });

  it('buildings keep off the motorways; LiDAR-traced ones off the streets and parks (street trees)', () => {
    let pts = 0;
    let onStreet = 0;
    for (const b of bs) {
      const base = b.prisms[0];
      expect(roads.edgeDistance(base.cx, base.cz)).toBeGreaterThan(0);
      for (const [x, z] of inside(base.ring, 3)) {
        pts++;
        const k = st.kerbDistance(x, z);
        if (k < 0) onStreet++;
        if (b.lidar) {
          expect(st.park(x, z)).toBeLessThan(0.5);
        }
      }
      if (b.lidar) expect(st.kerbDistance(base.cx, base.cz)).toBeGreaterThan(0);
    }
    // the outlines are real; the painted streets have estimated widths (19 / 12 / 7 m): a few metres
    // of overlap where a real street is narrower
    expect(onStreet / pts).toBeLessThan(0.03);
  });
});

describe('GeometryBuilder.prism', () => {
  // an L-shaped (concave) footprint, both windings
  const L = [0, 0, 20, 0, 20, -10, 10, -10, 10, -30, 0, -30];
  const rev: number[] = [];
  for (let i = L.length - 2; i >= 0; i -= 2) rev.push(L[i], L[i + 1]);
  for (const [name, ring] of [['positive', L], ['negative', rev]] as const) {
    it(`walls face out, the roof faces up and covers the footprint (${name} winding)`, () => {
      const B = new GeometryBuilder();
      const tris = B.prism(ring, 5, (x) => 20 + x * 0.1, 0x888888, 0x555555, WIN_OFFICE);
      expect(tris).toBe(6 * 2 + 4);
      const g = B.build()!;
      const pos = g.getAttribute('position');
      const nrm = g.getAttribute('normal');
      const idx = g.getIndex()!;
      let roofArea = 0;
      for (let t = 0; t < idx.count; t += 3) {
        const [a, b, c] = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)];
        const P = (k: number) => [pos.getX(k), pos.getY(k), pos.getZ(k)];
        const [p0, p1, p2] = [P(a), P(b), P(c)];
        // the winding agrees with the stored normal (front faces are the outside)
        const u = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
        const v = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        expect(n[0] * nrm.getX(a) + n[1] * nrm.getY(a) + n[2] * nrm.getZ(a)).toBeGreaterThan(0);
        if (Math.abs(nrm.getY(a)) > 0.5) {
          expect(nrm.getY(a)).toBeGreaterThan(0);
          roofArea += Math.abs(n[1]) / 2;
          continue;
        }
        // a wall: just outside its midpoint is outside the footprint
        const mx = (p0[0] + p1[0] + p2[0]) / 3 + nrm.getX(a) * 0.5;
        const mz = (p0[2] + p1[2] + p2[2]) / 3 + nrm.getZ(a) * 0.5;
        expect(pointInRing(L, mx, mz)).toBe(false);
      }
      expect(roofArea).toBeCloseTo(20 * 10 + 10 * 20, 3);
    });
  }

  it('simplifyRing drops near-collinear vertices, keeps the corners', () => {
    const r = Float32Array.from([0, 0, 10, 0.2, 20, 0, 20, -20, 0, -20]);
    expect(Array.from(simplifyRing(r, 0.5))).toEqual([0, 0, 20, 0, 20, -20, 0, -20]);
    expect(simplifyRing(r, 0)).toBe(r);
  });
});

describe('the CBD built from the LINZ buildings', () => {
  const features = allFeatures('auckland', [airfieldFeature('whenuapai')]);
  const hf = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 1024, features, pads: [] }));
  const height = (x: number, z: number) => hf.meshHeightAt(x, z);
  const build = (detail: number, withBuildings = true) => {
    const B = new GeometryBuilder();
    const lights = new LightList();
    const t0 = performance.now();
    const stats = buildCBD(B, lights, height, detail, cbd, roads, withBuildings ? bs : null);
    return { B, lights, stats, ms: performance.now() - t0 };
  };
  const medium = build(0.7);

  it('extrudes every building to its measured roof, standing on the terrain', () => {
    const { stats } = medium;
    expect(stats.prisms.length).toBe(prisms.length);
    expect(stats.footprints).toEqual([]);
    expect(stats.tallest).toBeGreaterThan(180);
    expect(stats.towers).toBeGreaterThanOrEqual(40);
    for (const p of stats.prisms) {
      // the walls reach the ground at every corner; the roof is the measured height above the centroid's ground
      for (let i = 0; i < p.ring.length; i += 2) expect(p.y0).toBeLessThanOrEqual(height(p.ring[i], p.ring[i + 1]));
      expect(p.y1 - p.y0).toBeGreaterThanOrEqual(p.h);
    }
  });

  // Budget (issue #2): the CBD stays in the city's one merged mesh (no extra draw call), ≤ 50 k
  // triangles on the medium tier (≤ 1.4 × the procedural towers it replaces), ≤ 35 k on low. Issue #156 raised it
  // for the tower kit's 115 measured towers (terraces, setbacks, plant: 45.5 k → 58.6 k on medium, 33 k → 38 k on low,
  // same draw call): ≤ 62 k on medium, ≤ 40 k on low.
  it('stays within the mobile budget: same single mesh, ≤ 62 k triangles on medium, ≤ 40 k on low', () => {
    const procedural = build(0.7, false);
    const low = build(0.35);
    const high = build(1);
    expect(medium.stats.triangles).toBeLessThan(62_000);
    expect(low.stats.triangles).toBeLessThan(40_000);
    expect(low.stats.triangles).toBeLessThan(medium.stats.triangles * 0.9);
    expect(high.stats.triangles).toBeGreaterThanOrEqual(medium.stats.triangles);
    // vs the procedural towers it replaces (same draw call: the caller's builder)
    expect(medium.stats.triangles).toBeLessThan(procedural.stats.triangles * 1.7); // 1.4 before the tower kit (#156)
    expect(medium.ms).toBeLessThan(1500);
  });

  it('street lamps on the footpaths, never inside a building; red obstruction lights on the towers', { timeout: 60_000 }, () => {
    let lamps = 0;
    let beacons = 0;
    const near = (p: BuildingPrism, x: number, z: number) => Math.hypot(p.cx - x, p.cz - z) < 400 && pointInRing(p.ring, x, z);
    medium.lights.forEach((x, y, z, r, g, b, size) => {
      if (size === 3.6) {
        lamps++;
        expect(prisms.some((p) => near(p, x, z))).toBe(false);
      } else if (size === 3.5 && r > 0.5 && g < 0.1) beacons++;
    });
    expect(lamps).toBeGreaterThan(600);
    expect(beacons).toBeGreaterThanOrEqual(12);
  });

  it('photo roofs (#140): the roof faces carry their offset, the walls a parapet band; no attribute unless enabled', () => {
    expect(medium.B.build()!.getAttribute('aRoof')).toBeUndefined();
    const B = new GeometryBuilder();
    B.enablePhotoRoofs();
    const t = buildCBD(B, new LightList(), height, 0.7, cbd, roads, bs).triangles;
    expect(t).toBe(medium.stats.triangles); // same triangles: the photo is a shader input
    const g = B.build()!;
    const a = g.getAttribute('aRoof');
    const n = g.getAttribute('normal');
    expect(a.count).toBe(g.getAttribute('position').count);
    let roofs = 0;
    let walls = 0;
    let shifted = 0;
    for (let v = 0; v < a.count; v++) {
      const k = a.getW(v);
      if (k === ROOF_PHOTO) {
        roofs++;
        expect(n.getY(v)).toBeGreaterThan(0.5); // (the shader drapes faces over 0.7: a steep monopitch keeps its colour)
        if (Math.hypot(a.getX(v), a.getY(v)) * ROOF_Q > 1) shifted++;
      } else if (k === ROOF_WALL) {
        walls++;
        expect(Math.abs(n.getY(v))).toBeLessThan(0.5);
      }
    }
    expect(roofs).toBeGreaterThan(5000);
    expect(walls).toBeGreaterThan(roofs);
    expect(shifted).toBeGreaterThan(roofs * 0.3);
  });

  it('falls back to the procedural towers on the real streets without the building data', () => {
    setAucklandBuildings(null);
    try {
      expect(aucklandBuildings()).toBeNull();
      const { stats } = build(0.7, false);
      expect(stats.prisms).toEqual([]);
      expect(stats.footprints.length).toBeGreaterThan(1000);
    } finally {
      setAucklandBuildings(BUILDINGS_BYTES);
    }
  });

  describe('night lights follow the buildings', () => {
    it('lit windows on the facades, from the second floor to the roof, capped', () => {
      const out = new LightList();
      const n = buildFacadeLightPoints(medium.stats.prisms, 7, 6000, out);
      expect(n).toBe(out.count);
      expect(n).toBeGreaterThan(3000);
      expect(n).toBeLessThan(6600);
      const tall = medium.stats.prisms.filter((p) => p.y1 - p.y0 >= 10);
      // every light hangs 0.6 m off a facade of a prism tall enough to reach it
      const near = (p: BuildingPrism & { y0: number; y1: number }, x: number, y: number, z: number) => {
        if (y < p.y0 + 5.9 || y > p.y1) return false;
        const r = p.ring;
        const k = r.length / 2;
        for (let i = 0, j = k - 1; i < k; j = i++) {
          const dx = r[i * 2] - r[j * 2];
          const dz = r[i * 2 + 1] - r[j * 2 + 1];
          const l2 = dx * dx + dz * dz;
          const t = Math.max(0, Math.min(1, ((x - r[j * 2]) * dx + (z - r[j * 2 + 1]) * dz) / l2));
          if (Math.hypot(r[j * 2] + dx * t - x, r[j * 2 + 1] + dz * t - z) < 0.7) return true;
        }
        return false;
      };
      let k = 0;
      out.forEach((x, y, z) => {
        if (k++ % 25) return;
        expect(tall.some((p) => near(p, x, y, z))).toBe(true);
      });
      // up the towers (the carpet's lights hang 5–15 m over the ground): the skyline glows to the top
      let high = 0;
      let top = 0;
      out.forEach((x, y) => {
        if (y > 80) high++;
        top = Math.max(top, y);
      });
      expect(high).toBeGreaterThan(n * 0.05);
      expect(top).toBeGreaterThan(160);
      // the cap thins uniformly
      expect(buildFacadeLightPoints(medium.stats.prisms, 7, 1000, new LightList())).toBeLessThan(1150);
    });

    it('the far-field carpet keeps out of the CBD region (the facades light it)', () => {
      const m = 64;
      const data = new Uint8Array(m * m * 4).fill(255);
      const map = { data, size: m, origin: -3200, extent: 6400 };
      const all = new LightList();
      const some = new LightList();
      buildCityLightPoints(map, () => 10, 3, 1e6, all);
      buildCityLightPoints(map, () => 10, 3, 1e6, some, (x, z) => st.inRegion(x, z));
      expect(some.count).toBeLessThan(all.count);
      some.forEach((x, y, z) => expect(st.inRegion(x, z)).toBe(false));
    });
  });
});
