/**
 * ISLANDS theatre — deep ocean with an archipelago: big volcanic islands (crater, radial gullies,
 * jungle slopes), hilly islands, low coral islands and atolls, all ringed by fringing reefs and
 * turquoise shallows. Every mission feature / pad cluster gets an island under it so airfields and
 * SAM sites always stand on dry land.
 */
import { mulberry32 } from '../../../core/math';
import { Noise2D, sstep, mixf } from '../noise';
import {
  MAT_BEACH,
  MAT_JUNGLE,
  MAT_NONE,
  MAT_REEF,
  MAT_VOLCANIC,
  type Anchor,
  type SampleOut,
  type TheaterGenerator,
} from '../types';

const enum Kind {
  Volcanic,
  Hilly,
  Low,
  Atoll,
}

interface Island {
  x: number;
  z: number;
  r: number;
  peak: number;
  kind: Kind;
}

/** Group anchors closer than `gap` into clusters (single linkage). */
function clusterAnchors(anchors: Anchor[], gap: number): Anchor[][] {
  const groups: Anchor[][] = [];
  const used = new Array(anchors.length).fill(false);
  for (let i = 0; i < anchors.length; i++) {
    if (used[i]) continue;
    const g = [anchors[i]];
    used[i] = true;
    for (let k = 0; k < g.length; k++) {
      for (let j = 0; j < anchors.length; j++) {
        if (used[j]) continue;
        const d = Math.hypot(anchors[j].x - g[k].x, anchors[j].z - g[k].z) - anchors[j].r - g[k].r;
        if (d < gap) {
          used[j] = true;
          g.push(anchors[j]);
        }
      }
    }
    groups.push(g);
  }
  return groups;
}

export function createIslands(seed: number, anchors: Anchor[]): TheaterGenerator {
  const nA = new Noise2D(seed * 11 + 1);
  const nB = new Noise2D(seed * 11 + 2);
  const nC = new Noise2D(seed * 11 + 3);
  const nD = new Noise2D(seed * 11 + 4);
  const rnd = mulberry32(seed + 202);
  const islands: Island[] = [];

  // 1) Islands under mission features / pads.
  for (const g of clusterAnchors(anchors, 5000)) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const a of g) {
      minX = Math.min(minX, a.x - a.r);
      maxX = Math.max(maxX, a.x + a.r);
      minZ = Math.min(minZ, a.z - a.r);
      maxZ = Math.max(maxZ, a.z + a.r);
    }
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    const half = Math.hypot(maxX - minX, maxZ - minZ) / 2;
    const big = half > 2500;
    islands.push({ x: cx, z: cz, r: half * 1.25 + 2600, peak: big ? 260 + rnd() * 380 : 60 + rnd() * 120, kind: big ? Kind.Hilly : Kind.Hilly });
  }

  // 2) Random islands: one or two big volcanoes, some hilly islands, low cays and an atoll.
  const wanted: { kind: Kind; r: [number, number]; peak: [number, number] }[] = [
    { kind: Kind.Volcanic, r: [7500, 10_500], peak: [1400, 1850] },
    { kind: Kind.Volcanic, r: [4500, 6500], peak: [700, 1100] },
    { kind: Kind.Hilly, r: [3500, 6000], peak: [250, 600] },
    { kind: Kind.Hilly, r: [2500, 4200], peak: [150, 380] },
    { kind: Kind.Atoll, r: [2200, 3200], peak: [3, 5] },
    { kind: Kind.Low, r: [1200, 2200], peak: [8, 18] },
    { kind: Kind.Low, r: [900, 1600], peak: [6, 14] },
    { kind: Kind.Hilly, r: [1800, 3000], peak: [90, 220] },
  ];
  for (const w of wanted) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const r = w.r[0] + rnd() * (w.r[1] - w.r[0]);
      const x = (rnd() * 2 - 1) * (34_000 - r);
      const z = (rnd() * 2 - 1) * (34_000 - r);
      const ok = islands.every((o) => Math.hypot(o.x - x, o.z - z) > o.r + r + 2500);
      if (ok) {
        islands.push({ x, z, r, peak: w.peak[0] + rnd() * (w.peak[1] - w.peak[0]), kind: w.kind });
        break;
      }
    }
  }

  const count = islands.length;
  const ix = new Float64Array(count);
  const iz = new Float64Array(count);
  const ir = new Float64Array(count);
  const inv = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    ix[i] = islands[i].x;
    iz[i] = islands[i].z;
    ir[i] = islands[i].r;
    inv[i] = 1 / islands[i].r;
  }

  return {
    edge: () => -520,

    height(x, z, out: SampleOut) {
      out.mat = MAT_NONE;
      out.aux = 0;
      // Domain warp (fractions of the island radius) for irregular coastlines.
      const wx = nA.fbm(x / 11_000, z / 11_000, 3);
      const wz = nA.fbm(x / 11_000 + 5.2, z / 11_000 + 1.3, 3);
      let best = -9;
      let bi = -1;
      for (let i = 0; i < count; i++) {
        const dx = (x - ix[i]) * inv[i] + wx * 0.38;
        const dz = (z - iz[i]) * inv[i] + wz * 0.38;
        const d2 = dx * dx + dz * dz;
        if (d2 > 4.5) continue;
        let e = 1 - Math.sqrt(d2);
        if (islands[i].kind === Kind.Atoll) e = 0.22 - Math.abs(Math.sqrt(d2) - 0.78) * 1.4;
        if (e > best) {
          best = e;
          bi = i;
        }
      }
      if (bi < 0 || best < -1.1) {
        return -520 + 90 * nC.fbm(x / 18_000, z / 18_000, 2);
      }
      const isl = islands[bi];
      const cn = 0.1 * nB.fbm(x / 2600, z / 2600, 3);
      const e = best + cn;

      if (e < 0) {
        // Underwater: lagoon → fringing reef → drop-off to the abyss.
        const t = -e;
        let h: number;
        const reef = 1 - sstep(0.0, 0.035, Math.abs(t - 0.1 - 0.02 * nD.noise(x / 900, z / 900)));
        if (t < 0.16) {
          h = -2.5 - 6 * sstep(0.0, 0.08, t) + 1.5 * nD.noise(x / 700, z / 700);
          h = mixf(h, -0.6 + 0.8 * nC.noise(x / 300, z / 300), reef);
          if (reef > 0.4) out.mat = MAT_REEF;
        } else {
          h = -7 - 520 * Math.pow(sstep(0.16, 1.1, t), 1.3);
        }
        if (isl.kind === Kind.Atoll) {
          // inside of the ring: lagoon
          const dd = Math.hypot((x - isl.x) * inv[bi] + wx * 0.38, (z - isl.z) * inv[bi] + wz * 0.38);
          if (dd < 0.78) h = Math.max(h, -9 + 3 * nD.noise(x / 800, z / 800));
        }
        return h;
      }

      // Land
      let h = 3.2 * sstep(0, 0.045, e); // beach ramp
      if (e < 0.05) out.mat = MAT_BEACH;
      const land = sstep(0.02, 0.35, e);
      switch (isl.kind) {
        case Kind.Volcanic: {
          const r = nC.ridged(x / 3800, z / 3800, 5);
          const cone = Math.pow(Math.min(1, e / 0.92), 1.35);
          // radial gullies
          const ang = Math.atan2(z - isl.z, x - isl.x);
          const gully = 0.5 + 0.5 * Math.sin(ang * 23 + 4 * nA.noise(x / 2500, z / 2500));
          h += isl.peak * cone * (0.72 + 0.4 * r) * (0.9 + 0.1 * gully) * land;
          if (e > 0.86) h -= isl.peak * 0.22 * sstep(0.86, 0.97, e); // summit crater
          h += 60 * land * nD.eroded(x / 5000, z / 5000, 4);
          if (e > 0.62) {
            out.mat = MAT_VOLCANIC;
            out.aux = (sstep(0.62, 0.85, e) * 255) | 0;
          } else if (e > 0.05) {
            out.mat = MAT_JUNGLE;
            out.aux = (sstep(0.05, 0.25, e) * (1 - sstep(0.45, 0.62, e)) * 255) | 0;
          }
          break;
        }
        case Kind.Hilly: {
          const er = nC.eroded(x / 5200 + 3, z / 5200 - 7, 6);
          h += isl.peak * land * (0.35 + 0.65 * sstep(0.0, 0.7, e)) * (0.55 + 0.6 * er);
          if (e > 0.05) {
            out.mat = MAT_JUNGLE;
            out.aux = Math.min(255, (sstep(0.05, 0.2, e) * (0.55 + 0.45 * nB.noise(x / 3000, z / 3000)) * 255) | 0);
          }
          break;
        }
        case Kind.Low:
        case Kind.Atoll: {
          h += isl.peak * land * (0.6 + 0.4 * nD.noise(x / 900, z / 900));
          if (e > 0.08) {
            out.mat = MAT_JUNGLE;
            out.aux = 120;
          }
          break;
        }
      }
      return h;
    },
  };
}
