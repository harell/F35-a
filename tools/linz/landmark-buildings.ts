/**
 * Real suburbs 5/9 (#124), step 2: bake the landmark sites (tools/linz/landmark-buildings.py → <work>/landmarks.json)
 * into src/world/terrain/data/auckland-landmarks.bin (gzip; decoded by src/world/scenery/aucklandLandmarks.ts).
 *
 *   python3 tools/linz/landmark-buildings.py fetch [<work>] && python3 tools/linz/landmark-buildings.py bake [<work>]
 *   npx vite-node tools/linz/landmark-buildings.ts [<work>] [preview.svg]
 *
 * Reprojects with the game's own geoToWorld, and leaves out what the game already models: buildings inside the CBD
 * region (the LINZ CBD bake's), a hero neighbourhood (aucklandNeighbourhoods.ts), Westfield Newmarket, Spark Arena,
 * the Auckland Domain or an aerodrome (the airfields' OSM terminals and hangars), or over the water. Each platform is
 * moved across the game's railway ribbon it serves (aucklandRailPaths: LINZ Topo50 centrelines, up to ≈ 15 m off the
 * real track), keeping its OSM outline: beside the formation (a side platform, on the side OSM has it) or onto its
 * centre line (an island platform, within ISLAND m of it); the canopies over a platform move with it. The schools' and
 * the 'other' outlines are simplified by SIMPLIFY_LOW m. A station building standing on the ribbon (a footbridge, a concourse over the tracks) is left out.
 * Writes the spot checks (tests/fixtures/landmark-spotchecks.json) for the ±5 m test.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { geoToWorld } from '../../src/core/auckland';
import { sparkArenaCovers } from '../../src/core/sparkArena';
import { WESTFIELD_PRISMS } from '../../src/core/westfieldNewmarket';
import { ringArea, ringCentroid, roofHeight, type BuildingPrism } from '../../src/world/scenery/aucklandBuildings';
import { simplifyRing } from '../../src/world/scenery/auckland';
import { decodeDomain } from '../../src/world/scenery/aucklandDomain';
import { ccw, encodeLandmarks, LANDMARK_KINDS, ringDistance, type LandmarkBuilding, type LandmarkKind, type LandmarkPlatform, type LandmarkSite, type Landmarks } from '../../src/world/scenery/aucklandLandmarks';
import { decodeNeighbourhoods } from '../../src/world/scenery/aucklandNeighbourhoods';
import { decodeOsm, OSM_AERODROME } from '../../src/world/scenery/aucklandOsm';
import { decodeRoads, setAucklandRoads } from '../../src/world/scenery/aucklandRoads';
import { CbdStreets, pointInRing } from '../../src/world/scenery/cbdStreets';
import { aucklandRailPaths, type RoadPath } from '../../src/world/scenery/motorways';
import { decodeLinz, linzIsLand } from '../../src/world/terrain/theaters/aucklandLinz';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const WORK = process.argv[2] ?? path.join(os.homedir(), 'work/landmarks');
const SVG = process.argv[3] ?? null;
const OUT = path.join(HERE, '../../src/world/terrain/data/auckland-landmarks.bin');
const FIXTURE = path.join(HERE, '../../tests/fixtures/landmark-spotchecks.json');

/** How far (m) a platform may lie from a railway ribbon's centre line and still be its. */
const PLATFORM_REACH = 45;
/** A platform whose middle is within this (m) of the ribbon's centre line is an island between the tracks. */
const ISLAND = 3.5;
/** Gap (m) between the formation's edge and a side platform. */
const GAP = 0.4;
/** Vertex quantum (m): the 2017 outlines are good to ±0.5–1 m (0.25 m cost 26 kB more gzip). */
const QUANTUM = 0.5;
/** Douglas–Peucker (m) on the schools' and the 'other' buildings' outlines (the hospitals', malls' and stations' keep the 0.5 m of the Python bake). */
const SIMPLIFY_LOW = 0.9;

interface InPart {
  ring: [number, number][];
  h: number;
  sx: number;
  sz: number;
}
interface InBuilding {
  site: number;
  id: number;
  src: 'outline' | 'lidar';
  canopy: boolean;
  parts: InPart[];
}
interface InSite {
  kind: LandmarkKind;
  name: string;
  osm: string;
  ring: [number, number][];
  /** Its other parts (a multipolygon site). */
  more?: [number, number][][];
  m2: number;
  platforms: [number, number][][];
  buildings: number;
}
const input = JSON.parse(fs.readFileSync(path.join(WORK, 'landmarks.json'), 'utf8')) as { osm: Record<string, string>; tally: Record<string, number>; sites: InSite[]; buildings: InBuilding[] };
const checks = JSON.parse(fs.readFileSync(path.join(WORK, 'landmark-spotchecks.json'), 'utf8')) as { name: string; kind: string; lon: number; lat: number; lidar: number; peak?: number }[];

const data = (dir: string, f: string) => new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(HERE, '../../src/world', dir, 'data', f))));
const roadBytes = data('terrain', 'auckland-roads.bin');
const st = new CbdStreets(decodeRoads(roadBytes));
setAucklandRoads(roadBytes);
const rails = aucklandRailPaths();
const linz = decodeLinz(data('terrain', 'auckland-linz.bin'));
const nbs = decodeNeighbourhoods(data('scenery', 'auckland-neighbourhoods.bin'));
const domain = decodeDomain(data('scenery', 'auckland-domain.bin'));
const aerodromes = decodeOsm(data('scenery', 'auckland-osm.bin')).features.filter((f) => f.layer === OSM_AERODROME && f.area);

const project = (r: [number, number][]): Float32Array => {
  const out = new Float32Array(r.length * 2);
  r.forEach(([lon, lat], i) => {
    const p = geoToWorld(lat, lon);
    out[i * 2] = p.x;
    out[i * 2 + 1] = p.z;
  });
  return ccw(out);
};

/** Why a point's building is already in the game, or null. */
function modelled(x: number, z: number): string | null {
  if (st.inRegion(x, z)) return 'CBD region';
  if (nbs.some((n) => pointInRing(n.footprint, x, z))) return 'neighbourhood';
  if (WESTFIELD_PRISMS.some((p) => pointInRing(Float32Array.from(p.ring), x, z)) || Math.hypot(x - 1233.9, z - 2540.1) < 140) return 'Westfield Newmarket';
  if (sparkArenaCovers(x, z, 20)) return 'Spark Arena';
  if (pointInRing(domain.park, x, z)) return 'Domain';
  if (aerodromes.some((a) => pointInRing(a.pts, x, z))) return 'aerodrome';
  if (!linzIsLand(linz, x, z)) return 'water';
  return null;
}

// ── Platforms beside the ribbons ──
interface Proj {
  path: RoadPath;
  seg: number;
  /** Arc length along the path (m) and signed offset (+ right of the direction of travel, looking +s). */
  s: number;
  d: number;
}
const cum = new Map<RoadPath, Float64Array>();
for (const p of rails) {
  const c = new Float64Array(p.x.length);
  for (let i = 1; i < p.x.length; i++) c[i] = c[i - 1] + Math.hypot(p.x[i] - p.x[i - 1], p.z[i] - p.z[i - 1]);
  cum.set(p, c);
}
function project1(p: RoadPath, x: number, z: number): Proj {
  const c = cum.get(p)!;
  let best: Proj = { path: p, seg: 0, s: 0, d: Infinity };
  for (let i = 0; i + 1 < p.x.length; i++) {
    const ax = p.x[i], az = p.z[i];
    const dx = p.x[i + 1] - ax, dz = p.z[i + 1] - az;
    const l2 = dx * dx + dz * dz;
    if (l2 <= 0) continue;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    const ex = x - (ax + dx * t), ez = z - (az + dz * t);
    const dist = Math.hypot(ex, ez);
    if (dist < Math.abs(best.d)) {
      const l = Math.sqrt(l2);
      // right of travel (+X east, +Z south seen from above): (−dz, dx)
      const side = Math.sign(ex * -dz + ez * dx) || 1;
      best = { path: p, seg: i, s: c[i] + t * l, d: side * dist };
    }
  }
  return best;
}
function nearestRail(x: number, z: number): Proj | null {
  let best: Proj | null = null;
  for (const p of rails) {
    let near = false;
    for (let i = 0; i < p.x.length && !near; i++) near = Math.abs(p.x[i] - x) < 400 && Math.abs(p.z[i] - z) < 400;
    if (!near) continue;
    const q = project1(p, x, z);
    if (!best || Math.abs(q.d) < Math.abs(best.d)) best = q;
  }
  return best;
}
/** Point and unit direction of a path at arc length s. */
function along(p: RoadPath, s: number): [number, number, number, number] {
  const c = cum.get(p)!;
  let i = 0;
  while (i + 2 < p.x.length && c[i + 1] < s) i++;
  const l = c[i + 1] - c[i] || 1;
  const t = Math.max(0, Math.min(1, (s - c[i]) / l));
  const dx = (p.x[i + 1] - p.x[i]) / l, dz = (p.z[i + 1] - p.z[i]) / l;
  return [p.x[i] + (p.x[i + 1] - p.x[i]) * t, p.z[i] + (p.z[i + 1] - p.z[i]) * t, dx, dz];
}

interface Laid {
  ring: Float32Array;
  /** The OSM platform's outline (for the canopies over it) and how far it moved. */
  osm: Float32Array;
  shift: [number, number];
}
const platformStats = { laid: 0, island: 0, side: 0, far: 0, tunnel: 0, maxShift: 0 };
function layPlatform(osmRing: Float32Array): Laid | null {
  const [cx, cz] = ringCentroid(osmRing);
  const near = nearestRail(cx, cz);
  if (!near || Math.abs(near.d) > PLATFORM_REACH) {
    platformStats.far++;
    return null;
  }
  const p = near.path;
  if (p.tunnel[near.seg] || p.tunnel[near.seg + 1]) {
    platformStats.tunnel++;
    return null;
  }
  // the platform's width: its extent across the ribbon at its middle (a platform beyond the end of a ribbon's
  // polyline, where LINZ splits a line, keeps its own outline: it is moved, not re-traced)
  const [, , dx, dz] = along(p, near.s);
  const rx = -dz, rz = dx; // right of travel
  let d0 = Infinity, d1 = -Infinity;
  for (let i = 0; i < osmRing.length; i += 2) {
    const t = (osmRing[i] - cx) * rx + (osmRing[i + 1] - cz) * rz;
    d0 = Math.min(d0, t);
    d1 = Math.max(d1, t);
  }
  const w = Math.max(2.5, Math.min(14, d1 - d0));
  const dc = near.d;
  const island = Math.abs(dc) < ISLAND;
  const off = island ? 0 : Math.sign(dc) * (p.width / 2 + GAP + w / 2);
  if (island) platformStats.island++;
  else platformStats.side++;
  const shift: [number, number] = [rx * (off - dc), rz * (off - dc)];
  const ring = osmRing.map((v, k) => v + shift[k % 2]);
  platformStats.laid++;
  platformStats.maxShift = Math.max(platformStats.maxShift, Math.hypot(...shift));
  if (Math.hypot(...shift) > 12) console.log(`  platform moved ${Math.hypot(...shift).toFixed(0)} m to the ribbon at (${cx.toFixed(0)}, ${cz.toFixed(0)}), ${island ? 'island' : 'side'}, offset ${dc.toFixed(1)} m`);
  return { ring, osm: osmRing, shift };
}

/** Share of a ring's area (2 m lattice) on a railway ribbon. */
function onRibbon(r: Float32Array): number {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    x0 = Math.min(x0, r[i]);
    x1 = Math.max(x1, r[i]);
    z0 = Math.min(z0, r[i + 1]);
    z1 = Math.max(z1, r[i + 1]);
  }
  const near = nearestRail((x0 + x1) / 2, (z0 + z1) / 2);
  if (!near || Math.abs(near.d) > 200) return 0;
  let n = 0, on = 0;
  for (let z = z0 + 1; z < z1; z += 2)
    for (let x = x0 + 1; x < x1; x += 2) {
      if (!pointInRing(r, x, z)) continue;
      n++;
      const q = project1(near.path, x, z);
      if (Math.abs(q.d) < near.path.width / 2 + 0.5) on++;
    }
  return n ? on / n : 0;
}

// ── Sites and buildings ──
const sites: LandmarkSite[] = [];
const buildings: LandmarkBuilding[] = [];
const platforms: LandmarkPlatform[] = [];
const dropped: Record<string, number> = {};
const droppedSites: string[] = [];
const byInSite = new Map<number, InBuilding[]>();
for (const b of input.buildings) {
  const l = byInSite.get(b.site);
  if (l) l.push(b);
  else byInSite.set(b.site, [b]);
}
// sites west → east in 2 km bands north → south (neighbours share their delta-coded vertices' magnitudes)
const order = input.sites.map((s, i) => ({ s, i, c: ringCentroid(project(s.ring)) }));
order.sort((a, b) => LANDMARK_KINDS.indexOf(a.s.kind) - LANDMARK_KINDS.indexOf(b.s.kind) || Math.floor(a.c[1] / 2000) - Math.floor(b.c[1] / 2000) || a.c[0] - b.c[0]);
let ribbonDrops = 0;
for (const { s, i } of order) {
  const laid = s.platforms.map((r) => layPlatform(project(r))).filter((l): l is Laid => l !== null);
  const kept: LandmarkBuilding[] = [];
  for (const b of byInSite.get(i) ?? []) {
    let prisms: BuildingPrism[] = b.parts
      .map((p) => {
        let ring = project(p.ring);
        if (s.kind === 'school' || s.kind === 'other') ring = simplifyRing(ring, SIMPLIFY_LOW);
        const [cx, cz] = ringCentroid(ring);
        return { h: p.h, ring, sx: p.sx, sz: p.sz, cx, cz };
      })
      .sort((a, c) => ringArea(c.ring) - ringArea(a.ring));
    const why = modelled(prisms[0].cx, prisms[0].cz);
    if (why) {
      dropped[why] = (dropped[why] ?? 0) + 1;
      continue;
    }
    if (b.canopy) {
      // with the platform under it
      const under = laid.find((l) => ringDistance(l.osm, prisms[0].cx, prisms[0].cz) < 3);
      if (under) {
        const [dx, dz] = under.shift;
        prisms = prisms.map((p) => {
          const ring = p.ring.map((v, k) => v + (k % 2 ? dz : dx));
          return { ...p, ring, cx: p.cx + dx, cz: p.cz + dz };
        });
      }
    } else if (s.kind === 'station' && onRibbon(prisms[0].ring) > 0.3) {
      ribbonDrops++;
      continue;
    }
    kept.push({ site: sites.length, lidar: b.src === 'lidar', canopy: b.canopy, prisms });
  }
  const [cx, cz] = ringCentroid(project(s.ring));
  if (!kept.length && !laid.length) {
    droppedSites.push(`${s.kind} ${s.name || s.osm} (${modelled(cx, cz) ?? 'no building standing'})`);
    continue;
  }
  for (const l of laid) platforms.push({ site: sites.length, ring: l.ring });
  if (s.kind === 'station' && !laid.length) console.log(`  station without a platform: ${s.name}`);
  sites.push({ kind: s.kind, name: s.kind === 'other' ? '' : s.name, ring: project(s.ring), b0: buildings.length, b1: buildings.length + kept.length });
  buildings.push(...kept);
  // a site in several parts (Middlemore's campus across Hospital Rd): one more site, without buildings, per part
  for (const r of s.kind === 'other' ? [] : s.more ?? []) sites.push({ kind: s.kind, name: s.kind === 'other' ? '' : s.name, ring: project(r), b0: buildings.length, b1: buildings.length });
}

const d: Landmarks = { sites, buildings, platforms };
const raw = encodeLandmarks(d, QUANTUM);
const gz = zlib.gzipSync(raw, { level: 9 });
fs.writeFileSync(OUT, gz);

// ── Report ──
const count = (k: LandmarkKind) => sites.filter((s) => s.kind === k).reduce((n, s) => n + s.b1 - s.b0, 0);
const prisms = buildings.flatMap((b) => b.prisms);
console.log(`OSM: ${JSON.stringify(input.osm)}`);
console.log(`sites kept: ${LANDMARK_KINDS.map((k) => `${k} ${sites.filter((s) => s.kind === k).length}`).join(', ')}; dropped ${droppedSites.length}`);
for (const s of droppedSites) console.log(`  dropped site: ${s}`);
console.log(`buildings: ${buildings.length} (${LANDMARK_KINDS.map((k) => `${k} ${count(k)}`).join(', ')}), ${prisms.length} prisms, ${prisms.reduce((n, p) => n + p.ring.length / 2, 0)} vertices, ${buildings.filter((b) => b.lidar).length} traced from the LiDAR, ${buildings.filter((b) => b.canopy).length} canopies`);
console.log(`left out (already modelled): ${JSON.stringify(dropped)}; station buildings on a ribbon: ${ribbonDrops}`);
console.log(`platforms: ${JSON.stringify(platformStats)}`);
const tallest = [...buildings].map((b) => ({ b, h: Math.max(...b.prisms.map((p) => p.h)) })).sort((a, c) => c.h - a.h).slice(0, 10);
console.log(`tallest: ${tallest.map(({ b, h }) => `${sites[b.site].name || sites[b.site].kind} ${h.toFixed(0)} m`).join(', ')}`);
// size by kind: encode each kind alone
for (const k of LANDMARK_KINDS) {
  const ss = sites.filter((s) => s.kind === k);
  const bs: LandmarkBuilding[] = [];
  const s2 = ss.map((s) => {
    const b0 = bs.length;
    bs.push(...buildings.slice(s.b0, s.b1));
    return { ...s, b0, b1: bs.length };
  });
  const pl = platforms.filter((p) => sites[p.site].kind === k).map((p) => ({ ...p, site: 0 }));
  const g = zlib.gzipSync(encodeLandmarks({ sites: s2, buildings: bs, platforms: pl }, QUANTUM), { level: 9 });
  console.log(`  ${k}: ${g.length} bytes gzip alone`);
}
console.log(`wrote ${OUT}: ${raw.length} bytes raw, ${gz.length} bytes gzip`);

/** Roof height of the baked landmark building at a point (the tallest prism containing it). */
const bakedAt = (x: number, z: number) => {
  let h = -1;
  for (const b of buildings) for (const p of b.prisms) if (Math.abs(p.cx - x) < 400 && Math.abs(p.cz - z) < 400 && pointInRing(p.ring, x, z)) h = Math.max(h, roofHeight(p, x, z));
  return h;
};
const fixture = checks
  .map((c) => {
    const p = geoToWorld(c.lat, c.lon);
    const x = Math.round(p.x * 10) / 10;
    const z = Math.round(p.z * 10) / 10;
    return { name: c.name, kind: c.kind, x, z, lidar: c.lidar, baked: bakedAt(x, z) };
  })
  .filter((c) => c.baked >= 0);
const off = fixture.filter((c) => Math.abs(c.baked - c.lidar) > 5);
for (const c of fixture.filter((f) => f.name.endsWith('(top)'))) console.log(`  ${c.name.padEnd(36)} LiDAR ${c.lidar.toFixed(1)} m, baked ${c.baked.toFixed(1)} m`);
console.log(`spot checks: ${fixture.length} of ${checks.length}, off by > 5 m: ${off.length}${off.length ? ' — ' + off.map((c) => `${c.name} ${c.lidar}/${c.baked.toFixed(1)}`).join(', ') : ''}`);
fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
fs.writeFileSync(FIXTURE, JSON.stringify(fixture.map(({ baked: _, ...c }) => c), null, 1) + '\n');
console.log(`wrote ${FIXTURE}`);

if (SVG) {
  const [x0, z0, x1, z1] = (process.env.SVG_BOX ?? '-16000,-16000,26000,26000').split(',').map(Number);
  const s = 2000 / (x1 - x0);
  const tr = (x: number, z: number) => `${((x - x0) * s).toFixed(1)},${((z - z0) * s).toFixed(1)}`;
  const poly = (r: Float32Array, fill: string, stroke: string) => {
    const pts: string[] = [];
    for (let i = 0; i < r.length; i += 2) pts.push(tr(r[i], r[i + 1]));
    return `<polygon points="${pts.join(' ')}" fill="${fill}" stroke="${stroke}" stroke-width="0.5"/>`;
  };
  let body = '';
  for (const p of rails) {
    const pts: string[] = [];
    for (let i = 0; i < p.x.length; i++) pts.push(tr(p.x[i], p.z[i]));
    body += `<polyline points="${pts.join(' ')}" fill="none" stroke="#999" stroke-width="${Math.max(0.6, p.width * s)}"/>`;
  }
  const col: Record<LandmarkKind, string> = { hospital: '#d33', mall: '#36c', station: '#3a3', school: '#c90', other: '#888' };
  for (const site of sites) body += poly(site.ring, 'none', col[site.kind]);
  for (const b of buildings) body += poly(b.prisms[0].ring, col[sites[b.site].kind], 'none');
  for (const p of platforms) body += poly(p.ring, '#000', 'none');
  fs.writeFileSync(SVG, `<svg xmlns="http://www.w3.org/2000/svg" width="${(x1 - x0) * s}" height="${(z1 - z0) * s}"><rect width="100%" height="100%" fill="#fff"/>${body}</svg>`);
  console.log(`wrote ${SVG}`);
}
