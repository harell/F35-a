/**
 * Real suburbs 7/9 (#126), step 2: bake the corridor's real houses (corridor-houses.py output) and its LINZ local roads
 * into streamed tiles, src/world/terrain/data/corridor/akl-corridor-<i>_<j>.bin (gzip, CORRIDOR_TILE m squares; decoded by
 * src/world/scenery/corridorHouses.ts), their manifest corridor.json and the spot checks
 * tests/fixtures/corridor-house-spotchecks.json.
 *
 *   python3 tools/linz/corridor-houses.py <work dir>                  # outlines + LiDAR roofs + photo colours
 *   LINZ_API_KEY=… npx vite-node tools/linz/corridor-houses.ts <work dir>
 *
 * An added area (#274: corridor-houses.py AREAS, e.g. AREA=east) is baked into the shipped tiles instead of over them:
 * its tiles join the manifest, a tile it shares with the corridor (or an area added before) keeps its houses, roads and
 * coverage and gains the area's, and its spot checks join the fixture's. Its roofs already use the shipped palette. The
 * corridor's own bake starts the tiles over, so the added areas (the manifest's `areas`) are baked again after it.
 *
 * Houses: reprojected with the game's geoToWorld; dropped in the water of the game's LINZ coastline, in the CBD region
 * (the LINZ buildings stand there: aucklandBuildings.ts), on #121's coverage (Devonport's own file), on the landmark
 * and hero sites (siteRings, siteBlocker: #124's hospitals, malls, stations and schools, the hero neighbourhoods, the
 * stadiums, the port, the oil terminal) and on the OSM aerodromes (the airfields' own hangars and terminals). An
 * outline too big for a record (over RECORD_MAX m a side) is cut into equal flat pieces along its rectangle.
 *
 * Coverage (32 m cells): the corridor's land outside the CBD region and #121's coverage. Under it the real houses are
 * the truth (corridorHouses.ts).
 *
 * Roads (#127 phase B, as islandRoads.ts does phase A): every LINZ road section (NZ Addresses: Road Sections, layer
 * 123109) on the coverage, not a footpath, a motorway or a placeholder, not along a ribbon already baked (the
 * motorways, the arterials, the hero neighbourhoods' streets) and outside the hero neighbourhoods' footprints: a sealed
 * local road ribbon (9 m kerb to kerb, lanes and places 6 m: islandRoads.ts localWidth), cut at the tiles' edges.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { geoToWorld, worldToGeo } from '../../src/core/auckland';
import { encodeHouses, HOUSE_BYTES, setAucklandHouses, aucklandHouses, housesCover, type HouseRecord } from '../../src/world/scenery/aucklandHouses';
import { decodeRoads, encodeRoads, ROAD_LOCAL, ROAD_RAIL, setAucklandRoads, type RoadLine } from '../../src/world/scenery/aucklandRoads';
import { setAucklandNeighbourhoods, aucklandNeighbourhoods } from '../../src/world/scenery/aucklandNeighbourhoods';
import { landmarkCovers, setAucklandLandmarks } from '../../src/world/scenery/aucklandLandmarks';
import { setAucklandOsm, aucklandOsm, OSM_AERODROME } from '../../src/world/scenery/aucklandOsm';
import { setAucklandDomain } from '../../src/world/scenery/aucklandDomain';
import { setTamakiDrive } from '../../src/world/scenery/tamakiDriveData';
import { siteBlocker, siteRings } from '../../src/world/scenery/aucklandSites';
import { CORRIDOR_CELL, CORRIDOR_TILE, CORRIDOR_VERSION, decodeCorridorTile, encodeCorridorTile, tileName, type CorridorManifest } from '../../src/world/scenery/corridorHouses';
import { decodeLinz, linzIsLand } from '../../src/world/terrain/theaters/aucklandLinz';
import { localWidth } from './islandRoads';
import { chain, densify, fetchWfs, lines, runs, segDist, simplify, type Feature, type Pt } from './polyline';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HERE, '../..');
const WORK = process.argv[2] ?? '/home/user/work/corridor';
const OUT = path.join(ROOT, 'src/world/terrain/data/corridor');
const FIXTURE = path.join(ROOT, 'tests/fixtures/corridor-house-spotchecks.json');
/** Longest side (m) a record holds (0.25 m steps in a byte: 63.75 m); bigger outlines are cut into pieces. */
const RECORD_MAX = 63;
const SPOTS = 40;

const gz = (f: string) => new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, f))));
const linz = decodeLinz(gz('src/world/terrain/data/auckland-linz.bin'));
const roadsBytes = gz('src/world/terrain/data/auckland-roads.bin');
setAucklandRoads(roadsBytes);
const roadData = decodeRoads(roadsBytes);
setAucklandHouses(gz('src/world/terrain/data/auckland-houses.bin'));
setAucklandNeighbourhoods(gz('src/world/scenery/data/auckland-neighbourhoods.bin'));
setAucklandLandmarks(gz('src/world/terrain/data/auckland-landmarks.bin'));
setAucklandOsm(gz('src/world/scenery/data/auckland-osm.bin'));
setAucklandDomain(gz('src/world/scenery/data/auckland-domain.bin'));
setTamakiDrive(gz('src/world/scenery/data/tamaki-drive.bin'));
const h121 = aucklandHouses()!;

interface InHouse {
  id: number;
  src: 'outline' | 'lidar';
  lon: number;
  lat: number;
  lon2: number;
  lat2: number;
  w: number;
  d: number;
  eave: number;
  rise: number;
  roof: string;
  c: number;
  m2: number;
}
const input = JSON.parse(fs.readFileSync(path.join(WORK, 'corridor-houses.json'), 'utf8')) as {
  area?: string;
  palette: number[][];
  houses: InHouse[];
  tally: Record<string, number>;
  corridor: number[][][];
};

// ── Point-in-polygon over many rings, bucketed ──
type Ring = { r: ArrayLike<number>; b: [number, number, number, number] };
function ringIndex(rings: ArrayLike<number>[], cell = 256) {
  const grid = new Map<string, Ring[]>();
  for (const r of rings) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < r.length; i += 2) {
      x0 = Math.min(x0, r[i]);
      x1 = Math.max(x1, r[i]);
      z0 = Math.min(z0, r[i + 1]);
      z1 = Math.max(z1, r[i + 1]);
    }
    const e: Ring = { r, b: [x0, z0, x1, z1] };
    for (let j = Math.floor(z0 / cell); j <= Math.floor(z1 / cell); j++)
      for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) {
        const k = `${i},${j}`;
        const l = grid.get(k);
        if (l) l.push(e);
        else grid.set(k, [e]);
      }
  }
  const inside = (r: ArrayLike<number>, x: number, z: number) => {
    let ins = false;
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = r[i * 2], zi = r[i * 2 + 1], xj = r[j * 2], zj = r[j * 2 + 1];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) ins = !ins;
    }
    return ins;
  };
  return (x: number, z: number) => (grid.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) ?? []).some((e) => x >= e.b[0] && x <= e.b[2] && z >= e.b[1] && z <= e.b[3] && inside(e.r, x, z));
}

const ringOf = (ll: number[][]) => Float32Array.from(ll.flatMap(([lon, lat]) => {
  const p = geoToWorld(lat, lon);
  return [p.x, p.z];
}));
const corridorRings = input.corridor.map(ringOf);
const inCorridor = ringIndex(corridorRings, 1024);
const inRegion = ringIndex([roadData.region], 512);
const nbs = aucklandNeighbourhoods() ?? [];
const inNeighbourhood = ringIndex(nbs.map((n) => n.footprint));
const onSiteRing = ringIndex(siteRings());
const blocker = siteBlocker();
const aerodromes = (aucklandOsm()?.features ?? []).filter((f) => f.layer === OSM_AERODROME && f.area).map((f) => f.pts);
const onAerodrome = ringIndex(aerodromes, 512);
const isLand = (x: number, z: number) => linzIsLand(linz, x, z);

/** Where the corridor's real houses are the truth (the coverage). */
const coverAt = (x: number, z: number) => inCorridor(x, z) && isLand(x, z) && !inRegion(x, z) && !housesCover(h121, x, z);

// ── Houses ──
const palette = input.palette.map(([r, g, b]) => (r << 16) | (g << 8) | b);
/** An area added to the shipped tiles (#274), not the corridor's whole bake. */
const ADD = (input.area ?? 'corridor') !== 'corridor';
const shipped: CorridorManifest | null = ADD ? JSON.parse(fs.readFileSync(path.join(OUT, 'corridor.json'), 'utf8')) : null;
if (shipped && JSON.stringify(shipped.palette) !== JSON.stringify(palette)) throw new Error(`${input.area}: its palette is not the shipped corridor.json's`);
// (twice would add its houses to the shared tiles twice: re-bake from the tiles as they were before it)
if (shipped?.areas?.includes(input.area!)) throw new Error(`${input.area} is already in the tiles: git checkout ${path.relative(ROOT, OUT)} first`);
const T = CORRIDOR_TILE;
const tkey = (i: number, j: number) => `${i}_${j}`;
const byTile = new Map<string, HouseRecord[]>();
const drop: Record<string, number> = { water: 0, region: 0, devonport: 0, site: 0, aerodrome: 0, uncovered: 0 };
let pieces = 0;
const kept: { h: InHouse; x: number; z: number }[] = [];
for (const h of input.houses) {
  const p = geoToWorld(h.lat, h.lon);
  const q = geoToWorld(h.lat2, h.lon2);
  const { x, z } = p;
  if (!isLand(x, z)) drop.water++;
  else if (inRegion(x, z)) drop.region++;
  else if (housesCover(h121, x, z)) drop.devonport++;
  else if (onSiteRing(x, z) || blocker(x, z, 0)) drop.site++;
  else if (onAerodrome(x, z)) drop.aerodrome++;
  else if (!inCorridor(x, z)) drop.uncovered++;
  else {
    const dir = Math.atan2(q.z - z, q.x - x);
    const nd = Math.max(1, Math.ceil(h.d / RECORD_MAX));
    const nw = Math.max(1, Math.ceil(h.w / RECORD_MAX));
    const ux = Math.cos(dir), uz = Math.sin(dir);
    let added = 0;
    for (let a = 0; a < nd; a++)
      for (let b = 0; b < nw; b++) {
        const oa = (a - (nd - 1) / 2) * (h.d / nd);
        const ob = (b - (nw - 1) / 2) * (h.w / nw);
        const px = x + ux * oa - uz * ob;
        const pz = z + uz * oa + ux * ob;
        const split = nd * nw > 1;
        // (a piece, or a house, reaching into a landmark building of #124 is that building: left to it)
        const hd = h.d / nd / 2, hw = h.w / nw / 2;
        if ([[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]].some(([sa, sb]) => landmarkCovers(px + ux * hd * sa - uz * hw * sb, pz + uz * hd * sa + ux * hw * sb, 0))) {
          drop.landmark = (drop.landmark ?? 0) + 1;
          continue;
        }
        if (split) pieces++;
        const r: HouseRecord = { x: px, z: pz, w: h.w / nw, d: h.d / nd, dir, eave: h.eave, rise: split ? 0 : h.rise, c: h.c };
        const k = tkey(Math.floor(px / T), Math.floor(pz / T));
        const l = byTile.get(k);
        if (l) l.push(r);
        else byTile.set(k, [r]);
        added++;
      }
    if (h.src === 'outline' && added === nd * nw) kept.push({ h, x, z });
  }
}
console.log(`houses in: ${input.houses.length}; dropped ${JSON.stringify(drop)}; ${pieces} pieces of ${input.houses.filter((h) => h.w > RECORD_MAX || h.d > RECORD_MAX).length} big outlines`);

// ── Roads (#127 phase B) ──
let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
for (const r of corridorRings)
  for (let i = 0; i < r.length; i += 2) {
    bx0 = Math.min(bx0, r[i]);
    bx1 = Math.max(bx1, r[i]);
    bz0 = Math.min(bz0, r[i + 1]);
    bz1 = Math.max(bz1, r[i + 1]);
  }
const SKIP = new Set(['Accessway', 'Steps', 'Walk', 'Track', 'Te Ara', 'Arcade', 'Motorway', 'State Highway']);
const PLACE_NAME = /(Island|Inlet|Bay|Beach)$/;
const BOX = 4000;
const seen = new Set<number>();
const secs: Feature[] = [];
for (let z = Math.floor(bz0 / BOX) * BOX; z < bz1; z += BOX)
  for (let x = Math.floor(bx0 / BOX) * BOX; x < bx1; x += BOX) {
    let any = false;
    for (let k = 0; k <= 16 && !any; k++) any = inCorridor(x + (k % 4) * (BOX / 3), z + Math.floor(k / 4) * (BOX / 3));
    if (!any) continue;
    const lo = worldToGeo(x - 50, z + BOX + 50);
    const hi = worldToGeo(x + BOX + 50, z - 50);
    for (const f of fetchWfs(WORK, `roads-${x}_${z}.json`, 'layer-123109', `BBOX(shape,${lo.lat},${lo.lon},${hi.lat},${hi.lon})`)) {
      const id = Number(f.properties.road_section_id);
      if (seen.has(id)) continue;
      seen.add(id);
      secs.push(f);
    }
  }
// the ribbons already baked (motorways, arterials, the neighbourhoods' streets), hashed on a 100 m grid
const G = 100;
const ribbons: [Pt, Pt][] = [];
const rgrid = new Map<string, number[]>();
for (const l of roadData.lines) {
  if (l.kind === ROAD_RAIL) continue;
  for (let i = 0; i + 3 < l.pts.length; i += 2) {
    const a: Pt = [l.pts[i], l.pts[i + 1]];
    const b: Pt = [l.pts[i + 2], l.pts[i + 3]];
    if (Math.max(a[0], b[0]) < bx0 - 100 || Math.min(a[0], b[0]) > bx1 + 100 || Math.max(a[1], b[1]) < bz0 - 100 || Math.min(a[1], b[1]) > bz1 + 100) continue;
    const k = ribbons.push([a, b]) - 1;
    for (let gi = Math.floor((Math.min(a[0], b[0]) - 15) / G); gi <= Math.floor((Math.max(a[0], b[0]) + 15) / G); gi++)
      for (let gj = Math.floor((Math.min(a[1], b[1]) - 15) / G); gj <= Math.floor((Math.max(a[1], b[1]) + 15) / G); gj++) {
        const key = `${gi},${gj}`;
        const l2 = rgrid.get(key);
        if (l2) l2.push(k);
        else rgrid.set(key, [k]);
      }
  }
}
const onRibbon = (p: Pt) => (rgrid.get(`${Math.floor(p[0] / G)},${Math.floor(p[1] / G)}`) ?? []).some((k) => segDist(p[0], p[1], ribbons[k][0], ribbons[k][1]) < 12);
const groups: { group: string; pts: Pt[] }[] = [];
let skipped = 0;
for (const f of secs) {
  const pr = f.properties;
  const type = (pr.road_name_type as string | null) ?? null;
  const name = String(pr.full_road_name ?? '');
  if ((type && SKIP.has(type)) || /Motorway|State Highway|Boardwalk|Marina/.test(name) || (!type && PLACE_NAME.test(name))) {
    skipped++;
    continue;
  }
  const w = localWidth({ island: false, name, type, unsealed: false, lanes: 2 });
  for (const pl of lines(f)) if (pl.some((q) => inCorridor(q[0], q[1]))) groups.push({ group: `${name}|${w}`, pts: pl });
}
const roadsByTile = new Map<string, RoadLine[]>();
let roadKm = 0;
let roadN = 0;
for (const c of chain(groups)) {
  const w = Number(c.group.split('|')[1]);
  const pts = densify(c.pts, 4);
  const flag = (q: Pt) => (coverAt(q[0], q[1]) && !inNeighbourhood(q[0], q[1]) ? (Math.floor(q[0] / T) + 512) * 1024 + (Math.floor(q[1] / T) + 512) : -1);
  for (const r of runs(pts, flag)) {
    if (r.pts.filter(onRibbon).length > r.pts.length / 2) continue;
    let len = 0;
    for (let i = 1; i < r.pts.length; i++) len += Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1]);
    if (len < 8) continue; // a corner clipped by a tile's edge or the coverage
    const s = simplify(r.pts, 0.8);
    if (s.length < 2) continue;
    const ti = Math.floor(r.flag / 1024) - 512;
    const tj = (r.flag % 1024) - 512;
    const k = tkey(ti, tj);
    const line: RoadLine = { name: '', kind: ROAD_LOCAL, width: w, tunnel: false, unsealed: false, pts: Float32Array.from(s.flat()) };
    const l = roadsByTile.get(k);
    if (l) l.push(line);
    else roadsByTile.set(k, [line]);
    roadKm += len / 1000;
    roadN++;
  }
}
console.log(`roads: ${secs.length} LINZ sections (${skipped} footpaths, motorways and placeholders skipped) → ${roadN} ribbon pieces, ${roadKm.toFixed(0)} km`);

// ── Tiles ──
fs.mkdirSync(OUT, { recursive: true });
if (!ADD) {
  // the corridor's whole bake starts over: the areas added since must be baked again after it, in order
  const was = fs.existsSync(path.join(OUT, 'corridor.json')) ? (JSON.parse(fs.readFileSync(path.join(OUT, 'corridor.json'), 'utf8')) as CorridorManifest).areas : undefined;
  if (was?.length) console.warn(`the added areas ${was.join(', ')} are dropped: bake them again (AREA=<area> corridor-houses.py, then this)`);
  for (const f of fs.readdirSync(OUT)) if (f.endsWith('.bin')) fs.unlinkSync(path.join(OUT, f));
}
const N = T / CORRIDOR_CELL;
const tiles: CorridorManifest['tiles'] = [];
// an added area: the shipped tiles it shares, decoded back to records (lossless: each value re-encodes to its byte)
const paletteIndex = new Map(palette.map((c, k) => [c, k] as const).reverse());
const shippedTiles = new Map((shipped?.tiles ?? []).map((t) => [tkey(t[0], t[1]), t] as const));
const merged = new Map<string, { recs: HouseRecord[]; bits: Uint8Array; roads: RoadLine[] }>();
for (const k of byTile.keys()) {
  if (!shippedTiles.has(k)) continue;
  const [i, j] = k.split('_').map(Number);
  const old = decodeCorridorTile(new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(OUT, tileName(i, j))))), palette);
  const h = old.houses;
  if (h.cover.x0 !== i * T || h.cover.z0 !== j * T || h.cover.cols !== N || h.cover.rows !== N) throw new Error(`tile ${k}: unexpected coverage grid`);
  const recs: HouseRecord[] = [];
  for (let n = 0; n < h.count; n++) {
    const c = paletteIndex.get(h.color[n]);
    if (c === undefined) throw new Error(`tile ${k}: a roof colour off the palette`);
    recs.push({ x: h.x[n], z: h.z[n], w: h.w[n], d: h.d[n], dir: h.dir[n], eave: h.eave[n], rise: h.rise[n], c });
  }
  merged.set(k, { recs, bits: h.cover.bits, roads: old.roads });
}
let tx0 = Infinity, tz0 = Infinity, tx1 = -Infinity, tz1 = -Infinity;
let total = 0, totalRaw = 0, housesTotal = 0, roadBytes = 0, coverBytes = 0, nHouses = 0;
const sizes: number[] = [];
const keys = [...new Set([...byTile.keys()])].sort();
for (const k of keys) {
  const [i, j] = k.split('_').map(Number);
  const old = merged.get(k);
  const recs = [...(old?.recs ?? []), ...byTile.get(k)!];
  const bits = old ? Uint8Array.from(old.bits) : new Uint8Array(N * N);
  for (let b = 0; b < N; b++)
    for (let a = 0; a < N; a++) if (coverAt(i * T + (a + 0.5) * CORRIDOR_CELL, j * T + (b + 0.5) * CORRIDOR_CELL)) bits[b * N + a] = 1;
  const cover = { x0: i * T, z0: j * T, cell: CORRIDOR_CELL, cols: N, rows: N, bits };
  const hb = encodeHouses(recs, [], cover);
  const rl = [...(old?.roads ?? []), ...(roadsByTile.get(k) ?? [])];
  const rb = rl.length ? encodeRoads({ region: new Float32Array(0), lines: rl }, 0.5) : new Uint8Array(0);
  const raw = encodeCorridorTile(hb, rb);
  decodeCorridorTile(raw, palette); // (round trip)
  const z = zlib.gzipSync(raw, { level: 9 });
  fs.writeFileSync(path.join(OUT, tileName(i, j)), z);
  tiles.push([i, j, recs.length, z.length]);
  sizes.push(z.length);
  total += z.length;
  totalRaw += raw.length;
  nHouses += recs.length;
  housesTotal += zlib.gzipSync(encodeHouses(recs, [], { x0: 0, z0: 0, cell: 1, cols: 0, rows: 0, bits: new Uint8Array(0) }), { level: 9 }).length;
  roadBytes += rb.length ? zlib.gzipSync(rb, { level: 9 }).length : 0;
  coverBytes += hb.length - (recs.length * HOUSE_BYTES);
  tx0 = Math.min(tx0, i * T);
  tz0 = Math.min(tz0, j * T);
  tx1 = Math.max(tx1, (i + 1) * T);
  tz1 = Math.max(tz1, (j + 1) * T);
}
const written = tiles.length;
// an added area: the shipped tiles it does not touch stay as they are
for (const t of shippedTiles.values()) {
  if (byTile.has(tkey(t[0], t[1]))) continue;
  tiles.push(t);
  tx0 = Math.min(tx0, t[0] * T);
  tz0 = Math.min(tz0, t[1] * T);
  tx1 = Math.max(tx1, (t[0] + 1) * T);
  tz1 = Math.max(tz1, (t[1] + 1) * T);
}
tiles.sort((a, b) => (tkey(a[0], a[1]) < tkey(b[0], b[1]) ? -1 : 1));
const areas = ADD ? [...(shipped!.areas ?? []), input.area!] : undefined;
const manifest: CorridorManifest = { version: CORRIDOR_VERSION, tile: T, cell: CORRIDOR_CELL, palette, bounds: [tx0, tz0, tx1, tz1], tiles, ...(areas ? { areas } : {}) };
fs.writeFileSync(path.join(OUT, 'corridor.json'), JSON.stringify(manifest) + '\n');
if (ADD) console.log(`${input.area}: ${written} tiles written (${written - merged.size} new, ${merged.size} shared with the shipped ones); the manifest now ${tiles.length} tiles, ${tiles.reduce((n, t) => n + t[2], 0)} houses, ${tiles.reduce((n, t) => n + t[3], 0)} B gzip`);

// spot checks: random outlines, their centroid (the bake keeps the houses where LINZ traced them); an added area's join
// the shipped ones
let seed = ADD ? 274 : 126;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
type Spot = { id: number; x: number; z: number; w: number; d: number; eave: number };
const spots: Spot[] = ADD ? (JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Spot[]) : [];
const want = spots.length + (ADD ? SPOTS / 2 : SPOTS);
const pool = kept.filter(({ h }) => h.m2 >= 60 && h.m2 <= 400);
while (spots.length < want && pool.length) {
  const k = Math.floor(rnd() * pool.length);
  const { h, x, z } = pool.splice(k, 1)[0];
  spots.push({ id: h.id, x: +x.toFixed(2), z: +z.toFixed(2), w: h.w, d: h.d, eave: h.eave });
}
fs.writeFileSync(FIXTURE, JSON.stringify(spots, null, 1) + '\n');

sizes.sort((a, b) => a - b);
const hash = crypto.createHash('sha1').update(JSON.stringify(manifest)).digest('hex').slice(0, 8);
console.log(`tiles: ${written} of ${T} m written (manifest ${hash}); houses ${nHouses}; gzip ${total} B (${(total / nHouses).toFixed(2)} B a house; raw ${totalRaw} B)`);
console.log(`  houses alone ${housesTotal} B gzip (${(housesTotal / nHouses).toFixed(2)} B a house), roads ${roadBytes} B gzip, coverage + cell tables ≈ ${coverBytes} B raw`);
console.log(`  bytes a tile: min ${sizes[0]}, median ${sizes[sizes.length >> 1]}, p90 ${sizes[Math.floor(sizes.length * 0.9)]}, max ${sizes[sizes.length - 1]}`);
console.log(`wrote ${path.relative(ROOT, OUT)}/ (${tiles.length} tiles + corridor.json) and ${path.relative(ROOT, FIXTURE)} (${spots.length} spot checks)`);
