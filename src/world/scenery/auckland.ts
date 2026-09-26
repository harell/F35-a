/**
 * Auckland landmarks (primary theatre): Sky Tower, Harbour Bridge, CBD high-rise cluster, Ports of
 * Auckland container terminal, Westhaven & Viaduct marinas, Auckland War Memorial Museum, One Tree
 * Hill obelisk. Positions come from src/core/auckland.ts (origin = Sky Tower). CBD towers are placed
 * on the same block grid the terrain shader paints (urbanGrid.ts), so streets line up.
 */
import { Color } from 'three';
import type { SceneryFeature } from '../../core/contracts';
import { AKL } from '../../core/auckland';
import { mulberry32 } from '../../core/math';
import { frameFromHeading, GeometryBuilder, WIN_GLOW, WIN_HOME, WIN_INDUSTRIAL, WIN_NONE, WIN_OFFICE, type Frame } from './GeometryBuilder';
import { LightList, type HeightFn } from './builders';
import { BLOCK_D, BLOCK_W, districtAt, toLocal, toWorld, blockHash, ROAD_HALF, type CbdGrid } from './urbanGrid';
import type { RoadNetwork } from './motorways';

const IDENT: Frame = { ox: 0, oy: 0, oz: 0, c: 1, s: 0 };

/** Always-present Auckland features the terrain must flatten (airport). */
export function aucklandBuiltinFeatures(): SceneryFeature[] {
  return [{ type: 'airbase', x: AKL.akl_airport.x, z: AKL.akl_airport.z, rotation: 50, size: 1 }];
}

/** Features of this type near Auckland's own landmarks are skipped (the city already has them). */
export function isDuplicateOfAuckland(f: SceneryFeature): boolean {
  const near = (id: string, r: number) => Math.hypot(f.x - AKL[id].x, f.z - AKL[id].z) < r;
  if ((f.type === 'city' || f.type === 'town') && near('cbd', 2500)) return true;
  if (f.type === 'port' && near('port', 1500)) return true;
  if (f.type === 'airbase' && near('akl_airport', 2500)) return true;
  return false;
}

export function buildSkyTower(B: GeometryBuilder, lights: LightList, height: HeightFn): void {
  const { x, z } = AKL.skytower;
  const g = height(x, z) - 2;
  const concrete = 0xd9d7d0;
  const glass = 0x3c5664;
  // Podium (SkyCity) and flared base
  B.box(IDENT, x + 10, g, z + 35, 80, 24, 60, 0xb9b2a4, 0x6f6f6c, WIN_OFFICE);
  B.cylinder(IDENT, x, g, z, 11, 6.2, 16, 12, concrete, WIN_NONE, false);
  // Shaft
  B.cylinder(IDENT, x, g + 16, z, 6.2, 5.4, 172, 12, concrete, WIN_NONE, false);
  // Pod: flare, observation deck, restaurant, sky deck
  B.cylinder(IDENT, x, g + 188, z, 5.4, 16.5, 5, 16, concrete, WIN_NONE, false);
  B.cylinder(IDENT, x, g + 193, z, 16.5, 17.5, 8, 16, glass, WIN_GLOW, false);
  B.cylinder(IDENT, x, g + 201, z, 17.5, 19.5, 2, 16, concrete, WIN_NONE, false);
  B.cylinder(IDENT, x, g + 203, z, 19.5, 19.5, 7, 16, glass, WIN_GLOW, false);
  B.cylinder(IDENT, x, g + 210, z, 19.5, 11, 5, 16, concrete, WIN_NONE, true);
  B.cylinder(IDENT, x, g + 215, z, 10, 9.5, 6, 16, glass, WIN_GLOW, false);
  B.cylinder(IDENT, x, g + 221, z, 9.5, 4, 4, 12, concrete, WIN_NONE, true);
  // Mast
  B.cylinder(IDENT, x, g + 225, z, 3.2, 1.8, 75, 8, 0xe6e6e2, WIN_NONE, false);
  B.cylinder(IDENT, x, g + 300, z, 1.2, 0.35, 30, 6, 0xf0f0ee, WIN_NONE, true);
  // Night: aviation lights, pod ring, shaft floodlights
  lights.add(x, g + 330, z, 0xff2a18, 5, 0.1);
  lights.add(x, g + 300, z, 0xff2a18, 4, 0.6);
  lights.add(x, g + 262, z, 0xffffff, 4, 0.35);
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    lights.add(x + Math.cos(a) * 20.5, g + 206, z + Math.sin(a) * 20.5, 0x9fd0ff, 3);
  }
  for (let y = 30; y < 185; y += 30) lights.add(x, g + y, z - 8, 0xaec8ff, 5);
}

/** Auckland Harbour Bridge: 1 km, eight spans, steel truss hump over the 43 m navigation span. */
export function buildHarbourBridge(B: GeometryBuilder, lights: LightList, height: HeightFn): void {
  const S = AKL.bridge_s;
  const N = AKL.bridge_n;
  const dx = N.x - S.x;
  const dz = N.z - S.z;
  const len = Math.hypot(dx, dz);
  const heading = Math.atan2(dx, -dz);
  const f = frameFromHeading(S.x, 0, S.z, heading); // local −Z runs S → N
  const at = (s: number) => [S.x + (dx * s) / len, S.z + (dz * s) / len] as const;
  const gS = Math.max(4, height(S.x, S.z)) + 1;
  const gN = Math.max(4, height(N.x, N.z)) + 1;
  const sm = len * 0.64;
  const eMax = 48; // deck top → 43 m clearance under the girders
  const deck = (s: number) => {
    if (s <= sm) {
      const t = s / sm;
      return gS + (eMax - gS) * Math.sin((t * Math.PI) / 2) ** 1.2;
    }
    const t = (len - s) / (len - sm);
    return gN + (eMax - gN) * Math.sin((t * Math.PI) / 2) ** 1.2;
  };
  const halfW = 15; // incl. the clip-on lanes
  const thick = 4;
  const road = new Color(0x3b3d40);
  const girder = new Color(0x8d9294);
  const steel = new Color(0x62706e);
  const pierCol = new Color(0xb8b6ae);
  const seg = 24;
  for (let i = 0; i < seg; i++) {
    const s0 = (i / seg) * len;
    const s1 = ((i + 1) / seg) * len;
    const y0 = deck(s0);
    const y1 = deck(s1);
    // road surface (top), girder sides and underside
    B.quad(f, [-halfW, y0, -s0, halfW, y0, -s0, halfW, y1, -s1, -halfW, y1, -s1], road);
    B.quad(f, [halfW, y0 - thick, -s0, halfW, y1 - thick, -s1, halfW, y1, -s1, halfW, y0, -s0], girder);
    B.quad(f, [-halfW, y1 - thick, -s1, -halfW, y0 - thick, -s0, -halfW, y0, -s0, -halfW, y1, -s1], girder);
    B.quad(f, [-halfW, y0 - thick, -s0, -halfW, y1 - thick, -s1, halfW, y1 - thick, -s1, halfW, y0 - thick, -s0], girder);
  }
  // Piers (concrete, founded on the harbour floor)
  const piers = [0.085, 0.17, 0.26, 0.35, 0.44, 0.535, 0.745, 0.85, 0.94].map((t) => t * len);
  for (const s of piers) {
    const [wx, wz] = at(s);
    const gy = Math.min(0, height(wx, wz)) - 2;
    const top = deck(s) - thick;
    B.box(f, 0, gy, -s, 24, top - gy, 9, pierCol, pierCol);
  }
  // Steel truss over the central spans (two trusses under the old four-lane deck)
  const t0 = 0.46 * len;
  const t1 = 0.98 * len;
  const top = (s: number) => {
    const main = Math.max(0, 1 - Math.abs(s - sm) / (0.21 * len));
    return deck(s) + 5 + 17 * Math.sin((main * Math.PI) / 2);
  };
  const panel = 22;
  for (const side of [-7.5, 7.5]) {
    let prev: [number, number, number] | null = null;
    for (let s = t0, k = 0; s <= t1 + 0.1; s += panel, k++) {
      const yb = deck(s);
      const yt = top(s);
      B.beam(f, side, yb, -s, side, yt, -s, 1.1, steel); // vertical
      if (prev) {
        B.beam(f, side, prev[1], -prev[0], side, yt, -s, 1.3, steel); // top chord
        B.beam(f, side, prev[2], -prev[0], side, yt, -s, 0.8, steel); // diagonal
      }
      prev = [s, yt, yb];
    }
  }
  // Cross bracing on top of the main span
  for (let s = sm - 90; s <= sm + 90; s += 44) B.beam(f, -7.5, top(s), -s, 7.5, top(s), -s, 0.8, steel);
  // Lamps along both edges, aviation lights on the truss crown, channel lights under the span
  for (let s = 20; s < len; s += 45) {
    for (const side of [-halfW + 0.5, halfW - 0.5]) {
      const [wx, wz] = at(s);
      const ox = side * f.c;
      const oz = -side * f.s;
      lights.add(wx + ox, deck(s) + 9, wz + oz, 0xffb060, 5);
    }
  }
  {
    const [wx, wz] = at(sm);
    lights.add(wx, top(sm) + 1.5, wz, 0xff2a18, 4, 0.2);
    lights.add(wx, deck(sm) - thick - 1, wz, 0x40ff70, 3.5);
  }
}

type TowerStyle = 'box' | 'setback' | 'slab' | 'round' | 'wedge';

/** Named CBD towers (game coordinates from their real lat/lon; heights to the roof/crown). */
const CBD_LANDMARKS: { x: number; z: number; h: number; style: TowerStyle; col: number; name: string }[] = [
  { x: 392, z: -433, h: 180, style: 'wedge', col: 0x7f949c, name: 'PwC Tower (Commercial Bay)' },
  { x: 445, z: -277, h: 170, style: 'round', col: 0x4f7478, name: 'Vero Centre' },
  { x: 650, z: -300, h: 187, style: 'slab', col: 0xd6d2c8, name: 'Pacifica' },
  { x: 499, z: 125, h: 155, style: 'round', col: 0xcfc9bb, name: 'Metropolis' },
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

/**
 * Auckland CBD: ~100 high-rises (a dozen named towers at their real positions, tallest 187 m) and
 * dense mid-rise blocks on the CBD street grid (AKL_CBD_GRID, painted by the terrain shader),
 * densest around Queen / Shortland / Customs Street, thinning towards Karangahape Road.
 */
export function buildCBD(B: GeometryBuilder, lights: LightList, height: HeightFn, detail: number, cbd: CbdGrid, roads: RoadNetwork | null): { towers: number; tallest: number; heights: number[] } {
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
      }
    }
  }
  return { towers, tallest, heights };
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
export function buildCentres(B: GeometryBuilder, lights: LightList, height: HeightFn, detail: number, cbd: CbdGrid, roads: RoadNetwork | null): number {
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
            if (height(wx, wz) < 1.5 || (roads && roads.near(wx, wz, 10))) continue;
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

/** Fergusson / Bledisloe container terminal on reclaimed wharves, with ships at berth. */
export function buildPort(B: GeometryBuilder, lights: LightList, height: HeightFn, detail: number): void {
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
  // Container ship alongside the north face, a car carrier at Bledisloe (east face)
  ship(B, lights, (main.x0 + main.x1) / 2 - 40, main.z0 - 24, Math.PI / 2, 270, 34, rnd, true);
  ship(B, lights, main.x1 + 22, (main.z0 + main.z1) / 2 + 60, 0, 200, 32, rnd, false);
  // Sheds and the car terminal
  for (let i = 0; i < 3; i++) B.box(IDENT, main.x1 - 70, 3, main.z1 - 90 - i * 70, 110, 14, 50, 0xbfc3c4, 0x7d8388, WIN_INDUSTRIAL);
  B.box(IDENT, (decks[1].x0 + decks[1].x1) / 2, 3, (decks[1].z0 + decks[1].z1) / 2, 240, 22, 180, 0xb4b6b2, 0x7a7c78, WIN_INDUSTRIAL);
  // Flood light towers
  for (let i = 0; i < 6; i++) {
    const x = main.x0 + 60 + i * 130;
    B.beam(IDENT, x, 3, main.z1 - 30, x, 33, main.z1 - 30, 1, 0x9a9a98);
    lights.add(x, 34, main.z1 - 30, 0xfff0d0, 10);
  }
  // Cruise ship at Princes Wharf
  ship(B, lights, 250, -1010, 0, 290, 36, rnd, false, true);
}

/**
 * A ship moored at (x, z), bow along `heading` (rad): hull, superstructure aft (or a full-length
 * cruise-ship block), deck cargo for container ships, and deck / mast lights.
 */
function ship(B: GeometryBuilder, lights: LightList, x: number, z: number, heading: number, L: number, W: number, rnd: () => number, containers: boolean, cruise = false): void {
  const fr = frameFromHeading(x, -8, z, heading);
  const hull = cruise ? 0xf2f2f0 : containers ? 0x2a3440 : 0x9a2a28;
  // hull (bow taper via two wedges)
  B.box(fr, 0, 0, 0, W, 17, L * 0.82, hull, 0x6a6a66);
  B.quad(fr, [-W / 2, 17, -L * 0.41, W / 2, 17, -L * 0.41, 0, 17, -L * 0.5, 0, 17, -L * 0.5], 0x6a6a66);
  B.tri(fr, [W / 2, 0, -L * 0.41, W / 2, 17, -L * 0.41, 0, 17, -L * 0.5], hull);
  B.tri(fr, [-W / 2, 17, -L * 0.41, -W / 2, 0, -L * 0.41, 0, 17, -L * 0.5], hull);
  if (cruise) {
    for (let t = 0; t < 5; t++) B.box(fr, 0, 17 + t * 5.5, L * 0.04, W * (0.96 - t * 0.06), 5.5, L * (0.74 - t * 0.07), 0xf4f4f2, 0xd8dcdc, WIN_HOME);
    B.box(fr, 0, 45, L * 0.18, 8, 9, 14, 0x2a4a8a, 0x2a4a8a);
    for (let k = -3; k <= 3; k++) lights.add(x + Math.sin(heading) * k * 35, 36, z - Math.cos(heading) * k * 35, 0xfff0d0, 4);
    return;
  }
  // superstructure aft
  B.box(fr, 0, 17, L * 0.33, W * 0.8, 20, 16, 0xf0f0ec, 0xd0d0cc, WIN_HOME);
  B.box(fr, 0, 37, L * 0.33, W * 1.0, 1.2, 8, 0xf0f0ec, 0xd0d0cc);
  B.box(fr, 0, 17, L * 0.4, 5, 26, 5, 0x3a3a3a, 0x222222);
  if (containers) {
    const colors = [0xb03a2e, 0x2e5a9a, 0x2f7a4a, 0xd87a2a, 0xe8e6e0, 0x6a6e72, 0x1f3f6a];
    for (let bay = -7; bay <= 4; bay++) {
      const tiers = 2 + ((rnd() * 4) | 0);
      B.box(fr, 0, 17, bay * 13.5, W * 0.92, 2.6 * tiers, 12.2, colors[(rnd() * colors.length) | 0], colors[(rnd() * colors.length) | 0]);
    }
  } else {
    // car carrier: tall box hull
    B.box(fr, 0, 17, -L * 0.05, W * 0.98, 16, L * 0.66, 0xe0e2e0, 0xc8cac8);
  }
  lights.add(x, 48, z, 0xfff6e0, 3.5);
  lights.add(x - Math.sin(heading) * L * 0.45, 22, z + Math.cos(heading) * L * 0.45, 0xfff6e0, 3);
}

/** Westhaven and Viaduct marinas: pontoons with rows of yachts (8 triangles each). */
export function buildMarinas(B: GeometryBuilder, lights: LightList, height: HeightFn, detail: number): void {
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
  // Auckland War Memorial Museum on the Domain
  const mx = AKL.domain.x;
  const mz = AKL.domain.z;
  const g = height(mx, mz) - 1.5;
  const fr = frameFromHeading(mx, g, mz, 0.3);
  const stone = 0xe8e0cc;
  B.box(fr, 0, 0, 0, 104, 22, 62, stone, 0x9c9486, WIN_NONE);
  B.box(fr, 0, 0, -35, 40, 20, 10, stone, 0x9c9486, WIN_NONE); // portico
  B.box(fr, 0, 22, 0, 40, 6, 30, stone, 0x9c9486);
  B.cylinder(fr, 0, 28, 0, 14, 14, 4, 16, stone, WIN_NONE, false);
  B.cylinder(fr, 0, 32, 0, 14, 2, 10, 16, 0x9aa8ae, WIN_NONE, true);
  lights.add(mx, g + 30, mz, 0xfff0d0, 12);
  // One Tree Hill obelisk
  const ox = AKL.one_tree_hill.x;
  const oz = AKL.one_tree_hill.z;
  const og = height(ox, oz) - 1;
  B.box(IDENT, ox, og, oz, 10, 4, 10, 0x9c9890, 0x9c9890);
  B.cylinder(frameFromHeading(ox, og, oz, Math.PI / 4), 0, 4, 0, 3.2, 1.2, 29, 4, 0xd6d2c8, WIN_NONE, true);
  lights.add(ox, og + 34, oz, 0xff2a18, 3, 0.4);
}
