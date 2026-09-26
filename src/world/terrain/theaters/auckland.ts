/**
 * AUCKLAND theatre (primary) — a stylised but recognisable Tāmaki Makaurau: the Waitematā and
 * Manukau harbours, Tāmaki estuary, Hauraki Gulf islands (Rangitoto's perfect shield cone,
 * Motutapu, Waiheke…), the isthmus with its scoria cones (Mt Eden, One Tree Hill…), the bush-clad
 * Waitākere and Hunua ranges, and the Tasman coast. Coastlines come from hand-traced polygons
 * (aucklandMap.ts) turned into a signed distance field; relief is procedural within mapped regions.
 */
import { Noise2D, sstep, mixf } from '../noise';
import { CoarseField } from '../coarse';
import { fillEllipse, fillPolygon, GridSampler, labelAt, signedDistance, type GridSpec } from '../raster';
import {
  HF_EXTENT,
  MAT_BEACH,
  MAT_BUSH,
  MAT_CONE,
  MAT_NONE,
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
  AKL_URBAN,
  AKL_WATER,
} from './aucklandMap';

const KM = 1000;
const MAP_N = 1024;

export interface AucklandMapData {
  labels: Uint8Array;
  coast: GridSampler;
  urban: GridSampler;
  n: number;
}

let cached: AucklandMapData | null = null;

/** Rasterised map (labels + coast / urban signed distance). Cached: it doesn't depend on the seed. */
export function aucklandMapData(): AucklandMapData {
  if (cached) return cached;
  const g: GridSpec = { n: MAP_N, extent: HF_EXTENT };
  const labels = new Uint8Array(MAP_N * MAP_N).fill(AKL_LABEL.land);
  const km = (pts: number[]) => pts.map((v) => v * KM);
  for (const w of AKL_WATER) fillPolygon(labels, g, km(w.pts), w.label);
  for (const isl of AKL_ISLANDS) {
    if ('pts' in isl) fillPolygon(labels, g, km(isl.pts), AKL_LABEL.land);
    else {
      const [cx, cz, rx, rz, rot] = isl.ellipse;
      fillEllipse(labels, g, cx * KM, cz * KM, rx * KM, rz * KM, rot, AKL_LABEL.land);
    }
  }
  for (const [cx, cz, r] of AKL_LAKES) fillEllipse(labels, g, cx * KM, cz * KM, r * KM, r * KM, 0, AKL_LABEL.lake);
  const coast = new GridSampler(signedDistance(labels, g, (l) => l === AKL_LABEL.land), MAP_N, HF_EXTENT);

  const urbanLabels = new Uint8Array(MAP_N * MAP_N);
  for (const poly of AKL_URBAN) fillPolygon(urbanLabels, g, km(poly), 1);
  const urban = new GridSampler(signedDistance(urbanLabels, g, (l) => l === 1), MAP_N, HF_EXTENT);
  cached = { labels, coast, urban, n: MAP_N };
  return cached;
}

function ellipseDist(e: [number, number, number, number, number], x: number, z: number): number {
  const dx = x - e[0] * KM;
  const dz = z - e[1] * KM;
  const c = Math.cos(e[4]);
  const s = Math.sin(e[4]);
  const u = (dx * c + dz * s) / (e[2] * KM);
  const v = (-dx * s + dz * c) / (e[3] * KM);
  return Math.sqrt(u * u + v * v);
}

export function createAuckland(seed: number): TheaterGenerator {
  const map = aucklandMapData();
  const nA = new Noise2D(seed * 29 + 1);
  const nB = new Noise2D(seed * 29 + 2);
  const nC = new Noise2D(seed * 29 + 3);
  const nD = new Noise2D(seed * 29 + 4);

  // Regional base height and roughness (max over noise-warped relief ellipses).
  const warpX = new CoarseField((x, z) => 2600 * nA.fbm(x / 9000 + 7.1, z / 9000, 3));
  const warpZ = new CoarseField((x, z) => 2600 * nA.fbm(x / 9000 - 3.3, z / 9000 + 5.5, 3));
  const regionH = new CoarseField((x, z) => {
    const wx = x + warpX.at(x, z);
    const wz = z + warpZ.at(x, z);
    let r = 14;
    for (const reg of AKL_RELIEF) r = Math.max(r, reg.h * (1 - sstep(0.5, 1.3, ellipseDist(reg.e, wx, wz))));
    return r;
  });
  const regionK = new CoarseField((x, z) => {
    const wx = x + warpX.at(x, z);
    const wz = z + warpZ.at(x, z);
    let k = 0.08;
    for (const reg of AKL_RELIEF) k = Math.max(k, reg.rough * (1 - sstep(0.5, 1.3, ellipseDist(reg.e, wx, wz))));
    return k;
  });
  const coastNoise = new CoarseField((x, z) => 110 * nA.fbm(x / 2200, z / 2200, 3));
  const channelF = new CoarseField((x, z) => nB.fbm(x / 5200 + 3, z / 5200 - 1, 3));
  const cones = AKL_CONES.map((c) => ({ ...c, x: c.x * KM, z: c.z * KM }));
  const rg = { ...AKL_RANGITOTO, x: AKL_RANGITOTO.x * KM, z: AKL_RANGITOTO.z * KM };
  const parks = AKL_PARKS.map(([x, z, r]) => ({ x: x * KM, z: z * KM, r: r * KM }));
  const cbd = { x: AKL_CBD.x * KM, z: AKL_CBD.z * KM, r: AKL_CBD.r * KM };

  /** Water depth by water body (all negative). */
  const waterHeight = (x: number, z: number, d: number): number => {
    const label = labelAt(map.labels, map.n, HF_EXTENT, x, z);
    const off = -d; // metres offshore
    switch (label) {
      case AKL_LABEL.tasman:
        return -1.5 - 26 * sstep(0, 2200, off) - 70 * sstep(2200, 16_000, off) + 3 * nC.noise(x / 900, z / 900) * sstep(200, 1500, off);
      case AKL_LABEL.manukau: {
        // Shallow tidal flats cut by winding channels, deeper towards the Heads.
        const ch = 1 - sstep(0, 0.035, Math.abs(channelF.at(x, z)));
        const west = sstep(-9000, -19_000, x);
        return -0.45 - 2.0 * sstep(0, 900, off) - (4 + 14 * west) * ch * sstep(80, 700, off) - 18 * west * sstep(300, 1500, off);
      }
      case AKL_LABEL.lake:
        return -0.5 - 18 * sstep(0, 200, off);
      default: {
        // Sheltered waters (Waitematā, Tāmaki estuary, Gulf): same law so bodies join seamlessly.
        const upper = sstep(-4000, -9000, x) * (label === AKL_LABEL.waitemata ? 1 : 0);
        const deep = 16 * (1 - upper * 0.7);
        return -1.0 - deep * sstep(0, 850, off) - 10 * sstep(2500, 9000, off) + 2.5 * nC.noise(x / 2500, z / 2500) * sstep(300, 2000, off);
      }
    }
  };

  return {
    edge(x, z) {
      // Ocean all round except the rural south (Pukekohe / Waiuku) and the Hunua foothills.
      const south = sstep(26_000, 34_000, z) * sstep(-24_000, -18_000, x) * (1 - sstep(36_000, 42_000, x));
      return mixf(-45, 70, south);
    },

    height(x, z, out: SampleOut) {
      out.mat = MAT_NONE;
      out.aux = 0;
      const d = map.coast.at(x, z) + coastNoise.at(x, z) + 28 * nD.noise(x / 420, z / 420);
      if (d < 0) {
        const h = waterHeight(x, z, d);
        return Math.min(h, -0.3);
      }

      // ── Land ──
      const R = regionH.at(x, z);
      const K = regionK.at(x, z);
      const ramp = sstep(0, K > 0.3 ? 140 : 380, d);
      const hills = nD.eroded(x / 3200, z / 3200, 5);
      let h = 1.0 + ramp * R * (0.6 + 0.4 * hills);
      if (K > 0.12) {
        const r = nC.ridged(x / 4800 + 3.3, z / 4800 - 1.7, 5);
        h += ramp * K * R * (r - 0.35) * 0.9;
      }
      h = Math.max(h, 0.6 + 2.4 * sstep(0, 120, d));

      // Beaches (patchy): black sand on the Tasman coast, golden elsewhere; the rest is rocky/cliffy
      if (d < 70 && h < 5 && (x < -18_000 || nB.noise(x / 1800 + 2.2, z / 1800) > 0.05)) {
        out.mat = MAT_BEACH;
        out.aux = x < -18_000 ? 255 : 0;
      }

      // Built-up area
      const ud = map.urban.at(x, z);
      if (ud > -350) {
        let dens = sstep(-350, 500, ud) * (0.75 + 0.25 * nB.noise(x / 1400, z / 1400));
        for (const p of parks) {
          const pd = Math.hypot(x - p.x, z - p.z);
          if (pd < p.r) dens *= sstep(p.r * 0.7, p.r, pd);
        }
        const cd = Math.hypot(x - cbd.x, z - cbd.z);
        if (cd < cbd.r * 1.5) dens = Math.max(dens, 1 - sstep(cbd.r * 0.8, cbd.r * 1.5, cd));
        if (dens > 0.05 && d > 40) {
          out.mat = MAT_URBAN;
          out.aux = Math.min(255, (dens * 255) | 0);
        }
      }

      // Native bush on the ranges (ragged edges, cleared valleys)
      const bushK = K + 0.22 * nB.fbm(x / 2600 + 4, z / 2600, 3);
      if (bushK > 0.62 && out.mat === MAT_NONE) {
        out.mat = MAT_BUSH;
        out.aux = Math.min(255, (sstep(0.62, 0.85, bushK) * (0.8 + 0.2 * hills) * 255) | 0);
      }

      // Scoria cones (grassy parks with craters)
      for (let i = 0; i < cones.length; i++) {
        const c = cones[i];
        const dx = x - c.x;
        const dz = z - c.z;
        if (dx > c.r || dx < -c.r || dz > c.r || dz < -c.r) continue;
        const cd = Math.sqrt(dx * dx + dz * dz);
        if (cd >= c.r) continue;
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

      // Rangitoto: symmetric basalt shield, bush over black lava, summit crater
      {
        const dx = x - rg.x;
        const dz = z - rg.z;
        const rd = Math.sqrt(dx * dx + dz * dz);
        if (rd < rg.r * 1.1) {
          const t = Math.min(1, rd / rg.r);
          let sh = rg.h * Math.pow(1 - t, 1.55) + 3;
          if (rd < rg.cr) sh -= rg.cd * (1 - (rd / rg.cr) * (rd / rg.cr));
          sh += 5 * nB.noise(x / 300, z / 300) * (1 - t);
          if (sh > h) h = sh;
          if (d > 30) {
            out.mat = MAT_VOLCANIC;
            out.aux = Math.min(255, ((0.55 + 0.45 * nA.noise(x / 700, z / 700)) * 255) | 0);
          }
        }
      }
      return h;
    },
  };
}
