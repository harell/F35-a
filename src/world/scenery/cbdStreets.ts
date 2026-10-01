/**
 * Auckland CBD street map (LINZ phase 2a): inside the CBD region (aucklandRoads.ts) the terrain shader
 * paints Auckland's real streets instead of the procedural Voronoi grid.
 *
 * The street centrelines are rasterised once per data install into a small RGBA8 texture (4 m texels
 * over the region's bounding box, ≈ 0.6 × 0.8 k texels):
 *   R  distance to the nearest kerb (m, + off the street; ±32 m in 0.25 m steps)
 *   G  signed distance to the region border (m, + inside)
 *   B  park coverage (Albert Park, Victoria Park, Myers Park)
 *   A  motorway verge: within MOTORWAY_VERGE m of a motorway carriageway (grassy embankments)
 * Distance fields interpolate well, so 4 m texels still give kerbs to a fraction of a metre.
 * The shader samples it with LINEAR / CLAMP_TO_EDGE filtering; `streetSD` / `regionSD` / `park` below
 * replicate that lookup exactly, so 3D houses, trees and towers agree with the painted streets.
 * `kerbDistance` / `inRegion` answer the same questions exactly from the vectors (placement, tests).
 */
import { aucklandRoads, aucklandRoadsVersion, ROAD_MOTORWAY, ROAD_STREET, type RoadData, type RoadLine } from './aucklandRoads';

/** Texel size (m). */
export const STREET_CELL = 4;
/** Encoded distance range (± m). */
export const STREET_RANGE = 32;
/** Footpath width painted beside every kerb (m). */
export const FOOTPATH = 3;
/** Grass verge / embankment beside the motorway carriageways in the CBD region (m from the edge). */
export const MOTORWAY_VERGE = 18;

/** CBD parks (game XZ, traced along the streets that bound them in the LINZ data). */
export const CBD_PARKS: { name: string; pts: [number, number][] }[] = [
  // Kitchener St, Wellesley St East, Princes St, Bowen Ave
  { name: 'Albert Park', pts: [[406, 92], [354, 258], [327, 333], [374, 384], [460, 476], [533, 385], [562, 311], [688, -23], [602, 17]] },
  // Fanshawe St, Halsey St, Victoria St West and the SH1 viaduct
  { name: 'Victoria Park', pts: [[-800, -352], [-727, -341], [-642, -312], [-540, -278], [-504, -263], [-521, -39], [-800, -46]] },
  // the gully between Queen St and Greys Ave, Mayoral Dr to Karangahape Rd
  { name: 'Myers Park', pts: [[-30, 610], [20, 640], [-5, 760], [-50, 880], [-95, 985], [-150, 975], [-125, 870], [-85, 735]] },
];

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + dx * t - px, az + dz * t - pz);
}

/** Even–odd point-in-polygon for a flat [x0, z0, ...] ring. */
export function pointInRing(ring: ArrayLike<number>, x: number, z: number): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const zi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const zj = ring[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** OR `bit` into the texels whose centres lie inside a ring (even–odd scanline fill, same rule as pointInRing). */
function fillRing(out: Uint8Array, ring: ArrayLike<number>, x0: number, z0: number, cell: number, cols: number, rows: number, bit: number): void {
  const n = ring.length / 2;
  const xs: number[] = [];
  for (let j = 0; j < rows; j++) {
    const z = z0 + (j + 0.5) * cell;
    xs.length = 0;
    for (let i = 0, k = n - 1; i < n; k = i++) {
      const xi = ring[i * 2];
      const zi = ring[i * 2 + 1];
      const xk = ring[k * 2];
      const zk = ring[k * 2 + 1];
      if (zi > z !== zk > z) xs.push(((xk - xi) * (z - zi)) / (zk - zi) + xi);
    }
    xs.sort((a, b) => a - b);
    for (let m = 0; m + 1 < xs.length; m += 2) {
      // texel centres x with xs[m] < x < xs[m+1] (pointInRing counts x < crossing)
      const i0 = Math.max(0, Math.floor((xs[m] - x0) / cell - 0.5) + 1);
      const i1 = Math.min(cols - 1, Math.ceil((xs[m + 1] - x0) / cell - 0.5) - 1);
      for (let i = i0; i <= i1; i++) out[j * cols + i] |= bit;
    }
  }
}

/** Nearest street to a point: distance to its kerb (m, negative on the carriageway) and direction. */
export interface NearestStreet {
  kerb: number;
  /** Unit direction of the street segment. */
  dx: number;
  dz: number;
  /** Signed side of the point (+1 left of the segment direction, −1 right). */
  side: number;
  halfWidth: number;
  line: RoadLine;
}

export class CbdStreets {
  /** Texture origin (m) and size (texels); texel (i, j) covers [x0 + i·cell, x0 + (i+1)·cell). */
  readonly x0: number;
  readonly z0: number;
  readonly cols: number;
  readonly rows: number;
  readonly cell = STREET_CELL;
  /** RGBA8 texels (see the module comment). */
  readonly data: Uint8Array;
  readonly region: Float32Array;
  /** Streets painted by the shader (kind ROAD_STREET). */
  readonly streets: RoadLine[];
  /** Motorway carriageways (open, not in a tunnel). */
  private readonly motorways: RoadLine[];
  /** Region bounding box (m). */
  readonly bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  private readonly bucket = 50;
  private readonly buckets = new Map<number, number[]>();
  /** Flat [ax, az, bx, bz, halfWidth, line] per segment. */
  private readonly segs: number[] = [];

  constructor(d: RoadData) {
    this.region = d.region;
    this.streets = d.lines.filter((l) => l.kind === ROAD_STREET && !l.tunnel);
    this.motorways = d.lines.filter((l) => l.kind === ROAD_MOTORWAY && !l.tunnel);
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < d.region.length; i += 2) {
      minX = Math.min(minX, d.region[i]);
      maxX = Math.max(maxX, d.region[i]);
      minZ = Math.min(minZ, d.region[i + 1]);
      maxZ = Math.max(maxZ, d.region[i + 1]);
    }
    this.bounds = { minX, minZ, maxX, maxZ };
    // margin: the edge texels are 'outside, far from the border' (CLAMP_TO_EDGE repeats them)
    const m = STREET_RANGE + 2 * STREET_CELL;
    this.x0 = Math.floor((minX - m) / STREET_CELL) * STREET_CELL;
    this.z0 = Math.floor((minZ - m) / STREET_CELL) * STREET_CELL;
    this.cols = Math.ceil((maxX + m - this.x0) / STREET_CELL);
    this.rows = Math.ceil((maxZ + m - this.z0) / STREET_CELL);

    this.streets.forEach((l, li) => {
      const p = l.pts;
      for (let i = 0; i + 3 < p.length; i += 2) {
        const k = this.segs.length / 6;
        this.segs.push(p[i], p[i + 1], p[i + 2], p[i + 3], l.width / 2, li);
        const r = l.width / 2 + STREET_RANGE + 8;
        const i0 = Math.floor((Math.min(p[i], p[i + 2]) - r) / this.bucket);
        const i1 = Math.floor((Math.max(p[i], p[i + 2]) + r) / this.bucket);
        const j0 = Math.floor((Math.min(p[i + 1], p[i + 3]) - r) / this.bucket);
        const j1 = Math.floor((Math.max(p[i + 1], p[i + 3]) + r) / this.bucket);
        for (let j = j0; j <= j1; j++)
          for (let ii = i0; ii <= i1; ii++) {
            const key = (ii + 4096) * 8192 + (j + 4096);
            let b = this.buckets.get(key);
            if (!b) this.buckets.set(key, (b = []));
            b.push(k);
          }
      }
    });
    this.data = this.rasterise();
  }

  private rasterise(): Uint8Array {
    const { cols, rows, cell, x0, z0 } = this;
    const R = STREET_RANGE;
    const kerb = new Float32Array(cols * rows).fill(R);
    const border = new Float32Array(cols * rows).fill(R);
    const stamp = (field: Float32Array, ax: number, az: number, bx: number, bz: number, off: number) => {
      const r = R + off + cell;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - x0) / cell));
      const i1 = Math.min(cols - 1, Math.ceil((Math.max(ax, bx) + r - x0) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - r - z0) / cell));
      const j1 = Math.min(rows - 1, Math.ceil((Math.max(az, bz) + r - z0) / cell));
      for (let j = j0; j <= j1; j++) {
        const z = z0 + (j + 0.5) * cell;
        for (let i = i0; i <= i1; i++) {
          const d = segDist(x0 + (i + 0.5) * cell, z, ax, az, bx, bz) - off;
          const k = j * cols + i;
          if (d < field[k]) field[k] = d;
        }
      }
    };
    const s = this.segs;
    for (let o = 0; o < s.length; o += 6) stamp(kerb, s[o], s[o + 1], s[o + 2], s[o + 3], s[o + 4]);
    const g = this.region;
    const n = g.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) stamp(border, g[j * 2], g[j * 2 + 1], g[i * 2], g[i * 2 + 1], 0);
    const verge = new Float32Array(cols * rows).fill(R);
    for (const l of this.motorways) {
      const p = l.pts;
      for (let i = 0; i + 3 < p.length; i += 2) {
        if (Math.max(p[i], p[i + 2]) < x0 - R || Math.min(p[i], p[i + 2]) > x0 + cols * cell + R) continue;
        if (Math.max(p[i + 1], p[i + 3]) < z0 - R || Math.min(p[i + 1], p[i + 3]) > z0 + rows * cell + R) continue;
        stamp(verge, p[i], p[i + 1], p[i + 2], p[i + 3], l.width / 2);
      }
    }
    const inside = new Uint8Array(cols * rows);
    fillRing(inside, g, x0, z0, cell, cols, rows, 1);
    for (const p of CBD_PARKS) fillRing(inside, Float32Array.from(p.pts.flat()), x0, z0, cell, cols, rows, 2);
    const out = new Uint8Array(cols * rows * 4);
    const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 4 + 128)));
    for (let k = 0; k < cols * rows; k++) {
      const f = inside[k];
      out[k * 4] = q(kerb[k]);
      out[k * 4 + 1] = q(f & 1 ? border[k] : -border[k]);
      out[k * 4 + 2] = f === 3 ? 255 : 0;
      out[k * 4 + 3] = verge[k] < MOTORWAY_VERGE ? 255 : 0;
    }
    return out;
  }

  /** Bilinear texel lookup (0–255) as the GPU does it: LINEAR filter, CLAMP_TO_EDGE, texel centres. */
  private sample(ch: number, x: number, z: number): number {
    let gx = (x - this.x0) / this.cell - 0.5;
    let gz = (z - this.z0) / this.cell - 0.5;
    const { cols, rows } = this;
    gx = gx < 0 ? 0 : gx > cols - 1 ? cols - 1 : gx;
    gz = gz < 0 ? 0 : gz > rows - 1 ? rows - 1 : gz;
    const ix = Math.min(cols - 2, Math.floor(gx));
    const iz = Math.min(rows - 2, Math.floor(gz));
    const fx = gx - ix;
    const fz = gz - iz;
    const d = this.data;
    const k = (iz * cols + ix) * 4 + ch;
    const a = d[k] + (d[k + 4] - d[k]) * fx;
    const b = d[k + cols * 4] + (d[k + cols * 4 + 4] - d[k + cols * 4]) * fx;
    return a + (b - a) * fz;
  }

  /** Painted kerb distance (m, + off the street), as the shader sees it. */
  streetSD(x: number, z: number): number {
    return (this.sample(0, x, z) - 128) / 4;
  }

  /** Signed distance to the region border (m, + inside), as the shader sees it. */
  regionSD(x: number, z: number): number {
    return (this.sample(1, x, z) - 128) / 4;
  }

  /** Park coverage 0..1, as the shader sees it. */
  park(x: number, z: number): number {
    return this.sample(2, x, z) / 255;
  }

  /** Motorway verge coverage 0..1, as the shader sees it. */
  verge(x: number, z: number): number {
    return this.sample(3, x, z) / 255;
  }

  /** Exact region test (vector polygon). */
  inRegion(x: number, z: number): boolean {
    return pointInRing(this.region, x, z);
  }

  /** Nearest street within ≈ 40 m of its kerb (exact, from the vectors), or null. */
  nearest(x: number, z: number): NearestStreet | null {
    const key = (Math.floor(x / this.bucket) + 4096) * 8192 + (Math.floor(z / this.bucket) + 4096);
    const b = this.buckets.get(key);
    if (!b) return null;
    const s = this.segs;
    let best = -1;
    let bd = Infinity;
    for (const k of b) {
      const o = k * 6;
      const d = segDist(x, z, s[o], s[o + 1], s[o + 2], s[o + 3]) - s[o + 4];
      if (d < bd) {
        bd = d;
        best = o;
      }
    }
    if (best < 0) return null;
    const dx = s[best + 2] - s[best];
    const dz = s[best + 3] - s[best + 1];
    const l = Math.hypot(dx, dz) || 1;
    const cross = dx * (z - s[best + 1]) - dz * (x - s[best]);
    return { kerb: bd, dx: dx / l, dz: dz / l, side: cross >= 0 ? 1 : -1, halfWidth: s[best + 4], line: this.streets[s[best + 5]] };
  }

  /** Exact distance to the nearest kerb (m, negative on the carriageway; ≥ 40 m reported as 40). */
  kerbDistance(x: number, z: number): number {
    const n = this.nearest(x, z);
    return n ? Math.min(40, n.kerb) : 40;
  }
}

let cache: { version: number; streets: CbdStreets | null } = { version: -1, streets: null };

/** The CBD street map of the installed LINZ road data (built once per install), or null. */
export function aucklandStreets(): CbdStreets | null {
  const v = aucklandRoadsVersion();
  if (cache.version !== v) {
    const d = aucklandRoads();
    cache = { version: v, streets: d && d.region.length >= 6 ? new CbdStreets(d) : null };
  }
  return cache.streets;
}
