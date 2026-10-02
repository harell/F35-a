/**
 * Camera-local instanced scatter: the world is divided into square tiles; tiles within `radius` of
 * the camera are generated on demand (a few per frame, cached), and their instances are packed
 * nearest-first into fixed-capacity InstancedMeshes (one per archetype). Distant tiles keep only a
 * random subset of instances (rank-based LOD), so density falls off smoothly with distance.
 */
import { Color, InstancedBufferAttribute, InstancedMesh, Matrix4, Quaternion, Vector3, type BufferGeometry, type Material } from 'three';

export interface TileInstances {
  /** Per archetype: packed [x, y, z, yaw, sx, sy, sz, r, g, b, rank] records. */
  data: number[][];
}

export const REC = 11;

export interface ScatterSource {
  /** Number of archetypes this source emits. */
  readonly kinds: number;
  /** Generate all instances for the tile with min corner (x0, z0). */
  generate(x0: number, z0: number, size: number, out: TileInstances): void;
}

interface Tile {
  key: number;
  tx: number;
  tz: number;
  inst: TileInstances;
  lastUsed: number;
}

export interface ScatterMeshSpec {
  geometry: BufferGeometry;
  material: Material;
  capacity: number;
  /** Several meshes may share one archetype's instances (e.g. walls + roof). */
  kind: number;
  /** Instance colour slot: 0 = record colour, 1 = secondary colour function. */
  color?: (rec: number[], i: number, out: Color) => void;
}

/**
 * Share of a tile's instances drawn at slant range `ds` (m) from the camera, for a scatter of radius
 * `R`: everything near, thinning to ~22 % at the edge, none beyond. The aerial photo's low-sun light
 * fades with the houses' share (terrainShader.ts AERIAL_LIGHT_GLSL, aucklandAerial.ts aerialHouseShare()).
 */
export function scatterKeep(ds: number, R: number): number {
  if (ds > R * 1.02) return 0;
  return ds < R * 0.35 ? 1 : Math.max(0.22, 1 - ((ds - R * 0.35) / (R * 0.65)) * 0.78);
}

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _up = new Vector3(0, 1, 0);
const _c = new Color();

export class TileScatter {
  readonly meshes: InstancedMesh[] = [];
  private readonly tiles = new Map<number, Tile>();
  private frame = 0;
  private lastTx = Number.NaN;
  private lastTz = Number.NaN;
  private pending: { tx: number; tz: number; d: number }[] = [];
  private dirty = false;
  /** Camera height above ground (m): instances thin out with slant range, not map distance. */
  private agl = 0;
  private aglBucket = -1;
  visible = true;

  constructor(
    private readonly source: ScatterSource,
    private readonly specs: ScatterMeshSpec[],
    private readonly tileSize: number,
    private readonly radius: number,
    private readonly tilesPerFrame = 2,
  ) {
    for (const s of specs) {
      const m = new InstancedMesh(s.geometry, s.material, s.capacity);
      m.instanceColor = new InstancedBufferAttribute(new Float32Array(s.capacity * 3), 3);
      m.count = 0;
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      this.meshes.push(m);
    }
  }

  private key(tx: number, tz: number): number {
    return (tx + 4096) * 8192 + (tz + 4096);
  }

  /** Stream tiles around the camera and repack instances when the set changes. */
  update(cam: Vector3, agl = 0): void {
    this.frame++;
    const bucket = Math.round(Math.max(0, agl) / 120);
    if (bucket !== this.aglBucket) {
      this.aglBucket = bucket;
      this.agl = bucket * 120;
      this.dirty = true;
    }
    const ts = this.tileSize;
    const tx = Math.floor(cam.x / ts);
    const tz = Math.floor(cam.z / ts);
    if (tx !== this.lastTx || tz !== this.lastTz) {
      this.lastTx = tx;
      this.lastTz = tz;
      const r = Math.ceil(this.radius / ts);
      this.pending.length = 0;
      for (let j = -r; j <= r; j++)
        for (let i = -r; i <= r; i++) {
          const cx = (tx + i + 0.5) * ts;
          const cz = (tz + j + 0.5) * ts;
          const d = Math.hypot(cx - cam.x, cz - cam.z);
          if (d > this.radius + ts * 0.71) continue;
          const t = this.tiles.get(this.key(tx + i, tz + j));
          if (t) t.lastUsed = this.frame;
          else this.pending.push({ tx: tx + i, tz: tz + j, d });
        }
      this.pending.sort((a, b) => b.d - a.d); // pop() nearest first
      // Evict tiles far outside the radius
      for (const [k, t] of this.tiles) {
        const cx = (t.tx + 0.5) * ts;
        const cz = (t.tz + 0.5) * ts;
        if (Math.hypot(cx - cam.x, cz - cam.z) > this.radius + ts * 2.5) this.tiles.delete(k);
      }
      this.dirty = true;
    }
    for (let n = 0; n < this.tilesPerFrame && this.pending.length; n++) {
      const p = this.pending.pop()!;
      const inst: TileInstances = { data: [] };
      for (let k = 0; k < this.source.kinds; k++) inst.data.push([]);
      this.source.generate(p.tx * ts, p.tz * ts, ts, inst);
      this.tiles.set(this.key(p.tx, p.tz), { key: this.key(p.tx, p.tz), tx: p.tx, tz: p.tz, inst, lastUsed: this.frame });
      this.dirty = true;
    }
    if (this.dirty && (this.pending.length === 0 || this.frame % 8 === 0)) this.repack(cam);
    for (const m of this.meshes) m.visible = this.visible;
  }

  private repack(cam: Vector3): void {
    this.dirty = false;
    const ts = this.tileSize;
    const list: { t: Tile; d: number }[] = [];
    for (const t of this.tiles.values()) {
      const d = Math.hypot((t.tx + 0.5) * ts - cam.x, (t.tz + 0.5) * ts - cam.z);
      if (d <= this.radius + ts * 0.71) list.push({ t, d });
    }
    list.sort((a, b) => a.d - b.d);
    const R = this.radius;
    const agl2 = this.agl * this.agl;
    const rec: number[] = new Array(REC);
    for (let si = 0; si < this.specs.length; si++) {
      const spec = this.specs[si];
      const mesh = this.meshes[si];
      const mat = mesh.instanceMatrix.array as Float32Array;
      const col = mesh.instanceColor!.array as Float32Array;
      let n = 0;
      for (const { t, d } of list) {
        // rank-based thinning with slant range: keep everything near, ~22 % at the edge, none beyond
        const keep = scatterKeep(Math.sqrt(d * d + agl2), R);
        if (keep <= 0) continue;
        const arr = t.inst.data[spec.kind];
        for (let i = 0; i < arr.length && n < spec.capacity; i += REC) {
          if (arr[i + 10] > keep) continue;
          _p.set(arr[i], arr[i + 1], arr[i + 2]);
          _q.setFromAxisAngle(_up, arr[i + 3]);
          _s.set(arr[i + 4], arr[i + 5], arr[i + 6]);
          _m.compose(_p, _q, _s);
          _m.toArray(mat, n * 16);
          if (spec.color) {
            for (let k = 0; k < REC; k++) rec[k] = arr[i + k];
            spec.color(rec, i, _c);
            col[n * 3] = _c.r;
            col[n * 3 + 1] = _c.g;
            col[n * 3 + 2] = _c.b;
          } else {
            col[n * 3] = arr[i + 7];
            col[n * 3 + 1] = arr[i + 8];
            col[n * 3 + 2] = arr[i + 9];
          }
          n++;
        }
        if (n >= spec.capacity) break;
      }
      mesh.count = n;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, n * 16);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.clearUpdateRanges();
      mesh.instanceColor!.addUpdateRange(0, n * 3);
      mesh.instanceColor!.needsUpdate = true;
    }
  }

  /** True when no tiles are pending and instances are packed. */
  get idle(): boolean {
    return this.pending.length === 0 && !this.dirty;
  }

  get instanceCount(): number {
    return this.meshes.reduce((a, m) => a + m.count, 0);
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.removeFromParent();
      m.dispose();
    }
    this.tiles.clear();
  }
}
