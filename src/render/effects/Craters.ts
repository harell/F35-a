/**
 * Impact craters (#201): a dark, shallow bowl with a raised rim of thrown-up sand, laid on the
 * terrain where a bomb or missile hit the ground (Effects: every munition that ends on land, sized
 * by its warhead) and where a target that leaves nothing else behind died (g03's stoat, t04's rats).
 * Each crater is its own small mesh (a few hundred triangles), conformed to the ground under it, and
 * stays for the rest of the sortie; a fixed pool, the oldest reused when it runs out.
 *
 * A new crater is dug, not dropped: it opens from a third of its size to full over CRATER_DIG s
 * (update), under the blast's own dust. A crater asked for where one already is (a bomb that killed
 * the stoat: the kill and the impact land together) reuses it, grown to the larger of the two.
 */
import { BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshLambertMaterial } from 'three';

/** Rings and segments of a crater mesh. */
const RINGS = 7;
const SEGS = 28;
/** Colours: the scorched floor, the dug-up sand of the rim, and the sand it fades into. */
const FLOOR = new Color(0x2b231b);
const RIM = new Color(0xb09670);
const EDGE = new Color(0x8f7d5c);

/**
 * Height of the crater surface above the ground (m) at `f` = distance / radius: a shallow floor
 * (drawn just above the ground: the bowl reads by its colour and its rim), a rim peaking at
 * 0.9 × radius, gone by 1.3 × radius. `rim` is the rim's height (m).
 */
export function craterProfile(f: number, rim: number): number {
  const lift = 0.06;
  if (f <= 0.75) return lift;
  if (f <= 0.9) return lift + rim * ((f - 0.75) / 0.15);
  if (f <= 1.3) return lift + rim * (1 - (f - 0.9) / 0.4);
  return lift;
}

/** Seconds a new crater takes to open to its full size. */
export const CRATER_DIG = 0.6;
/** Size a crater opens from (× its radius). */
const DIG_FROM = 0.35;

/** How far a crater has opened (× its radius) `age` s after it was dug: eases out from DIG_FROM to 1. */
export function craterOpening(age: number): number {
  const f = Math.min(1, Math.max(0, age / CRATER_DIG));
  return DIG_FROM + (1 - DIG_FROM) * (1 - (1 - f) ** 3);
}

interface CraterInfo {
  x: number;
  z: number;
  radius: number;
  /** Time it was dug (s, the clock update() is given). */
  t0: number;
}

export class Craters {
  readonly group = new Group();
  private readonly meshes: Mesh[] = [];
  private readonly info: CraterInfo[] = [];
  private next = 0;
  private time = 0;
  private readonly material = new MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });

  constructor(private readonly max = 32) {
    this.group.name = 'craters';
  }

  /** Open the craters still being dug; `time` is the sim clock (s). */
  update(time: number): void {
    this.time = time;
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i];
      if (!m.visible) continue;
      const k = craterOpening(time - this.info[i].t0);
      m.scale.set(k, 1, k);
    }
  }

  /** How many craters are on the ground. */
  get count(): number {
    return this.meshes.filter((m) => m.visible).length;
  }

  /**
   * A crater of `radius` m centred at (x, z) on the ground `groundAt` gives (m MSL), with its rim
   * `rim` m high.
   */
  add(x: number, z: number, radius: number, groundAt: (x: number, z: number) => number, rim = radius * 0.15): Mesh {
    // one already there (the kill and the bomb that made it): keep it, or grow it to the bigger one
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i];
      const c = this.info[i];
      if (!m.visible || Math.hypot(c.x - x, c.z - z) > Math.max(c.radius, radius) * 0.6) continue;
      if (c.radius >= radius) return m;
      this.build(i, c.x, c.z, radius, groundAt, rim, c.t0);
      return m;
    }
    const slot = this.next;
    this.next = (this.next + 1) % this.max;
    return this.build(slot, x, z, radius, groundAt, rim, this.time);
  }

  private build(slot: number, x: number, z: number, radius: number, groundAt: (x: number, z: number) => number, rim: number, t0: number): Mesh {
    const verts = 1 + RINGS * SEGS;
    const pos = new Float32Array(verts * 3);
    const col = new Float32Array(verts * 3);
    const c = new Color();
    const outer = 1.3;
    const put = (i: number, px: number, pz: number, f: number) => {
      pos[i * 3] = px - x;
      pos[i * 3 + 1] = groundAt(px, pz) + craterProfile(f, rim);
      pos[i * 3 + 2] = pz - z;
      if (f <= 0.75) c.copy(FLOOR).lerp(RIM, (f / 0.75) ** 3 * 0.35);
      else if (f <= 0.9) c.copy(FLOOR).lerp(RIM, 0.35 + 0.65 * ((f - 0.75) / 0.15));
      else c.copy(RIM).lerp(EDGE, (f - 0.9) / 0.4);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    };
    put(0, x, z, 0);
    for (let r = 1; r <= RINGS; r++) {
      const f = (r / RINGS) * outer;
      // a ragged edge: thrown sand doesn't land in a circle
      for (let s = 0; s < SEGS; s++) {
        const a = (s / SEGS) * Math.PI * 2;
        const jag = r >= RINGS - 2 ? 1 + 0.12 * Math.sin(a * 5 + x) * Math.cos(a * 3 + z) : 1;
        put(1 + (r - 1) * SEGS + s, x + Math.cos(a) * radius * f * jag, z + Math.sin(a) * radius * f * jag, f);
      }
    }
    const idx: number[] = [];
    for (let s = 0; s < SEGS; s++) idx.push(0, 1 + ((s + 1) % SEGS), 1 + s);
    for (let r = 1; r < RINGS; r++) {
      const a0 = 1 + (r - 1) * SEGS;
      const b0 = 1 + r * SEGS;
      for (let s = 0; s < SEGS; s++) {
        const s1 = (s + 1) % SEGS;
        idx.push(a0 + s, a0 + s1, b0 + s, a0 + s1, b0 + s1, b0 + s);
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    geo.setAttribute('color', new BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    let mesh = this.meshes[slot];
    if (mesh) {
      mesh.geometry.dispose();
      mesh.geometry = geo;
    } else {
      mesh = new Mesh(geo, this.material);
      mesh.name = 'crater';
      mesh.receiveShadow = true;
      this.meshes[slot] = mesh;
      this.group.add(mesh);
    }
    this.info[slot] = { x, z, radius, t0 };
    mesh.position.set(x, 0, z);
    const k = craterOpening(this.time - t0);
    mesh.scale.set(k, 1, k);
    mesh.visible = true;
    return mesh;
  }

  dispose(): void {
    for (const m of this.meshes) m.geometry.dispose();
    this.material.dispose();
    this.group.removeFromParent();
  }
}
