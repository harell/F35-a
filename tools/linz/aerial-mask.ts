/**
 * Masks for the aerial photo bake (tools/linz/aerial.py), on a photo's own pixel grid (pixel centres):
 *
 *   npx vite-node tools/linz/aerial-mask.ts <out.bin> <x0> <z0> <cols> <rows> <cell>
 *
 * (x0, z0: the north-west corner in game XZ, m; cell: pixel size, m). aerial.py runs it once per photo
 * rectangle (the city photo, AERIAL_RECT in src/world/terrain/theaters/aucklandAerial.ts, and each
 * island tile). Writes three rows × cols u8 planes:
 *   0  signed distance to the LINZ coastline the game uses (m, + land), encoded d + 128, clamped
 *   1  255 inside an OSM wharf / pier / breakwater / dock outline (the scenery decks them)
 *   2  255 on a LINZ CBD street carriageway (kerb distance < 0; for the alignment check)
 *   3  land label (AKL_LABEL.land = land, else 0) for the island bake's per-island connected components
 * Reads the baked game data only (no download).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { aucklandMapData } from '../../src/world/terrain/theaters/auckland';
import { AKL_LABEL } from '../../src/world/terrain/theaters/aucklandMap';
import { setAucklandLinz } from '../../src/world/terrain/theaters/aucklandLinz';
import { splatDistance, type SampleGrid } from '../../src/world/terrain/coastline';
import { setAucklandOsm } from '../../src/world/scenery/aucklandOsm';
import { inRing, siteLayout } from '../../src/world/scenery/aucklandSites';
import { setAucklandRoads } from '../../src/world/scenery/aucklandRoads';
import { aucklandStreets } from '../../src/world/scenery/cbdStreets';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const [outPath, ...nums] = process.argv.slice(2);
const [X0, Z0, cols, rows, cell] = nums.map(Number);
if (!outPath || !(cell > 0) || !(cols > 0) || !(rows > 0)) throw new Error('usage: aerial-mask.ts <out.bin> <x0> <z0> <cols> <rows> <cell>');

const read = (p: string) => {
  const b = fs.readFileSync(path.join(HERE, '../../src', p));
  return new Uint8Array(b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b);
};
setAucklandLinz(read('world/terrain/data/auckland-linz.bin'));
setAucklandOsm(read('world/scenery/data/auckland-osm.bin'));
setAucklandRoads(read('world/terrain/data/auckland-roads.bin'));

const R = { x0: X0, z0: Z0, x1: X0 + cols * cell, z1: Z0 + rows * cell };
const g: SampleGrid = { n: cols, x0: X0 + cell / 2, z0: Z0 + cell / 2, cell };
const N = cols * rows;
const out = new Uint8Array(N * 4);

// 0: signed coast distance (the terrain's coast segments and land fill: LINZ rings + crater lakes)
const map = aucklandMapData();
const labels = new Uint8Array(N);
map.fillLand(labels, g, rows);
const RANGE = 127;
const dist = new Float32Array(N).fill(RANGE);
splatDistance(map.segments, g, RANGE, dist, 0, rows);
let landN = 0;
for (let k = 0; k < N; k++) {
  const land = labels[k] === AKL_LABEL.land;
  if (land) landN++;
  out[k] = Math.max(0, Math.min(255, Math.round(128 + (land ? 1 : -1) * dist[k])));
  out[3 * N + k] = land ? 255 : 0;
}

// 1: OSM decks
const site = siteLayout();
if (!site) throw new Error('no OSM site layout');
const decks = [...site.port, ...site.piers, ...site.breakwaters, ...site.docks].filter(
  (r) => r.x1 > R.x0 && r.x0 < R.x1 && r.z1 > R.z0 && r.z0 < R.z1,
);
for (const r of decks) {
  const i0 = Math.max(0, Math.floor((r.x0 - g.x0) / cell));
  const i1 = Math.min(cols - 1, Math.ceil((r.x1 - g.x0) / cell));
  const j0 = Math.max(0, Math.floor((r.z0 - g.z0) / cell));
  const j1 = Math.min(rows - 1, Math.ceil((r.z1 - g.z0) / cell));
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) if (inRing(r, g.x0 + i * cell, g.z0 + j * cell)) out[N + j * cols + i] = 255;
}

// 2: CBD carriageways
const st = aucklandStreets();
if (!st) throw new Error('no LINZ street map');
for (let j = 0; j < rows; j++)
  for (let i = 0; i < cols; i++) if (st.kerbDistance(g.x0 + i * cell, g.z0 + j * cell) < 0) out[2 * N + j * cols + i] = 255;

fs.writeFileSync(outPath, out);
console.log(`${path.basename(outPath)}: ${cols} × ${rows} at ${cell} m, ${decks.length} decks, land ${((landN / N) * 100).toFixed(1)} %`);
