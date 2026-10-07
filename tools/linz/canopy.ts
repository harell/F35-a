/**
 * Real suburbs 4/9 (#123), step 2: bake the canopy grid (canopy.py output) into src/world/terrain/data/auckland-canopy.bin
 * (gzip; decoded by src/world/terrain/theaters/aucklandCanopy.ts) and the LiDAR canopy share of the test areas into
 * tests/fixtures/linz-canopy-areas.json.
 *
 *   python3 tools/linz/canopy.py bake <work dir>
 *   npx vite-node tools/linz/canopy.ts <work dir>
 *
 * Quantises the share (0 … 250 from canopy.py) to CANOPY_LEVELS levels, checks the round trip and prints the size.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { CANOPY_LEVELS, decodeCanopy, encodeCanopy, type Canopy } from '../../src/world/terrain/theaters/aucklandCanopy';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const WORK = process.argv[2] ?? '/home/user/work/canopy';
const OUT = path.join(HERE, '../../src/world/terrain/data/auckland-canopy.bin');
const FIXTURE = path.join(HERE, '../../tests/fixtures/linz-canopy-areas.json');

interface Meta {
  x0: number;
  z0: number;
  cell: number;
  cols: number;
  rows: number;
  hcell: number;
  hcols: number;
  hrows: number;
  areas: { key: string; kind: string; land: number; tree: number; share: number; rings: number[][] }[];
}
const meta = JSON.parse(fs.readFileSync(path.join(WORK, 'canopy-grid.json'), 'utf8')) as Meta;
const raw = new Uint8Array(fs.readFileSync(path.join(WORK, 'canopy-grid.bin')));
const n = meta.cols * meta.rows;
const hcell = Math.round(meta.hcell / meta.cell);
if (Math.ceil(meta.cols / hcell) !== meta.hcols || Math.ceil(meta.rows / hcell) !== meta.hrows) throw new Error('height grid size');
const Q = CANOPY_LEVELS;
const share = new Uint8Array(n);
for (let k = 0; k < n; k++) share[k] = raw[k] === 255 ? Q : Math.round((raw[k] / 250) * (Q - 1));
const height = raw.slice(n, n + meta.hcols * meta.hrows);
const canopy: Canopy = {
  attribution: 'Tree canopy: LINZ Auckland LiDAR 2024 and NZ Building Outlines, CC BY 4.0',
  x0: meta.x0,
  z0: meta.z0,
  cell: meta.cell,
  cols: meta.cols,
  rows: meta.rows,
  levels: Q,
  share,
  hcell,
  hcols: meta.hcols,
  hrows: meta.hrows,
  height,
};
const t0 = Date.now();
const bytes = encodeCanopy(canopy);
const t1 = Date.now();
const back = decodeCanopy(bytes);
const t2 = Date.now();
for (let k = 0; k < n; k++) if (back.share[k] !== share[k]) throw new Error(`share round trip at ${k}`);
for (let k = 0; k < height.length; k++) if (back.height[k] !== Math.min(63, height[k])) throw new Error(`height round trip at ${k}`);
const gz = zlib.gzipSync(bytes, { level: 9 });
fs.writeFileSync(OUT, gz);
let covered = 0;
for (let k = 0; k < n; k++) if (share[k] < Q) covered++;
console.log(`canopy: ${meta.cols} × ${meta.rows} cells of ${meta.cell} m (${((covered * meta.cell * meta.cell) / 1e6).toFixed(0)} km² covered), ${bytes.length} bytes (${gz.length} gzip) → ${path.relative(process.cwd(), OUT)}; encode ${t1 - t0} ms, decode ${t2 - t1} ms`);
fs.writeFileSync(FIXTURE, JSON.stringify(meta.areas.map((a) => ({ key: a.key, kind: a.kind, land: a.land, share: a.share, rings: a.rings }))) + '\n');
for (const a of meta.areas) console.log(`  ${a.key}: LiDAR canopy ${(a.share * 100).toFixed(1)} % of ${(a.land / 1e6).toFixed(2)} km² land`);
