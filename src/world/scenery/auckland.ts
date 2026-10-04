/**
 * Auckland landmarks (primary theatre): SkyCity (the Sky Tower is in skyTower.ts; the Harbour Bridge in harbourBridge.ts), CBD high-rise cluster, Ports of
 * Auckland container terminal, Westhaven & Viaduct marinas (both from OpenStreetMap when loaded: aucklandSites.ts,
 * which also has the naval base, the Wiri terminal and Eden Park), Auckland War Memorial Museum, One Tree
 * Hill obelisk. Positions come from src/core/auckland.ts (origin = Sky Tower). The CBD's buildings are
 * the real ones (LINZ outlines + LiDAR heights) when that data is installed, else procedural towers
 * on the streets the terrain shader paints (the real LINZ streets, or the urbanGrid.ts block grid).
 */
import { Color } from 'three';
import type { SceneryFeature } from '../../core/contracts';
import { AKL } from '../../core/auckland';
import { AIRFIELD_IDS, airfieldFeature, airfieldNear } from '../../core/airfields';
import { airfieldLayout } from './aucklandOsm';
import { buildRealPort, buildRealWaterside, siteLayout } from './aucklandSites';
import { mulberry32 } from '../../core/math';
import { frameFromHeading, GeometryBuilder, WIN_BALCONY, WIN_BANDS, WIN_CURTAIN, WIN_GLOW, WIN_HOME, WIN_INDUSTRIAL, WIN_LOBBY, WIN_NONE, WIN_OFFICE, type Frame } from './GeometryBuilder';
import type { CbdTower, TowerFacade } from '../../core/cbdTowers';
import { SCENE_FINS, type SceneTerraceKind } from '../../core/sceneApartments';
import { buildMuseum } from './museum';
import { LightList, type HeightFn } from './builders';
import { BLOCK_D, BLOCK_W, districtAt, toLocal, toWorld, blockHash, ROAD_HALF, type CbdGrid } from './urbanGrid';
import type { RoadNetwork } from './motorways';
import { FOOTPATH, pointInRing, type CbdStreets } from './cbdStreets';
import { ringArea, roofHeight, type Building, type BuildingPrism } from './aucklandBuildings';

const IDENT: Frame = { ox: 0, oy: 0, oz: 0, c: 1, s: 0 };

/**
 * Always-present Auckland features the terrain must flatten: the real airfields (Whenuapai, Auckland
 * Airport, Ardmore, North Shore at Dairy Flat), each levelled along its OpenStreetMap outline when the
 * OSM layer is loaded (aucklandOsm.ts), else along the template strip on its real main runway.
 */
export function aucklandBuiltinFeatures(): SceneryFeature[] {
  return AIRFIELD_IDS.map((id) => {
    const f = airfieldFeature(id);
    const lay = airfieldLayout(id);
    if (lay) f.outline = Array.from(lay.core);
    return f;
  });
}

/** Features of this type near Auckland's own landmarks are skipped (the city already has them). */
export function isDuplicateOfAuckland(f: SceneryFeature): boolean {
  const near = (id: string, r: number) => Math.hypot(f.x - AKL[id].x, f.z - AKL[id].z) < r;
  if ((f.type === 'city' || f.type === 'town') && near('cbd', 2500)) return true;
  if (f.type === 'port' && near('port', 1500)) return true;
  // a mission's airbase on a real airfield (FEATURES.whenuapai) is the built-in one
  if (f.type === 'airbase' && airfieldNear(f.x, f.z, 2500)) return true;
  return false;
}

/**
 * Stand-in SkyCity block at the foot of the Sky Tower, for the procedural CBD (the LINZ buildings
 * have the real one). The tower itself is its own mesh (skyTower.ts).
 */
export function buildSkyCityPodium(B: GeometryBuilder, height: HeightFn): void {
  const { x, z } = AKL.skytower;
  B.box(IDENT, x + 10, height(x, z) - 2, z + 35, 80, 24, 60, 0xb9b2a4, 0x6f6f6c, WIN_OFFICE);
}

type TowerStyle = 'box' | 'setback' | 'slab' | 'round' | 'wedge';

/** Named CBD towers (game coordinates from their real lat/lon; heights to the roof/crown). */
const CBD_LANDMARKS: { x: number; z: number; h: number; style: TowerStyle; col: number; name: string }[] = [
  { x: 392, z: -433, h: 180, style: 'wedge', col: 0x7f949c, name: 'PwC Tower (Commercial Bay)' },
  { x: 445, z: -277, h: 170, style: 'round', col: 0x4f7478, name: 'Vero Centre' },
  { x: 650, z: -300, h: 187, style: 'slab', col: 0xd6d2c8, name: 'Pacifica' },
  { x: 440, z: -10, h: 155, style: 'round', col: 0xcfc9bb, name: 'Metropolis' }, // 1 Courthouse Lane (LINZ), by Albert Park
  { x: 294, z: -144, h: 143, style: 'box', col: 0x33495a, name: 'ANZ Centre' },
  { x: 560, z: -180, h: 130, style: 'setback', col: 0x5e7884, name: 'Lumley Centre' },
  { x: 294, z: -322, h: 120, style: 'box', col: 0x4a6a80, name: 'Deloitte Centre' },
  { x: 169, z: -67, h: 112, style: 'setback', col: 0xc8c0b2, name: 'Crowne Plaza' },
  { x: -85, z: 70, h: 110, style: 'box', col: 0x5d6f78, name: 'SkyCity Grand' },
  { x: -285, z: -55, h: 110, style: 'slab', col: 0xbdb6aa, name: 'Victopia' },
  { x: 205, z: -470, h: 104, style: 'wedge', col: 0x6c8a96, name: 'Shortland Tower' },
  { x: 60, z: 330, h: 96, style: 'slab', col: 0xd8d0c2, name: 'Hobson St tower' },
];

const GLASS = [0x4f6f7f, 0x3f5f66, 0x8fa1a8, 0x6b7c86, 0x2f4452, 0x7d6a58, 0x5a8290, 0x46606e];
const STONE = [0xcfc8bb, 0xb9b3a8, 0xe0dbd0, 0x9d978c, 0xc9b9a1, 0xa8a49a];
/** Victorian / Edwardian brick and plaster (Queen St, Customs St, Britomart). */
const HERITAGE = [0x9a5a44, 0x8a4c3a, 0xd8c8a8, 0xc9b28a, 0xb07a58];

/** A glass / concrete tower in a building frame (base at y = 0). */
function tower(B: GeometryBuilder, fr: Frame, style: TowerStyle, tw: number, td: number, h: number, col: number, rnd: () => number, lights: LightList, top: { x: number; y: number; z: number }): void {
  const roof = new Color(col).multiplyScalar(0.62);
  const win = style === 'slab' ? WIN_HOME : WIN_OFFICE;
  switch (style) {
    case 'setback': {
      const h1 = h * (0.55 + rnd() * 0.15);
      const h2 = h1 + (h - h1) * 0.6;
      B.box(fr, 0, 0, 0, tw, h1, td, col, roof, win);
      B.box(fr, 0, h1, 0, tw * 0.8, h2 - h1, td * 0.8, col, roof, win);
      B.box(fr, 0, h2, 0, tw * 0.6, h - h2, td * 0.6, col, roof, win);
      B.cylinder(fr, 0, h, 0, 0.8, 0.3, h * 0.12, 6, 0xd0d0cc, WIN_NONE, true);
      break;
    }
    case 'round': {
      const r = Math.min(tw, td) * 0.5;
      B.cylinder(fr, 0, 0, 0, r, r, h * 0.9, 12, col, win, false);
      B.cylinder(fr, 0, h * 0.9, 0, r, r * 0.55, h * 0.1, 12, col, WIN_GLOW, true, roof);
      break;
    }
    case 'wedge': {
      const rise = Math.min(tw, td) * 0.5;
      const hb = h - rise;
      B.box(fr, 0, 0, 0, tw, hb, td, col, roof, win);
      const x0 = -tw / 2;
      const x1 = tw / 2;
      const z0 = -td / 2;
      const z1 = td / 2;
      // sloped crown: low at +Z, high at −Z
      B.quad(fr, [x0, hb, z1, x1, hb, z1, x1, h, z0, x0, h, z0], roof);
      B.quad(fr, [x1, hb, z0, x0, hb, z0, x0, h, z0, x1, h, z0], col, WIN_GLOW);
      B.tri(fr, [x1, hb, z1, x1, hb, z0, x1, h, z0], col);
      B.tri(fr, [x0, hb, z0, x0, hb, z1, x0, h, z0], col);
      break;
    }
    case 'slab':
      B.box(fr, 0, 0, 0, tw, h, td, col, roof, win);
      B.box(fr, tw * 0.15, h, 0, tw * 0.4, 5, td * 0.5, 0x9a9a98, 0x6a6a68);
      break;
    default:
      B.box(fr, 0, 0, 0, tw, h, td, col, roof, win);
      if (rnd() < 0.6) B.box(fr, 0, h, 0, tw * 0.62, 4 + rnd() * 8, td * 0.62, 0x9a9a98, 0x6a6a68);
  }
  if (h > 95) lights.add(top.x, top.y + h + 4, top.z, 0xff2a18, 3.5, rnd());
}

/** A CBD building's footprint (m, world): centre, width along `angle`, depth across it, height. */
export interface Footprint {
  x: number;
  z: number;
  w: number;
  d: number;
  /** Rotation (rad) of the width axis: (cos, sin) in world XZ (frameFromHeading's heading). */
  angle: number;
  h: number;
}

export interface CbdStats {
  /** Buildings over 60 m. */
  towers: number;
  tallest: number;
  heights: number[];
  /** Procedural buildings (rectangles); empty for the LINZ buildings (see prisms). */
  footprints: Footprint[];
  /** LINZ buildings: every prism built (empty for the procedural CBD). */
  prisms: BuiltPrism[];
  /** Triangles added for the CBD (towers, buildings; not the Sky Tower). */
  triangles: number;
  /**
   * LINZ buildings: the vertex range [start, end) of building i (index into aucklandBuildings()) in the
   * builder, at [2i, 2i + 1], and its ground height at [i] of `buildingGround`, so a collapsed building
   * can be flattened in the merged mesh (#128). Absent for the procedural CBD.
   */
  buildingVerts?: Int32Array;
  buildingGround?: Float32Array;
}

/**
 * Auckland CBD. With the LINZ street map and buildings installed: the real buildings, extruded from
 * their outlines to their LiDAR heights (buildLinzCBD). Else ~100 procedural high-rises (a dozen
 * named towers at their real positions, tallest 187 m) and dense mid-rise blocks, densest around
 * Queen / Shortland / Customs Street, thinning towards Karangahape Road: along Auckland's real streets
 * when the LINZ street map is installed (buildRealCBD), else on the fixed CBD grid (AKL_CBD_GRID,
 * painted by the terrain shader).
 */
export function buildCBD(B: GeometryBuilder, lights: LightList, height: HeightFn, detail: number, cbd: CbdGrid, roads: RoadNetwork | null, buildings: Building[] | null = null): CbdStats {
  if (cbd.streets && buildings && buildings.length) return buildLinzCBD(B, lights, height, detail, cbd.streets, buildings);
  if (cbd.streets) return buildRealCBD(B, lights, height, detail, cbd.streets, roads);
  const t0 = B.triangleCount;
  const rnd = mulberry32(2024);
  const core = { x: 400, z: -300 };
  const minX = -620;
  const maxX = 1000;
  const minZ = -720;
  const maxZ = 800;
  const d = districtAt(cbd.x, cbd.z, undefined, undefined, cbd);
  const blocked = (x: number, z: number, m: number) => {
    if (x < minX || x > maxX || z < minZ || z > maxZ) return true;
    if (Math.hypot(x - 480, z - 200) < 175) return true; // Albert Park
    if (Math.hypot(x - 10, z - 25) < 75) return true; // Sky Tower & SkyCity
    if (height(x, z) < 1.5) return true; // wharves / water
    if (roads && roads.near(x, z, m)) return true;
    return false;
  };
  // Block range in CBD-grid coordinates
  let lx0 = Infinity, lx1 = -Infinity, lz0 = Infinity, lz1 = -Infinity;
  for (const [x, z] of [[minX, minZ], [maxX, minZ], [minX, maxZ], [maxX, maxZ]]) {
    const [px, pz] = toLocal(d, x, z);
    lx0 = Math.min(lx0, px);
    lx1 = Math.max(lx1, px);
    lz0 = Math.min(lz0, pz);
    lz1 = Math.max(lz1, pz);
  }
  interface Slot { x: number; z: number; w: number; dd: number; dist: number; bx: number; bz: number; half: number }
  const halves: Slot[] = [];
  for (let bz = Math.floor(lz0 / BLOCK_D); bz <= Math.floor(lz1 / BLOCK_D); bz++) {
    for (let bx = Math.floor(lx0 / BLOCK_W); bx <= Math.floor(lx1 / BLOCK_W); bx++) {
      if (blockHash(d, bx, bz) >= 0.965) continue; // plaza
      const x0 = bx * BLOCK_W + ROAD_HALF + 1.5;
      const x1 = (bx + 1) * BLOCK_W - ROAD_HALF - 1.5;
      const z0 = bz * BLOCK_D + ROAD_HALF + 1.5;
      const z1 = (bz + 1) * BLOCK_D - ROAD_HALF - 1.5;
      // two half-blocks along the long (local x) side
      for (let k = 0; k < 2; k++) {
        const hx = x0 + ((x1 - x0) * (k + 0.5)) / 2;
        const [wx, wz] = toWorld(d, hx, (z0 + z1) / 2);
        if (Math.hypot(wx - cbd.x, wz - cbd.z) > cbd.radius - 40) continue;
        if (blocked(wx, wz, 14)) continue;
        halves.push({ x: wx, z: wz, w: (x1 - x0) / 2 - 2, dd: z1 - z0, dist: Math.hypot(wx - core.x, wz - core.z), bx, bz, half: k });
      }
    }
  }
  const used = new Set<Slot>();
  let towers = 0;
  let tallest = 0;
  const heights: number[] = [];
  const footprints: Footprint[] = [];
  const place = (sl: Slot, h: number, style: TowerStyle, col: number) => {
    used.add(sl);
    const g = height(sl.x, sl.z) - 3;
    const fr = frameFromHeading(sl.x, g, sl.z, d.angle);
    const podium = h > 70 && rnd() < 0.7;
    const pod = 10 + rnd() * 12;
    if (podium) B.box(fr, 0, 0, 0, sl.w - 1, pod, sl.dd - 2, STONE[(rnd() * STONE.length) | 0], 0x6c6a66, WIN_OFFICE);
    const tw = style === 'slab' ? 20 + rnd() * 6 : Math.min(sl.w - 3, 26 + rnd() * 14);
    const td = style === 'slab' ? Math.min(sl.dd - 6, 38 + rnd() * 10) : Math.min(sl.dd - 4, 26 + rnd() * 16);
    tower(B, fr, style, tw, td, h, col, rnd, lights, { x: sl.x, y: g, z: sl.z });
    if (h > 60) towers++;
    heights.push(h);
    tallest = Math.max(tallest, h);
    footprints.push({ x: sl.x, z: sl.z, w: podium ? sl.w - 1 : tw, d: podium ? sl.dd - 2 : td, angle: d.angle, h });
  };
  // 1) named towers on the half-block nearest their real position
  for (const L of CBD_LANDMARKS) {
    let best: Slot | null = null;
    let bd = 160;
    for (const sl of halves) {
      if (used.has(sl)) continue;
      const dd = Math.hypot(sl.x - L.x, sl.z - L.z);
      if (dd < bd) {
        bd = dd;
        best = sl;
      }
    }
    if (best) place(best, L.h, L.style, L.col);
  }
  // 2) the rest: towers most likely near the core, mid-rise elsewhere
  const styles: TowerStyle[] = ['box', 'box', 'setback', 'slab', 'wedge', 'round', 'box', 'slab'];
  for (const sl of halves) {
    if (used.has(sl)) continue;
    const fall = Math.exp(-((sl.dist / 560) ** 2));
    const pTower = 0.04 + 0.42 * fall;
    const r = rnd();
    if (r < pTower) {
      const h = 64 + 96 * Math.pow(rnd(), 1.25) * (0.3 + 0.7 * fall);
      const style = styles[(rnd() * styles.length) | 0];
      const col = style === 'slab' ? STONE[(rnd() * STONE.length) | 0] : GLASS[(rnd() * GLASS.length) | 0];
      place(sl, h, style, col);
    } else {
      // mid-rise: 1–2 buildings per half block
      used.add(sl);
      const parts = detail > 0.5 && rnd() < 0.5 ? 2 : 1;
      for (let k = 0; k < parts; k++) {
        const off = parts === 2 ? (k - 0.5) * (sl.dd / 2) : 0;
        const g = height(sl.x, sl.z) - 3;
        const fr = frameFromHeading(sl.x, g, sl.z, d.angle);
        const h = 10 + 30 * Math.pow(rnd(), 1.6) * (0.4 + 0.6 * Math.exp(-((sl.dist / 700) ** 2)));
        const heritage = h < 22 && rnd() < 0.35;
        const col = heritage ? HERITAGE[(rnd() * HERITAGE.length) | 0] : rnd() < 0.3 ? GLASS[(rnd() * GLASS.length) | 0] : STONE[(rnd() * STONE.length) | 0];
        const bw = sl.w - 2 - rnd() * 6;
        const bdd = (parts === 2 ? sl.dd / 2 : sl.dd) - 2 - rnd() * 6;
        // flat roofs: grey concrete / membrane with a hint of the facade colour
        B.box(fr, 0, 0, off, bw, h, bdd, col, new Color(0x7c7b77).lerp(new Color(col), 0.2).multiplyScalar(0.8 + rnd() * 0.3), WIN_OFFICE);
        if (detail > 0.5 && rnd() < 0.4) B.box(fr, bw * 0.2, h, off - bdd * 0.15, bw * 0.3, 3, bdd * 0.3, 0x8a8a88, 0x6a6a68);
        const [ox, oz] = toWorld({ ...d, cx: sl.x, cz: sl.z }, 0, off);
        footprints.push({ x: ox, z: oz, w: bw, d: bdd, angle: d.angle, h });
      }
    }
  }
  return { towers, tallest, heights, footprints, prisms: [], triangles: B.triangleCount - t0 };
}

/**
 * The CBD on Auckland's real streets (LINZ street map, cbdStreets.ts). Every building stands behind
 * the footpath of the street it faces and is turned to it:
 *  1. the named towers at their real positions, aligned with their nearest street;
 *  2. a frontage of buildings along both sides of every street (main streets first), towers most
 *     likely near the Queen / Shortland / Customs St core;
 *  3. low infill in what is left of the deeper blocks.
 * Footprints keep off every street (≥ FOOTPATH + 0.8 m from the kerb), the motorways, the parks, the
 * water, the Sky Tower / SkyCity and each other. Street lamps line the streets.
 */
function buildRealCBD(B: GeometryBuilder, lights: LightList, height: HeightFn, detail: number, st: CbdStreets, roads: RoadNetwork | null): CbdStats {
  const t0 = B.triangleCount;
  const rnd = mulberry32(2024);
  const core = { x: 400, z: -300 };
  const SET = FOOTPATH + 0.8; // building line: behind the footpath
  // occupancy (2 m cells) over the region
  const OC = 2;
  const ox0 = st.bounds.minX;
  const oz0 = st.bounds.minZ;
  const ocols = Math.ceil((st.bounds.maxX - ox0) / OC) + 1;
  const orows = Math.ceil((st.bounds.maxZ - oz0) / OC) + 1;
  const occ = new Uint8Array(ocols * orows);
  const cellOf = (x: number, z: number) => {
    const i = Math.floor((x - ox0) / OC);
    const j = Math.floor((z - oz0) / OC);
    return i < 0 || j < 0 || i >= ocols || j >= orows ? -1 : j * ocols + i;
  };
  /** Visit points of a footprint on a lattice of ≤ step m (edges included). */
  const lattice = (x: number, z: number, ux: number, uz: number, w: number, d: number, step: number, f: (px: number, pz: number) => boolean) => {
    const na = Math.max(1, Math.ceil(w / step));
    const nb = Math.max(1, Math.ceil(d / step));
    for (let a = 0; a <= na; a++)
      for (let b = 0; b <= nb; b++) {
        const sa = (a / na - 0.5) * w;
        const sb = (b / nb - 0.5) * d;
        if (!f(x + ux * sa - uz * sb, z + uz * sa + ux * sb)) return false;
      }
    return true;
  };
  // the motorways (+ 4 m) are blocked up front: one stamp instead of a query per lattice point
  if (roads) {
    for (const rp of roads.paths) {
      const hw = rp.width / 2 + 4;
      for (let i = 0; i + 1 < rp.x.length; i++) {
        if (rp.tunnel[i]) continue;
        const ax = rp.x[i];
        const az = rp.z[i];
        const bx = rp.x[i + 1];
        const bz = rp.z[i + 1];
        if (Math.max(ax, bx) < ox0 - hw || Math.min(ax, bx) > ox0 + ocols * OC + hw || Math.max(az, bz) < oz0 - hw || Math.min(az, bz) > oz0 + orows * OC + hw) continue;
        const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - hw - ox0) / OC));
        const i1 = Math.min(ocols - 1, Math.floor((Math.max(ax, bx) + hw - ox0) / OC));
        const j0 = Math.max(0, Math.floor((Math.min(az, bz) - hw - oz0) / OC));
        const j1 = Math.min(orows - 1, Math.floor((Math.max(az, bz) + hw - oz0) / OC));
        const dx = bx - ax;
        const dz = bz - az;
        const l2 = dx * dx + dz * dz || 1;
        for (let j = j0; j <= j1; j++)
          for (let ii = i0; ii <= i1; ii++) {
            // any point of the cell within hw: test its centre against hw + half the cell diagonal
            const cx = ox0 + (ii + 0.5) * OC;
            const cz = oz0 + (j + 0.5) * OC;
            const t = Math.max(0, Math.min(1, ((cx - ax) * dx + (cz - az) * dz) / l2));
            if (Math.hypot(ax + dx * t - cx, az + dz * t - cz) < hw + OC * 0.71) occ[j * ocols + ii] = 1;
          }
      }
    }
  }
  const free = (px: number, pz: number) => {
    const k = cellOf(px, pz);
    if (k < 0 || occ[k]) return false;
    if (st.regionSD(px, pz) < 2 || st.park(px, pz) > 0.05 || Math.hypot(px - 10, pz - 25) < 75) return false;
    // painted kerb distance first (cheap), the exact one near the streets: the kerb distance is
    // 1-Lipschitz, so ≥ SET at lattice points 4 m apart keeps every point of the footprint ≥ SET − 2
    const painted = st.streetSD(px, pz);
    if (painted < SET - 1) return false;
    if (painted < SET + 4 && st.kerbDistance(px, pz) < SET) return false;
    if (height(px, pz) < 1.5) return false;
    return true;
  };
  /** Occupancy along the outline every OC m (rectangles overlap at their outlines, or one holds the other: the lattice). */
  const outlineFree = (x: number, z: number, ux: number, uz: number, w: number, d: number) => {
    for (const [a, b, len] of [[1, 0, w], [0, 1, d]] as const) {
      const n = Math.max(1, Math.ceil(len / OC));
      for (let k = 0; k <= n; k++) {
        const t = (k / n - 0.5) * len;
        for (const sgn of [-0.5, 0.5]) {
          const sa = a ? t : sgn * w;
          const sb = b ? t : sgn * d;
          const c = cellOf(x + ux * sa - uz * sb, z + uz * sa + ux * sb);
          if (c < 0 || occ[c]) return false;
        }
      }
    }
    return true;
  };
  const fits = (x: number, z: number, ux: number, uz: number, w: number, d: number) => outlineFree(x, z, ux, uz, w, d) && lattice(x, z, ux, uz, w, d, 4, free);
  const claim = (x: number, z: number, ux: number, uz: number, w: number, d: number) =>
    lattice(x, z, ux, uz, w + 2, d + 2, OC / 2, (px, pz) => {
      const k = cellOf(px, pz);
      if (k >= 0) occ[k] = 1;
      return true;
    });

  let towers = 0;
  let tallest = 0;
  const heights: number[] = [];
  const footprints: Footprint[] = [];
  const styles: TowerStyle[] = ['box', 'box', 'setback', 'slab', 'wedge', 'round', 'box', 'slab'];
  const placeTower = (x: number, z: number, ux: number, uz: number, w: number, d: number, h: number, style: TowerStyle, col: number) => {
    claim(x, z, ux, uz, w, d);
    const angle = Math.atan2(uz, ux);
    const g = height(x, z) - 3;
    const fr = frameFromHeading(x, g, z, angle);
    const podium = h > 70 && rnd() < 0.7;
    if (podium) B.box(fr, 0, 0, 0, w, 10 + rnd() * 12, d, STONE[(rnd() * STONE.length) | 0], 0x6c6a66, WIN_OFFICE);
    const tw = style === 'slab' ? Math.min(w, 20 + rnd() * 6) : Math.min(w - 2, 24 + rnd() * 14);
    const td = style === 'slab' ? Math.min(d - 2, 36 + rnd() * 10) : Math.min(d - 2, 24 + rnd() * 16);
    tower(B, fr, style, tw, td, h, col, rnd, lights, { x, y: g, z });
    if (h > 60) towers++;
    heights.push(h);
    tallest = Math.max(tallest, h);
    footprints.push({ x, z, w: podium ? w : tw, d: podium ? d : td, angle, h });
  };
  const placeMid = (x: number, z: number, ux: number, uz: number, w: number, d: number, fall: number) => {
    claim(x, z, ux, uz, w, d);
    const angle = Math.atan2(uz, ux);
    const g = height(x, z) - 3;
    const fr = frameFromHeading(x, g, z, angle);
    const h = 9 + 30 * Math.pow(rnd(), 1.6) * (0.35 + 0.65 * fall);
    const heritage = h < 22 && rnd() < 0.35;
    const col = heritage ? HERITAGE[(rnd() * HERITAGE.length) | 0] : rnd() < 0.3 ? GLASS[(rnd() * GLASS.length) | 0] : STONE[(rnd() * STONE.length) | 0];
    B.box(fr, 0, 0, 0, w, h, d, col, new Color(0x7c7b77).lerp(new Color(col), 0.2).multiplyScalar(0.8 + rnd() * 0.3), WIN_OFFICE);
    if (detail > 0.5 && rnd() < 0.4) B.box(fr, w * 0.2, h, -d * 0.15, w * 0.3, 3, d * 0.3, 0x8a8a88, 0x6a6a68);
    heights.push(h);
    footprints.push({ x, z, w, d, angle, h });
  };
  const fallAt = (x: number, z: number, r: number) => Math.exp(-((Math.hypot(x - core.x, z - core.z) / r) ** 2));

  // 1) named towers at the nearest spot to their (approximate) positions that fits, turned to their
  //    street: some of the hand-placed points fall on a street or in Albert Park
  const spiral: [number, number][] = [];
  for (let dz = -72; dz <= 72; dz += 4) for (let dx = -72; dx <= 72; dx += 4) if (Math.hypot(dx, dz) <= 72) spiral.push([dx, dz]);
  spiral.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]));
  for (const L of CBD_LANDMARKS) {
    search: for (const size of [32, 26, 20]) {
      for (const [dx, dz] of spiral) {
        const x = L.x + dx;
        const z = L.z + dz;
        const n = st.nearest(x, z);
        if (!n || n.kerb < SET + size / 2 - 1) continue;
        if (fits(x, z, n.dx, n.dz, size, size)) {
          placeTower(x, z, n.dx, n.dz, size, size, L.h, L.style, L.col);
          break search;
        }
      }
    }
  }

  // 2) frontages along both sides of every street, main streets first
  const lines = st.streets.slice().sort((a, b) => b.width - a.width);
  for (const l of lines) {
    const p = l.pts;
    const hw = l.width / 2;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i];
      const az = p[i + 1];
      const len = Math.hypot(p[i + 2] - ax, p[i + 3] - az);
      if (len < 12) continue;
      const ux = (p[i + 2] - ax) / len;
      const uz = (p[i + 3] - az) / len;
      for (const side of [1, -1]) {
        const nx = -uz * side;
        const nz = ux * side;
        for (let t = 2; t < len - 6; ) {
          const mx = ax + ux * t;
          const mz = az + uz * t;
          const fall = fallAt(mx, mz, 560);
          const tower = rnd() < 0.02 + 0.24 * fall;
          let placed = false;
          // CBD lots run deep and wall to wall: try a full-depth building, then shallower ones
          const fw0 = tower ? 30 + rnd() * 12 : 16 + rnd() * 20;
          const fd0 = tower ? 28 + rnd() * 12 : 22 + rnd() * 16;
          const tries = tower ? [[fw0, fd0], [26, 26], [fw0 * 0.6, fd0 * 0.6]] : [[fw0, fd0], [fw0, fd0 * 0.6], [fw0 * 0.6, 14], [10, 10]];
          for (const [fw, fd] of tries) {
            if (t + fw > len + 4) continue;
            const off = hw + SET + fd / 2 + 0.3;
            const x = mx + ux * (fw / 2) + nx * off;
            const z = mz + uz * (fw / 2) + nz * off;
            if (!fits(x, z, ux, uz, fw, fd)) continue;
            if (tower && fw >= 24) {
              const f = fallAt(x, z, 560);
              const h = 62 + 96 * Math.pow(rnd(), 1.25) * (0.3 + 0.7 * f);
              const style = styles[(rnd() * styles.length) | 0];
              placeTower(x, z, ux, uz, fw, fd, h, style, style === 'slab' ? STONE[(rnd() * STONE.length) | 0] : GLASS[(rnd() * GLASS.length) | 0]);
            } else placeMid(x, z, ux, uz, fw, fd, fallAt(x, z, 700));
            t += fw + 0.6 + rnd() * 1.2;
            placed = true;
            break;
          }
          if (!placed) t += 4;
        }
      }
    }
  }

  // 3) infill: lower buildings in the deeper blocks, turned to the nearest street
  if (detail > 0.3) {
    for (let z = st.bounds.minZ; z < st.bounds.maxZ; z += 9) {
      for (let x = st.bounds.minX; x < st.bounds.maxX; x += 9) {
        const n = st.nearest(x, z);
        if (!n || n.kerb < SET + 6) continue;
        for (const sz of [30, 22, 15]) {
          const w = sz * (0.8 + rnd() * 0.4);
          if (!fits(x, z, n.dx, n.dz, w, sz)) continue;
          placeMid(x, z, n.dx, n.dz, w, sz, fallAt(x, z, 700) * 0.6);
          break;
        }
      }
    }
  }

  streetLamps(st, lights, height, () => false);
  return { towers, tallest, heights, footprints, prisms: [], triangles: B.triangleCount - t0 };
}

/**
 * Street lamps: every ≈ 34 m, alternating sides, on the footpaths of the region's streets (not the
 * lanes), not where the footpath runs into a side street, nor inside a building (`inside`).
 */
function streetLamps(st: CbdStreets, lights: LightList, height: HeightFn, inside: (x: number, z: number) => boolean): void {
  for (const l of st.streets) {
    if (l.width < 10) continue;
    const p = l.pts;
    let next = 10;
    let s = 0;
    let k = 0;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const len = Math.hypot(p[i + 2] - p[i], p[i + 3] - p[i + 1]);
      const ux = (p[i + 2] - p[i]) / (len || 1);
      const uz = (p[i + 3] - p[i + 1]) / (len || 1);
      while (next <= s + len) {
        const t = next - s;
        const side = k++ % 2 === 0 ? 1 : -1;
        const x = p[i] + ux * t - uz * side * (l.width / 2 + 0.6);
        const z = p[i + 1] + uz * t + ux * side * (l.width / 2 + 0.6);
        const kerb = st.kerbDistance(x, z);
        if (st.inRegion(x, z) && height(x, z) > 0.5 && kerb > 0.3 && kerb < FOOTPATH && !inside(x, z)) lights.add(x, height(x, z) + 8, z, 0xffd9a8, 3.6);
        next += 34;
      }
      s += len;
    }
  }
}

/** A LINZ building prism as built: footprint, roof (m above its ground), and the world base / roof y. */
export interface BuiltPrism extends BuildingPrism {
  /** World y of the walls' foot and of the roof at the centroid. */
  y0: number;
  y1: number;
}

/** Douglas–Peucker on a closed ring (flat [x, z, ...]); keeps ≥ 3 vertices. */
export function simplifyRing(r: Float32Array, tol: number): Float32Array {
  const n = r.length / 2;
  if (n <= 4 || tol <= 0) return r;
  // split at the vertex farthest from the first one: two open chains
  let far = 0;
  let fd = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(r[i * 2] - r[0], r[i * 2 + 1] - r[1]);
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const seg = (px: number, pz: number, a: number, b: number) => {
    const ax = r[a * 2];
    const az = r[a * 2 + 1];
    const dx = r[(b % n) * 2] - ax;
    const dz = r[(b % n) * 2 + 1] - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
    return Math.hypot(ax + dx * t - px, az + dz * t - pz);
  };
  const stack: [number, number][] = [[0, far], [far, n]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1;
    let bd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = seg(r[i * 2], r[i * 2 + 1], a, b);
      if (d > bd) {
        bd = d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(r[i * 2], r[i * 2 + 1]);
  return out.length >= 6 ? Float32Array.from(out) : r;
}

/** Deterministic 0..1 hash of a footprint (stable colours across sessions and quality tiers). */
const ringHash = (r: Float32Array) => {
  let h = 2166136261;
  for (let i = 0; i < Math.min(r.length, 8); i++) h = Math.imul(h ^ Math.round(r[i] * 4), 16777619);
  return ((h >>> 0) % 100_000) / 100_000;
};

/**
 * Auckland CBD from the LINZ building outlines and LiDAR heights (phase 2b, aucklandBuildings.ts):
 * every building of the CBD region extruded from its real footprint to its measured roof, towers on
 * their podiums as their own prisms, wedge crowns as tilted roofs. One merged mesh with the Sky Tower
 * (the caller's builder). Facades by height class: glass towers, stone / glass mid-rise, brick and
 * plaster low-rise (Victorian / Edwardian Queen St), warehouses on the wharves; red obstruction
 * lights on the towers over 95 m; street lamps on the footpaths, never inside a building.
 * The ground under each building is the terrain at its centroid; the walls reach down to its lowest
 * corner (the CBD's streets climb 40 m from Quay St to K Rd).
 *
 * Mobile budget (`detail` = sceneryDensity): the medium tier simplifies the footprints by 0.5 m, the
 * low tier by 1.5 m and drops the smallest prisms (< 60 m²).
 */
/** Facade colour and window style of the Scene apartments' parts (Mapillary street imagery, 2021–25). */
const HERO_FACADE: Record<SceneTerraceKind, [number, number]> = {
  tower: [0xe9ebe8, WIN_BALCONY],
  bay: [0x6fb3ad, WIN_LOBBY],
  podium_high: [0xd5d6d1, WIN_OFFICE],
  podium: [0xd5d6d1, WIN_OFFICE],
  low: [0xbfbfba, WIN_NONE],
};

/** The lime-green fins on the Scene towers' Beach Road faces: 2.6 m wide, 0.9 m proud, from the colonnade to over the roof. */
function buildSceneFins(B: GeometryBuilder, height: HeightFn): void {
  for (const [x, z, ax, az, nx, nz, top] of SCENE_FINS) {
    const g = height(x, z);
    const f = frameFromHeading(x, 0, z, Math.atan2(az, ax));
    const out = Math.sign(nx * -az + nz * ax) || 1;
    B.box(f, 0, g + 5, out * 0.45, 2.6, top - 5, 0.9, 0x6cc04a, 0x6cc04a);
  }
}

/** Window style of a kit tower's shaft facade (core/cbdTowers.ts). */
const TOWER_WIN: Record<TowerFacade, number> = { glass: WIN_CURTAIN, bands: WIN_BANDS, punched: WIN_OFFICE, balcony: WIN_BALCONY };

/** Wall colour, roof colour and window style of a kit tower's part. */
function towerPartFacade(t: CbdTower, kind: string | undefined, tmp: Color): [number, number, number] {
  switch (kind) {
    case 'podium':
      return [t.podium, tmp.setHex(t.podium).multiplyScalar(0.62).getHex(), WIN_OFFICE];
    case 'plant':
      return [0x8d8f8e, 0x6f7170, WIN_NONE];
    case 'spire':
      return [0xc9ccce, 0xc9ccce, WIN_NONE];
    case 'crown':
      if (t.crownColour !== undefined) return [t.crownColour, tmp.setHex(t.crownColour).multiplyScalar(0.7).getHex(), t.crown === 'lit' ? WIN_GLOW : WIN_NONE];
      break;
  }
  return [t.wall, tmp.setHex(t.wall).multiplyScalar(0.55).getHex(), TOWER_WIN[t.facade]];
}

function buildLinzCBD(B: GeometryBuilder, lights: LightList, height: HeightFn, detail: number, st: CbdStreets, bs: Building[]): CbdStats {
  const tol = detail >= 0.9 ? 0 : detail >= 0.5 ? 0.5 : 1.5;
  const minArea = detail >= 0.5 ? 0 : 60;
  const t0 = B.triangleCount;
  let towers = 0;
  let tallest = 0;
  const heights: number[] = [];
  const prisms: BuiltPrism[] = [];
  const tmp = new Color();
  const buildingVerts = new Int32Array(bs.length * 2);
  const buildingGround = new Float32Array(bs.length);
  for (let bi = 0; bi < bs.length; bi++) {
    const b = bs[bi];
    const base = b.prisms[0];
    buildingVerts[bi * 2] = B.vertexCount;
    // ground: the terrain at the footprint's centroid; walls down to its lowest corner
    const g = height(base.cx, base.cz);
    let gMin = g;
    for (const p of b.prisms) for (let i = 0; i < p.ring.length; i += 2) gMin = Math.min(gMin, height(p.ring[i], p.ring[i + 1]));
    const y0 = gMin - 1.5;
    const top = Math.max(...b.prisms.map((p) => p.h));
    const area = Math.abs(ringArea(base.ring));
    const hsh = ringHash(base.ring);
    // facade by height class
    let col: number;
    let win: number;
    if (top >= 60) {
      col = hsh < 0.7 ? GLASS[Math.floor(hsh * 100) % GLASS.length] : STONE[Math.floor(hsh * 100) % STONE.length];
      win = WIN_OFFICE;
    } else if (top >= 20) {
      col = hsh < 0.35 ? GLASS[Math.floor(hsh * 100) % GLASS.length] : STONE[Math.floor(hsh * 100) % STONE.length];
      win = WIN_OFFICE;
    } else if (area > 2500 && top < 16) {
      col = 0xa9aaa4;
      win = WIN_INDUSTRIAL; // wharf sheds, warehouses, the Viaduct's events centre
    } else {
      col = hsh < 0.35 ? HERITAGE[Math.floor(hsh * 100) % HERITAGE.length] : STONE[Math.floor(hsh * 100) % STONE.length];
      win = top < 9 && area < 300 ? WIN_HOME : WIN_OFFICE;
    }
    const roofCol = top >= 60 ? tmp.setHex(col).multiplyScalar(0.62).getHex() : tmp.setHex(0x7c7b77).lerp(new Color(col), 0.2).multiplyScalar(0.8 + hsh * 0.3).getHex();
    for (const p of b.prisms) {
      if (minArea && Math.abs(ringArea(p.ring)) < minArea) continue;
      if (detail < 0.5 && p.kind === 'plant') continue; // low tier: the kit towers' roof plant goes
      // the kit towers' terraces are traced at 0.5 m: below the high tier they take a coarser outline (1 m / 2 m)
      const ring = simplifyRing(p.ring, b.hero === 'tower' && tol > 0 ? tol * 2 : tol);
      const roof = (x: number, z: number) => g + roofHeight(p, x, z);
      if (b.hero === 'scene') {
        // the Scene apartments (core/sceneApartments.ts): white balcony bands on the towers, Scene One's teal glass bay
        const [c, w] = HERO_FACADE[(p.kind ?? 'podium') as SceneTerraceKind];
        B.prism(ring, y0, roof, c, p.kind === 'tower' ? 0xd8dbdb : 0x9a9b97, w);
        prisms.push({ ...p, y0, y1: g + p.h });
        heights.push(p.h);
        continue;
      }
      if (b.hero === 'tower' && b.tower) {
        // a kit tower (core/cbdTowers.ts): its measured parts, each with its facade; sloped crowns keep the wall colour.
        // Every part stands from the ground, and a crown terrace is beside the shaft's roof, not on it: up to the shaft's
        // roof its walls are the shaft's facade, the crown's colour (and its light) only above
        const [c, rc, w] = towerPartFacade(b.tower, p.kind, tmp);
        let from = y0;
        if (p.kind === 'crown') {
          const shaftTop = Math.max(0, ...b.prisms.filter((q) => q.kind === 'shaft' || q.kind === 'podium').map((q) => q.h));
          if (shaftTop > 0 && shaftTop < p.h) {
            const [sc, , sw] = towerPartFacade(b.tower, 'shaft', tmp);
            B.prism(ring, y0, () => g + shaftTop, sc, sc, sw);
            from = g + shaftTop;
          }
        }
        B.prism(ring, from, roof, c, p.sx || p.sz ? c : rc, w);
        prisms.push({ ...p, y0, y1: g + p.h });
        heights.push(p.h);
        continue;
      }
      // towers on a podium: a little darker, the crown's roof the facade colour
      const c = p === base ? col : tmp.setHex(col).multiplyScalar(0.92).getHex();
      B.prism(ring, y0, roof, c, p.sx || p.sz ? col : roofCol, win);
      prisms.push({ ...p, y0, y1: g + p.h });
      heights.push(p.h);
    }
    buildingVerts[bi * 2 + 1] = B.vertexCount;
    buildingGround[bi] = g;
    tallest = Math.max(tallest, top);
    if (top > 60) towers++;
    if (top > 95) {
      const t = b.prisms.reduce((a, p) => (p.h > a.h ? p : a));
      lights.add(t.cx, g + roofHeight(t, t.cx, t.cz) + 4, t.cz, 0xff2a18, 3.5, hsh);
    }
  }
  if (bs.some((b) => b.hero === 'scene')) buildSceneFins(B, height);
  // street lamps, not inside a building: a 20 m bucket grid of the footprints
  const grid = new Map<number, BuildingPrism[]>();
  const key = (i: number, j: number) => (i + 4096) * 8192 + (j + 4096);
  // (a kit tower's terraces don't overlap: every one of its parts holds the lamps off)
  for (const p of bs.flatMap((b) => (b.hero === 'tower' ? b.prisms : [b.prisms[0]]))) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < p.ring.length; i += 2) {
      x0 = Math.min(x0, p.ring[i]);
      x1 = Math.max(x1, p.ring[i]);
      z0 = Math.min(z0, p.ring[i + 1]);
      z1 = Math.max(z1, p.ring[i + 1]);
    }
    for (let j = Math.floor(z0 / 20); j <= Math.floor(z1 / 20); j++)
      for (let i = Math.floor(x0 / 20); i <= Math.floor(x1 / 20); i++) {
        const k = key(i, j);
        const l = grid.get(k);
        if (l) l.push(p);
        else grid.set(k, [p]);
      }
  }
  const inside = (x: number, z: number) => (grid.get(key(Math.floor(x / 20), Math.floor(z / 20))) ?? []).some((p) => pointInRing(p.ring, x, z));
  streetLamps(st, lights, height, inside);
  return { towers, tallest, heights, footprints: [], prisms, triangles: B.triangleCount - t0, buildingVerts, buildingGround };
}

interface Centre {
  name: string;
  x: number;
  z: number;
  r: number;
  /** Tallest building (m). */
  h: number;
  industrial?: boolean;
}

/** Suburban town centres (km → m below) with their shops, offices and apartment blocks. */
const CENTRES: Centre[] = [
  { name: 'Newmarket', x: 1.41, z: 2.39, r: 420, h: 42 },
  { name: 'Parnell', x: 1.55, z: 0.8, r: 300, h: 18 },
  { name: 'Grafton (hospital)', x: 0.75, z: 1.35, r: 260, h: 38 },
  { name: 'Ponsonby Road', x: -1.55, z: 0.35, r: 380, h: 16 },
  { name: 'Karangahape Road', x: -0.45, z: 1.08, r: 320, h: 22 },
  { name: 'Wynyard Quarter', x: -0.65, z: -0.95, r: 260, h: 34 },
  { name: 'Mt Eden village', x: -0.62, z: 3.72, r: 220, h: 14 },
  { name: 'Takapuna', x: 0.72, z: -6.72, r: 420, h: 58 },
  { name: 'Devonport', x: 3.0, z: -1.9, r: 230, h: 12 },
  { name: 'Northcote / Akoranga', x: -1.2, z: -4.3, r: 260, h: 18 },
  { name: 'Albany', x: -5.5, z: -13.2, r: 480, h: 32 },
  { name: 'Henderson', x: -11.8, z: 3.5, r: 420, h: 24 },
  { name: 'New Lynn', x: -6.9, z: 6.6, r: 380, h: 44 },
  { name: 'Onehunga', x: 2.0, z: 8.3, r: 330, h: 18 },
  { name: 'Sylvia Park', x: 7.1, z: 7.6, r: 400, h: 26 },
  { name: 'Ellerslie', x: 4.1, z: 5.5, r: 260, h: 22 },
  { name: 'Manukau', x: 10.5, z: 16.1, r: 520, h: 40 },
  { name: 'Botany', x: 13.6, z: 9.3, r: 360, h: 18 },
  { name: 'Glenfield', x: -3.7, z: -7.6, r: 280, h: 16 },
  { name: 'Hobsonville Point', x: -9.1, z: -6.3, r: 300, h: 16 },
  { name: 'Penrose (industrial)', x: 4.7, z: 7.4, r: 520, h: 14, industrial: true },
  { name: 'East Tāmaki (industrial)', x: 11.4, z: 10.2, r: 560, h: 14, industrial: true },
  { name: 'Wiri (industrial)', x: 9.0, z: 18.5, r: 480, h: 14, industrial: true },
];

/** Town centres, suburban apartment clusters and industrial estates (one merged mesh). */
/** `skip`: places where no procedural shop / industrial block may stand (under the aerial photo, which shows the real ones). */
export function buildCentres(
  B: GeometryBuilder,
  lights: LightList,
  height: HeightFn,
  detail: number,
  cbd: CbdGrid,
  roads: RoadNetwork | null,
  skip: ((x: number, z: number) => boolean) | null = null,
): number {
  const rnd = mulberry32(777);
  let n = 0;
  const shop = [0xe4ddd0, 0xcfc6b6, 0xb8b0a2, 0x9a5a48, 0xd8d4cc, 0xa8a49c];
  const ind = [0xbfc3c4, 0xa9adb0, 0xc8c2b4, 0x8f959a];
  for (const c of CENTRES) {
    const cx = c.x * 1000;
    const cz = c.z * 1000;
    const done = new Set<string>();
    for (let z = cz - c.r; z <= cz + c.r; z += 30) {
      for (let x = cx - c.r; x <= cx + c.r; x += 30) {
        const rr = Math.hypot(x - cx, z - cz);
        if (rr > c.r) continue;
        const d = districtAt(x, z, undefined, undefined, cbd);
        if (d.real) continue; // CBD region: built along the real streets (buildRealCBD)
        const [px, pz] = toLocal(d, x, z);
        const bx = Math.floor(px / BLOCK_W);
        const bz = Math.floor(pz / BLOCK_D);
        const key = `${d.cx | 0}:${d.cz | 0}:${bx}:${bz}`;
        if (done.has(key)) continue;
        done.add(key);
        if (d.border < 20) continue;
        const x0 = bx * BLOCK_W + ROAD_HALF + 1.5;
        const x1 = (bx + 1) * BLOCK_W - ROAD_HALF - 1.5;
        const z0 = bz * BLOCK_D + ROAD_HALF + 1.5;
        const z1 = (bz + 1) * BLOCK_D - ROAD_HALF - 1.5;
        const cols = 2;
        const w = (x1 - x0) / cols;
        for (let k = 0; k < cols; k++) {
          for (const zz of c.industrial ? [(z0 + z1) / 2] : [z0 + (z1 - z0) * 0.27, z0 + (z1 - z0) * 0.73]) {
            const [wx, wz] = toWorld(d, x0 + w * (k + 0.5), zz);
            const r2 = Math.hypot(wx - cx, wz - cz);
            const fall = Math.exp(-((r2 / c.r) ** 2) * 1.8);
            if (r2 > c.r || rnd() > (c.industrial ? 0.3 : 0.1 + 0.55 * fall)) continue;
            if (height(wx, wz) < 1.5 || (roads && roads.near(wx, wz, 10)) || skip?.(wx, wz)) continue;
            const g = height(wx, wz) - 2;
            const fr = frameFromHeading(wx, g, wz, d.angle);
            const bw = w - 2 - rnd() * 4;
            const bd = (c.industrial ? z1 - z0 : (z1 - z0) / 2) - 3 - rnd() * 5;
            if (c.industrial) {
              const h = 8 + rnd() * c.h * 0.6;
              B.box(fr, 0, 0, 0, bw, h, bd, ind[(rnd() * ind.length) | 0], 0x7d8388, WIN_INDUSTRIAL);
            } else {
              const h = Math.max(6, c.h * (0.25 + 0.75 * Math.pow(rnd(), 1.6)) * fall);
              const glassy = h > 24 && rnd() < 0.45;
              const col = glassy ? GLASS[(rnd() * GLASS.length) | 0] : shop[(rnd() * shop.length) | 0];
              B.box(fr, 0, 0, 0, bw, h, bd, col, new Color(col).multiplyScalar(0.6), h > 14 ? WIN_OFFICE : WIN_HOME);
              if (detail > 0.5 && h > 10 && rnd() < 0.4) B.box(fr, bw * 0.2, h, 0, bw * 0.3, 2.5, bd * 0.3, 0x8a8a88, 0x6a6a68);
              if (h > 45) lights.add(wx, g + h + 3, wz, 0xff2a18, 3, rnd());
            }
            n++;
          }
        }
      }
    }
  }
  return n;
}

/**
 * Fergusson / Bledisloe container terminal: the real wharves from OpenStreetMap (aucklandSites.ts), else a
 * hand-placed stand-in. The ships at berth (and the cruise liner at Princes Wharf) are sim entities, not
 * scenery: missions/runtime/shipping.ts PORT_BERTHS.
 */
export function buildPort(B: GeometryBuilder, lights: LightList, height: HeightFn, detail: number): void {
  const sites = siteLayout();
  if (sites?.port.length) {
    buildRealPort(B, lights, height, detail, sites);
    return;
  }
  const rnd = mulberry32(99);
  // wharf platforms (world axis-aligned; the harbour polygon carved water under them)
  const decks = [
    { x0: 1180, x1: 1960, z0: -1370, z1: -700 },
    { x0: 780, x1: 1120, z0: -1250, z1: -760 },
  ];
  const deckCol = new Color(0x8f8c86);
  for (const d of decks) {
    B.box(IDENT, (d.x0 + d.x1) / 2, -3, (d.z0 + d.z1) / 2, d.x1 - d.x0, 6, d.z1 - d.z0, deckCol, deckCol);
  }
  const main = decks[0];
  // Container stacks: blocks of rows (4 high max) separated by straddle-carrier lanes
  const colors = [0xb03a2e, 0x2e5a9a, 0x2f7a4a, 0xd87a2a, 0xe8e6e0, 0x6a6e72, 0x9a2e5a, 0x1f3f6a, 0x8a6a3a, 0x3a8a9a];
  const rows = detail > 0.5 ? 12 : 8;
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < 16; k++) {
      if (rnd() < 0.12) continue;
      const x = main.x0 + 70 + k * 36;
      const z = main.z0 + 110 + r * 34;
      if (x > main.x1 - 120 || z > main.z1 - 60) continue;
      const tiers = 1 + ((rnd() * 4) | 0);
      for (let c = 0; c < 2; c++) {
        const col = colors[(rnd() * colors.length) | 0];
        B.box(IDENT, x, 3, z + (c - 0.5) * 12.5, 12.2 * 2, 2.6 * tiers, 12, col, new Color(col).multiplyScalar(0.8));
      }
    }
  }
  // Gantry cranes along the north face
  const craneCol = new Color(0xdad8d2);
  const boomCol = new Color(0xc0392b);
  const cranes = detail > 0.5 ? 7 : 4;
  for (let i = 0; i < cranes; i++) {
    const x = main.x0 + 70 + i * ((main.x1 - main.x0 - 140) / (cranes - 1));
    const z = main.z0 + 30;
    const legH = 44;
    for (const ox of [-9, 9]) for (const oz of [-12, 12]) B.beam(IDENT, x + ox, 3, z + oz, x + ox, 3 + legH, z + oz, 1.6, craneCol);
    B.beam(IDENT, x - 9, 3 + legH, z - 12, x + 9, 3 + legH, z - 12, 1.8, craneCol);
    B.beam(IDENT, x - 9, 3 + legH, z + 12, x + 9, 3 + legH, z + 12, 1.8, craneCol);
    B.beam(IDENT, x - 9, 3 + 16, z - 12, x - 9, 3 + 16, z + 12, 1.2, craneCol);
    B.beam(IDENT, x + 9, 3 + 16, z - 12, x + 9, 3 + 16, z + 12, 1.2, craneCol);
    // boom out over the water (north = −Z) and backreach; raised booms on two idle cranes
    if (i % 3 === 2) B.beam(IDENT, x, 3 + legH + 2, z - 10, x, 3 + legH + 58, z - 30, 2.4, boomCol);
    else B.beam(IDENT, x, 3 + legH + 2, z + 40, x, 3 + legH + 2, z - 62, 2.4, boomCol);
    B.box(IDENT, x, 3 + legH - 1, z + 10, 14, 7, 12, craneCol, craneCol, WIN_INDUSTRIAL);
    B.beam(IDENT, x, 3 + legH + 2, z + 8, x, 3 + legH + 20, z + 2, 1.2, craneCol);
    lights.add(x, 3 + legH + 22, z + 2, 0xff2a18, 3, rnd());
  }
  // Sheds and the car terminal
  for (let i = 0; i < 3; i++) B.box(IDENT, main.x1 - 70, 3, main.z1 - 90 - i * 70, 110, 14, 50, 0xbfc3c4, 0x7d8388, WIN_INDUSTRIAL);
  B.box(IDENT, (decks[1].x0 + decks[1].x1) / 2, 3, (decks[1].z0 + decks[1].z1) / 2, 240, 22, 180, 0xb4b6b2, 0x7a7c78, WIN_INDUSTRIAL);
  // Flood light towers
  for (let i = 0; i < 6; i++) {
    const x = main.x0 + 60 + i * 130;
    B.beam(IDENT, x, 3, main.z1 - 30, x, 33, main.z1 - 30, 1, 0x9a9a98);
    lights.add(x, 34, main.z1 - 30, 0xfff0d0, 10);
  }
}

/**
 * Piers, pontoons, breakwaters and the marinas' yachts (8 triangles each): the real ones from OpenStreetMap
 * (aucklandSites.ts), else hand-placed pontoons at Westhaven and the Viaduct.
 */
export function buildMarinas(B: GeometryBuilder, lights: LightList, height: HeightFn, detail: number): void {
  const sites = siteLayout();
  if (sites?.piers.length) {
    buildRealWaterside(B, lights, height, detail, sites);
    return;
  }
  const rnd = mulberry32(7);
  const hull = new Color(0xf2f2ee);
  const hullSide = new Color(0xd8d8d2);
  const deckCol = new Color(0x9a8f7c);
  const mast = new Color(0xd0d0cc);
  const marinas = [
    { x0: -1520, x1: -1000, zShore: -1300, zOut: -1620, spacing: 38 }, // Westhaven
    { x0: -440, x1: -250, zShore: -760, zOut: -930, spacing: 32 }, // Viaduct basin
  ];
  for (const m of marinas) {
    for (let x = m.x0; x <= m.x1; x += m.spacing) {
      // pontoon running north from the shore
      const z0 = m.zShore - 10;
      const z1 = m.zOut;
      if (height(x, (z0 + z1) / 2) > 0) continue;
      B.quad(IDENT, [x - 1.5, 0.8, z0, x + 1.5, 0.8, z0, x + 1.5, 0.8, z1, x - 1.5, 0.8, z1], deckCol);
      for (let z = z0 - 6; z > z1 + 6; z -= 7.5) {
        for (const side of [-1, 1]) {
          if (rnd() < 0.18 || height(x + side * 9, z) > -0.3) continue;
          const L = 9 + rnd() * 6;
          const bx = x + side * (2 + L / 2);
          const hw = 1.6 + L * 0.05;
          // hull: deck + two sloped sides meeting at the keel line
          B.quad(IDENT, [bx - L / 2, 1.6, z + hw, bx + L / 2, 1.6, z + hw, bx + L / 2, 1.6, z - hw, bx - L / 2, 1.6, z - hw], hull);
          B.quad(IDENT, [bx - L / 2, 1.6, z + hw, bx - L / 2 + 1, 0, z, bx + L / 2 - 1, 0, z, bx + L / 2, 1.6, z + hw], hullSide);
          B.quad(IDENT, [bx + L / 2, 1.6, z - hw, bx + L / 2 - 1, 0, z, bx - L / 2 + 1, 0, z, bx - L / 2, 1.6, z - hw], hullSide);
          if (detail > 0.3 && rnd() < 0.75) {
            const mh = 1.6 + L * 1.3;
            B.quad(IDENT, [bx - 0.15, 1.6, z, bx + 0.15, 1.6, z, bx + 0.1, mh, z, bx - 0.1, mh, z], mast);
          }
        }
      }
      lights.add(x, 3, m.zOut, 0xfff0d0, 2.5);
    }
    // breakwater along the outer edge
    B.box(IDENT, (m.x0 + m.x1) / 2, -2, m.zOut - 12, m.x1 - m.x0 + 60, 4.2, 10, 0x5a5854, 0x6a6864);
  }
}

export function buildMuseumAndObelisk(B: GeometryBuilder, lights: LightList, height: HeightFn): void {
  // Auckland War Memorial Museum on Pukekawa: measured from the LiDAR and OpenStreetMap (core/museum.ts)
  buildMuseum(B, lights, height);
  // One Tree Hill obelisk
  const ox = AKL.one_tree_hill.x;
  const oz = AKL.one_tree_hill.z;
  const og = height(ox, oz) - 1;
  B.box(IDENT, ox, og, oz, 10, 4, 10, 0x9c9890, 0x9c9890);
  B.cylinder(frameFromHeading(ox, og, oz, Math.PI / 4), 0, 4, 0, 3.2, 1.2, 29, 4, 0xd6d2c8, WIN_NONE, true);
  lights.add(ox, og + 34, oz, 0xff2a18, 3, 0.4);
}
