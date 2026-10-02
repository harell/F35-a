/**
 * Polish 5/5 (#61): the corridor along Auckland's road and railway ribbons where the suburbs have no
 * houses. The terrain shader paints a house on every built lot of its procedural grid (urbanPattern)
 * and the instanced 3D houses stand on the same lots (sources.ts HouseSource), but neither knew about
 * the ribbons: the 3D houses were culled next to a road while the painted roofs stayed, so the
 * motorway, arterial and railway ribbons ran across rows of painted roofs.
 *
 * LotMask is one bit per LOT_MASK_CELL square: set where a lot centred in that cell would come within
 * LOT_CLEARANCE of a ribbon's centre line plus half width. A lot whose centre falls in a set cell is
 * left unbuilt (lawn and garden trees) by both the shader (lotMasked()) and HouseSource, so the
 * painted and the 3D houses still agree. Bits are packed 8 (x) × 4 (z) cells per RGBA8 texel: byte
 * `j & 3` of texel (i >> 3, j >> 2), bit `i & 7`. Node-safe (no three.js).
 */

/** Mask cell (m). */
export const LOT_MASK_CELL = 12;
/** How far (m) a house or apartment block reaches from its lot centre (sources.ts houseFootprint: ≤ 16.7 m). */
const HOUSE_REACH = 17;
/**
 * Clearance (m) from a ribbon's edge within which a lot centre is cleared. A lot centre anywhere in an
 * unset cell is at least LOT_CLEARANCE − half a cell diagonal from every edge, so its house keeps ≥ 1 m
 * off the ribbon.
 */
export const LOT_CLEARANCE = HOUSE_REACH + LOT_MASK_CELL * Math.SQRT1_2 + 1;

export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

export class LotMask {
  /** Texels across (8 cells each) and down (4 cells each). */
  readonly texW: number;
  readonly texH: number;
  /** RGBA8 texels, row 0 at z0. */
  readonly data: Uint8Array;

  constructor(
    readonly x0: number,
    readonly z0: number,
    readonly cols: number,
    readonly rows: number,
    readonly cell = LOT_MASK_CELL,
  ) {
    this.texW = Math.max(1, Math.ceil(cols / 8));
    this.texH = Math.max(1, Math.ceil(rows / 4));
    this.data = new Uint8Array(this.texW * this.texH * 4);
  }

  /** True when a lot centred at (x, z) is cleared (same arithmetic as the terrain shader's lotMasked()). */
  masked(x: number, z: number): boolean {
    const i = Math.floor((x - this.x0) / this.cell);
    const j = Math.floor((z - this.z0) / this.cell);
    if (i < 0 || j < 0 || i >= this.texW * 8 || j >= this.texH * 4) return false;
    return ((this.data[((j >> 2) * this.texW + (i >> 3)) * 4 + (j & 3)] >> (i & 7)) & 1) === 1;
  }

  private set(i: number, j: number): void {
    this.data[((j >> 2) * this.texW + (i >> 3)) * 4 + (j & 3)] |= 1 << (i & 7);
  }

  /** Number of set cells. */
  get count(): number {
    let n = 0;
    for (const b of this.data) for (let v = b; v; v &= v - 1) n++;
    return n;
  }

  /**
   * Mask over `rect` from ribbon segments, flat [ax, az, bx, bz, halfWidth] records
   * (RoadNetwork.segments): a cell is set when its centre is within halfWidth + clearance of a segment.
   */
  static fromSegments(segs: ArrayLike<number>, rect: Rect, clearance = LOT_CLEARANCE, cell = LOT_MASK_CELL): LotMask {
    const x0 = Math.floor(rect.x0 / cell) * cell;
    const z0 = Math.floor(rect.z0 / cell) * cell;
    const m = new LotMask(x0, z0, Math.ceil((rect.x1 - x0) / cell), Math.ceil((rect.z1 - z0) / cell), cell);
    const cols = m.texW * 8;
    const rows = m.texH * 4;
    for (let o = 0; o + 4 < segs.length; o += 5) {
      const ax = segs[o];
      const az = segs[o + 1];
      const dx = segs[o + 2] - ax;
      const dz = segs[o + 3] - az;
      const r = segs[o + 4] + clearance;
      const r2 = r * r;
      const l2 = dx * dx + dz * dz;
      const i0 = Math.max(0, Math.floor((Math.min(ax, ax + dx) - r - x0) / cell));
      const i1 = Math.min(cols - 1, Math.floor((Math.max(ax, ax + dx) + r - x0) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(az, az + dz) - r - z0) / cell));
      const j1 = Math.min(rows - 1, Math.floor((Math.max(az, az + dz) + r - z0) / cell));
      for (let j = j0; j <= j1; j++) {
        const cz = z0 + (j + 0.5) * cell;
        for (let i = i0; i <= i1; i++) {
          const cx = x0 + (i + 0.5) * cell;
          let t = l2 > 0 ? ((cx - ax) * dx + (cz - az) * dz) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = ax + dx * t - cx;
          const ez = az + dz * t - cz;
          if (ex * ex + ez * ez < r2) m.set(i, j);
        }
      }
    }
    return m;
  }
}

/**
 * Bounds of the built-up area in the baked colour map (alpha ≥ 0.5 + a trace: urban; texel centres,
 * grown by one texel), or null when there is none. The mask only needs to cover where lots are painted.
 */
export function urbanBounds(color: Uint8Array, size: number, origin: number, extent: number): Rect | null {
  let i0 = size;
  let i1 = -1;
  let j0 = size;
  let j1 = -1;
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++)
      if (color[(j * size + i) * 4 + 3] >= 129) {
        if (i < i0) i0 = i;
        if (i > i1) i1 = i;
        if (j < j0) j0 = j;
        if (j > j1) j1 = j;
      }
  if (i1 < 0) return null;
  const t = extent / size;
  return { x0: origin + (i0 - 1) * t, z0: origin + (j0 - 1) * t, x1: origin + (i1 + 2) * t, z1: origin + (j1 + 2) * t };
}
