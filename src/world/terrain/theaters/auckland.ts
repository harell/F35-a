/**
 * AUCKLAND theatre (primary) — a stylised but recognisable Tāmaki Makaurau: the Waitematā and
 * Manukau harbours, Tāmaki estuary, Hauraki Gulf islands (Rangitoto's perfect shield cone,
 * Motutapu, Waiheke…), the isthmus with its scoria cones (Mt Eden, One Tree Hill…), the bush-clad
 * Waitākere and Hunua ranges, and the Tasman coast. Coastlines come from hand-traced polygons
 * (aucklandMap.ts) kept as vector segments (coastline.ts): the signed coast distance is exact near
 * the shore, and the height is a CONTINUOUS function of it (≈ 2–3 % shelving beaches, steeper on
 * rocky shores), so the bilinear heightfield contour — and the 15 m shader coast mask baked from the
 * same function — are smooth instead of following an 86 m raster staircase.
 *
 * With the LINZ data loaded (aucklandLinz.ts — the normal case) the coastline is the real
 * mean-high-water line, land heights are the LiDAR DEM, water depth comes from the LINZ nautical charts
 * (ENC depth areas) and the bush / pine forests / scrub are the Topo50 vegetation polygons: the
 * procedural relief / cones / coast noise / bush mask are off and the hand-traced polygons only keep the
 * crater lakes. Without it (offline, old browser) everything below falls back to the hand-traced map.
 */
import { Noise2D, sstep, mixf } from '../noise';
import { CoarseField } from '../coarse';
import { GridSampler, labelAt, signedDistance, type GridSpec } from '../raster';
import {
  COAST_MASK_RANGE,
  LAND_LABEL,
  classify,
  encodeCoast,
  ellipsePolygon,
  extractCoastSegments,
  fillPolygonGrid,
  makePolygon,
  splatDistance,
  type CoastPolygon,
  type SampleGrid,
} from '../coastline';
import {
  HF_EXTENT,
  MAT_BEACH,
  MAT_BUSH,
  MAT_CONE,
  MAT_NONE,
  MAT_PINE,
  MAT_URBAN,
  MAT_VOLCANIC,
  type SampleOut,
  type TheaterGenerator,
} from '../types';
import {
  AKL_CBD,
  AKL_CONES,
  AKL_ISLANDS,
  AKL_LABEL,
  AKL_LAKES,
  AKL_PARKS,
  AKL_RANGITOTO,
  AKL_RELIEF,
  AKL_RURAL,
  AKL_URBAN,
  AKL_WATER,
} from './aucklandMap';
import {
  COVER_EXOTIC,
  COVER_SCRUB,
  aucklandLinz,
  aucklandLinzVersion,
  fillLinzLand,
  linzCoastSegments,
  linzCover,
  linzDepth,
  linzHeight,
  linzIsLand,
  type CoverSample,
  type LinzData,
} from './aucklandLinz';


const KM = 1000;
const MAP_N = 1024;
/** Band (m) around the coast where the map SDF is replaced by the exact vector distance. */
const EXACT_BAND = 600;

export interface AucklandMapData {
  labels: Uint8Array;
  coast: GridSampler;
  urban: GridSampler;
  n: number;
  /** Land/water boundary pieces [x0, z0, x1, z1, ...] (m). */
  segments: Float32Array;
  /** Procedural map: every polygon in painting order. LINZ map: the lakes only. */
  polys: CoastPolygon[];
  /** Real LINZ coastline/heights in use (null: hand-traced fallback). */
  linz: LinzData | null;
  /** Land test at a point (same rule as the rasters). */
  isLand: (x: number, z: number) => boolean;
  /** Write LAND_LABEL (land) / anything else (water) for rows [0, rows) of grid `g` into `labels`. */
  fillLand: (labels: Uint8Array, g: SampleGrid, rows: number) => void;
}

let cached: AucklandMapData | null = null;
let cachedVersion = -1;

/** Water / island / lake polygons (m) in painting order over a land base. */
export function aucklandPolygons(): CoastPolygon[] {
  const km = (pts: number[]) => pts.map((v) => v * KM);
  const out: CoastPolygon[] = [];
  for (const w of AKL_WATER) out.push(makePolygon(km(w.pts), w.label));
  for (const isl of AKL_ISLANDS) {
    if ('pts' in isl) out.push(makePolygon(km(isl.pts), AKL_LABEL.land));
    else {
      const [cx, cz, rx, rz, rot] = isl.ellipse;
      out.push(ellipsePolygon(cx * KM, cz * KM, rx * KM, rz * KM, rot, AKL_LABEL.land));
    }
  }
  for (const [cx, cz, r] of AKL_LAKES) out.push(ellipsePolygon(cx * KM, cz * KM, r * KM, r * KM, 0, AKL_LABEL.lake, 64));
  return out;
}

/** Rasterised map (labels + coast / urban signed distance). Cached: it doesn't depend on the seed. */
export function aucklandMapData(): AucklandMapData {
  if (cached && cachedVersion === aucklandLinzVersion()) return cached;
  cachedVersion = aucklandLinzVersion();
  const g: GridSpec = { n: MAP_N, extent: HF_EXTENT };
  const sg: SampleGrid = { n: MAP_N, x0: -HF_EXTENT / 2, z0: -HF_EXTENT / 2, cell: HF_EXTENT / MAP_N };
  const handPolys = aucklandPolygons();
  const labels = new Uint8Array(MAP_N * MAP_N).fill(AKL_LABEL.land);
  for (const p of handPolys) fillPolygonGrid(labels, sg, p, p.label);
  const linz = aucklandLinz();
  let polys = handPolys;
  let segments: Float32Array;
  let isLand: AucklandMapData['isLand'];
  let fillLand: AucklandMapData['fillLand'];
  if (linz) {
    // Real coastline; lakes (not in the coastline data) stay as the hand-placed crater lakes.
    polys = handPolys.filter((p) => p.label === AKL_LABEL.lake);
    relabelWithLinz(labels, linz, sg);
    const lakeSegs = extractCoastSegments(polys, 30, LAND_LABEL);
    const coastSegs = linzCoastSegments(linz, 30);
    segments = new Float32Array(coastSegs.length + lakeSegs.length);
    segments.set(coastSegs);
    segments.set(lakeSegs, coastSegs.length);
    isLand = (x, z) => linzIsLand(linz, x, z) && classify(polys, x, z) === LAND_LABEL;
    fillLand = (out, grid, rows) => {
      out.fill(0, 0, rows * grid.n);
      fillLinzLand(linz, out, grid, rows, AKL_LABEL.land);
      for (const p of polys) fillPolygonGridRows(out, grid, rows, p, p.label);
    };
  } else {
    segments = extractCoastSegments(polys, 30, LAND_LABEL);
    isLand = (x, z) => classify(polys, x, z) === LAND_LABEL;
    fillLand = (out, grid, rows) => {
      out.fill(AKL_LABEL.land, 0, rows * grid.n);
      for (const p of polys) fillPolygonGridRows(out, grid, rows, p, p.label);
    };
  }
  // Raster EDT for the far field (bathymetry, inland ramps) …
  const sdf = signedDistance(labels, g, (l) => l === AKL_LABEL.land);
  // … exact vector distance near the shore (blended into the raster value at the band edge).
  const exact = new Float32Array(MAP_N * MAP_N).fill(EXACT_BAND);
  splatDistance(segments, sg, EXACT_BAND, exact);
  for (let k = 0; k < sdf.length; k++) {
    const e = exact[k];
    if (e >= EXACT_BAND) continue;
    const s = labels[k] === AKL_LABEL.land ? 1 : -1;
    const w = sstep(EXACT_BAND * 0.7, EXACT_BAND, e);
    sdf[k] = s * mixf(e, Math.abs(sdf[k]), w);
  }
  const coast = new GridSampler(sdf, MAP_N, HF_EXTENT);

  // Urban footprint only needs ~350 m accuracy: a 256² field is plenty.
  const UN = 256;
  const ug: SampleGrid = { n: UN, x0: -HF_EXTENT / 2, z0: -HF_EXTENT / 2, cell: HF_EXTENT / UN };
  const urbanLabels = new Uint8Array(UN * UN);
  for (const poly of AKL_URBAN) fillPolygonGrid(urbanLabels, ug, makePolygon(poly.map((v) => v * KM), 1), 1);
  const urban = new GridSampler(signedDistance(urbanLabels, { n: UN, extent: HF_EXTENT }, (l) => l === 1), UN, HF_EXTENT);
  cached = { labels, coast, urban, n: MAP_N, segments, polys, linz, isLand, fillLand };
  return cached;
}

/**
 * Replace the hand-traced land/water split of `labels` (painted from the hand polygons) with the
 * LINZ coastline, keeping the hand map's water-body names (they drive the bathymetry): water that
 * was land on the hand map takes the nearest hand-map water body; hand-placed lakes are kept.
 */
function relabelWithLinz(labels: Uint8Array, linz: LinzData, sg: SampleGrid): void {
  const n = sg.n;
  const real = new Uint8Array(n * n);
  fillLinzLand(linz, real, sg, n, 1);
  const queue = new Int32Array(n * n);
  let head = 0;
  let tail = 0;
  for (let k = 0; k < n * n; k++) {
    const old = labels[k];
    if (old === AKL_LABEL.lake) continue;
    if (real[k]) labels[k] = AKL_LABEL.land;
    else if (old === AKL_LABEL.land) labels[k] = 0; // water, body unknown yet
    else queue[tail++] = k;
  }
  // Multi-source BFS: unnamed water takes the label of the nearest named water.
  while (head < tail) {
    const k = queue[head++];
    const i = k % n;
    const l = labels[k];
    const nb = [i > 0 ? k - 1 : -1, i < n - 1 ? k + 1 : -1, k - n, k + n];
    for (const m of nb) {
      if (m < 0 || m >= n * n || labels[m] !== 0) continue;
      labels[m] = l;
      queue[tail++] = m;
    }
  }
  for (let k = 0; k < n * n; k++) if (labels[k] === 0) labels[k] = AKL_LABEL.gulf;
}

/**
 * Seeded coastline perturbation (m) added to the map distance: broad bays/headlands (±110 m) plus
 * small coves (±28 m). Shared by the heightfield and the shader coast mask so both agree.
 */
export function aucklandCoastPerturbation(seed: number): (x: number, z: number) => number {
  // The real coastline is used as is.
  if (aucklandLinz()) return () => 0;
  const nA = new Noise2D(seed * 29 + 1);
  const nD = new Noise2D(seed * 29 + 4);
  const coastNoise = new CoarseField((x, z) => 110 * nA.fbm(x / 2200, z / 2200, 3));
  return (x, z) => coastNoise.at(x, z) + 28 * nD.noise(x / 420, z / 420);
}

/**
 * High-resolution coast mask for the shaders: n × n texels over [−extent/2, extent/2]² (texel
 * centres), each the signed coast distance (m, + land, map distance + the seeded perturbation)
 * encoded with `encodeCoast` (±COAST_MASK_RANGE). Rows [j0, j1) only when splitting work.
 */
export function bakeAucklandCoastMask(seed: number, n: number, extent: number, j0 = 0, j1 = n): Uint8Array {
  const map = aucklandMapData();
  const perturb = aucklandCoastPerturbation(seed);
  const cell = extent / n;
  const g: SampleGrid = { n, x0: -extent / 2 + cell / 2, z0: -extent / 2 + cell / 2, cell };
  const rows = j1 - j0;
  // Land/water at texel centres (band of rows).
  const bandGrid: SampleGrid = { n, x0: g.x0, z0: g.z0 + j0 * cell, cell };
  const labels = new Uint8Array(n * rows);
  map.fillLand(labels, bandGrid, rows);
  // |perturbation| ≤ 138 m (none on the LINZ coast), so exact distances are needed within
  // RANGE + 140 m of the polygons.
  const R = COAST_MASK_RANGE + (map.linz ? 8 : 176);
  const dist = new Float32Array(n * rows).fill(R);
  splatDistance(map.segments, g, R, dist, j0, j1, j0);
  const out = new Uint8Array(n * rows);
  for (let j = 0; j < rows; j++) {
    const z = g.z0 + (j0 + j) * cell;
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const s = labels[k] === AKL_LABEL.land ? 1 : -1;
      const e = dist[k];
      out[k] = e >= R ? (s > 0 ? 255 : 0) : encodeCoast(s * e + perturb(g.x0 + i * cell, z));
    }
  }
  return out;
}

/** fillPolygonGrid for a band of `rows` rows (grid z0 = first row). */
function fillPolygonGridRows(labels: Uint8Array, g: SampleGrid, rows: number, poly: CoastPolygon, value: number): void {
  if (poly.maxZ < g.z0 || poly.minZ > g.z0 + (rows - 1) * g.cell) return;
  const tmp: SampleGrid = { n: g.n, x0: g.x0, z0: g.z0, cell: g.cell };
  // fillPolygonGrid clamps rows to [0, n); restrict to the band by clipping the polygon's z range.
  const clipped: CoastPolygon = { ...poly, minZ: Math.max(poly.minZ, g.z0), maxZ: Math.min(poly.maxZ, g.z0 + (rows - 1) * g.cell) };
  fillPolygonGrid(labels, tmp, clipped, value);
}

interface Relief {
  cx: number;
  cz: number;
  c: number;
  s: number;
  irx: number;
  irz: number;
  h: number;
  rough: number;
}

const RELIEF: Relief[] = AKL_RELIEF.map((r) => ({
  cx: r.e[0] * KM,
  cz: r.e[1] * KM,
  c: Math.cos(r.e[4]),
  s: Math.sin(r.e[4]),
  irx: 1 / (r.e[2] * KM),
  irz: 1 / (r.e[3] * KM),
  h: r.h,
  rough: r.rough,
}));

function ellipseDist(e: Relief, x: number, z: number): number {
  const dx = x - e.cx;
  const dz = z - e.cz;
  const u = (dx * e.c + dz * e.s) * e.irx;
  const v = (-dx * e.s + dz * e.c) * e.irz;
  return Math.sqrt(u * u + v * v);
}

/** Riverhead pine plantation of the hand-traced map (centre x, z and radius, m). */
const RIVERHEAD_PINES = { x: -16_000, z: -14_500, r: 6000 };

/** Shore gradients: gentle beaches / mudflats, rocky shores, cliffs (height = slope · distance). */
const SHORE_GENTLE = 0.03;
const SHORE_ROCKY = 0.14;
const SHORE_CLIFF = 0.3;

export function createAuckland(seed: number): TheaterGenerator {
  const map = aucklandMapData();
  const nA = new Noise2D(seed * 29 + 1);
  const nB = new Noise2D(seed * 29 + 2);
  const nC = new Noise2D(seed * 29 + 3);
  const nD = new Noise2D(seed * 29 + 4);
  const coastPerturb = aucklandCoastPerturbation(seed);

  // Regional base height and roughness (max over noise-warped relief ellipses).
  const warpX = new CoarseField((x, z) => 2600 * nA.fbm(x / 9000 + 7.1, z / 9000, 3));
  const warpZ = new CoarseField((x, z) => 2600 * nA.fbm(x / 9000 - 3.3, z / 9000 + 5.5, 3));
  const regionH = new CoarseField((x, z) => {
    const wx = x + warpX.at(x, z);
    const wz = z + warpZ.at(x, z);
    let r = 14;
    for (const reg of RELIEF) r = Math.max(r, reg.h * (1 - sstep(0.5, 1.3, ellipseDist(reg, wx, wz))));
    return r;
  });
  const regionK = new CoarseField((x, z) => {
    const wx = x + warpX.at(x, z);
    const wz = z + warpZ.at(x, z);
    let k = 0.08;
    for (const reg of RELIEF) k = Math.max(k, reg.rough * (1 - sstep(0.5, 1.3, ellipseDist(reg, wx, wz))));
    return k;
  });
  const channelF = new CoarseField((x, z) => nB.fbm(x / 5200 + 3, z / 5200 - 1, 3));
  const cones = AKL_CONES.map((c) => ({ ...c, x: c.x * KM, z: c.z * KM }));
  const rg = { ...AKL_RANGITOTO, x: AKL_RANGITOTO.x * KM, z: AKL_RANGITOTO.z * KM };
  const parks = AKL_PARKS.map(([x, z, r]) => ({ x: x * KM, z: z * KM, r: r * KM }));
  const rural = AKL_RURAL.map(([x, z, r]) => ({ x: x * KM, z: z * KM, r: r * KM }));
  const cbd = { x: AKL_CBD.x * KM, z: AKL_CBD.z * KM, r: AKL_CBD.r * KM };
  const linz = map.linz;
  const realCover = !!linz?.cover;
  const lc: CoverSample = { cls: 0, cover: 0 };

  /** Water depth by water body (all negative), continuous (→ 0⁻) at the shoreline. */
  const waterHeight = (x: number, z: number, d: number): number => {
    const label = labelAt(map.labels, map.n, HF_EXTENT, x, z);
    const off = -d; // metres offshore
    // Real bathymetry (chart depth areas); the hand-placed crater lakes keep their bowl profile.
    const real = label === AKL_LABEL.lake || !linz ? null : linzDepth(linz, x, z);
    if (real !== null) return -Math.max(0.3, real);
    let h: number;
    switch (label) {
      case AKL_LABEL.tasman:
        h = -1.5 - 26 * sstep(0, 2200, off) - 70 * sstep(2200, 16_000, off) + 3 * nC.noise(x / 900, z / 900) * sstep(200, 1500, off);
        break;
      case AKL_LABEL.manukau: {
        // Shallow tidal flats cut by winding channels, deeper towards the Heads.
        const ch = 1 - sstep(0, 0.035, Math.abs(channelF.at(x, z)));
        const west = sstep(-9000, -19_000, x);
        h = -0.45 - 2.0 * sstep(0, 900, off) - (4 + 14 * west) * ch * sstep(80, 700, off) - 18 * west * sstep(300, 1500, off);
        break;
      }
      case AKL_LABEL.lake:
        h = -0.5 - 18 * sstep(0, 200, off);
        break;
      default: {
        // Sheltered waters (Waitematā, Tāmaki estuary, Gulf): same law so bodies join seamlessly.
        const upper = sstep(-4000, -9000, x) * (label === AKL_LABEL.waitemata ? 1 : 0);
        const deep = 16 * (1 - upper * 0.7);
        h = -1.0 - deep * sstep(0, 850, off) - 10 * sstep(2500, 9000, off) + 2.5 * nC.noise(x / 2500, z / 2500) * sstep(300, 2000, off);
      }
    }
    return h;
  };

  /**
   * Shore gradient at a point (same smooth function on both sides of the waterline, so the
   * heightfield is linear in the coast distance across the shore and its bilinear contour follows
   * the exact coastline).
   */
  const shoreSlope = (x: number, z: number, K: number): number => {
    const rdx = x - rg.x;
    const rdz = z - rg.z;
    const rr = Math.sqrt(rdx * rdx + rdz * rdz);
    let s = K > 0.3 ? mixf(SHORE_ROCKY, SHORE_CLIFF, sstep(0.5, 0.95, K)) : mixf(SHORE_GENTLE, SHORE_ROCKY, sstep(0.1, 0.0, nB.noise(x / 1800 + 2.2, z / 1800)) * sstep(-18_500, -17_500, x));
    s = mixf(s, SHORE_ROCKY * 1.6, 1 - sstep(rg.r * 1.05, rg.r * 1.2, rr));
    for (let i = 0; i < cones.length; i++) {
      const c = cones[i];
      const dx = x - c.x;
      const dz = z - c.z;
      if (Math.abs(dx) > c.r * 1.2 || Math.abs(dz) > c.r * 1.2) continue;
      s = mixf(s, SHORE_CLIFF, 1 - sstep(c.r * 0.95, c.r * 1.2, Math.sqrt(dx * dx + dz * dz)));
    }
    return s;
  };

  const gen: TheaterGenerator & { raw: (x: number, z: number, out: SampleOut) => number } = {
    edge(x, z) {
      // Ocean all round except the rural south (Pukekohe / Waiuku) and the Hunua foothills.
      const south = sstep(26_000, 34_000, z) * sstep(-24_000, -18_000, x) * (1 - sstep(36_000, 42_000, x));
      return mixf(-45, 70, south);
    },

    raw(x, z, out) {
      out.mat = MAT_NONE;
      out.aux = 0;
      const d = map.coast.at(x, z) + coastPerturb(x, z);
      const K = regionK.at(x, z);
      if (d < 0) {
        // Linear in the coast distance for the first ~60 m offshore, then the body's own profile.
        const off = -d;
        const lin = -shoreSlope(x, z, K) * off;
        return Math.min(-0.005, mixf(lin, waterHeight(x, z, d), sstep(50, 160, off)));
      }

      // ── Land ──
      const hills = nD.eroded(x / 3200, z / 3200, 5);
      let h: number;
      if (linz) {
        // Real ground (LiDAR DEM); a few metres of dry land along the shore like the procedural map.
        h = Math.max(linzHeight(linz, x, z), 0.6 + 2.4 * sstep(0, 120, d));
      } else {
        const R = regionH.at(x, z);
        const ramp = sstep(0, K > 0.3 ? 140 : 380, d);
        h = 1.0 + ramp * R * (0.6 + 0.4 * hills);
        if (K > 0.12) {
          const r = nC.ridged(x / 4800 + 3.3, z / 4800 - 1.7, 5);
          h += ramp * K * R * (r - 0.35) * 0.9;
        }
        h = Math.max(h, 0.6 + 2.4 * sstep(0, 120, d));
      }
      const rocky = nB.noise(x / 1800 + 2.2, z / 1800) <= 0.05 && x > -18_000;

      // Beaches (patchy): black sand on the Tasman coast, golden elsewhere; the rest is rocky/cliffy
      if (d < 70 && h < 5 && (x < -18_000 || !rocky)) {
        out.mat = MAT_BEACH;
        out.aux = x < -18_000 ? 255 : 0;
      }

      // Built-up area
      const ud = map.urban.at(x, z);
      if (ud > -350) {
        // suburbs of detached houses (≤ 0.85); only the CBD fringe reaches apartment density
        let dens = sstep(-350, 500, ud) * (0.62 + 0.23 * nB.noise(x / 1400, z / 1400));
        for (const p of parks) {
          const pd = Math.hypot(x - p.x, z - p.z);
          if (pd < p.r) dens *= sstep(p.r * 0.7, p.r, pd);
        }
        for (const p of rural) {
          const pd = Math.hypot(x - p.x, z - p.z);
          if (pd < p.r + 700) dens *= sstep(p.r, p.r + 700, pd);
        }
        const cd = Math.hypot(x - cbd.x, z - cbd.z);
        if (cd < cbd.r * 1.5) dens = Math.max(dens, 1 - sstep(cbd.r * 0.8, cbd.r * 1.5, cd));
        if (dens > 0.05 && d > 25) {
          out.mat = MAT_URBAN;
          out.aux = Math.min(255, (dens * 255) | 0);
        }
      }

      if (realCover) {
        // Topo50 bush / pine forest / scrub: a forest share over ½ also wins over the hand-traced
        // suburbs (which are only ≈ 350 m accurate), so reserves and the bush-clad fringes stay green.
        linzCover(linz!, x, z, lc);
        if (lc.cover > 0.3 && (out.mat === MAT_NONE || (out.mat === MAT_URBAN && lc.cover > 0.5))) {
          const dens = sstep(0.3, 0.75, lc.cover) * (lc.cls === COVER_SCRUB ? 0.5 : 0.85 + 0.15 * hills);
          out.mat = lc.cls === COVER_EXOTIC ? MAT_PINE : MAT_BUSH;
          out.aux = Math.min(255, (dens * 255) | 0);
        }
      } else {
        // Native bush on the ranges (ragged edges, cleared valleys)
        const bushK = K + 0.22 * nB.fbm(x / 2600 + 4, z / 2600, 3);
        if (bushK > 0.62 && out.mat === MAT_NONE) {
          out.mat = MAT_BUSH;
          out.aux = Math.min(255, (sstep(0.62, 0.85, bushK) * (0.8 + 0.2 * hills) * 255) | 0);
        }
        // Riverhead pine plantation, patchy (felled and replanted blocks)
        const pd = Math.hypot(x - RIVERHEAD_PINES.x, z - RIVERHEAD_PINES.z);
        if (pd < RIVERHEAD_PINES.r && out.mat === MAT_NONE) {
          const pine = (1 - sstep(RIVERHEAD_PINES.r * 0.58, RIVERHEAD_PINES.r, pd)) * sstep(-0.6, -0.2, -nB.noise(x / 2600, z / 2600));
          if (pine > 0.05) {
            out.mat = MAT_PINE;
            out.aux = Math.min(255, (pine * 255) | 0);
          }
        }
      }

      // Scoria cones (grassy parks with craters)
      for (let i = 0; i < cones.length; i++) {
        const c = cones[i];
        const dx = x - c.x;
        const dz = z - c.z;
        if (dx > c.r || dx < -c.r || dz > c.r || dz < -c.r) continue;
        const cd = Math.sqrt(dx * dx + dz * dz);
        if (cd >= c.r) continue;
        if (linz) {
          // Real cone in the DEM: only the grassy-park material.
          if (cd < c.r * 0.85) {
            out.mat = MAT_CONE;
            out.aux = 0;
          }
          continue;
        }
        let ch: number;
        if (c.cr > 0 && cd < c.cr) ch = c.h - c.cd * (1 - (cd / c.cr) * (cd / c.cr));
        else ch = c.h * Math.pow(1 - (cd - c.cr) / (c.r - c.cr), 1.15);
        ch += 4 * nC.noise(x / 150, z / 150);
        if (ch > h) {
          h = ch;
          out.mat = MAT_CONE;
          out.aux = 0;
        }
      }

      // Rangitoto: symmetric basalt shield (gentle lava flanks + steeper summit scoria cone with
      // twin craters), pōhutukawa bush over black lava fields right down to a black rocky shore.
      {
        const dx = x - rg.x;
        const dz = z - rg.z;
        const rd = Math.sqrt(dx * dx + dz * dz);
        if (rd < rg.r * 1.12) {
          const t = Math.min(1, rd / rg.r);
          let sh = 172 * Math.pow(1 - t, 1.35) + 4;
          const rc = 680;
          if (rd < rc) sh += (rg.h - 176) * Math.pow(1 - rd / rc, 1.1);
          if (rd < rg.cr) sh -= rg.cd * (1 - (rd / rg.cr) * (rd / rg.cr));
          // secondary crater on the NE rim
          const sx = dx - 150;
          const sz = dz + 110;
          const s2 = sx * sx + sz * sz;
          if (s2 < 70 * 70) sh -= 18 * (1 - s2 / (70 * 70));
          sh += 4 * nB.noise(x / 300, z / 300) * (1 - t);
          if (sh > h && !linz) h = sh;
          out.mat = MAT_VOLCANIC;
          // aux: bush cover (lava fields show through in lobes running down the flanks)
          const lobes = nA.noise(x / 700, z / 700) * 0.6 + nA.noise(x / 230 + 4.1, z / 230) * 0.4;
          out.aux = Math.min(255, Math.max(0, ((0.62 + 0.55 * lobes) * 255) | 0));
        }
      }

      // Continuous shoreline: exactly slope·distance for the first ~60 m inland (same slope as the
      // water side), then the terrain's own profile.
      const lin = shoreSlope(x, z, K) * d;
      return mixf(lin, h, sstep(50, 160, d));
    },

    height(x, z, out) {
      return gen.raw(x, z, out);
    },
  };
  return gen;
}
