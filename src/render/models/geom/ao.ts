/**
 * Baked ambient occlusion into vertex colours (build time, CPU, no extra passes or textures).
 *
 * For every receiver vertex a fixed set of cosine-weighted hemisphere rays is cast against the
 * occluder triangles (a uniform grid keeps it to a few ms per thousand vertices). Hits closer than
 * `maxDist` occlude, weighted by a distance falloff so only nearby geometry (duct walls, wing roots,
 * canopy sills, bay walls) darkens a vertex. The result multiplies the vertex colour, so it shows in
 * every material with `vertexColors` and in single-material LOD meshes alike.
 *
 * Vertices are deduplicated by position + normal (the geometry is non-indexed), the ray set is fixed
 * (no randomness), so a bake is deterministic.
 */
import { BufferAttribute, BufferGeometry, Float32BufferAttribute } from 'three';

export interface AoOptions {
  /** Rays per vertex (cosine-weighted hemisphere). */
  rays?: number;
  /** Occluders further than this (m) don't count; a hit at d weighs 1 − (d/maxDist)² (near hits ≈ full). */
  maxDist?: number;
  /** 0..1: how much full occlusion darkens (1 → black). */
  strength?: number;
  /** Lower bound of the AO factor, so buried vertices never go black. */
  floor?: number;
  /** Ray origin offset along the normal (m), avoids self-hits on the vertex's own faces. */
  bias?: number;
  /** Grid cell size (m): small cells keep triangle tests per ray low (the dominant cost). */
  cell?: number;
  /**
   * Adaptive refinement passes: receiver edges longer than `splitLen` whose end-point AO differs by
   * more than `splitDelta` are split at their midpoint (exactly on the edge, so the shape and the
   * silhouette are unchanged) and the new vertices baked. Puts vertices where the shadow gradient is.
   */
  refine?: number;
  splitLen?: number;
  splitDelta?: number;
}

const DEFAULTS: Required<AoOptions> = {
  rays: 16,
  maxDist: 1.0,
  strength: 1,
  floor: 0.3,
  bias: 0.012,
  cell: 0.12,
  refine: 0,
  splitLen: 1.0,
  splitDelta: 0.35,
};

/** Fixed cosine-weighted hemisphere directions about +Z (Fibonacci spiral → even coverage). */
export function hemisphereRays(n: number): Float32Array {
  const out = new Float32Array(n * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    // cosine-weighted: r = sqrt(u) on the unit disc, lifted onto the hemisphere
    const u = (i + 0.5) / n;
    const r = Math.sqrt(u);
    const phi = i * golden;
    out[i * 3] = r * Math.cos(phi);
    out[i * 3 + 1] = r * Math.sin(phi);
    out[i * 3 + 2] = Math.sqrt(Math.max(0, 1 - u));
  }
  return out;
}

/** Uniform grid of triangle indices over the occluders' bounding box. */
class TriGrid {
  readonly tris: Float32Array;
  readonly count: number;
  private readonly min = [Infinity, Infinity, Infinity];
  private readonly dims = [1, 1, 1];
  private readonly start: Uint32Array;
  private readonly items: Uint32Array;
  /** Mailbox: last ray id that tested each triangle. */
  private readonly stamp: Uint32Array;
  private rayId = 0;

  constructor(
    geos: BufferGeometry[],
    readonly cell: number,
  ) {
    let n = 0;
    for (const g of geos) n += g.attributes.position.count;
    this.tris = new Float32Array(n * 3);
    let o = 0;
    for (const g of geos) {
      const a = g.attributes.position.array as Float32Array;
      this.tris.set(a.subarray(0, g.attributes.position.count * 3), o);
      o += g.attributes.position.count * 3;
    }
    this.count = (n / 3) | 0;
    const t = this.tris;
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < t.length; i += 3)
      for (let k = 0; k < 3; k++) {
        if (t[i + k] < this.min[k]) this.min[k] = t[i + k];
        if (t[i + k] > max[k]) max[k] = t[i + k];
      }
    for (let k = 0; k < 3; k++) {
      this.min[k] -= 1e-3;
      this.dims[k] = Math.max(1, Math.ceil((max[k] + 1e-3 - this.min[k]) / cell));
    }
    const cells = this.dims[0] * this.dims[1] * this.dims[2];
    const counts = new Uint32Array(cells + 1);
    const each = (tri: number, f: (c: number) => void) => {
      const lo = [0, 0, 0];
      const hi = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        const a = t[tri * 9 + k];
        const b = t[tri * 9 + 3 + k];
        const c = t[tri * 9 + 6 + k];
        lo[k] = this.clampCell(k, Math.min(a, b, c));
        hi[k] = this.clampCell(k, Math.max(a, b, c));
      }
      for (let z = lo[2]; z <= hi[2]; z++)
        for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) f((z * this.dims[1] + y) * this.dims[0] + x);
    };
    for (let i = 0; i < this.count; i++) each(i, (c) => counts[c + 1]++);
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    this.start = counts;
    this.items = new Uint32Array(counts[cells]);
    const fill = counts.slice(0, cells);
    for (let i = 0; i < this.count; i++) each(i, (c) => (this.items[fill[c]++] = i));
    this.stamp = new Uint32Array(this.count);
  }

  private clampCell(k: number, v: number): number {
    return Math.min(this.dims[k] - 1, Math.max(0, Math.floor((v - this.min[k]) / this.cell)));
  }

  // scratch for cast() (no per-ray allocation)
  private readonly o = new Float64Array(3);
  private readonly d = new Float64Array(3);
  private readonly ci = new Int32Array(3);
  private readonly step = new Int32Array(3);
  private readonly tNext = new Float64Array(3);
  private readonly tDelta = new Float64Array(3);

  /** Distance to the nearest hit along a unit ray within (tMin, tMax), or Infinity. 3D-DDA walk. */
  cast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tMin: number, tMax: number): number {
    const id = ++this.rayId;
    if (id === 0xffffffff) {
      this.stamp.fill(0);
      this.rayId = 1;
    }
    const { o, d, ci, step, tNext, tDelta, min, dims, cell } = this;
    o[0] = ox;
    o[1] = oy;
    o[2] = oz;
    d[0] = dx;
    d[1] = dy;
    d[2] = dz;
    // clip the ray to the grid box
    let t0 = tMin;
    let t1 = tMax;
    for (let k = 0; k < 3; k++) {
      const lo = min[k];
      const hi = lo + dims[k] * cell;
      if (Math.abs(d[k]) < 1e-12) {
        if (o[k] < lo || o[k] > hi) return Infinity;
      } else {
        let a = (lo - o[k]) / d[k];
        let b = (hi - o[k]) / d[k];
        if (a > b) {
          const tmp = a;
          a = b;
          b = tmp;
        }
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
      }
    }
    if (t0 > t1) return Infinity;
    for (let k = 0; k < 3; k++) {
      const p = o[k] + d[k] * t0;
      ci[k] = this.clampCell(k, p);
      if (d[k] > 0) {
        step[k] = 1;
        tNext[k] = t0 + (min[k] + (ci[k] + 1) * cell - p) / d[k];
        tDelta[k] = cell / d[k];
      } else if (d[k] < 0) {
        step[k] = -1;
        tNext[k] = t0 + (min[k] + ci[k] * cell - p) / d[k];
        tDelta[k] = -cell / d[k];
      } else {
        step[k] = 0;
        tNext[k] = Infinity;
        tDelta[k] = Infinity;
      }
    }
    let best = Infinity;
    const t = this.tris;
    const start = this.start;
    const items = this.items;
    const stamp = this.stamp;
    for (;;) {
      const c = (ci[2] * dims[1] + ci[1]) * dims[0] + ci[0];
      for (let j = start[c], end = start[c + 1]; j < end; j++) {
        const tri = items[j];
        if (stamp[tri] === id) continue;
        stamp[tri] = id;
        const h = rayTri(t, tri * 9, ox, oy, oz, dx, dy, dz);
        if (h > tMin && h < best && h < tMax) best = h;
      }
      // advance to the next cell; stop once the best hit lies before it
      const k = tNext[0] < tNext[1] ? (tNext[0] < tNext[2] ? 0 : 2) : tNext[1] < tNext[2] ? 1 : 2;
      if (best <= tNext[k] || tNext[k] > t1) return best;
      ci[k] += step[k];
      if (ci[k] < 0 || ci[k] >= dims[k]) return best;
      tNext[k] += tDelta[k];
    }
  }
}

/** Möller–Trumbore, double-sided. Returns the ray parameter or -1. */
function rayTri(t: Float32Array, o: number, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
  const ax = t[o];
  const ay = t[o + 1];
  const az = t[o + 2];
  const e1x = t[o + 3] - ax;
  const e1y = t[o + 4] - ay;
  const e1z = t[o + 5] - az;
  const e2x = t[o + 6] - ax;
  const e2y = t[o + 7] - ay;
  const e2z = t[o + 8] - az;
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return -1;
  const inv = 1 / det;
  const sx = ox - ax;
  const sy = oy - ay;
  const sz = oz - az;
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = sy * e1z - sz * e1y;
  const qy = sz * e1x - sx * e1z;
  const qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

/** Ray-casting AO evaluator over a fixed occluder set; caches results by vertex position + normal. */
class AoBaker {
  private readonly grid: TriGrid;
  private readonly dirs: Float32Array;
  // dedupe on quantised position (mm) + normal (~1°)
  private readonly cache = new Map<string, number>();

  constructor(
    occluders: BufferGeometry[],
    private readonly o: Required<AoOptions>,
  ) {
    this.grid = new TriGrid(occluders, o.cell);
    this.dirs = hemisphereRays(o.rays);
  }

  /** AO factor (floor..1) for every vertex of g. */
  bake(g: BufferGeometry): Float32Array {
    const p = g.attributes.position.array as Float32Array;
    const nrm = g.attributes.normal.array as Float32Array;
    const n = g.attributes.position.count;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.at(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]);
    return out;
  }

  at(px: number, py: number, pz: number, nx: number, ny: number, nz: number): number {
    const o = this.o;
    const key = `${Math.round(px * 1000)},${Math.round(py * 1000)},${Math.round(pz * 1000)},${Math.round(nx * 64)},${Math.round(ny * 64)},${Math.round(nz * 64)}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    // tangent frame (Frisvad / branchless ONB)
    const s = nz >= 0 ? 1 : -1;
    const a = -1 / (s + nz);
    const b = nx * ny * a;
    const tx = 1 + s * nx * nx * a;
    const ty = s * b;
    const tz = -s * nx;
    const bx = b;
    const by = s + ny * ny * a;
    const bz = -ny;
    const ox = px + nx * o.bias;
    const oy = py + ny * o.bias;
    const oz = pz + nz * o.bias;
    const dirs = this.dirs;
    let occ = 0;
    for (let r = 0; r < o.rays; r++) {
      const u = dirs[r * 3];
      const v = dirs[r * 3 + 1];
      const w = dirs[r * 3 + 2];
      const d = this.grid.cast(ox, oy, oz, tx * u + bx * v + nx * w, ty * u + by * v + ny * w, tz * u + bz * v + nz * w, 1e-4, o.maxDist);
      if (d < o.maxDist) {
        const k = d / o.maxDist;
        occ += 1 - k * k;
      }
    }
    const ao = Math.max(o.floor, 1 - o.strength * (occ / o.rays));
    this.cache.set(key, ao);
    return ao;
  }
}

const posKey = (p: ArrayLike<number>, i: number) => `${Math.round(p[i * 3] * 1000)},${Math.round(p[i * 3 + 1] * 1000)},${Math.round(p[i * 3 + 2] * 1000)}`;
const edgeKey = (ka: string, kb: string) => (ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`);

/**
 * One refinement pass over all receivers: split marked edges (decided per edge position across every
 * receiver, so triangles sharing an edge split it alike and no T-junction opens). Returns new
 * geometries (same attribute layout) or the input when nothing was split.
 */
function refinePass(geos: BufferGeometry[], ao: Float32Array[], o: Required<AoOptions>): BufferGeometry[] {
  const split = new Set<string>();
  const len2 = o.splitLen * o.splitLen;
  geos.forEach((g, gi) => {
    const p = g.attributes.position.array as Float32Array;
    const a = ao[gi];
    for (let t = 0; t + 2 < g.attributes.position.count; t += 3)
      for (let e = 0; e < 3; e++) {
        const i = t + e;
        const j = t + ((e + 1) % 3);
        const dx = p[i * 3] - p[j * 3];
        const dy = p[i * 3 + 1] - p[j * 3 + 1];
        const dz = p[i * 3 + 2] - p[j * 3 + 2];
        if (dx * dx + dy * dy + dz * dz > len2 && Math.abs(a[i] - a[j]) > o.splitDelta) split.add(edgeKey(posKey(p, i), posKey(p, j)));
      }
  });
  if (split.size === 0) return geos;
  return geos.map((g) => {
    // regular attributes, then morph targets (flattened as name#index), all split alike
    const names = Object.keys(g.attributes);
    const src = names.map((nm) => g.attributes[nm] as BufferAttribute);
    for (const [nm, list] of Object.entries(g.morphAttributes))
      list.forEach((a, i) => {
        names.push(`${nm}#${i}`);
        src.push(a as BufferAttribute);
      });
    const out: number[][] = names.map(() => []);
    const p = g.attributes.position.array as Float32Array;
    const n = g.attributes.position.count;
    let changed = false;
    // per output vertex: either an original index, or the midpoint of two
    const emit = (i: number, j = i) => {
      src.forEach((s, k) => {
        const sz = s.itemSize;
        const arr = s.array as Float32Array;
        if (i === j) for (let c = 0; c < sz; c++) out[k].push(arr[i * sz + c]);
        else {
          const v: number[] = [];
          for (let c = 0; c < sz; c++) v.push((arr[i * sz + c] + arr[j * sz + c]) / 2);
          if (names[k] === 'normal') {
            const l = Math.hypot(v[0], v[1], v[2]) || 1;
            v[0] /= l;
            v[1] /= l;
            v[2] /= l;
          }
          out[k].push(...v);
        }
      });
    };
    type V = [number, number];
    const tri = (a: V, b: V, c: V) => {
      emit(a[0], a[1]);
      emit(b[0], b[1]);
      emit(c[0], c[1]);
    };
    for (let t = 0; t + 2 < n; t += 3) {
      const v: V[] = [
        [t, t],
        [t + 1, t + 1],
        [t + 2, t + 2],
      ];
      const k = [0, 1, 2].map((e) => split.has(edgeKey(posKey(p, t + e), posKey(p, t + ((e + 1) % 3)))));
      const m: V[] = [0, 1, 2].map((e) => [t + e, t + ((e + 1) % 3)]); // m[e] = midpoint of edge e→e+1
      const cnt = k.filter(Boolean).length;
      if (cnt === 0) {
        tri(v[0], v[1], v[2]);
        continue;
      }
      changed = true;
      if (cnt === 3) {
        tri(v[0], m[0], m[2]);
        tri(m[0], v[1], m[1]);
        tri(m[2], m[1], v[2]);
        tri(m[0], m[1], m[2]);
        continue;
      }
      // rotate so the pattern starts at edge r (the split one for cnt 1, the unsplit one for cnt 2)
      const r = cnt === 1 ? k.indexOf(true) : k.indexOf(false);
      const A = v[r];
      const B = v[(r + 1) % 3];
      const C = v[(r + 2) % 3];
      if (cnt === 1) {
        const M = m[r]; // on A→B
        tri(A, M, C);
        tri(M, B, C);
      } else {
        // edges B→C and C→A split; A→B kept
        const MBC = m[(r + 1) % 3];
        const MCA = m[(r + 2) % 3];
        tri(MCA, MBC, C);
        tri(A, B, MBC);
        tri(A, MBC, MCA);
      }
    }
    if (!changed) return g;
    const r = new BufferGeometry();
    names.forEach((nm, k) => {
      const a = new Float32BufferAttribute(out[k], src[k].itemSize);
      const [base, idx] = nm.split('#');
      if (idx === undefined) r.setAttribute(nm, a);
      else {
        const m = r.morphAttributes as Record<string, BufferAttribute[]>;
        (m[base] ??= [])[Number(idx)] = a;
      }
    });
    r.morphTargetsRelative = g.morphTargetsRelative;
    return r;
  });
}

/**
 * AO factor (floor..1) per vertex of each receiver, against all occluders, after `refine` adaptive
 * passes. Receivers need not be in the occluder set (and vice versa). Returns the (possibly refined)
 * receiver geometries with one AO array each, plus the first-pass AO of the unrefined receivers.
 */
export function computeVertexAO(
  receivers: BufferGeometry[],
  occluders: BufferGeometry[],
  opts: AoOptions = {},
): { geos: BufferGeometry[]; ao: Float32Array[]; coarseAo: Float32Array[] } {
  const o = { ...DEFAULTS, ...opts };
  const baker = new AoBaker(occluders, o);
  let geos = receivers;
  const coarseAo = geos.map((g) => baker.bake(g));
  let ao = coarseAo;
  for (let pass = 0; pass < o.refine; pass++) {
    const next = refinePass(geos, ao, o);
    if (next === geos) break;
    ao = next.map((g, i) => (g === geos[i] ? ao[i] : baker.bake(g)));
    geos = next;
  }
  return { geos, ao, coarseAo };
}

function multiplyColors(g: BufferGeometry, a: Float32Array): void {
  const c = g.attributes.color as BufferAttribute;
  for (let i = 0; i < c.count; i++) c.setXYZ(i, c.getX(i) * a[i], c.getY(i) * a[i], c.getZ(i) * a[i]);
  c.needsUpdate = true;
}

/**
 * Bake AO into the receivers' vertex colours. `fine[i]` is the receiver to draw up close (a new,
 * refined geometry, or the input modified in place); `coarse[i]` is the unrefined input with the
 * first-pass AO, for distant LODs that shouldn't pay for the extra triangles (same object as
 * `fine[i]` when nothing was split).
 */
export function bakeVertexAO(
  receivers: BufferGeometry[],
  occluders: BufferGeometry[],
  opts: AoOptions = {},
): { fine: BufferGeometry[]; coarse: BufferGeometry[] } {
  const { geos, ao, coarseAo } = computeVertexAO(receivers, occluders, opts);
  geos.forEach((g, i) => multiplyColors(g, ao[i]));
  receivers.forEach((g, i) => {
    if (geos[i] !== g) multiplyColors(g, coarseAo[i]);
  });
  return { fine: geos, coarse: receivers };
}
