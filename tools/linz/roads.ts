/**
 * Bake LINZ road centrelines for the Auckland theatre into src/world/terrain/data/auckland-roads.bin
 * (gzip; decoded by src/world/scenery/aucklandRoads.ts).
 *
 *   LINZ_API_KEY=… npx vite-node tools/linz/roads.ts [work dir] [preview.svg]
 *
 * Downloads (curl, cached as GeoJSON in the work dir) from the LINZ Data Service WFS:
 *  - NZ Addresses: Road Sections (layer 123109, the most accurate centrelines in the cities):
 *    every section in the CBD box, every motorway / state-highway section in the theatre, and the
 *    main arterials by name;
 *  - NZ Tunnel Centrelines (Topo, 1:50k, layer 50366): Victoria Park and Waterview tunnels.
 * Reprojected with the game's own geoToWorld (WGS84 requested from the WFS; NZGD2000 ≈ WGS84 to < 1 m).
 *
 * The CBD region polygon is traced along the real road graph (shortest paths along the SH1 / SH16
 * carriageways and Stanley St / Beach Rd / Quay St) and closed through the harbour, so the seam
 * between the real streets and the procedural suburbs runs under a motorway or along a real street.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { AKL } from '../../src/core/auckland';
import { decodeRoads, encodeRoads, ROAD_ARTERIAL, ROAD_MOTORWAY, ROAD_RAIL, ROAD_STREET, type RoadData, type RoadKind, type RoadLine } from '../../src/world/scenery/aucklandRoads';
import { HAND_ARTERIALS } from '../../src/world/scenery/motorways';
import { decodeLinz, linzIsLand } from '../../src/world/terrain/theaters/aucklandLinz';
import { chain, densify, dirAt, fetchWfs, keyOf, lines, polyDist, project, runs, segDist, simplify, type Feature, type Pt } from './polyline';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const WORK = process.argv[2] ?? path.join(os.tmpdir(), 'f35-linz-roads');
const SVG = process.argv[3] ?? null;
const OUT = path.join(HERE, '../../src/world/terrain/data/auckland-roads.bin');
fs.mkdirSync(WORK, { recursive: true });

const wfs = (file: string, typeName: string, cql: string) => fetchWfs(WORK, file, typeName, cql);

// World box ±44 km (lat/lon order for EPSG:4167 / 4326 BBOX filters, northing/easting for NZTM)
const W = { s: -37.25, n: -36.44, w: 174.26, e: 175.26 };
const CBD = { s: -36.8745, n: -36.8275, w: 174.7365, e: 174.7905 };
const ARTERIAL_NAMES: Record<string, string> = {
  'Dominion Road': 'Dominion Rd',
  'Mount Eden Road': 'Mt Eden Rd',
  'Manukau Road': 'Manukau Rd',
  'Remuera Road': 'Remuera Rd',
  'Sandringham Road': 'Sandringham Rd',
  'New North Road': 'New North Rd',
  'Great North Road': 'Great North Rd',
  'Lake Road': 'Lake Rd',
  'Onewa Road': 'Onewa Rd',
  'East Coast Road': 'East Coast Rd',
};
const streets = wfs('cbd-streets.json', 'layer-123109', `BBOX(shape,${CBD.s},${CBD.w},${CBD.n},${CBD.e})`);
const motorways = wfs('motorways.json', 'layer-123109', `BBOX(shape,${W.s},${W.w},${W.n},${W.e}) AND (road_name_type IN ('Motorway','State Highway') OR full_road_name LIKE '%Motorway%')`);
const arterials = wfs('arterials.json', 'layer-123109', `territorial_authority='Auckland' AND full_road_name IN (${Object.keys(ARTERIAL_NAMES).map((n) => `'${n}'`).join(',')})`);
const tunnels = wfs('tunnels.json', 'layer-50366', `BBOX(GEOMETRY,5880000,1710000,5965000,1800000) AND use1='vehicle'`);

// ── Road graph (for the region border) ──
class Graph {
  readonly nodes: Pt[] = [];
  readonly adj: number[][] = [];
  private readonly ids = new Map<string, number>();
  add(pl: Pt[]): void {
    let prev = -1;
    for (const p of pl) {
      const k = keyOf(p);
      let id = this.ids.get(k);
      if (id === undefined) {
        id = this.nodes.push(p) - 1;
        this.adj.push([]);
        this.ids.set(k, id);
      }
      if (prev >= 0 && prev !== id) {
        this.adj[prev].push(id);
        this.adj[id].push(prev);
      }
      prev = id;
    }
  }
  nearest(x: number, z: number): number {
    let best = 0;
    let bd = Infinity;
    this.nodes.forEach((p, i) => {
      const d = Math.hypot(p[0] - x, p[1] - z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    if (bd > 60) throw new Error(`no road node within 60 m of ${x}, ${z}`);
    return best;
  }
  /** Shortest path (Dijkstra) between the nodes nearest two points. */
  path(from: Pt, to: Pt): Pt[] {
    const s = this.nearest(from[0], from[1]);
    const t = this.nearest(to[0], to[1]);
    const dist = new Float64Array(this.nodes.length).fill(Infinity);
    const prev = new Int32Array(this.nodes.length).fill(-1);
    dist[s] = 0;
    const heap: [number, number][] = [[0, s]];
    const push = (e: [number, number]) => {
      heap.push(e);
      for (let i = heap.length - 1; i > 0; ) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = (): [number, number] => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        for (let i = 0; ; ) {
          const l = i * 2 + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    while (heap.length) {
      const [d, u] = pop();
      if (u === t) break;
      if (d > dist[u]) continue;
      for (const v of this.adj[u]) {
        const nd = d + Math.hypot(this.nodes[u][0] - this.nodes[v][0], this.nodes[u][1] - this.nodes[v][1]);
        if (nd < dist[v]) {
          dist[v] = nd;
          prev[v] = u;
          push([nd, v]);
        }
      }
    }
    if (!Number.isFinite(dist[t])) throw new Error(`no road path ${from} → ${to}`);
    const out: Pt[] = [];
    for (let v = t; v >= 0; v = prev[v]) out.push(this.nodes[v]);
    return out.reverse();
  }
}

// ── Coastline (for the Harbour Bridge clip and the region checks) ──
const linz = decodeLinz(new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(HERE, '../../src/world/terrain/data/auckland-linz.bin')))));
const isLand = (p: Pt) => linzIsLand(linz, p[0], p[1]);

// ── Tunnels ──
const tunnelLines = tunnels.flatMap(lines).filter((l) => l.length > 1);
/**
 * True where a road runs along a vehicle tunnel (not where it merely crosses over one). Short tunnels
 * (Victoria Park, 0.5 km) must match the line closely: the address data there has only the viaduct
 * beside it. Between the portals of long ones (Waterview, 2.4 km) the address centreline is schematic
 * (up to ≈ 200 m off the bored route), so anything parallel between the portals is in the tunnel.
 */
function inTunnel(p: Pt, dir: Pt): boolean {
  for (const t of tunnelLines) {
    let total = 0;
    for (let i = 0; i + 1 < t.length; i++) total += Math.hypot(t[i + 1][0] - t[i][0], t[i + 1][1] - t[i][1]);
    const tol = total > 1000 ? 220 : 22;
    let s = 0;
    for (let i = 0; i + 1 < t.length; i++) {
      const tx = t[i + 1][0] - t[i][0];
      const tz = t[i + 1][1] - t[i][1];
      const l = Math.hypot(tx, tz);
      const u = l > 0 ? ((p[0] - t[i][0]) * tx + (p[1] - t[i][1]) * tz) / (l * l) : 0;
      const along = s + Math.max(0, Math.min(1, u)) * l;
      s += l;
      if (u < -0.01 || u > 1.01 || segDist(p[0], p[1], t[i], t[i + 1]) > tol) continue;
      const cos = Math.abs(tx * dir[0] + tz * dir[1]) / (l * Math.hypot(dir[0], dir[1]) || 1);
      // not at the portals: the approach cuttings stay open
      if (cos > (total > 1000 ? 0.7 : 0.9) && along > 25 && along < total - 25) return true;
    }
  }
  return false;
}

/**
 * Per-vertex tunnel flags of a (densified) polyline: runs shorter than 150 m are dropped (a
 * carriageway passing a portal, or Victoria Park, where the address data has only the viaduct).
 */
function tunnelFlags(pts: Pt[]): Uint8Array {
  const f = Uint8Array.from(pts, (p, i) => (inTunnel(p, dirAt(pts, i)) ? 1 : 0));
  for (let i = 0; i < f.length; ) {
    if (!f[i]) {
      i++;
      continue;
    }
    let j = i;
    let len = 0;
    while (j + 1 < f.length && f[j + 1]) {
      len += Math.hypot(pts[j + 1][0] - pts[j][0], pts[j + 1][1] - pts[j][1]);
      j++;
    }
    if (len < 150) f.fill(0, i, j + 1);
    i = j + 1;
  }
  return f;
}

// Harbour Bridge: the scenery has its own model between the abutments; the ribbons stop at the shore.
const BS: Pt = [AKL.bridge_s.x, AKL.bridge_s.z];
const BN: Pt = [AKL.bridge_n.x, AKL.bridge_n.z];
const onBridge = (p: Pt) => segDist(p[0], p[1], BS, BN) < 80 && !isLand(p);

// ── Motorways ──
const MOTORWAY_WIDTH = 13; // one carriageway (3 lanes + shoulders); the LINZ data has one line per carriageway / ramp
const mwSecs = motorways.flatMap((f) => lines(f).map((pts) => ({ group: String(f.properties.full_road_name), pts })));
const mwGraph = new Graph();
for (const s of mwSecs) mwGraph.add(s.pts);
const out: RoadLine[] = [];
const toLine = (name: string, kind: RoadKind, width: number, tunnel: boolean, pts: Pt[]): RoadLine => ({ name, kind, width, tunnel, pts: Float32Array.from(pts.flat()) });
for (const c of chain(mwSecs)) {
  const pts = densify(c.pts, 8);
  const tun = tunnelFlags(pts);
  for (const r of runs(pts, (p, i) => (onBridge(p) ? -1 : tun[i]))) {
    const pts = simplify(r.pts, 1.5);
    if (pts.length > 1) out.push(toLine(c.group, ROAD_MOTORWAY, MOTORWAY_WIDTH, r.flag === 1, pts));
  }
}

// ── CBD streets ──
const MAJOR = new Set([
  'Queen Street', 'Customs Street East', 'Customs Street West', 'Quay Street', 'Fanshawe Street', 'Hobson Street', 'Nelson Street',
  'Albert Street', 'Symonds Street', 'Karangahape Road', 'Wellesley Street East', 'Wellesley Street West', 'Victoria Street East',
  'Victoria Street West', 'Mayoral Drive', 'Beach Road', 'The Strand', 'Stanley Street', 'Grafton Road', 'Khyber Pass Road',
  'Ponsonby Road', 'Great North Road', 'New North Road', 'Newton Road', 'Parnell Rise', 'Anzac Avenue', 'Upper Queen Street',
  'Cook Street', 'Union Street', 'Pitt Street', 'Halsey Street', 'Princes Street', 'Kitchener Street', 'Shortland Street',
  'Ian McKinnon Drive', 'Gore Street', 'Jellicoe Street', 'Market Place', 'Wakefield Street', 'Vincent Street',
]);
const LANES = new Set(['Lane', 'Place', 'Accessway', 'Service Lane', 'Close', 'Spur', 'Grove']);
const PEDESTRIAN = new Set(['Steps', 'Walk', 'Track', 'Te Ara', 'Arcade']);
function streetWidth(p: Feature['properties']): number | null {
  const n = String(p.full_road_name ?? '');
  const t = p.road_name_type as string | null;
  if (/Marina|Boardwalk|Arcade|Motorway|State Highway/.test(n) || (t && (PEDESTRIAN.has(t) || t === 'Motorway' || t === 'State Highway'))) return null;
  if (MAJOR.has(n)) return 19;
  if (t && LANES.has(t)) return 7;
  return 12;
}
const stSecs: { group: string; pts: Pt[] }[] = [];
const stGraph = new Graph();
for (const f of streets) {
  const w = streetWidth(f.properties);
  for (const pts of lines(f)) {
    stGraph.add(pts);
    if (w !== null) stSecs.push({ group: `${f.properties.full_road_name ?? ''}|${w}`, pts });
  }
}

// ── Region polygon ──
// Legs along the real road graph (counter-clockwise on the map: west → south → east), then closed
// through the harbour. Waypoints are only hints: each is snapped to the nearest road node.
const region: Pt[] = [
  // SH1 at St Marys Bay → down the SH1 carriageways, through the Central Motorway Junction → up SH16 (Grafton Gully)
  ...mwGraph.path([-1125, -590], [1030, 452]),
  // SH16 end → Stanley St → Beach Rd → Quay St, west of the port's Captain Cook / Marsden wharves
  ...stGraph.path([1030, 452], [925, -585]).slice(1),
  // across the root of the wharf (≈ 100 m) to its west waterline, round the port's west deck
  // (buildPort), Queens Wharf and the Wynyard Quarter, back through Westhaven Marina to the shore at
  // St Marys Bay (the last ≈ 45 m cross Westhaven Dr to the motorway)
  [895, -700], [770, -760], [770, -1260], [600, -1400], [-300, -1700], [-760, -1500], [-1000, -1100], [-1125, -760],
];
const regionPts = simplify(region.concat([region[0]]), 1).slice(0, -1);
const inRegion = (x: number, z: number) => {
  let inside = false;
  for (let i = 0, j = regionPts.length - 1; i < regionPts.length; j = i++) {
    const [xi, zi] = regionPts[i];
    const [xj, zj] = regionPts[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};
const regionDist = (x: number, z: number) => {
  let d = Infinity;
  for (let i = 0, j = regionPts.length - 1; i < regionPts.length; j = i++) d = Math.min(d, segDist(x, z, regionPts[j], regionPts[i]));
  return inRegion(x, z) ? d : -d;
};

// Streets: everything within 60 m of the region (the shader blends the last few metres at the border)
for (const c of chain(stSecs)) {
  const [name, w] = c.group.split('|');
  for (const r of runs(densify(c.pts, 4), (p) => (regionDist(p[0], p[1]) > -60 ? 0 : -1))) {
    const pts = simplify(r.pts, 0.6);
    if (pts.length > 1) out.push(toLine(name, ROAD_STREET, Number(w), false, pts));
  }
}

// ── Arterials (by name, along the hand-traced corridors, outside the CBD region) ──
const hand = new Map(HAND_ARTERIALS.map((a) => [a.name, a.ll.map(([lat, lon]) => project([lon, lat]))]));
// by suburb instead of along the hand-traced corridor: Great North Rd past its hand-traced end at
// Waterview, through Avondale and over the Whau to New Lynn
const SUBURBS: Record<string, string[]> = { 'Great North Rd': ['Grey Lynn', 'Western Springs', 'Point Chevalier', 'Waterview', 'Avondale', 'New Lynn'] };
for (const [linzName, short] of Object.entries(ARTERIAL_NAMES)) {
  const corridor = hand.get(short) ?? [];
  if (!corridor.length) continue;
  const suburbs = SUBURBS[short];
  const secs = arterials
    .filter((f) => f.properties.full_road_name === linzName && (!suburbs || suburbs.includes(String(f.properties.suburb_locality))))
    .flatMap(lines)
    .filter((pts) => suburbs || pts.every((p) => polyDist(p[0], p[1], corridor) < 700))
    .map((pts) => ({ group: short, pts }));
  const width = HAND_ARTERIALS.find((a) => a.name === short)!.width;
  for (const c of chain(secs)) {
    for (const r of runs(densify(c.pts, 8), (p) => (regionDist(p[0], p[1]) > -15 ? -1 : 0))) {
      const pts = simplify(r.pts, 1.5);
      if (pts.length > 1) out.push(toLine(short, ROAD_ARTERIAL, width, false, pts));
    }
  }
}

// ── Write ──
// the railways (tools/linz/railways.ts) share the file: keep the ones already baked
const rails = fs.existsSync(OUT) ? decodeRoads(new Uint8Array(zlib.gunzipSync(fs.readFileSync(OUT)))).lines.filter((l) => l.kind === ROAD_RAIL) : [];
const data: RoadData = { region: Float32Array.from(regionPts.flat()), lines: out.concat(rails) };
const raw = encodeRoads(data, 0.5);
const gz = zlib.gzipSync(raw, { level: 9 });
fs.writeFileSync(OUT, gz);
const count = (k: RoadKind) => out.filter((l) => l.kind === k);
const len = (ls: RoadLine[]) => ls.reduce((s, l) => s + l.pts.reduce((a, _, i, p) => (i >= 2 && i % 2 === 0 ? a + Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]) : a), 0), 0) / 1000;
console.log(`region: ${regionPts.length} vertices; ${rails.length} railway lines kept`);
for (const [k, n] of [[ROAD_STREET, 'streets'], [ROAD_MOTORWAY, 'motorways'], [ROAD_ARTERIAL, 'arterials']] as const) console.log(`${n}: ${count(k).length} lines, ${len(count(k)).toFixed(1)} km, ${count(k).reduce((s, l) => s + l.pts.length / 2, 0)} vertices, ${count(k).filter((l) => l.tunnel).length} tunnel runs`);
console.log(`wrote ${OUT}: ${raw.length} bytes raw, ${gz.length} bytes gzip`);

if (SVG) {
  // SVG_BOX="x0,z0,x1,z1" (m) picks another view, e.g. the whole motorway network
  const [x0, z0, x1, z1] = (process.env.SVG_BOX ?? '-1700,-1900,1700,1700').split(',').map(Number);
  const s = 1360 / (x1 - x0);
  const tr = (x: number, z: number) => `${((x - x0) * s).toFixed(1)},${((z - z0) * s).toFixed(1)}`;
  let body = '';
  for (const r of linz.rings) {
    const pts: string[] = [];
    for (let i = 0; i < r.length; i += 2) if (r[i] > x0 - 2000 && r[i] < x1 + 2000 && r[i + 1] > z0 - 2000 && r[i + 1] < z1 + 2000) pts.push(tr(r[i], r[i + 1]));
    if (pts.length > 2) body += `<polyline points="${pts.join(' ')}" fill="none" stroke="#6af" stroke-width="1.5"/>`;
  }
  for (const l of out) {
    const pts: string[] = [];
    for (let i = 0; i < l.pts.length; i += 2) pts.push(tr(l.pts[i], l.pts[i + 1]));
    const col = l.kind === ROAD_MOTORWAY ? (l.tunnel ? '#fa0' : '#c00') : l.kind === ROAD_ARTERIAL ? '#0a0' : '#333';
    body += `<polyline points="${pts.join(' ')}" fill="none" stroke="${col}" stroke-width="${Math.max(0.6, l.width * s)}" stroke-opacity="0.75"/>`;
  }
  body += `<polygon points="${regionPts.map(([x, z]) => tr(x, z)).join(' ')}" fill="rgba(255,0,255,0.07)" stroke="#f0f" stroke-width="1.5"/>`;
  fs.writeFileSync(SVG, `<svg xmlns="http://www.w3.org/2000/svg" width="${(x1 - x0) * s}" height="${(z1 - z0) * s}"><rect width="100%" height="100%" fill="#fff"/>${body}</svg>`);
  console.log(`wrote ${SVG}`);
}
