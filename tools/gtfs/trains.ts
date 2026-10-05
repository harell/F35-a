/**
 * Bake Auckland's train network (#146) into src/sim/civil/railData.ts: the track shapes and stations of the
 * three post-CRL Auckland Transport lines (East-West, South-City, Onehunga-West) from AT's GTFS feed, both
 * directions, with the GTFS stop times of one representative weekday trip each, plus the KiwiRail
 * container path between the Ports of Auckland and the Wiri Inland Port, each way.
 *
 *   npx vite-node tools/gtfs/trains.ts [work dir]
 *
 * Downloads (cached in the work dir):
 *  - https://gtfs.at.govt.nz/gtfs.zip (Auckland Transport GTFS, CC BY 4.0): shapes.txt, stops.txt,
 *    trips.txt, stop_times.txt;
 *  - OpenStreetMap (main API, ODbL): the CRL / Britomart / Parnell tunnels (rail ways tagged
 *    tunnel=yes in three bounding boxes) and the freight-only track the GTFS and LINZ lack: the link
 *    from the port's siding to the main line and POAL Road 1 at Wiri (ways by id).
 * The port's siding itself is the LINZ line (auckland-roads.bin), so the freight runs on the drawn ribbon.
 * Tunnels also come from the LINZ rail ribbons already baked in auckland-roads.bin (New Lynn trench,
 * Britomart, Parnell). The three underground CRL stations are tunnel whatever the tagging says.
 *
 * Prints, per path, its length, vertex count, how far each GTFS stop lies off the track, and how far
 * the track runs from the LINZ ribbons (the CRL is not in LINZ: there the GTFS shape wins).
 *
 * Format of the base64 blob (little-endian): 'AKLT' | u8 version | f32 quantum (m) | varint names |
 * names (u8 length + UTF-8) | varint paths | per path: u8 line, u8 dir, varint vertex count, vertices
 * (zig-zag varint deltas in quanta from the previous vertex, the first from the origin), varint tunnel
 * runs, runs (varint start, varint length, in whole metres along the path, the start a delta from the
 * previous run's end), varint stops, stops (varint name, varint s along the path in decimetres as a
 * delta from the previous stop, varint GTFS departure time in s since the trip's first departure,
 * zig-zag varint GTFS stop x and z in quanta).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { geoToWorld } from '../../src/core/auckland';
import { decodeRoads, ROAD_RAIL } from '../../src/world/scenery/aucklandRoads';
import { simplify, type Pt } from '../linz/polyline';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const WORK = process.argv[2] ?? path.join(os.tmpdir(), 'f35-gtfs');
const OUT = path.join(HERE, '../../src/sim/civil/railData.ts');
fs.mkdirSync(WORK, { recursive: true });

const GTFS_URL = 'https://gtfs.at.govt.nz/gtfs.zip';
const OSM_API = 'https://api.openstreetmap.org/api/0.6';
/** Quantum of the vertices (m). */
const Q = 0.25;
/** Douglas–Peucker tolerance of the baked track (m): the cars are posed on chords between bogies. */
const TOL = 0.6;

// line ids: what the runtime (src/sim/civil/rail.ts RAIL_LINES) indexes
const LINE = { EW: 0, SC: 1, OW: 2, FREIGHT: 3 } as const;
/** The main weekday shape of each line and direction (the most frequent in trips.txt, 2026-09-17 feed). */
const SHAPES: { line: number; dir: number; shape: string }[] = [
  { line: LINE.EW, dir: 0, shape: '258-880001-a7ac99b9' }, // Manukau → Swanson via Waitematā
  { line: LINE.EW, dir: 1, shape: '258-880002-bf21076d' }, // Swanson → Manukau via Waitematā
  { line: LINE.SC, dir: 0, shape: '257-870005-926893b6' }, // Pukekohe → Newmarket, clockwise round the CRL
  { line: LINE.SC, dir: 1, shape: '257-870006-370b2aed' }, // Newmarket → Pukekohe, anticlockwise
  { line: LINE.OW, dir: 0, shape: '259-860001-f60817d2' }, // Onehunga → Henderson via Newmarket
  { line: LINE.OW, dir: 1, shape: '259-860002-6b6c52a7' }, // Henderson → Onehunga
];
/** Underground stations (CRL): ± this many metres of track round them are tunnel. */
const UNDERGROUND = ['Waitemata', 'Te Waihorotiu', 'Karanga-a-Hape'];
const UNDERGROUND_HALF = 170;
/** OSM boxes searched for tunnel=yes railways (lon0, lat0, lon1, lat1): CRL south, CRL north + Britomart, Parnell. */
const TUNNEL_BOXES = [
  [174.754, -36.871, 174.764, -36.856],
  [174.758, -36.857, 174.775, -36.842],
  [174.775, -36.865, 174.785, -36.852],
];
/**
 * The port's rail siding along Quay St / The Strand: the LINZ line (the drawn ribbon) from the yard by Quay Park
 * east to where OSM's link to the main line (way 371690641) leaves it.
 */
const PORT_LINK_WAY = 371690641;
/** A point on the LINZ port line (picks it out) and where the link leaves it. */
const PORT_LINE_AT: Pt = [1600, -200];
const PORT_LINK_AT: Pt = [2366, -57];
/** POAL Road 1 at Wiri (the inland port's siding), main-line end first after chaining. */
const WIRI_WAYS = [830631749];

// ───────────────────────── downloads ─────────────────────────

function cached(file: string, url: string): string {
  const out = path.join(WORK, file);
  if (!fs.existsSync(out)) {
    console.log(`fetching ${url} …`);
    execFileSync('curl', ['-sSfL', '--max-time', '600', url, '-o', out + '.part']);
    fs.renameSync(out + '.part', out);
  }
  return out;
}

const zip = cached('gtfs.zip', GTFS_URL);
const GT = path.join(WORK, 'gtfs');
if (!fs.existsSync(path.join(GT, 'stop_times.txt'))) {
  fs.mkdirSync(GT, { recursive: true });
  execFileSync('unzip', ['-o', '-q', zip, 'shapes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt', 'feed_info.txt', '-d', GT]);
}

/** One CSV line (quoted fields may hold commas: "Pukekohe 3 Clockwise To Newmarket 2 Via NKT1, PPK 3"). */
function splitCsv(l: string): string[] {
  if (!l.includes('"')) return l.split(',');
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (c === '"') {
      if (q && l[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (c === ',' && !q) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}
function csvRows(file: string): Record<string, string>[] {
  const lines = fs.readFileSync(path.join(GT, file), 'utf8').split(/\r?\n/).filter((l) => l.length);
  const head = lines[0].replace(/^\uFEFF/, '').split(',');
  return lines.slice(1).map((l) => {
    const v = splitCsv(l);
    return Object.fromEntries(head.map((h, i) => [h, v[i] ?? '']));
  });
}
async function streamRows(file: string, keep: (r: Record<string, string>) => boolean): Promise<Record<string, string>[]> {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(GT, file)) });
  let head: string[] | null = null;
  const out: Record<string, string>[] = [];
  for await (const l of rl) {
    if (!l) continue;
    if (!head) {
      head = l.replace(/^\uFEFF/, '').split(',');
      continue;
    }
    const v = splitCsv(l);
    const r = Object.fromEntries(head.map((h, i) => [h, v[i] ?? '']));
    if (keep(r)) out.push(r);
  }
  return out;
}

interface OsmWay {
  id: number;
  tags: Record<string, string>;
  pts: Pt[];
}
function parseOsm(xml: string): OsmWay[] {
  const nodes = new Map<string, Pt>();
  for (const m of xml.matchAll(/<node id="(\d+)"[^>]*?lat="([-\d.]+)" lon="([-\d.]+)"/g)) {
    const p = geoToWorld(+m[2], +m[3]);
    nodes.set(m[1], [p.x, p.z]);
  }
  const ways: OsmWay[] = [];
  for (const m of xml.matchAll(/<way id="(\d+)"[^>]*>([\s\S]*?)<\/way>/g)) {
    const pts = [...m[2].matchAll(/<nd ref="(\d+)"/g)].map((r) => nodes.get(r[1])).filter((p): p is Pt => !!p);
    const tags = Object.fromEntries([...m[2].matchAll(/<tag k="([^"]+)" v="([^"]*)"/g)].map((t) => [t[1], t[2]]));
    ways.push({ id: +m[1], tags, pts });
  }
  return ways;
}
const osmFile = (file: string, q: string) => fs.readFileSync(cached(file, `${OSM_API}/${q}`), 'utf8');

// ───────────────────────── geometry ─────────────────────────

const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);
function cumulative(p: Pt[]): number[] {
  const s = [0];
  for (let i = 1; i < p.length; i++) s.push(s[i - 1] + dist(p[i - 1], p[i]));
  return s;
}
/** Nearest point of a polyline: its distance along it, the perpendicular distance, the segment and fraction. */
function project(pl: Pt[], cum: number[], q: Pt, from = 0, to = pl.length - 1): { s: number; d: number; i: number; u: number } {
  let best = { s: 0, d: Infinity, i: 0, u: 0 };
  for (let i = from; i < to; i++) {
    const a = pl[i];
    const b = pl[i + 1];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    const u = l2 > 0 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dz) / l2)) : 0;
    const d = Math.hypot(a[0] + dx * u - q[0], a[1] + dz * u - q[1]);
    if (d < best.d) best = { s: cum[i] + u * Math.sqrt(l2), d, i, u };
  }
  return best;
}
function densify(p: Pt[], step: number): Pt[] {
  const out: Pt[] = [p[0]];
  for (let i = 1; i < p.length; i++) {
    const n = Math.max(1, Math.ceil(dist(p[i - 1], p[i]) / step));
    for (let k = 1; k <= n; k++) out.push([p[i - 1][0] + ((p[i][0] - p[i - 1][0]) * k) / n, p[i - 1][1] + ((p[i][1] - p[i - 1][1]) * k) / n]);
  }
  return out;
}
/**
 * Clean a GTFS shape into a track the cars can follow: the shapes jog 1–3 m sideways and double back a
 * few metres where they were snapped to stops (≈ 800 turns over 30° on the six shapes). Drop the spikes
 * (points the line turns back at) and points within 2 m of the last kept one, resample every 4 m, smooth with a ±12 m binomial
 * window (a 150 m curve moves ≈ 0.2 m), keep the ends.
 */
function clean(raw: Pt[]): Pt[] {
  // drop spikes (a point the line turns back at, > 90°) until there are none, then points within 2 m
  let pts = raw.slice();
  for (let pass = 0; pass < 20; pass++) {
    const out: Pt[] = [pts[0]];
    for (let i = 1; i + 1 < pts.length; i++) {
      const a = out[out.length - 1];
      const p = pts[i];
      const b = pts[i + 1];
      if ((p[0] - a[0]) * (b[0] - p[0]) + (p[1] - a[1]) * (b[1] - p[1]) < 0) continue;
      out.push(p);
    }
    out.push(pts[pts.length - 1]);
    const done = out.length === pts.length;
    pts = out;
    if (done) break;
  }
  const kept: Pt[] = [pts[0]];
  for (const p of pts.slice(1, -1)) if (dist(kept[kept.length - 1], p) >= 2) kept.push(p);
  kept.push(pts[pts.length - 1]);
  // resample every 4 m
  const cum = cumulative(kept);
  const total = cum[cum.length - 1];
  const n = Math.max(2, Math.round(total / 4));
  const res: Pt[] = [];
  let k = 0;
  for (let i = 0; i <= n; i++) {
    const s = (total * i) / n;
    while (k + 1 < cum.length - 1 && cum[k + 1] < s) k++;
    const l = cum[k + 1] - cum[k] || 1;
    const u = (s - cum[k]) / l;
    res.push([kept[k][0] + (kept[k + 1][0] - kept[k][0]) * u, kept[k][1] + (kept[k + 1][1] - kept[k][1]) * u]);
  }
  // binomial smoothing (1 4 6 4 1), three passes, the ends fixed
  let cur = res;
  for (let pass = 0; pass < 3; pass++) {
    const nx: Pt[] = cur.map((p) => [p[0], p[1]]);
    for (let i = 2; i + 2 < cur.length; i++) {
      for (const c of [0, 1]) nx[i][c] = (cur[i - 2][c] + 4 * cur[i - 1][c] + 6 * cur[i][c] + 4 * cur[i + 1][c] + cur[i + 2][c]) / 16;
    }
    cur = nx;
  }
  return cur;
}

/** The part of `pl` between its nearest points to `a` and `b` (a before b along it). */
function between(pl: Pt[], a: Pt, b: Pt): Pt[] {
  const cum = cumulative(pl);
  const pa = project(pl, cum, a);
  const pb = project(pl, cum, b, pa.i);
  const at = (r: { i: number; u: number }): Pt => [pl[r.i][0] + (pl[r.i + 1][0] - pl[r.i][0]) * r.u, pl[r.i][1] + (pl[r.i + 1][1] - pl[r.i][1]) * r.u];
  return [at(pa), ...pl.slice(pa.i + 1, pb.i + 1), at(pb)];
}
/** Chain OSM ways end to end (in the order given, each flipped to continue the last). */
function chainWays(ways: OsmWay[]): Pt[] {
  let out: Pt[] = ways[0].pts.slice();
  for (const w of ways.slice(1)) {
    const p = w.pts;
    const end = out[out.length - 1];
    const start = out[0];
    if (out.length === ways[0].pts.length && Math.min(dist(start, p[0]), dist(start, p[p.length - 1])) < Math.min(dist(end, p[0]), dist(end, p[p.length - 1]))) out.reverse();
    const e = out[out.length - 1];
    out = out.concat((dist(e, p[0]) <= dist(e, p[p.length - 1]) ? p : p.slice().reverse()).slice(1));
  }
  return out;
}
/** Join polylines; consecutive ones overlap or nearly meet (≤ a few metres at a junction). */
function join(parts: Pt[][]): Pt[] {
  let out: Pt[] = [];
  for (const p of parts) {
    if (out.length && dist(out[out.length - 1], p[0]) > 25) console.warn(`  ! join gap ${dist(out[out.length - 1], p[0]).toFixed(1)} m`);
    out = out.concat(out.length && dist(out[out.length - 1], p[0]) < 0.5 ? p.slice(1) : p);
  }
  return out;
}

// ───────────────────────── GTFS ─────────────────────────

const feed = csvRows('feed_info.txt')[0];
const stops = new Map(csvRows('stops.txt').map((r) => [r.stop_id, r]));
const shapeIds = new Set(SHAPES.map((s) => s.shape));
const shapePts = new Map<string, { seq: number; p: Pt }[]>();
for (const r of await streamRows('shapes.txt', (r) => shapeIds.has(r.shape_id))) {
  const w = geoToWorld(+r.shape_pt_lat, +r.shape_pt_lon);
  const l = shapePts.get(r.shape_id) ?? [];
  l.push({ seq: +r.shape_pt_sequence, p: [w.x, w.z] });
  shapePts.set(r.shape_id, l);
}
const trips = csvRows('trips.txt').filter((t) => shapeIds.has(t.shape_id) && t.service_id.startsWith('Weekday'));
const tripIds = new Set(trips.map((t) => t.trip_id));
const times = new Map<string, Record<string, string>[]>();
for (const r of await streamRows('stop_times.txt', (r) => tripIds.has(r.trip_id))) {
  const l = times.get(r.trip_id) ?? [];
  l.push(r);
  times.set(r.trip_id, l);
}
const secs = (t: string) => t.split(':').reduce((a, v) => a * 60 + +v, 0);

// ───────────────────────── tunnels ─────────────────────────

const tunnelLines: Pt[][] = [];
/** The boxes cut into cells of at most 0.005° (the API refuses a map call over 50,000 nodes: the CBD is dense). */
const CELL = 0.005;
const seenWays = new Set<number>();
for (const [x0, y0, x1, y1] of TUNNEL_BOXES) {
  const nx = Math.ceil((x1 - x0) / CELL - 1e-9);
  const ny = Math.ceil((y1 - y0) / CELL - 1e-9);
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++) {
      const b = [x0 + i * CELL, y0 + j * CELL, Math.min(x1, x0 + (i + 1) * CELL), Math.min(y1, y0 + (j + 1) * CELL)].map((v) => v.toFixed(4));
      for (const w of parseOsm(osmFile(`osm-tunnels-${b.join('_')}.osm`, `map?bbox=${b.join(',')}`))) {
        if (seenWays.has(w.id) || w.tags.railway !== 'rail' || w.tags.tunnel !== 'yes' || w.pts.length < 2) continue;
        seenWays.add(w.id);
        tunnelLines.push(w.pts);
      }
    }
}
const osmTunnels = tunnelLines.length;
let roadsBuf = fs.readFileSync(path.join(HERE, '../../src/world/terrain/data/auckland-roads.bin'));
if (roadsBuf[0] === 0x1f) roadsBuf = zlib.gunzipSync(roadsBuf);
const linz = decodeRoads(new Uint8Array(roadsBuf)).lines.filter((l) => l.kind === ROAD_RAIL);
const linzLines: Pt[][] = linz.map((l) => Array.from({ length: l.pts.length / 2 }, (_, i): Pt => [l.pts[2 * i], l.pts[2 * i + 1]]));
for (const l of linz) if (l.tunnel) tunnelLines.push(Array.from({ length: l.pts.length / 2 }, (_, i): Pt => [l.pts[2 * i], l.pts[2 * i + 1]]));
console.log(`tunnels: ${osmTunnels} OSM ways, ${tunnelLines.length - osmTunnels} LINZ lines`);

/** Along a tunnel line, in its direction (not crossing over or under one). */
function inTunnel(p: Pt, dir: Pt): boolean {
  for (const t of tunnelLines) {
    for (let i = 0; i + 1 < t.length; i++) {
      const tx = t[i + 1][0] - t[i][0];
      const tz = t[i + 1][1] - t[i][1];
      const l = Math.hypot(tx, tz);
      if (l < 1e-6) continue;
      const u = ((p[0] - t[i][0]) * tx + (p[1] - t[i][1]) * tz) / (l * l);
      if (u < -0.02 || u > 1.02) continue;
      const d = Math.abs((p[0] - t[i][0]) * tz - (p[1] - t[i][1]) * tx) / l;
      if (d > 14) continue;
      if (Math.abs(tx * dir[0] + tz * dir[1]) / (l * (Math.hypot(dir[0], dir[1]) || 1)) > 0.85) return true;
    }
  }
  return false;
}
/** Tunnel runs along a path as [s0, s1] (m): tunnel lines, the underground stations, short gaps closed. */
function tunnelRuns(pl: Pt[], stopsAt: { name: string; s: number }[]): [number, number][] {
  const d = densify(pl, 5);
  const cum = cumulative(d);
  const flag = d.map((p, i) => inTunnel(p, [d[Math.min(d.length - 1, i + 1)][0] - d[Math.max(0, i - 1)][0], d[Math.min(d.length - 1, i + 1)][1] - d[Math.max(0, i - 1)][1]]));
  for (const st of stopsAt) if (UNDERGROUND.some((u) => st.name.startsWith(u))) cum.forEach((s, i) => Math.abs(s - st.s) <= UNDERGROUND_HALF && (flag[i] = true));
  let out: [number, number][] = [];
  for (let i = 0; i < d.length; i++) {
    if (!flag[i]) continue;
    let j = i;
    while (j + 1 < d.length && flag[j + 1]) j++;
    out.push([cum[i], cum[j]]);
    i = j;
  }
  // close gaps under 60 m (a portal kink), drop runs under 30 m (a bridge over a tunnel)
  const merged: [number, number][] = [];
  for (const r of out) {
    const last = merged[merged.length - 1];
    if (last && r[0] - last[1] < 60) last[1] = r[1];
    else merged.push([r[0], r[1]]);
  }
  out = merged.filter((r) => r[1] - r[0] >= 30);
  return out;
}

// ───────────────────────── paths ─────────────────────────

interface Stop {
  name: string;
  /** Along the path (m). */
  s: number;
  /** GTFS departure (s since the trip's first departure). */
  t: number;
  gx: number;
  gz: number;
}
interface PathOut {
  line: number;
  dir: number;
  pts: Pt[];
  tunnels: [number, number][];
  stops: Stop[];
}
const paths: PathOut[] = [];
const shapeLine = new Map<string, Pt[]>();

for (const sh of SHAPES) {
  const raw = (shapePts.get(sh.shape) ?? []).sort((a, b) => a.seq - b.seq).map((r) => r.p);
  const track = clean(raw);
  const pl = simplify(track, TOL);
  shapeLine.set(sh.shape, track);
  const cum = cumulative(pl);
  // the representative trip: the median weekday departure of this shape
  const ts = trips.filter((t) => t.shape_id === sh.shape && times.has(t.trip_id)).map((t) => ({ t, rows: times.get(t.trip_id)!.sort((a, b) => +a.stop_sequence - +b.stop_sequence) }));
  ts.sort((a, b) => secs(a.rows[0].departure_time) - secs(b.rows[0].departure_time));
  const rep = ts[Math.floor(ts.length / 2)];
  const t0 = secs(rep.rows[0].departure_time);
  // each stop is searched for near its GTFS shape_dist_traveled (km; scaled to the cleaned track), so the
  // South-City's two calls at Newmarket (before and after the CRL loop) each find their own pass
  const scale = cum[cum.length - 1] / (1000 * +rep.rows[rep.rows.length - 1].shape_dist_traveled);
  const st: Stop[] = rep.rows.map((r) => {
    const s = stops.get(r.stop_id)!;
    const g = geoToWorld(+s.stop_lat, +s.stop_lon);
    const sd = 1000 * +r.shape_dist_traveled * scale;
    let i0 = 0;
    while (i0 + 1 < cum.length - 1 && cum[i0 + 1] < sd - 400) i0++;
    let i1 = i0;
    while (i1 < cum.length - 1 && cum[i1] < sd + 400) i1++;
    const pr = project(pl, cum, [g.x, g.z], i0, i1);
    return { name: s.stop_name.replace(/ Train Station.*$/, ''), s: pr.s, t: secs(r.departure_time) - t0, gx: g.x, gz: g.z, off: pr.d } as Stop & { off: number };
  });
  const offs = (st as (Stop & { off: number })[]).map((x) => x.off);
  const tunnels = tunnelRuns(pl, st);
  console.log(
    `${sh.shape} line ${sh.line} dir ${sh.dir}: ${(cum[cum.length - 1] / 1000).toFixed(2)} km, ${raw.length} → ${pl.length} vertices, ${st.length} stops (${st[0].name} → ${st[st.length - 1].name}, ${(st[st.length - 1].t / 60).toFixed(0)} min), stop off-track max ${Math.max(...offs).toFixed(1)} m, tunnels ${tunnels.map((r) => `${r[0].toFixed(0)}–${r[1].toFixed(0)}`).join(' ')}`,
  );
  paths.push({ line: sh.line, dir: sh.dir, pts: pl, tunnels, stops: st });
}

// ── freight: the port's siding → the Eastern Line → the main trunk → POAL Road 1 at Wiri, and back ──
const portLinz = linzLines
  .filter((l, i) => !linz[i].tunnel)
  .map((l) => ({ l, d: project(l, cumulative(l), PORT_LINE_AT).d }))
  .sort((a, b) => a.d - b.d)[0].l;
const portLine = portLinz[0][0] < portLinz[portLinz.length - 1][0] ? portLinz : portLinz.slice().reverse();
const link = parseOsm(osmFile(`osm-way-${PORT_LINK_WAY}.osm`, `way/${PORT_LINK_WAY}/full`)).find((w) => w.id === PORT_LINK_WAY)!.pts;
const linkE = link[0][0] < link[link.length - 1][0] ? link : link.slice().reverse();
const port = join([between(portLine, portLine[0], PORT_LINK_AT), between(linkE, PORT_LINK_AT, linkE[linkE.length - 1])]);
let wiri = chainWays(WIRI_WAYS.map((id) => parseOsm(osmFile(`osm-way-${id}.osm`, `way/${id}/full`)).find((w) => w.id === id)!));
// port: west (the yard by Quay Park) first; POAL Road 1: the main-line end (north) first
if (port[0][0] > port[port.length - 1][0]) port.reverse();
if (wiri[0][1] > wiri[wiri.length - 1][1]) wiri = wiri.reverse();
const portJn = port[port.length - 1];
const wiriJn = wiri[0];
const ew1 = shapeLine.get('258-880002-bf21076d')!;
const ew0 = shapeLine.get('258-880001-a7ac99b9')!;
const sc1 = shapeLine.get('257-870006-370b2aed')!;
const sc0 = shapeLine.get('257-870005-926893b6')!;
const puhinui = (() => {
  const s = [...stops.values()].find((r) => r.stop_name.startsWith('Puhinui Train Station'))!;
  const g = geoToWorld(+s.stop_lat, +s.stop_lon);
  return [g.x, g.z] as Pt;
})();
const toWiri = join([port, between(ew1, portJn, puhinui), between(sc1, puhinui, wiriJn), wiri]);
const toPort = join([wiri.slice().reverse(), between(sc0, wiriJn, puhinui), between(ew0, puhinui, portJn), port.slice().reverse()]);
for (const [dir, raw] of [[0, toWiri], [1, toPort]] as const) {
  const pl = simplify(clean(raw), TOL);
  const cum = cumulative(pl);
  const len = cum[cum.length - 1];
  const tunnels = tunnelRuns(pl, []);
  console.log(`freight dir ${dir}: ${(len / 1000).toFixed(2)} km, ${pl.length} vertices, tunnels ${tunnels.map((r) => `${r[0].toFixed(0)}–${r[1].toFixed(0)}`).join(' ') || 'none'}`);
  // the ends: the yard at the port, the inland port's siding (no GTFS: the runtime places the consist)
  const [a, b] = dir === 0 ? ['Ports of Auckland', 'Wiri Inland Port'] : ['Wiri Inland Port', 'Ports of Auckland'];
  paths.push({ line: LINE.FREIGHT, dir, pts: pl, tunnels, stops: [{ name: a, s: 0, t: 0, gx: pl[0][0], gz: pl[0][1] }, { name: b, s: len, t: 0, gx: pl[pl.length - 1][0], gz: pl[pl.length - 1][1] }] });
}

// ── against the LINZ ribbons ──
for (const p of paths) {
  const d = densify(p.pts, 25);
  const cum = cumulative(d);
  const off: number[] = [];
  let worst = { d: 0, s: 0 };
  d.forEach((q, i) => {
    if (p.tunnels.some((r) => cum[i] >= r[0] - 50 && cum[i] <= r[1] + 50)) return;
    let m = Infinity;
    for (const l of linzLines) for (let k = 0; k + 1 < l.length; k++) {
      const a = l[k];
      const b = l[k + 1];
      if (Math.min(a[0], b[0]) > q[0] + 400 || Math.max(a[0], b[0]) < q[0] - 400) continue;
      if (Math.min(a[1], b[1]) > q[1] + 400 || Math.max(a[1], b[1]) < q[1] - 400) continue;
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const l2 = dx * dx + dz * dz;
      const u = l2 > 0 ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dz) / l2)) : 0;
      m = Math.min(m, Math.hypot(a[0] + dx * u - q[0], a[1] + dz * u - q[1]));
    }
    if (m === Infinity) m = 400; // no LINZ line within 400 m (off the LINZ model)
    off.push(m);
    if (m > worst.d) worst = { d: m, s: cum[i] };
  });
  off.sort((a, b) => a - b);
  const pc = (k: number) => off[Math.min(off.length - 1, Math.floor(off.length * k))].toFixed(1);
  console.log(`  line ${p.line} dir ${p.dir} vs LINZ ribbons (outside tunnels): median ${pc(0.5)} m, p95 ${pc(0.95)} m, max ${worst.d.toFixed(0)} m at s=${worst.s.toFixed(0)}`);
}

// ───────────────────────── encode ─────────────────────────

const bytes: number[] = [];
const u8 = (v: number) => bytes.push(v & 255);
const varint = (v: number) => {
  v = Math.round(v);
  if (v < 0) throw new Error(`negative varint ${v}`);
  while (v >= 128) {
    u8((v & 127) | 128);
    v = Math.floor(v / 128);
  }
  u8(v);
};
const zz = (v: number) => varint(v >= 0 ? v * 2 : -v * 2 - 1);
for (const c of 'AKLT') u8(c.charCodeAt(0));
u8(1);
const f = new DataView(new ArrayBuffer(4));
f.setFloat32(0, Q, true);
for (let i = 0; i < 4; i++) u8(f.getUint8(i));
const names: string[] = [];
const nameId = (n: string) => (names.includes(n) ? names.indexOf(n) : names.push(n) - 1);
for (const p of paths) for (const s of p.stops) nameId(s.name);
varint(names.length);
for (const n of names) {
  const b = Buffer.from(n, 'utf8');
  u8(b.length);
  for (const x of b) u8(x);
}
varint(paths.length);
for (const p of paths) {
  u8(p.line);
  u8(p.dir);
  varint(p.pts.length);
  let px = 0;
  let pz = 0;
  for (const [x, z] of p.pts) {
    const qx = Math.round(x / Q);
    const qz = Math.round(z / Q);
    zz(qx - px);
    zz(qz - pz);
    px = qx;
    pz = qz;
  }
  varint(p.tunnels.length);
  let end = 0;
  for (const [a, b] of p.tunnels) {
    const s0 = Math.round(a);
    varint(s0 - end);
    varint(Math.round(b) - s0);
    end = Math.round(b);
  }
  varint(p.stops.length);
  let ps = 0;
  for (const s of p.stops) {
    const ds = Math.round(s.s * 10);
    varint(ds - ps);
    ps = ds;
    varint(nameId(s.name));
    varint(s.t);
    zz(Math.round(s.gx / Q));
    zz(Math.round(s.gz / Q));
  }
}
const b64 = Buffer.from(bytes).toString('base64');
const src = `/**
 * GENERATED by tools/gtfs/trains.ts — do not edit. Auckland's train network (#146): the East-West, South-City
 * and Onehunga-West lines (both directions, with one representative weekday trip's GTFS stop times) and the
 * KiwiRail port ↔ Wiri freight path. Decoded by src/sim/civil/rail.ts (format in the tool's header).
 *
 * Sources: Auckland Transport GTFS (${feed.feed_start_date}–${feed.feed_end_date}, CC BY 4.0), © OpenStreetMap
 * contributors (ODbL: tunnels, freight sidings), LINZ Topo50 railway and tunnel centrelines (CC BY 4.0).
 * ${bytes.length} bytes (${b64.length} as base64).
 */
export const RAIL_DATA_B64 =
  '${b64}';
`;
fs.writeFileSync(OUT, src);
console.log(`wrote ${OUT}: ${bytes.length} bytes, ${b64.length} base64 chars, ${names.length} names`);
