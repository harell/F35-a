/**
 * The Tāmaki Drive waterfront, The Strand to St Heliers (8.2 km), as measured from public data
 * (tools/hero/sites/tamaki_drive.py, baked by tamaki_drive_bake.py): the shared path, the cycleway and the footpaths on
 * both sides of the road, the seawall (basalt revetment, stepped concrete, the low beach wall), the railings along its
 * crest, 229 lamp poles from the LINZ point cloud and 740 LiDAR trees (18 of them palms). LINZ LiDAR and aerial
 * (CC BY 4.0), © OpenStreetMap contributors (ODbL).
 *
 * src/world/scenery/data/tamaki-waterfront.bin (≈ 58 kB gzip), fetched once per page load next to the other Auckland
 * data. Without it the drive is the plain arterial ribbon it was.
 *
 * The game's terrain is coarse there and has the Hobson Bay causeway as sea. So every part stands on the higher of the
 * game's ground and its measured height; a measured "fill" closes the ground where the game has water instead of land,
 * and Tāmaki Drive's own ribbon takes the measured road as its floor (applyWaterfrontFloor) instead of being lifted onto
 * a viaduct.
 */
import waterfrontUrl from './data/tamaki-waterfront.bin?url';
import { fetchMaybeGzip } from '../terrain/theaters/aucklandLinz';
import { GeometryBuilder, IDENT_FRAME } from './GeometryBuilder';
import type { LightList } from './builders';
import type { RoadPath } from './motorways';

export const WATERFRONT_URL: string = waterfrontUrl;

type HeightFn = (x: number, z: number) => number;

export const WF_SHARED_PATH = 1;
export const WF_CYCLEWAY = 2;
export const WF_FOOTPATH = 3;
export const WF_ROAD = 4;
export const WF_FILL = 5;
export const WALL_ROCK = 0;
export const WALL_CONCRETE = 1;
export const WALL_LOW = 2;

/** A polyline with a width: a path, the road (kerb to kerb) or the fill. Game XZ, y in metres above the datum. */
export interface WaterfrontLine {
  kind: number;
  surface: number;
  x: Float32Array;
  z: Float32Array;
  y: Float32Array;
  w: Float32Array;
}

export interface WaterfrontWall {
  kind: number;
  /** Crest (top) and toe (bottom) points, same count. */
  cx: Float32Array;
  cz: Float32Array;
  cy: Float32Array;
  tx: Float32Array;
  tz: Float32Array;
  ty: Float32Array;
}

export interface WaterfrontRail {
  x: Float32Array;
  z: Float32Array;
  y: Float32Array;
}

export interface WaterfrontLamp {
  x: number;
  z: number;
  ground: number;
  top: number;
  /** The head's offset from the shaft (m, game XZ); 0, 0 when the point cloud showed none. */
  hx: number;
  hz: number;
}

export interface WaterfrontTree {
  x: number;
  z: number;
  ground: number;
  height: number;
  radius: number;
  /** Crown colour from the aerial (sRGB 0..255 packed 0xRRGGBB). */
  color: number;
  palm: boolean;
}

export interface Waterfront {
  lines: WaterfrontLine[];
  walls: WaterfrontWall[];
  rails: WaterfrontRail[];
  lamps: WaterfrontLamp[];
  trees: WaterfrontTree[];
}

const MAGIC = 'AKTW';
const VERSION = 1;

let current: Waterfront | null = null;
let version = 0;
let index: WaterfrontIndex | null = null;

export function tamakiWaterfront(): Waterfront | null {
  return current;
}

export function tamakiWaterfrontVersion(): number {
  return version;
}

/** Install decompressed bytes (null clears → the plain arterial). Throws on malformed data. */
export function setTamakiWaterfront(bytes: Uint8Array | null): void {
  current = bytes ? decodeWaterfront(bytes) : null;
  index = current ? new WaterfrontIndex(current) : null;
  version++;
}

export async function loadTamakiWaterfront(url = WATERFRONT_URL): Promise<boolean> {
  if (current) return true;
  try {
    setTamakiWaterfront(await fetchMaybeGzip(url));
    return true;
  } catch (err) {
    console.warn('[world] Tāmaki Drive waterfront unavailable, using the plain road', err);
    return false;
  }
}

export function decodeWaterfront(bytes: Uint8Array): Waterfront {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== MAGIC || dv.getUint32(4, true) !== VERSION) throw new Error('bad waterfront data header');
  let o = 8;
  const need = (n: number) => {
    if (o + n > bytes.length) throw new Error('truncated waterfront data');
  };
  const u32 = () => (need(4), (o += 4), dv.getUint32(o - 4, true));
  const u16 = () => (need(2), (o += 2), dv.getUint16(o - 2, true));
  const i16 = () => (need(2), (o += 2), dv.getInt16(o - 2, true));
  const u8 = () => (need(1), bytes[o++]);
  const i8 = () => (need(1), dv.getInt8(o++));
  const f32 = () => (need(4), (o += 4), dv.getFloat32(o - 4, true));
  const out: Waterfront = { lines: [], walls: [], rails: [], lamps: [], trees: [] };
  for (let k = 0, n = u32(); k < n; k++) {
    const kind = u8(), surface = u8(), m = u16();
    let px = f32(), pz = f32();
    const l: WaterfrontLine = { kind, surface, x: new Float32Array(m), z: new Float32Array(m), y: new Float32Array(m), w: new Float32Array(m) };
    for (let i = 0; i < m; i++) {
      px += i16() / 100;
      pz += i16() / 100;
      l.x[i] = px;
      l.z[i] = pz;
      l.y[i] = i16() / 100;
      l.w[i] = u8() / 10;
    }
    out.lines.push(l);
  }
  for (let k = 0, n = u32(); k < n; k++) {
    const kind = u8(), m = u16();
    let px = f32(), pz = f32();
    const w: WaterfrontWall = { kind, cx: new Float32Array(m), cz: new Float32Array(m), cy: new Float32Array(m), tx: new Float32Array(m), tz: new Float32Array(m), ty: new Float32Array(m) };
    for (let i = 0; i < m; i++) {
      px += i16() / 100;
      pz += i16() / 100;
      w.cx[i] = px;
      w.cz[i] = pz;
      w.cy[i] = i16() / 100;
      w.tx[i] = px + i16() / 100;
      w.tz[i] = pz + i16() / 100;
      w.ty[i] = i16() / 100;
    }
    out.walls.push(w);
  }
  for (let k = 0, n = u32(); k < n; k++) {
    const m = u16();
    let px = f32(), pz = f32();
    const r: WaterfrontRail = { x: new Float32Array(m), z: new Float32Array(m), y: new Float32Array(m) };
    for (let i = 0; i < m; i++) {
      px += i16() / 100;
      pz += i16() / 100;
      r.x[i] = px;
      r.z[i] = pz;
      r.y[i] = i16() / 100;
    }
    out.rails.push(r);
  }
  for (let k = 0, n = u32(); k < n; k++) {
    const x = f32(), z = f32(), ground = i16() / 100, top = i16() / 100, hx = i8() / 10, hz = i8() / 10;
    out.lamps.push({ x, z, ground, top, hx, hz });
  }
  for (let k = 0, n = u32(); k < n; k++) {
    const x = f32(), z = f32(), ground = i16() / 100, height = u16() / 100, radius = u8() / 10;
    const r = u8(), g = u8(), b = u8();
    out.trees.push({ x, z, ground, height, radius, color: (r << 16) | (g << 8) | b, palm: u8() === 1 });
  }
  return out;
}

const CELL = 10;
const key = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);

/** Spatial lookups: the measured road's floor, the strip's cells (no procedural trees there), trees by tile. */
class WaterfrontIndex {
  /** 10 m cell → the road's points [x, z, y, half width] in or next to it. */
  private road = new Map<number, number[]>();
  private strip = new Set<number>();
  private treeCells = new Map<number, WaterfrontTree[]>();

  constructor(d: Waterfront) {
    for (const l of d.lines) {
      const fill = l.kind === WF_FILL;
      const road = l.kind === WF_ROAD;
      if (!fill && !road) continue;
      for (let i = 0; i + 1 < l.x.length; i++) {
        const len = Math.hypot(l.x[i + 1] - l.x[i], l.z[i + 1] - l.z[i]);
        const steps = Math.max(1, Math.ceil(len / 2));
        for (let s = 0; s <= steps; s++) {
          const t = s / steps;
          const x = l.x[i] + (l.x[i + 1] - l.x[i]) * t, z = l.z[i] + (l.z[i + 1] - l.z[i]) * t;
          const y = l.y[i] + (l.y[i + 1] - l.y[i]) * t, hw = (l.w[i] + (l.w[i + 1] - l.w[i]) * t) / 2;
          if (road) {
            const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
            const a = this.road.get(k);
            if (a) a.push(x, z, y, hw);
            else this.road.set(k, [x, z, y, hw]);
          } else {
            // the strip: every cell the fill's cross-section passes through
            const tx = l.x[i + 1] - l.x[i], tz = l.z[i + 1] - l.z[i], tl = Math.hypot(tx, tz) || 1;
            const nx = -tz / tl, nz = tx / tl;
            for (let o = -hw; o <= hw; o += 3) this.strip.add(key(Math.floor((x + nx * o) / CELL), Math.floor((z + nz * o) / CELL)));
          }
        }
      }
    }
    for (const t of d.trees) {
      const k = key(Math.floor(t.x / 100), Math.floor(t.z / 100));
      const a = this.treeCells.get(k);
      if (a) a.push(t);
      else this.treeCells.set(k, [t]);
    }
  }

  /** The measured road surface (m) at (x, z), or null when (x, z) is not on Tāmaki Drive's measured carriageway. */
  roadFloor(x: number, z: number): number | null {
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    let best = Infinity, y: number | null = null;
    for (let j = cj - 1; j <= cj + 1; j++)
      for (let i = ci - 1; i <= ci + 1; i++) {
        const a = this.road.get(key(i, j));
        if (!a) continue;
        for (let k = 0; k < a.length; k += 4) {
          const d = Math.hypot(a[k] - x, a[k + 1] - z);
          if (d < best && d < a[k + 3] + 4) {
            best = d;
            y = a[k + 2];
          }
        }
      }
    return y;
  }

  inStrip(x: number, z: number): boolean {
    return this.strip.has(key(Math.floor(x / CELL), Math.floor(z / CELL)));
  }

  trees(x0: number, z0: number, size: number, cb: (t: WaterfrontTree) => void): void {
    for (let j = Math.floor(z0 / 100); j <= Math.floor((z0 + size) / 100); j++)
      for (let i = Math.floor(x0 / 100); i <= Math.floor((x0 + size) / 100); i++)
        for (const t of this.treeCells.get(key(i, j)) ?? []) if (t.x >= x0 && t.x < x0 + size && t.z >= z0 && t.z < z0 + size) cb(t);
  }
}

/** The measured road's surface (m) under (x, z), or null off Tāmaki Drive's measured carriageway. */
export function waterfrontRoadFloor(x: number, z: number): number | null {
  return index?.roadFloor(x, z) ?? null;
}

/**
 * Give every road ribbon running on the measured carriageway its floor (RoadPath.floor): Tāmaki Drive then rests on the
 * measured road instead of the game's coarse ground, and is no longer a viaduct on the Hobson Bay causeway. Returns the
 * number of points floored.
 */
export function applyWaterfrontFloor(paths: readonly RoadPath[]): number {
  if (!index) return 0;
  let count = 0;
  for (const p of paths) {
    if (p.kind !== 'arterial') continue;
    let f: Float32Array | null = null;
    for (let i = 0; i < p.x.length; i++) {
      const y = index.roadFloor(p.x[i], p.z[i]);
      if (y === null) continue;
      if (!f) f = new Float32Array(p.x.length).fill(NaN);
      f[i] = y;
      count++;
    }
    if (f) p.floor = f;
  }
  return count;
}

/** True inside the waterfront strip (seawall crest to the land's edge): its trees are the measured ones. */
export function inWaterfrontStrip(x: number, z: number): boolean {
  return index?.inStrip(x, z) ?? false;
}

/** The measured trees whose trunks stand in the tile [x0, x0 + size) × [z0, z0 + size). */
export function waterfrontTreesIn(x0: number, z0: number, size: number, cb: (t: WaterfrontTree) => void): void {
  index?.trees(x0, z0, size, cb);
}

// sRGB surface colours (the recipe's, checked against unshaded aerial pixels and Mapillary)
const SURFACE = [0x5c6063, 0xb8b4aa, 0xa89e92, 0x68804a, 0x484b4e];
const CYCLEWAY = 0x55625a;
const BANK = 0x5e7444;
const ROCK = [0x4a4c48, 0x3c3e3b, 0x55574f];
const SEAWALL = 0x96948c;
const SEAWALL_DARK = 0x77756e;
const RAIL = 0xe6e6de;
const POLE = 0x9a9ea1;
const HEAD = 0x6f7375;
/** Above the ground: the road ribbon sits 0.45 m up (motorways.ts), the paths a kerb's height over it. */
const PATH_LIFT = 0.6;
const FILL_LIFT = 0.35;
/** The fill is drawn only where the game has water (below this, m): the causeway and the reclaimed seawall top. */
const FILL_WET = 0.6;
/** Mesh chunks along the drive (frustum culling): one per this many metres of x. */
const CHUNK = 1500;

/** Quad a-b-c-d (each [x, y, z]) facing `want` (a direction; front faces only in the building material). */
function face(B: GeometryBuilder, a: number[], b: number[], c: number[], d: number[], want: number[], color: number): void {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const p = nx * want[0] + ny * want[1] + nz * want[2] >= 0 ? [...a, ...b, ...c, ...d] : [...a, ...d, ...c, ...b];
  B.quad(IDENT_FRAME, p, color);
}

const UP = [0, 1, 0];

/**
 * Build the waterfront into `chunk(x)`'s builder (one per CHUNK m of x, so each is culled on its own), its lamps' heads
 * into `lights`. `detail` is the quality tier's scenery density: railings from 0.5 up.
 */
export function buildTamakiWaterfront(chunk: (x: number) => GeometryBuilder, lights: LightList | null, height: HeightFn, detail: number, d: Waterfront | null = current): number {
  if (!d) return 0;
  const base = (x: number, z: number, y: number) => Math.max(height(x, z), y);
  let tris = 0;
  // ── paths and the fill: ribbons with a skirt down each edge (a kerb on the paths) ──
  for (const l of d.lines) {
    if (l.kind === WF_ROAD) continue; // the game's own ribbon draws the road (with its markings) on the measured floor
    const fill = l.kind === WF_FILL;
    const color = fill ? SURFACE[3] : l.kind === WF_CYCLEWAY ? CYCLEWAY : SURFACE[l.surface] ?? SURFACE[0];
    const n = l.x.length;
    for (let i = 0; i + 1 < n; i++) {
      const pts: number[][] = [];
      for (const k of [i, i + 1]) {
        const k0 = Math.max(0, k - 1), k1 = Math.min(n - 1, k + 1);
        let tx = l.x[k1] - l.x[k0], tz = l.z[k1] - l.z[k0];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl;
        tz /= tl;
        const hw = l.w[k] / 2;
        for (const s of [-1, 1]) {
          const x = l.x[k] - tz * hw * s, z = l.z[k] + tx * hw * s;
          pts.push([x, base(x, z, l.y[k]) + (fill ? FILL_LIFT : PATH_LIFT), z]);
        }
      }
      // pts: [i left, i right, i+1 left, i+1 right]
      if (fill) {
        const xm = (l.x[i] + l.x[i + 1]) / 2, zm = (l.z[i] + l.z[i + 1]) / 2;
        if (height(xm, zm) >= FILL_WET) continue;
      }
      const [a, b, c, e] = pts;
      const B = chunk((l.x[i] + l.x[i + 1]) / 2);
      face(B, a, b, e, c, UP, color);
      tris += 2;
      // edges: a path's kerb straight down; the fill's banks slope 1:2 down to the game's ground (or under its water)
      for (const [p, q] of [[a, c], [b, e]]) {
        const ox = p === a ? a[0] - b[0] : b[0] - a[0], oz = p === a ? a[2] - b[2] : b[2] - a[2];
        const ol = Math.hypot(ox, oz) || 1;
        if (!fill) {
          face(B, p, q, [q[0], q[1] - 2.5, q[2]], [p[0], p[1] - 2.5, p[2]], [ox, 0, oz], SEAWALL);
        } else {
          const foot = (v: number[]) => {
            const g = Math.min(height(v[0], v[2]), v[1]) - 0.5;
            const run = Math.min(12, 2 * (v[1] - g));
            return [v[0] + (ox / ol) * run, Math.min(g, height(v[0] + (ox / ol) * run, v[2] + (oz / ol) * run) - 0.3), v[2] + (oz / ol) * run];
          };
          face(B, p, q, foot(q), foot(p), [ox / ol, 1, oz / ol], BANK);
        }
        tris += 2;
      }
    }
  }
  // ── seawall: crest to toe, rock as a lumpy dark face in rows, concrete as steps, the beach wall straight down; a coping ──
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const w of d.walls) {
    const n = w.cx.length;
    for (let i = 0; i + 1 < n; i++) {
      const B = chunk((w.cx[i] + w.cx[i + 1]) / 2);
      const c0 = [w.cx[i], base(w.cx[i], w.cz[i], w.cy[i]) + 0.2, w.cz[i]], c1 = [w.cx[i + 1], base(w.cx[i + 1], w.cz[i + 1], w.cy[i + 1]) + 0.2, w.cz[i + 1]];
      // the toe tucks under the game's water and ground so no gap shows
      const toeY = (k: number) => Math.min(w.ty[k], height(w.tx[k], w.tz[k]), -0.6) - 0.6;
      const t0 = [w.tx[i], toeY(i), w.tz[i]], t1 = [w.tx[i + 1], toeY(i + 1), w.tz[i + 1]];
      const out = [(w.tx[i] + w.tx[i + 1] - w.cx[i] - w.cx[i + 1]) / 2, 0, (w.tz[i] + w.tz[i + 1] - w.cz[i] - w.cz[i + 1]) / 2];
      const lerp = (p: number[], q: number[], k: number) => [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k];
      if (w.kind === WALL_ROCK) {
        const rows = detail > 0.5 ? 3 : 1;
        for (let r = 0; r < rows; r++) {
          const k0 = r / rows, k1 = (r + 1) / rows;
          const j = (p: number[]) => [p[0] + (rnd() - 0.5) * 0.6, p[1] + (rnd() - 0.5) * 0.4, p[2] + (rnd() - 0.5) * 0.6];
          const a = r === 0 ? lerp(c0, t0, k0) : j(lerp(c0, t0, k0)), b = r === 0 ? lerp(c1, t1, k0) : j(lerp(c1, t1, k0));
          face(B, a, b, j(lerp(c1, t1, k1)), j(lerp(c0, t0, k1)), [out[0], 0.5, out[2]], ROCK[Math.floor(rnd() * 3)]);
          tris += 2;
        }
      } else if (w.kind === WALL_CONCRETE) {
        const steps = detail > 0.5 ? 4 : 1;
        for (let r = 0; r < steps; r++) {
          const k0 = r / steps, k1 = (r + 1) / steps;
          const a0 = lerp(c0, t0, k0), a1 = lerp(c1, t1, k0), b0 = lerp(c0, t0, k1), b1 = lerp(c1, t1, k1);
          if (steps === 1) {
            face(B, a0, a1, b1, b0, [out[0], 0.5, out[2]], SEAWALL);
            tris += 2;
            continue;
          }
          const m0 = [b0[0], a0[1], b0[2]], m1 = [b1[0], a1[1], b1[2]];
          face(B, a0, a1, m1, m0, UP, SEAWALL);
          face(B, m0, m1, b1, b0, out, SEAWALL_DARK);
          tris += 4;
        }
      } else {
        face(B, c0, c1, [c1[0], t1[1], c1[2]], [c0[0], t0[1], c0[2]], out, SEAWALL_DARK);
        tris += 2;
      }
      // coping: a lip on the crest
      const l0 = [c0[0], c0[1] + 0.25, c0[2]], l1 = [c1[0], c1[1] + 0.25, c1[2]];
      face(B, l0, l1, c1, c0, out, SEAWALL);
      face(B, [l0[0] - out[0] * 0.05, l0[1], l0[2] - out[2] * 0.05], [l1[0] - out[0] * 0.05, l1[1], l1[2] - out[2] * 0.05], l1, l0, UP, SEAWALL);
      tris += 4;
    }
  }
  // ── railings: posts every 2.5 m, top and mid rails ──
  if (detail >= 0.5) {
    for (const r of d.rails) {
      const n = r.x.length;
      let carry = 0;
      for (let i = 0; i + 1 < n; i++) {
        const B = chunk(r.x[i]);
        const ya = base(r.x[i], r.z[i], r.y[i]) + PATH_LIFT, yb = base(r.x[i + 1], r.z[i + 1], r.y[i + 1]) + PATH_LIFT;
        const L = Math.hypot(r.x[i + 1] - r.x[i], r.z[i + 1] - r.z[i]);
        for (let s = carry; s < L; s += 2.5) {
          const k = s / L, x = r.x[i] + (r.x[i + 1] - r.x[i]) * k, z = r.z[i] + (r.z[i + 1] - r.z[i]) * k, y = ya + (yb - ya) * k;
          B.box(IDENT_FRAME, x, y, z, 0.1, 1.1, 0.1, RAIL, RAIL);
          tris += 10;
        }
        carry = (((carry - L) % 2.5) + 2.5) % 2.5;
        for (const h of [1.1, 0.6]) B.beam(IDENT_FRAME, r.x[i], ya + h, r.z[i], r.x[i + 1], yb + h, r.z[i + 1], 0.07, RAIL);
        tris += 16;
      }
    }
  }
  // ── lamps: a tapered grey pole, one arm out to the measured head, a flat LED head; a light at the head ──
  for (const l of d.lamps) {
    const B = chunk(l.x);
    const g = base(l.x, l.z, l.ground), top = g + (l.top - l.ground);
    B.cylinder(IDENT_FRAME, l.x, g, l.z, 0.13, 0.08, top - 0.2 - g, 6, POLE, 0, true, POLE);
    let hx = l.hx, hz = l.hz;
    const arm = Math.hypot(hx, hz);
    if (arm < 0.6) hx = hz = 0;
    const tx = l.x + hx, tz = l.z + hz;
    if (arm >= 0.6) B.beam(IDENT_FRAME, l.x, top - 0.6, l.z, tx, top - 0.25, tz, 0.1, POLE);
    B.box(IDENT_FRAME, tx, top - 0.35, tz, 0.7, 0.16, 0.7, HEAD, HEAD);
    tris += 36;
    lights?.add(tx, top - 0.45, tz, 0xfff1d6, 3.6);
  }
  return tris;
}

/** One builder per CHUNK m of x along the drive; `get` makes them on demand. */
export function waterfrontChunks(): { get: (x: number) => GeometryBuilder; all: Map<number, GeometryBuilder> } {
  const all = new Map<number, GeometryBuilder>();
  return {
    all,
    get: (x: number) => {
      const k = Math.floor(x / CHUNK);
      let b = all.get(k);
      if (!b) all.set(k, (b = new GeometryBuilder()));
      return b;
    },
  };
}
