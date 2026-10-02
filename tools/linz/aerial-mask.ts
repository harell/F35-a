/**
 * Masks for the aerial photo bake (tools/linz/aerial.py), on the photo's own pixel grid
 * (AERIAL_RECT in src/world/terrain/theaters/aucklandAerial.ts, pixel centres):
 *
 *   npx vite-node tools/linz/aerial-mask.ts <work> [n = 4096]
 *
 * writes <work>/aerial-mask-<n>.bin, three n × n u8 planes:
 *   0  signed distance to the LINZ coastline the game uses (m, + land), encoded d + 128, clamped
 *   1  255 inside an OSM wharf / pier / breakwater / dock outline (the scenery decks them)
 *   2  255 on a LINZ CBD street carriageway (kerb distance < 0; for the alignment check)
 * Reads the baked game data only (no download).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { AERIAL_RECT } from '../../src/world/terrain/theaters/aucklandAerial';
import { aucklandMapData } from '../../src/world/terrain/theaters/auckland';
import { AKL_LABEL } from '../../src/world/terrain/theaters/aucklandMap';
import { setAucklandLinz } from '../../src/world/terrain/theaters/aucklandLinz';
import { splatDistance, type SampleGrid } from '../../src/world/terrain/coastline';
import { setAucklandOsm } from '../../src/world/scenery/aucklandOsm';
import { inRing, siteLayout } from '../../src/world/scenery/aucklandSites';
import { setAucklandRoads } from '../../src/world/scenery/aucklandRoads';
import { aucklandStreets } from '../../src/world/scenery/cbdStreets';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const work = process.argv[2];
const n = Number(process.argv[3] ?? 4096);
if (!work) throw new Error('usage: aerial-mask.ts <work> [n]');

const read = (p: string) => {
  const b = fs.readFileSync(path.join(HERE, '../../src', p));
  return new Uint8Array(b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b);
};
setAucklandLinz(read('world/terrain/data/auckland-linz.bin'));
setAucklandOsm(read('world/scenery/data/auckland-osm.bin'));
setAucklandRoads(read('world/terrain/data/auckland-roads.bin'));

const R = AERIAL_RECT;
const cell = R.size / n;
const g: SampleGrid = { n, x0: R.x0 + cell / 2, z0: R.z0 + cell / 2, cell };
const out = new Uint8Array(n * n * 3);

// 0: signed coast distance (the terrain's coast segments and land fill: LINZ rings + crater lakes)
const map = aucklandMapData();
const labels = new Uint8Array(n * n);
map.fillLand(labels, g, n);
const RANGE = 127;
const dist = new Float32Array(n * n).fill(RANGE);
splatDistance(map.segments, g, RANGE, dist);
for (let k = 0; k < n * n; k++) {
  const s = labels[k] === AKL_LABEL.land ? 1 : -1;
  out[k] = Math.max(0, Math.min(255, Math.round(128 + s * dist[k])));
}

// 1: OSM decks
const site = siteLayout();
if (!site) throw new Error('no OSM site layout');
const decks = [...site.port, ...site.piers, ...site.breakwaters, ...site.docks].filter(
  (r) => r.x1 > R.x0 && r.x0 < R.x0 + R.size && r.z1 > R.z0 && r.z0 < R.z0 + R.size,
);
for (const r of decks) {
  const i0 = Math.max(0, Math.floor((r.x0 - g.x0) / cell));
  const i1 = Math.min(n - 1, Math.ceil((r.x1 - g.x0) / cell));
  const j0 = Math.max(0, Math.floor((r.z0 - g.z0) / cell));
  const j1 = Math.min(n - 1, Math.ceil((r.z1 - g.z0) / cell));
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) if (inRing(r, g.x0 + i * cell, g.z0 + j * cell)) out[n * n + j * n + i] = 255;
}

// 2: CBD carriageways
const st = aucklandStreets();
if (!st) throw new Error('no LINZ street map');
for (let j = 0; j < n; j++)
  for (let i = 0; i < n; i++) if (st.kerbDistance(g.x0 + i * cell, g.z0 + j * cell) < 0) out[2 * n * n + j * n + i] = 255;

fs.writeFileSync(path.join(work, `aerial-mask-${n}.bin`), out);
console.log(`aerial-mask-${n}.bin: ${decks.length} decks, land ${(labels.reduce((a, b) => a + (b === AKL_LABEL.land ? 1 : 0), 0) / (n * n) * 100).toFixed(1)} %`);
