/**
 * Accumulates simple lit primitives (boxes, gable roofs, prisms, cylinders, arches) into one merged
 * BufferGeometry with per-vertex colour and a window-style attribute, so every scenery feature is a
 * single draw call. Local frames: yaw θ about +Y (three.js convention); θ = −heading.
 */
import { BufferAttribute, BufferGeometry, Color, ShapeUtils, Vector2 } from 'three';

export interface Frame {
  ox: number;
  oy: number;
  oz: number;
  c: number;
  s: number;
}

/** Frame at a world origin whose local −Z axis points along `heading` (rad, clockwise from north). */
export function frameFromHeading(x: number, y: number, z: number, heading: number): Frame {
  const th = -heading;
  return { ox: x, oy: y, oz: z, c: Math.cos(th), s: Math.sin(th) };
}

/** World frame (local = world). */
export const IDENT_FRAME: Frame = { ox: 0, oy: 0, oz: 0, c: 1, s: 0 };

/** Window styles for the building shader (aWin). */
export const WIN_NONE = 0;
export const WIN_OFFICE = 1;
export const WIN_HOME = 2;
export const WIN_INDUSTRIAL = 3;
export const WIN_GLOW = 4; // uniformly emissive at night (tower pod, lit sign)
export const WIN_RIBS = 5; // standing-seam sheet metal: seams down a roof's fall line (Spark Arena)
export const WIN_LOBBY = 6; // curtain-wall glass on a mullion grid, lit from inside at night (Spark Arena's foyer)
export const WIN_BALCONY = 7; // apartment balcony bands: a white slab edge every 3.2 m storey over dark glazing (the Scene apartments)

export class GeometryBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private col: number[] = [];
  private win: number[] = [];
  private idx: number[] = [];
  private readonly tmp = new Color();

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  private wx(f: Frame, lx: number, lz: number): number {
    return f.ox + lx * f.c + lz * f.s;
  }
  private wz(f: Frame, lx: number, lz: number): number {
    return f.oz - lx * f.s + lz * f.c;
  }

  /** Quad from 4 local points (counter-clockwise seen from the front), flat normal. */
  quad(f: Frame, p: number[], color: Color | number, win = WIN_NONE): void {
    const c = typeof color === 'number' ? this.tmp.setHex(color) : color;
    const base = this.vertexCount;
    const w: number[] = [];
    for (let i = 0; i < 4; i++) {
      w.push(this.wx(f, p[i * 3], p[i * 3 + 2]), f.oy + p[i * 3 + 1], this.wz(f, p[i * 3], p[i * 3 + 2]));
    }
    // normal = (p1 − p0) × (p3 − p0)
    const ax = w[3] - w[0], ay = w[4] - w[1], az = w[5] - w[2];
    const bx = w[9] - w[0], by = w[10] - w[1], bz = w[11] - w[2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    for (let i = 0; i < 4; i++) {
      this.pos.push(w[i * 3], w[i * 3 + 1], w[i * 3 + 2]);
      this.nrm.push(nx, ny, nz);
      this.col.push(c.r, c.g, c.b);
      this.win.push(win);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Triangle from 3 local points (counter-clockwise from the front). */
  tri(f: Frame, p: number[], color: Color | number, win = WIN_NONE): void {
    const c = typeof color === 'number' ? this.tmp.setHex(color) : color;
    const base = this.vertexCount;
    const w: number[] = [];
    for (let i = 0; i < 3; i++) w.push(this.wx(f, p[i * 3], p[i * 3 + 2]), f.oy + p[i * 3 + 1], this.wz(f, p[i * 3], p[i * 3 + 2]));
    const ax = w[3] - w[0], ay = w[4] - w[1], az = w[5] - w[2];
    const bx = w[6] - w[0], by = w[7] - w[1], bz = w[8] - w[2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    for (let i = 0; i < 3; i++) {
      this.pos.push(w[i * 3], w[i * 3 + 1], w[i * 3 + 2]);
      this.nrm.push(nx, ny, nz);
      this.col.push(c.r, c.g, c.b);
      this.win.push(win);
    }
    this.idx.push(base, base + 1, base + 2);
  }

  /**
   * Axis-aligned (in the frame) box: centre (cx, cz), bottom y0, size w (x) × h (y) × d (z).
   * Bottom face omitted. `roof` colours the top face.
   */
  box(f: Frame, cx: number, y0: number, cz: number, w: number, h: number, d: number, color: Color | number, roof?: Color | number, win = WIN_NONE): void {
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, y1 = y0 + h;
    const colr = typeof color === 'number' ? new Color(color) : color.clone();
    // +Z face (south in local)
    this.quad(f, [x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1], colr, win);
    // −Z
    this.quad(f, [x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0], colr, win);
    // +X
    this.quad(f, [x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1], colr, win);
    // −X
    this.quad(f, [x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0], colr, win);
    // top
    this.quad(f, [x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0], roof ?? colr, WIN_NONE);
  }

  /** Gable roof on top of a w × d footprint at height y0, ridge along local Z. */
  gable(f: Frame, cx: number, y0: number, cz: number, w: number, d: number, rise: number, color: Color | number): void {
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2, yr = y0 + rise;
    this.quad(f, [x1, y0, z1, x1, y0, z0, cx, yr, z0, cx, yr, z1], color);
    this.quad(f, [x0, y0, z0, x0, y0, z1, cx, yr, z1, cx, yr, z0], color);
    this.tri(f, [x0, y0, z1, x1, y0, z1, cx, yr, z1], color);
    this.tri(f, [x1, y0, z0, x0, y0, z0, cx, yr, z0], color);
  }

  /** Vertical (tapered) cylinder / cone frustum. */
  cylinder(f: Frame, cx: number, y0: number, cz: number, r0: number, r1: number, h: number, segs: number, color: Color | number, win = WIN_NONE, capTop = true, topColor?: Color | number): void {
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      this.quad(f, [cx + c1 * r0, y0, cz + s1 * r0, cx + c0 * r0, y0, cz + s0 * r0, cx + c0 * r1, y0 + h, cz + s0 * r1, cx + c1 * r1, y0 + h, cz + s1 * r1], color, win);
      if (capTop && r1 > 0.01) this.tri(f, [cx, y0 + h, cz, cx + c1 * r1, y0 + h, cz + s1 * r1, cx + c0 * r1, y0 + h, cz + s0 * r1], topColor ?? color);
    }
  }

  /** Half-cylinder arch (hardened aircraft shelter / hangar), axis along local Z, opening at −Z. */
  arch(f: Frame, cx: number, y0: number, cz: number, radius: number, length: number, segs: number, color: Color | number, doorColor: Color | number): void {
    const z0 = cz - length / 2;
    const z1 = cz + length / 2;
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI;
      const a1 = ((i + 1) / segs) * Math.PI;
      const xa = cx + Math.cos(a0) * radius, ya = y0 + Math.sin(a0) * radius * 0.85;
      const xb = cx + Math.cos(a1) * radius, yb = y0 + Math.sin(a1) * radius * 0.85;
      this.quad(f, [xa, ya, z1, xa, ya, z0, xb, yb, z0, xb, yb, z1], color);
      // back wall (+Z) fan and front door (−Z)
      this.tri(f, [cx, y0, z1, xa, ya, z1, xb, yb, z1], color);
      this.tri(f, [cx, y0, z0, xb, yb, z0, xa, ya, z0], doorColor);
    }
  }

  /**
   * Vertical prism over a footprint polygon in world XZ (flat [x0, z0, ...], either winding): walls from
   * y0 up to the roof, roof triangulated (earcut). `roof(x, z)` gives the roof height at a vertex (a
   * tilted plane for a sloped crown). Bottom face omitted; `walls = false` draws the roof alone (a flat
   * slab: pontoons). Returns the triangle count.
   */
  prism(ring: ArrayLike<number>, y0: number, roof: (x: number, z: number) => number, color: Color | number, roofColor: Color | number, win = WIN_NONE, walls = true): number {
    const n = ring.length / 2;
    if (n < 3) return 0;
    const t0 = this.triangleCount;
    let area = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) area += ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
    const colr = typeof color === 'number' ? new Color(color) : color.clone();
    const top: number[] = [];
    for (let i = 0; i < n; i++) top.push(roof(ring[i * 2], ring[i * 2 + 1]));
    // walls face out: with a positive shoelace area (x, z) the outside is on the right of a → b, so
    // the quad runs b → a (quad's normal = (p1 − p0) × (p3 − p0))
    for (let i = 0; walls && i < n; i++) {
      const j = (i + 1) % n;
      const [a, b] = area > 0 ? [j, i] : [i, j];
      const ax = ring[a * 2];
      const az = ring[a * 2 + 1];
      const bx = ring[b * 2];
      const bz = ring[b * 2 + 1];
      if (ax === bx && az === bz) continue;
      this.quad(IDENT_FRAME, [ax, y0, az, bx, y0, bz, bx, top[b], bz, ax, top[a], az], colr, win);
    }
    const pts: Vector2[] = [];
    for (let i = 0; i < n; i++) pts.push(new Vector2(ring[i * 2], ring[i * 2 + 1]));
    for (const [a, b, c] of ShapeUtils.triangulateShape(pts, [])) {
      const p = (k: number) => [ring[k * 2], top[k], ring[k * 2 + 1]];
      // upward normal: (p1 − p0) × (p2 − p0) has y = Δz1·Δx2 − Δx1·Δz2 > 0
      const up = (ring[b * 2 + 1] - ring[a * 2 + 1]) * (ring[c * 2] - ring[a * 2]) - (ring[b * 2] - ring[a * 2]) * (ring[c * 2 + 1] - ring[a * 2 + 1]) > 0;
      this.tri(IDENT_FRAME, up ? [...p(a), ...p(b), ...p(c)] : [...p(a), ...p(c), ...p(b)], roofColor, WIN_NONE);
    }
    return this.triangleCount - t0;
  }

  /** Oriented box between two local points (beams, truss members, masts). */
  beam(f: Frame, ax: number, ay: number, az: number, bx: number, by: number, bz: number, thick: number, color: Color | number): void {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz) || 1;
    const ux = dx / len, uy = dy / len, uz = dz / len;
    // pick a helper axis not parallel to u
    let hx = 0, hy = 1;
    const hz = 0;
    if (Math.abs(uy) > 0.9) {
      hx = 1;
      hy = 0;
    }
    // v = normalize(h × u), w = u × v
    let vx = hy * uz - hz * uy, vy = hz * ux - hx * uz, vz = hx * uy - hy * ux;
    const vl = Math.hypot(vx, vy, vz) || 1;
    vx /= vl;
    vy /= vl;
    vz /= vl;
    const wx = uy * vz - uz * vy, wy = uz * vx - ux * vz, wz = ux * vy - uy * vx;
    const t = thick / 2;
    const corner = (s: number, e: number, px: number, py: number, pz: number) => [px + (vx * s + wx * e) * t, py + (vy * s + wy * e) * t, pz + (vz * s + wz * e) * t];
    const A = [corner(-1, -1, ax, ay, az), corner(1, -1, ax, ay, az), corner(1, 1, ax, ay, az), corner(-1, 1, ax, ay, az)];
    const B = [corner(-1, -1, bx, by, bz), corner(1, -1, bx, by, bz), corner(1, 1, bx, by, bz), corner(-1, 1, bx, by, bz)];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.quad(f, [...A[i], ...A[j], ...B[j], ...B[i]], color);
    }
  }

  build(): BufferGeometry | null {
    if (this.pos.length === 0) return null;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('aWin', new BufferAttribute(new Float32Array(this.win), 1));
    const n = this.vertexCount;
    g.setIndex(n > 65535 ? new BufferAttribute(new Uint32Array(this.idx), 1) : new BufferAttribute(new Uint16Array(this.idx), 1));
    g.computeBoundingSphere();
    return g;
  }
}
