/**
 * Add the street ribbons of the hero neighbourhoods outside the CBD region (Mission Bay: neighbourhoodStreets.ts) to
 * src/world/terrain/data/auckland-roads.bin, keeping every other line (a full re-bake, roads.ts, adds them itself).
 * Run it after baking a new neighbourhood (tools/hero/sites/neighbourhoods_bake.py); a second run adds nothing, as
 * the streets it added are then ribbons already.
 *
 *   LINZ_API_KEY=… npx vite-node tools/linz/neighbourhood-streets.ts [work dir]
 *
 * Streets are left out where the game's base terrain (the LINZ heightfield, as tests/world-suburbs.test.ts builds it)
 * is under 0.6 m: the game would draw them across the water.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeRoads, encodeRoads } from '../../src/world/scenery/aucklandRoads';
import { neighbourhoodStreets } from './neighbourhoodStreets';
import type { Pt } from './polyline';
import { setAucklandLinz } from '../../src/world/terrain/theaters/aucklandLinz';
import { generateTerrain, runSync } from '../../src/world/terrain/generate';
import { allFeatures } from '../../src/world/scenery/Scenery';
import { airfieldFeature } from '../../src/core/airfields';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const WORK = process.argv[2] ?? path.join(os.tmpdir(), 'f35-linz-roads');
const OUT = path.join(HERE, '../../src/world/terrain/data/auckland-roads.bin');
fs.mkdirSync(WORK, { recursive: true });

const old = decodeRoads(new Uint8Array(zlib.gunzipSync(fs.readFileSync(OUT))));
const region = Array.from({ length: old.region.length / 2 }, (_, i): Pt => [old.region[2 * i], old.region[2 * i + 1]]);
setAucklandLinz(new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(HERE, '../../src/world/terrain/data/auckland-linz.bin')))));
const features = allFeatures('auckland', [airfieldFeature('whenuapai')]);
const hf = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 1024, features, pads: [] }));
const add = neighbourhoodStreets(WORK, region, old.lines, console.log, (x, z) => hf.heightAt(x, z) < 0.6);
const raw = encodeRoads({ region: old.region, lines: old.lines.concat(add) }, 0.5);
const gz = zlib.gzipSync(raw, { level: 9 });
fs.writeFileSync(OUT, gz);
console.log(`added ${add.length} lines; wrote ${OUT}: ${raw.length} bytes raw, ${gz.length} bytes gzip`);
