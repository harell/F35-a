/**
 * ISLANDS theatre — deep ocean with an archipelago: big volcanic islands (crater, radial gullies,
 * jungle slopes), hilly islands, low coral cays and an atoll, all ringed by fringing reefs and
 * turquoise shallows. Every mission feature / pad cluster gets an island under it so airfields and
 * SAM sites always stand on dry land.
 */
import { mulberry32 } from '../../../core/math';
import { Noise2D, sstep, mixf } from '../noise';
import { CoarseField } from '../coarse';
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

/** One elliptical lobe of an island (islands are unions of 1–3 lobes). */
interface Lobe {
  x: number;
  z: number;
  cos: number;
  sin: number;
  irx: number;
  irz: number;
  peak: number;
  kind: Kind;
  /** Bounding radius (m) for early-out. */
  reach2: number;
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
  const centres: { x: number; z: number; r: number }[] = [];
  const lobes: Lobe[] = [];

  const addIsland = (x: number, z: number, r: number, peak: number, kind: Kind, extraLobes: number) => {
    centres.push({ x, z, r });
    const rot = rnd() * Math.PI;
    const elong = kind === Kind.Atoll ? 1 : 0.62 + rnd() * 0.38;
    const mk = (lx: number, lz: number, rx: number, rz: number, a: number, pk: number, k: Kind) => {
      const reach = Math.max(rx, rz) * 2.3;
      lobes.push({ x: lx, z: lz, cos: Math.cos(a), sin: Math.sin(a), irx: 1 / rx, irz: 1 / rz, peak: pk, kind: k, reach2: reach * reach });
    };
    mk(x, z, r, r * elong, rot, peak, kind);
    for (let i = 0; i < extraLobes; i++) {
      const a = rnd() * Math.PI * 2;
      const d = r * (0.55 + rnd() * 0.4);
      const lr = r * (0.3 + rnd() * 0.3);
      mk(x + Math.cos(a) * d, z + Math.sin(a) * d, lr, lr * (0.55 + rnd() * 0.45), rnd() * Math.PI, peak * (0.25 + rnd() * 0.3), kind === Kind.Volcanic ? Kind.Hilly : kind);
    }
  };

  // 1) Islands under mission features / pads.
  for (const g of clusterAnchors(anchors, 5000)) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const a of g) {
      minX = Math.min(minX, a.x - a.r);
      maxX = Math.max(maxX, a.x + a.r);
      minZ = Math.min(minZ, a.z - a.r);
      maxZ = Math.max(maxZ, a.z + a.r);
    }
    const half = Math.hypot(maxX - minX, maxZ - minZ) / 2;
    const big = half > 2500;
    addIsland((minX + maxX) / 2, (minZ + maxZ) / 2, half * 1.3 + 2800, big ? 260 + rnd() * 380 : 70 + rnd() * 140, Kind.Hilly, big ? 2 : 1);
    // make sure the main lobe is round enough to cover the cluster
    const l = lobes[lobes.length - 1 - (big ? 2 : 1)];
    l.irz = l.irx;
  }

  // 2) Random islands: two volcanoes, hilly islands, low cays and an atoll.
  const wanted: { kind: Kind; r: [number, number]; peak: [number, number]; lobes: number }[] = [
    { kind: Kind.Volcanic, r: [7000, 9500], peak: [1450, 1850], lobes: 2 },
    { kind: Kind.Volcanic, r: [4200, 6000], peak: [750, 1150], lobes: 1 },
    { kind: Kind.Hilly, r: [3500, 5500], peak: [250, 600], lobes: 2 },
    { kind: Kind.Hilly, r: [2500, 4000], peak: [150, 380], lobes: 2 },
    { kind: Kind.Atoll, r: [2200, 3200], peak: [3, 5], lobes: 0 },
    { kind: Kind.Low, r: [1100, 2000], peak: [8, 18], lobes: 1 },
    { kind: Kind.Low, r: [800, 1500], peak: [6, 14], lobes: 1 },
    { kind: Kind.Hilly, r: [1800, 2800], peak: [90, 220], lobes: 1 },
  ];
  for (const w of wanted) {
    for (let attempt = 0; attempt < 80; attempt++) {
      const r = w.r[0] + rnd() * (w.r[1] - w.r[0]);
      const x = (rnd() * 2 - 1) * (33_000 - r);
      const z = (rnd() * 2 - 1) * (33_000 - r);
      const ok = centres.every((o) => Math.hypot(o.x - x, o.z - z) > (o.r + r) * 1.25 + 2500);
      if (ok) {
        addIsland(x, z, r, w.peak[0] + rnd() * (w.peak[1] - w.peak[0]), w.kind, w.lobes);
        break;
      }
    }
  }

  const count = lobes.length;
  const warpX = new CoarseField((x, z) => nA.fbm(x / 11_000, z / 11_000, 3));
  const warpZ = new CoarseField((x, z) => nA.fbm(x / 11_000 + 5.2, z / 11_000 + 1.3, 3));
  const coastBig = new CoarseField((x, z) => 0.16 * nB.fbm(x / 4200, z / 4200, 2));
  const abyss = new CoarseField((x, z) => 90 * nC.fbm(x / 18_000, z / 18_000, 2));

  return {
    edge: () => -520,

    height(x, z, out: SampleOut) {
      out.mat = MAT_NONE;
      out.aux = 0;
      const wx = warpX.at(x, z) * 0.45;
      const wz = warpZ.at(x, z) * 0.45;
      let best = -9;
      let bi = -1;
      for (let i = 0; i < count; i++) {
        const L = lobes[i];
        const dx = x - L.x;
        const dz = z - L.z;
        if (dx * dx + dz * dz > L.reach2) continue;
        const u = (dx * L.cos + dz * L.sin) * L.irx + wx;
        const v = (-dx * L.sin + dz * L.cos) * L.irz + wz;
        const d = Math.sqrt(u * u + v * v);
        const e = L.kind === Kind.Atoll ? 0.2 - Math.abs(d - 0.8) * 1.3 : 1 - d;
        if (e > best) {
          best = e;
          bi = i;
        }
      }
      if (bi < 0 || best < -1.05) return -520 + abyss.at(x, z);
      const L = lobes[bi];
      const e = best + coastBig.at(x, z) + 0.05 * nB.noise(x / 1100, z / 1100);

      if (e < 0) {
        // Underwater: lagoon → fringing reef → steep drop-off to the abyss.
        const t = -e;
        let h: number;
        if (t < 0.15) {
          const s0 = sstep(0, 0.03, t);
          h = -0.3 - 2.2 * s0 - 5 * sstep(0.02, 0.07, t) + 1.5 * s0 * nD.noise(x / 700, z / 700);
          const reef = 1 - sstep(0.0, 0.03, Math.abs(t - 0.095 - 0.02 * nD.noise(x / 900, z / 900)));
          h = mixf(h, -0.5 + 0.8 * nC.noise(x / 300, z / 300), reef);
          if (reef > 0.4) out.mat = MAT_REEF;
        } else {
          h = -7 - 513 * Math.pow(sstep(0.15, 0.75, t), 1.15) + abyss.at(x, z) * sstep(0.4, 1, t);
        }
        if (L.kind === Kind.Atoll && t < 0.5) {
          const dx = x - L.x;
          const dz = z - L.z;
          const u = (dx * L.cos + dz * L.sin) * L.irx + wx;
          const v = (-dx * L.sin + dz * L.cos) * L.irz + wz;
          if (Math.sqrt(u * u + v * v) < 0.8) h = Math.max(h, -9 + 3 * nD.noise(x / 800, z / 800));
        }
        return h;
      }

      // Land
      let h = 3.2 * sstep(0, 0.045, e); // beach ramp
      if (e < 0.05) out.mat = MAT_BEACH;
      const land = sstep(0.02, 0.35, e);
      switch (L.kind) {
        case Kind.Volcanic: {
          const r = nC.ridged(x / 3800, z / 3800, 5);
          const cone = Math.pow(Math.min(1, e / 0.92), 1.35);
          const ang = Math.atan2(z - L.z, x - L.x);
          const gully = 0.5 + 0.5 * Math.sin(ang * 23 + 4 * nA.noise(x / 2500, z / 2500));
          h += L.peak * cone * (0.72 + 0.4 * r) * (0.88 + 0.12 * gully) * land;
          if (e > 0.86) h -= L.peak * 0.22 * sstep(0.86, 0.97, e); // summit crater
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
          const er = nC.eroded(x / 5200 + 3, z / 5200 - 7, 5);
          h += L.peak * land * (0.35 + 0.65 * sstep(0.0, 0.7, e)) * (0.55 + 0.6 * er);
          if (e > 0.05) {
            out.mat = MAT_JUNGLE;
            out.aux = Math.min(255, (sstep(0.05, 0.2, e) * (0.55 + 0.45 * nB.noise(x / 3000, z / 3000)) * 255) | 0);
          }
          break;
        }
        case Kind.Low:
        case Kind.Atoll: {
          h += L.peak * land * (0.6 + 0.4 * nD.noise(x / 900, z / 900));
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
