/**
 * Sculpted bodies for the Codex pests: a body is a list of signed-distance primitives (ellipsoids and
 * round cones) blended with a smooth union, then meshed by naive surface nets on a grid. Each vertex is
 * painted by the species (colour, fur length, the direction the fur lies) from its position, normal and
 * the part it belongs to. Thin parts (tails, whiskers, legs, antennae) are tubes, not SDF: see tube().
 * Pure geometry, no DOM: tests build every body in node.
 */
import { BufferAttribute, BufferGeometry, CatmullRomCurve3, Color, Euler, Matrix4, Vector3 } from 'three';

export type V3 = [number, number, number];

interface PrimBase {
  part: string;
  /** Smooth-union radius into what came before (m); 0 = hard union. */
  k: number;
  /** Carve this shape out instead of adding it. */
  sub?: boolean;
}
interface Ell extends PrimBase {
  kind: 'ell';
  c: Vector3;
  r: Vector3;
  /** World → primitive frame (rotation only). */
  inv: Matrix4 | null;
}
interface Cone extends PrimBase {
  kind: 'cone';
  a: Vector3;
  b: Vector3;
  ra: number;
  rb: number;
}
export type Prim = Ell | Cone;

/** An ellipsoid at `c` with radii `r`, optionally rotated (Euler XYZ, radians). */
export function ell(part: string, c: V3, r: V3, k = 0, rot?: V3, sub = false): Prim {
  const inv = rot ? new Matrix4().makeRotationFromEuler(new Euler(...rot)).invert() : null;
  return { kind: 'ell', part, k, sub, c: new Vector3(...c), r: new Vector3(...r), inv };
}
/** A round cone (a capsule whose radius goes from `ra` at `a` to `rb` at `b`). */
export function cone(part: string, a: V3, b: V3, ra: number, rb: number, k = 0, sub = false): Prim {
  return { kind: 'cone', part, k, sub, a: new Vector3(...a), b: new Vector3(...b), ra, rb };
}
/** Round cones along a polyline, radius interpolated from r[0] to r[last]. */
export function chain(part: string, pts: V3[], r: number[], k = 0): Prim[] {
  const out: Prim[] = [];
  for (let i = 0; i < pts.length - 1; i++) out.push(cone(part, pts[i], pts[i + 1], r[i], r[i + 1], k));
  return out;
}

const _q = new Vector3();
const _ba = new Vector3();
const _pa = new Vector3();

function dist(p: Vector3, s: Prim): number {
  if (s.kind === 'ell') {
    _q.copy(p).sub(s.c);
    if (s.inv) _q.applyMatrix4(s.inv);
    const k0 = Math.hypot(_q.x / s.r.x, _q.y / s.r.y, _q.z / s.r.z);
    const k1 = Math.hypot(_q.x / (s.r.x * s.r.x), _q.y / (s.r.y * s.r.y), _q.z / (s.r.z * s.r.z));
    return k1 < 1e-12 ? -Math.min(s.r.x, s.r.y, s.r.z) : (k0 * (k0 - 1)) / k1;
  }
  // round cone (Inigo Quilez, sdRoundCone between two points)
  _ba.copy(s.b).sub(s.a);
  _pa.copy(p).sub(s.a);
  const l2 = _ba.lengthSq();
  const rr = s.ra - s.rb;
  const a2 = l2 - rr * rr;
  const il2 = 1 / l2;
  const y = _pa.dot(_ba);
  const z = y - l2;
  const x2 = _q.copy(_pa).multiplyScalar(l2).addScaledVector(_ba, -y).lengthSq();
  const y2 = y * y * l2;
  const z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - s.rb;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - s.ra;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - s.ra;
}

function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

function bounds(s: Prim): [Vector3, Vector3] {
  if (s.kind === 'ell') {
    const m = Math.max(s.r.x, s.r.y, s.r.z);
    const e = s.inv ? new Vector3(m, m, m) : s.r.clone();
    return [s.c.clone().sub(e), s.c.clone().add(e)];
  }
  const ra = new Vector3(s.ra, s.ra, s.ra);
  const rb = new Vector3(s.rb, s.rb, s.rb);
  return [s.a.clone().sub(ra).min(s.b.clone().sub(rb)), s.a.clone().add(ra).max(s.b.clone().add(rb))];
}

/** Field and nearest part at a point (the slow path, used for normals and projection). */
export function field(prims: Prim[], p: Vector3): { d: number; part: number } {
  let d = 1e9;
  let part = 0;
  let best = 1e9;
  for (let i = 0; i < prims.length; i++) {
    const s = prims[i];
    const di = dist(p, s);
    if (s.sub) d = smax(d, -di, s.k);
    else {
      d = smin(d, di, s.k);
      if (di < best) {
        best = di;
        part = i;
      }
    }
  }
  return { d, part };
}

/** What a species paints on one vertex. Colours are sRGB 0..1. */
export interface Paint {
  c: V3;
  /** Fur length factor 0..1 (0 = bare skin). */
  fur: number;
  /** How much the species' tip colour shows on this fur (0..1, default 1). */
  tip?: number;
  /** Direction the fur lies (unit-ish, object space); projected onto the surface. */
  comb?: V3;
}
export type Painter = (p: Vector3, n: Vector3, part: string) => Paint;

/**
 * Mesh a body: surface nets over a grid of cell size `h` (m). Attributes: position, normal, color
 * (linear), furLen and furTip (floats), comb (vec3, tangent to the surface).
 */
export function sculpt(prims: Prim[], paint: Painter, h: number, smoothColour = 2): BufferGeometry {
  const lo = new Vector3(1e9, 1e9, 1e9);
  const hi = new Vector3(-1e9, -1e9, -1e9);
  for (const s of prims) {
    if (s.sub) continue;
    const [a, b] = bounds(s);
    lo.min(a);
    hi.max(b);
  }
  // smooth unions bulge out past their primitives (up to k/4 per blend, and blends stack)
  const pad = Math.max(0, ...prims.map((s) => s.k)) + h * 3;
  lo.subScalar(pad);
  hi.addScalar(pad);
  const nx = Math.ceil((hi.x - lo.x) / h) + 1;
  const ny = Math.ceil((hi.y - lo.y) / h) + 1;
  const nz = Math.ceil((hi.z - lo.z) / h) + 1;
  const N = nx * ny * nz;
  const F = new Float32Array(N);
  const at = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const p = new Vector3();
  // coarse to fine: per block of B³ grid points, the exact field at the block centre decides whether the
  // surface can pass through it; if not the whole block takes that value (only its sign matters there),
  // otherwise every point is evaluated, with only the primitives that can matter to the block
  const B = 4;
  const R = (B * h * Math.sqrt(3)) / 2;
  const dists = new Float64Array(prims.length);
  const near: Prim[] = [];
  for (let bk = 0; bk < nz; bk += B)
    for (let bj = 0; bj < ny; bj += B)
      for (let bi = 0; bi < nx; bi += B) {
        const ei = Math.min(nx, bi + B);
        const ej = Math.min(ny, bj + B);
        const ek = Math.min(nz, bk + B);
        p.set(lo.x + ((bi + ei - 1) / 2) * h, lo.y + ((bj + ej - 1) / 2) * h, lo.z + ((bk + ek - 1) / 2) * h);
        let dc = 1e9;
        let best = 1e9;
        for (let i = 0; i < prims.length; i++) {
          const s = prims[i];
          const d = dist(p, s);
          dists[i] = d;
          if (s.sub) dc = smax(dc, -d, s.k);
          else {
            dc = smin(dc, d, s.k);
            if (d < best) best = d;
          }
        }
        if (Math.abs(dc) > R * 1.6 + h) {
          for (let k = bk; k < ek; k++) for (let j = bj; j < ej; j++) for (let i = bi; i < ei; i++) F[at(i, j, k)] = dc;
          continue;
        }
        near.length = 0;
        for (let i = 0; i < prims.length; i++) {
          const s = prims[i];
          if (s.sub ? dists[i] < R * 2 + s.k : dists[i] < best + R * 2 + s.k * 2) near.push(s);
        }
        for (let k = bk; k < ek; k++)
          for (let j = bj; j < ej; j++)
            for (let i = bi; i < ei; i++) F[at(i, j, k)] = field(near, p.set(lo.x + i * h, lo.y + j * h, lo.z + k * h)).d;
      }

  // one vertex per cell the surface crosses, at the mean of its edge crossings
  const cellVert = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
  const cat = (i: number, j: number, k: number) => i + (nx - 1) * (j + (ny - 1) * k);
  const pos: number[] = [];
  const EDGES = [
    [0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const cv = new Float32Array(8);
  for (let k = 0; k < nz - 1; k++)
    for (let j = 0; j < ny - 1; j++)
      for (let i = 0; i < nx - 1; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = F[at(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))];
          cv[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;
        let sx = 0;
        let sy = 0;
        let sz = 0;
        let cnt = 0;
        for (const [e0, e1] of EDGES) {
          const a = cv[e0];
          const b = cv[e1];
          if (a < 0 === b < 0) continue;
          const t = a / (a - b);
          sx += (e0 & 1) + t * ((e1 & 1) - (e0 & 1));
          sy += ((e0 >> 1) & 1) + t * (((e1 >> 1) & 1) - ((e0 >> 1) & 1));
          sz += ((e0 >> 2) & 1) + t * (((e1 >> 2) & 1) - ((e0 >> 2) & 1));
          cnt++;
        }
        cellVert[cat(i, j, k)] = pos.length / 3;
        pos.push(lo.x + (i + sx / cnt) * h, lo.y + (j + sy / cnt) * h, lo.z + (k + sz / cnt) * h);
      }

  // a quad for every grid edge with a sign change, joining the four cells around it
  const idx: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    // winding is fixed against the gradient below
    if (flip) idx.push(a, b, c, a, c, d);
    else idx.push(a, c, b, a, d, c);
  };
  for (let k = 1; k < nz - 1; k++)
    for (let j = 1; j < ny - 1; j++)
      for (let i = 1; i < nx - 1; i++) {
        const v0 = F[at(i, j, k)] < 0;
        if (v0 !== F[at(i + 1, j, k)] < 0 && i < nx - 1)
          quad(cellVert[cat(i, j - 1, k - 1)], cellVert[cat(i, j, k - 1)], cellVert[cat(i, j, k)], cellVert[cat(i, j - 1, k)], v0);
        if (v0 !== F[at(i, j + 1, k)] < 0)
          quad(cellVert[cat(i - 1, j, k - 1)], cellVert[cat(i - 1, j, k)], cellVert[cat(i, j, k)], cellVert[cat(i, j, k - 1)], v0);
        if (v0 !== F[at(i, j, k + 1)] < 0)
          quad(cellVert[cat(i - 1, j - 1, k)], cellVert[cat(i, j - 1, k)], cellVert[cat(i, j, k)], cellVert[cat(i - 1, j, k)], v0);
      }

  // project onto the surface and take normals from the gradient, both read from the grid (trilinear),
  // then paint with the nearest part from the exact field
  const n = pos.length / 3;
  const P = new Float32Array(pos);
  const NRM = new Float32Array(n * 3);
  const COL = new Float32Array(n * 3);
  const FUR = new Float32Array(n);
  const TIP = new Float32Array(n);
  const COMB = new Float32Array(n * 3);
  const sample = (x: number, y: number, z: number) => {
    const gx = Math.min(nx - 1.001, Math.max(0, (x - lo.x) / h));
    const gy = Math.min(ny - 1.001, Math.max(0, (y - lo.y) / h));
    const gz = Math.min(nz - 1.001, Math.max(0, (z - lo.z) / h));
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const k = Math.floor(gz);
    const fx = gx - i;
    const fy = gy - j;
    const fz = gz - k;
    const c = (a: number, b: number, d: number) => F[at(i + a, j + b, k + d)];
    const x00 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * fx;
    const x10 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * fx;
    const x01 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * fx;
    const x11 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * fx;
    const y0 = x00 + (x10 - x00) * fy;
    const y1 = x01 + (x11 - x01) * fy;
    return y0 + (y1 - y0) * fz;
  };
  const nv = new Vector3();
  const col = new Color();
  const cb = new Vector3();
  const q = new Vector3();
  const grad = (x: number, y: number, z: number) =>
    nv.set(sample(x + h, y, z) - sample(x - h, y, z), sample(x, y + h, z) - sample(x, y - h, z), sample(x, y, z + h) - sample(x, y, z - h)).normalize();
  for (let v = 0; v < n; v++) {
    q.fromArray(P, v * 3);
    for (let it = 0; it < 2; it++) {
      const d = sample(q.x, q.y, q.z);
      grad(q.x, q.y, q.z);
      q.addScaledVector(nv, -d);
    }
    grad(q.x, q.y, q.z);
    const part = prims[field(prims, q).part].part;
    q.toArray(P, v * 3);
    nv.toArray(NRM, v * 3);
    const pt = paint(q, nv, part);
    col.setRGB(pt.c[0], pt.c[1], pt.c[2]).convertSRGBToLinear();
    COL[v * 3] = col.r;
    COL[v * 3 + 1] = col.g;
    COL[v * 3 + 2] = col.b;
    FUR[v] = pt.fur;
    TIP[v] = pt.tip ?? 1;
    cb.set(...(pt.comb ?? [0, -0.35, 1]));
    cb.addScaledVector(nv, -cb.dot(nv));
    if (cb.lengthSq() < 1e-8) cb.set(0, 0, 0);
    else cb.normalize();
    cb.toArray(COMB, v * 3);
  }

  // face every triangle the way the field's gradient points (out of the body)
  {
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    for (let t = 0; t < idx.length; t += 3) {
      a.fromArray(P, idx[t] * 3);
      b.fromArray(P, idx[t + 1] * 3).sub(a);
      c.fromArray(P, idx[t + 2] * 3).sub(a);
      b.cross(c);
      const nx3 = NRM[idx[t] * 3] + NRM[idx[t + 1] * 3] + NRM[idx[t + 2] * 3];
      const ny3 = NRM[idx[t] * 3 + 1] + NRM[idx[t + 1] * 3 + 1] + NRM[idx[t + 2] * 3 + 1];
      const nz3 = NRM[idx[t] * 3 + 2] + NRM[idx[t + 1] * 3 + 2] + NRM[idx[t + 2] * 3 + 2];
      if (b.x * nx3 + b.y * ny3 + b.z * nz3 < 0) {
        const tmp = idx[t + 1];
        idx[t + 1] = idx[t + 2];
        idx[t + 2] = tmp;
      }
    }
  }

  // soften paint seams between parts
  if (smoothColour > 0) {
    const nb: number[][] = Array.from({ length: n }, () => []);
    for (let t = 0; t < idx.length; t += 3)
      for (let s = 0; s < 3; s++) {
        const a = idx[t + s];
        const b = idx[t + ((s + 1) % 3)];
        nb[a].push(b);
        nb[b].push(a);
      }
    for (let pass = 0; pass < smoothColour; pass++) {
      const C2 = COL.slice();
      const F2 = FUR.slice();
      const T2 = TIP.slice();
      for (let v = 0; v < n; v++) {
        const list = nb[v];
        if (!list.length) continue;
        let r = COL[v * 3] * 2;
        let g = COL[v * 3 + 1] * 2;
        let b = COL[v * 3 + 2] * 2;
        let f = FUR[v] * 2;
        let tp = TIP[v] * 2;
        for (const w of list) {
          tp += TIP[w];
          r += COL[w * 3];
          g += COL[w * 3 + 1];
          b += COL[w * 3 + 2];
          f += FUR[w];
        }
        const m = list.length + 2;
        C2[v * 3] = r / m;
        C2[v * 3 + 1] = g / m;
        C2[v * 3 + 2] = b / m;
        F2[v] = f / m;
        T2[v] = tp / m;
      }
      COL.set(C2);
      FUR.set(F2);
      TIP.set(T2);
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(P, 3));
  geo.setAttribute('normal', new BufferAttribute(NRM, 3));
  geo.setAttribute('color', new BufferAttribute(COL, 3));
  geo.setAttribute('furLen', new BufferAttribute(FUR, 1));
  geo.setAttribute('furTip', new BufferAttribute(TIP, 1));
  geo.setAttribute('comb', new BufferAttribute(COMB, 3));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/* ───────────────────────────── tubes ───────────────────────────── */

/**
 * A tapered tube along a smooth curve through `pts`: radius from r0 to r1 (or a function of u 0..1),
 * capped at both ends. UV: u along the length, v around. Colour attribute from `color(u)` (sRGB hex).
 */
export function tube(
  pts: V3[],
  r0: number,
  r1: number | ((u: number) => number),
  opts: { seg?: number; radial?: number; color?: (u: number, around: number) => number; furLen?: number } = {},
): BufferGeometry {
  const seg = opts.seg ?? 32;
  const radial = opts.radial ?? 10;
  const curve = new CatmullRomCurve3(pts.map((x) => new Vector3(...x)), false, 'centripetal');
  const frames = curve.computeFrenetFrames(seg, false);
  const rad = typeof r1 === 'function' ? r1 : (u: number) => r0 + (r1 - r0) * u;
  const P: number[] = [];
  const N: number[] = [];
  const UV: number[] = [];
  const C: number[] = [];
  const col = new Color();
  const pt = new Vector3();
  const nrm = new Vector3();
  for (let i = 0; i <= seg; i++) {
    const u = i / seg;
    curve.getPointAt(u, pt);
    const r = rad(u);
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      nrm.copy(frames.normals[i]).multiplyScalar(Math.cos(a)).addScaledVector(frames.binormals[i], Math.sin(a));
      P.push(pt.x + nrm.x * r, pt.y + nrm.y * r, pt.z + nrm.z * r);
      N.push(nrm.x, nrm.y, nrm.z);
      UV.push(u, j / radial);
      col.setHex(opts.color ? opts.color(u, j / radial) : 0xffffff).convertSRGBToLinear();
      C.push(col.r, col.g, col.b);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < seg; i++)
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j;
      const b = a + radial + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  // end caps: a centre vertex each
  for (const end of [0, 1]) {
    curve.getPointAt(end, pt);
    const tan = frames.tangents[end ? seg : 0].clone().multiplyScalar(end ? 1 : -1);
    const c = P.length / 3;
    const ring = end ? seg * (radial + 1) : 0;
    const rr = rad(end);
    P.push(pt.x + tan.x * rr * 0.6, pt.y + tan.y * rr * 0.6, pt.z + tan.z * rr * 0.6);
    N.push(tan.x, tan.y, tan.z);
    UV.push(end, 0.5);
    C.push(C[ring * 3], C[ring * 3 + 1], C[ring * 3 + 2]);
    for (let j = 0; j < radial; j++) {
      if (end) idx.push(ring + j, c, ring + j + 1);
      else idx.push(ring + j + 1, c, ring + j);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(P), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(N), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(UV), 2));
  geo.setAttribute('color', new BufferAttribute(new Float32Array(C), 3));
  geo.setIndex(idx);
  return geo;
}

/* ───────────────────────────── noise ───────────────────────────── */

function hash3(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
/** Smooth value noise in 0..1. */
export function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const s = (t: number) => t * t * (3 - 2 * t);
  const fx = s(x - xi);
  const fy = s(y - yi);
  const fz = s(z - zi);
  const L = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (i: number, j: number, k: number) => hash3(xi + i, yi + j, zi + k);
  return L(
    L(L(c(0, 0, 0), c(1, 0, 0), fx), L(c(0, 1, 0), c(1, 1, 0), fx), fy),
    L(L(c(0, 0, 1), c(1, 0, 1), fx), L(c(0, 1, 1), c(1, 1, 1), fx), fy),
    fz,
  );
}
/** Fractal noise (3 octaves) in about 0..1. */
export function fbm(p: Vector3, scale: number): number {
  return (noise3(p.x * scale, p.y * scale, p.z * scale) * 0.57 + noise3(p.x * scale * 2.1, p.y * scale * 2.1, p.z * scale * 2.1) * 0.29 + noise3(p.x * scale * 4.3, p.y * scale * 4.3, p.z * scale * 4.3) * 0.14);
}
/** Mix two sRGB colours. */
export function mix(a: V3, b: V3, t: number): V3 {
  const u = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}
export const hex = (h: number): V3 => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
export const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
