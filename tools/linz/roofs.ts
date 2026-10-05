/**
 * #140: register the aerial photo on the CBD buildings' roofs, one offset per building, in
 * src/world/terrain/data/auckland-buildings.bin (format version 2: aucklandBuildings.ts).
 *
 *   npx vite-node tools/linz/roofs.ts dump <work>    # the file's buildings → <work>/roofs-in.json
 *   python3 tools/linz/roofs.py <work>               # offsets on the game's 4096² photo → <work>/roofs.json
 *   npx vite-node tools/linz/roofs.ts bake <work>    # rewrites auckland-buildings.bin with them
 *
 * Only the offsets change: every building, prism and vertex keeps its bytes (decode → set `roof` → encode), so it
 * runs after any re-bake of the buildings (buildings.ts writes them without offsets) without the LiDAR or the WFS.
 * `dump` marks the buildings the game draws from the file: the CBD tower kit, the Scene apartments and the hero
 * neighbourhoods replace some (applyHeroBuildings, applyNeighbourhoods), and those keep their own roofs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { applyHeroBuildings, applyNeighbourhoods, decodeBuildings, encodeBuildings, type Building } from '../../src/world/scenery/aucklandBuildings';
import { decodeNeighbourhoods } from '../../src/world/scenery/aucklandNeighbourhoods';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const MODE = process.argv[2];
const WORK = process.argv[3] ?? path.join(os.tmpdir(), 'f35-linz-roofs');
const FILE = path.join(HERE, '../../src/world/terrain/data/auckland-buildings.bin');
const NB = path.join(HERE, '../../src/world/scenery/data/auckland-neighbourhoods.bin');
fs.mkdirSync(WORK, { recursive: true });

const gunzip = (f: string) => new Uint8Array(zlib.gunzipSync(fs.readFileSync(f)));
const list: Building[] = decodeBuildings(gunzip(FILE));

if (MODE === 'dump') {
  const drawn = new Set(applyNeighbourhoods(applyHeroBuildings(list), decodeNeighbourhoods(gunzip(NB))));
  const out = list.map((b, i) => ({
    i,
    drawn: drawn.has(b),
    lidar: b.lidar,
    prisms: b.prisms.map((p) => ({ h: p.h, sx: p.sx, sz: p.sz, ring: Array.from(p.ring, (v) => Math.round(v * 100) / 100) })),
  }));
  fs.writeFileSync(path.join(WORK, 'roofs-in.json'), JSON.stringify(out));
  console.log(`${list.length} buildings, ${out.filter((b) => b.drawn).length} drawn from the file → ${path.join(WORK, 'roofs-in.json')}`);
} else if (MODE === 'bake') {
  const res = JSON.parse(fs.readFileSync(path.join(WORK, 'roofs.json'), 'utf8')) as { i: number; dx: number; dz: number; measured: boolean }[];
  for (const b of list) delete b.roof;
  for (const r of res) list[r.i].roof = { dx: r.dx, dz: r.dz, measured: r.measured };
  const before = fs.statSync(FILE).size;
  const raw = encodeBuildings(list);
  const gz = zlib.gzipSync(raw, { level: 9 });
  fs.writeFileSync(FILE, gz);
  const n = list.filter((b) => b.roof).length;
  const m = list.filter((b) => b.roof?.measured).length;
  console.log(`photo roofs on ${n} buildings (${m} registered by correlation, ${n - m} from the lean field); wrote ${FILE}: ${raw.length} bytes raw, ${gz.length} bytes gzip (${gz.length - before >= 0 ? '+' : ''}${gz.length - before})`);
} else {
  console.error('usage: roofs.ts dump|bake <work>');
  process.exit(1);
}
