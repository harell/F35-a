/**
 * DESERT theatre — Arabian-Gulf style: a shallow gulf with shoals and sandbank islets on the east,
 * sabkha salt flats along the coast, gravel plains rising westward, a sand sea of linear dunes,
 * mesas with terraced cliffs, dry wadis, and a rugged Hajar-like range in the west.
 */
import { Noise2D, mulberry32, sstep, mixf } from '../noise';
import { CoarseField } from '../coarse';
import { MAT_DUNE, MAT_MESA, MAT_NONE, MAT_ROCKY, MAT_SALT, MAT_WADI, MAT_BEACH, type SampleOut, type TheaterGenerator } from '../types';

export function createDesert(seed: number): TheaterGenerator {
  const nA = new Noise2D(seed * 7 + 1);
  const nB = new Noise2D(seed * 7 + 2);
  const nC = new Noise2D(seed * 7 + 3);
  const nD = new Noise2D(seed * 7 + 4);
  const rnd = mulberry32(seed + 101);
  const coastX = 15_000 + rnd() * 5_000;
  const duneAng = 0.35 + rnd() * 0.5;
  const dcos = Math.cos(duneAng);
  const dsin = Math.sin(duneAng);
  const mtnX = -17_000 - rnd() * 5_000;

  // ── Smooth (coarse) fields ──
  /** Signed distance-ish to the coast: > 0 = gulf side. */
  const coast = new CoarseField((x, z) => x - coastX + 5500 * nA.fbm(z / 24_000 + 3.1, 0.7, 3) + 1800 * nA.noise(z / 6500, x / 6500 + 9));
  const regionalNoise = new CoarseField((x, z) => 70 * nB.fbm(x / 30_000, z / 30_000, 2) + 22 * nD.fbm(x / 7000, z / 7000, 3));
  const mMaskF = new CoarseField((x, z) => sstep(mtnX + 9000, mtnX - 6000, x + 7000 * nB.noise(z / 20_000, 5.5)));
  const mtnLow = new CoarseField((x, z) => 300 * nA.fbm(x / 14_000, z / 14_000, 2) + 2500 * nD.fbm(x / 9000, z / 9000, 2));
  const meRegionF = new CoarseField((x, z) => sstep(0.05, 0.35, nA.fbm(x / 22_000 - 7, z / 22_000 + 3, 2)));
  const sandF = new CoarseField((x, z) => sstep(-0.05, 0.3, nB.fbm(x / 32_000 + 11, z / 32_000, 2)));
  const duneWarp = new CoarseField((x, z) => 1.9 * nA.fbm(x / 9000, z / 9000, 2));
  const duneAmp = new CoarseField((x, z) => 16 + 26 * (0.5 + 0.5 * nC.noise(x / 6000, z / 6000)));
  const wadiF = new CoarseField((x, z) => nB.fbm(x / 15_000 + 4.4, z / 15_000 - 2.2, 3) + 0.22 * nA.noise(x / 3200, z / 3200));
  const saltF = new CoarseField((x, z) => nC.fbm(x / 6000 + 2, z / 6000 + 8, 3));
  const mesaCap = new CoarseField((x, z) => 50 * nB.noise(x / 3000, z / 3000));

  const regional = (inland: number, x: number, z: number) =>
    4 + Math.min(Math.max(0, inland), 60_000) * 0.0068 + regionalNoise.at(x, z) * sstep(0, 8000, inland);

  /** Gulf floor with shoals and sandbank islets. */
  const seaFloor = (x: number, z: number, c: number) => {
    const depth = 3 + Math.min(34, Math.max(0, c - 1800) / 260);
    const shoal = nC.fbm(x / 5200, z / 5200, 4);
    let h = -depth + 12 * shoal + 4 * nD.noise(x / 1400, z / 1400);
    if (shoal > 0.42) h = Math.max(h, (shoal - 0.42) * 70 - 1);
    return h;
  };

  return {
    edge(x, z) {
      const c = x - coastX;
      return mixf(4 + Math.min(Math.max(0, -c), 60_000) * 0.0068, -28, sstep(-3000, 4000, c));
    },

    height(x, z, out: SampleOut) {
      out.mat = MAT_NONE;
      out.aux = 0;
      const c = coast.at(x, z);
      const inland = -c;

      // ── Gulf ──
      if (c > 1800) {
        const h = seaFloor(x, z, c);
        if (h > -0.5 && h < 3) out.mat = MAT_BEACH;
        return h;
      }

      let h = regional(inland, x, z);

      // ── Western mountains (Hajar-like) ──
      const mMask = mMaskF.at(x, z);
      if (mMask > 0.002) {
        const low = mtnLow.at(x, z);
        const r = nC.ridged((x + low) / 12_000, z / 9000, 6);
        h += mMask * (180 + r * r * 2100 + low * 0.12);
        if (mMask > 0.4 && r > 0.35) {
          out.mat = MAT_ROCKY;
          out.aux = Math.min(255, (mMask * (r - 0.2) * 3 * 255) | 0);
        }
      }

      // ── Inselbergs / jebels scattered over the plain ──
      if (mMask < 0.95) {
        const jb = nA.ridged(x / 6000 + 40, z / 6000 - 12, 4);
        const jMask = sstep(0.62, 0.8, jb) * (1 - mMask);
        if (jMask > 0) {
          h += jMask * 260 * (0.6 + 0.4 * nD.noise(x / 1500, z / 1500));
          out.mat = MAT_ROCKY;
          out.aux = (jMask * 200) | 0;
        }
      }

      // ── Mesas with terraced cliffs ──
      const meRegion = meRegionF.at(x, z) * (1 - mMask) * sstep(4000, 12_000, inland);
      if (meRegion > 0.002) {
        const m = nC.fbm(x / 5200 + 11, z / 5200 - 5, 4);
        const p1 = sstep(0.16, 0.22, m);
        const p2 = sstep(0.36, 0.41, m);
        h += meRegion * (p1 * (120 + mesaCap.at(x, z)) + p2 * 70);
        if (p1 > 0.05) {
          out.mat = MAT_MESA;
          out.aux = Math.min(255, (meRegion * (0.4 + 0.6 * p1) * 255) | 0);
        }
      }

      // ── Sand sea: linear dunes aligned with the prevailing wind ──
      const sMask = sandF.at(x, z) * (1 - mMask) * (1 - meRegion * 0.8) * sstep(5000, 14_000, inland);
      if (sMask > 0.01) {
        const phase = (x * dcos + z * dsin) / 1150 + duneWarp.at(x, z);
        const p = phase - Math.floor(phase);
        const prof = p < 0.72 ? sstep(0, 0.72, p) : 1 - sstep(0.72, 1, p);
        const crest = 0.65 + 0.35 * nD.noise(x / 1700 + 3, z / 1700);
        h += sMask * duneAmp.at(x, z) * prof * crest + sMask * 25;
        if (out.mat === MAT_NONE || sMask > 0.5) {
          out.mat = MAT_DUNE;
          out.aux = Math.min(255, (sMask * 255) | 0);
        }
      }

      // ── Wadis: dry channels, deeper as canyons in the mountains ──
      const wv = Math.abs(wadiF.at(x, z));
      const ch = (1 - sstep(0.0, 0.032, wv)) * sstep(1500, 5000, inland) * (1 - sMask * 0.85);
      if (ch > 0.01) {
        h -= ch * (10 + 90 * mMask + 40 * meRegion);
        if (out.mat !== MAT_DUNE || ch > 0.5) {
          out.mat = MAT_WADI;
          out.aux = (ch * 255) | 0;
        }
      }

      // ── Coastal strip: sabkha salt flats & beaches ──
      if (inland < 7000) {
        const coastal = 1 - sstep(0, 7000, inland);
        const flat = 1.2 + 2.5 * sstep(0, 5000, inland) + 1.2 * nD.noise(x / 2500, z / 2500);
        h = mixf(h, flat, coastal * 0.85);
        const salt = sstep(0.1, 0.3, saltF.at(x, z)) * coastal;
        if (salt > 0.35) {
          out.mat = MAT_SALT;
          out.aux = (salt * 255) | 0;
        } else if (inland < 900) out.mat = MAT_BEACH;
      }
      // blend into the gulf floor across the shoreline
      if (c > -600) {
        const t = sstep(-600, 1800, c);
        h = mixf(h, seaFloor(x, z, c), t);
        if (t > 0.3) out.mat = MAT_BEACH;
      }
      // Inland must stay dry (no accidental puddles below sea level)
      if (inland > 3000 && h < 3) h = 3 + (h - 3) * 0.1;
      return h;
    },
  };
}
