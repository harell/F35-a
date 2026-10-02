import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { TerrainQueryImpl } from '../src/world/terrain/TerrainQueryImpl';
import { Heightfield } from '../src/world/terrain/Heightfield';
import { mulberry32 } from '../src/core/math';
import type { SceneryFeature } from '../src/core/contracts';

// Auckland is the only theatre: the generic heightfield / query tests run on it. Mission-style features
// on land (the campaign's Waiheke strip and Motutapu depot) and SAM pads on the Gulf islands.
const FEATURES: SceneryFeature[] = [
  { type: 'airbase', x: 26_900, z: -6600, rotation: 90, size: 0.8 },
  { type: 'industrial', x: 13_300, z: -9800, size: 0.6 },
];
const PADS = [
  { x: 12_900, z: -8600, radius: 150 },
  { x: 8200, z: -5600, radius: 110 },
  { x: 24_000, z: -5500, radius: 120 },
];

const cache = new Map<string, Heightfield>();
function gen(seed = 1234, resolution = 512): Heightfield {
  const key = `${seed}/${resolution}`;
  let hf = cache.get(key);
  if (!hf) {
    hf = runSync(generateTerrain({ theater: 'auckland', seed, resolution, features: FEATURES, pads: PADS }));
    cache.set(key, hf);
  }
  return hf;
}

/** Reference LOS by dense sampling. */
function bruteLos(q: TerrainQueryImpl, a: Vector3, b: Vector3): boolean {
  const len = a.distanceTo(b);
  const steps = Math.ceil(len / 4);
  const eps = Math.min(0.05, 1 / len);
  for (let i = 0; i <= steps; i++) {
    const t = eps + ((1 - 2 * eps) * i) / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    const z = a.z + (b.z - a.z) * t;
    if (y < q.surfaceHeightAt(x, z) - 0.5) return false;
  }
  return true;
}

describe('world terrain generation', () => {
  it('is deterministic for a given seed', () => {
    const a = runSync(generateTerrain({ theater: 'auckland', seed: 77, resolution: 256, features: FEATURES, pads: PADS }));
    const b = runSync(generateTerrain({ theater: 'auckland', seed: 77, resolution: 256, features: FEATURES, pads: PADS }));
    expect(a.data).toEqual(b.data);
  });

  it('has finite heights in a plausible range', () => {
    const hf = gen();
    let mn = Infinity;
    let mx = -Infinity;
    let bad = 0;
    for (const v of hf.data) {
      if (!Number.isFinite(v)) bad++;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    expect(bad).toBe(0);
    // the Tasman shelf off the west coast, the Hunua ranges (≤ 688 m) at the south-east edge
    expect(mn).toBeGreaterThan(-200);
    expect(mn).toBeLessThan(-40);
    expect(mx).toBeGreaterThan(400);
    expect(mx).toBeLessThan(800);
  }, 20_000);

  it('heightAt is bilinear and continuous', () => {
    const hf = gen();
    const q = new TerrainQueryImpl(hf);
    // exact at samples
    for (const [i, j] of [
      [10, 20],
      [200, 300],
      [255, 256],
    ]) {
      expect(q.heightAt(hf.pos(i), hf.pos(j))).toBeCloseTo(hf.data[j * hf.n + i], 3);
    }
    // centre of a cell = mean of its corners
    const i = 150;
    const j = 222;
    const k = j * hf.n + i;
    const mean = (hf.data[k] + hf.data[k + 1] + hf.data[k + hf.n] + hf.data[k + hf.n + 1]) / 4;
    expect(q.heightAt(hf.pos(i) + hf.cell / 2, hf.pos(j) + hf.cell / 2)).toBeCloseTo(mean, 3);
    // continuity: 1 m moves never jump more than slope allows
    const rnd = mulberry32(5);
    for (let s = 0; s < 500; s++) {
      const x = (rnd() - 0.5) * 80_000;
      const z = (rnd() - 0.5) * 80_000;
      expect(Math.abs(q.heightAt(x, z) - q.heightAt(x + 1, z))).toBeLessThan(15);
    }
    // surface / water consistency
    for (let s = 0; s < 200; s++) {
      const x = (rnd() - 0.5) * 80_000;
      const z = (rnd() - 0.5) * 80_000;
      const h = q.heightAt(x, z);
      expect(q.surfaceHeightAt(x, z)).toBe(Math.max(h, 0));
      expect(q.isWater(x, z)).toBe(h < 0);
    }
  });

  it('continues beyond the world edge without NaNs or cliffs', () => {
    const q = new TerrainQueryImpl(gen());
    for (const d of [41_000, 44_000, 60_000, 200_000]) {
      const h = q.heightAt(d, 1234);
      expect(Number.isFinite(h)).toBe(true);
      expect(q.isWater(d, 1234)).toBe(true);
    }
  });

  it('flattens pads and features on dry land', () => {
    const hf = gen();
    for (const p of PADS) {
      const c = hf.heightAt(p.x, p.z);
      expect(c).toBeGreaterThanOrEqual(1.9);
      for (let a = 0; a < 8; a++) {
        const r = p.radius * 0.9;
        const h = hf.heightAt(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r);
        expect(Math.abs(h - c)).toBeLessThan(1.0);
      }
    }
    // Airbase runway strip: flat along its length
    const ab = FEATURES[0];
    const hd = ((ab.rotation ?? 0) * Math.PI) / 180;
    const h0 = hf.heightAt(ab.x, ab.z);
    expect(h0).toBeGreaterThanOrEqual(1.9);
    for (let v = -600; v <= 600; v += 150) {
      const h = hf.heightAt(ab.x + Math.sin(hd) * v, ab.z - Math.cos(hd) * v);
      expect(Math.abs(h - h0)).toBeLessThan(1.0);
    }
    // the depot is on land
    expect(hf.heightAt(FEATURES[1].x, FEATURES[1].z)).toBeGreaterThan(1.9);
  });
});

describe('world terrain queries', () => {
  it('lineOfSight is blocked by a ridge and clear above it', () => {
    const hf = gen();
    const q = new TerrainQueryImpl(hf);
    // find the highest sample away from the border
    let best = -1;
    let bi = 0;
    for (let k = 0; k < hf.data.length; k++) {
      const i = k % hf.n;
      const j = (k / hf.n) | 0;
      if (i < 50 || j < 50 || i > hf.n - 50 || j > hf.n - 50) continue;
      if (hf.data[k] > best) {
        best = hf.data[k];
        bi = k;
      }
    }
    const px = hf.pos(bi % hf.n);
    const pz = hf.pos((bi / hf.n) | 0);
    let found = false;
    for (let ang = 0; ang < Math.PI && !found; ang += 0.2) {
      const ax = px + Math.cos(ang) * 7000;
      const az = pz + Math.sin(ang) * 7000;
      const bx = px - Math.cos(ang) * 7000;
      const bz = pz - Math.sin(ang) * 7000;
      const a = new Vector3(ax, q.surfaceHeightAt(ax, az) + 40, az);
      const b = new Vector3(bx, q.surfaceHeightAt(bx, bz) + 40, bz);
      if (a.y > best - 250 || b.y > best - 250) continue;
      found = true;
      expect(q.lineOfSight(a, b)).toBe(false);
      expect(q.lineOfSight(b, a)).toBe(false);
      // well above the peak: clear
      const a2 = a.clone().setY(best + 300);
      const b2 = b.clone().setY(best + 300);
      expect(q.lineOfSight(a2, b2)).toBe(true);
    }
    expect(found).toBe(true);
  });

  it('lineOfSight is clear low over open water', () => {
    const q = new TerrainQueryImpl(gen());
    const rnd = mulberry32(9);
    let tested = 0;
    for (let s = 0; s < 400 && tested < 20; s++) {
      const ax = (rnd() - 0.5) * 70_000;
      const az = (rnd() - 0.5) * 70_000;
      const ang = rnd() * Math.PI * 2;
      const bx = ax + Math.cos(ang) * 10_000;
      const bz = az + Math.sin(ang) * 10_000;
      let allWater = true;
      for (let t = 0; t <= 1; t += 0.01) if (!q.isWater(ax + (bx - ax) * t, az + (bz - az) * t)) allWater = false;
      if (!allWater) continue;
      tested++;
      expect(q.lineOfSight(new Vector3(ax, 30, az), new Vector3(bx, 30, bz))).toBe(true);
      // a point under the sea surface can't see anything
      expect(q.lineOfSight(new Vector3(ax, -5, az), new Vector3(bx, 30, bz))).toBe(false);
    }
    expect(tested).toBeGreaterThan(5);
  });

  it('lineOfSight agrees with dense sampling', () => {
    const q = new TerrainQueryImpl(gen());
    const rnd = mulberry32(42);
    let mismatches = 0;
    const N = 600;
    for (let s = 0; s < N; s++) {
      const ax = (rnd() - 0.5) * 76_000;
      const az = (rnd() - 0.5) * 76_000;
      const ang = rnd() * Math.PI * 2;
      const len = 500 + rnd() * 25_000;
      const bx = ax + Math.cos(ang) * len;
      const bz = az + Math.sin(ang) * len;
      const a = new Vector3(ax, q.surfaceHeightAt(ax, az) + 5 + rnd() * 1500, az);
      const b = new Vector3(bx, q.surfaceHeightAt(bx, bz) + 5 + rnd() * 1500, bz);
      if (q.lineOfSight(a, b) !== bruteLos(q, a, b)) mismatches++;
    }
    expect(mismatches / N).toBeLessThan(0.01);
  });

  it('raycast finds the surface accurately', () => {
    const q = new TerrainQueryImpl(gen());
    const rnd = mulberry32(3);
    const dir = new Vector3();
    let checked = 0;
    for (let s = 0; s < 300; s++) {
      const o = new Vector3((rnd() - 0.5) * 70_000, 0, (rnd() - 0.5) * 70_000);
      o.y = q.surfaceHeightAt(o.x, o.z) + 50 + rnd() * 4000;
      dir.set(rnd() - 0.5, -0.05 - rnd() * 0.8, rnd() - 0.5).normalize();
      const d = q.raycast(o, dir, 60_000);
      // brute force
      let ref = -1;
      for (let t = 0; t < 60_000; t += 2) {
        if (o.y + dir.y * t <= q.surfaceHeightAt(o.x + dir.x * t, o.z + dir.z * t)) {
          ref = t;
          break;
        }
      }
      if (ref < 0) {
        expect(d).toBe(-1);
        continue;
      }
      checked++;
      expect(Math.abs(d - ref)).toBeLessThan(3);
      const hx = o.x + dir.x * d;
      const hz = o.z + dir.z * d;
      expect(Math.abs(o.y + dir.y * d - q.surfaceHeightAt(hx, hz))).toBeLessThan(1);
    }
    expect(checked).toBeGreaterThan(200);
    // upward ray misses; maxDist respected
    expect(q.raycast(new Vector3(0, 9000, 0), new Vector3(0, 1, 0), 10_000)).toBe(-1);
    expect(q.raycast(new Vector3(0, 9000, 0), new Vector3(0, -1, 0), 100)).toBe(-1);
    const down = q.raycast(new Vector3(100, 9000, 100), new Vector3(0, -1, 0), 20_000);
    expect(down).toBeCloseTo(9000 - q.surfaceHeightAt(100, 100), 0);
  });

  it('10k line-of-sight queries run fast', () => {
    const q = new TerrainQueryImpl(gen(1234, 1024));
    const rnd = mulberry32(11);
    const pts: Vector3[] = [];
    for (let s = 0; s < 20_000; s++) {
      const x = (rnd() - 0.5) * 76_000;
      const z = (rnd() - 0.5) * 76_000;
      pts.push(new Vector3(x, q.surfaceHeightAt(x, z) + 20 + rnd() * rnd() * 8000, z));
    }
    // warm-up
    for (let s = 0; s < 2000; s++) q.lineOfSight(pts[s], pts[s + 1]);
    const t0 = performance.now();
    let clear = 0;
    for (let s = 0; s < 10_000; s++) {
      const a = pts[s * 2];
      const b = pts[s * 2 + 1];
      // keep segments at radar-ish ranges (≤ 40 km)
      if (q.lineOfSight(a, b)) clear++;
    }
    const ms = performance.now() - t0;
    expect(clear).toBeGreaterThan(0);
    expect(ms).toBeLessThan(50);
  });
});
