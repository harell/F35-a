/**
 * Road frontage: the row of lots that lines both sides of every arterial and main street (LINZ, motorways.ts
 * kind 'arterial'), each facing the road across its footpath, as the suburbs are really laid out. Without it
 * the procedural grid (urbanGrid.ts) ran under the ribbon at its own angle and the ribbon cut across blocks and
 * cleared a strip of lawn either side (lotMask.ts).
 *
 * Each arterial is cut into straight segments (Douglas–Peucker, FRONT_SIMPLIFY m). A segment's band reaches
 * FRONT_BAND m past its kerb on each side: a FRONT_FOOTPATH m footpath, then lots FRONT_DEPTH m deep and about
 * FRONT_LOT_W m wide, fitted to the segment and trimmed on the inside of each bend (no lot crosses the bisector).
 * Every lot is decided here, once: a house, an apartment block, a shop (in a town centre) or empty (water, another
 * ribbon, a landmark site, the CBD region, a side street, an empty section). The terrain shader paints the same
 * lots (frontageLot() in terrainShader.ts) and HouseSource stands the 3D houses on them.
 *
 * Inside the band the grid streets that meet the road at more than ≈ 35° carry on to the kerb (side streets);
 * the ones running along it stop at the back of the lots, and the grid's own lots are cleared behind the band
 * (Scenery: the mask's clearance starts at the band's back edge).
 *
 * Shared with the shader as four textures (FRONT_TEX_W texels across, texelFetch):
 *  - cells (RGBA8, FRONT_CELL m squares): start of the cell's candidate list (R + G·256 + B·65536) and its length (A);
 *  - list (RGBA8): segment indices (R + G·256 + B·65536);
 *  - segments (RGBA32F, 4 texels each): (ax, az, ux, uz), (length, half width, first lot flag left, right),
 *    (s0, lot width, lots) left, the same right;
 *  - flags (R8): one byte per lot, FRONT_EMPTY / HOUSE / APARTMENT / SHOP.
 * `at()` replicates the shader's lookup exactly (the same candidates, the same nearest rule). Node-safe.
 */
import type { RoadPath } from './motorways';
import { BLOCK_D, BLOCK_W, districtAt, hash12, toLocal, type CbdGrid, type District } from './urbanGrid';

/** Footpath between the kerb and the lots (m). */
export const FRONT_FOOTPATH = 3.5;
/** Lot depth from the footpath to the back fence (m). */
export const FRONT_DEPTH = 34;
/** Band reach past the kerb (m). */
export const FRONT_BAND = FRONT_FOOTPATH + FRONT_DEPTH;
/** Target lot width along the road (m); each segment side fits a whole number of lots. */
export const FRONT_LOT_W = 17.5;
/** Narrowest lot kept (m). */
const MIN_LOT_W = 12;
/** Straight-segment tolerance (m). */
export const FRONT_SIMPLIFY = 2;
/** Cell of the candidate grid (m). */
export const FRONT_CELL = 64;
/** Most candidate segments per cell (the shader's loop bound); the nearest to the cell centre are kept. */
export const FRONT_MAX = 12;
/** Texels across every frontage texture. */
export const FRONT_TEX_W = 1024;
/** A grid street crosses the band (a side street) when it meets the road at more than ≈ 55°: |cos| below this. */
export const SIDE_STREET_COS = 0.57;
/** Gap (m) left for a side street between two blocks of lots: its carriageway and a margin. */
export const SIDE_STREET_GAP = 9;
/** Clearance (m) a house keeps from a side street's centre line: its half width (3.6 m) and a margin. */
const SIDE_STREET_CLEAR = 4.4;

export const FRONT_EMPTY = 0;
export const FRONT_HOUSE = 1;
export const FRONT_APARTMENT = 2;
export const FRONT_SHOP = 3;
export type FrontKind = typeof FRONT_EMPTY | typeof FRONT_HOUSE | typeof FRONT_APARTMENT | typeof FRONT_SHOP;

/** What the lots need to know about the world (Scenery wires these to the heightfield, colour map, ribbons…). */
export interface FrontageWorld {
  /** Distance (m) to the nearest ribbon edge (every road and railway; RoadNetwork.edgeDistance). */
  ribbonEdge(x: number, z: number): number;
  /** Urban density 0..1 (colour map). */
  urban(x: number, z: number): number;
  /** Ground height (m). */
  ground(x: number, z: number): number;
  /** True where no lot may stand: a landmark site, the CBD region with its real streets. */
  excluded(x: number, z: number): boolean;
  /** True in a town centre (shops line the road there). */
  centre?(x: number, z: number): boolean;
  /** The districts' street grid (CbdGrid: the region with real streets has none). */
  cbd: CbdGrid | null;
}

/** One straight piece of an arterial. */
export interface FrontSegment {
  ax: number;
  az: number;
  /** Unit direction; the left side (side 0) is +n = (−uz, ux). */
  ux: number;
  uz: number;
  len: number;
  /** Carriageway half width (m). */
  hw: number;
  /**
   * Per side (0 left, 1 right): where the lots start along the segment, their width and count, the first flag;
   * `period` > 0 when they come in blocks between side streets (one every `period` m, a SIDE_STREET_GAP m gap
   * centred on each, `perBlock` lots between), else 0 (`s0 + k · lotW`).
   */
  s0: [number, number];
  lotW: [number, number];
  n: [number, number];
  flag: [number, number];
  period: [number, number];
  perBlock: [number, number];
  /** Span (m along the segment) the lots must keep inside: the bend trims. */
  lo: [number, number];
  hi: [number, number];
}

/** A point's place in the band: its segment, side and lot, and its coordinates in the lot frame. */
export interface FrontHit {
  seg: number;
  side: 0 | 1;
  /** Along the segment (m from its start, may be < 0 or > len past its ends). */
  s: number;
  /** Distance from the kerb (m, negative on the carriageway). */
  kerb: number;
  /** Lot index along the side, or −1 (a bend trim, the segment's ends). */
  lot: number;
  /** In the lot: along the road from its start, and back from the footpath (m). */
  lx: number;
  ly: number;
}

/** A built lot's house (HouseSource), with its place for the tests. */
export interface FrontHouse {
  x: number;
  z: number;
  /** Instance yaw (rad, as HouseSource's: local X of the archetype along `w`). */
  yaw: number;
  w: number;
  d: number;
  h: number;
  kind: FrontKind;
  /** Lot hash (roof colour, as the shader's lh). */
  lh: number;
  seg: number;
  side: 0 | 1;
  lot: number;
}

const f32 = Math.fround;
const fract = (x: number) => x - Math.floor(x);
/** GLSL fract(lh * k) with float32 rounding. */
const lotFrac = (lh: number, k: number) => fract(f32(f32(lh) * f32(k)));

/** The shader's lot hash of lot `k` on `side` of segment `seg`. */
export function frontLotHash(seg: number, side: number, k: number): number {
  return hash12(k + 17, seg * 2 + side + 101);
}

/**
 * House footprint in a frontage lot as fractions of (lot width, FRONT_DEPTH), front at 0 (terrainShader.ts
 * frontage branch of urbanPattern): a house set back behind its front lawn, an apartment block, or a shop built
 * out to the footpath across the whole lot.
 */
export function frontFootprint(lh: number, kind: FrontKind): { cx: number; cy: number; sx: number; sy: number } {
  if (kind === FRONT_SHOP) return { cx: 0.5, cy: 0.3, sx: 0.96, sy: 0.56 };
  if (kind === FRONT_APARTMENT) return { cx: 0.5, cy: 0.45, sx: 0.8, sy: 0.55 + 0.2 * lotFrac(lh, 13.9) };
  return { cx: 0.5 + (lotFrac(lh, 37.1) - 0.5) * 0.14, cy: 0.4, sx: 0.5 + 0.24 * lotFrac(lh, 71.7), sy: 0.3 + 0.14 * lotFrac(lh, 13.9) };
}

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + dx * t - px, az + dz * t - pz);
}

/** Douglas–Peucker over a path's points (indices kept). */
function simplifyIdx(x: Float32Array, z: Float32Array, i0: number, i1: number, tol: number): number[] {
  const keep = new Uint8Array(x.length);
  keep[i0] = keep[i1] = 1;
  const stack: [number, number][] = [[i0, i1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1;
    let bd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(x[i], z[i], x[a], z[a], x[b], z[b]);
      if (d > bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out: number[] = [];
  for (let i = i0; i <= i1; i++) if (keep[i]) out.push(i);
  return out;
}

export class FrontageMap {
  readonly segments: FrontSegment[] = [];
  /** Candidate grid origin (m), size (cells). */
  readonly x0: number = 0;
  readonly z0: number = 0;
  readonly cols: number = 0;
  readonly rows: number = 0;
  readonly cell = FRONT_CELL;
  /** RGBA8 cells, `cols` × `rows` texels. */
  readonly cellData: Uint8Array;
  /** RGBA8 list, FRONT_TEX_W texels across. */
  readonly listData: Uint8Array;
  readonly listRows: number;
  /** RGBA32F segments, 4 texels each, FRONT_TEX_W texels across. */
  readonly segData: Float32Array;
  readonly segRows: number;
  /** R8 lot flags, FRONT_TEX_W across. */
  readonly flagData: Uint8Array;
  readonly flagRows: number;
  /** Built lots' houses, bucketed by `bucket` m squares. */
  private readonly houses = new Map<number, FrontHouse[]>();
  private readonly bucket = 100;
  /** Lot counts by kind (stats, tests). */
  readonly counts = [0, 0, 0, 0];
  private readonly cellStart: Int32Array;
  private readonly cellCount: Uint8Array;
  private readonly list: number[] = [];

  /**
   * `bounds`: the built-up area (lotMask.ts urbanBounds); the terrain only paints the suburbs inside it, so the
   * candidate grid stops there.
   */
  constructor(paths: readonly RoadPath[], world: FrontageWorld, bounds?: { x0: number; z0: number; x1: number; z1: number } | null) {
    // ── segments ──
    for (const p of paths) {
      if (p.kind !== 'arterial') continue;
      const n = p.x.length;
      // runs outside tunnels (arterials have none today)
      for (let i = 0; i < n; ) {
        if (p.tunnel[i]) {
          i++;
          continue;
        }
        let j = i;
        while (j + 1 < n && !p.tunnel[j + 1]) j++;
        if (j > i) this.addRun(p, simplifyIdx(p.x, p.z, i, j, FRONT_SIMPLIFY), world.cbd);
        i = j + 1;
      }
    }
    // ── candidate cells ──
    const reach = (s: FrontSegment) => s.hw + FRONT_BAND;
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (const s of this.segments) {
      const r = reach(s);
      const bx = s.ax + s.ux * s.len;
      const bz = s.az + s.uz * s.len;
      minX = Math.min(minX, s.ax - r, bx - r);
      maxX = Math.max(maxX, s.ax + r, bx + r);
      minZ = Math.min(minZ, s.az - r, bz - r);
      maxZ = Math.max(maxZ, s.az + r, bz + r);
    }
    const cell = FRONT_CELL;
    if (bounds) {
      minX = Math.max(minX, bounds.x0);
      minZ = Math.max(minZ, bounds.z0);
      maxX = Math.min(maxX, bounds.x1);
      maxZ = Math.min(maxZ, bounds.z1);
    }
    if (this.segments.length && maxX > minX && maxZ > minZ) {
      this.x0 = Math.floor(minX / cell) * cell;
      this.z0 = Math.floor(minZ / cell) * cell;
      this.cols = Math.ceil((maxX - this.x0) / cell) + 1;
      this.rows = Math.ceil((maxZ - this.z0) / cell) + 1;
    }
    const cells: number[][] = [];
    const cellOf = new Map<number, number>();
    const half = (cell * Math.SQRT2) / 2;
    this.segments.forEach((s, k) => {
      const r = reach(s) + half;
      const bx = s.ax + s.ux * s.len;
      const bz = s.az + s.uz * s.len;
      const i0 = Math.floor((Math.min(s.ax, bx) - r - this.x0) / cell);
      const i1 = Math.floor((Math.max(s.ax, bx) + r - this.x0) / cell);
      const j0 = Math.floor((Math.min(s.az, bz) - r - this.z0) / cell);
      const j1 = Math.floor((Math.max(s.az, bz) + r - this.z0) / cell);
      for (let j = Math.max(0, j0); j <= Math.min(this.rows - 1, j1); j++)
        for (let i = Math.max(0, i0); i <= Math.min(this.cols - 1, i1); i++) {
          const cx = this.x0 + (i + 0.5) * cell;
          const cz = this.z0 + (j + 0.5) * cell;
          if (segDist(cx, cz, s.ax, s.az, bx, bz) > r) continue;
          const q = j * this.cols + i;
          let c = cellOf.get(q);
          if (c === undefined) {
            c = cells.push([]) - 1;
            cellOf.set(q, c);
          }
          cells[c].push(k);
        }
    });
    this.cellData = new Uint8Array(Math.max(1, this.cols * this.rows) * 4);
    this.cellStart = new Int32Array(Math.max(1, this.cols * this.rows));
    this.cellCount = new Uint8Array(Math.max(1, this.cols * this.rows));
    for (const [q, c] of cellOf) {
      let l = cells[c];
      if (l.length > FRONT_MAX) {
        const cx = this.x0 + ((q % this.cols) + 0.5) * cell;
        const cz = this.z0 + (Math.floor(q / this.cols) + 0.5) * cell;
        const d = (k: number) => {
          const s = this.segments[k];
          return segDist(cx, cz, s.ax, s.az, s.ax + s.ux * s.len, s.az + s.uz * s.len) - s.hw;
        };
        l = l.slice().sort((a, b) => d(a) - d(b)).slice(0, FRONT_MAX);
      }
      const start = this.list.length;
      this.list.push(...l);
      this.cellStart[q] = start;
      this.cellCount[q] = l.length;
      this.cellData[q * 4] = start & 255;
      this.cellData[q * 4 + 1] = (start >> 8) & 255;
      this.cellData[q * 4 + 2] = (start >> 16) & 255;
      this.cellData[q * 4 + 3] = l.length;
    }
    this.listRows = Math.max(1, Math.ceil(this.list.length / FRONT_TEX_W));
    this.listData = new Uint8Array(FRONT_TEX_W * this.listRows * 4);
    this.list.forEach((k, i) => {
      this.listData[i * 4] = k & 255;
      this.listData[i * 4 + 1] = (k >> 8) & 255;
      this.listData[i * 4 + 2] = (k >> 16) & 255;
    });
    // ── lots ──
    let nFlags = 0;
    for (const s of this.segments)
      for (const side of [0, 1] as const) {
        s.flag[side] = nFlags;
        nFlags += s.n[side];
      }
    this.flagRows = Math.max(1, Math.ceil(nFlags / FRONT_TEX_W));
    this.flagData = new Uint8Array(FRONT_TEX_W * this.flagRows);
    const scratch = {} as District;
    this.segments.forEach((s, k) => {
      for (const side of [0, 1] as const)
        for (let lot = 0; lot < s.n[side]; lot++) {
          const kind = this.decide(k, side, lot, world, scratch);
          this.flagData[s.flag[side] + lot] = kind;
          this.counts[kind]++;
          if (kind !== FRONT_EMPTY) this.addHouse(k, side, lot, kind);
        }
    });
    this.segRows = Math.max(1, Math.ceil((this.segments.length * 4) / FRONT_TEX_W));
    this.segData = new Float32Array(FRONT_TEX_W * this.segRows * 4);
    this.segments.forEach((s, k) => {
      this.segData.set([s.ax, s.az, s.ux, s.uz, s.len, s.hw, s.flag[0], s.flag[1], s.s0[0], s.lotW[0], s.n[0], s.period[0], s.s0[1], s.lotW[1], s.n[1], s.period[1]], k * 16);
    });
  }

  /** Segments of one simplified run (vertex indices `idx` into the path), with the bend trims and the lots. */
  private addRun(p: RoadPath, idx: number[], cbd: CbdGrid | null): void {
    const first = this.segments.length;
    const hw = p.width / 2;
    for (let m = 0; m + 1 < idx.length; m++) {
      const ax = p.x[idx[m]];
      const az = p.z[idx[m]];
      const dx = p.x[idx[m + 1]] - ax;
      const dz = p.z[idx[m + 1]] - az;
      const len = Math.hypot(dx, dz);
      if (len < 0.5) continue;
      this.segments.push({ ax, az, ux: dx / len, uz: dz / len, len, hw, s0: [0, 0], lotW: [0, 0], n: [0, 0], flag: [0, 0], period: [0, 0], perBlock: [0, 0], lo: [0, 0], hi: [0, 0] });
    }
    const segs = this.segments.slice(first);
    // trims at the start / end of each segment, per side
    const t0 = segs.map(() => [0, 0]);
    const t1 = segs.map(() => [0, 0]);
    for (let m = 0; m + 1 < segs.length; m++) {
      const a = segs[m];
      const b = segs[m + 1];
      const cross = a.ux * b.uz - a.uz * b.ux;
      const dot = a.ux * b.ux + a.uz * b.uz;
      const turn = Math.abs(Math.atan2(cross, dot));
      if (turn < 0.01) continue;
      // the inside of the bend: the left (+n) side when turning toward it
      const inner = cross > 0 ? 0 : 1;
      const trim = (hw + FRONT_BAND) * Math.tan(Math.min(turn, 2.6) / 2) + 0.5;
      t1[m][inner] = Math.max(t1[m][inner], trim);
      t0[m + 1][inner] = Math.max(t0[m + 1][inner], trim);
    }
    const scratch = {} as District;
    segs.forEach((s, m) => {
      for (const side of [0, 1] as const) {
        const a = t0[m][side];
        const b = s.len - t1[m][side];
        const usable = b - a;
        s.lo[side] = a;
        s.hi[side] = b;
        // in blocks between the side streets: a gap at each crossing, as many lots as fit between two
        const phase = sideStreetPhase(s, side, cbd, scratch);
        if (phase && usable > 0) {
          const P = phase.period;
          const m = Math.max(1, Math.round((P - SIDE_STREET_GAP) / FRONT_LOT_W));
          const w = (P - SIDE_STREET_GAP) / m;
          // the block before the first lot that fits (lots before `a` stay empty)
          const s0 = phase.at + Math.floor((a - phase.at) / P) * P;
          let n = 0;
          for (let k = 0; ; k++) {
            const start = s0 + Math.floor(k / m) * P + SIDE_STREET_GAP / 2 + (k % m) * w;
            if (start + w > b + 1e-6) break;
            n = k + 1;
          }
          if (n > 0) {
            s.n[side] = n;
            s.lotW[side] = w;
            s.s0[side] = s0;
            s.period[side] = P;
            s.perBlock[side] = m;
          }
          continue;
        }
        let n = usable > 0 ? Math.round(usable / FRONT_LOT_W) : 0;
        if (n > 0 && usable / n < MIN_LOT_W) n--;
        if (n <= 0) continue;
        s.n[side] = n;
        s.lotW[side] = usable / n;
        s.s0[side] = a;
      }
    });
  }

  /** The band at (x, z): the shader's frontageLot() lookup (same candidates, nearest kerb wins), or null. */
  at(x: number, z: number): FrontHit | null {
    const i = Math.floor((x - this.x0) / this.cell);
    const j = Math.floor((z - this.z0) / this.cell);
    if (i < 0 || j < 0 || i >= this.cols || j >= this.rows) return null;
    const q = j * this.cols + i;
    const count = this.cellCount[q];
    if (!count) return null;
    const start = this.cellStart[q];
    let best = -1;
    let bd = FRONT_BAND;
    let bs = 0;
    let bt = 0;
    for (let c = 0; c < count; c++) {
      const k = this.list[start + c];
      const sg = this.segments[k];
      const vx = x - sg.ax;
      const vz = z - sg.az;
      const s = vx * sg.ux + vz * sg.uz;
      const t = -vx * sg.uz + vz * sg.ux;
      const sc = s < 0 ? 0 : s > sg.len ? sg.len : s;
      const d = Math.hypot(s - sc, t) - sg.hw;
      if (d < bd) {
        bd = d;
        best = k;
        bs = s;
        bt = t;
      }
    }
    if (best < 0) return null;
    const sg = this.segments[best];
    const side = bt >= 0 ? 0 : 1;
    const kerb = Math.abs(bt) - sg.hw;
    const ly = kerb - FRONT_FOOTPATH;
    const [lot, lx] = sg.n[side] > 0 && ly >= 0 && ly < FRONT_DEPTH ? lotAlong(bs - sg.s0[side], sg.lotW[side], sg.period[side], sg.n[side]) : [-1, 0];
    return { seg: best, side, s: bs, kerb, lot, lx, ly };
  }

  /** The built kind of a lot (its flag). */
  kindOf(seg: number, side: 0 | 1, lot: number): FrontKind {
    const s = this.segments[seg];
    return lot >= 0 && lot < s.n[side] ? (this.flagData[s.flag[side] + lot] as FrontKind) : FRONT_EMPTY;
  }

  /** World position of a point in a lot (lx along the road from the lot's start, ly back from the footpath). */
  lotPoint(seg: number, side: 0 | 1, lot: number, lx: number, ly: number): [number, number] {
    const s = this.segments[seg];
    const along = this.lotStart(s, side, lot) + lx;
    const off = (s.hw + FRONT_FOOTPATH + ly) * (side === 0 ? 1 : -1);
    return [s.ax + s.ux * along - s.uz * off, s.az + s.uz * along + s.ux * off];
  }

  /** Start of a lot along its segment (m). */
  private lotStart(s: FrontSegment, side: 0 | 1, lot: number): number {
    const m = s.perBlock[side];
    return s.period[side] > 0 ? s.s0[side] + Math.floor(lot / m) * s.period[side] + SIDE_STREET_GAP / 2 + (lot % m) * s.lotW[side] : s.s0[side] + lot * s.lotW[side];
  }

  /** Every built lot's house whose centre lies in [x0, x0 + size) × [z0, z0 + size). */
  housesIn(x0: number, z0: number, size: number, out: FrontHouse[] = []): FrontHouse[] {
    const b = this.bucket;
    for (let j = Math.floor(z0 / b); j <= Math.floor((z0 + size) / b); j++)
      for (let i = Math.floor(x0 / b); i <= Math.floor((x0 + size) / b); i++)
        for (const h of this.houses.get((i + 4096) * 8192 + (j + 4096)) ?? []) if (h.x >= x0 && h.x < x0 + size && h.z >= z0 && h.z < z0 + size) out.push(h);
    return out;
  }

  /** True within the band of an arterial (its footpath and lots), where the grid has no buildings. */
  inBand(x: number, z: number): boolean {
    return this.at(x, z) !== null;
  }

  /**
   * What stands on a lot: empty where any of it is off this lot in the band lookup (another segment's nearer),
   * near another ribbon, over water, on an excluded site or crossed by a side street; else a shop in a town
   * centre, an apartment block in the densest parts, a house — or an empty section, as often as on the grid.
   */
  private decide(seg: number, side: 0 | 1, lot: number, w: FrontageWorld, scratch: District): FrontKind {
    const s = this.segments[seg];
    const W = s.lotW[side];
    // (a block's first lots before the bend trim)
    const start = this.lotStart(s, side, lot);
    if (start < s.lo[side] - 1e-6 || start + W > s.hi[side] + 1e-6) return FRONT_EMPTY;
    const pts: [number, number][] = [];
    for (const fy of [0.08, 0.5, 0.92]) for (const fx of [0.12, 0.5, 0.88]) pts.push(this.lotPoint(seg, side, lot, fx * W, fy * FRONT_DEPTH));
    for (const [x, z] of pts) {
      const h = this.at(x, z);
      if (!h || h.seg !== seg || h.side !== side || h.lot !== lot) return FRONT_EMPTY;
      if (w.ribbonEdge(x, z) < 2 || w.ground(x, z) < 0.6 || w.excluded(x, z)) return FRONT_EMPTY;
    }
    const [cx, cz] = pts[4];
    const dens = w.urban(cx, cz);
    if (dens < 0.08 || w.ground(cx, cz) < 1) return FRONT_EMPTY;
    const lh = frontLotHash(seg, side, lot);
    const kind: FrontKind = w.centre?.(cx, cz) ? FRONT_SHOP : lh >= 0.8 + 0.2 * dens ? FRONT_EMPTY : dens > 0.9 ? FRONT_APARTMENT : FRONT_HOUSE;
    if (kind === FRONT_EMPTY) return kind;
    // the house itself: clear of every ribbon and of the side streets (which cross the rest of the lot to the kerb)
    const fp = frontFootprint(lh, kind);
    const x0 = (fp.cx - fp.sx / 2) * W;
    const x1 = (fp.cx + fp.sx / 2) * W;
    const y0 = (fp.cy - fp.sy / 2) * FRONT_DEPTH;
    const y1 = (fp.cy + fp.sy / 2) * FRONT_DEPTH;
    const corners = [this.lotPoint(seg, side, lot, x0, y0), this.lotPoint(seg, side, lot, x1, y0), this.lotPoint(seg, side, lot, x1, y1), this.lotPoint(seg, side, lot, x0, y1)];
    const edge = [...corners, this.lotPoint(seg, side, lot, (x0 + x1) / 2, y0), this.lotPoint(seg, side, lot, (x0 + x1) / 2, y1), this.lotPoint(seg, side, lot, x0, (y0 + y1) / 2), this.lotPoint(seg, side, lot, x1, (y0 + y1) / 2)];
    if (edge.some(([x, z]) => w.ribbonEdge(x, z) < 1.5)) return FRONT_EMPTY;
    // (and wholly on its own lot as the band lookup sees it: not into a neighbouring segment's at a bend)
    for (const [x, z] of edge) {
      const h = this.at(x, z);
      if (!h || h.seg !== seg || h.side !== side || h.lot !== lot) return FRONT_EMPTY;
    }
    const seen: string[] = [];
    for (const [x, z] of [[cx, cz] as [number, number], ...edge]) {
      const d = districtAt(x, z, undefined, scratch, w.cbd);
      if (d.real) return FRONT_EMPTY;
      const key = `${d.cx},${d.cz}`;
      if (seen.includes(key)) continue;
      seen.push(key);
      if (crossedBySideStreet(d, s.ux, s.uz, corners)) return FRONT_EMPTY;
    }
    return kind;
  }

  private addHouse(seg: number, side: 0 | 1, lot: number, kind: FrontKind): void {
    const s = this.segments[seg];
    const lh = frontLotHash(seg, side, lot);
    const fp = frontFootprint(lh, kind);
    const W = s.lotW[side];
    const [x, z] = this.lotPoint(seg, side, lot, fp.cx * W, fp.cy * FRONT_DEPTH);
    const w = fp.sx * W;
    const d = fp.sy * FRONT_DEPTH;
    const h = kind === FRONT_SHOP ? 5 + 4 * lotFrac(lh, 5.7) : kind === FRONT_APARTMENT ? 12 + 14 * lotFrac(lh, 5.7) : 3.2 + 1.6 * lotFrac(lh, 3.3);
    // the archetype's local X runs along `w`: along the road; ridge along the long side (HouseSource's swap)
    const yaw = -Math.atan2(s.uz, s.ux);
    const swap = w > d;
    const house: FrontHouse = { x, z, yaw: yaw + (swap ? Math.PI / 2 : 0), w: swap ? d : w, d: swap ? w : d, h, kind, lh, seg, side, lot };
    const key = (Math.floor(x / this.bucket) + 4096) * 8192 + (Math.floor(z / this.bucket) + 4096);
    const l = this.houses.get(key);
    if (l) l.push(house);
    else this.houses.set(key, [house]);
  }
}

/**
 * Lot index and position in it of a point `u` m along a side from its `s0`: lots of width `w`, uniform or in
 * blocks of `period` m with a SIDE_STREET_GAP gap centred on each block boundary; [−1, 0] off the lots.
 * (terrainShader.ts frontageLot() computes the same.)
 */
export function lotAlong(u: number, w: number, period: number, n: number): [number, number] {
  let k: number;
  let x: number;
  if (period > 0) {
    const m = Math.floor((period - SIDE_STREET_GAP) / w + 0.5);
    const b = Math.floor(u / period);
    const v = u - b * period - SIDE_STREET_GAP / 2;
    const j = Math.floor(v / w);
    if (v < 0 || j >= m) return [-1, 0];
    k = b * m + j;
    x = v - j * w;
  } else {
    k = Math.floor(u / w);
    x = u - k * w;
  }
  return k >= 0 && k < n ? [k, x] : [-1, 0];
}

/** Families of grid lines in district `d` that meet a road of direction (ux, uz) square enough to cross its band. */
export function sideStreetFamilies(d: District, ux: number, uz: number): [boolean, boolean] {
  // road direction in the district's local frame (toLocal's rotation)
  const lx = d.cos * ux + d.sin * uz;
  const lz = -d.sin * ux + d.cos * uz;
  // lines x = k·BLOCK_W run along local z; lines z = k·BLOCK_D along local x
  return [Math.abs(lz) < SIDE_STREET_COS, Math.abs(lx) < SIDE_STREET_COS];
}

/**
 * Where the side streets cross one side of a segment's band (at its middle depth): the crossings of the grid
 * family meeting the road most squarely, `at` + k · `period` m along the segment. Null when none crosses (the
 * district has the real CBD streets, or its grid runs along the road both ways).
 */
function sideStreetPhase(s: FrontSegment, side: 0 | 1, cbd: CbdGrid | null, scratch: District): { at: number; period: number } | null {
  const off = (s.hw + FRONT_FOOTPATH + FRONT_DEPTH / 2) * (side === 0 ? 1 : -1);
  const mx = s.ax + s.ux * (s.len / 2) - s.uz * off;
  const mz = s.az + s.uz * (s.len / 2) + s.ux * off;
  const d = districtAt(mx, mz, undefined, scratch, cbd);
  if (d.real) return null;
  const [fx, fz] = sideStreetFamilies(d, s.ux, s.uz);
  const lx = d.cos * s.ux + d.sin * s.uz;
  const lz = -d.sin * s.ux + d.cos * s.uz;
  // the family whose lines the road crosses most squarely
  const useX = fx && (!fz || Math.abs(lx) / BLOCK_W >= Math.abs(lz) / BLOCK_D);
  if (!useX && !fz) return null;
  const S = useX ? BLOCK_W : BLOCK_D;
  const rate = useX ? lx : lz;
  // local coordinate of the band's middle line at the segment's start
  const [px, pz] = toLocal(d, s.ax - s.uz * off, s.az + s.ux * off);
  const p0 = useX ? px : pz;
  const period = S / Math.abs(rate);
  // first crossing p0 + rate · t = k · S at t ≥ 0 (or the one before it: only the phase matters)
  const t = (Math.ceil(p0 / S) * S - p0) / rate;
  return { at: ((t % period) + period) % period, period };
}

/** True when a side street of district `d` runs through the rectangle with these corners (a house). */
function crossedBySideStreet(d: District, ux: number, uz: number, corners: [number, number][]): boolean {
  const [fx, fz] = sideStreetFamilies(d, ux, uz);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of corners) {
    const [px, pz] = toLocal(d, x, z);
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minZ = Math.min(minZ, pz);
    maxZ = Math.max(maxZ, pz);
  }
  const m = SIDE_STREET_CLEAR;
  const hits = (lo: number, hi: number, S: number) => Math.floor((hi + m) / S) * S >= lo - m;
  return (fx && hits(minX, maxX, BLOCK_W)) || (fz && hits(minZ, maxZ, BLOCK_D));
}
