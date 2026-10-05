/**
 * #141: bake the OpenStreetMap facade tags (tools/linz/facades.py → <work>/facades.json) into
 * src/world/terrain/data/auckland-buildings.bin (format v3: aucklandBuildings.ts `Building.osm`).
 *
 *   npx vite-node tools/linz/roofs.ts dump <work>
 *   python3 tools/linz/facades.py <work>
 *   npx vite-node tools/linz/facades.ts bake <work>
 *
 * Only the tags change: every building, prism, vertex and photo-roof offset keeps its bytes (decode → set `osm` →
 * encode), so it runs after any re-bake of the buildings or the roofs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeBuildings, encodeBuildings } from '../../src/world/scenery/aucklandBuildings';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const WORK = process.argv[3] ?? path.join(os.tmpdir(), 'f35-linz-roofs');
const FILE = path.join(HERE, '../../src/world/terrain/data/auckland-buildings.bin');

if (process.argv[2] !== 'bake') {
  console.error('usage: facades.ts bake <work>');
  process.exit(1);
}
const list = decodeBuildings(new Uint8Array(zlib.gunzipSync(fs.readFileSync(FILE))));
const res = JSON.parse(fs.readFileSync(path.join(WORK, 'facades.json'), 'utf8')) as { i: number; use: number; levels: number; material: number; colour: number | null }[];
for (const b of list) delete b.osm;
for (const r of res) list[r.i].osm = { use: r.use, levels: r.levels, material: r.material, colour: r.colour ?? undefined };
const before = fs.statSync(FILE).size;
const raw = encodeBuildings(list);
const gz = zlib.gzipSync(raw, { level: 9 });
fs.writeFileSync(FILE, gz);
console.log(`OSM tags on ${res.length} buildings (${res.filter((r) => r.levels).length} with storeys); wrote ${FILE}: ${raw.length} bytes raw, ${gz.length} bytes gzip (${gz.length - before >= 0 ? '+' : ''}${gz.length - before})`);
