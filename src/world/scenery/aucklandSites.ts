/**
 * Open data 2 (issue #33): Auckland's waterfront and strategic sites from the OpenStreetMap layer
 * (aucklandOsm.ts, © OpenStreetMap contributors, ODbL 1.0):
 *
 * - Ports of Auckland: the real port outline (Queens Wharf to Fergusson, plus the Fergusson reclamation
 *   the LINZ coastline predates) as a concrete deck, its sheds, container stacks, and the procedural
 *   gantry cranes standing on the real berth faces. The ships alongside are sim entities
 *   (missions/runtime/shipping.ts PORT_BERTHS), never scenery.
 * - Piers, pontoons and breakwaters everywhere in the theatre, and yachts berthed along the pontoons of
 *   the marinas (Westhaven, Viaduct, Silo, Half Moon Bay, …).
 * - Devonport Naval Base (AKL.naval_base): its buildings and Calliope Dock (dry dock); Calliope Wharf
 *   comes with the piers.
 * - Wiri oil terminal (AKL.wiri): the storage tanks (core/sites.ts WIRI_TANKS, so they stand without
 *   the file too) and the terminal's buildings.
 * - Stadiums with OSM grandstands (Eden Park, AKL.eden_park; Mt Smart, North Harbour, …).
 *
 * Without the file, auckland.ts keeps its hand-placed port and marinas; the Wiri tanks still stand.
 */
import { Color } from 'three';
import { AKL } from '../../core/auckland';
import { WIRI_TANKS } from '../../core/sites';
import { sparkArenaCovers } from '../../core/sparkArena';
import { EDEN_PARK_STANDS } from '../../core/edenPark';
import { CONTAINER_TIER, PORT_CRANES, PORT_MASTS, type PortCrane } from '../../core/portOfAuckland';
import { aucklandPortStacks } from './aucklandPort';
import { WESTFIELD_PRISMS } from '../../core/westfieldNewmarket';
import { aucklandNeighbourhoods, neighbourhoodAt, type Neighbourhood } from './aucklandNeighbourhoods';
import { tamakiDriveRings } from './tamakiDriveData';
import { mulberry32 } from '../../core/math';
import { frameFromHeading, IDENT_FRAME, WIN_FLOOD, WIN_INDUSTRIAL, WIN_OFFICE, type GeometryBuilder } from './GeometryBuilder';
import type { DecalBuilder, HeightFn, LightList } from './builders';
import { aucklandLinz, fillLinzLand, linzIsLand } from '../terrain/theaters/aucklandLinz';
import {
  aucklandOsm,
  aucklandOsmVersion,
  distToPath,
  pointInRing,
  OSM_BREAKWATER,
  OSM_BUILDING,
  OSM_DEPOT,
  OSM_DOCK,
  OSM_GRANDSTAND,
  OSM_MARINA,
  OSM_MILITARY,
  OSM_NAVAL,
  OSM_PIER,
  OSM_PORT,
  OSM_STADIUM,
  type OsmFeature,
} from './aucklandOsm';

/** A ring (flat XZ, closed implicitly) with its bounding box. */
export interface Ring {
  pts: Float32Array;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  name: string;
}

export interface SiteLayout {
  /** Port land (all `industrial=port` rings: the Waitematā wharves, Onehunga). */
  port: Ring[];
  /** Pier / pontoon outlines, including closed pier ways (Calliope Wharf). */
  piers: Ring[];
  /** Open pier ways (jetties drawn along the line). */
  pierLines: OsmFeature[];
  breakwaters: Ring[];
  breakwaterLines: OsmFeature[];
  marinas: Ring[];
  /** Devonport Naval Base: the military outline round AKL.naval_base. */
  naval: Ring | null;
  /** Wiri oil terminal outline. */
  depot: Ring | null;
  docks: Ring[];
  stadiums: { outline: Ring; stands: Ring[] }[];
  /** Buildings inside the port, the naval base and the terminal (height in m, 0 = untagged). */
  buildings: (Ring & { height: number })[];
}

function ringOf(pts: Float32Array, name = ''): Ring {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]);
    x1 = Math.max(x1, pts[i]);
    z0 = Math.min(z0, pts[i + 1]);
    z1 = Math.max(z1, pts[i + 1]);
  }
  return { pts, x0, z0, x1, z1, name };
}

/** Inside the ring (bounding box first). */
export function inRing(r: Ring, x: number, z: number): boolean {
  return x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1 && pointInRing(r.pts, x, z);
}

/** Shoelace area (m², unsigned). */
export function areaOf(pts: ArrayLike<number>): number {
  let a = 0;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += pts[j * 2] * pts[i * 2 + 1] - pts[i * 2] * pts[j * 2 + 1];
  return Math.abs(a / 2);
}

/** Vertex mean (good enough for the convex-ish footprints it is used on). */
export function centreOf(pts: ArrayLike<number>): [number, number] {
  let sx = 0, sz = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    sx += pts[i * 2];
    sz += pts[i * 2 + 1];
  }
  return [sx / n, sz / n];
}

/** A line way that closes on itself (OSM draws some wharves as an outline without area=yes). */
function closedLine(f: OsmFeature): Float32Array | null {
  const n = f.pts.length / 2;
  if (n < 4 || Math.hypot(f.pts[0] - f.pts[n * 2 - 2], f.pts[1] - f.pts[n * 2 - 1]) > 1) return null;
  return f.pts.slice(0, n * 2 - 2);
}

let cache: SiteLayout | null = null;
let cacheVersion = -1;

/** The sites from the installed OSM data, or null without it. */
export function siteLayout(): SiteLayout | null {
  const d = aucklandOsm();
  if (!d) return null;
  if (cache && cacheVersion === aucklandOsmVersion()) return cache;
  const fs = d.features;
  const of = (layer: number) => fs.filter((f) => f.layer === layer);
  const areas = (layer: number) => of(layer).filter((f) => f.area).map((f) => ringOf(f.pts, f.name));
  const piers = areas(OSM_PIER);
  const pierLines: OsmFeature[] = [];
  for (const f of of(OSM_PIER).filter((f) => !f.area)) {
    const c = closedLine(f);
    if (c) piers.push(ringOf(c, f.name));
    else pierLines.push(f);
  }
  const breakwaters = areas(OSM_BREAKWATER);
  const breakwaterLines = of(OSM_BREAKWATER).filter((f) => !f.area);
  const nb = AKL.naval_base;
  const navalF = [...of(OSM_MILITARY), ...of(OSM_NAVAL)].filter((f) => f.area && pointInRing(f.pts, nb.x, nb.z)).sort((a, b) => areaOf(b.pts) - areaOf(a.pts))[0];
  const depotF = of(OSM_DEPOT).find((f) => pointInRing(f.pts, AKL.wiri.x, AKL.wiri.z)) ?? null;
  const stands = areas(OSM_GRANDSTAND);
  const stadiums = areas(OSM_STADIUM)
    .map((outline) => ({ outline, stands: stands.filter((s) => inRing(outline, ...centreOf(s.pts))) }))
    .filter((s) => s.stands.length > 0);
  cache = {
    port: areas(OSM_PORT),
    piers,
    pierLines,
    breakwaters,
    breakwaterLines,
    marinas: areas(OSM_MARINA),
    naval: navalF ? ringOf(navalF.pts, navalF.name) : null,
    depot: depotF ? ringOf(depotF.pts, depotF.name) : null,
    docks: areas(OSM_DOCK),
    stadiums,
    buildings: of(OSM_BUILDING).map((f) => ({ ...ringOf(f.pts, f.name), height: f.width })),
  };
  cacheVersion = aucklandOsmVersion();
  return cache;
}

/**
 * Keeps the scattered houses and trees off the sites (sources.ts `blocked`): port land, the naval
 * base's land, the oil terminal's hardstand, the stadium grounds and Spark Arena (core/sparkArena.ts,
 * always). Without the OSM data only the terminal's fallback hardstand and the arena (#61).
 */
export function siteBlocker(): (x: number, z: number, margin: number) => boolean {
  const s = siteLayout();
  const pad = ringOf(Float32Array.from(wiriHardstand(s)));
  const rings = s ? [...s.port, ...(s.naval ? [s.naval] : []), pad, ...s.stadiums.map((st) => st.outline)] : [pad];
  return (x, z) => sparkArenaCovers(x, z, 15) || rings.some((r) => inRing(r, x, z));
}

/**
 * The landmark sites the procedural street grid must not run through (Scenery.siteMask → the terrain shader's
 * siteMasked()): every stadium's grounds, the oil terminal's hardstand and Westfield Newmarket's buildings, where a 3D
 * landmark stands, and the hero neighbourhoods' footprints: Mission Bay lies outside the real-streets region, so its
 * measured houses would otherwise stand on painted grid lots (its LINZ streets are ribbons: tools/linz/neighbourhoodStreets.ts;
 * inside the region, Herne Bay's and Westhaven's change nothing), and the Tāmaki Drive waterfront's strip. The port and the
 * naval base are not here: they lie in the real-streets region or under the aerial photo, which never paint the grid.
 */
export function siteRings(): Float32Array[] {
  const s = siteLayout();
  return [
    Float32Array.from(wiriHardstand(s)),
    ...(s ? s.stadiums.map((st) => st.outline.pts) : []),
    ...WESTFIELD_PRISMS.map((p) => Float32Array.from(p.ring)),
    ...(aucklandNeighbourhoods() ?? []).map((n) => n.footprint),
    // the Tāmaki Drive waterfront (its paths, verges and trees: tamakiDrive.ts), in short pieces
    ...tamakiDriveRings(),
  ];
}

/**
 * Water test on the real LINZ coastline over a box, rasterised at `cell` m (dense queries stay cheap;
 * outside the box it asks the vector rings). The terrain mesh (~40–80 m cells) is too coarse for the
 * port basins and marina fairways. Without LINZ data: the terrain height.
 */
export function waterMask(x0: number, z0: number, x1: number, z1: number, cell: number, height: HeightFn): (x: number, z: number) => boolean {
  const d = aucklandLinz();
  if (!d) return (x, z) => height(x, z) < -0.5;
  const n = Math.ceil(Math.max(x1 - x0, z1 - z0) / cell) + 2;
  const labels = new Uint8Array(n * n);
  fillLinzLand(d, labels, { n, x0, z0, cell }, n, 1);
  return (x, z) => {
    const i = Math.round((x - x0) / cell);
    const j = Math.round((z - z0) / cell);
    if (i < 0 || j < 0 || i >= n || j >= n) return !linzIsLand(d, x, z);
    return labels[j * n + i] === 0;
  };
}

/* ───────────────────────────── Berth faces ───────────────────────────── */

export interface BerthFace {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  length: number;
  /** Unit vector along the face (a → b) and the outward normal (towards the water). */
  ux: number;
  uz: number;
  nx: number;
  nz: number;
}

/**
 * The straight faces of a port ring that ships can lie alongside: ≥ `minLength` long (consecutive
 * edges within 8° merged), water 35 m out (and outside every port ring), port land 20 m in.
 */
export function berthFaces(ring: Ring, isWater: (x: number, z: number) => boolean, allPort: Ring[], minLength = 150): BerthFace[] {
  const p = ring.pts;
  const n = p.length / 2;
  // runs of nearly collinear edges, starting at the sharpest corner so no run wraps round
  const dir = (i: number) => Math.atan2(p[((i + 1) % n) * 2 + 1] - p[i * 2 + 1], p[((i + 1) % n) * 2] - p[i * 2]);
  const turn = (i: number) => Math.abs(((dir(i) - dir((i + n - 1) % n) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
  let start = 0;
  for (let i = 1; i < n; i++) if (turn(i) > turn(start)) start = i;
  const faces: BerthFace[] = [];
  let a = start;
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n;
    const ax = p[a * 2], az = p[a * 2 + 1];
    const bx = p[i * 2], bz = p[i * 2 + 1];
    const nextDir = dir(i);
    const runDir = Math.atan2(bz - az, bx - ax);
    const bend = Math.abs(((nextDir - runDir + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
    if (k < n && bend < (8 * Math.PI) / 180) continue;
    const L = Math.hypot(bx - ax, bz - az);
    a = i;
    if (L < minLength) continue;
    const ux = (bx - ax) / L, uz = (bz - az) / L;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    for (const s of [1, -1]) {
      const nx = -uz * s, nz = ux * s;
      const ox = mx + nx * 35, oz = mz + nz * 35;
      if (isWater(ox, oz) && !allPort.some((r) => inRing(r, ox, oz)) && inRing(ring, mx - nx * 20, mz - nz * 20)) {
        faces.push({ ax, az, bx, bz, length: L, ux, uz, nx, nz });
        break;
      }
    }
  }
  return faces;
}

/* ───────────────────────────── Builders ───────────────────────────── */

const CONTAINER_COLORS = [0xb03a2e, 0x2e5a9a, 0x2f7a4a, 0xd87a2a, 0xe8e6e0, 0x6a6e72, 0x9a2e5a, 0x1f3f6a, 0x8a6a3a, 0x3a8a9a];

/** Highest ground under a ring (vertices and a 40 m grid inside), clamped to a wharf's 2.5–6 m. */
function deckHeight(r: Ring, height: HeightFn): number {
  let hi = 2.5;
  for (let i = 0; i < r.pts.length; i += 2) hi = Math.max(hi, height(r.pts[i], r.pts[i + 1]));
  for (let x = r.x0; x <= r.x1; x += 40) for (let z = r.z0; z <= r.z1; z += 40) if (pointInRing(r.pts, x, z)) hi = Math.max(hi, height(x, z));
  return Math.min(6, hi) + 0.4;
}

/** A building footprint extruded from its lowest ground, to its OSM height or one from its size. */
function building(B: GeometryBuilder, b: Ring & { height: number }, height: HeightFn, base: number | null, wall: number, roof: number, win: number): void {
  const area = areaOf(b.pts);
  if (area < 25) return;
  let lo = Infinity;
  for (let i = 0; i < b.pts.length; i += 2) lo = Math.min(lo, height(b.pts[i], b.pts[i + 1]));
  const y0 = base ?? lo - 1;
  const h = b.height > 0 ? Math.min(60, b.height) : area > 4000 ? 15 : area > 1000 ? 11 : 7;
  B.prism(b.pts, y0, () => y0 + h + (base === null ? 1 : 0), wall, roof, win);
}

/**
 * Ports of Auckland from the OSM port outline: deck, sheds, container stacks and gantry cranes on the
 * berth faces. Returns the berth faces (for the tests and the e2e shots).
 */
export function buildRealPort(B: GeometryBuilder, lights: LightList, height: HeightFn, detail: number, s: SiteLayout): BerthFace[] {
  const rnd = mulberry32(99);
  const deckCol = new Color(0x8f8c86);
  const sideCol = new Color(0x77746e);
  const allFaces: BerthFace[] = [];
  for (const ring of s.port) {
    const y = deckHeight(ring, height);
    B.prism(ring.pts, -4, () => y, sideCol, deckCol);
    const sheds = s.buildings.filter((b) => inRing(ring, ...centreOf(b.pts)));
    for (const b of sheds) building(B, b, height, y - 0.2, 0xbfc3c4, 0x7d8388, WIN_INDUSTRIAL);
    if (areaOf(ring.pts) < 100_000) continue;
    const isWater = waterMask(ring.x0 - 100, ring.z0 - 100, ring.x1 + 100, ring.z1 + 100, 2, height);
    const faces = berthFaces(ring, isWater, s.port).sort((a, b) => b.length - a.length);
    allFaces.push(...faces);
    // The measured port (core/portOfAuckland.ts): its ring is the one the real cranes stand on
    const hero = PORT_CRANES.some((c) => inRing(ring, c.x - c.ux * 10, c.z - c.uz * 10));
    const cranePos: [number, number][] = [];
    if (hero) {
      for (const c of PORT_CRANES) {
        portCrane(B, c, y, lights, rnd);
        cranePos.push([c.x - c.ux * 18, c.z - c.uz * 18]);
      }
    } else {
      // Gantry cranes along the longest faces, booms out over the water
      let cranes = detail > 0.5 ? 9 : 5;
      const craneCol = new Color(0xdad8d2);
      const boomCol = new Color(0xc0392b);
      for (const f of faces) {
        if (cranes <= 0) break;
        const k = Math.min(cranes, 4, Math.floor(f.length / 85));
        cranes -= k;
        for (let i = 0; i < k; i++) {
          const t = f.length / 2 + (i - (k - 1) / 2) * 80;
          const x = f.ax + f.ux * t - f.nx * 18;
          const z = f.az + f.uz * t - f.nz * 18;
          cranePos.push([x, z]);
          // local −Z = out over the water, local X = along the face
          const fr = frameFromHeading(x, y, z, Math.atan2(f.nx, -f.nz));
          const legH = 44;
          for (const ox of [-9, 9]) for (const oz of [-12, 12]) B.beam(fr, ox, 0, oz, ox, legH, oz, 1.6, craneCol);
          B.beam(fr, -9, legH, -12, 9, legH, -12, 1.8, craneCol);
          B.beam(fr, -9, legH, 12, 9, legH, 12, 1.8, craneCol);
          B.beam(fr, -9, 16, -12, -9, 16, 12, 1.2, craneCol);
          B.beam(fr, 9, 16, -12, 9, 16, 12, 1.2, craneCol);
          // boom out over the water and backreach; a raised boom on every third (idle) crane
          if (i % 3 === 2) B.beam(fr, 0, legH + 2, -10, 0, legH + 58, -30, 2.4, boomCol);
          else B.beam(fr, 0, legH + 2, 40, 0, legH + 2, -62, 2.4, boomCol);
          B.box(fr, 0, legH - 1, 10, 14, 7, 12, craneCol, craneCol, WIN_INDUSTRIAL);
          B.beam(fr, 0, legH + 2, 8, 0, legH + 20, 2, 1.2, craneCol);
          lights.add(x - f.nx * 2, y + legH + 22, z - f.nz * 2, 0xff2a18, 3, rnd());
        }
      }
    }
    // Container stacks: the LiDAR's blocks where the baked file is in (aucklandPort.ts), else procedural ones
    const stacks = hero ? aucklandPortStacks() : null;
    if (stacks) {
      const tmp = new Color();
      const minArea = detail < 0.5 ? 40 : 0; // the low tier keeps the bigger blocks (≈ 2 containers and up)
      for (const st of stacks) {
        if (st.w * st.d < minArea || !inRing(ring, st.x, st.z)) continue;
        const fr = frameFromHeading(st.x, 0, st.z, st.angle);
        tmp.setHex(st.color);
        B.box(fr, 0, y, 0, st.w, st.tiers * CONTAINER_TIER, st.d, tmp, tmp.clone().multiplyScalar(0.9));
      }
    } else {
      // Container stacks on the open deck, aligned with the nearest berth face
      const step = detail > 0.5 ? 40 : 52;
      for (let x = ring.x0 + step / 2; x < ring.x1; x += step) {
        for (let z = ring.z0 + step / 2; z < ring.z1; z += step) {
          if (rnd() < 0.15 || !pointInRing(ring.pts, x, z) || distToPath(ring.pts, x, z, true) < 45) continue;
          if (sheds.some((b) => x > b.x0 - 15 && x < b.x1 + 15 && z > b.z0 - 15 && z < b.z1 + 15)) continue;
          if (cranePos.some(([cx, cz]) => Math.hypot(cx - x, cz - z) < 40)) continue;
          let face: BerthFace | null = null;
          let best = 400;
          for (const f of faces) {
            const d = distToPath([f.ax, f.az, f.bx, f.bz], x, z, false);
            if (d < best) {
              best = d;
              face = f;
            }
          }
          const fr = frameFromHeading(x, y, z, face ? Math.atan2(face.ux, -face.uz) : 0);
          const tiers = 1 + ((rnd() * 4) | 0);
          for (const c of [-0.5, 0.5]) {
            const col = CONTAINER_COLORS[(rnd() * CONTAINER_COLORS.length) | 0];
            B.box(fr, c * 12.5, 0, 0, 12, 2.6 * tiers, 24.4, col, new Color(col).multiplyScalar(0.8));
          }
        }
      }
    }
    // Flood light masts: where the LiDAR found them on the measured port, else behind the berths
    if (hero) {
      for (const [x, z, h] of PORT_MASTS) {
        if (!inRing(ring, x, z)) continue;
        B.beam(IDENT_FRAME, x, y, z, x, y + h - 1.5, z, 0.8, 0x9a9a98);
        B.box(IDENT_FRAME, x, y + h - 2.2, z, 4, 2.2, 1.2, 0x55595d, 0x55595d);
        lights.add(x, y + h, z, 0xfff0d0, 10);
      }
    } else {
      // Flood light towers behind the berths
      let floods = 0;
      for (const f of faces) {
        for (let t = 60; t < f.length - 30 && floods < 14; t += 150, floods++) {
          const x = f.ax + f.ux * t - f.nx * 75;
          const z = f.az + f.uz * t - f.nz * 75;
          if (!inRing(ring, x, z)) continue;
          B.beam(IDENT_FRAME, x, y, z, x, y + 30, z, 1, 0x9a9a98);
          lights.add(x, y + 31, z, 0xfff0d0, 10);
        }
      }
    }
  }
  return allFaces;
}

/**
 * A ship-to-shore crane as measured (core/portOfAuckland.ts): legs on a 30.5 m gauge behind the quay edge, the girder
 * over the backreach and the boom (lowered over the berth, or raised), the A-frame over the waterside legs with its
 * stays, the machinery house on the backreach, the trolley and spreader under a lowered boom. White frame, dark blue
 * girder and boom (photos). Local frame: x along the boom (towards the water), z along the rails.
 */
function portCrane(B: GeometryBuilder, c: PortCrane, deck: number, lights: LightList, rnd: () => number): void {
  const f = frameFromHeading(c.x, 0, c.z, Math.atan2(c.uz, c.ux));
  const g = deck + c.girder, apexY = deck + c.apex, big = c.girder > 50;
  const uw = -3, ul = uw - 30.5, half = big ? 10 : 9, hinge = 4;
  const white = 0xe6e8e6, blue = 0x214d8c, grey = 0x8c9396;
  const beam = (a: number[], b: number[], w: number, col: number) => B.beam(f, a[0], a[1], a[2], b[0], b[1], b[2], w, col);
  for (const v of [-half, half]) {
    beam([uw, deck, v], [uw, g - 2, v], 2.2, white);
    beam([ul, deck, v], [ul, g - 2, v], 2.2, white);
    beam([ul, deck + 1.5, v], [uw, deck + 1.5, v], 1.6, white);
    beam([ul, g - 14, v], [uw, g - 14, v], 1.8, white);
    beam([ul, g - 2, v], [uw, g - 2, v], 2.2, white);
  }
  for (const u of [uw, ul]) {
    beam([u, g - 2, -half], [u, g - 2, half], 2.4, white);
    beam([u, g - 14, -half], [u, g - 14, half], 1.6, white);
  }
  const end = c.boomTop === null ? c.tip : hinge;
  for (const v of [-3.6, 3.6]) beam([c.back, g, v], [end, g, v], 2.4, blue);
  for (let u = c.back + 8; u < end - 4; u += 12) beam([u, g, -3.6], [u, g, 3.6], 0.8, blue);
  let tip: number[];
  if (c.boomTop !== null) {
    const rise = c.boomTop - c.girder, L = Math.max(rise + 1, big ? 66 : 60), du = Math.sqrt(Math.max(0, L * L - rise * rise));
    for (const v of [-3.6, 3.6]) beam([hinge, g, v], [hinge + du, deck + c.boomTop, v], 2.2, blue);
    tip = [hinge + du, deck + c.boomTop, 0];
  } else tip = [c.tip, g, 0];
  const ua = uw - 6;
  for (const v of [-4, 4]) {
    beam([uw, g, v], [ua, apexY, v * 0.4], 1.4, white);
    beam([ul + 8, g, v], [ua, apexY, v * 0.4], 1.4, white);
  }
  for (const v of [-3, 3]) {
    beam([ua, apexY - 0.5, v * 0.4], [tip[0], tip[1], v], 0.45, grey);
    beam([ua, apexY - 0.5, v * 0.4], [c.back + 2, g + 1, v], 0.45, grey);
  }
  B.box(f, c.back + 9, g + 1, 0, 14, 6, 11, white, white);
  if (c.boomTop === null) {
    const ut = Math.min(c.tip - 8, 25);
    B.box(f, ut, g - 4, 0, 4, 2.8, 4, 0x52595f, 0x52595f);
    B.box(f, ut, g - 14, 0, 2.8, 1, 12, 0xd9a626, 0xd9a626);
  }
  const [ax, az] = [c.x + c.ux * ua, c.z + c.uz * ua];
  lights.add(ax, apexY + 1, az, 0xff2a18, 3, rnd());
  lights.add(c.x + c.ux * tip[0], tip[1] + 1, c.z + c.uz * tip[0], 0xff2a18, 3, rnd());
}

/**
 * Piers and pontoons, breakwaters, and yachts berthed along the marina pontoons. Wharves the LINZ
 * coastline already has as land (and port land, decked by buildRealPort) are skipped.
 */
export function buildRealWaterside(B: GeometryBuilder, lights: LightList, height: HeightFn, detail: number, s: SiteLayout): number {
  const rnd = mulberry32(7);
  const pontoonCol = new Color(0x9a8f7c);
  const wharfCol = new Color(0x8e8a82);
  const wharfSide = new Color(0x6f6a62);
  const rock = new Color(0x5f5d58);
  const rockTop = new Color(0x6f6c66);
  const inMarina = (x: number, z: number) => s.marinas.some((m) => inRing(m, x, z));
  const inPort = (x: number, z: number) => s.port.some((p) => inRing(p, x, z));
  const linz = aucklandLinz();
  const onLand = (x: number, z: number) => (linz ? linzIsLand(linz, x, z) : height(x, z) > 0.5);
  const pontoons: Ring[] = [];
  // a hero neighbourhood with a measured marina (Westhaven) brings its own pontoons and boats
  const marine = (aucklandNeighbourhoods() ?? []).filter((n) => n.pontoons.length || n.boats.length);
  const measured = (x: number, z: number) => !!neighbourhoodAt(x, z, marine);
  for (const r of s.piers) {
    const area = areaOf(r.pts);
    if (area < 6) continue;
    const [cx, cz] = centreOf(r.pts);
    if (inPort(cx, cz) || onLand(cx, cz)) continue;
    if (inMarina(cx, cz) && area < 20_000 && measured(cx, cz)) continue;
    if (inMarina(cx, cz) && area < 20_000) {
      B.prism(r.pts, 0, () => 0.8, pontoonCol, pontoonCol, 0, false);
      pontoons.push(r);
      if (area > 400) lights.add(cx, 3, cz, 0xfff0d0, 2.5);
    } else B.prism(r.pts, -2, () => 2.6, wharfSide, wharfCol);
  }
  for (const f of s.pierLines) {
    const w = Math.max(2.5, Math.min(8, f.width || 3));
    for (let i = 0; i + 3 < f.pts.length; i += 2) B.beam(IDENT_FRAME, f.pts[i], 2.6 - w / 2, f.pts[i + 1], f.pts[i + 2], 2.6 - w / 2, f.pts[i + 3], w, wharfCol);
  }
  for (const r of s.breakwaters) {
    const [cx, cz] = centreOf(r.pts);
    if (onLand(cx, cz) && !inMarina(cx, cz)) continue;
    B.prism(r.pts, -3, () => 2.2, rock, rockTop);
  }
  for (const f of s.breakwaterLines) {
    for (let i = 0; i + 3 < f.pts.length; i += 2) B.beam(IDENT_FRAME, f.pts[i], -1.5, f.pts[i + 1], f.pts[i + 2], -1.5, f.pts[i + 3], 6, rock);
  }
  let boats = 0;
  const max = detail > 0.5 ? 2400 : 900;
  for (const n of marine) boats += buildMeasuredMarina(B, lights, n, pontoonCol, detail, max - boats);
  for (const m of s.marinas) {
    const mine = pontoons.filter((r) => inRing(m, ...centreOf(r.pts)));
    if (mine.length) boats += berthYachts(B, waterMask(m.x0 - 30, m.z0 - 30, m.x1 + 30, m.z1 + 30, 2, height), detail, mine, max - boats, rnd);
  }
  return boats;
}

/**
 * A hero neighbourhood's marina as measured (aucklandNeighbourhoods.ts, Westhaven): every pontoon and finger from the
 * 2024 aerial as a slab 0.8 m over the water, every boat with its own length, beam, heading, hull colour and the
 * LiDAR's deck, cabin and mast heights. Low detail drops the cabins and masts. Returns the number of boats.
 */
function buildMeasuredMarina(B: GeometryBuilder, lights: LightList, n: Neighbourhood, pontoonCol: Color, detail: number, max: number): number {
  for (const r of n.pontoons) {
    B.prism(r, 0, () => 0.8, pontoonCol, pontoonCol, 0, false);
    if (Math.abs(areaOf(r)) > 400) {
      const [cx, cz] = centreOf(r);
      lights.add(cx, 3, cz, 0xfff0d0, 2.5);
    }
  }
  const col = new Color();
  const side = new Color();
  const cabin = new Color(0xe8eaea);
  const mast = new Color(0xd0d0cc);
  let k = 0;
  for (const b of n.boats) {
    if (k >= max) break;
    const fr = frameFromHeading(b.x, 0, b.z, Math.atan2(-Math.cos(b.heading), Math.sin(b.heading))); // local +Z towards the bow
    const l = b.length / 2;
    const hw = b.beam / 2;
    const deck = Math.max(0.9, Math.min(3, b.deck));
    col.setHex(b.color).lerp(cabin, 0.35);
    side.copy(col).multiplyScalar(0.85);
    // deck (pointed at the bow) + two sloped sides meeting at the keel line
    B.quad(fr, [-hw, deck, l * 0.55, hw, deck, l * 0.55, hw, deck, -l, -hw, deck, -l], col);
    B.tri(fr, [-hw, deck, l * 0.55, 0, deck, l, hw, deck, l * 0.55], col);
    B.quad(fr, [hw, deck, l * 0.55, 0, 0, l - 0.5, 0, 0, -l + 0.5, hw, deck, -l], side);
    B.quad(fr, [-hw, deck, -l, 0, 0, -l + 0.5, 0, 0, l - 0.5, -hw, deck, l * 0.55], side);
    if (detail > 0.3) {
      if (b.cabin > 0.3) B.box(fr, 0, deck, -l * 0.1, b.beam * 0.55, Math.min(b.cabin, 3), b.length * 0.4, cabin, cabin);
      if (b.mast > deck + 3) B.quad(fr, [-0.12, deck, l * 0.15, 0.12, deck, l * 0.15, 0.08, b.mast, l * 0.15, -0.08, b.mast, l * 0.15], mast);
    }
    k++;
  }
  return k;
}

interface Boat {
  x: number;
  z: number;
  ux: number;
  uz: number;
  L: number;
  W: number;
}

/**
 * Yachts alongside the pontoons: on a 4 m grid of the water within 1.5–6 m of a pontoon edge, each
 * hull parallel to its nearest edge (a finger berth), never overlapping another or a pontoon.
 * Returns the number of boats.
 */
function berthYachts(B: GeometryBuilder, isWater: (x: number, z: number) => boolean, detail: number, pontoons: Ring[], max: number, rnd: () => number): number {
  if (!pontoons.length || max <= 0) return 0;
  // pontoon edges bucketed on a 16 m grid
  const CELL = 16;
  const grid = new Map<number, number[]>();
  const key = (i: number, j: number) => i * 100_003 + j;
  const segs: number[] = [];
  for (const r of pontoons) {
    const n = r.pts.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const s = segs.length;
      segs.push(r.pts[i * 2], r.pts[i * 2 + 1], r.pts[j * 2], r.pts[j * 2 + 1]);
      const x0 = Math.floor(Math.min(r.pts[i * 2], r.pts[j * 2]) / CELL), x1 = Math.floor(Math.max(r.pts[i * 2], r.pts[j * 2]) / CELL);
      const z0 = Math.floor(Math.min(r.pts[i * 2 + 1], r.pts[j * 2 + 1]) / CELL), z1 = Math.floor(Math.max(r.pts[i * 2 + 1], r.pts[j * 2 + 1]) / CELL);
      for (let a = x0; a <= x1; a++)
        for (let b = z0; b <= z1; b++) {
          const k = key(a, b);
          const l = grid.get(k);
          if (l) l.push(s);
          else grid.set(k, [s]);
        }
    }
  }
  /** Nearest pontoon edge within 8 m: [distance, ux, uz] or null. */
  const nearest = (x: number, z: number): [number, number, number] | null => {
    let best = 8;
    let out: [number, number, number] | null = null;
    const ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
    for (let a = ci - 1; a <= ci + 1; a++)
      for (let b = cj - 1; b <= cj + 1; b++) {
        for (const s of grid.get(key(a, b)) ?? []) {
          const ax = segs[s], az = segs[s + 1], dx = segs[s + 2] - ax, dz = segs[s + 3] - az;
          const l2 = dx * dx + dz * dz;
          if (l2 < 1) continue;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
          const d = Math.hypot(x - ax - dx * t, z - az - dz * t);
          if (d < best) {
            best = d;
            const l = Math.sqrt(l2);
            out = [d, dx / l, dz / l];
          }
        }
      }
    return out;
  };
  const onPontoon = (x: number, z: number) => pontoons.some((r) => inRing(r, x, z));
  const boats: Boat[] = [];
  const boatGrid = new Map<number, Boat[]>();
  /** Projected half-extent of a hull on the unit axis (ax, az). */
  const proj = (h: Boat, ax: number, az: number) => (Math.abs(h.ux * ax + h.uz * az) * h.L) / 2 + (Math.abs(-h.uz * ax + h.ux * az) * h.W) / 2;
  /** Overlaps (with 0.6 m to spare) a boat already berthed: separating-axis test on both hulls' axes. */
  const clash = (b: Boat) => {
    const ci = Math.floor(b.x / CELL), cj = Math.floor(b.z / CELL);
    for (let a = ci - 1; a <= ci + 1; a++)
      for (let c = cj - 1; c <= cj + 1; c++)
        for (const o of boatGrid.get(key(a, c)) ?? []) {
          const axes = [b.ux, b.uz, -b.uz, b.ux, o.ux, o.uz, -o.uz, o.ux];
          let separated = false;
          for (let k = 0; k < 8 && !separated; k += 2) {
            const d = Math.abs((o.x - b.x) * axes[k] + (o.z - b.z) * axes[k + 1]);
            separated = d > proj(b, axes[k], axes[k + 1]) + proj(o, axes[k], axes[k + 1]) + 0.6;
          }
          if (!separated) return true;
        }
    return false;
  };
  const STEP = 4;
  for (const r of pontoons) {
    for (let x = r.x0 - 8; x <= r.x1 + 8 && boats.length < max; x += STEP) {
      for (let z = r.z0 - 8; z <= r.z1 + 8 && boats.length < max; z += STEP) {
        if (rnd() < 0.2) continue;
        const nb = nearest(x, z);
        if (!nb) continue;
        const L = 9 + rnd() * 7;
        const W = 3 + L * 0.06;
        if (nb[0] < W / 2 + 0.6 || nb[0] > W / 2 + 2.5) continue;
        const b: Boat = { x, z, ux: nb[1], uz: nb[2], L, W };
        const ends: [number, number][] = [];
        for (const sl of [-0.5, 0.5]) for (const sw of [-0.5, 0.5]) ends.push([x + b.ux * L * sl - b.uz * W * sw, z + b.uz * L * sl + b.ux * W * sw]);
        if (ends.some(([ex, ez]) => onPontoon(ex, ez) || !isWater(ex, ez)) || clash(b)) continue;
        boats.push(b);
        const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
        const l = boatGrid.get(k);
        if (l) l.push(b);
        else boatGrid.set(k, [b]);
      }
    }
  }
  const hull = new Color(0xf2f2ee);
  const hullSide = new Color(0xd8d8d2);
  const mast = new Color(0xd0d0cc);
  for (const b of boats) {
    const fr = frameFromHeading(b.x, 0, b.z, Math.atan2(b.ux, -b.uz)); // local −Z along the hull
    const l = b.L / 2;
    const hw = b.W / 2;
    // deck + two sloped sides meeting at the keel line
    B.quad(fr, [-hw, 1.6, l, hw, 1.6, l, hw, 1.6, -l, -hw, 1.6, -l], hull);
    B.quad(fr, [hw, 1.6, l, 0, 0, l - 1, 0, 0, -l + 1, hw, 1.6, -l], hullSide);
    B.quad(fr, [-hw, 1.6, -l, 0, 0, -l + 1, 0, 0, l - 1, -hw, 1.6, l], hullSide);
    if (detail > 0.3 && rnd() < 0.75) {
      const mh = 1.6 + b.L * 1.3;
      B.quad(fr, [-0.15, 1.6, 0, 0.15, 1.6, 0, 0.1, mh, 0, -0.1, mh, 0], mast);
    }
  }
  return boats.length;
}

/** Devonport Naval Base: its buildings and Calliope Dock (Calliope Wharf is one of the piers). */
export function buildNavalBase(B: GeometryBuilder, lights: LightList, height: HeightFn, s: SiteLayout): void {
  const base = s.naval;
  if (!base) return;
  for (const b of s.buildings) {
    const [cx, cz] = centreOf(b.pts);
    if (!inRing(base, cx, cz)) continue;
    building(B, b, height, null, 0xb9bcbc, 0x5f6a70, WIN_OFFICE);
  }
  // the dry dock: a sunken dark floor inside a concrete coping, a caisson across its seaward end
  const coping = new Color(0xa8a6a0);
  for (const d of s.docks) {
    const [cx, cz] = centreOf(d.pts);
    if (Math.hypot(cx - AKL.naval_base.x, cz - AKL.naval_base.z) > 1500) continue;
    let lo = Infinity;
    for (let i = 0; i < d.pts.length; i += 2) lo = Math.min(lo, height(d.pts[i], d.pts[i + 1]));
    B.prism(d.pts, lo - 1, () => lo + 0.35, 0x3a3e40, 0x3a3e40);
    // keel blocks down the dock's long axis (its two farthest vertices)
    let a = 0, b = 0, best = 0;
    const n = d.pts.length / 2;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const L = Math.hypot(d.pts[i * 2] - d.pts[j * 2], d.pts[i * 2 + 1] - d.pts[j * 2 + 1]);
        if (L > best) [best, a, b] = [L, i, j];
      }
    const ax = d.pts[a * 2], az = d.pts[a * 2 + 1];
    const ux = (d.pts[b * 2] - ax) / best, uz = (d.pts[b * 2 + 1] - az) / best;
    const fr = frameFromHeading(cx, lo + 0.35, cz, Math.atan2(ux, -uz));
    for (let t = -best / 2 + 15; t < best / 2 - 15; t += 12) B.box(fr, 0, 0, t, 2, 1.4, 3, coping, coping);
    lights.add(cx, lo + 12, cz, 0xfff0d0, 6);
  }
}

/** Wiri oil terminal: its storage tanks (always: core/sites.ts) and, with the OSM data, its buildings. */
/** Margin (m) of the tank farm's bund wall round the fuel tanks, and of the fallback hardstand round all tanks. */
const WIRI_BUND_MARGIN = 10;
const WIRI_PAD_MARGIN = 45;

/** The tank farm's bund wall: a rectangle (x0, z0, x1, z1) round the fuel tanks. */
export function wiriBund(): [number, number, number, number] {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const t of WIRI_TANKS) {
    if (!t.fuel) continue;
    x0 = Math.min(x0, t.x - t.r);
    z0 = Math.min(z0, t.z - t.r);
    x1 = Math.max(x1, t.x + t.r);
    z1 = Math.max(z1, t.z + t.r);
  }
  const m = WIRI_BUND_MARGIN;
  return [x0 - m, z0 - m, x1 + m, z1 + m];
}

/**
 * The terminal's concrete hardstand: the OSM depot outline, else a rectangle round every tank. It hides
 * the terrain's procedural streets and lots, which ran between the tanks (#61 item 4).
 */
export function wiriHardstand(s: SiteLayout | null): ArrayLike<number> {
  if (s?.depot) return s.depot.pts;
  const m = WIRI_PAD_MARGIN;
  const x0 = Math.min(...WIRI_TANKS.map((t) => t.x - t.r)) - m;
  const z0 = Math.min(...WIRI_TANKS.map((t) => t.z - t.r)) - m;
  const x1 = Math.max(...WIRI_TANKS.map((t) => t.x + t.r)) + m;
  const z1 = Math.max(...WIRI_TANKS.map((t) => t.z + t.r)) + m;
  return [x0, z0, x1, z0, x1, z1, x0, z1];
}

/**
 * The Wiri oil terminal: the storage tanks with their bunds, the tank farm's bund wall, the depot's
 * OSM buildings and (with `pad`, the scenery's concrete decals) the hardstand under it all.
 */
export function buildWiriTerminal(B: GeometryBuilder, lights: LightList, height: HeightFn, s: SiteLayout | null, pad: DecalBuilder | null = null): void {
  pad?.polygon(wiriHardstand(s), height, 40, 60, 0.3);
  // bund wall round the tank farm (1.8 m, following the ground in ≤ 30 m pieces)
  const [bx0, bz0, bx1, bz1] = wiriBund();
  const corners = [bx0, bz0, bx1, bz0, bx1, bz1, bx0, bz1];
  for (let c = 0; c < 4; c++) {
    const ax = corners[c * 2];
    const az = corners[c * 2 + 1];
    const ex = corners[((c + 1) % 4) * 2];
    const ez = corners[((c + 1) % 4) * 2 + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(ex - ax, ez - az) / 30));
    for (let k = 0; k < n; k++) {
      const x = ax + ((ex - ax) * k) / n;
      const z = az + ((ez - az) * k) / n;
      const x2 = ax + ((ex - ax) * (k + 1)) / n;
      const z2 = az + ((ez - az) * (k + 1)) / n;
      B.beam(IDENT_FRAME, x, height(x, z) + 0.4, z, x2, height(x2, z2) + 0.4, z2, 1.8, 0x9c9a92);
    }
  }
  WIRI_TANKS.forEach((t, i) => {
    const y = height(t.x, t.z) - 0.5;
    const h = Math.max(8, Math.min(18, t.r * 0.9));
    B.cylinder(IDENT_FRAME, t.x, y, t.z, t.r, t.r, h, 16, t.fuel ? 0xe4e4e0 : 0xc8ccc8, 0, true, 0xcfd0cc);
    // bund wall round each fuel tank, a lamp on every other roof
    if (t.fuel) B.cylinder(IDENT_FRAME, t.x, y, t.z, t.r + 4, t.r + 4, 1.6, 16, 0x9c9a92, 0, false);
    if (i % 2 === 0) lights.add(t.x, y + h + 1, t.z, 0xfff0d0, 5);
  });
  if (!s?.depot) return;
  for (const b of s.buildings) if (inRing(s.depot, ...centreOf(b.pts))) building(B, b, height, null, 0xc4c6c2, 0x7c8084, WIN_INDUSTRIAL);
}

/**
 * Stadiums with OSM grandstands (Eden Park): the stands and four floodlight towers. Eden Park's four stands are measured
 * (core/edenPark.ts): strips across each stand from its back to the pitch at their LiDAR heights, the canopy and the
 * seating raking down. Other stadiums' stands rake from a guessed back height (26 m for a big stand, 14 m) down to
 * half of it at the pitch side. Plain concrete outside, floodlit at night.
 */
export function buildStadiums(B: GeometryBuilder, lights: LightList, height: HeightFn, s: SiteLayout): void {
  const stand = new Color(0xc9c7c0);
  const canopy = new Color(0xdfe3e3);
  const seats = new Color(0x56616b);
  for (const st of s.stadiums) {
    const [scx, scz] = centreOf(st.outline.pts);
    for (const r of st.stands) {
      let lo = Infinity;
      for (let i = 0; i < r.pts.length; i += 2) lo = Math.min(lo, height(r.pts[i], r.pts[i + 1]));
      const [cx, cz] = centreOf(r.pts);
      const measured = EDEN_PARK_STANDS.find((m) => Math.hypot(m.x - cx, m.z - cz) < 25);
      if (measured) {
        const g = height(measured.x, measured.z);
        for (const strip of measured.strips) B.prism(strip.ring, lo - 1, () => g + strip.h, stand, strip.h >= 8 ? canopy : seats, WIN_FLOOD);
        continue;
      }
      // a raked stand: its back (away from the pitch) at h, the pitch side at h / 2
      const h = areaOf(r.pts) > 3000 ? 26 : 14;
      let dx = scx - cx;
      let dz = scz - cz;
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl;
      dz /= dl;
      let t0 = Infinity;
      let t1 = -Infinity;
      for (let i = 0; i < r.pts.length; i += 2) {
        const t = (r.pts[i] - cx) * dx + (r.pts[i + 1] - cz) * dz;
        t0 = Math.min(t0, t);
        t1 = Math.max(t1, t);
      }
      const span = Math.max(1, t1 - t0);
      B.prism(r.pts, lo - 1, (x, z) => lo + h * (1 - (0.5 * ((x - cx) * dx + (z - cz) * dz - t0)) / span), stand, seats, WIN_FLOOD);
    }
    if (st.stands.length < 2) continue;
    // floodlight masts at the outline's four extreme points, pulled 15 m in
    const o = st.outline;
    const [cx, cz] = centreOf(o.pts);
    for (const [px, pz] of [[o.x0, cz], [o.x1, cz], [cx, o.z0], [cx, o.z1]]) {
      const d = Math.hypot(px - cx, pz - cz) || 1;
      const x = px + ((cx - px) / d) * 15;
      const z = pz + ((cz - pz) / d) * 15;
      const g = height(x, z);
      B.beam(IDENT_FRAME, x, g, z, x, g + 45, z, 1.6, 0x9a9c9c);
      B.box(IDENT_FRAME, x, g + 45, z, 8, 4, 8, 0xdedede, 0xdedede);
      lights.add(x, g + 47, z, 0xfff6e0, 12);
    }
  }
}
