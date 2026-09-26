/**
 * MOUNTAINS theatre — Caucasus-like: a main range running WNW–ESE with 4–5 km peaks and a sharp
 * divide, spurs separated by deep, winding gorges (terrain masking!), a lesser range to the south,
 * eroded foothills, and a broad lowland plain with meandering river valleys and low hills.
 */
import { mulberry32 } from '../../../core/math';
import { Noise2D, sstep, mixf } from '../noise';
import { CoarseField } from '../coarse';
import { MAT_NONE, MAT_RIVER, MAT_ROCKY, type SampleOut, type TheaterGenerator } from '../types';

export function createMountains(seed: number): TheaterGenerator {
  const nA = new Noise2D(seed * 13 + 1);
  const nB = new Noise2D(seed * 13 + 2);
  const nC = new Noise2D(seed * 13 + 3);
  const nD = new Noise2D(seed * 13 + 4);
  const rnd = mulberry32(seed + 303);
  const axis0 = -9000 + rnd() * 4000;
  const tilt = 0.08 + rnd() * 0.1;
  const axis2z = 21_000 + rnd() * 4000;

  const plainF = (x: number, z: number) => 150 + 80 * nB.fbm(x / 26_000, z / 26_000, 2) - 0.0022 * z;
  const warpX = new CoarseField((x, z) => 3600 * nB.fbm(x / 16_000, z / 16_000, 3));
  const warpZ = new CoarseField((x, z) => 3600 * nB.fbm(x / 16_000 + 3.3, z / 16_000 - 1.1, 3));
  // Range envelope (M) and main-divide proximity (crest), both from warped coordinates.
  const envelope = new CoarseField((x, z) => {
    const wx = x + warpX.at(x, z);
    const wz = z + warpZ.at(x, z);
    const ax1 = axis0 + 7000 * nA.fbm(wx / 42_000, 1.7, 3) + tilt * wx;
    const ax2 = axis2z + 5000 * nA.fbm(wx / 30_000, 8.1, 2) - 0.05 * wx;
    const d1 = (wz - ax1) / 12_500;
    const d2 = (wz - ax2) / 7000;
    const taper = 1 - sstep(26_000, 39_000, Math.abs(x) + 3500 * nD.noise(z / 9000, 4.4));
    const strength = 0.75 + 0.35 * nC.fbm(wx / 20_000 + 2, 3.3, 2);
    return Math.max(Math.exp(-d1 * d1) * strength, 0.42 * Math.exp(-d2 * d2)) * taper;
  });
  const crestF = new CoarseField((x, z) => {
    const wx = x + warpX.at(x, z);
    const wz = z + warpZ.at(x, z);
    const ax1 = axis0 + 7000 * nA.fbm(wx / 42_000, 1.7, 3) + tilt * wx;
    const d1 = (wz - ax1) / 4000;
    const taper = 1 - sstep(26_000, 39_000, Math.abs(x) + 3500 * nD.noise(z / 9000, 4.4));
    return Math.exp(-d1 * d1) * taper;
  });
  // Gorges: zero-lines of a smooth field, stretched N–S but strongly meandering.
  const gorgeF = new CoarseField((x, z) => {
    const wx = x + warpX.at(x, z) * 1.6;
    return nA.fbm(wx / 7200 + 0.5, z / 26_000, 3) + 0.25 * nD.noise(x / 3500, z / 3500);
  });
  const gorgeW = new CoarseField((x, z) => 0.05 + 0.04 * nC.noise(x / 12_000 + 5, z / 12_000));
  const riverF = new CoarseField((x, z) => nD.fbm(x / 20_000 + 9, z / 11_000 - 3, 3) + 0.18 * nB.noise(x / 4000, z / 4000));
  const plain = new CoarseField(plainF);

  return {
    edge: (x, z) => plainF(x, z),

    height(x, z, out: SampleOut) {
      out.mat = MAT_NONE;
      out.aux = 0;
      const M = envelope.at(x, z);
      let h = plain.at(x, z);

      // Eroded foothills / low hills everywhere (stronger near the range)
      const hills = nD.eroded(x / 6500 + 1.3, z / 6500 - 2.7, 5);
      h += (70 + 560 * sstep(0.05, 0.55, M)) * (0.5 + 0.5 * hills) * sstep(0.0, 0.3, M + 0.1 * (hills + 1));

      if (M > 0.03) {
        const wx = x + warpX.at(x, z);
        const wz = z + warpZ.at(x, z);
        const crest = crestF.at(x, z);
        // Spurs elongated N–S (ridges roughly perpendicular to the main axis)
        const r = nC.ridged(wx / 8200, wz / 14_000, 6);
        let mtn = M * (480 + 3900 * r * r * (0.5 + 0.5 * crest)) + crest * M * 750 * r;
        // Deep winding gorges between the spurs
        const w = gorgeW.at(x, z);
        const gorge = 1 - sstep(0.0, w, Math.abs(gorgeF.at(x, z)));
        mtn -= gorge * M * (1000 + 500 * crest) * (0.8 + 0.4 * r);
        if (mtn < 0) mtn *= 0.15;
        h += mtn;
        if (gorge > 0.55 && M > 0.2) {
          out.mat = MAT_RIVER;
          out.aux = (gorge * 255) | 0;
        } else if (r > 0.45 && M > 0.35) {
          out.mat = MAT_ROCKY;
          out.aux = Math.min(255, ((r - 0.35) * 2.5 * M * 255) | 0);
        }
      }

      // Lowland meandering river valleys
      const river = (1 - sstep(0, 0.03, Math.abs(riverF.at(x, z)))) * (1 - sstep(0.2, 0.5, M));
      if (river > 0.02) {
        h -= river * 30;
        if (out.mat === MAT_NONE) {
          out.mat = MAT_RIVER;
          out.aux = (river * 255) | 0;
        }
      }
      return Math.max(h, mixf(25, 70, sstep(0, 1, M)));
    },
  };
}
