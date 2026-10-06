/**
 * Scatter sources:
 *  - TreeSource: jittered-grid candidates accepted by the baked forest density (colour map alpha),
 *    plus garden/street trees in suburbs; species by theatre/altitude
 *  - HouseSource: houses / apartment blocks on the exact lots the terrain shader paints (urbanGrid;
 *    none inside the CBD region with real streets, whose buildings come from buildCBD)
 */
import { Color } from 'three';
import type { TheaterId } from '../../core/types';
import type { Heightfield } from '../terrain/Heightfield';
import type { VegetationField } from '../terrain/vegetation';
import { TREE_BROADLEAF, TREE_CONIFER, TREE_PALM } from '../terrain/vegetation';
import { hash2 } from '../terrain/noise';
import type { ScatterSource, TileInstances } from './scatter';
import type { LotMask } from './lotMask';
import { FRONT_HOUSE, type FrontageMap, type FrontHouse } from './frontage';
import { canopyAt, neighbourhoodAt, type Neighbourhood } from './aucklandNeighbourhoods';
import { pointInRing } from './cbdStreets';
import { BLOCK_D, BLOCK_W, LOTS_X, LOTS_Z, ROAD_HALF, blockHash, districtAt, lotHash, toLocal, toWorld, type CbdGrid, type District } from './urbanGrid';
import { LU_COMMERCIAL, LU_INDUSTRIAL, LU_PITCH, LU_SCHOOL, landUseAt, luOpen, luSheds, type LandUse } from './aucklandLandUse';
import { SCHOOL_BUILT, SHED_ROOFS, UNIT_LOTS, shedFootprint, shedHeight, shedRoofOf } from './landUseLots';

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

/** True on (or within 2 m of) a street the terrain shader paints: the procedural grid (district
 *  borders are ordinary streets now, not arterials: real arterials are road ribbons, see motorways.ts)
 *  or, inside the CBD region, Auckland's real streets (cbdStreets.ts). */
export function onStreet(x: number, z: number, cbd: CbdGrid | null, scratch: District): boolean {
  const d = districtAt(x, z, undefined, scratch, cbd);
  if (d.real) return cbd!.streets!.streetSD(x, z) < 2;
  if (d.border < ROAD_HALF + 2) return true;
  const [px, pz] = toLocal(d, x, z);
  const fx = ((px % BLOCK_W) + BLOCK_W) % BLOCK_W;
  const fz = ((pz % BLOCK_D) + BLOCK_D) % BLOCK_D;
  return Math.min(fx, BLOCK_W - fx, fz, BLOCK_D - fz) < ROAD_HALF + 2;
}

/** Trees measured one by one on a site of their own (tamakiDrive.ts tamakiTrees: [x, y, z, width, height, palm, shade] each). */
export interface MeasuredTrees {
  trees: Float32Array;
  /** True on the site (+ margin m): the scatter grows nothing else there. */
  covers(x: number, z: number, margin: number): boolean;
}

export class TreeSource implements ScatterSource {
  readonly kinds = 3;
  private readonly dist: District = {} as District;
  constructor(
    private readonly hf: Heightfield,
    private readonly cmap: ColorMapSampler,
    private readonly veg: VegetationField,
    _theater: TheaterId,
    private readonly seed: number,
    private readonly spacing = 14,
    private readonly blocked: ((x: number, z: number, margin: number) => boolean) | null = null,
    private readonly cbd: CbdGrid | null = null,
    private readonly nbs: Neighbourhood[] | null = null,
    /** The real land use (#122): no garden trees on pitches, few in car parks and yards. */
    private readonly landUse: LandUse | null = null,
    /** Measured trees standing on a strip of their own (the Tāmaki Drive waterfront): no others grow there. */
    private readonly measured: MeasuredTrees | null = null,
  ) {}

  /** Hero neighbourhoods' building footprints in 20 m buckets (trunks stay out of the houses). */
  private nbBuildings: Map<number, Float32Array[]> | null = null;

  private inNbBuilding(x: number, z: number): boolean {
    if (!this.nbBuildings) {
      const m = new Map<number, Float32Array[]>();
      for (const n of this.nbs ?? [])
        for (const parts of n.buildings)
          for (const p of parts) {
            let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
            for (let i = 0; i < p.ring.length; i += 2) {
              x0 = Math.min(x0, p.ring[i]);
              x1 = Math.max(x1, p.ring[i]);
              z0 = Math.min(z0, p.ring[i + 1]);
              z1 = Math.max(z1, p.ring[i + 1]);
            }
            for (let j = Math.floor(z0 / 20); j <= Math.floor(z1 / 20); j++)
              for (let i = Math.floor(x0 / 20); i <= Math.floor(x1 / 20); i++) {
                const k = (i + 8192) * 16384 + (j + 8192);
                const l = m.get(k);
                if (l) l.push(p.ring);
                else m.set(k, [p.ring]);
              }
          }
      this.nbBuildings = m;
    }
    const l = this.nbBuildings.get((Math.floor(x / 20) + 8192) * 16384 + (Math.floor(z / 20) + 8192));
    return !!l && l.some((r) => pointInRing(r, x, z));
  }

  /**
   * A tree of a hero neighbourhood (Herne Bay, Westhaven) at grid point (x, z), or false: grown to match the measured
   * canopy cell it stands in (aucklandNeighbourhoods.ts canopy grid), its share under trees and their height, off the
   * houses and the streets. Each 14 m grid point stands for 196 m² of ground, so a cell with share c gets a tree at a
   * point with probability c · 196 / crown area, crowns widened where that would exceed one (a closed canopy).
   */
  private nbTree(n: Neighbourhood, x: number, z: number, gx: number, gz: number, out: TileInstances): void {
    const c = canopyAt(n.canopy, x, z);
    if (!c || c.cover <= 0 || c.height < 2.5) return;
    const seed = this.seed;
    const h1 = hash2(gx, gz, seed + 11);
    const s = c.height * (0.8 + 0.4 * hash2(gx, gz, seed + 12));
    const cell = this.spacing * this.spacing;
    let w = s * 0.9;
    let p = (c.cover * cell) / (Math.PI * (w / 2) ** 2);
    if (p > 1) {
      w = Math.min(s * 1.6, 2 * Math.sqrt((c.cover * cell) / Math.PI));
      p = 1;
    }
    if (h1 > p) return;
    const hf = this.hf;
    if (hf.heightAt(x, z) < 0.6) return;
    if (this.inNbBuilding(x, z)) return;
    const st = this.cbd?.streets;
    if (st && st.streetSD(x, z) < 2) return;
    if (this.blocked && this.blocked(x, z, 2)) return;
    const mi = Math.round((z - hf.origin) / hf.cell) * hf.n + Math.round((x - hf.origin) / hf.cell);
    const mat = hf.mat[Math.max(0, Math.min(hf.mat.length - 1, mi))];
    const kind = this.veg.species(hf.heightAt(x, z), mat, hash2(gx, gz, seed + 3), x, z);
    _c.setScalar(0.82 + 0.3 * hash2(gx, gz, seed + 13));
    out.data[kind].push(x, hf.meshHeightAt(x, z) - 0.3, z, h1 * 40, w, s, w, _c.r, _c.g, _c.b, hash2(gx, gz, seed + 4));
  }

  generate(x0: number, z0: number, size: number, out: TileInstances): void {
    const sp = this.spacing;
    const n = Math.floor(size / sp);
    const hf = this.hf;
    const seed = this.seed;
    const m = this.measured;
    if (m) {
      // the measured trees in this tile (kept to the edge of the scatter's radius: they're the real ones)
      const t = m.trees;
      for (let i = 0; i < t.length; i += 7) {
        const x = t[i], z = t[i + 2];
        if (x < x0 || x >= x0 + size || z < z0 || z >= z0 + size) continue;
        _c.setScalar(t[i + 6]);
        out.data[t[i + 5] ? TREE_PALM : TREE_BROADLEAF].push(x, t[i + 1], z, hash2(i, 7, seed) * 40, t[i + 3], t[i + 4], t[i + 3], _c.r, _c.g, _c.b, 0.1 * hash2(i, 9, seed));
      }
    }
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const gx = Math.floor(x0 / sp) + i;
        const gz = Math.floor(z0 / sp) + j;
        const h1 = hash2(gx, gz, seed);
        const h2 = hash2(gx, gz, seed + 1);
        const h3 = hash2(gx, gz, seed + 2);
        const x = (gx + 0.1 + 0.8 * h1) * sp;
        const z = (gz + 0.1 + 0.8 * h2) * sp;
        if (m?.covers(x, z, 2)) continue;
        const nb = this.nbs ? neighbourhoodAt(x, z, this.nbs) : null;
        if (nb) {
          this.nbTree(nb, x, z, gx, gz, out);
          continue;
        }
        let dens = this.cmap.forest(x, z);
        const urban = dens > 0 ? 0 : this.cmap.urban(x, z);
        if (urban > 0.05) dens = 0.1 * (1 - urban * 0.7); // garden & street trees
        else if (dens < 0.02) dens = 0.012; // lone trees
        if (h3 > dens) continue;
        const gh = hf.heightAt(x, z);
        if (gh < 0.6) continue;
        if (this.blocked && this.blocked(x, z, 3)) continue;
        // garden / street trees stay off the painted streets and arterials
        if (urban > 0.05 && onStreet(x, z, this.cbd, this.dist)) continue;
        if (urban > 0.05 && this.landUse) {
          const c = landUseAt(this.landUse, x, z);
          if (c === LU_PITCH || c === LU_SCHOOL || ((c === LU_COMMERCIAL || c === LU_INDUSTRIAL) && h1 > 0.2)) continue;
        }
        // CBD (real streets): the blocks are built up (auckland.ts buildCBD); trees only in the parks
        const st = this.cbd?.streets;
        if (st && st.regionSD(x, z) > -2 && (st.park(x, z) < 0.6 || st.streetSD(x, z) < 2)) continue;
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
        _c.setScalar(shade);
        const arr = out.data[kind];
        arr.push(x, hf.meshHeightAt(x, z) - 0.3, z, h3 * 40, w, s, w, _c.r, _c.g, _c.b, hash2(gx, gz, seed + 4));
      }
    }
  }
}

export const HOUSE = 0;
export const APARTMENT = 1;
/** A flat-roofed shed on commercial, industrial, hospital or school land (landUseLots.ts). */
export const SHED = 2;

const f32 = Math.fround;
const fract = (x: number) => x - Math.floor(x);
/** GLSL fract(lh * k) with float32 rounding (matches the terrain shader's per-lot hashes). */
const lotFrac = (lh: number, k: number) => fract(f32(f32(lh) * f32(k)));

/**
 * House footprint inside its lot, exactly as the terrain shader paints it (urbanPattern):
 * centre / size as fractions of the 17.5 × 38 m lot.
 */
export function houseFootprint(lh: number, lz: number, apt: boolean): { cx: number; cz: number; sx: number; sz: number } {
  if (apt) return { cx: 0.5, cz: 0.5, sx: 0.78, sz: 0.6 + 0.2 * lotFrac(lh, 13.9) };
  const row = ((lz % 2) + 2) % 2;
  return { cx: 0.5 + (lotFrac(lh, 37.1) - 0.5) * 0.14, cz: row === 0 ? 0.34 : 0.66, sx: 0.5 + 0.24 * lotFrac(lh, 71.7), sz: 0.28 + 0.14 * lotFrac(lh, 13.9) };
}

export class HouseSource implements ScatterSource {
  private readonly dist: District = {} as District;
  constructor(
    private readonly hf: Heightfield,
    private readonly cmap: ColorMapSampler,
    private readonly groundAt: (x: number, z: number) => number = (x, z) => hf.meshHeightAt(x, z),
    private readonly cbd: CbdGrid | null = null,
    private readonly blocked: ((x: number, z: number, margin: number) => boolean) | null = null,
    /** Lots cleared along the road and railway ribbons (the terrain shader leaves them unbuilt too). */
    private readonly lotMask: Pick<LotMask, 'masked'> | null = null,
    /** The lots along the arterials, facing them (frontage.ts; the terrain shader paints the same). */
    private readonly frontage: FrontageMap | null = null,
    /** The real land use (#122): houses only off open ground, sheds on commercial / industrial / hospital land. */
    private readonly landUse: LandUse | null = null,
  ) {
    this.kinds = landUse ? 3 : 2;
  }
  readonly kinds: number;

  private readonly front: FrontHouse[] = [];

  generate(x0: number, z0: number, size: number, out: TileInstances): void {
    // Districts overlapping the tile (sampled on a 3×3 grid)
    const seen: District[] = [];
    for (let j = 0; j <= 2; j++)
      for (let i = 0; i <= 2; i++) {
        const d = districtAt(x0 + (size * i) / 2, z0 + (size * j) / 2, undefined, undefined, this.cbd);
        // the CBD region has no procedural lots (its buildings follow the real streets: buildCBD)
        if (!d.real && !seen.some((s) => s.cx === d.cx && s.cz === d.cz)) seen.push(d);
      }
    if (this.frontage) {
      this.front.length = 0;
      for (const h of this.frontage.housesIn(x0, z0, size, this.front)) {
        const gh = this.groundAt(h.x, h.z);
        if (gh < 1) continue;
        if (this.blocked && this.blocked(h.x, h.z, 4)) continue;
        if (this.landUse && luOpen(landUseAt(this.landUse, h.x, h.z))) continue;
        out.data[h.kind === FRONT_HOUSE ? HOUSE : APARTMENT].push(h.x, gh - 0.8, h.z, h.yaw, h.w, h.h + 0.8, h.d, 1, 1, 1, h.lh);
      }
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
          const [cwx, cwz] = toWorld(d, (lx + 0.5) * lotW, (lz + 0.5) * lotD);
          if (cwx < x0 || cwx >= x0 + size || cwz < z0 || cwz >= z0 + size) continue;
          const own = districtAt(cwx, cwz, undefined, this.dist, this.cbd);
          if (own.real || own.cx !== d.cx || own.cz !== d.cz || own.border < 9) continue;
          const dens = this.cmap.urban(cwx, cwz);
          if (dens < 0.08) continue;
          const bx = Math.floor(lx / LOTS_X);
          const bz = Math.floor(lz / LOTS_Z);
          if (blockHash(d, bx, bz) >= 0.975 - dens * 0.03) continue; // park block (same rule as the shader)
          const lu = this.landUse;
          if (lu) {
            // the unit of UNIT_LOTS lots this one starts (landUseLots.ts): a shed / classroom block, or no houses
            const ux = Math.floor(lx / UNIT_LOTS);
            const [ucx, ucz] = toWorld(d, (ux + 0.5) * UNIT_LOTS * lotW, (lz + 0.5) * lotD);
            const cu = landUseAt(lu, ucx, ucz);
            if (luSheds(cu) || cu === LU_SCHOOL) {
              if (lx !== ux * UNIT_LOTS) continue;
              const uh = lotHash(d, lx, lz);
              if (cu === LU_SCHOOL && uh >= SCHOOL_BUILT) continue;
              if (this.lotMask?.masked(ucx, ucz)) continue;
              const fp = shedFootprint(cu);
              const gh = this.groundAt(ucx, ucz);
              if (gh < 1) continue;
              if (this.blocked && this.blocked(ucx, ucz, 20)) continue;
              if (this.cbd?.streets && this.cbd.streets.regionSD(ucx, ucz) > -ROAD_HALF - 20) continue;
              const own2 = districtAt(ucx, ucz, undefined, this.dist, this.cbd);
              if (own2.real || own2.cx !== d.cx || own2.cz !== d.cz || own2.border < 20) continue;
              const hgt = shedHeight(cu, uh);
              out.data[SHED].push(ucx, gh - 0.8, ucz, -d.angle, fp.sx * UNIT_LOTS * lotW, hgt + 0.8, fp.sz * lotD, 1, 1, 1, uh);
              continue;
            }
            if (luOpen(landUseAt(lu, cwx, cwz))) continue;
          }
          const lh = lotHash(d, lx, lz);
          if (lh >= 0.8 + 0.2 * dens) continue;
          // the corridor along a road or railway ribbon (lotMask.ts; tested at the lot centre, as the shader does)
          if (this.lotMask?.masked(cwx, cwz)) continue;
          const apt = dens > 0.9;
          const fp = houseFootprint(lh, lz, apt);
          const [wx, wz] = toWorld(d, (lx + fp.cx) * lotW, (lz + fp.cz) * lotD);
          const gh = this.groundAt(wx, wz);
          if (gh < 1) continue;
          if (this.blocked && this.blocked(wx, wz, 12)) continue;
          // the house itself (not only its lot centre) clear of the street along the real-streets region's border
          if (this.cbd?.streets && this.cbd.streets.regionSD(wx, wz) > -ROAD_HALF - 2) continue;
          const w = fp.sx * lotW;
          const dd = fp.sz * lotD;
          const hgt = apt ? 12 + 26 * lotFrac(lh, 5.7) * dens : 3.2 + 1.6 * lotFrac(lh, 3.3);
          // ridge along the long side: the unit archetype's ridge runs along local Z
          const swap = w > dd;
          out.data[apt ? APARTMENT : HOUSE].push(wx, gh - 0.8, wz, -d.angle + (swap ? Math.PI / 2 : 0), swap ? dd : w, hgt + 0.8, swap ? w : dd, 1, 1, 1, lh);
        }
      }
    }
  }
}

/** Roof colour for a shed record (matches the terrain shader's shedRoof(uh)). */
export function shedColorFn(): (rec: number[], i: number, out: Color) => void {
  const roofs = SHED_ROOFS.map((h) => new Color(h));
  return (rec, _i, out) => {
    const { index, k } = shedRoofOf(rec[10]);
    const c = roofs[index];
    out.setRGB(c.r * k, c.g * k, c.b * k);
  };
}

/** Roof colour for a house record (matches the terrain shader's roofColor(lh)). */
export function roofColorFn(roofs: Color[]): (rec: number[], i: number, out: Color) => void {
  return (rec, _i, out) => {
    const lh = rec[10];
    const c = roofs[Math.min(roofs.length - 1, Math.floor(lotFrac(lh, 5.1) * 5.999))];
    const k = 0.85 + 0.3 * lotFrac(lh, 7.3);
    out.setRGB(c.r * k, c.g * k, c.b * k);
  };
}
