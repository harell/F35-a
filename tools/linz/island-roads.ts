/**
 * Add the local roads of the gulf islands and the Devonport peninsula (#127: islandRoads.ts) to
 * src/world/terrain/data/auckland-roads.bin, replacing the local roads already there and keeping every other line (a
 * full re-bake, roads.ts, adds them itself). Run it after a re-bake of the real houses (tools/linz/houses.ts), whose
 * coverage it follows.
 *
 *   LINZ_API_KEY=… npx vite-node tools/linz/island-roads.ts [work dir] [preview.svg]
 *
 * SVG_BOX="x0,z0,x1,z1" (m) picks the preview's view (default: Waiheke's west end, Matiatia to Onetangi).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeRoads, encodeRoads, ROAD_LOCAL } from '../../src/world/scenery/aucklandRoads';
import { decodeLinz, linzIsLand } from '../../src/world/terrain/theaters/aucklandLinz';
import { islandRoads } from './islandRoads';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const WORK = process.argv[2] ?? path.join(os.tmpdir(), 'f35-linz-roads');
const SVG = process.argv[3] ?? null;
const OUT = path.join(HERE, '../../src/world/terrain/data/auckland-roads.bin');
fs.mkdirSync(WORK, { recursive: true });

const old = decodeRoads(new Uint8Array(zlib.gunzipSync(fs.readFileSync(OUT))));
const keep = old.lines.filter((l) => l.kind !== ROAD_LOCAL);
const region = old.region;
const inRegion = (x: number, z: number) => {
  let inside = false;
  for (let i = 0, j = region.length / 2 - 1; i < region.length / 2; j = i++) {
    const xi = region[i * 2], zi = region[i * 2 + 1], xj = region[j * 2], zj = region[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};
const linz = decodeLinz(new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(HERE, '../../src/world/terrain/data/auckland-linz.bin')))));
const add = islandRoads(WORK, inRegion, keep, (x, z) => linzIsLand(linz, x, z));
const raw = encodeRoads({ region, lines: keep.concat(add) }, 0.5);
const gz = zlib.gzipSync(raw, { level: 9 });
fs.writeFileSync(OUT, gz);
console.log(`${old.lines.length - keep.length} local roads replaced by ${add.length}; wrote ${OUT}: ${raw.length} bytes raw, ${gz.length} bytes gzip`);

if (SVG) {
  const [x0, z0, x1, z1] = (process.env.SVG_BOX ?? '19500,-9000,30500,-2500').split(',').map(Number);
  const s = 1600 / (x1 - x0);
  const tr = (x: number, z: number) => `${((x - x0) * s).toFixed(1)},${((z - z0) * s).toFixed(1)}`;
  let body = '';
  for (const r of linz.rings) {
    const pts: string[] = [];
    for (let i = 0; i < r.length; i += 2) if (r[i] > x0 - 2000 && r[i] < x1 + 2000 && r[i + 1] > z0 - 2000 && r[i + 1] < z1 + 2000) pts.push(tr(r[i], r[i + 1]));
    if (pts.length > 2) body += `<polyline points="${pts.join(' ')}" fill="none" stroke="#6af" stroke-width="1.5"/>`;
  }
  for (const l of keep.concat(add)) {
    const pts: string[] = [];
    for (let i = 0; i < l.pts.length; i += 2) pts.push(tr(l.pts[i], l.pts[i + 1]));
    const col = l.kind === ROAD_LOCAL ? (l.unsealed ? '#b80' : '#333') : '#c00';
    body += `<polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="${Math.max(0.8, l.width * s)}" stroke-opacity="0.8"/>`;
  }
  fs.writeFileSync(SVG, `<svg xmlns="http://www.w3.org/2000/svg" width="${(x1 - x0) * s}" height="${(z1 - z0) * s}"><rect width="100%" height="100%" fill="#fff"/>${body}</svg>`);
  console.log(`wrote ${SVG}`);
}
