/**
 * Bake the LINZ railway centrelines of the Auckland theatre into src/world/terrain/data/auckland-roads.bin
 * (as lines of kind ROAD_RAIL, next to the roads that tools/linz/roads.ts writes; the other lines are kept).
 *
 *   LINZ_API_KEY=… npx vite-node tools/linz/railways.ts [work dir] [preview.svg]
 *
 * Downloads (curl, cached as GeoJSON in the work dir) from the LINZ Data Service WFS:
 *  - NZ Railway Centrelines (Topo, 1:50k, layer 50319): the lines in the theatre, without sidings
 *    and bush tramways;
 *  - NZ Tunnel Centrelines (Topo, 1:50k, layer 50366): the train tunnels.
 * Reprojected with the game's own geoToWorld (WGS84 requested from the WFS; NZGD2000 ≈ WGS84 to < 1 m).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { decodeRoads, encodeRoads, ROAD_RAIL, type RoadLine } from '../../src/world/scenery/aucklandRoads';
import { decodeLinz } from '../../src/world/terrain/theaters/aucklandLinz';
import { HF_EXTENT } from '../../src/world/terrain/types';
import { chain, densify, dirAt, fetchWfs, lines, runs, segDist, simplify, type Pt } from './polyline';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const WORK = process.argv[2] ?? path.join(os.tmpdir(), 'f35-linz-rail');
const SVG = process.argv[3] ?? null;
const OUT = path.join(HERE, '../../src/world/terrain/data/auckland-roads.bin');
fs.mkdirSync(WORK, { recursive: true });

// World box ±44 km in NZTM (northing, easting) for the Topo50 layers' BBOX filters
const NZTM_BOX = 'BBOX(GEOMETRY,5880000,1710000,5965000,1800000)';
const rail = fetchWfs(WORK, 'railways.json', 'layer-50319', NZTM_BOX);
const tunnels = fetchWfs(WORK, 'train-tunnels.json', 'layer-50366', `${NZTM_BOX} AND use1='train'`);

/** Formation width (m): ballast shoulders included, so a double track reads from altitude. */
const WIDTH = { single: 6, multiple: 11 } as const;

// ── Tunnels ──
const tunnelLines = tunnels.flatMap(lines).filter((l) => l.length > 1);
/** True where the line runs along a train tunnel between its portals (not where it crosses over one). */
function inTunnel(p: Pt, dir: Pt): boolean {
  for (const t of tunnelLines) {
    let total = 0;
    for (let i = 0; i + 1 < t.length; i++) total += Math.hypot(t[i + 1][0] - t[i][0], t[i + 1][1] - t[i][1]);
    let s = 0;
    for (let i = 0; i + 1 < t.length; i++) {
      const tx = t[i + 1][0] - t[i][0];
      const tz = t[i + 1][1] - t[i][1];
      const l = Math.hypot(tx, tz);
      const u = l > 0 ? ((p[0] - t[i][0]) * tx + (p[1] - t[i][1]) * tz) / (l * l) : 0;
      const along = s + Math.max(0, Math.min(1, u)) * l;
      s += l;
      if (u < -0.01 || u > 1.01 || segDist(p[0], p[1], t[i], t[i + 1]) > 25) continue;
      const cos = Math.abs(tx * dir[0] + tz * dir[1]) / (l * Math.hypot(dir[0], dir[1]) || 1);
      if (cos > 0.8 && along > 10 && along < total - 10) return true;
    }
  }
  return false;
}

// ── Lines ──
// sidings (yards, freight spurs) and the Waitākere bush tramways are left out
const kept = rail.filter((f) => f.properties.rway_use !== 'siding' && f.properties.veh_type !== 'tram');
const secs = kept.flatMap((f) => {
  const track = f.properties.track_type === 'multiple' ? 'multiple' : 'single';
  const name = String(f.properties.name ?? '');
  return lines(f).map((pts) => ({ group: `${name}|${track}`, pts }));
});
// the WFS returns whole features: the North Auckland Line runs on to Whangārei
const HALF = HF_EXTENT / 2;
const inWorld = (p: Pt) => Math.abs(p[0]) < HALF && Math.abs(p[1]) < HALF;
const out: RoadLine[] = [];
for (const c of chain(secs)) {
  const [name, track] = c.group.split('|') as [string, keyof typeof WIDTH];
  const pts = densify(c.pts, 8);
  const tun = Uint8Array.from(pts, (p, i) => (inTunnel(p, dirAt(pts, i)) ? 1 : 0));
  for (const r of runs(pts, (p, i) => (inWorld(p) ? tun[i] : -1))) {
    const s = simplify(r.pts, 1.5);
    if (s.length > 1) out.push({ name, kind: ROAD_RAIL, width: WIDTH[track], tunnel: r.flag === 1, pts: Float32Array.from(s.flat()) });
  }
}

// ── Write (the roads already in the file are kept) ──
const old = decodeRoads(new Uint8Array(zlib.gunzipSync(fs.readFileSync(OUT))));
const roads = old.lines.filter((l) => l.kind !== ROAD_RAIL);
const raw = encodeRoads({ region: old.region, lines: roads.concat(out) }, 0.5);
const gz = zlib.gzipSync(raw, { level: 9 });
fs.writeFileSync(OUT, gz);
const km = (ls: RoadLine[]) => ls.reduce((s, l) => s + l.pts.reduce((a, _, i, p) => (i >= 2 && i % 2 === 0 ? a + Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]) : a), 0), 0) / 1000;
const names = new Map<string, RoadLine[]>();
for (const l of out) names.set(l.name || '(unnamed)', [...(names.get(l.name || '(unnamed)') ?? []), l]);
for (const [n, ls] of names) console.log(`${n}: ${ls.length} lines, ${km(ls).toFixed(1)} km, ${ls.filter((l) => l.tunnel).length} tunnel runs`);
console.log(`railways: ${out.length} lines, ${km(out).toFixed(1)} km, ${out.reduce((s, l) => s + l.pts.length / 2, 0)} vertices; ${roads.length} road lines kept`);
console.log(`wrote ${OUT}: ${raw.length} bytes raw, ${gz.length} bytes gzip`);

if (SVG) {
  // SVG_BOX="x0,z0,x1,z1" (m) picks another view
  const [x0, z0, x1, z1] = (process.env.SVG_BOX ?? '-44000,-44000,44000,44000').split(',').map(Number);
  const sc = 1400 / (x1 - x0);
  const tr = (x: number, z: number) => `${((x - x0) * sc).toFixed(1)},${((z - z0) * sc).toFixed(1)}`;
  const linz = decodeLinz(new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(HERE, '../../src/world/terrain/data/auckland-linz.bin')))));
  let body = '';
  for (const r of linz.rings) {
    const pts: string[] = [];
    for (let i = 0; i < r.length; i += 2) pts.push(tr(r[i], r[i + 1]));
    body += `<polyline points="${pts.join(' ')}" fill="none" stroke="#6af" stroke-width="1"/>`;
  }
  for (const l of roads) {
    if (l.kind !== 1) continue;
    const pts: string[] = [];
    for (let i = 0; i < l.pts.length; i += 2) pts.push(tr(l.pts[i], l.pts[i + 1]));
    body += `<polyline points="${pts.join(' ')}" fill="none" stroke="#e99" stroke-width="1"/>`;
  }
  for (const l of out) {
    const pts: string[] = [];
    for (let i = 0; i < l.pts.length; i += 2) pts.push(tr(l.pts[i], l.pts[i + 1]));
    body += `<polyline points="${pts.join(' ')}" fill="none" stroke="${l.tunnel ? '#fa0' : l.width > 8 ? '#000' : '#555'}" stroke-width="${Math.max(1.2, l.width * sc)}"/>`;
  }
  fs.writeFileSync(SVG, `<svg xmlns="http://www.w3.org/2000/svg" width="${(x1 - x0) * sc}" height="${(z1 - z0) * sc}"><rect width="100%" height="100%" fill="#fff"/>${body}</svg>`);
  console.log(`wrote ${SVG}`);
}
