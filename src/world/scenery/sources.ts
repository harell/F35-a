/**
 * Scatter sources:
 *  - TreeSource: jittered-grid candidates accepted by the baked forest density (colour map alpha),
 *    plus garden/street trees in suburbs; species by theatre/altitude
 *  - HouseSource: houses / apartment blocks on the exact lots the terrain shader paints (urbanGrid;
 *    none inside the CBD region with real streets, whose buildings come from buildCBD), and the real houses of
 *    Devonport and the gulf islands (aucklandHouses.ts, #121) through the same archetypes
 */
import { Color } from 'three';
import type { TheaterId } from '../../core/types';
import type { Heightfield } from '../terrain/Heightfield';
import type { VegetationField } from '../terrain/vegetation';
import { TREE_BROADLEAF, TREE_CONIFER, TREE_PALM } from '../terrain/vegetation';
import { MAT_PINE } from '../terrain/types';
import { hash2 } from '../terrain/noise';
import type { ScatterSource, TileInstances } from './scatter';
import type { LotMask } from './lotMask';
import { FRONT_HOUSE, type FrontageMap, type FrontHouse } from './frontage';
import { canopyAt, neighbourhoodAt, type Neighbourhood } from './aucklandNeighbourhoods';
import { pointInRing } from './cbdStreets';
import type { AucklandDomain, DomainTree } from './aucklandDomain';
import { BLOCK_D, BLOCK_W, LOTS_X, LOTS_Z, ROAD_HALF, blockHash, districtAt, lotHash, toLocal, toWorld, type CbdGrid, type District } from './urbanGrid';
import { LU_COMMERCIAL, LU_INDUSTRIAL, LU_PITCH, LU_SCHOOL, landUseAt, luOpen, luSheds, type LandUse } from './aucklandLandUse';
import { SCHOOL_BUILT, SHED_ROOFS, UNIT_LOTS, shedFootprint, shedHeight, shedRoofOf } from './landUseLots';
import { housesCover, housesIn, type RealHouses } from './aucklandHouses';
import { canopyAt as realCanopyAt, canopyHeightAt, type Canopy } from '../terrain/theaters/aucklandCanopy';

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

/**
 * The real tree canopy (#123, aucklandCanopy.ts) and what keeps its trees' trunks clear. Where the grid covers, it
 * decides the trees (on the aerial photo too: the photo's own trees get 3D trees standing on them).
 */
export interface CanopyTrees {
  grid: Canopy;
  /** The road ribbons and the landmark sites (not the photo). */
  blocked: ((x: number, z: number, margin: number) => boolean) | null;
  /** The real houses (#121): no trunk inside one. */
  houses: RealHouses | null;
  /** Lots cleared along the ribbons and on the sites (no procedural house stands there). */
  lotMask: Pick<LotMask, 'masked'> | null;
}

/** Where the canopy grid is: the share (0 … 1) the trees there follow, or −1 (the Topo50 cover and the gardens rule). */
export function canopyShareAt(c: CanopyTrees | null, x: number, z: number): number {
  return c ? realCanopyAt(c.grid, x, z) : -1;
}

/** A closed canopy's crowns widen up to this × their height (a pōhutukawa is wider than tall). */
const CANOPY_MAX_WIDEN = 2.2;
/** The share the crowns' overlap correction saturates at. */
const CANOPY_MAX_SHARE = 0.9;

const LOT_W = BLOCK_W / LOTS_X;
const LOT_D = BLOCK_D / LOTS_Z;

/**
 * True when (x, z) lies within `margin` m of a procedural house of the scatter (HouseSource's lot rule: the built lots
 * of the urban colour map, off the park blocks and the masked lots; the land-use sheds and the frontage lots are left
 * out). A tree of the real canopy does not grow through one.
 */
export function onProceduralHouse(x: number, z: number, cmap: ColorMapSampler, cbd: CbdGrid | null, masked: Pick<LotMask, 'masked'> | null, margin: number, scratch: District): boolean {
  const d = districtAt(x, z, undefined, scratch, cbd);
  if (d.real || d.border < 9) return false;
  const [px, pz] = toLocal(d, x, z);
  const lx = Math.floor(px / LOT_W);
  const lz = Math.floor(pz / LOT_D);
  const [cwx, cwz] = toWorld(d, (lx + 0.5) * LOT_W, (lz + 0.5) * LOT_D);
  const dens = cmap.urban(cwx, cwz);
  if (dens < 0.08) return false;
  if (blockHash(d, Math.floor(lx / LOTS_X), Math.floor(lz / LOTS_Z)) >= 0.975 - dens * 0.03) return false;
  const lh = lotHash(d, lx, lz);
  if (lh >= 0.8 + 0.2 * dens) return false;
  if (masked?.masked(cwx, cwz)) return false;
  const fp = houseFootprint(lh, lz, dens > 0.9);
  return Math.abs((px / LOT_W - lx - fp.cx) * LOT_W) < (fp.sx * LOT_W) / 2 + margin && Math.abs((pz / LOT_D - lz - fp.cz) * LOT_D) < (fp.sz * LOT_D) / 2 + margin;
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
    /** The Auckland Domain (aucklandDomain.ts): its measured trees grow there instead of the grid's. */
    private readonly domain: AucklandDomain | null = null,
    /** Measured trees standing on a strip of their own (the Tāmaki Drive waterfront): no others grow there. */
    private readonly measured: MeasuredTrees | null = null,
    /** The real tree canopy (#123): where its grid covers, the trees follow it instead of the Topo50 cover. */
    private readonly canopy: CanopyTrees | null = null,
  ) {}

  private readonly realIdx: number[] = [];

  /** Within `margin` m of a real house (#121: an oriented rectangle). */
  private onRealHouse(x: number, z: number, margin: number): boolean {
    const h = this.canopy?.houses;
    if (!h) return false;
    this.realIdx.length = 0;
    for (const k of housesIn(h, x - 16, z - 16, x + 16, z + 16, this.realIdx)) {
      const dx = x - h.x[k];
      const dz = z - h.z[k];
      const c = Math.cos(h.dir[k]);
      const s = Math.sin(h.dir[k]);
      if (Math.abs(dx * c + dz * s) < h.d[k] / 2 + margin && Math.abs(-dx * s + dz * c) < h.w[k] / 2 + margin) return true;
    }
    return false;
  }

  /**
   * A tree of the real canopy (#123) for the grid point (gx, gz), or none: the cell's share of land under trees and the
   * trees' measured height decide it, as nbTree does for the hero neighbourhoods (a 14 m point stands for 196 m², so it
   * takes a tree with probability −ln(1 − share) · 196 / crown area, the overlap of crowns put down at random allowed
   * for, the crowns widened up to CANOPY_MAX_WIDEN × the height where that would exceed one: a closed canopy). Its trunk keeps off the road ribbons, the landmark sites, the real and the procedural
   * houses and the painted streets; a point blocked there tries two more spots in its square, so the canopy stays near
   * its share round them. Palms only in gardens (the bush and the islands' pōhutukawa forest are broadleaf).
   */
  private canopyTree(share: number, gx: number, gz: number, out: TileInstances): void {
    if (share <= 0) return;
    const ct = this.canopy!;
    const seed = this.seed;
    const sp = this.spacing;
    const top = canopyHeightAt(ct.grid, (gx + 0.5) * sp, (gz + 0.5) * sp);
    const r = hash2(gx, gz, seed + 33);
    const s = Math.max(3, (top >= 3 ? top : 9) * (0.7 + 0.45 * hash2(gx, gz, seed + 32)));
    const cell = sp * sp;
    for (let attempt = 0; attempt < 3; attempt++) {
      const x = (gx + 0.1 + 0.8 * hash2(gx, gz, seed + 40 + attempt * 2)) * sp;
      const z = (gz + 0.1 + 0.8 * hash2(gx, gz, seed + 41 + attempt * 2)) * sp;
      const hf = this.hf;
      const gh = hf.heightAt(x, z);
      if (gh < 0.6) return;
      const mi = Math.round((z - hf.origin) / hf.cell) * hf.n + Math.round((x - hf.origin) / hf.cell);
      const mat = hf.mat[Math.max(0, Math.min(hf.mat.length - 1, mi))];
      const urban = this.cmap.urban(x, z);
      // conifers in the pine plantations and the gardens, palms in the gardens; the bush is broadleaf
      let kind = this.veg.species(gh, mat, r, x, z);
      if (urban <= 0.05 && (kind === TREE_PALM || (kind === TREE_CONIFER && mat !== MAT_PINE))) kind = TREE_BROADLEAF;
      const ratio = kind === TREE_CONIFER ? 0.55 : kind === TREE_PALM ? 0.75 : 0.95;
      // crowns fall where they will, so some overlap: the cover their union reaches is 1 − e^(−crown area per m²)
      const want = -Math.log(1 - Math.min(share, CANOPY_MAX_SHARE)) * cell;
      let w = s * ratio;
      let p = want / (Math.PI * (w / 2) ** 2);
      if (p > 1) {
        w = Math.min(s * CANOPY_MAX_WIDEN, 2 * Math.sqrt(want / Math.PI));
        p = Math.min(1, want / (Math.PI * (w / 2) ** 2));
      }
      if (attempt === 0 && hash2(gx, gz, seed + 31) > p) return;
      if (ct.blocked?.(x, z, 1.5)) continue;
      const st = this.cbd?.streets;
      // CBD (real streets): its blocks are built up (buildCBD), trees only in the parks
      if (st && st.regionSD(x, z) > -2 && (st.park(x, z) < 0.6 || st.streetSD(x, z) < 2)) continue;
      if (this.onRealHouse(x, z, 1)) continue;
      // the procedural suburbs' painted streets and houses (none where the real houses are the truth)
      if (urban > 0.05 && !(ct.houses && housesCover(ct.houses, x, z))) {
        if (onStreet(x, z, this.cbd, this.dist)) continue;
        if (onProceduralHouse(x, z, this.cmap, this.cbd, ct.lotMask, 1, this.dist)) continue;
      }
      // the bush darker than the gardens' trees (the photo's crowns under them are a deep green)
      _c.setScalar((urban <= 0.05 ? 0.55 : 0.8) + 0.25 * hash2(gx, gz, seed + 34));
      // aux: a real canopy tree (1 + a shade in [0, 1)): on the photo it takes the photo's colour (materials.ts foliage)
      out.data[kind].push(x, hf.meshHeightAt(x, z) - 0.3, z, r * 40, w, s, w, _c.r, _c.g, _c.b, hash2(gx, gz, seed + 4), 1 + 0.999 * hash2(gx, gz, seed + 35));
      return;
    }
  }

  /** The Domain's trees in 50 m buckets, its park's box, and its trees' mean colour (the shade reference). */
  private domainIndex: { cells: Map<number, DomainTree[]>; box: [number, number, number, number]; mean: [number, number, number] } | null = null;

  private domainTrees(): NonNullable<TreeSource['domainIndex']> | null {
    const d = this.domain;
    if (!d) return null;
    if (!this.domainIndex) {
      const cells = new Map<number, DomainTree[]>();
      const mean: [number, number, number] = [0, 0, 0];
      for (const t of d.trees) {
        const k = (Math.floor(t.x / 50) + 8192) * 16384 + (Math.floor(t.z / 50) + 8192);
        const l = cells.get(k);
        if (l) l.push(t);
        else cells.set(k, [t]);
        mean[0] += ((t.colour >> 16) & 255) / d.trees.length;
        mean[1] += ((t.colour >> 8) & 255) / d.trees.length;
        mean[2] += (t.colour & 255) / d.trees.length;
      }
      const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < d.park.length; i += 2) {
        box[0] = Math.min(box[0], d.park[i]);
        box[1] = Math.min(box[1], d.park[i + 1]);
        box[2] = Math.max(box[2], d.park[i]);
        box[3] = Math.max(box[3], d.park[i + 1]);
      }
      this.domainIndex = { cells, box, mean };
    }
    return this.domainIndex;
  }

  /** Inside the Domain's park (its trees are the measured ones there). */
  private inDomain(x: number, z: number): boolean {
    const ix = this.domainTrees();
    if (!ix) return false;
    const [x0, z0, x1, z1] = ix.box;
    return x >= x0 && x <= x1 && z >= z0 && z <= z1 && pointInRing(this.domain!.park, x, z);
  }

  /**
   * The Domain's measured trees in the tile [x0, x0 + size) × [z0, z0 + size): one crown per LiDAR tree at its height and
   * crown radius (the broadleaf archetype is 1 m tall with a 0.92 m crown), from the game's ground at its trunk, shaded
   * by its aerial colour against the park's mean; a tall narrow crown is a conifer. No blocker applies: they are measured.
   */
  private domainTile(x0: number, z0: number, size: number, out: TileInstances): void {
    const ix = this.domainTrees();
    if (!ix) return;
    const [bx0, bz0, bx1, bz1] = ix.box;
    if (x0 > bx1 || z0 > bz1 || x0 + size < bx0 || z0 + size < bz0) return;
    const hf = this.hf;
    for (let j = Math.floor(z0 / 50); j <= Math.floor((z0 + size) / 50); j++)
      for (let i = Math.floor(x0 / 50); i <= Math.floor((x0 + size) / 50); i++) {
        const l = ix.cells.get((i + 8192) * 16384 + (j + 8192));
        if (!l) continue;
        for (const t of l) {
          if (t.x < x0 || t.x >= x0 + size || t.z < z0 || t.z >= z0 + size) continue;
          const conifer = t.h > 15 && t.r < 0.2 * t.h;
          const w = conifer ? (2 * t.r) / 0.6 : (2 * t.r) / 0.92;
          const k = (v: number, m: number) => Math.max(0.65, Math.min(1.35, v / Math.max(1, m)));
          const r = k((t.colour >> 16) & 255, ix.mean[0]);
          const g = k((t.colour >> 8) & 255, ix.mean[1]);
          const b = k(t.colour & 255, ix.mean[2]);
          const h = hash2(Math.round(t.x * 10), Math.round(t.z * 10), this.seed + 21);
          out.data[conifer ? TREE_CONIFER : TREE_BROADLEAF].push(t.x, hf.meshHeightAt(t.x, t.z) - 0.3, t.z, h * 40, w, t.h, w, r, g, b, h, 0);
        }
      }
  }

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
    out.data[kind].push(x, hf.meshHeightAt(x, z) - 0.3, z, h1 * 40, w, s, w, _c.r, _c.g, _c.b, hash2(gx, gz, seed + 4), 0);
  }

  generate(x0: number, z0: number, size: number, out: TileInstances): void {
    const sp = this.spacing;
    const n = Math.floor(size / sp);
    const hf = this.hf;
    const seed = this.seed;
    this.domainTile(x0, z0, size, out);
    const m = this.measured;
    if (m) {
      // the measured trees in this tile (kept to the edge of the scatter's radius: they're the real ones)
      const t = m.trees;
      for (let i = 0; i < t.length; i += 7) {
        const x = t[i], z = t[i + 2];
        if (x < x0 || x >= x0 + size || z < z0 || z >= z0 + size) continue;
        _c.setScalar(t[i + 6]);
        out.data[t[i + 5] ? TREE_PALM : TREE_BROADLEAF].push(x, t[i + 1], z, hash2(i, 7, seed) * 40, t[i + 3], t[i + 4], t[i + 3], _c.r, _c.g, _c.b, 0.1 * hash2(i, 9, seed), 0);
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
        if (this.domain && this.inDomain(x, z)) continue;
        if (m?.covers(x, z, 2)) continue;
        const nb = this.nbs ? neighbourhoodAt(x, z, this.nbs) : null;
        if (nb) {
          this.nbTree(nb, x, z, gx, gz, out);
          continue;
        }
        const cs = canopyShareAt(this.canopy, x, z);
        if (cs >= 0) {
          this.canopyTree(cs, gx, gz, out);
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
        arr.push(x, hf.meshHeightAt(x, z) - 0.3, z, h3 * 40, w, s, w, _c.r, _c.g, _c.b, hash2(gx, gz, seed + 4), 0);
      }
    }
  }
}

export const HOUSE = 0;
export const APARTMENT = 1;
/** The house archetype's roof overhangs its walls by these factors across and along its ridge (archetypes.ts houseGeometry). */
export const HOUSE_OVERHANG_W = 1.1;
export const HOUSE_OVERHANG_D = 1.08;
/** Record aux of a real building drawn with its archetype's own roof (aux 0: procedural; ≥ 1: a real house, 1 + its rise). */
export const REAL_FLAG = 0.5;
/** A real flat-roofed building with its eave this high (m) or more is drawn as an apartment block (three storeys). */
export const REAL_APARTMENT_EAVE = 8;
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
    /**
     * The real houses (#121, aucklandHouses.ts): drawn as they were measured, under the aerial photo too (the procedural
     * lots step aside round them: their coverage is in `lotMask`). `realBlocked` keeps them off the road ribbons and the
     * landmark sites that have buildings of their own (the naval base).
     */
    private readonly real: RealHouses | null = null,
    private readonly realBlocked: ((x: number, z: number, margin: number) => boolean) | null = null,
  ) {
    this.kinds = landUse ? 3 : 2;
  }
  readonly kinds: number;

  private readonly front: FrontHouse[] = [];
  private readonly realIdx: number[] = [];

  /**
   * The real houses in the tile: a gable along the measured ridge (the house archetype, its roof's rise per instance:
   * record aux = 1 + rise, materials.ts HOUSES) or, flat and three storeys or more, an apartment block (aux = REAL_FLAG:
   * its own roof); the roof colour from the photo (roofColorFn takes the record's colour when aux > 0). The roof is the outline's (LINZ traces roofs), so the walls are the archetype's overhang inside it.
   * They stand from the lowest ground under their corners (no floating downhill side), their eave at the measured
   * height over the ground at their centre.
   */
  private realTile(x0: number, z0: number, size: number, out: TileInstances): void {
    const h = this.real!;
    this.realIdx.length = 0;
    const idx = housesIn(h, x0, z0, x0 + size, z0 + size, this.realIdx);
    for (const k of idx) {
      const x = h.x[k], z = h.z[k];
      if (this.realBlocked?.(x, z, 0.5)) continue;
      const c = Math.cos(h.dir[k]), sn = Math.sin(h.dir[k]);
      const hd = h.d[k] / 2, hw = h.w[k] / 2;
      const gc = this.groundAt(x, z);
      let base = gc;
      for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) base = Math.min(base, this.groundAt(x + c * hd * a - sn * hw * b, z + sn * hd * a + c * hw * b));
      base = Math.max(base, 0.2);
      const yaw = Math.atan2(c, sn); // local +Z (the archetype's ridge) along (c, sn)
      _c.setHex(h.color[k]);
      const rank = hash2(k & 0xffff, k >> 16, 121);
      const wall = h.eave[k] + Math.max(0, gc - base) + 0.3;
      if (h.rise[k] < 0.3 && h.eave[k] >= REAL_APARTMENT_EAVE)
        out.data[APARTMENT].push(x, base - 0.3, z, yaw, h.w[k], wall, h.d[k], _c.r, _c.g, _c.b, rank, REAL_FLAG);
      else out.data[HOUSE].push(x, base - 0.3, z, yaw, h.w[k] / HOUSE_OVERHANG_W, wall, h.d[k] / HOUSE_OVERHANG_D, _c.r, _c.g, _c.b, rank, 1 + h.rise[k]);
    }
  }

  generate(x0: number, z0: number, size: number, out: TileInstances): void {
    if (this.real) this.realTile(x0, z0, size, out);
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
        out.data[h.kind === FRONT_HOUSE ? HOUSE : APARTMENT].push(h.x, gh - 0.8, h.z, h.yaw, h.w, h.h + 0.8, h.d, 1, 1, 1, h.lh, 0);
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
              out.data[SHED].push(ucx, gh - 0.8, ucz, -d.angle, fp.sx * UNIT_LOTS * lotW, hgt + 0.8, fp.sz * lotD, 1, 1, 1, uh, 0);
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
          out.data[apt ? APARTMENT : HOUSE].push(wx, gh - 0.8, wz, -d.angle + (swap ? Math.PI / 2 : 0), swap ? dd : w, hgt + 0.8, swap ? w : dd, 1, 1, 1, lh, 0);
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

/** Roof colour for a house record (matches the terrain shader's roofColor(lh)); a real house (aux > 0) has its own. */
export function roofColorFn(roofs: Color[]): (rec: number[], i: number, out: Color) => void {
  return (rec, _i, out) => {
    if (rec[11] > 0) {
      out.setRGB(rec[7], rec[8], rec[9]);
      return;
    }
    const lh = rec[10];
    const c = roofs[Math.min(roofs.length - 1, Math.floor(lotFrac(lh, 5.1) * 5.999))];
    const k = 0.85 + 0.3 * lotFrac(lh, 7.3);
    out.setRGB(c.r * k, c.g * k, c.b * k);
  };
}
