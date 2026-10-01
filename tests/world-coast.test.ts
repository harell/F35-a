/**
 * Regression tests for the i1 review finding "86 m terrain/coast resolution gives stair-stepped
 * coastlines": the Auckland coast is now an exact vector distance, the heightfield is continuous
 * (linear in that distance) across the shore, and a 15 m shader coast mask agrees with it.
 */
import { describe, expect, it } from 'vitest';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { allFeatures } from '../src/world/scenery/Scenery';
import { aucklandCoastPerturbation, aucklandMapData, bakeAucklandCoastMask } from '../src/world/terrain/theaters/auckland';
import {
  classify,
  decodeCoast,
  ellipsePolygon,
  encodeCoast,
  extractCoastSegments,
  makePolygon,
  segmentDistance,
  splatDistance,
  COAST_MASK_RANGE,
  LAND_LABEL,
} from '../src/world/terrain/coastline';
import { signedDistance, GridSampler } from '../src/world/terrain/raster';
import { fillPolygonGrid } from '../src/world/terrain/coastline';
import { AKL } from '../src/core/auckland';
import { terrainFragmentShader } from '../src/world/terrain/terrainShader';

const MISSION = [
  { type: 'airbase' as const, x: AKL.whenuapai.x, z: AKL.whenuapai.z, rotation: 30 },
  { type: 'airbase' as const, x: 26_500, z: -6200, rotation: 80, size: 0.8 },
];
// SAM pads on Rangitoto / Motutapu like the campaign's (used to grow land aprons into the sea)
const PADS = [
  { x: 7400, z: -5700, radius: 120 },
  { x: 8400, z: -5000, radius: 120 },
  { x: 12_900, z: -8600, radius: 150 },
];
const hf = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 1024, features: allFeatures('auckland', MISSION), pads: PADS }));
const map = aucklandMapData();
const perturb = aucklandCoastPerturbation(1840);
const exactD = (x: number, z: number) => (map.isLand(x, z) ? 1 : -1) * segmentDistance(map.segments, x, z) + perturb(x, z);

/** Zero crossings of the bilinear heightfield along rows (central ±13 km), every `step` rows. */
function contourPoints(data: Float32Array, n: number, origin: number, cell: number, step: number): { x: number; z: number }[] {
  const pts: { x: number; z: number }[] = [];
  for (let j = 0; j < n; j += step) {
    const z = origin + j * cell;
    if (Math.abs(z) > 13_000) continue;
    for (let i = 0; i < n - 1; i++) {
      const x = origin + i * cell;
      if (Math.abs(x) > 13_000) continue;
      const a = data[j * n + i];
      const b = data[j * n + i + 1];
      if (a > 0 === b > 0) continue;
      pts.push({ x: x + (a / (a - b)) * cell, z });
    }
  }
  return pts;
}

const quantile = (a: number[], q: number) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * q)];

describe('exact vector coastline', () => {
  it('keeps only edges that separate land from water (no coast inside overlapping water bodies)', () => {
    // Two overlapping water rectangles carved out of land: the shared inner edges are not coast.
    const a = makePolygon([0, 0, 1000, 0, 1000, 1000, 0, 1000], 3);
    const b = makePolygon([500, 0, 1500, 0, 1500, 1000, 500, 1000], 4);
    const segs = extractCoastSegments([a, b], 25);
    // inner vertical edges at x = 500 (of b) and x = 1000 (of a) are water on both sides
    for (let s = 0; s < segs.length; s += 4) {
      const mx = (segs[s] + segs[s + 2]) / 2;
      const mz = (segs[s + 1] + segs[s + 3]) / 2;
      const inner = mz > 1 && mz < 999 && (Math.abs(mx - 500) < 1 || Math.abs(mx - 1000) < 1);
      expect(inner).toBe(false);
    }
    // every piece lies on the outline of the union [0, 1500] × [0, 1000], and the outline is covered
    let right = 0;
    for (let s = 0; s < segs.length; s += 4) {
      const mx = (segs[s] + segs[s + 2]) / 2;
      const mz = (segs[s + 1] + segs[s + 3]) / 2;
      const onOutline = Math.abs(mx) < 1 || Math.abs(mx - 1500) < 1 || Math.abs(mz) < 1 || Math.abs(mz - 1000) < 1;
      expect(onOutline).toBe(true);
      if (Math.abs(mx - 1500) < 1) right += Math.hypot(segs[s + 2] - segs[s], segs[s + 3] - segs[s + 1]);
    }
    expect(right).toBeCloseTo(1000, 0);
  });

  it('splats the exact segment distance', () => {
    const isl = ellipsePolygon(0, 0, 900, 600, 0.3, LAND_LABEL, 64);
    const water = makePolygon([-5000, -5000, 5000, -5000, 5000, 5000, -5000, 5000], 3);
    const segs = extractCoastSegments([water, isl], 30);
    const g = { n: 64, x0: -1600, z0: -1600, cell: 50 };
    const dist = new Float32Array(64 * 64).fill(400);
    splatDistance(segs, g, 400, dist);
    for (let k = 0; k < 200; k++) {
      const i = (k * 37) % 64;
      const j = (k * 11) % 64;
      const x = g.x0 + i * g.cell;
      const z = g.z0 + j * g.cell;
      const d = segmentDistance(segs, x, z);
      if (d < 399) expect(dist[j * 64 + i]).toBeCloseTo(d, 3);
    }
  });

  it('a straight coast rasterised at 86 m has a staircase contour; the exact field does not', () => {
    // Coast along a line at 17° through a 1024-cell (86 m) grid: compare the bilinear contour of the
    // old raster EDT distance with the new exact distance.
    const n = 256;
    const cell = 86;
    const E = n * cell;
    const ang = (17 * Math.PI) / 180;
    const nx = Math.cos(ang);
    const nz = Math.sin(ang);
    // water = half plane x·nx + z·nz > 0 (a big quad with one edge on the line)
    const t = 1e5;
    const P1 = [-nz * t, nx * t];
    const P2 = [nz * t, -nx * t];
    const poly = makePolygon([P1[0], P1[1], P2[0], P2[1], P2[0] + nx * t, P2[1] + nz * t, P1[0] + nx * t, P1[1] + nz * t], 3);
    const g = { n, x0: -E / 2, z0: -E / 2, cell };
    const labels = new Uint8Array(n * n).fill(LAND_LABEL);
    fillPolygonGrid(labels, g, poly, 3);
    const raster = signedDistance(labels, { n, extent: E }, (l) => l === LAND_LABEL);
    const segs = extractCoastSegments([poly], 30);
    const exact = new Float32Array(n * n).fill(600);
    splatDistance(segs, g, 600, exact);
    for (let k = 0; k < n * n; k++) exact[k] *= labels[k] === LAND_LABEL ? 1 : -1;
    const err = (f: Float32Array) => {
      const pts = contourPoints(f, n, -E / 2, cell, 3);
      // true coast: the line x·nx + z·nz = 0 (water on the positive side)
      return pts.map((p) => Math.abs(p.x * nx + p.z * nz));
    };
    const eOld = err(raster);
    const eNew = err(exact);
    expect(eOld.length).toBeGreaterThan(20);
    expect(quantile(eOld, 0.9)).toBeGreaterThan(20); // staircase: tens of metres
    expect(quantile(eNew, 0.9)).toBeLessThan(2);
  });
});

describe('Auckland heightfield coastline (reviewer: saw-tooth coast at 86 m)', () => {
  it('the bilinear shoreline follows the exact map coast within a few metres', () => {
    const pts = contourPoints(hf.data, hf.n, hf.origin, hf.cell, 3);
    expect(pts.length).toBeGreaterThan(300);
    const errs = pts.map((p) => Math.abs(exactD(p.x, p.z)));
    expect(quantile(errs, 0.5)).toBeLessThan(2);
    // The real (LINZ) coast has coves and creeks narrower than an 86 m cell that a bilinear contour
    // cannot follow (the hand-traced polygons were smooth: < 8 m); the visible shoreline is drawn
    // from the 15 m shader coast mask, checked below.
    expect(quantile(errs, 0.9)).toBeLessThan(15);
  });

  it('height is continuous across the waterline (no ±1 m step between neighbours)', () => {
    // For sample pairs straddling the coast, the zero crossing implied by linear interpolation must
    // not snap to the cell midpoint: with a step function a/(a−b) ≈ 0.5 always.
    const n = hf.n;
    let midpointSnaps = 0;
    let pairs = 0;
    for (let j = 0; j < n; j += 2) {
      for (let i = 0; i < n - 1; i++) {
        const a = hf.data[j * n + i];
        const b = hf.data[j * n + i + 1];
        if (a > 0 === b > 0) continue;
        const x = hf.pos(i);
        const z = hf.pos(j);
        if (Math.abs(x) > 13_000 || Math.abs(z) > 13_000) continue;
        pairs++;
        const f = a / (a - b);
        if (Math.abs(f - 0.5) < 0.04) midpointSnaps++;
      }
    }
    expect(pairs).toBeGreaterThan(200);
    expect(midpointSnaps / pairs).toBeLessThan(0.2); // uniform crossings → ≈ 8 %
  });

  it('SAM pads near Rangitoto no longer grow land aprons into the Gulf', () => {
    // points the map puts ~300–600 m offshore of Rangitoto next to the pads stay water
    for (const [x, z] of [
      [6300, -4600],
      [7600, -3900],
      [5900, -5600],
    ]) {
      expect(exactD(x, z)).toBeLessThan(-150);
      expect(hf.heightAt(x, z)).toBeLessThan(0);
    }
  });
});

describe('15 m shader coast mask', () => {
  const N = 1024;
  const E = 32_000;
  const mask = bakeAucklandCoastMask(1840, N, E);

  it('encodes the signed coast distance (± range, 0.5 m steps)', () => {
    for (const d of [-80, -64, -10.2, 0, 3.3, 63.9, 200]) {
      const v = decodeCoast(encodeCoast(d));
      expect(Math.abs(v - Math.max(-COAST_MASK_RANGE, Math.min(COAST_MASK_RANGE, d)))).toBeLessThanOrEqual(0.26);
    }
    let checked = 0;
    for (let k = 0; k < 4000; k++) {
      const i = (k * 7919) % N;
      const j = (k * 104729) % N;
      const v = decodeCoast(mask[j * N + i]);
      if (Math.abs(v) > 60) continue;
      const x = -E / 2 + (i + 0.5) * (E / N);
      const z = -E / 2 + (j + 0.5) * (E / N);
      expect(Math.abs(v - exactD(x, z))).toBeLessThan(0.3);
      checked++;
    }
    expect(checked).toBeGreaterThan(40);
  });

  it('baking in row bands (workers) gives the same mask', () => {
    const a = bakeAucklandCoastMask(1840, 256, E);
    const b = new Uint8Array(256 * 256);
    for (let j = 0; j < 256; j += 100) b.set(bakeAucklandCoastMask(1840, 256, E, j, Math.min(256, j + 100)), j * 256);
    expect(b).toEqual(a);
  });

  it('agrees with the heightfield away from the waterline', () => {
    const g = new GridSampler(Float32Array.from(mask, (b) => decodeCoast(b)), N, E);
    let bad = 0;
    let n = 0;
    for (let k = 0; k < 20_000; k++) {
      const x = ((k * 0.61803398875) % 1) * 30_000 - 15_000;
      const z = ((k * 0.7548776662) % 1) * 30_000 - 15_000;
      const sd = g.at(x + E / N / 2, z + E / N / 2);
      if (Math.abs(sd) < 25) continue;
      n++;
      if (sd > 0 !== hf.heightAt(x, z) > 0) bad++;
    }
    expect(n).toBeGreaterThan(10_000);
    expect(bad / n).toBeLessThan(0.005);
  });
});

describe('far-coast outline (i1 re-check: black line along coasts seen 3–5 km away)', () => {
  // Cause: beyond ~3 km the terrain mesh is a coarser LOD than the 15 m mask / fine heightfield the
  // water uses, so a strip of terrain stands above the water plane where the mask already says sea.
  // That strip was painted as dark wet sand (× 0.5 × 0.68 wet line, seawalls at 0.2 grey), a 1–2 px
  // black outline round every coast facing away from the camera.
  const main = terrainFragmentShader.slice(terrainFragmentShader.indexOf('void main()'));

  it('terrain seaward of the mask coast is painted with the water model, not wet sand', () => {
    expect(terrainFragmentShader).toContain('uniform vec3 uSeaShallow;');
    const branch = main.slice(main.indexOf('if (sd < -0.5)'));
    expect(branch.length).toBeGreaterThan(0);
    expect(branch).toContain('atmoSky(');
    expect(branch).toContain('uSeaShallow');
    // applied to the lit colour, before the night / fog passes (like the water shader)
    expect(main.indexOf('if (sd < -0.5)')).toBeLessThan(main.indexOf('col = atmoNight(col)'));
  });

  it('seawalls are grey riprap, and the sub-pixel wet line fades out with range', () => {
    expect(main).not.toContain('vec3(0.2, 0.2, 0.19)');
    const wall = /shore = mix\(shore, vec3\(([\d.]+), ([\d.]+), ([\d.]+)\)/.exec(main);
    expect(wall).not.toBeNull();
    const lum = 0.2126 * Number(wall![1]) + 0.7152 * Number(wall![2]) + 0.0722 * Number(wall![3]);
    expect(lum).toBeGreaterThan(0.3);
    expect(main).toMatch(/0\.32 \* \(1\.0 - smoothstep\(0\.0, 4\.0, abs\(sd\)\)\) \* \(1\.0 - smoothstep\([\d.]+, [\d.]+, mpp\)\)/);
  });
});
