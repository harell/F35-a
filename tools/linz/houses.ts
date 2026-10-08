/**
 * Real suburbs 2/9 (#121), step 2: bake the real houses (houses.py output) into src/world/terrain/data/auckland-houses.bin
 * (gzip; decoded by src/world/scenery/aucklandHouses.ts) and the photo spot checks into
 * tests/fixtures/linz-house-spotchecks.json.
 *
 *   python3 tools/linz/houses.py <work dir> [<aerial work dir>]     # outlines + LiDAR roofs + photo colours → <work>/houses.json
 *   npx vite-node tools/linz/houses.ts <work dir>
 *
 * Reprojects with the game's own geoToWorld (WGS84 → game XZ), the ridge's direction from a second point 10 m along it,
 * and drops the houses standing in the water of the game's LINZ coastline (a boatshed on piles). Prints the bytes per
 * house and the gzip size. (The landmark sites with buildings of their own, the naval base, keep the houses off at
 * runtime: sources.ts HouseSource.)
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { geoToWorld } from '../../src/core/auckland';
import { decodeHouses, encodeHouses, HOUSE_BYTES, nearestHouse, type HouseRecord } from '../../src/world/scenery/aucklandHouses';
import { decodeLinz, linzIsLand } from '../../src/world/terrain/theaters/aucklandLinz';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const WORK = process.argv[2] ?? '/home/user/work/houses';
const OUT = path.join(HERE, '../../src/world/terrain/data/auckland-houses.bin');
const FIXTURE = path.join(HERE, '../../tests/fixtures/linz-house-spotchecks.json');

interface InHouse {
  id: number;
  src: 'outline' | 'lidar';
  area: string;
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
}
interface InCheck {
  id: number;
  lon: number;
  lat: number;
  offset: number;
  ridge: number;
  photo: string;
  outlines: number;
}

const input = JSON.parse(fs.readFileSync(path.join(WORK, 'houses.json'), 'utf8')) as {
  palette: number[][];
  houses: InHouse[];
  tally: Record<string, Record<string, number>>;
  cover: { x0: number; z0: number; cell: number; cols: number; rows: number; runs: number[][] };
};
const checks = JSON.parse(fs.readFileSync(path.join(WORK, 'house-spotchecks.json'), 'utf8')) as InCheck[];
const linz = decodeLinz(new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(HERE, '../../src/world/terrain/data/auckland-linz.bin')))));

const palette = input.palette.map(([r, g, b]) => (r << 16) | (g << 8) | b);
const records: HouseRecord[] = [];
const byId = new Map<number, number>();
let wet = 0;
for (const h of input.houses) {
  const p = geoToWorld(h.lat, h.lon);
  const q = geoToWorld(h.lat2, h.lon2);
  if (!linzIsLand(linz, p.x, p.z)) {
    wet++;
    continue;
  }
  if (h.id > 0) byId.set(h.id, records.length);
  records.push({ x: p.x, z: p.z, w: h.w, d: h.d, dir: Math.atan2(q.z - p.z, q.x - p.x), eave: h.eave, rise: h.rise, c: h.c });
}

const cv = input.cover;
const bits = new Uint8Array(cv.cols * cv.rows);
cv.runs.forEach((runs, j) => {
  let i = 0;
  runs.forEach((n, r) => {
    if (r % 2) bits.fill(1, j * cv.cols + i, j * cv.cols + i + n);
    i += n;
  });
});
const raw = encodeHouses(records, palette, { x0: cv.x0, z0: cv.z0, cell: cv.cell, cols: cv.cols, rows: cv.rows, bits });
const gz = zlib.gzipSync(raw, { level: 9 });
fs.writeFileSync(OUT, gz);
const back = decodeHouses(raw);

// spot checks: the photo's roof (game XZ) and the house the bake made of that outline (its decoded centre is tested)
const fixture = checks.map((c) => {
  const p = geoToWorld(c.lat, c.lon);
  const r = records[byId.get(c.id)!];
  const k = nearestHouse(back, r.x, r.z, 1);
  return { id: c.id, x: +p.x.toFixed(2), z: +p.z.toFixed(2), ridge: c.ridge, photo: c.photo, house: k, offsetFromOutline: c.offset };
});
fs.writeFileSync(FIXTURE, JSON.stringify(fixture, null, 1) + '\n');

const perArea: Record<string, number> = {};
for (const h of input.houses) perArea[h.area] = (perArea[h.area] ?? 0) + 1;
console.log(`houses: ${records.length} (${wet} in the water dropped); per area ${JSON.stringify(perArea)}`);
const bare = zlib.gzipSync(encodeHouses(records, palette, { x0: 0, z0: 0, cell: 1, cols: 0, rows: 0, bits: new Uint8Array(0) }), { level: 9 }).length;
console.log(`raw ${raw.length} B (${(raw.length / records.length).toFixed(2)} B a house, columns ${HOUSE_BYTES}), gzip ${gz.length} B (${(gz.length / records.length).toFixed(2)} B a house)`);
console.log(`coverage: ${cv.cols} x ${cv.rows} cells of ${cv.cell} m (+${gz.length - bare} B gzip; the houses alone ${bare} B gzip, ${(bare / records.length).toFixed(2)} B a house)`);
console.log(`wrote ${path.relative(process.cwd(), OUT)} and ${path.relative(process.cwd(), FIXTURE)} (${fixture.length} spot checks)`);
