/**
 * Small collectors used by the scenery builders:
 *  - LightList: point lights (runway/taxi/aviation/city) → one Points object
 *  - DecalBuilder: terrain-conforming textured ground strips/quads → one mesh per texture
 */
import { BufferAttribute, BufferGeometry, Color, Points, type Material } from 'three';

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
