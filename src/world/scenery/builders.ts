/**
 * Small collectors used by the scenery builders:
 *  - LightList: point lights (runway/taxi/aviation/city) → one Points object
 *  - DecalBuilder: terrain-conforming textured ground strips/quads → one mesh per texture
 */
import { BufferAttribute, BufferGeometry, Color, Points, ShapeUtils, Vector2, type Material } from 'three';

export class LightList {
  private pos: number[] = [];
  private col: number[] = [];
  private sb: number[] = [];
  private readonly c = new Color();

  get count(): number {
    return this.pos.length / 3;
  }

  /** size in metres (rendered with a pixel minimum), blink phase 0..1 or −1 for steady. */
  add(x: number, y: number, z: number, color: number, size: number, blink = -1): void {
    this.c.setHex(color);
    this.pos.push(x, y, z);
    this.col.push(this.c.r, this.c.g, this.c.b);
    this.sb.push(size, blink);
  }

  /** Visit every light: position, linear colour, size (m). */
  forEach(cb: (x: number, y: number, z: number, r: number, g: number, b: number, size: number, blink: number) => void): void {
    for (let i = 0; i < this.count; i++) cb(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2], this.col[i * 3], this.col[i * 3 + 1], this.col[i * 3 + 2], this.sb[i * 2], this.sb[i * 2 + 1]);
  }

  build(material: Material): Points | null {
    if (this.count === 0) return null;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('aColor', new BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('aSizeBlink', new BufferAttribute(new Float32Array(this.sb), 2));
    g.computeBoundingSphere();
    const p = new Points(g, material);
    p.name = 'world-lights';
    p.frustumCulled = false;
    p.renderOrder = 5;
    return p;
  }
}

export type HeightFn = (x: number, z: number) => number;

export class DecalBuilder {
  private pos: number[] = [];
  private uv: number[] = [];
  private idx: number[] = [];

  /**
   * Grid-subdivided quad in a local frame (origin ox/oz, yaw via c/s: local −Z = heading),
   * covering local x ∈ [x0, x1], z ∈ [z0, z1]. `uvFn(lx, lz)` gives texture coordinates; each
   * vertex is lifted `lift` metres above the terrain.
   */
  quad(
    f: { ox: number; oz: number; c: number; s: number },
    x0: number,
    x1: number,
    z0: number,
    z1: number,
    height: HeightFn,
    uvFn: (lx: number, lz: number) => [number, number],
    step = 90,
    lift = 0.3,
  ): void {
    const nx = Math.max(1, Math.ceil((x1 - x0) / step));
    const nz = Math.max(1, Math.ceil((z1 - z0) / step));
    const base = this.pos.length / 3;
    for (let j = 0; j <= nz; j++) {
      const lz = z0 + ((z1 - z0) * j) / nz;
      for (let i = 0; i <= nx; i++) {
        const lx = x0 + ((x1 - x0) * i) / nx;
        const wx = f.ox + lx * f.c + lz * f.s;
        const wz = f.oz - lx * f.s + lz * f.c;
        this.pos.push(wx, height(wx, wz) + lift, wz);
        const [u, v] = uvFn(lx, lz);
        this.uv.push(u, v);
      }
    }
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const a = base + j * (nx + 1) + i;
        const b = a + 1;
        const c = a + nx + 1;
        const d = c + 1;
        // counter-clockwise seen from above
        this.idx.push(a, c, b, b, c, d);
      }
  }

  /** One terrain-draped triangle in world XZ (wound to face up), split until no edge exceeds `maxEdge`. */
  private triangle(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, height: HeightFn, uvScale: number, maxEdge: number, lift: number): void {
    const ab = Math.hypot(bx - ax, bz - az);
    const bc = Math.hypot(cx - bx, cz - bz);
    const ca = Math.hypot(ax - cx, az - cz);
    const m = Math.max(ab, bc, ca);
    if (m > maxEdge) {
      // split the longest edge
      if (m === ab) {
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        this.triangle(ax, az, mx, mz, cx, cz, height, uvScale, maxEdge, lift);
        this.triangle(mx, mz, bx, bz, cx, cz, height, uvScale, maxEdge, lift);
      } else if (m === bc) {
        const mx = (bx + cx) / 2, mz = (bz + cz) / 2;
        this.triangle(ax, az, bx, bz, mx, mz, height, uvScale, maxEdge, lift);
        this.triangle(ax, az, mx, mz, cx, cz, height, uvScale, maxEdge, lift);
      } else {
        const mx = (cx + ax) / 2, mz = (cz + az) / 2;
        this.triangle(ax, az, bx, bz, mx, mz, height, uvScale, maxEdge, lift);
        this.triangle(mx, mz, bx, bz, cx, cz, height, uvScale, maxEdge, lift);
      }
      return;
    }
    // upward normal: (b − a) × (c − a) has y = Δz1·Δx2 − Δx1·Δz2 > 0
    const up = (bz - az) * (cx - ax) - (bx - ax) * (cz - az) > 0;
    const base = this.pos.length / 3;
    for (const [x, z] of up ? [[ax, az], [bx, bz], [cx, cz]] : [[ax, az], [cx, cz], [bx, bz]]) {
      this.pos.push(x, height(x, z) + lift, z);
      this.uv.push(x / uvScale, z / uvScale);
    }
    this.idx.push(base, base + 1, base + 2);
  }

  /**
   * A polygon in world XZ (flat [x0, z0, ...], either winding, closed implicitly), triangulated and draped
   * on the terrain (edges split to ≤ `maxEdge`). Texture coordinates are world XZ / `uvScale`, so
   * overlapping surfaces with the same texture (apron + taxiway) line up seamlessly.
   */
  polygon(ring: ArrayLike<number>, height: HeightFn, uvScale = 40, maxEdge = 90, lift = 0.3): void {
    const n = ring.length / 2;
    if (n < 3) return;
    const pts: Vector2[] = [];
    for (let i = 0; i < n; i++) pts.push(new Vector2(ring[i * 2], ring[i * 2 + 1]));
    for (const [a, b, c] of ShapeUtils.triangulateShape(pts, [])) {
      this.triangle(pts[a].x, pts[a].y, pts[b].x, pts[b].y, pts[c].x, pts[c].y, height, uvScale, maxEdge, lift);
    }
  }

  /**
   * A ribbon of half width `hw` along a polyline in world XZ (flat [x0, z0, ...]): mitred joints, long
   * segments split every `step` m to follow the terrain, ends extended by `hw` unless told otherwise
   * (overlapping the ribbons and aprons it meets). `snap` may move an edge vertex (off a runway). World XZ texture coordinates, as polygon().
   */
  ribbon(line: ArrayLike<number>, hw: number, height: HeightFn, uvScale = 40, step = 60, lift = 0.3, extendStart = true, extendEnd = true, snap?: (x: number, z: number) => [number, number]): void {
    const n = line.length / 2;
    if (n < 2) return;
    // densified centreline with the ends pushed out by hw
    const xs: number[] = [];
    const zs: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      let ax = line[i * 2], az = line[i * 2 + 1];
      let bx = line[i * 2 + 2], bz = line[i * 2 + 3];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-3) continue;
      const ux = (bx - ax) / len, uz = (bz - az) / len;
      if (i === 0 && extendStart) {
        ax -= ux * hw;
        az -= uz * hw;
      }
      if (i === n - 2 && extendEnd) {
        bx += ux * hw;
        bz += uz * hw;
      }
      const segs = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
      for (let k = xs.length ? 1 : 0; k <= segs; k++) {
        xs.push(ax + ((bx - ax) * k) / segs);
        zs.push(az + ((bz - az) * k) / segs);
      }
    }
    const m = xs.length;
    if (m < 2) return;
    const base = this.pos.length / 3;
    for (let i = 0; i < m; i++) {
      // averaged direction → miter normal, clamped
      const p = Math.max(0, i - 1), q = Math.min(m - 1, i + 1);
      const i0 = i === 0 ? 0 : p, i1 = i === m - 1 ? m - 1 : q;
      let dx1 = xs[i] - xs[i0], dz1 = zs[i] - zs[i0];
      let dx2 = xs[i1] - xs[i], dz2 = zs[i1] - zs[i];
      const l1 = Math.hypot(dx1, dz1) || 1, l2 = Math.hypot(dx2, dz2) || 1;
      dx1 /= l1; dz1 /= l1; dx2 /= l2; dz2 /= l2;
      if (i === 0) {
        dx1 = dx2;
        dz1 = dz2;
      }
      if (i === m - 1) {
        dx2 = dx1;
        dz2 = dz1;
      }
      // right-hand normals of both segments, averaged
      let nx = -(dz1 + dz2), nz = dx1 + dx2;
      const nl = Math.hypot(nx, nz) || 1;
      nx /= nl; nz /= nl;
      const cos = Math.max(0.5, nx * -dz1 + nz * dx1);
      const w = hw / cos;
      for (const s of [-1, 1]) {
        let x = xs[i] + nx * w * s, z = zs[i] + nz * w * s;
        if (snap) [x, z] = snap(x, z);
        this.pos.push(x, height(x, z) + lift, z);
        this.uv.push(x / uvScale, z / uvScale);
      }
    }
    for (let i = 0; i < m - 1; i++) {
      const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
      // vertices: a = left(-n) i, b = right(+n) i, c = left i+1, d = right i+1
      this.upTri(a, b, c);
      this.upTri(c, b, d);
    }
  }

  /** Index a triangle wound to face up (each one on its own: a ribbon folds at hairpin turns). */
  private upTri(a: number, b: number, c: number): void {
    const p = this.pos;
    const up = (p[b * 3 + 2] - p[a * 3 + 2]) * (p[c * 3] - p[a * 3]) - (p[b * 3] - p[a * 3]) * (p[c * 3 + 2] - p[a * 3 + 2]) >= 0;
    if (up) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }

  build(): BufferGeometry | null {
    if (this.pos.length === 0) return null;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    g.setIndex(this.pos.length / 3 > 65535 ? new BufferAttribute(new Uint32Array(this.idx), 1) : new BufferAttribute(new Uint16Array(this.idx), 1));
    g.computeBoundingSphere();
    return g;
  }
}
