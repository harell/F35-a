/**
 * The Auckland Domain (world/scenery/aucklandDomain.ts, baked by tools/hero/sites/domain_bake.py; buildings in
 * world/scenery/domain.ts, trees in sources.ts TreeSource) and the museum on it (the layered-site contract: the base
 * keeps clear of the top layer's footprint).
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { aucklandDomain, decodeDomain } from '../src/world/scenery/aucklandDomain';
import { buildDomainBuildings } from '../src/world/scenery/domain';
import { buildMuseum } from '../src/world/scenery/museum';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';
import { LightList } from '../src/world/scenery/builders';
import { siteRings } from '../src/world/scenery/aucklandSites';
import { ColorMapSampler, TreeSource } from '../src/world/scenery/sources';
import { pointInRing } from '../src/world/scenery/cbdStreets';
import { allFeatures } from '../src/world/scenery/Scenery';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { bakeColorRows } from '../src/world/terrain/bake';
import { reduceView } from '../src/world/terrain/parallel';
import { createVegetation } from '../src/world/terrain/vegetation';
import { MUSEUM, MUSEUM_OUTLINE } from '../src/core/museum';
import { AKL } from '../src/core/auckland';
import { DOMAIN_BYTES, DOMAIN_GZ } from './linz-setup';

const D = aucklandDomain()!;

function ringDistance(r: ArrayLike<number>, x: number, z: number): number {
  let best = Infinity;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = r[j * 2], az = r[j * 2 + 1], dx = r[i * 2] - ax, dz = r[i * 2 + 1] - az;
    const l = dx * dx + dz * dz;
    const t = l > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l)) : 0;
    best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t));
  }
  return best;
}

describe('the Auckland Domain (measured)', () => {
  it('decodes: the park round the museum, its buildings and 2,000+ LiDAR trees, inside the area budget', () => {
    expect(decodeDomain(DOMAIN_BYTES).trees.length).toBe(D.trees.length);
    expect(DOMAIN_GZ.length).toBeLessThan(25_000);
    expect(pointInRing(D.park, MUSEUM.x, MUSEUM.z)).toBe(true);
    expect(pointInRing(D.park, AKL.domain.x, AKL.domain.z)).toBe(true);
    expect(D.trees.length).toBeGreaterThan(2000);
    expect(D.buildings.length).toBeGreaterThan(20);
    const hs = D.trees.map((t) => t.h).sort((a, b) => a - b);
    expect(hs[hs.length >> 1]).toBeGreaterThan(12);
    expect(hs[hs.length >> 1]).toBeLessThan(22);
    expect(hs[hs.length - 1]).toBeLessThan(60);
    for (const t of D.trees) {
      expect(t.r).toBeGreaterThan(0);
      expect(t.base).toBeGreaterThan(0.1);
      expect(t.base).toBeLessThan(0.8);
    }
  });

  it('keeps clear of the museum: no tree or park building within 3 m of its outline', () => {
    for (const t of D.trees) {
      const inside = pointInRing(MUSEUM_OUTLINE, t.x, t.z);
      expect(inside || ringDistance(MUSEUM_OUTLINE, t.x, t.z) < 3, `tree ${t.x},${t.z}`).toBe(false);
      // and no crown reaches over it
      expect(ringDistance(MUSEUM_OUTLINE, t.x, t.z)).toBeGreaterThan(t.r - 0.5);
    }
    for (const b of D.buildings)
      for (let i = 0; i < b.ring.length; i += 2) expect(pointInRing(MUSEUM_OUTLINE, b.ring[i], b.ring[i + 1])).toBe(false);
  });

  it('the museum stands on the game ground at its centroid; the Domain is a site the street grid stops on', () => {
    const B = new GeometryBuilder();
    const height = (x: number, z: number) => 60 + 0.02 * (x - MUSEUM.x) - 0.03 * (z - MUSEUM.z);
    expect(Math.abs(buildMuseum(B, new LightList(), height) - height(MUSEUM.x, MUSEUM.z))).toBeLessThan(0.5);
    expect(siteRings().some((r) => r.length === D.park.length && r[0] === D.park[0])).toBe(true);
  });

  it('the Wintergarden glasshouses are glass vaults whose faces all point out', () => {
    const glass = D.buildings.filter((b) => b.kind === 1);
    expect(glass).toHaveLength(2);
    for (const b of glass) {
      expect(b.ridge).toBeGreaterThan(b.h + 1);
      expect(b.ridge).toBeLessThan(16);
      const B = new GeometryBuilder();
      buildDomainBuildings(B, { park: D.park, buildings: [b], trees: [] }, () => 50);
      const geo = B.build()!;
      const pos = geo.getAttribute('position');
      const nrm = geo.getAttribute('normal');
      const idx = geo.getIndex()!;
      let cx = 0, cz = 0;
      for (let i = 0; i < 4; i++) {
        cx += b.ring[i * 2] / 4;
        cz += b.ring[i * 2 + 1] / 4;
      }
      const c = new Vector3(cx, 50, cz);
      for (let t = 0; t < idx.count; t += 3) {
        const v = [0, 1, 2].map((k) => idx.getX(t + k));
        const m = new Vector3();
        for (const k of v) m.add(new Vector3(pos.getX(k), pos.getY(k), pos.getZ(k)).divideScalar(3));
        const n = new Vector3(nrm.getX(v[0]), nrm.getY(v[0]), nrm.getZ(v[0]));
        expect(n.dot(m.sub(c)), `triangle ${t / 3}`).toBeGreaterThan(-1e-6);
      }
    }
  });

  it('builds its buildings in the caller\'s mesh, within budget', () => {
    const B = new GeometryBuilder();
    const tris = buildDomainBuildings(B, D, () => 50);
    expect(tris).toBeGreaterThan(200);
    expect(tris).toBeLessThan(2500);
  });

  it('TreeSource grows the measured trees in the park and none of its own there', () => {
    const features = allFeatures('auckland', []);
    const hf = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 512, features, pads: [] }));
    const m = 256;
    const color = new Uint8Array(m * m * 4);
    bakeColorRows(reduceView(hf, m), { theater: 'auckland', seed: 1840, features }, m, 0, m, color);
    const cmap = new ColorMapSampler(color, m, hf.origin, hf.extent);
    const src = new TreeSource(hf, cmap, createVegetation('auckland', 1840, features), 'auckland', 1840, 14, null, null, null, null, D);
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < D.park.length; i += 2) {
      x0 = Math.min(x0, D.park[i]);
      x1 = Math.max(x1, D.park[i]);
      z0 = Math.min(z0, D.park[i + 1]);
      z1 = Math.max(z1, D.park[i + 1]);
    }
    const out = { data: [[], [], []] as number[][] };
    const T = 400;
    for (let z = Math.floor(z0 / T) * T; z < z1; z += T) for (let x = Math.floor(x0 / T) * T; x < x1; x += T) src.generate(x, z, T, out);
    const measured = new Set(D.trees.map((t) => `${t.x},${t.z}`));
    let inPark = 0;
    let ours = 0;
    for (const a of out.data)
      for (let i = 0; i < a.length; i += 12) {
        const key = `${a[i]},${a[i + 2]}`;
        if (measured.has(key)) {
          ours++;
          const t = D.trees.find((q) => q.x === a[i] && q.z === a[i + 2])!;
          expect(a[i + 5]).toBe(t.h);
          expect(Math.abs(a[i + 1] - hf.meshHeightAt(t.x, t.z))).toBeLessThan(0.5);
        } else if (pointInRing(D.park, a[i], a[i + 2])) inPark++;
      }
    expect(ours).toBe(D.trees.length);
    expect(inPark).toBe(0);
  });
});
