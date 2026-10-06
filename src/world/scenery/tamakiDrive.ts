/**
 * The Tāmaki Drive waterfront's meshes (data and its sources: tamakiDriveData.ts), merged into the builder Scenery
 * hands in (the city's road-side mesh: no draw call of its own): the shared path, cycleway and footpaths beside the
 * road, the seawall (basalt revetment, stepped concrete, the low beach wall) with its coping, the white post-and-rail
 * fence on the crest, the lamp poles with their arm and LED head (a warm light each at night) and, where the drive
 * crosses water, a low bridge deck on piers. The trees go to the game's tree scatter (TreeSource, `tamakiTrees`).
 *
 * The ground. The game's terrain (an 86 m grid on medium, 43 m on high) can't hold a strip 40 m wide: along the
 * Hobson Bay causeway, the western 600 m, it has sea where the road, the paths and the verges stand ~3 m above the
 * water, so the road ribbon became a viaduct on piers. `tamakiGround` is the terrain raised to the road's measured
 * level (the LiDAR DEM under the carriageway) between the seawall's crest and the land edge of the strip; the road
 * ribbon, the paths, the lamps and the trees all stand on it, and wherever it is above the terrain a grass verge fills
 * the strip at that level, the seawall dropping to the water on the harbour side and an embankment on the land side.
 * Over the two real bridges (the Hobson Bay outlet, Ngapipi Road) the level runs between the abutments and a deck
 * spans the water instead of the fill.
 */
import { GeometryBuilder, IDENT_FRAME, WIN_GLOW, WIN_NONE, frameFromHeading } from './GeometryBuilder';
import type { HeightFn, LightList } from './builders';
import { TD_CONCRETE, TD_LOW, TD_ROCK, tdAt, tdPlace, tdPoint, type TamakiDrive, type TdSurface } from './tamakiDriveData';

/** Surface colours (sRGB) read off unshaded aerial pixels and Mapillary (tamaki_drive.py SURF). */
const COL = {
  asphalt: 0x5c6063,
  concrete: 0xb8b4aa,
  paving: 0xa89e92,
  grass: 0x68804a,
  sand: 0xc4b696,
  rock: [74, 76, 72] as const,
  seawall: 0x96948c,
  deck: 0x8c8b86,
  rail: 0xe6e6de,
  pole: 0x9a9ea0,
  head: 0x737778,
};
/** Paths sit this far over the ground (the road ribbon is at +0.45: a path running onto it stays on top). */
const PATH_LIFT = 0.5;
/** The verge fill over the raised ground. */
const FILL_LIFT = 0.08;
/** The coping on the seawall's crest: width and height over the ground. */
const COPING = 0.25;
/** The railing's height (OSM fence, 1.1 m post-and-rail from Mapillary). */
const RAIL_H = 1.1;
/** A station needs the raised ground when the terrain anywhere across it is this far under the road's level. */
const RAISE = 0.25;

/** The harbour edge of the raised ground per station: the seawall's crest, else the harbour-most path's outer edge. */
function harbourEdge(td: TamakiDrive): Float32Array {
  const e = new Float32Array(td.n).fill(Infinity);
  const wall = new Uint8Array(td.n);
  for (const w of td.walls)
    for (let i = 0; i < w.crest.length; i++) {
      e[w.k0 + i] = w.crest[i];
      wall[w.k0 + i] = 1;
    }
  for (const p of td.paths)
    for (let i = 0; i < p.o.length; i++) {
      const k = p.k0 + i;
      if (!wall[k]) e[k] = Math.min(e[k], p.o[i] - p.w[i] / 2 - 1);
    }
  for (let k = 0; k < td.n; k++) if (!Number.isFinite(e[k])) e[k] = Math.max(td.lo[k], -8);
  return e;
}

const edges = new WeakMap<TamakiDrive, Float32Array>();
function edgeOf(td: TamakiDrive): Float32Array {
  let e = edges.get(td);
  if (!e) edges.set(td, (e = harbourEdge(td)));
  return e;
}

/** Bounding box of the strip (+ margin) for a quick reject. */
function bounds(td: TamakiDrive, m: number): [number, number, number, number] {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < td.n; i++) {
    x0 = Math.min(x0, td.x[i]);
    x1 = Math.max(x1, td.x[i]);
    z0 = Math.min(z0, td.z[i]);
    z1 = Math.max(z1, td.z[i]);
  }
  return [x0 - m, z0 - m, x1 + m, z1 + m];
}

/**
 * The ground the waterfront stands on: the terrain, raised to the road's measured level between the seawall's crest
 * and the strip's land edge (see the header). Elsewhere `height` itself.
 */
export function tamakiGround(td: TamakiDrive, height: HeightFn): HeightFn {
  const [x0, z0, x1, z1] = bounds(td, 70);
  const edge = edgeOf(td);
  return (x, z) => {
    const h = height(x, z);
    if (x < x0 || x > x1 || z < z0 || z > z1) return h;
    const p = tdPlace(td, x, z, 60);
    // (0.5 m of slack: the strip's own vertices on its edges must land inside it)
    if (!p || p.k <= 0 || p.k >= td.n - 1 || p.o < tdAt(edge, p.k) - 0.5 || p.o > tdAt(td.hi, p.k) + 0.5) return h;
    return Math.max(h, tdAt(td.level, p.k));
  };
}

/** True on the strip (from the seawall's toe to its land edge, + `margin` m): no scattered trees, houses or generic road lamps. */
export function tamakiCovers(td: TamakiDrive): (x: number, z: number, margin?: number) => boolean {
  const [x0, z0, x1, z1] = bounds(td, 70);
  return (x, z, margin = 0) => {
    if (x < x0 || x > x1 || z < z0 || z > z1) return false;
    const p = tdPlace(td, x, z, 60 + margin);
    return !!p && p.o >= tdAt(td.lo, p.k) - margin && p.o <= tdAt(td.hi, p.k) + margin;
  };
}

/** A face with its normal turned towards (ox, oy, oz) (world points, flat [x, y, z, …], 3 or 4 of them). */
function face(B: GeometryBuilder, p: number[], color: number | readonly number[], ox: number, oy: number, oz: number, win = WIN_NONE): void {
  const n = p.length / 3;
  const ax = p[3] - p[0], ay = p[4] - p[1], az = p[5] - p[2];
  const bx = p[(n - 1) * 3] - p[0], by = p[(n - 1) * 3 + 1] - p[1], bz = p[(n - 1) * 3 + 2] - p[2];
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  let q = p;
  if (nx * ox + ny * oy + nz * oz < 0) {
    q = [];
    for (let i = n - 1; i >= 0; i--) q.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
  }
  const c = typeof color === 'number' ? color : (color[0] << 16) | (color[1] << 8) | color[2];
  if (n === 4) B.quad(IDENT_FRAME, q, c, win);
  else B.tri(IDENT_FRAME, q, c, win);
}

/** Deterministic 0..1 noise for station k, row j. */
function hash(k: number, j: number): number {
  const s = Math.sin(k * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** An sRGB hex colour with its channels scaled. */
function tint(c: number, r: number, g: number, b: number): number {
  const ch = (v: number, f: number) => Math.min(255, Math.round(v * f));
  return (ch((c >> 16) & 255, r) << 16) | (ch((c >> 8) & 255, g) << 8) | ch(c & 255, b);
}

const SURFACE_COL: Record<TdSurface, number> = { asphalt: COL.asphalt, concrete: COL.concrete, paving: COL.paving };

/**
 * Build the waterfront into `B` and its lamps' lights into `lights` (when given). `ground` = tamakiGround(td, height),
 * `height` the bare terrain; `detail` the tier's sceneryDensity (low: one face per seawall section, no railings,
 * four-sided poles; high: three rows of rock, five steps, posts every 2.5 m). Returns the triangles added.
 */
export function buildTamakiDrive(B: GeometryBuilder, lights: LightList | null, td: TamakiDrive, ground: HeightFn, height: HeightFn, detail: number): number {
  const t0 = B.triangleCount;
  const hi = detail >= 0.9;
  const lo = detail < 0.5;
  const edge = edgeOf(td);
  const P = (k: number, o: number, lift: number): [number, number, number] => {
    const [x, z] = tdPoint(td, k, o);
    return [x, ground(x, z) + lift, z];
  };

  // ── the raised ground: a grass verge at the road's level wherever the terrain is lower (the causeway) ──
  const ACROSS = 6;
  const need = new Uint8Array(td.n);
  for (let k = 0; k < td.n; k++) {
    if (td.bridge[k]) continue;
    for (let j = 0; j <= ACROSS; j++) {
      const [x, z] = tdPoint(td, k, edge[k] + ((td.hi[k] - edge[k]) * j) / ACROSS);
      if (height(x, z) < td.level[k] - RAISE) need[k] = 1;
    }
  }
  const walled = new Uint8Array(td.n);
  for (const w of td.walls) walled.fill(1, w.k0, w.k0 + w.crest.length);
  for (let k = 0; k + 1 < td.n; k++) {
    if (!(need[k] || need[k + 1]) || td.bridge[k] || td.bridge[k + 1]) continue;
    const row = (kk: number) => {
      const out: [number, number, number][] = [];
      for (let j = 0; j <= ACROSS; j++) out.push(P(kk, edge[kk] + ((td.hi[kk] - edge[kk]) * j) / ACROSS, FILL_LIFT));
      return out;
    };
    const a = row(k), b = row(k + 1);
    for (let j = 0; j < ACROSS; j++) face(B, [...a[j], ...a[j + 1], ...b[j + 1], ...b[j]], COL.grass, 0, 1, 0);
    // the land side: an embankment down to the terrain
    const la = a[ACROSS], lb = b[ACROSS];
    const ga = height(la[0], la[2]) - 0.5, gb = height(lb[0], lb[2]) - 0.5;
    if (la[1] > ga + 0.6 || lb[1] > gb + 0.6) face(B, [...la, ...lb, lb[0], gb, lb[2], la[0], ga, la[2]], COL.grass, td.nx[k], 0, td.nz[k]);
    // the harbour side where no seawall stands (a beach, the bridges' approaches): a sand bank 4 m out to the ground
    if (!walled[k] || !walled[k + 1]) {
      const bank = (kk: number, top: [number, number, number]): [number, number, number] => {
        const [x, z] = tdPoint(td, kk, edge[kk] - 4);
        return [x, Math.max(Math.min(height(x, z), top[1] - 0.6), -1.5), z];
      };
      const sa = a[0], sb = b[0], ta = bank(k, sa), tb = bank(k + 1, sb);
      // (onto a beach: sand; onto land, the port's yards at The Strand: grass)
      face(B, [...sa, ...sb, ...tb, ...ta], Math.min(ta[1], tb[1]) > 2 ? COL.grass : COL.sand, -td.nx[k], 1, -td.nz[k]);
    }
  }

  // ── bridges: a deck at the road's level from the harbour edge to the land edge, piers every 30 m ──
  for (let k = 0; k + 1 < td.n; k++) {
    if (!td.bridge[k] && !td.bridge[k + 1]) continue;
    const a0 = P(k, edge[k], 0.35), a1 = P(k, td.hi[k], 0.35), b0 = P(k + 1, edge[k + 1], 0.35), b1 = P(k + 1, td.hi[k + 1], 0.35);
    face(B, [...a0, ...a1, ...b1, ...b0], COL.deck, 0, 1, 0);
    face(B, [a0[0], a0[1] - 1.5, a0[2], b0[0], b0[1] - 1.5, b0[2], b1[0], b1[1] - 1.5, b1[2], a1[0], a1[1] - 1.5, a1[2]], COL.deck, 0, -1, 0);
    for (const [p, q, s] of [[a0, b0, -1], [a1, b1, 1]] as const)
      face(B, [...p, ...q, q[0], q[1] - 1.5, q[2], p[0], p[1] - 1.5, p[2]], COL.deck, td.nx[k] * s, 0, td.nz[k] * s);
    if (td.bridge[k] && k % 3 === 0 && td.bridge[k - 1] && td.bridge[k + 1]) {
      const [x, z] = tdPoint(td, k, (edge[k] + td.hi[k]) / 2);
      const top = a0[1] - 1.5;
      const bed = Math.min(0, height(x, z)) - 1.5;
      B.box(frameFromHeading(x, bed, z, Math.atan2(td.nx[k], -td.nz[k])), 0, 0, 0, 1.2, top - bed, (td.hi[k] - edge[k]) * 0.85, COL.deck, COL.deck);
    }
  }

  // ── paths: a ribbon each, with a kerb face down both edges ──
  for (const p of td.paths) {
    // (the cycleway's surface reads a touch greener)
    const col = p.kind === 'CY' ? tint(SURFACE_COL[p.surface], 0.92, 1.04, 0.95) : SURFACE_COL[p.surface];
    const kerb = tint(col, 0.8, 0.8, 0.8);
    for (let i = 0; i + 1 < p.o.length; i++) {
      const k = p.k0 + i;
      const a = P(k, p.o[i] - p.w[i] / 2, PATH_LIFT), b = P(k, p.o[i] + p.w[i] / 2, PATH_LIFT);
      const c = P(k + 1, p.o[i + 1] + p.w[i + 1] / 2, PATH_LIFT), d = P(k + 1, p.o[i + 1] - p.w[i + 1] / 2, PATH_LIFT);
      face(B, [...a, ...b, ...c, ...d], col, 0, 1, 0);
      if (lo) continue; // (the low tier: no kerb faces, unseen from the air)
      const drop = 0.6;
      face(B, [...a, ...d, d[0], d[1] - drop, d[2], a[0], a[1] - drop, a[2]], kerb, -td.nx[k], 0, -td.nz[k]);
      face(B, [...b, ...c, c[0], c[1] - drop, c[2], b[0], b[1] - drop, b[2]], kerb, td.nx[k], 0, td.nz[k]);
    }
  }

  // ── seawall: crest to toe (rock rows, concrete steps or the low wall's face), the coping on the crest ──
  const rows = lo ? 1 : hi ? 3 : 2;
  for (const w of td.walls) {
    for (let i = 0; i + 1 < w.crest.length; i++) {
      const k = w.k0 + i;
      const c0 = P(k, w.crest[i], 0), c1 = P(k + 1, w.crest[i + 1], 0);
      const [tx0, tz0] = tdPoint(td, k, w.toe[i]);
      const [tx1, tz1] = tdPoint(td, k + 1, w.toe[i + 1]);
      const t0: [number, number, number] = [tx0, Math.max(Math.min(w.zt[i], c0[1] - 0.4), -2.3), tz0];
      const t1: [number, number, number] = [tx1, Math.max(Math.min(w.zt[i + 1], c1[1] - 0.4), -2.3), tz1];
      const ox = -td.nx[k], oz = -td.nz[k];
      const kind = w.kind[i];
      const lerp = (a: readonly number[], b: readonly number[], t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      if (kind === TD_ROCK) {
        // rows of boulders: the inner row ends jittered (shared by the neighbouring sections), each quad its own shade
        const jit = (kk: number, r: number, p: [number, number, number]): [number, number, number] =>
          r === 0 || r === rows ? p : [p[0] + (hash(kk, r) - 0.5) * 0.6, p[1] + (hash(kk, r + 7) - 0.5) * 0.5, p[2] + (hash(kk, r + 13) - 0.5) * 0.6];
        for (let r = 0; r < rows; r++) {
          const a = jit(k, r, lerp(c0, t0, r / rows)), b = jit(k + 1, r, lerp(c1, t1, r / rows));
          const c = jit(k + 1, r + 1, lerp(c1, t1, (r + 1) / rows)), d = jit(k, r + 1, lerp(c0, t0, (r + 1) / rows));
          const g = 0.75 + hash(k, r + 31) * 0.5;
          face(B, [...a, ...b, ...c, ...d], COL.rock.map((v) => Math.min(255, Math.round(v * g))), ox, 0.6, oz);
        }
      } else if (kind === TD_CONCRETE) {
        const steps = lo ? 1 : hi ? 4 : 3;
        const base = COL.seawall;
        const dark = tint(base, 0.9, 0.9, 0.9);
        for (let r = 0; r < steps; r++) {
          const a0 = lerp(c0, t0, r / steps), a1 = lerp(c1, t1, r / steps), b0 = lerp(c0, t0, (r + 1) / steps), b1 = lerp(c1, t1, (r + 1) / steps);
          if (steps === 1) {
            face(B, [...a0, ...a1, ...b1, ...b0], base, ox, 0.5, oz);
            continue;
          }
          const m0: [number, number, number] = [b0[0], a0[1], b0[2]], m1: [number, number, number] = [b1[0], a1[1], b1[2]];
          face(B, [...a0, ...a1, ...m1, ...m0], base, 0, 1, 0);
          face(B, [...m0, ...m1, ...b1, ...b0], dark, ox, 0, oz);
        }
      } else if (kind === TD_LOW) {
        face(B, [...c0, ...c1, c1[0], t1[1], c1[2], c0[0], t0[1], c0[2]], 0x87857e, ox, 0, oz);
      }
      // the coping: a 0.5 m lip on the crest, its front face down to the ground
      const l0: [number, number, number] = [c0[0], c0[1] + COPING, c0[2]], l1: [number, number, number] = [c1[0], c1[1] + COPING, c1[2]];
      const [ix0, iz0] = tdPoint(td, k, w.crest[i] + 0.5);
      const [ix1, iz1] = tdPoint(td, k + 1, w.crest[i + 1] + 0.5);
      face(B, [...l0, ...l1, ix1, l1[1], iz1, ix0, l0[1], iz0], COL.seawall, 0, 1, 0);
      if (!lo) face(B, [...l0, ...l1, ...c1, ...c0], COL.seawall, ox, 0, oz);
    }
    // the run's two ends: the section from the crest down to the toe, closed
    for (const [i, s] of [[0, -1], [w.crest.length - 1, 1]] as const) {
      const k = w.k0 + i;
      const c = P(k, w.crest[i], COPING);
      const [tx, tz] = tdPoint(td, k, w.toe[i]);
      const ty = Math.max(Math.min(w.zt[i], c[1] - 0.4), -2.3);
      const [bx, bz] = tdPoint(td, k, w.crest[i] + 0.5);
      face(B, [...c, tx, ty, tz, bx, ty, bz, bx, c[1], bz], w.kind[i] === TD_ROCK ? 0x4a4c48 : COL.seawall, (td.x[Math.min(td.n - 1, k + 1)] - td.x[Math.max(0, k - 1)]) * s, 0, (td.z[Math.min(td.n - 1, k + 1)] - td.z[Math.max(0, k - 1)]) * s);
    }
  }

  // ── railings: white posts and rails along the crest (medium: posts every 5 m and the top rail only) ──
  if (!lo) {
    const every = hi ? 2.5 : 5;
    for (const r of td.rails) {
      let carry = 0;
      for (let i = 0; i + 1 < r.o.length; i++) {
        const k = r.k0 + i;
        const a = P(k, r.o[i], COPING), b = P(k + 1, r.o[i + 1], COPING);
        const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
        for (let s = carry; s < L; s += every) {
          const t = s / L;
          const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, z = a[2] + (b[2] - a[2]) * t;
          B.box(frameFromHeading(x, y, z, 0), 0, 0, 0, 0.1, RAIL_H, 0.1, COL.rail, COL.rail);
        }
        carry = (((carry - L) % every) + every) % every;
        for (const hh of hi ? [RAIL_H, RAIL_H * 0.55] : [RAIL_H]) B.beam(IDENT_FRAME, a[0], a[1] + hh, a[2], b[0], b[1] + hh, b[2], 0.08, COL.rail);
      }
    }
  }

  // ── lamps: a tapered grey pole, the arm towards the head the point cloud found, a flat LED head; a light each ──
  const segs = hi ? 6 : 4;
  for (const l of td.lamps) {
    const p = tdPlace(td, l.x, l.z, 80);
    const lvl = p ? tdAt(td.level, p.k) : l.g;
    const g = Math.max(ground(l.x, l.z), Math.min(l.g, lvl));
    const top = g + l.h;
    B.cylinder({ ox: l.x, oy: g, oz: l.z, c: 1, s: 0 }, 0, 0, 0, 0.13, 0.07, l.h - 0.2, segs, COL.pole, WIN_NONE, false);
    const arm = Math.hypot(l.ax, l.az) > 0.6;
    const tx = arm ? l.x + l.ax : l.x, tz = arm ? l.z + l.az : l.z;
    if (arm) B.beam(IDENT_FRAME, l.x, top - 0.6, l.z, tx, top - 0.3, tz, 0.1, COL.pole);
    if (!lo) B.box(frameFromHeading(tx, top - 0.38, tz, arm ? Math.atan2(l.ax, -l.az) : 0), 0, 0, 0, 0.45, 0.16, 0.8, COL.head, COL.head, WIN_GLOW);
    lights?.add(tx, top - 0.5, tz, 0xfff0d8, 4.5);
  }
  return B.triangleCount - t0;
}

/**
 * The measured trees as TreeSource instances (palms and broadleaf; tamakiDriveData.ts TdTree): [x, y, z, width,
 * height, palm (0/1), shade] per tree, standing on `ground`.
 */
export function tamakiTrees(td: TamakiDrive, ground: HeightFn): Float32Array {
  const out = new Float32Array(td.trees.length * 7);
  td.trees.forEach((t, i) => {
    const p = tdPlace(td, t.x, t.z, 80);
    const lvl = p ? tdAt(td.level, p.k) : t.g;
    const g = Math.max(ground(t.x, t.z), Math.min(t.g, lvl));
    // the archetypes: a broadleaf crown is 0.46 of the width across, a palm's fronds reach half of it
    const w = t.palm ? 2 * Math.max(3, Math.min(t.r, 5)) : (t.r / 0.46);
    out.set([t.x, g - 0.3, t.z, w, t.h, t.palm ? 1 : 0, Math.max(0.7, Math.min(1.3, t.shade / 90))], i * 7);
  });
  return out;
}
