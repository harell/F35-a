/**
 * LINZ phase 2b, step 2: bake the CBD buildings (buildings.py output) into
 * src/world/terrain/data/auckland-buildings.bin (gzip; decoded by src/world/scenery/aucklandBuildings.ts).
 *
 *   python3 tools/linz/buildings.py <work dir>            # outlines + LiDAR heights → <work>/buildings.json
 *   npx vite-node tools/linz/buildings.ts <work dir> [preview.svg]
 *
 * Reprojects with the game's own geoToWorld (WGS84 → game XZ, as roads.ts does), keeps the buildings
 * of the CBD region (auckland-roads.bin: outside it the procedural suburbs and their street grid stay),
 * drops the ones over the harbour (wharf sheds: the terrain there is water) and writes the spot checks
 * (raw LiDAR heights at the named towers and a sample of outlines) to tests/fixtures for the ±5 m test.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { geoToWorld } from '../../src/core/auckland';
import { encodeBuildings, ringArea, ringCentroid, roofHeight, type Building } from '../../src/world/scenery/aucklandBuildings';
import { decodeRoads, setAucklandRoads } from '../../src/world/scenery/aucklandRoads';
import { CbdStreets, pointInRing } from '../../src/world/scenery/cbdStreets';
import { aucklandRoadPaths, RoadNetwork } from '../../src/world/scenery/motorways';
import { decodeLinz, linzIsLand } from '../../src/world/terrain/theaters/aucklandLinz';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const WORK = process.argv[2] ?? path.join(os.tmpdir(), 'f35-linz-buildings');
const SVG = process.argv[3] ?? null;
const OUT = path.join(HERE, '../../src/world/terrain/data/auckland-buildings.bin');
const FIXTURE = path.join(HERE, '../../tests/fixtures/linz-buildings-spotchecks.json');

interface InPart {
  ring: [number, number][];
  /** Roof height (m above the ground), at the centroid for a sloped roof. */
  h: number;
  /** Roof slope east / south (m/m). */
  sx: number;
  sz: number;
}
interface InBuilding {
  id: number;
  src: 'outline' | 'lidar';
  name: string;
  use: string;
  parts: InPart[];
}
const input = JSON.parse(fs.readFileSync(path.join(WORK, 'buildings.json'), 'utf8')) as InBuilding[];
const checks = JSON.parse(fs.readFileSync(path.join(WORK, 'spotchecks.json'), 'utf8')) as { name: string; lon: number; lat: number; lidar: number; peak?: number }[];

const data = (f: string) => new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(HERE, '../../src/world/terrain/data', f))));
const st = new CbdStreets(decodeRoads(data('auckland-roads.bin')));
setAucklandRoads(data('auckland-roads.bin'));
const roads = new RoadNetwork(aucklandRoadPaths());
const linz = decodeLinz(data('auckland-linz.bin'));

const project = (r: [number, number][]): Float32Array => {
  const out = new Float32Array(r.length * 2);
  r.forEach(([lon, lat], i) => {
    const p = geoToWorld(lat, lon);
    out[i * 2] = p.x;
    out[i * 2 + 1] = p.z;
  });
  // counter-clockwise on the map (ringArea > 0)
  if (ringArea(out) < 0) {
    const n = r.length;
    for (let i = 0; i < n / 2; i++) {
      const j = n - 1 - i;
      for (const k of [0, 1]) [out[i * 2 + k], out[j * 2 + k]] = [out[j * 2 + k], out[i * 2 + k]];
    }
  }
  return out;
};
const centroid = ringCentroid;

/** Fraction of a ring's area (2 m lattice) on a street, a motorway or in a park. */
const blockedFraction = (r: Float32Array) => {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    x0 = Math.min(x0, r[i]);
    x1 = Math.max(x1, r[i]);
    z0 = Math.min(z0, r[i + 1]);
    z1 = Math.max(z1, r[i + 1]);
  }
  let n = 0;
  let bad = 0;
  for (let z = z0 + 1; z < z1; z += 2)
    for (let x = x0 + 1; x < x1; x += 2) {
      if (!pointInRing(r, x, z)) continue;
      n++;
      if (st.kerbDistance(x, z) < 0 || roads.edgeDistance(x, z) < 0 || st.park(x, z) > 0.5) bad++;
    }
  return n ? bad / n : 1;
};

const out: Building[] = [];
let outside = 0;
let water = 0;
let trees = 0;
for (const b of input) {
  // the tallest prism last: the footprint (podium) first, its towers after it
  const prisms = b.parts
    .map((p) => {
      const ring = project(p.ring);
      const [cx, cz] = centroid(ring);
      return { h: p.h, ring, sx: p.sx, sz: p.sz, cx, cz };
    })
    .sort((a, c) => ringArea(c.ring) - ringArea(a.ring));
  const [cx, cz] = centroid(prisms[0].ring);
  if (!st.inRegion(cx, cz)) {
    outside++;
    continue;
  }
  if (!linzIsLand(linz, cx, cz)) {
    water++;
    continue;
  }
  // traced from the LiDAR over a street, a motorway or a park: street trees, a viaduct
  if (b.src === 'lidar' && blockedFraction(prisms[0].ring) > 0.1) {
    trees++;
    continue;
  }
  out.push({ lidar: b.src === 'lidar', prisms });
}
// west → east, north → south: neighbours share their delta-coded vertices' magnitudes (smaller gzip)
const key = (b: Building) => {
  const [x, z] = centroid(b.prisms[0].ring);
  return Math.floor(z / 100) * 100_000 + x;
};
out.sort((a, b) => key(a) - key(b));

const raw = encodeBuildings(out);
const gz = zlib.gzipSync(raw, { level: 9 });
fs.writeFileSync(OUT, gz);

// ── Report ──
const prisms = out.flatMap((b) => b.prisms);
const verts = prisms.reduce((s, p) => s + p.ring.length / 2, 0);
console.log(`kept ${out.length} buildings (${out.filter((b) => b.lidar).length} traced from the LiDAR), ${prisms.length} prisms, ${verts} vertices; ${outside} outside the CBD region, ${water} over the water, ${trees} LiDAR-traced on a street / motorway / park`);
const hs = prisms.map((p) => p.h).sort((a, b) => b - a);
console.log(`sloped roofs: ${prisms.filter((p) => p.sx || p.sz).length}`);
console.log(`tallest: ${hs.slice(0, 12).map((h) => h.toFixed(0)).join(', ')}; ≥ 60 m: ${hs.filter((h) => h >= 60).length}, ≥ 100 m: ${hs.filter((h) => h >= 100).length}`);
let onStreet = 0;
for (const p of prisms) {
  for (let i = 0; i < p.ring.length; i += 2) if (st.kerbDistance(p.ring[i], p.ring[i + 1]) < 0) onStreet++;
}
console.log(`vertices on a painted carriageway: ${onStreet} of ${verts}`);
console.log(`wrote ${OUT}: ${raw.length} bytes raw, ${gz.length} bytes gzip`);

/** Roof height of the baked building at a point (the tallest prism containing it). */
const bakedAt = (x: number, z: number) => {
  let h = -1;
  for (const p of prisms) if (pointInRing(p.ring, x, z)) h = Math.max(h, roofHeight(p, x, z));
  return h;
};
const fixture = checks
  .map((c) => {
    const p = geoToWorld(c.lat, c.lon);
    const x = Math.round(p.x * 10) / 10;
    const z = Math.round(p.z * 10) / 10;
    return { name: c.name, x, z, lidar: c.lidar, baked: bakedAt(x, z) };
  })
  .filter((c) => c.baked >= 0 && st.inRegion(c.x, c.z));
for (const c of fixture.slice(0, 10)) console.log(`  ${c.name.padEnd(16)} LiDAR ${c.lidar.toFixed(1)} m, baked ${c.baked.toFixed(1)} m`);
const off = fixture.filter((c) => Math.abs(c.baked - c.lidar) > 5);
console.log(`spot checks: ${fixture.length}, off by > 5 m: ${off.length}${off.length ? ' — ' + off.map((c) => `${c.name} ${c.lidar}/${c.baked}`).join(', ') : ''}`);
fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
fs.writeFileSync(FIXTURE, JSON.stringify(fixture.map(({ baked: _, ...c }) => c), null, 1) + '\n');
console.log(`wrote ${FIXTURE}`);

if (SVG) {
  const [x0, z0, x1, z1] = (process.env.SVG_BOX ?? '-1200,-1750,1150,1400').split(',').map(Number);
  const s = 1400 / (x1 - x0);
  const tr = (x: number, z: number) => `${((x - x0) * s).toFixed(1)},${((z - z0) * s).toFixed(1)}`;
  let body = '';
  for (const l of st.streets) {
    const pts: string[] = [];
    for (let i = 0; i < l.pts.length; i += 2) pts.push(tr(l.pts[i], l.pts[i + 1]));
    body += `<polyline points="${pts.join(' ')}" fill="none" stroke="#ccc" stroke-width="${l.width * s}"/>`;
  }
  for (const b of out)
    for (const p of b.prisms) {
      const pts: string[] = [];
      for (let i = 0; i < p.ring.length; i += 2) pts.push(tr(p.ring[i], p.ring[i + 1]));
      const t = Math.min(1, p.h / 180);
      body += `<polygon points="${pts.join(' ')}" fill="hsl(${220 - 220 * t},70%,${70 - 30 * t}%)" stroke="${b.lidar ? '#f0f' : '#333'}" stroke-width="0.6"/>`;
    }
  const reg: string[] = [];
  for (let i = 0; i < st.region.length; i += 2) reg.push(tr(st.region[i], st.region[i + 1]));
  body += `<polygon points="${reg.join(' ')}" fill="none" stroke="#f00" stroke-width="1.5"/>`;
  fs.writeFileSync(SVG, `<svg xmlns="http://www.w3.org/2000/svg" width="${(x1 - x0) * s}" height="${(z1 - z0) * s}"><rect width="100%" height="100%" fill="#fff"/>${body}</svg>`);
  console.log(`wrote ${SVG}`);
}
