/**
 * Real suburbs 7/9 (#126): the real houses and local streets of the Whenuapai → Airport corridor, streamed in 2 km
 * tiles (src/world/terrain/data/corridor/, tools/linz/corridor-houses.py + corridor-houses.ts; corridorHouses.ts).
 */
import { describe, expect, it } from 'vitest';
import SPOT from './fixtures/corridor-house-spotchecks.json';
import MANIFEST from '../src/world/terrain/data/corridor/corridor.json';
import sw from '../public/sw.js?raw';
import { aucklandHouses, housesCover, housesIn, nearestHouse, type RealHouses } from '../src/world/scenery/aucklandHouses';
import { aucklandRoads, ROAD_LOCAL } from '../src/world/scenery/aucklandRoads';
import { aucklandNeighbourhoods } from '../src/world/scenery/aucklandNeighbourhoods';
import { landmarkCovers } from '../src/world/scenery/aucklandLandmarks';
import { CORRIDOR_CELL, CORRIDOR_TILE, CorridorHouses, decodeCorridorTile, tileName, type CorridorManifest } from '../src/world/scenery/corridorHouses';
import { CORRIDOR_MANIFEST, CORRIDOR_URLS, FETCH_AHEAD, KEEP_PAST } from '../src/world/scenery/corridorTiles';
import { APARTMENT, ColorMapSampler, HOUSE, HouseSource, SHED, TreeSource } from '../src/world/scenery/sources';
import { REC, TileScatter, type ScatterSource, type TileInstances } from '../src/world/scenery/scatter';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { allFeatures } from '../src/world/scenery/Scenery';
import { bakeColorRows } from '../src/world/terrain/bake';
import { reduceView } from '../src/world/terrain/parallel';
import { AKL_CBD_GRID, worldConfig } from '../src/world/config';
import { QUALITY_PRESETS } from '../src/core/data';
import { createVegetation } from '../src/world/terrain/vegetation';
import { AKL_LAKES } from '../src/world/terrain/theaters/aucklandMap';
import { BoxGeometry, MeshBasicMaterial, Vector3 } from 'three';

interface Fs {
  readFileSync(p: URL): Uint8Array;
  existsSync(p: URL): boolean;
}
interface Zlib {
  gunzipSync(b: Uint8Array): Uint8Array;
}
const fs = (await import(/* @vite-ignore */ 'node:fs' as string)) as Fs;
const zlib = (await import(/* @vite-ignore */ 'node:zlib' as string)) as Zlib;

const M = MANIFEST as unknown as CorridorManifest;
const fileOf = (i: number, j: number) => new URL(`../src/world/terrain/data/corridor/${tileName(i, j)}`, import.meta.url);
const gzOf = (i: number, j: number) => new Uint8Array(fs.readFileSync(fileOf(i, j)));
const rawOf = (i: number, j: number) => new Uint8Array(zlib.gunzipSync(gzOf(i, j)));
const tileAt = (x: number, z: number) => [Math.floor(x / CORRIDOR_TILE), Math.floor(z / CORRIDOR_TILE)] as const;
const decoded = new Map<string, ReturnType<typeof decodeCorridorTile>>();
const tile = (i: number, j: number) => {
  const k = `${i}_${j}`;
  if (!decoded.has(k)) decoded.set(k, decodeCorridorTile(rawOf(i, j), M.palette));
  return decoded.get(k)!;
};

/** Places along the corridor (game XZ, m). */
const MT_ROSKILL = [-2247, 7156] as const;
const HENDERSON = [-11735, 3428] as const;
const AVONDALE = [-6081, 5270] as const;
const MANGERE = [3282, 13259] as const;
const WHENUAPAI = [-11776, -6422] as const;
const AIRPORT = [2139, 18147] as const;

/** A stream over the shipped tiles that reads them from disk at once (the browser fetches them). */
function diskStream(houseRadius: number, log: [number, number][] = []): CorridorHouses {
  return new CorridorHouses(
    M,
    (i, j) => {
      log.push([i, j]);
      return Promise.resolve(rawOf(i, j));
    },
    { fetchRadius: houseRadius + FETCH_AHEAD, keepRadius: houseRadius + KEEP_PAST, maxInFlight: 2 },
  );
}
const settle = () => new Promise((r) => setTimeout(r, 0));
async function loadAround(s: CorridorHouses, x: number, z: number): Promise<void> {
  for (let n = 0; n < 200; n++) {
    s.update(x, z);
    await settle();
    if (!s.busy) return;
  }
}

describe('corridor tiles (src/world/terrain/data/corridor)', () => {
  it('ship every tile of the manifest, at its bytes, ≈ 7–9 B a house, ≈ 2.5–3 MB in all', () => {
    expect(M.tile).toBe(CORRIDOR_TILE);
    expect(M.cell).toBe(CORRIDOR_CELL);
    expect(M.palette.length).toBe(256);
    expect(M.tiles.length).toBeGreaterThan(100);
    let bytes = 0;
    let houses = 0;
    for (const [i, j, n, b] of M.tiles) {
      expect(fs.existsSync(fileOf(i, j))).toBe(true);
      expect(gzOf(i, j).length).toBe(b);
      bytes += b;
      houses += n;
      // a tile is one download of a few tens of kB at most
      expect(b).toBeLessThan(120_000);
    }
    expect(houses).toBeGreaterThan(250_000);
    expect(bytes).toBeLessThan(3_300_000);
    expect(bytes / houses).toBeLessThan(10);
    // the game finds every tile's URL (Vite: import.meta.glob)
    expect(CORRIDOR_MANIFEST.tiles.length).toBe(M.tiles.length);
    for (const [i, j] of M.tiles) expect(CORRIDOR_URLS.has(`${i}_${j}`)).toBe(true);
  });

  it('put the houses where LINZ traced them (spot checks across the corridor, within 0.5 m)', () => {
    expect(SPOT.length).toBeGreaterThanOrEqual(20);
    for (const s of SPOT) {
      const [i, j] = tileAt(s.x, s.z);
      const t = tile(i, j);
      const k = nearestHouse(t.houses, s.x, s.z, 2);
      expect(k, `house ${s.id}`).toBeGreaterThanOrEqual(0);
      expect(Math.hypot(t.houses.x[k] - s.x, t.houses.z[k] - s.z)).toBeLessThan(0.5);
      expect(t.houses.w[k]).toBeCloseTo(s.w, 0);
      expect(t.houses.d[k]).toBeCloseTo(s.d, 0);
      expect(t.houses.eave[k]).toBeCloseTo(s.eave, 0);
      // and its coverage is set there: the procedural lots step aside
      expect(housesCover(t.houses, s.x, s.z)).toBe(true);
    }
  });

  it("keep out of the CBD region, #121's Devonport, the hero neighbourhoods and the landmark buildings", () => {
    const region = aucklandRoads()!.region;
    const inRegion = (x: number, z: number) => {
      let ins = false;
      for (let a = 0, b = region.length / 2 - 1; a < region.length / 2; b = a++) {
        const xa = region[a * 2], za = region[a * 2 + 1], xb = region[b * 2], zb = region[b * 2 + 1];
        if (za > z !== zb > z && x < ((xb - xa) * (z - za)) / (zb - za) + xa) ins = !ins;
      }
      return ins;
    };
    const dev = aucklandHouses()!;
    const nbs = aucklandNeighbourhoods()!;
    const inRing = (r: ArrayLike<number>, x: number, z: number) => {
      let ins = false;
      for (let a = 0, b = r.length / 2 - 1; a < r.length / 2; b = a++) {
        const xa = r[a * 2], za = r[a * 2 + 1], xb = r[b * 2], zb = r[b * 2 + 1];
        if (za > z !== zb > z && x < ((xb - xa) * (z - za)) / (zb - za) + xa) ins = !ins;
      }
      return ins;
    };
    let n = 0;
    for (const [i, j] of M.tiles.filter((_, k) => k % 4 === 0)) {
      const h = tile(i, j).houses;
      for (let k = 0; k < h.count; k += 5) {
        const x = h.x[k], z = h.z[k];
        expect(inRegion(x, z)).toBe(false);
        expect(housesCover(dev, x, z)).toBe(false);
        expect(nbs.some((nb) => inRing(nb.footprint, x, z))).toBe(false);
        expect(landmarkCovers(x, z, 0)).toBe(false);
        n++;
      }
      // the coverage: never in the CBD region nor on Devonport's
      const c = h.cover;
      for (let b = 0; b < c.rows; b += 3)
        for (let a = 0; a < c.cols; a += 3) {
          if (!c.bits[b * c.cols + a]) continue;
          const x = c.x0 + (a + 0.5) * c.cell, z = c.z0 + (b + 0.5) * c.cell;
          expect(inRegion(x, z)).toBe(false);
          expect(housesCover(dev, x, z)).toBe(false);
        }
    }
    expect(n).toBeGreaterThan(10_000);
  });

  it('stand clear of the hand-placed lakes, as their streets do (playtest r1 1.2-a: the Panmure Basin over Pakuranga)', () => {
    let near = 0;
    for (const [lx, lz, lr] of AKL_LAKES) {
      const cx = lx * 1000, cz = lz * 1000, r = lr * 1000;
      for (const [i, j] of M.tiles) {
        if (cx + r < i * CORRIDOR_TILE || cx - r > (i + 1) * CORRIDOR_TILE || cz + r < j * CORRIDOR_TILE || cz - r > (j + 1) * CORRIDOR_TILE) continue;
        const t = tile(i, j);
        for (let k = 0; k < t.houses.count; k++) {
          const d = Math.hypot(t.houses.x[k] - cx, t.houses.z[k] - cz);
          if (d < r + 200) near++;
          expect(d, `house at ${t.houses.x[k].toFixed(0)},${t.houses.z[k].toFixed(0)}`).toBeGreaterThan(r + 5);
        }
        for (const l of t.roads) for (let k = 0; k < l.pts.length; k += 2) expect(Math.hypot(l.pts[k] - cx, l.pts[k + 1] - cz)).toBeGreaterThan(r);
      }
    }
    expect(near).toBeGreaterThan(20); // (the basin's shore is built up)
  });

  it('carry the suburbs’ LINZ streets as local road ribbons (#127 phase B)', () => {
    let km = 0;
    for (const c of [MT_ROSKILL, HENDERSON, AVONDALE, MANGERE]) {
      const t = tile(...tileAt(c[0], c[1]));
      expect(t.houses.count).toBeGreaterThan(1500);
      expect(t.roads.length).toBeGreaterThan(80);
      for (const l of t.roads) {
        expect(l.kind).toBe(ROAD_LOCAL);
        expect([6, 9]).toContain(l.width);
        for (let p = 0; p < l.pts.length; p += 2) {
          // cut at the tile's edges (the cut's vertex is the 4 m densified one just past it)
          expect(l.pts[p]).toBeGreaterThanOrEqual(t.houses.cover.x0 - 4.5);
          expect(l.pts[p]).toBeLessThanOrEqual(t.houses.cover.x0 + CORRIDOR_TILE + 4.5);
        }
        for (let p = 2; p < l.pts.length; p += 2) km += Math.hypot(l.pts[p] - l.pts[p - 2], l.pts[p + 1] - l.pts[p - 1]) / 1000;
      }
    }
    // dense suburbs: 20–40 km of streets in a tile of 4.2 km² (besides the arterials and motorways)
    expect(km).toBeGreaterThan(4 * 18);
  });
});

describe('the corridor stream (corridorHouses.ts)', () => {
  it('fetches the tiles the house scatter reaches, nearest first, two at a time; drops them far behind', async () => {
    const log: [number, number][] = [];
    const R = 2400; // the medium tier's house radius (config.ts)
    const s = diskStream(R, log);
    expect(s.covers(MT_ROSKILL[0], MT_ROSKILL[1])).toBe(false);
    s.update(MT_ROSKILL[0], MT_ROSKILL[1]);
    // two requests in flight, the camera's own tile first
    expect(log.length).toBe(2);
    expect(log[0]).toEqual([...tileAt(MT_ROSKILL[0], MT_ROSKILL[1])]);
    await loadAround(s, MT_ROSKILL[0], MT_ROSKILL[1]);
    expect(s.stats.loaded).toBeGreaterThan(4);
    expect(s.stats.pending).toBe(0);
    expect(s.covers(MT_ROSKILL[0], MT_ROSKILL[1])).toBe(true);
    // every tile within reach loaded; none beyond it
    for (const t of s.tiles.values()) {
      const dx = Math.max(t.x0 - MT_ROSKILL[0], 0, MT_ROSKILL[0] - t.x0 - CORRIDOR_TILE);
      const dz = Math.max(t.z0 - MT_ROSKILL[1], 0, MT_ROSKILL[1] - t.z0 - CORRIDOR_TILE);
      expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(R + FETCH_AHEAD);
    }
    // the loaded houses are found where they stand
    const files: RealHouses[] = s.filesIn(MT_ROSKILL[0] - 100, MT_ROSKILL[1] - 100, MT_ROSKILL[0] + 100, MT_ROSKILL[1] + 100);
    expect(files.length).toBe(1);
    // fly 30 km away: they're dropped, the coverage is clear (the procedural suburbs come back)
    let gone = 0;
    s.listeners.push((_t, loaded) => {
      if (!loaded) gone++;
    });
    s.update(MT_ROSKILL[0] + 30_000, MT_ROSKILL[1] - 30_000);
    expect(gone).toBeGreaterThan(4);
    expect(s.covers(MT_ROSKILL[0], MT_ROSKILL[1])).toBe(false);
  });

  it('keeps the procedural suburbs where a tile fails to load (offline), and asks again later', async () => {
    let calls = 0;
    const s = new CorridorHouses(M, () => {
      calls++;
      return Promise.reject(new Error('offline'));
    }, { fetchRadius: 1000, keepRadius: 8000, retryMs: 50, maxInFlight: 100 });
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      s.update(MT_ROSKILL[0], MT_ROSKILL[1], 0);
      await settle();
      await settle();
      expect(s.stats.loaded).toBe(0);
      expect(s.stats.failed).toBeGreaterThan(0);
      expect(s.covers(MT_ROSKILL[0], MT_ROSKILL[1])).toBe(false);
      const first = calls;
      s.update(MT_ROSKILL[0], MT_ROSKILL[1], 10); // too soon
      expect(calls).toBe(first);
      s.update(MT_ROSKILL[0], MT_ROSKILL[1], Date.now() + 1000);
      expect(calls).toBeGreaterThan(first);
    } finally {
      console.warn = warn;
    }
  });

  it('streams ≈ 20–40 tiles a minute at 500 kt from Whenuapai to the airport (medium tier), a few hundred kB a minute', () => {
    // the flight line at 257 m/s (500 kt); the tiles are installed as soon as they are asked for
    const R = 2400;
    const reqs: [number, number][] = [];
    const s = new CorridorHouses(M, (i, j) => {
      reqs.push([i, j]);
      return new Promise(() => undefined);
    }, { fetchRadius: R + FETCH_AHEAD, keepRadius: R + KEEP_PAST, maxInFlight: 1000 });
    const L = Math.hypot(AIRPORT[0] - WHENUAPAI[0], AIRPORT[1] - WHENUAPAI[1]);
    const secs = L / 257;
    for (let t = 0; t <= secs; t += 0.5) {
      const f = Math.min(1, t / secs);
      s.update(WHENUAPAI[0] + (AIRPORT[0] - WHENUAPAI[0]) * f, WHENUAPAI[1] + (AIRPORT[1] - WHENUAPAI[1]) * f);
    }
    const bytes = reqs.reduce((a, [i, j]) => a + M.tiles.find((t) => t[0] === i && t[1] === j)![3], 0);
    const perMin = (reqs.length / secs) * 60;
    console.log(`corridor flight ${(L / 1000).toFixed(1)} km in ${secs.toFixed(0)} s: ${reqs.length} tiles (${perMin.toFixed(1)} a minute), ${(bytes / 1024).toFixed(0)} KiB (${((bytes / secs) * 60 / 1024).toFixed(0)} KiB a minute)`);
    expect(perMin).toBeGreaterThan(10);
    expect(perMin).toBeLessThan(60);
    expect((bytes / secs) * 60).toBeLessThan(2_000_000);
  });
});

describe('the scatters under a loaded tile', () => {
  const SEED = 1840;
  const features = allFeatures('auckland', []);
  const hf = runSync(generateTerrain({ theater: 'auckland', seed: SEED, resolution: 1024, features, pads: [] }));
  const m = 512;
  const color = new Uint8Array(m * m * 4);
  bakeColorRows(reduceView(hf, m), { theater: 'auckland', seed: SEED, features }, m, 0, m, color);
  const cmap = new ColorMapSampler(color, m, hf.origin, hf.extent);
  const ground = (x: number, z: number) => hf.meshHeightAt(x, z);
  const count = (out: TileInstances) => {
    let real = 0;
    let proc = 0;
    for (const kind of [HOUSE, APARTMENT, SHED])
      for (let i = 0; i < (out.data[kind]?.length ?? 0); i += REC) {
        if (out.data[kind][i + 11] > 0) real++;
        else proc++;
      }
    return { real, proc };
  };

  it('procedural houses offline; the real ones, and no procedural lot, once the tile is in', async () => {
    const s = diskStream(2400);
    const src = new HouseSource(hf, cmap, ground, AKL_CBD_GRID, null, null, null, null, null, null, s);
    const run = () => {
      const out: TileInstances = { data: [[], [], []] };
      src.generate(HENDERSON[0] - 300, HENDERSON[1] - 300, 600, out);
      return count(out);
    };
    // offline (no tile yet): the procedural suburb
    const before = run();
    expect(before.real).toBe(0);
    expect(before.proc).toBeGreaterThan(80);
    await loadAround(s, HENDERSON[0], HENDERSON[1]);
    const after = run();
    expect(after.proc).toBe(0);
    // every loaded house in the square, none twice (a house is its tile's)
    let want = 0;
    for (const h of s.filesIn(HENDERSON[0] - 300, HENDERSON[1] - 300, HENDERSON[0] + 300, HENDERSON[1] + 300)) want += housesIn(h, HENDERSON[0] - 300, HENDERSON[1] - 300, HENDERSON[0] + 300, HENDERSON[1] + 300).length;
    expect(after.real).toBe(want);
    expect(after.real).toBeGreaterThan(100);
    // the trees keep off the real houses where they're the truth (the low tier's garden trees: no canopy grid)
    const veg = createVegetation('auckland', SEED, features);
    const trees = new TreeSource(hf, cmap, veg, 'auckland', SEED, 14, (x, z, mm) => s.near(x, z, mm), AKL_CBD_GRID, null, null, null, null, null, s);
    const tout: TileInstances = { data: [[], [], []] };
    trees.generate(HENDERSON[0] - 300, HENDERSON[1] - 300, 600, tout);
    const files = s.filesIn(HENDERSON[0] - 320, HENDERSON[1] - 320, HENDERSON[0] + 320, HENDERSON[1] + 320);
    let inside = 0;
    let n = 0;
    for (const arr of tout.data)
      for (let i = 0; i < arr.length; i += REC) {
        n++;
        const x = arr[i], z = arr[i + 2];
        for (const h of files) {
          const k = nearestHouse(h, x, z, 30);
          if (k < 0) continue;
          const dx = x - h.x[k], dz = z - h.z[k];
          const c = Math.cos(h.dir[k]), sn = Math.sin(h.dir[k]);
          if (Math.abs(dx * c + dz * sn) < h.d[k] / 2 && Math.abs(-dx * sn + dz * c) < h.w[k] / 2) inside++;
        }
        expect(s.near(x, z, 2)).toBe(false);
      }
    expect(n).toBeGreaterThan(20);
    expect(inside).toBe(0);
  });

  it('the medium tier draws the real houses as far out as the high tier over a dense suburb (playtest r1 R11-1)', async () => {
    // Mt Eden from 520 m, looking south (the reviewer's view): past where the house scatter's capacity runs out the
    // ground is the lots' mosaic, which read as green farmland from ≈ 0.9 km on (medium's 3,600 houses)
    const cam = new Vector3(-680, 520, 1300);
    const agl = cam.y - ground(cam.x, cam.z);
    const geo = new BoxGeometry();
    const mat = new MeshBasicMaterial();
    const reach = async (cfg: { houseRadius: number; houseMax: number }) => {
      const s = diskStream(cfg.houseRadius);
      await loadAround(s, cam.x, cam.z);
      const src = new HouseSource(hf, cmap, ground, AKL_CBD_GRID, null, null, null, null, null, null, s);
      const sc = new TileScatter(
        src,
        [
          { geometry: geo, material: mat, capacity: cfg.houseMax, kind: HOUSE },
          { geometry: geo, material: mat, capacity: Math.round(cfg.houseMax / 5), kind: APARTMENT },
        ],
        300,
        cfg.houseRadius,
        10_000,
      );
      sc.update(cam, agl);
      return sc.reach[0];
    };
    const medium = await reach(worldConfig(QUALITY_PRESETS.medium));
    const high = await reach(worldConfig(QUALITY_PRESETS.high));
    expect(medium).toBeGreaterThan(1250); // 3,600 houses: 918 m; 6,000: 1,373 m
    expect(medium).toBeGreaterThan(high * 0.9); // high: 1,451 m
  });

  it('a scatter regenerates the tiles a stream tile changed, drawing the old ones until then', () => {
    let gen = 0;
    const src: ScatterSource = {
      kinds: 1,
      generate(x0, z0, _size, out) {
        gen++;
        out.data[0].push(x0 + 1, 0, z0 + 1, 0, 1, 1, 1, 1, 1, 1, 0, gen);
      },
    };
    const sc = new TileScatter(src, [{ geometry: new BoxGeometry(), material: new MeshBasicMaterial(), capacity: 100, kind: 0 }], 300, 600, 100);
    const cam = new Vector3(0, 0, 0);
    sc.update(cam);
    const n = gen;
    const drawn = sc.instanceCount;
    expect(drawn).toBeGreaterThan(4);
    sc.invalidate(-300, -300, 0, 0);
    // of the tiles round the origin's corner only (-1, -1) is regenerated; the others are kept
    sc.update(cam);
    expect(gen).toBe(n + 1);
    expect(sc.instanceCount).toBe(drawn);
  });

  it("reports how far a scatter's instances reach when its capacity runs out (the terrain's ground fades there)", () => {
    const src: ScatterSource = {
      kinds: 1,
      generate(x0, z0, _size, out) {
        for (let k = 0; k < 10; k++) out.data[0].push(x0 + k, 0, z0 + 1, 0, 1, 1, 1, 1, 1, 1, 0, 0);
      },
    };
    const geo = new BoxGeometry();
    const mat = new MeshBasicMaterial();
    const roomy = new TileScatter(src, [{ geometry: geo, material: mat, capacity: 10_000, kind: 0 }], 300, 1500, 1000);
    roomy.update(new Vector3());
    expect(roomy.reach[0]).toBe(Number.POSITIVE_INFINITY);
    const tight = new TileScatter(src, [{ geometry: geo, material: mat, capacity: 95, kind: 0 }], 300, 1500, 1000);
    tight.update(new Vector3());
    expect(tight.instanceCount).toBe(95);
    // ten tiles' worth fit: the nearest ten tiles lie within ≈ 450 m of the camera
    expect(tight.reach[0]).toBeGreaterThan(0);
    expect(tight.reach[0]).toBeLessThan(600);
  });
});

describe('the service worker', () => {
  it('never precaches the corridor tiles and caches them in their own cache', () => {
    const helpers = new Function('self', `${sw.slice(0, sw.indexOf("self.addEventListener('install'"))}; return { referencedAssets, ON_DEMAND, TILE };`)({
      registration: { scope: 'https://example.com/f35/' },
    }) as { referencedAssets: (code: string, url: string) => string[]; ON_DEMAND: RegExp; TILE: RegExp };
    const name = 'assets/akl-corridor--3_4-AbC12_x.bin';
    expect(helpers.ON_DEMAND.test(`/f35/${name}`)).toBe(true);
    expect(helpers.TILE.test(`/f35/${name}`)).toBe(true);
    expect(helpers.TILE.test('/f35/assets/auckland-houses-AbC12.bin')).toBe(false);
    const code = `const a="${name}",b="assets/auckland-houses-AbC12.bin";`;
    const refs = helpers.referencedAssets(code, 'https://example.com/f35/assets/index-x.js');
    expect(refs.some((u) => u.includes('akl-corridor'))).toBe(false);
    expect(refs.some((u) => u.includes('auckland-houses'))).toBe(true);
    expect(sw).toMatch(/keep = new Set\(\[PRECACHE, RUNTIME, TILES\]\)/);
  });
});
