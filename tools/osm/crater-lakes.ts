/**
 * #276: the crater lakes' real shorelines (AKL_LAKES in src/world/terrain/theaters/aucklandMap.ts), from OpenStreetMap:
 *
 *   npx vite-node tools/osm/crater-lakes.ts [<osm-dir>]
 *
 * Downloads each lake's OSM outline once with the OSM API (0.6 `…/full.json`, two small requests; cached in
 * <osm-dir>, default the system's temp directory) and prints the AKL_LAKES block to paste:
 *   - Lake Pupuke: way 4847408 (`natural=water`, `water=lake`).
 *   - Panmure Basin (Te Kopua Kai-a-Hiku): relation 14732359 (`natural=water`, `water=lagoon`): its outer ring is the
 *     LINZ coastline way round the basin, closed by a short line across its channel to the Tāmaki River.
 * Each ring goes to game XZ (km, as src/core/auckland.ts geoToWorld), is simplified (Douglas–Peucker, SIMPLIFY m),
 * and gets its calm-water circles (`calm`, for the terrain and water shaders' calmAt(), CALM_MAX in all): circles
 * no larger than the lake that cover its shore and keep LAKE_RIM + MARGIN clear of the sea (the LINZ coastline's water outside every lake),
 * so the lake loses its surf and sand band while Takapuna Beach and the Tāmaki River keep theirs. Chosen greedily,
 * each the circle that covers the most shore points still uncovered (the smallest of equals).
 *
 * Data © OpenStreetMap contributors, ODbL 1.0 (docs/CREDITS.md).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { geoToWorld } from '../../src/core/auckland';
import { ringDistance } from '../../src/world/terrain/features';
import { LAKE_RIM } from '../../src/world/terrain/theaters/auckland';
import { linzIsLand, setAucklandLinz, aucklandLinz } from '../../src/world/terrain/theaters/aucklandLinz';
import { CALM_MAX } from '../../src/world/terrain/terrainShader';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CACHE = process.argv[2] ?? path.join(os.tmpdir(), 'f35-crater-lakes');
const API = 'https://api.openstreetmap.org/api/0.6';
/** Douglas–Peucker tolerance (m). */
const SIMPLIFY = 4;
/** Sea kept this far past a calm circle's rim (m). */
const MARGIN = 30;
/** Shore sample spacing (m) for the circles' cover, and the grid of candidate centres (m). */
const STEP = 20;

interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  members?: { type: string; ref: number; role: string }[];
}

const LAKES: { name: string; kind: 'way' | 'relation'; id: number }[] = [
  { name: 'Lake Pupuke', kind: 'way', id: 4847408 },
  { name: 'Panmure Basin', kind: 'relation', id: 14732359 },
];

async function osm(kind: string, id: number): Promise<OsmElement[]> {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${kind}-${id}.json`);
  if (!fs.existsSync(file)) {
    const r = await fetch(`${API}/${kind}/${id}/full.json`, { headers: { 'User-Agent': 'F35-a crater-lakes bake' } });
    if (!r.ok) throw new Error(`${kind} ${id}: HTTP ${r.status}`);
    fs.writeFileSync(file, await r.text());
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')).elements;
}

/** The outer ring (node ids, closed): a closed way, or a relation's outer ways joined end to end. */
function outerRing(els: OsmElement[], kind: string, id: number): number[] {
  const ways = new Map(els.filter((e) => e.type === 'way').map((e) => [e.id, e.nodes!]));
  if (kind === 'way') return ways.get(id)!;
  const rel = els.find((e) => e.type === 'relation' && e.id === id)!;
  const parts = rel.members!.filter((m) => m.type === 'way' && m.role === 'outer').map((m) => [...ways.get(m.ref)!]);
  const ring = parts.shift()!;
  while (parts.length) {
    const end = ring[ring.length - 1];
    const k = parts.findIndex((p) => p[0] === end || p[p.length - 1] === end);
    if (k < 0) throw new Error(`relation ${id}: outer ways don't join`);
    const p = parts.splice(k, 1)[0];
    ring.push(...(p[0] === end ? p : p.reverse()).slice(1));
  }
  if (ring[0] !== ring[ring.length - 1]) throw new Error(`relation ${id}: outer ring not closed`);
  return ring;
}

function simplify(pts: [number, number][], eps: number): [number, number][] {
  if (pts.length < 3) return pts;
  const [[x1, z1], [x2, z2]] = [pts[0], pts[pts.length - 1]];
  const len = Math.hypot(x2 - x1, z2 - z1) || 1e-9;
  let dmax = 0;
  let idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = Math.abs((x2 - x1) * (z1 - pts[i][1]) - (x1 - pts[i][0]) * (z2 - z1)) / len;
    if (d > dmax) [dmax, idx] = [d, i];
  }
  if (dmax <= eps) return [pts[0], pts[pts.length - 1]];
  return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)];
}

const read = (p: string) => {
  const b = fs.readFileSync(path.join(HERE, '../../src', p));
  return new Uint8Array(b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b);
};
setAucklandLinz(read('world/terrain/data/auckland-linz.bin'));
const linz = aucklandLinz()!;

const rings: { name: string; flat: number[] }[] = [];
for (const l of LAKES) {
  const els = await osm(l.kind, l.id);
  const nodes = new Map(els.filter((e) => e.type === 'node').map((e) => [e.id, e]));
  const ring = outerRing(els, l.kind, l.id).map((n) => {
    const { x, z } = geoToWorld(nodes.get(n)!.lat!, nodes.get(n)!.lon!);
    return [x, z] as [number, number];
  });
  // the ring is closed: simplify its two halves, so both ends of each stay put
  const h = ring.length >> 1;
  const s = [...simplify(ring.slice(0, h + 1), SIMPLIFY).slice(0, -1), ...simplify(ring.slice(h), SIMPLIFY).slice(0, -1)];
  rings.push({ name: l.name, flat: s.flat() });
}

const inAnyLake = (x: number, z: number) => rings.some((r) => ringDistance(r.flat, x, z).inside || ringDistance(r.flat, x, z).dist < MARGIN);
const perLake = Math.floor(CALM_MAX / rings.length);
const out: string[] = [];
for (const r of rings) {
  const xs = r.flat.filter((_, i) => i % 2 === 0);
  const zs = r.flat.filter((_, i) => i % 2 === 1);
  const [x0, x1, z0, z1] = [Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs)];
  // the sea round it: LINZ water outside every lake
  const sea: number[] = [];
  const P = 1500;
  for (let x = x0 - P; x <= x1 + P; x += 10) for (let z = z0 - P; z <= z1 + P; z += 10) if (!linzIsLand(linz, x, z) && !inAnyLake(x, z)) sea.push(x, z);
  const seaDist = (x: number, z: number) => {
    let best = Infinity;
    for (let k = 0; k < sea.length; k += 2) best = Math.min(best, Math.hypot(sea[k] - x, sea[k + 1] - z));
    return best;
  };
  // shore samples
  const shore: [number, number][] = [];
  const n = r.flat.length / 2;
  for (let i = 0; i < n; i++) {
    const [ax, az, bx, bz] = [r.flat[i * 2], r.flat[i * 2 + 1], r.flat[((i + 1) % n) * 2], r.flat[((i + 1) % n) * 2 + 1]];
    const m = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / STEP));
    for (let k = 0; k < m; k++) shore.push([ax + ((bx - ax) * k) / m, az + ((bz - az) * k) / m]);
  }
  // candidates: centres inside the lake, each as large as the sea allows
  const cand: [number, number, number][] = [];
  for (let x = x0; x <= x1; x += STEP) for (let z = z0; z <= z1; z += STEP) {
    if (!ringDistance(r.flat, x, z).inside) continue;
    // no larger than it takes to reach the farthest shore point
    const reach = Math.max(...shore.map(([sx, sz]) => Math.hypot(sx - x, sz - z)));
    const rad = Math.min(seaDist(x, z) - LAKE_RIM - MARGIN, reach);
    if (rad > 50) cand.push([x, z, rad]);
  }
  const covered = new Uint8Array(shore.length);
  const calm: [number, number, number][] = [];
  for (let c = 0; c < perLake; c++) {
    let best = -1;
    let gain = 0;
    for (let k = 0; k < cand.length; k++) {
      const [cx, cz, cr] = cand[k];
      let g = 0;
      for (let s = 0; s < shore.length; s++) if (!covered[s] && Math.hypot(shore[s][0] - cx, shore[s][1] - cz) <= cr) g++;
      if (g > gain || (g > 0 && g === gain && cr < cand[best][2])) [gain, best] = [g, k]; // the smallest of equals
    }
    if (best < 0) break;
    const [cx, cz, cr] = cand[best];
    for (let s = 0; s < shore.length; s++) if (Math.hypot(shore[s][0] - cx, shore[s][1] - cz) <= cr) covered[s] = 1;
    calm.push([Math.round(cx), Math.round(cz), Math.floor(cr)]);
  }
  const left = shore.length - covered.reduce((a, b) => a + b, 0);
  console.error(`${r.name}: ${n} points, ${calm.length} calm circles, ${left} of ${shore.length} shore samples uncovered`);
  const km = (v: number) => +(v / 1000).toFixed(4);
  out.push(`  {\n    name: '${r.name}',\n    pts: [${r.flat.map(km).join(', ')}],\n    calm: [${calm.map((c) => `[${c.map(km).join(', ')}]`).join(', ')}],\n  },`);
}
console.log(`export const AKL_LAKES: AklLake[] = [\n${out.join('\n')}\n];`);
