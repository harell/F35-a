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
 *  - NZ Tunnel Centrelines (Topo, 1:50k, layer 50366): Victoria Park and Waterview tunnels;
 *  - every section on the gulf islands and the Devonport peninsula, with the Topo50 road centrelines' surface
 *    (layer 50329): islandRoads.ts (#127).
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
import { decodeLinz, linzIsLand } from '../../src/world/terrain/theaters/aucklandLinz';
import { decodeOsm, OSM_STADIUM } from '../../src/world/scenery/aucklandOsm';
import { worldToGeo } from '../../src/core/auckland';
import { WESTFIELD_PRISMS } from '../../src/core/westfieldNewmarket';
import { chain, densify, dirAt, fetchWfs, keyOf, lines, polyDist, runs, segDist, simplify, type Feature, type Pt } from './polyline';
import { neighbourhoodStreets } from './neighbourhoodStreets';
import { islandRoads } from './islandRoads';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const WORK = process.argv[2] ?? path.join(os.tmpdir(), 'f35-linz-roads');
const SVG = process.argv[3] ?? null;
const OUT = path.join(HERE, '../../src/world/terrain/data/auckland-roads.bin');
fs.mkdirSync(WORK, { recursive: true });

const wfs = (file: string, typeName: string, cql: string) => fetchWfs(WORK, file, typeName, cql);

// World box ±44 km (lat/lon order for EPSG:4167 / 4326 BBOX filters, northing/easting for NZTM)
const W = { s: -37.25, n: -36.44, w: 174.26, e: 175.26 };
// the CBD and, west of it, Herne Bay and Westhaven (hero neighbourhoods: tools/hero/sites/herne_bay.py, westhaven.py)
const CBD = { s: -36.8745, n: -36.8275, w: 174.72, e: 174.7905 };
/**
 * The arterials and main streets outside the CBD region (inside it they are the street map's): LINZ name, the name
 * the game shows, kerb-to-kerb width (m; 4-lane arterials ≈ 15–16 m, 2-lane main streets 12–13 m) and, where the
 * name is common (a Park Road in Titirangi, Waiuku and Grafton), the suburbs it is taken from.
 */
const ARTERIALS: [linz: string, name: string, width: number, suburbs?: string[]][] = [
  // isthmus: the radial roads out of the CBD
  ['Great North Road', 'Great North Rd', 15, ['Grey Lynn', 'Western Springs', 'Point Chevalier', 'Waterview', 'Avondale', 'New Lynn', 'Glendene', 'Glen Eden', 'Henderson']],
  ['New North Road', 'New North Rd', 14],
  ['Sandringham Road', 'Sandringham Rd', 13],
  ['Dominion Road', 'Dominion Rd', 15, ['Eden Terrace', 'Mount Eden', 'Kingsland', 'Mount Roskill']],
  ['Mount Eden Road', 'Mt Eden Rd', 14],
  ['Symonds Street', 'Symonds St', 15, ['Auckland Central', 'Eden Terrace', 'Grafton']],
  ['Khyber Pass Road', 'Khyber Pass Rd', 15],
  ['Park Road', 'Park Rd', 13, ['Grafton', 'Newmarket']],
  ['Domain Drive', 'Domain Dr', 11],
  ['Grafton Road', 'Grafton Rd', 14],
  ['Carlton Gore Road', 'Carlton Gore Rd', 13],
  ['Broadway', 'Broadway', 16, ['Newmarket', 'Epsom']],
  ['Manukau Road', 'Manukau Rd', 15, ['Epsom', 'Royal Oak']],
  ['Gillies Avenue', 'Gillies Ave', 14],
  ['Great South Road', 'Great South Rd', 15],
  ['Remuera Road', 'Remuera Rd', 14],
  ['Parnell Road', 'Parnell Rd', 13],
  ['St Stephens Avenue', 'St Stephens Ave', 12],
  ['Gladstone Road', 'Gladstone Rd', 12, ['Parnell']],
  ['Tamaki Drive', 'Tamaki Dr', 14],
  ['Ngapipi Road', 'Ngapipi Rd', 12],
  ['Kepa Road', 'Kepa Rd', 13],
  ['Kohimarama Road', 'Kohimarama Rd', 12],
  ['St Heliers Bay Road', 'St Heliers Bay Rd', 12],
  ['West Tamaki Road', 'West Tamaki Rd', 12],
  ['Orakei Road', 'Orakei Rd', 13],
  ['Meadowbank Road', 'Meadowbank Rd', 12],
  ['Gowing Drive', 'Gowing Dr', 11],
  ['Ladies Mile', 'Ladies Mile', 13, ['Remuera', 'Ellerslie']],
  ['Market Road', 'Market Rd', 14],
  ['Green Lane East', 'Green Lane East', 14],
  ['Green Lane West', 'Green Lane West', 14],
  ['Abbotts Way', 'Abbotts Way', 13],
  ['Main Highway', 'Main Hwy', 14],
  ['Ellerslie-Panmure Highway', 'Ellerslie-Panmure Hwy', 15],
  ['Lunn Avenue', 'Lunn Ave', 13],
  ['Morrin Road', 'Morrin Rd', 13],
  ['Apirana Avenue', 'Apirana Ave', 13],
  ['Mount Wellington Highway', 'Mt Wellington Hwy', 15],
  ['Penrose Road', 'Penrose Rd', 13],
  ['Ponsonby Road', 'Ponsonby Rd', 14],
  ['Jervois Road', 'Jervois Rd', 12],
  ['College Hill', 'College Hill', 14],
  ['Franklin Road', 'Franklin Rd', 13, ['Freemans Bay', 'Ponsonby']],
  ['Newton Road', 'Newton Rd', 14, ['Eden Terrace', 'Grey Lynn']],
  ['Richmond Road', 'Richmond Rd', 12],
  ['Williamson Avenue', 'Williamson Ave', 13, ['Grey Lynn']],
  ['Surrey Crescent', 'Surrey Cres', 12],
  ['Meola Road', 'Meola Rd', 12],
  ['Point Chevalier Road', 'Pt Chevalier Rd', 13],
  ['Carrington Road', 'Carrington Rd', 13],
  ['Mount Albert Road', 'Mt Albert Rd', 13],
  ['Balmoral Road', 'Balmoral Rd', 13],
  ['Valley Road', 'Valley Rd', 12, ['Mount Eden']],
  ['Owairaka Avenue', 'Owairaka Ave', 12],
  ['Richardson Road', 'Richardson Rd', 13, ['Mount Roskill', 'Mount Albert', 'Wesley', 'New Windsor', 'Hillsborough']],
  ['Stoddard Road', 'Stoddard Rd', 13],
  ['May Road', 'May Rd', 12, ['Wesley', 'Mount Roskill']],
  ['Mount Roskill Road', 'Mt Roskill Rd', 12],
  ['Hillsborough Road', 'Hillsborough Rd', 13],
  ['Blockhouse Bay Road', 'Blockhouse Bay Rd', 13],
  ['Whitney Street', 'Whitney St', 12],
  ['Tiverton Road', 'Tiverton Rd', 12],
  ['Wolverton Street', 'Wolverton St', 12],
  ['Rosebank Road', 'Rosebank Rd', 13, ['Avondale']],
  ['Ash Street', 'Ash St', 13, ['Avondale']],
  ['Rata Street', 'Rata St', 13, ['New Lynn']],
  ['Clark Street', 'Clark St', 13, ['New Lynn']],
  ['Portage Road', 'Portage Rd', 12, ['New Lynn', 'Green Bay', 'Papatoetoe', 'Ōtāhuhu', 'Māngere']],
  ['Titirangi Road', 'Titirangi Rd', 12],
  ['Pah Road', 'Pah Rd', 13, ['Epsom', 'Royal Oak']],
  ['Mount Smart Road', 'Mt Smart Rd', 13],
  ['Queenstown Road', 'Queenstown Rd', 12],
  ['Onehunga Mall', 'Onehunga Mall', 13],
  ['Church Street', 'Church St', 13, ['Onehunga', 'Penrose', 'Ōtāhuhu']],
  ['Neilson Street', 'Neilson St', 15],
  ['Selwyn Street', 'Selwyn St', 12],
  ['Princes Street', 'Princes St', 12, ['Onehunga', 'Ōtāhuhu']],
  // south and east
  ['Massey Road', 'Massey Rd', 14],
  ['Kirkbride Road', 'Kirkbride Rd', 14],
  ['Coronation Road', 'Coronation Rd', 13, ['Māngere Bridge', 'Papatoetoe']],
  ['Mangere Road', 'Mangere Rd', 13],
  ['Bader Drive', 'Bader Dr', 13],
  ['Ireland Road', 'Ireland Rd', 13, ['Mount Wellington', 'Panmure']],
  ['Pakuranga Road', 'Pakuranga Rd', 15],
  ['Ti Rakau Drive', 'Ti Rakau Dr', 16],
  ['Te Irirangi Drive', 'Te Irirangi Dr', 16],
  ['Botany Road', 'Botany Rd', 14],
  ['Harris Road', 'Harris Rd', 14, ['East Tāmaki']],
  ['Springs Road', 'Springs Rd', 14, ['East Tāmaki', 'Ōtara']],
  ['Highbrook Drive', 'Highbrook Dr', 15],
  ['East Tamaki Road', 'East Tamaki Rd', 14],
  ['Otara Road', 'Otara Rd', 13],
  ['Preston Road', 'Preston Rd', 13],
  ['Bairds Road', 'Bairds Rd', 13],
  ['Ormiston Road', 'Ormiston Rd', 14],
  ['Chapel Road', 'Chapel Rd', 13],
  ['Redoubt Road', 'Redoubt Rd', 13],
  ['Cavendish Drive', 'Cavendish Dr', 15],
  ['Puhinui Road', 'Puhinui Rd', 14],
  ['Station Road', 'Station Rd', 13, ['Penrose', 'Papatoetoe', 'Ōtāhuhu']],
  ['Weymouth Road', 'Weymouth Rd', 13],
  ['Alfriston Road', 'Alfriston Rd', 13, ['Manurewa', 'Manurewa East']],
  // west
  ['Lincoln Road', 'Lincoln Rd', 16, ['Henderson']],
  ['Te Atatu Road', 'Te Atatu Rd', 14],
  ['Edmonton Road', 'Edmonton Rd', 13],
  ['Swanson Road', 'Swanson Rd', 13, ['Henderson', 'Rānui', 'Swanson']],
  ['Don Buck Road', 'Don Buck Rd', 13],
  ['Universal Drive', 'Universal Dr', 13],
  ['West Coast Road', 'West Coast Rd', 12, ['Glen Eden', 'Oratia']],
  ['Henderson Valley Road', 'Henderson Valley Rd', 12, ['Henderson']],
  ['Sturges Road', 'Sturges Rd', 12],
  ['Hobsonville Road', 'Hobsonville Rd', 13],
  // North Shore
  ['Lake Road', 'Lake Rd', 14],
  ['Victoria Road', 'Victoria Rd', 12, ['Devonport']],
  ['Bayswater Avenue', 'Bayswater Ave', 12],
  ['Esmonde Road', 'Esmonde Rd', 15],
  ['Hurstmere Road', 'Hurstmere Rd', 12],
  ['Taharoto Road', 'Taharoto Rd', 14],
  ['Shakespeare Road', 'Shakespeare Rd', 13, ['Milford']],
  ['Akoranga Drive', 'Akoranga Dr', 13],
  ['Onewa Road', 'Onewa Rd', 14],
  ['Northcote Road', 'Northcote Rd', 14],
  ['Birkenhead Avenue', 'Birkenhead Ave', 12],
  ['Mokoia Road', 'Mokoia Rd', 12],
  ['Beach Haven Road', 'Beach Haven Rd', 12],
  ['Glenfield Road', 'Glenfield Rd', 14, ['Glenfield', 'Birkenhead', 'Hillcrest', 'Tōtara Vale', 'Bayview']],
  ['Wairau Road', 'Wairau Rd', 15],
  ['Sunset Road', 'Sunset Rd', 13],
  ['Sunnynook Road', 'Sunnynook Rd', 12],
  ['Forrest Hill Road', 'Forrest Hill Rd', 12],
  ['Tristram Avenue', 'Tristram Ave', 13],
  ['East Coast Road', 'East Coast Rd', 13, ['Milford', 'Castor Bay', 'Forrest Hill', 'Sunnynook', 'Mairangi Bay', 'Campbells Bay', 'Windsor Park', 'Northcross', 'Pinehill', 'Browns Bay', 'Murrays Bay', 'Torbay', 'Oteha']],
  ['Browns Bay Road', 'Browns Bay Rd', 12],
  ['Constellation Drive', 'Constellation Dr', 15],
  ['Rosedale Road', 'Rosedale Rd', 14],
  ['Albany Highway', 'Albany Hwy', 15],
  ['Oteha Valley Road', 'Oteha Valley Rd', 14],
];
const streets = wfs('cbd-streets.json', 'layer-123109', `BBOX(shape,${CBD.s},${CBD.w},${CBD.n},${CBD.e})`);
const motorways = wfs('motorways.json', 'layer-123109', `BBOX(shape,${W.s},${W.w},${W.n},${W.e}) AND (road_name_type IN ('Motorway','State Highway') OR full_road_name LIKE '%Motorway%')`);
const arterials = wfs('arterials-v2.json', 'layer-123109', `territorial_authority='Auckland' AND full_road_name IN (${ARTERIALS.map(([n]) => `'${n}'`).join(',')})`);
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
// Herne Bay and Westhaven are in the region: their buildings, trees and boats are the hero
// neighbourhood models (src/world/scenery/aucklandNeighbourhoods.ts), so the seam follows the streets
// that bound them (Jervois Rd, Shelly Beach Rd, SH1) and St Marys Bay and Ponsonby stay procedural.
const JERVOIS_W: Pt = [-3234, 122];
const JERVOIS_E: Pt = [-1871, -333];
const SHELLY_N: Pt = [-1786, -1329];
// a graph of those two roads alone, so the shortest path can't cut along a parallel street
const herneGraph = new Graph();
for (const f of streets) if (['Jervois Road', 'Shelly Beach Road'].includes(String(f.properties.full_road_name))) for (const pts of lines(f)) herneGraph.add(pts);
const region: Pt[] = [
  // Jervois Rd from Herne Bay's west end to Ponsonby Rd, up Shelly Beach Rd to SH1
  ...herneGraph.path(JERVOIS_W, JERVOIS_E),
  ...herneGraph.path(JERVOIS_E, SHELLY_N).slice(1),
  // SH1 from the bridge approach through St Marys Bay and the Central Motorway Junction → up SH16 (Grafton Gully)
  ...mwGraph.path([-1812, -1342], [1030, 452]),
  // SH16 end → Stanley St → Beach Rd → Quay St, west of the port's Captain Cook / Marsden wharves
  ...stGraph.path([1030, 452], [925, -585]).slice(1),
  // across the root of the wharf (≈ 100 m) to its west waterline, round the port's west deck
  // (buildPort), Queens Wharf and the Wynyard Quarter, outside Westhaven's breakwaters, under the
  // Harbour Bridge and ≈ 100 m off Herne Bay's shore to Cox's Bay
  [895, -700], [770, -760], [770, -1260], [600, -1400], [-300, -1700], [-650, -1440], [-1000, -1590], [-1720, -1590],
  [-2100, -1370], [-2240, -1110], [-2400, -975], [-2650, -950], [-2920, -870], [-3090, -665], [-3300, -605], [-3560, -200],
  [-3560, 20],
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

// ── Arterials and main streets (by name and suburb, outside the CBD region) ──
// in the world box only (the LINZ layer is the whole Auckland region, out to Wellsford and Waiuku)
const inWorld = (pts: Pt[]) => pts.every(([x, z]) => Math.abs(x) < 44000 && Math.abs(z) < 44000);
for (const [linzName, short, width, suburbs] of ARTERIALS) {
  const secs = arterials
    .filter((f) => f.properties.full_road_name === linzName && (!suburbs || suburbs.includes(String(f.properties.suburb_locality))))
    .flatMap(lines)
    .filter(inWorld)
    .map((pts) => ({ group: short, pts }));
  if (!secs.length) throw new Error(`no LINZ road sections for ${linzName}`);
  for (const c of chain(secs)) {
    for (const r of runs(densify(c.pts, 8), (p) => (regionDist(p[0], p[1]) > -15 ? -1 : 0))) {
      const pts = simplify(r.pts, 1.5);
      if (pts.length > 1) out.push(toLine(short, ROAD_ARTERIAL, width, false, pts));
    }
  }
}

// ── Streets round the 3D landmarks outside the region (the stadiums with OSM stands, Westfield Newmarket) ──
// The terrain shader stops its procedural grid on a landmark's site (Scenery.siteMask); the real streets
// that bound the site are ribbons, so a stadium stands among its own streets, not on painted ones.
// Every LINZ road section within LANDMARK_REACH m of the site's outline, clipped there.
const LANDMARK_REACH = 90;
const osmRaw = fs.readFileSync(path.join(HERE, '../../src/world/scenery/data/auckland-osm.bin'));
const osm = decodeOsm(new Uint8Array(osmRaw[0] === 0x1f ? zlib.gunzipSync(osmRaw) : osmRaw));
const landmarkStreets: RoadLine[] = [];
// the motorways and arterials already baked: a landmark street along one of them is the same road
const ribbonSegs: [Pt, Pt][] = [];
for (const l of out) for (let i = 0; i + 3 < l.pts.length; i += 2) ribbonSegs.push([[l.pts[i], l.pts[i + 1]], [l.pts[i + 2], l.pts[i + 3]]]);
const onRibbon = (p: Pt) => ribbonSegs.some(([a, b]) => segDist(p[0], p[1], a, b) < 12);
const inRing = (ring: Pt[], x: number, z: number) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
};
const toPts = (a: ArrayLike<number>): Pt[] => {
  const r: Pt[] = [];
  for (let i = 0; i < a.length; i += 2) r.push([a[i], a[i + 1]]);
  return r;
};
// each landmark is one or more outlines (Westfield's buildings stand either side of Mortimer Pass, a real street)
const landmarks: Pt[][][] = [...osm.features.filter((f) => f.layer === OSM_STADIUM).map((f) => [toPts(f.pts)]), WESTFIELD_PRISMS.map((p) => toPts(p.ring))];
for (const rings of landmarks) {
  if (rings.some((ring) => ring.some((p) => inRegion(p[0], p[1])))) continue; // Spark Arena: the region's own streets
  const xs = rings.flat().map((p) => p[0]);
  const zs = rings.flat().map((p) => p[1]);
  const lo = worldToGeo(Math.min(...xs) - LANDMARK_REACH - 50, Math.max(...zs) + LANDMARK_REACH + 50);
  const hi = worldToGeo(Math.max(...xs) + LANDMARK_REACH + 50, Math.min(...zs) - LANDMARK_REACH - 50);
  const key = `landmark-${Math.round(xs[0])}_${Math.round(zs[0])}.json`;
  const secs = wfs(key, 'layer-123109', `BBOX(shape,${lo.lat},${lo.lon},${hi.lat},${hi.lon})`);
  const closed = rings.map((ring) => ring.concat([ring[0]]));
  const dist = (p: Pt) => Math.min(...closed.map((c) => polyDist(p[0], p[1], c)));
  const onSite = (p: Pt) => rings.some((ring) => inRing(ring, p[0], p[1]));
  for (const sec of secs) {
    const w = streetWidth(sec.properties);
    // accessways are mostly footpath links through parks and between sections
    if (w === null || sec.properties.road_name_type === 'Accessway') continue;
    for (const pl of lines(sec))
      // (not across the site itself: a racecourse's own service roads stay off its grounds)
      for (const r of runs(densify(pl, 4), (p) => (dist(p) < LANDMARK_REACH && !onSite(p) ? 0 : -1))) {
        if (r.flag !== 0 || r.pts.filter(onRibbon).length > r.pts.length / 2) continue;
        if (Math.hypot(r.pts[r.pts.length - 1][0] - r.pts[0][0], r.pts[r.pts.length - 1][1] - r.pts[0][1]) < 15) continue; // stubs
        const pts = simplify(r.pts, 0.8);
        if (pts.length > 1) landmarkStreets.push(toLine(String(sec.properties.full_road_name ?? ''), ROAD_ARTERIAL, Math.min(w, 12), false, pts));
      }
  }
}
out.push(...landmarkStreets);

// ── Streets of the hero neighbourhoods outside the region (Mission Bay: neighbourhoodStreets.ts) ──
out.push(...neighbourhoodStreets(WORK, regionPts, out));

// ── Local roads of the gulf islands and the Devonport peninsula, where the real houses stand (#127: islandRoads.ts) ──
out.push(...islandRoads(WORK, inRegion, out, (x, z) => isLand([x, z])));

// ── Write ──
// the railways (tools/linz/railways.ts) share the file: keep the ones already baked
const rails = fs.existsSync(OUT) ? decodeRoads(new Uint8Array(zlib.gunzipSync(fs.readFileSync(OUT)))).lines.filter((l) => l.kind === ROAD_RAIL) : [];
const data: RoadData = { region: Float32Array.from(regionPts.flat()), lines: out.concat(rails) };
const raw = encodeRoads(data, 0.5);
const gz = zlib.gzipSync(raw, { level: 9 });
fs.writeFileSync(OUT, gz);
const count = (k: RoadKind) => out.filter((l) => l.kind === k);
const len = (ls: RoadLine[]) => ls.reduce((s, l) => s + l.pts.reduce((a, _, i, p) => (i >= 2 && i % 2 === 0 ? a + Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]) : a), 0), 0) / 1000;
console.log(`region: ${regionPts.length} vertices; ${rails.length} railway lines kept; ${landmarkStreets.length} street runs round the landmarks`);
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
