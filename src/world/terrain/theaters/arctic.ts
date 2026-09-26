/**
 * ARCTIC theatre — Kola / northern Norway: open sea to the north-west with rocky skerries, a
 * ragged coast cut by deep U-shaped fjords, a snowy plateau with rolling fells, isolated alpine
 * peaks, frozen lakes, and tundra patches along the low coast.
 */
import { Noise2D, mulberry32, sstep, mixf } from '../noise';
import { CoarseField } from '../coarse';
import { MAT_ICE, MAT_NONE, MAT_ROCKY, MAT_TUNDRA, MAT_BEACH, type SampleOut, type TheaterGenerator } from '../types';

const R2 = Math.SQRT1_2;

export function createArctic(seed: number): TheaterGenerator {
  const nA = new Noise2D(seed * 17 + 1);
  const nB = new Noise2D(seed * 17 + 2);
  const nC = new Noise2D(seed * 17 + 3);
  const nD = new Noise2D(seed * 17 + 4);
  const rnd = mulberry32(seed + 404);
  const coast0 = 9000 + rnd() * 5000;

  const plateauF = (x: number, z: number) => 430 + 260 * nB.fbm(x / 24_000, z / 24_000, 2);
  /** > 0 = land (m from the coastline, roughly). */
  const coast = new CoarseField((x, z) => {
    const s = (-x - z) * R2;
    const u = (x - z) * R2;
    return coast0 + 7000 * nA.fbm(u / 24_000, 3.3, 3) + 2200 * nD.fbm(x / 7000, z / 7000, 2) - s;
  });
  const plateau = new CoarseField(plateauF);
  const peakMaskF = new CoarseField((x, z) => sstep(0.1, 0.45, nB.fbm(x / 30_000 - 4, z / 30_000 + 6, 2)));
  const fjordF = new CoarseField((x, z) => {
    const s = (-x - z) * R2;
    const u = (x - z) * R2;
    return nC.fbm(u / 8500 + 0.35 * nA.noise(u / 4000, s / 4000), s / 38_000, 3);
  });
  const seaF = new CoarseField((x, z) => 25 * nD.noise(x / 5000, z / 5000));
  const lakeF = new CoarseField((x, z) => nA.fbm(x / 6500 + 9, z / 6500 - 4, 3));

  return {
    edge(x, z) {
      const c = coast0 - (-x - z) * R2;
      return mixf(-180, plateauF(x, z) * 0.9, sstep(-6000, 12_000, c));
    },

    height(x, z, out: SampleOut) {
      out.mat = MAT_NONE;
      out.aux = 0;
      const c = coast.at(x, z);
      const rise = sstep(-500, 9000, c);
      const base = plateau.at(x, z);

      // Fells (rounded eroded hills) and a few alpine peaks
      const fell = nD.eroded(x / 7000, z / 7000, 6);
      const peakMask = peakMaskF.at(x, z) * sstep(6000, 16_000, c);
      let h = 8 + rise * base + (40 + 240 * rise) * (0.5 + 0.5 * fell);
      if (peakMask > 0.001) {
        const pk = nC.ridged(x / 11_000 + 7, z / 11_000 - 3, 5);
        h += peakMask * pk * pk * 1500;
        if (peakMask * pk > 0.35) {
          out.mat = MAT_ROCKY;
          out.aux = Math.min(255, (peakMask * pk * 300) | 0);
        }
      }

      // Fjords: long channels perpendicular to the coast with steep walls and flat floors
      const inland = sstep(0, 30_000, c);
      const w = 0.085 * (1 - 0.65 * inland);
      const fj = sstep(w, w * 0.3, Math.abs(fjordF.at(x, z))) * (1 - sstep(24_000, 34_000, c));
      if (fj > 0.001) {
        const floor = mixf(-190, 80, sstep(-2000, 26_000, c));
        h = mixf(h, Math.min(h, floor), fj);
      }

      // Open sea + skerries
      if (c < 0) {
        const t = sstep(0, 14_000, -c);
        const sea = -8 - 260 * t + seaF.at(x, z);
        h = mixf(h, sea, sstep(0, 2500, -c));
        if (-c < 7000) {
          const sk = nB.fbm(x / 900, z / 900, 3);
          if (sk > 0.3) {
            h = Math.max(h, (sk - 0.3) * 90 - 2);
            out.mat = MAT_ROCKY;
            out.aux = 160;
          }
        }
      }

      // Frozen lakes on the plateau (flat ice sheets)
      if (c > 3000 && fj < 0.3) {
        const lake = sstep(0.3, 0.36, lakeF.at(x, z)) * sstep(3000, 8000, c) * (1 - peakMask * 0.8);
        if (lake > 0.001) {
          const level = 8 + rise * base + 34;
          h = mixf(h, level, lake);
          if (lake > 0.5) {
            out.mat = MAT_ICE;
            out.aux = (lake * 255) | 0;
          }
        }
      }

      // Tundra / beaches along the low coast
      if (out.mat === MAT_NONE && h > 0 && h < 90 && c < 6000) {
        out.mat = h < 6 ? MAT_BEACH : MAT_TUNDRA;
        out.aux = ((1 - sstep(0, 90, h)) * 255) | 0;
      }
      return h;
    },
  };
}
