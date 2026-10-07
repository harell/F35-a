/**
 * Real suburbs 7/9 (#126): the real houses and local streets of the whole Whenuapai → Airport corridor, streamed in
 * TILE m squares as the house scatter's radius reaches them.
 *
 * The bake (tools/linz/corridor-houses.py + corridor-houses.ts) fits every LINZ building outline of the corridor (the
 * box of epic #119's count inside the Auckland 2024 LiDAR Part 1 sheets) as #121 fits Devonport's (aucklandHouses.ts:
 * an oriented rectangle, a LiDAR eave and ridge, the 2024 photo's roof colour), and takes the LINZ road sections there
 * as local road ribbons (#127 phase B: kind ROAD_LOCAL). It writes one gzip file per tile under
 * src/world/terrain/data/corridor/ (akl-corridor-<i>_<j>.bin: Vite hashes them; the service worker caches them on first
 * use and never precaches them, public/sw.js ON_DEMAND) and the manifest corridor.json (bundled: the tiles, their
 * bytes, the shared roof palette).
 *
 * Tile format (little-endian, gzip on disk): 'AKLC' | u32 version | u32 n | n bytes of a houses file (aucklandHouses.ts
 * format with no palette of its own; its coverage grid is the tile's, CELL m cells) | u32 m | m bytes of a roads file
 * (aucklandRoads.ts format: the tile's local road ribbons, no region, no names).
 *
 * Where a loaded tile's coverage is set, the real houses are the truth: the scatter's procedural houses, the frontage
 * lots and the town centres' blocks step aside, and the terrain shader paints no procedural lots or streets there (its
 * ground fades from gardens near the camera, where the 3D houses stand, to the suburbs' far average where they thin
 * out). Until a tile has loaded, and offline, the procedural suburbs stay. Node-safe (no DOM).
 */
import { decodeHouses, type RealHouses } from './aucklandHouses';
import { decodeRoads, type RoadLine } from './aucklandRoads';
import { LotMask } from './lotMask';
import { linzRoadPaths, RoadNetwork, type RoadPath } from './motorways';

export const CORRIDOR_MAGIC = 'AKLC';
export const CORRIDOR_VERSION = 1;
/** Tile size (m) and coverage cell (m). */
export const CORRIDOR_TILE = 2048;
export const CORRIDOR_CELL = 32;

export interface CorridorManifest {
  version: number;
  tile: number;
  cell: number;
  /** Shared roof palette, sRGB 0xRRGGBB. */
  palette: number[];
  /** [x0, z0, x1, z1] (m): the tiles' box, on the tile lattice. */
  bounds: [number, number, number, number];
  /** [i, j, houses, gzip bytes] per tile (its square: i·tile … (i+1)·tile, j·tile …). */
  tiles: [number, number, number, number][];
}

export interface CorridorTile {
  i: number;
  j: number;
  x0: number;
  z0: number;
  houses: RealHouses;
  roads: RoadLine[];
  /** The roads as ribbon paths and their network (houses and trees keep off them). */
  paths: RoadPath[];
  net: RoadNetwork | null;
  /** The file's bytes (gzip, from the manifest). */
  bytes: number;
}

export const tileName = (i: number, j: number): string => `akl-corridor-${i}_${j}.bin`;

export function encodeCorridorTile(houses: Uint8Array, roads: Uint8Array): Uint8Array {
  const out = new Uint8Array(16 + houses.length + roads.length);
  const dv = new DataView(out.buffer);
  for (let k = 0; k < 4; k++) out[k] = CORRIDOR_MAGIC.charCodeAt(k);
  dv.setUint32(4, CORRIDOR_VERSION, true);
  dv.setUint32(8, houses.length, true);
  out.set(houses, 12);
  dv.setUint32(12 + houses.length, roads.length, true);
  out.set(roads, 16 + houses.length);
  return out;
}

export function decodeCorridorTile(bytes: Uint8Array, palette: readonly number[]): { houses: RealHouses; roads: RoadLine[] } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 16 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== CORRIDOR_MAGIC || dv.getUint32(4, true) !== CORRIDOR_VERSION) throw new Error('bad corridor tile header');
  const n = dv.getUint32(8, true);
  if (12 + n + 4 > bytes.length) throw new Error('bad corridor tile size');
  const houses = decodeHouses(bytes.subarray(12, 12 + n), palette);
  const m = dv.getUint32(12 + n, true);
  if (16 + n + m !== bytes.length) throw new Error('bad corridor tile size');
  const roads = m ? decodeRoads(bytes.subarray(16 + n, 16 + n + m)).lines : [];
  return { houses, roads };
}

export interface CorridorOptions {
  /** Tiles whose square comes within this (m, horizontally) of the camera are fetched. */
  fetchRadius: number;
  /** Loaded tiles farther than this are dropped (their coverage cleared: the procedural suburbs come back). */
  keepRadius: number;
  /** Requests in flight at once. */
  maxInFlight?: number;
  /** A failed tile is asked for again after this (ms). */
  retryMs?: number;
}

export interface CorridorStats {
  /** Tiles in the manifest. */
  tiles: number;
  loaded: number;
  pending: number;
  failed: number;
  /** Requests made, tiles installed and dropped since the start. */
  requests: number;
  installs: number;
  evictions: number;
  /** Bytes (gzip, as shipped) of the tiles installed since the start. */
  bytes: number;
  /** Real houses in the loaded tiles. */
  houses: number;
}

const key = (i: number, j: number) => `${i}_${j}`;

/**
 * The corridor's streamed tiles: which to fetch as the camera moves, the loaded ones' houses, roads and coverage
 * (`cover`, CELL m cells over the manifest's box: the terrain shader's house mask, TerrainRenderer.setHouseMask), and
 * listeners told when a tile comes or goes (Scenery: the scatters regenerate under it, the street ribbons and the town
 * centres follow, the terrain's mask rows are re-uploaded).
 */
export class CorridorHouses {
  readonly cover: LotMask;
  readonly tiles = new Map<string, CorridorTile>();
  readonly stats: CorridorStats;
  readonly listeners: ((t: CorridorTile, loaded: boolean) => void)[] = [];
  private readonly entries = new Map<string, [number, number, number, number]>();
  private readonly pending = new Set<string>();
  private readonly failed = new Map<string, number>();
  private readonly tmp: CorridorTile[] = [];
  private lastI = Number.NaN;
  private lastJ = Number.NaN;
  private queue: { i: number; j: number; d: number }[] = [];

  constructor(
    readonly manifest: CorridorManifest,
    private readonly fetchTile: (i: number, j: number) => Promise<Uint8Array>,
    readonly opts: CorridorOptions,
  ) {
    const [x0, z0, x1, z1] = manifest.bounds;
    const c = manifest.cell;
    this.cover = new LotMask(x0, z0, Math.round((x1 - x0) / c), Math.round((z1 - z0) / c), c);
    for (const t of manifest.tiles) this.entries.set(key(t[0], t[1]), t);
    this.stats = { tiles: manifest.tiles.length, loaded: 0, pending: 0, failed: 0, requests: 0, installs: 0, evictions: 0, bytes: 0, houses: 0 };
  }

  /** Horizontal distance (m) from (x, z) to tile (i, j)'s square. */
  private tileDist(i: number, j: number, x: number, z: number): number {
    const T = this.manifest.tile;
    const dx = Math.max(i * T - x, 0, x - (i + 1) * T);
    const dz = Math.max(j * T - z, 0, z - (j + 1) * T);
    return Math.hypot(dx, dz);
  }

  /** Fetch the tiles coming into range of the camera at (x, z); drop the ones left far behind. */
  update(x: number, z: number, now = Date.now()): void {
    const T = this.manifest.tile;
    const ci = Math.floor(x / T);
    const cj = Math.floor(z / T);
    // (re-list the tiles in range whenever the camera crosses a quarter tile)
    const qi = Math.floor((x * 4) / T);
    const qj = Math.floor((z * 4) / T);
    if (qi !== this.lastI || qj !== this.lastJ || this.failed.size) {
      this.lastI = qi;
      this.lastJ = qj;
      const R = this.opts.fetchRadius;
      const r = Math.ceil(R / T) + 1;
      this.queue = [];
      for (let j = cj - r; j <= cj + r; j++)
        for (let i = ci - r; i <= ci + r; i++) {
          const k = key(i, j);
          if (!this.entries.has(k) || this.tiles.has(k) || this.pending.has(k)) continue;
          const retry = this.failed.get(k);
          if (retry !== undefined && now < retry) continue;
          const d = this.tileDist(i, j, x, z);
          if (d <= R) this.queue.push({ i, j, d });
        }
      this.queue.sort((a, b) => b.d - a.d); // pop() nearest first
      for (const [k, t] of this.tiles)
        if (this.tileDist(t.i, t.j, x, z) > this.opts.keepRadius) {
          this.tiles.delete(k);
          this.setCover(t, false);
          this.stats.evictions++;
          this.count();
          for (const l of this.listeners) l(t, false);
        }
    }
    const max = this.opts.maxInFlight ?? 2;
    while (this.pending.size < max && this.queue.length) {
      const { i, j } = this.queue.pop()!;
      const k = key(i, j);
      if (this.tiles.has(k) || this.pending.has(k)) continue;
      this.pending.add(k);
      this.failed.delete(k);
      this.stats.requests++;
      this.count();
      this.fetchTile(i, j)
        .then((bytes) => {
          this.pending.delete(k);
          this.install(i, j, bytes);
        })
        .catch((err) => {
          this.pending.delete(k);
          this.failed.set(k, Date.now() + (this.opts.retryMs ?? 20000));
          this.count();
          console.warn(`[world] corridor tile ${k} unavailable, keeping the procedural suburbs there`, err);
        });
    }
  }

  /** Decode and install a tile's bytes (decompressed); its listeners are told. Throws on malformed data. */
  install(i: number, j: number, bytes: Uint8Array): CorridorTile {
    const k = key(i, j);
    const e = this.entries.get(k);
    const { houses, roads } = decodeCorridorTile(bytes, this.manifest.palette);
    const paths = roads.length ? linzRoadPaths({ region: new Float32Array(0), lines: roads }) : [];
    const T = this.manifest.tile;
    const t: CorridorTile = { i, j, x0: i * T, z0: j * T, houses, roads, paths, net: paths.length ? new RoadNetwork(paths) : null, bytes: e?.[3] ?? bytes.length };
    const old = this.tiles.get(k);
    if (old) this.setCover(old, false);
    this.tiles.set(k, t);
    this.setCover(t, true);
    this.stats.installs++;
    this.stats.bytes += t.bytes;
    this.count();
    for (const l of this.listeners) l(t, true);
    return t;
  }

  private count(): void {
    const s = this.stats;
    s.loaded = this.tiles.size;
    s.pending = this.pending.size;
    s.failed = this.failed.size;
    let n = 0;
    for (const t of this.tiles.values()) n += t.houses.count;
    s.houses = n;
  }

  /** Set (or clear) the tile's coverage cells in `cover`. */
  private setCover(t: CorridorTile, on: boolean): void {
    const g = t.houses.cover;
    const m = this.cover;
    for (let j = 0; j < g.rows; j++)
      for (let i = 0; i < g.cols; i++) {
        if (!g.bits[j * g.cols + i]) continue;
        const ci = Math.round((g.x0 + i * g.cell - m.x0) / m.cell);
        const cj = Math.round((g.z0 + j * g.cell - m.z0) / m.cell);
        if (ci < 0 || cj < 0 || ci >= m.cols || cj >= m.rows) continue;
        if (on) m.mark(ci, cj);
        else m.unmark(ci, cj);
      }
  }

  /** The texel rows (first, end) of `cover` a tile touches (TerrainRenderer.updateHouseMask). */
  coverRows(t: CorridorTile): [number, number] {
    const m = this.cover;
    const j0 = Math.floor((t.z0 - m.z0) / m.cell);
    const j1 = Math.ceil((t.z0 + this.manifest.tile - m.z0) / m.cell);
    return [Math.max(0, j0 >> 2), Math.min(m.texH, (j1 + 3) >> 2)];
  }

  /** Tiles still to fetch in range, or in flight. */
  get busy(): boolean {
    return this.pending.size > 0 || this.queue.length > 0;
  }

  /** True where a loaded tile's real houses are the truth. */
  covers(x: number, z: number): boolean {
    return this.cover.masked(x, z);
  }

  /** The loaded tiles' house files overlapping [x0, x1) × [z0, z1). */
  filesIn(x0: number, z0: number, x1: number, z1: number, out: RealHouses[] = []): RealHouses[] {
    for (const t of this.tilesIn(x0, z0, x1, z1)) out.push(t.houses);
    return out;
  }

  /** The loaded tiles overlapping [x0, x1) × [z0, z1) (a shared scratch list). */
  tilesIn(x0: number, z0: number, x1: number, z1: number): CorridorTile[] {
    const out = this.tmp;
    out.length = 0;
    if (!this.tiles.size) return out;
    const T = this.manifest.tile;
    for (let j = Math.floor(z0 / T); j <= Math.floor((z1 - 1e-6) / T); j++)
      for (let i = Math.floor(x0 / T); i <= Math.floor((x1 - 1e-6) / T); i++) {
        const t = this.tiles.get(key(i, j));
        if (t) out.push(t);
      }
    return out;
  }

  /** Within `margin` m of a loaded tile's street ribbon. */
  near(x: number, z: number, margin: number): boolean {
    if (!this.tiles.size) return false;
    const r = margin + 12;
    for (const t of this.tilesIn(x - r, z - r, x + r, z + r)) if (t.net?.near(x, z, margin)) return true;
    return false;
  }
}
