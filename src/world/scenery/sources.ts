/**
 * Scatter sources:
 *  - TreeSource: jittered-grid candidates accepted by the baked forest density (colour map alpha),
 *    plus garden/street trees in suburbs; species by theatre/altitude
 *  - HouseSource: houses / apartment blocks on the exact lots the terrain shader paints (urbanGrid)
 */
import { Color } from 'three';
import type { TheaterId } from '../../core/types';
import type { Heightfield } from '../terrain/Heightfield';
import type { VegetationField } from '../terrain/vegetation';
import { TREE_BROADLEAF, TREE_CONIFER, TREE_PALM } from '../terrain/vegetation';
import { hash2 } from '../terrain/noise';
import { REC, type ScatterSource, type TileInstances } from './scatter';
import { BLOCK_D, BLOCK_W, LOTS_X, LOTS_Z, blockHash, districtAt, lotHash, lotInset, toLocal, toWorld, type District } from './urbanGrid';

/** Bilinear lookups into the baked colour map's alpha: forest (A < 128) / urban (A ≥ 128). */
export class ColorMapSampler {
  private readonly inv: number;
  constructor(
    private readonly data: Uint8Array,
    private readonly size: number,
    private readonly origin: number,
    extent: number,
  ) {
    this.inv = size / extent;
  }
  private alpha(x: number, z: number): number {
    const n = this.size;
    let gx = (x - this.origin) * this.inv;
    let gz = (z - this.origin) * this.inv;
    if (gx < 0) gx = 0;
    else if (gx > n - 1.001) gx = n - 1.001;
    if (gz < 0) gz = 0;
    else if (gz > n - 1.001) gz = n - 1.001;
    const ix = gx | 0;
    const iz = gz | 0;
    const fx = gx - ix;
    const fz = gz - iz;
    const d = this.data;
    const k = (iz * n + ix) * 4 + 3;
    const a = d[k] + (d[k + 4] - d[k]) * fx;
    const b = d[k + n * 4] + (d[k + n * 4 + 4] - d[k + n * 4]) * fx;
    return (a + (b - a) * fz) / 255;
  }
  forest(x: number, z: number): number {
    const a = this.alpha(x, z);
    return a < 0.5 ? a * 2 : 0;
  }
  urban(x: number, z: number): number {
    const a = this.alpha(x, z);
    return a >= 0.5 ? Math.min(1, a * 2 - 1) : 0;
  }
}

const _c = new Color();

export class TreeSource implements ScatterSource {
  readonly kinds = 3;
  private readonly tint: Color;
  constructor(
    private readonly hf: Heightfield,
    private readonly cmap: ColorMapSampler,
    private readonly veg: VegetationField,
    private readonly theater: TheaterId,
    private readonly seed: number,
    private readonly spacing = 14,
  ) {
    this.tint = theater === 'desert' ? new Color(1.08, 1.02, 0.78) : theater === 'arctic' ? new Color(0.82, 0.9, 0.88) : new Color(1, 1, 1);
  }

  generate(x0: number, z0: number, size: number, out: TileInstances): void {
    const sp = this.spacing;
    const n = Math.floor(size / sp);
    const hf = this.hf;
    const seed = this.seed;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const gx = Math.floor(x0 / sp) + i;
        const gz = Math.floor(z0 / sp) + j;
        const h1 = hash2(gx, gz, seed);
        const h2 = hash2(gx, gz, seed + 1);
        const h3 = hash2(gx, gz, seed + 2);
        const x = (gx + 0.1 + 0.8 * h1) * sp;
        const z = (gz + 0.1 + 0.8 * h2) * sp;
        let dens = this.cmap.forest(x, z);
        const urban = dens > 0 ? 0 : this.cmap.urban(x, z);
        if (urban > 0.05) dens = 0.1 * (1 - urban * 0.7); // garden & street trees
        else if (dens < 0.02) dens = this.theater === 'desert' || this.theater === 'arctic' ? 0 : 0.012; // lone trees
        if (h3 > dens) continue;
        const gh = hf.heightAt(x, z);
        if (gh < 0.6) continue;
        const slope = hf.slopeAt(x, z);
        if (slope > 0.9) continue;
        const mi = Math.round((z - hf.origin) / hf.cell) * hf.n + Math.round((x - hf.origin) / hf.cell);
        const mat = hf.mat[Math.max(0, Math.min(hf.mat.length - 1, mi))];
        const r = hash2(gx, gz, seed + 3);
        const kind = this.veg.species(gh, mat, r, x, z);
        const base = kind === TREE_CONIFER ? 11 + 12 * r : kind === TREE_PALM ? 8 + 7 * r : 8 + 9 * r;
        const s = base * (urban > 0.05 ? 0.8 : 1);
        const w = s * (kind === TREE_PALM ? 0.95 : kind === TREE_CONIFER ? 0.95 : 1.15) * (0.85 + 0.3 * h1);
        const shade = 0.82 + 0.3 * h2;
        _c.copy(this.tint).multiplyScalar(shade);
        if (kind === TREE_BROADLEAF && this.theater === 'mountains' && gh > 1500) _c.multiplyScalar(0.9);
        const arr = out.data[kind];
        arr.push(x, hf.meshHeightAt(x, z) - 0.3, z, h3 * 40, w, s, w, _c.r, _c.g, _c.b, hash2(gx, gz, seed + 4));
      }
    }
  }
}

export const HOUSE = 0;
export const APARTMENT = 1;

const WALLS = [0xf2efe6, 0xe8e2d2, 0xdfe6ea, 0xf0e6d8, 0xd8dcd4, 0xe6d8c8, 0xc8d4dc];

export class HouseSource implements ScatterSource {
  readonly kinds = 2;
  private readonly wall = WALLS.map((h) => new Color(h));
  private readonly dist: District = {} as District;
  constructor(
    private readonly hf: Heightfield,
    private readonly cmap: ColorMapSampler,
  ) {}

  generate(x0: number, z0: number, size: number, out: TileInstances): void {
    // Districts overlapping the tile (sampled on a 3×3 grid)
    const seen: District[] = [];
    for (let j = 0; j <= 2; j++)
      for (let i = 0; i <= 2; i++) {
        const d = districtAt(x0 + (size * i) / 2, z0 + (size * j) / 2);
        if (!seen.some((s) => s.cx === d.cx && s.cz === d.cz)) seen.push(d);
      }
    const lotW = BLOCK_W / LOTS_X;
    const lotD = BLOCK_D / LOTS_Z;
    for (const d of seen) {
      // local bbox of the tile corners
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [cx, cz] of [
        [x0, z0],
        [x0 + size, z0],
        [x0, z0 + size],
        [x0 + size, z0 + size],
      ]) {
        const [lx, lz] = toLocal(d, cx, cz);
        minX = Math.min(minX, lx);
        maxX = Math.max(maxX, lx);
        minZ = Math.min(minZ, lz);
        maxZ = Math.max(maxZ, lz);
      }
      for (let lz = Math.floor(minZ / lotD); lz <= Math.floor(maxZ / lotD); lz++) {
        for (let lx = Math.floor(minX / lotW); lx <= Math.floor(maxX / lotW); lx++) {
          const [wx, wz] = toWorld(d, (lx + 0.5) * lotW, (lz + 0.5) * lotD);
          if (wx < x0 || wx >= x0 + size || wz < z0 || wz >= z0 + size) continue;
          const own = districtAt(wx, wz, undefined, this.dist);
          if (own.cx !== d.cx || own.cz !== d.cz || own.border < 9) continue;
          const dens = this.cmap.urban(wx, wz);
          if (dens < 0.08) continue;
          const bx = Math.floor(lx / LOTS_X);
          const bz = Math.floor(lz / LOTS_Z);
          if (blockHash(d, bx, bz) >= 0.94 - dens * 0.06) continue; // park block
          const lh = lotHash(d, lx, lz);
          if (lh >= 0.62 + 0.38 * dens) continue;
          const gh = this.hf.meshHeightAt(wx, wz);
          if (gh < 1) continue;
          const [ix, iz] = lotInset(dens);
          const w = lotW * (1 - 2 * ix);
          const dd = lotD * (1 - 2 * iz);
          const apt = dens > 0.82;
          const hgt = apt ? 12 + 26 * ((lh * 5.7) % 1) * dens : 4.5 + 2.8 * ((lh * 3.3) % 1);
          const wc = this.wall[Math.floor(((lh * 17.3) % 1) * this.wall.length)];
          out.data[apt ? APARTMENT : HOUSE].push(wx, gh - 1.2, wz, -d.angle, w, hgt + 1.2, dd, wc.r, wc.g, wc.b, lh);
        }
      }
    }
  }
}

/** Roof colour for a house record (matches the shader's lot roof colour). */
export function roofColorFn(roofs: [Color, Color, Color]): (rec: number[], i: number, out: Color) => void {
  return (rec, _i, out) => {
    const lh = rec[10];
    const c = lh < 0.3 ? roofs[0] : lh < 0.66 ? roofs[1] : roofs[2];
    const k = 0.8 + 0.45 * ((lh * 7.3) % 1);
    out.setRGB(c.r * k, c.g * k, c.b * k);
  };
}
