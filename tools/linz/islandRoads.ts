/**
 * Real suburbs 8/9 (#127, phase A): the LINZ roads of the gulf islands (Waiheke, Rangitoto, Motutapu, Motuihe, Rakino,
 * Browns Island) and of the Devonport peninsula, as road ribbons of kind ROAD_LOCAL.
 *
 * Those are the places where #121 put the real houses (auckland-houses.bin) and took the procedural streets away: its
 * coverage grid is where the file is the truth. Every LINZ road section (NZ Addresses: Road Sections, layer 123109) on
 * that coverage, outside the CBD region and not along a ribbon already baked (Lake Rd, Victoria Rd, Bayswater Ave: the
 * arterials), is a ribbon, so the real houses stand along their own streets on every tier and trees and houses keep
 * off them (RoadNetwork). Footpaths (accessways, walks, steps) are left out.
 *
 * Address "roads" with no road type named after an island, bay, inlet or beach (Motutapu Island, Rotoroa Island, Matiatia
 * Bay, Blackpool Beach) are placeholder lines round a shore, not roads: left out. The island roads with no address sections
 * (Rangitoto's summit and Islington Bay roads, Motutapu's and Motuihe's farm roads: Department of Conservation land) come from the Topo50 road centrelines (layer 50329, 1:50k: within ≈ 20 m), where they
 * run over 25 m from every address section; sealed and metalled only (the unmetalled ones are farm tracks).
 *
 * The surface comes from the Topo50 road centrelines (layer 50329: `surface` sealed / metalled / unmetalled,
 * `lane_count`), matched to each section by its road id (Topo50 `rna_sufi` = the address data's `road_id`) and
 * distance; a section takes its matched points' majority (a section with no match is sealed). Widths (kerb to kerb or
 * seal edge to seal edge, m):
 *  - island roads: the main sealed roads (ISLAND_MAIN) 7, other sealed two-lane roads 6, one-lane roads and lanes 4.5,
 *    unsealed (metalled and unmetalled: Rangitoto's summit road, Motutapu's farm roads, the end of Waiheke) 4.5;
 *  - Devonport and the North Shore's covered streets: 9 (parking both sides), lanes and places 6.
 * Stretches over the water longer than WHARF m (wharves, the end of a slipway) are left out; shorter ones (a causeway
 * the coastline traces as sea) stay.
 *
 * Used by roads.ts (a full re-bake) and by island-roads.ts (adds them to the current file).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROAD_LOCAL, ROAD_RAIL, type RoadLine } from '../../src/world/scenery/aucklandRoads';
import { decodeHouses, housesCover } from '../../src/world/scenery/aucklandHouses';
import { worldToGeo } from '../../src/core/auckland';
import { chain, densify, fetchWfs, lines, runs, segDist, simplify, type Feature, type Pt } from './polyline';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const HOUSES = path.join(HERE, '../../src/world/terrain/data/auckland-houses.bin');
const OUTER = path.join(HERE, '../../src/world/terrain/data/auckland-aerial-outer.json');

/** Islands east of this (m, game X); the coverage west of it is the Devonport peninsula and the North Shore's tip. */
export const ISLAND_X = 5500;
/** Stretches off the coastline longer than this (m) are wharves or slipways: left out. */
const WHARF = 60;
/** The Topo50 box (NZTM northing / easting) over Devonport and the islands: lat −36.86 … −36.70, lon 174.74 … 175.21. */
const TOPO_BOX = '5918378,1755108,5936997,1797422';

/** Island roads drawn 7 m wide: the sealed spine of Waiheke and its feeders to the wharves and beaches. */
export const ISLAND_MAIN = new Set([
  'Ocean View Road', 'Onetangi Road', 'Waiheke Road', 'Te Whau Drive', 'Orapiu Road', 'Wharf Road', 'Kennedy Point Road',
  'Donald Bruce Road', 'Sea View Road', 'Belgium Street', 'Pacific Parade', 'Moa Avenue', 'The Strand', 'Cross Road',
  'Causeway Road', 'Tahi Road', 'Trig Hill Road', 'Ostend Road', 'Te Huruhi Road',
]);
const LANES = new Set(['Lane', 'Place', 'Close', 'Spur', 'Grove', 'Service Lane']);
/** Address "roads" with no type named like this are placeholders along a shore (see below). */
const PLACE_NAME = /(Island|Inlet|Bay|Beach)$/;
const SKIP = new Set(['Accessway', 'Steps', 'Walk', 'Track', 'Te Ara', 'Arcade', 'Motorway', 'State Highway']);

export interface LocalWidthInput {
  island: boolean;
  name: string;
  type: string | null;
  unsealed: boolean;
  lanes: number;
}
/** Ribbon width (m) of a local road (see the header). */
export function localWidth(r: LocalWidthInput): number {
  const lane = r.type !== null && LANES.has(r.type);
  if (!r.island) return lane ? 6 : 9;
  if (r.unsealed || r.lanes === 1 || lane) return 4.5;
  return ISLAND_MAIN.has(r.name) ? 7 : 6;
}

interface TopoSeg {
  a: Pt;
  b: Pt;
  id: number;
  unsealed: boolean;
  lanes: number;
}

/**
 * The local road ribbons. `inRegion`: the CBD region (its streets are the street map's); `existing`: the ribbons already
 * baked (runs along them are left out); `isLand`: the coastline.
 */
export function islandRoads(work: string, inRegion: (x: number, z: number) => boolean, existing: RoadLine[], isLand: (x: number, z: number) => boolean, log = console.log): RoadLine[] {
  const raw = fs.readFileSync(HOUSES);
  const houses = decodeHouses(new Uint8Array(raw[0] === 0x1f ? zlib.gunzipSync(raw) : raw));
  const cv = houses.cover;
  const covered = (x: number, z: number) => housesCover(houses, x, z);

  // the boxes to fetch: the coverage west of ISLAND_X, and each island photo box (auckland-aerial-outer.json) east of it
  let dx0 = Infinity, dx1 = -Infinity, dz0 = Infinity, dz1 = -Infinity;
  for (let j = 0; j < cv.rows; j++)
    for (let i = 0; i < cv.cols; i++) {
      const x = cv.x0 + i * cv.cell;
      const z = cv.z0 + j * cv.cell;
      if (!cv.bits[j * cv.cols + i] || x >= ISLAND_X) continue;
      dx0 = Math.min(dx0, x);
      dx1 = Math.max(dx1, x + cv.cell);
      dz0 = Math.min(dz0, z);
      dz1 = Math.max(dz1, z + cv.cell);
    }
  const boxes: { name: string; x0: number; z0: number; x1: number; z1: number }[] = [{ name: 'devonport', x0: dx0, z0: dz0, x1: dx1, z1: dz1 }];
  const rects = (JSON.parse(fs.readFileSync(OUTER, 'utf8')) as { rects: { name: string; x0: number; z0: number; w: number; h: number }[] }).rects;
  for (const r of rects) if (r.x0 >= ISLAND_X) boxes.push({ name: r.name, x0: r.x0, z0: r.z0, x1: r.x0 + r.w, z1: r.z0 + r.h });

  const seen = new Set<number>();
  const secs: Feature[] = [];
  for (const b of boxes) {
    const lo = worldToGeo(b.x0 - 50, b.z1 + 50);
    const hi = worldToGeo(b.x1 + 50, b.z0 - 50);
    for (const f of fetchWfs(work, `local-${b.name}.json`, 'layer-123109', `BBOX(shape,${lo.lat},${lo.lon},${hi.lat},${hi.lon})`)) {
      const id = Number(f.properties.road_section_id);
      if (seen.has(id)) continue;
      seen.add(id);
      secs.push(f);
    }
  }

  // Topo50 centrelines with their surface, hashed on a 100 m grid
  const topo: TopoSeg[] = [];
  const topoFeatures = fetchWfs(work, 'topo50-roads-gulf.json', 'layer-50329', `BBOX(GEOMETRY,${TOPO_BOX})`);
  const surfaceOf = (f: Feature) => {
    const s = String(f.properties.surface ?? 'sealed');
    return { unsealed: s === 'metalled' || s === 'unmetalled', lanes: Number(f.properties.lane_count ?? 2) || 2 };
  };
  for (const f of topoFeatures) {
    const { unsealed, lanes } = surfaceOf(f);
    const id = Number(f.properties.rna_sufi ?? 0);
    for (const pl of lines(f)) for (let i = 0; i + 1 < pl.length; i++) topo.push({ a: pl[i], b: pl[i + 1], id, unsealed, lanes });
  }
  const G = 100;
  const grid = new Map<string, number[]>();
  topo.forEach((s, k) => {
    for (let i = Math.floor((Math.min(s.a[0], s.b[0]) - 40) / G); i <= Math.floor((Math.max(s.a[0], s.b[0]) + 40) / G); i++)
      for (let j = Math.floor((Math.min(s.a[1], s.b[1]) - 40) / G); j <= Math.floor((Math.max(s.a[1], s.b[1]) + 40) / G); j++) {
        const key = `${i},${j}`;
        const l = grid.get(key);
        if (l) l.push(k);
        else grid.set(key, [k]);
      }
  });
  /** The Topo50 segment matching (x, z): the same road within 40 m, else any within 20 m. */
  const match = (p: Pt, id: number): TopoSeg | null => {
    let same: TopoSeg | null = null;
    let sd = 40;
    let any: TopoSeg | null = null;
    let ad = 20;
    for (const k of grid.get(`${Math.floor(p[0] / G)},${Math.floor(p[1] / G)}`) ?? []) {
      const s = topo[k];
      const d = segDist(p[0], p[1], s.a, s.b);
      if (s.id === id && d < sd) {
        sd = d;
        same = s;
      }
      if (d < ad) {
        ad = d;
        any = s;
      }
    }
    return same ?? any;
  };

  // the ribbons already baked near the coverage (roads, not railways), hashed like the Topo50 lines
  const ribbons: [Pt, Pt][] = [];
  const rgrid = new Map<string, number[]>();
  for (const l of existing) {
    if (l.kind === ROAD_RAIL) continue;
    for (let i = 0; i + 3 < l.pts.length; i += 2) {
      const a: Pt = [l.pts[i], l.pts[i + 1]];
      const b: Pt = [l.pts[i + 2], l.pts[i + 3]];
      if (!covered(a[0], a[1]) && !covered(b[0], b[1])) continue;
      const k = ribbons.push([a, b]) - 1;
      for (let gi = Math.floor((Math.min(a[0], b[0]) - 15) / G); gi <= Math.floor((Math.max(a[0], b[0]) + 15) / G); gi++)
        for (let gj = Math.floor((Math.min(a[1], b[1]) - 15) / G); gj <= Math.floor((Math.max(a[1], b[1]) + 15) / G); gj++) {
          const key = `${gi},${gj}`;
          const l2 = rgrid.get(key);
          if (l2) l2.push(k);
          else rgrid.set(key, [k]);
        }
    }
  }
  const onRibbon = (p: Pt) => (rgrid.get(`${Math.floor(p[0] / G)},${Math.floor(p[1] / G)}`) ?? []).some((k) => segDist(p[0], p[1], ribbons[k][0], ribbons[k][1]) < 12);

  // each section's surface and width; then chained by name, width and surface
  const groups: { group: string; pts: Pt[] }[] = [];
  /** The address sections kept (the roads, not the footpaths and placeholders). */
  const roads: Feature[] = [];
  let skipped = 0;
  for (const f of secs) {
    const p = f.properties;
    const type = (p.road_name_type as string | null) ?? null;
    const name = String(p.full_road_name ?? '');
    // (an address "road" named after an island, bay, inlet or beach with no road type is a schematic line round its
    // shore for the addresses there, not a road: Motutapu Island's runs round the coast, 15 m out to sea in places)
    if ((type && SKIP.has(type)) || /Motorway|State Highway|Boardwalk|Marina/.test(name) || (!type && PLACE_NAME.test(name))) {
      skipped++;
      continue;
    }
    roads.push(f);
    const id = Number(p.road_id ?? -1);
    for (const pl of lines(f)) {
      if (!pl.some((q) => covered(q[0], q[1]))) continue;
      let un = 0;
      let n = 0;
      let lanes1 = 0;
      for (const q of densify(pl, 20)) {
        const m = match(q, id);
        if (!m) continue;
        n++;
        if (m.unsealed) un++;
        if (m.lanes === 1) lanes1++;
      }
      const unsealed = n > 0 && un * 2 > n;
      const island = pl[0][0] >= ISLAND_X;
      const w = localWidth({ island, name, type, unsealed, lanes: n > 0 && lanes1 * 2 > n ? 1 : 2 });
      groups.push({ group: `${name}|${w}|${unsealed ? 1 : 0}`, pts: pl });
    }
  }

  // The island roads the address data lacks (Rangitoto's summit and Islington Bay roads, Motuihe's: DOC roads with no
  // addresses), from the Topo50 centrelines: the runs on the islands' coverage over TOPO_GAP m from every address section
  const TOPO_GAP = 25;
  const agrid = new Map<string, [Pt, Pt][]>();
  for (const f of roads)
    for (const pl of lines(f))
      for (let i = 0; i + 1 < pl.length; i++) {
        const a = pl[i];
        const b = pl[i + 1];
        for (let gi = Math.floor((Math.min(a[0], b[0]) - TOPO_GAP) / G); gi <= Math.floor((Math.max(a[0], b[0]) + TOPO_GAP) / G); gi++)
          for (let gj = Math.floor((Math.min(a[1], b[1]) - TOPO_GAP) / G); gj <= Math.floor((Math.max(a[1], b[1]) + TOPO_GAP) / G); gj++) {
            const key = `${gi},${gj}`;
            const l = agrid.get(key);
            if (l) l.push([a, b]);
            else agrid.set(key, [[a, b]]);
          }
      }
  const addressed = (p: Pt) => (agrid.get(`${Math.floor(p[0] / G)},${Math.floor(p[1] / G)}`) ?? []).some(([a, b]) => segDist(p[0], p[1], a, b) < TOPO_GAP);
  let topoKm = 0;
  for (const f of topoFeatures) {
    // not the unmetalled ones: farm tracks (69 km of them on Waiheke), mostly grass in the photo
    if (f.properties.surface === 'unmetalled') continue;
    const { unsealed, lanes } = surfaceOf(f);
    const name = String(f.properties.name ?? '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    for (const pl of lines(f)) {
      if (!pl.some((q) => q[0] >= ISLAND_X && covered(q[0], q[1]))) continue;
      for (const r of runs(densify(pl, 4), (q) => (q[0] >= ISLAND_X && covered(q[0], q[1]) && !addressed(q) ? 0 : -1))) {
        let len = 0;
        for (let i = 1; i < r.pts.length; i++) len += Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1]);
        if (len < 60) continue; // the ends of an addressed road, where the two centrelines part
        topoKm += len / 1000;
        groups.push({ group: `${name}|${localWidth({ island: true, name, type: null, unsealed, lanes })}|${unsealed ? 1 : 0}`, pts: r.pts });
      }
    }
  }

  const out: RoadLine[] = [];
  const km = { sealed: 0, unsealed: 0, devonport: 0 };
  for (const c of chain(groups)) {
    const [name, w, un] = c.group.split('|');
    const pts = densify(c.pts, 4);
    // off the coastline: wharves (long runs) are dropped, short runs (causeways, a coastline that cuts a corner) kept
    const wet = Uint8Array.from(pts, (q) => (isLand(q[0], q[1]) ? 0 : 1));
    for (let i = 0; i < pts.length; ) {
      if (!wet[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < pts.length && wet[j]) j++;
      // a run that reaches a line's end (a wharf) or is long is dropped; a short one between land is a causeway
      if ((j - i) * 4 <= WHARF && i > 0 && j < pts.length) wet.fill(0, i, j);
      i = j;
    }
    for (const r of runs(pts, (q, i) => (covered(q[0], q[1]) && !inRegion(q[0], q[1]) && !wet[i] ? 0 : -1))) {
      if (r.pts.filter(onRibbon).length > r.pts.length / 2) continue;
      if (Math.hypot(r.pts[r.pts.length - 1][0] - r.pts[0][0], r.pts[r.pts.length - 1][1] - r.pts[0][1]) < 15) continue; // stubs
      const s = simplify(r.pts, 0.8);
      if (s.length < 2) continue;
      out.push({ name, kind: ROAD_LOCAL, width: Number(w), tunnel: false, unsealed: un === '1', pts: Float32Array.from(s.flat()) });
      let len = 0;
      for (let i = 1; i < s.length; i++) len += Math.hypot(s[i][0] - s[i - 1][0], s[i][1] - s[i - 1][1]) / 1000;
      if (s[0][0] < ISLAND_X) km.devonport += len;
      else if (un === '1') km.unsealed += len;
      else km.sealed += len;
    }
  }
  log(`local roads: ${secs.length} LINZ sections (${skipped} footpaths, motorways and placeholders skipped), ${topo.length} Topo50 segments (${topoKm.toFixed(1)} km of island roads with no address sections taken from them); ${out.length} ribbons: islands ${km.sealed.toFixed(1)} km sealed + ${km.unsealed.toFixed(1)} km unsealed, Devonport ${km.devonport.toFixed(1)} km`);
  return out;
}
