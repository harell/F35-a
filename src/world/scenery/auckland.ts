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
import { frameFromHeading, GeometryBuilder, WIN_GLOW, WIN_INDUSTRIAL, WIN_NONE, WIN_OFFICE, type Frame } from './GeometryBuilder';
import { LightList, type HeightFn } from './builders';
import { BLOCK_D, BLOCK_W, districtAt, toLocal, toWorld, blockHash, ROAD_HALF } from './urbanGrid';

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

/** CBD high-rises on the shader's block grid: tallest around Shortland / Queen Street. */
export function buildCBD(B: GeometryBuilder, lights: LightList, height: HeightFn, detail: number): void {
  const rnd = mulberry32(2024);
  const centre = { x: 120, z: -330 };
  const minX = -600;
  const maxX = 980;
  const minZ = -690;
  const maxZ = 540;
  const glass = [0x5d7887, 0x49686c, 0x7a6b5a, 0xa9b3b6, 0x3f5260, 0x6f8a96];
  const stone = [0xd8d0c0, 0xc4bcad, 0xa9a69e, 0xe2ddd2, 0xb49c84];
  const done = new Set<string>();
  const inside = (x: number, z: number) => {
    if (x < minX || x > maxX || z < minZ || z > maxZ) return false;
    if (Math.hypot(x - 350, z + 200) < 170) return false; // Albert Park
    if (Math.hypot(x, z) < 70) return false; // Sky Tower plaza
    if (height(x, z) < 1.5) return false; // wharves / water
    return true;
  };
  // Sample the area on a fine grid, collect distinct blocks
  for (let z = minZ; z <= maxZ; z += 25) {
    for (let x = minX; x <= maxX; x += 25) {
      if (!inside(x, z)) continue;
      const d = districtAt(x, z);
      const [px, pz] = toLocal(d, x, z);
      const bx = Math.floor(px / BLOCK_W);
      const bz = Math.floor(pz / BLOCK_D);
      const key = `${d.cx.toFixed(0)}:${d.cz.toFixed(0)}:${bx}:${bz}`;
      if (done.has(key)) continue;
      done.add(key);
      if (blockHash(d, bx, bz) >= 0.9) continue; // plaza / park block
      // Block interior in district-local space
      const x0 = bx * BLOCK_W + ROAD_HALF + 1;
      const x1 = (bx + 1) * BLOCK_W - ROAD_HALF - 1;
      const z0 = bz * BLOCK_D + ROAD_HALF + 1;
      const z1 = (bz + 1) * BLOCK_D - ROAD_HALF - 1;
      const [cx, cz] = toWorld(d, (x0 + x1) / 2, (z0 + z1) / 2);
      if (!inside(cx, cz) || d.border < 60) continue;
      const dist = Math.hypot(cx - centre.x, cz - centre.z);
      const hmax = 22 + 150 * Math.exp(-((dist / 430) ** 2));
      const heading = d.angle; // building axes = district street axes
      // Split the block into 1–3 buildings along its long side
      const parts = hmax > 90 ? 1 + ((rnd() * 2) | 0) : 2 + ((rnd() * 2) | 0);
      const w = (x1 - x0) / parts;
      for (let k = 0; k < parts; k++) {
        const lx = x0 + w * (k + 0.5);
        const [wx, wz] = toWorld(d, lx, (z0 + z1) / 2);
        if (!inside(wx, wz)) continue;
        const g = height(wx, wz) - 3;
        const fr = frameFromHeading(wx, g, wz, heading);
        const r = rnd();
        let h = Math.max(12, hmax * (0.3 + 0.7 * Math.pow(r, 0.8)));
        if (dist < 350 && r > 0.8) h = Math.min(185, h * 1.35);
        const bw = w - 3 - rnd() * 6;
        const bd = z1 - z0 - rnd() * 10;
        const tall = h > 70;
        const col = tall ? glass[(rnd() * glass.length) | 0] : stone[(rnd() * stone.length) | 0];
        const roof = new Color(col).multiplyScalar(0.65);
        if (tall && bw > 22 && bd > 22) {
          // Podium + tower (+ crown)
          const pod = 12 + rnd() * 10;
          B.box(fr, 0, 0, 0, bw, pod, bd, stone[(rnd() * stone.length) | 0], roof, WIN_OFFICE);
          const tw = Math.min(bw, 24 + rnd() * 20);
          const td = Math.min(bd, 24 + rnd() * 18);
          B.box(fr, 0, pod, 0, tw, h - pod, td, col, roof, WIN_OFFICE);
          if (rnd() < 0.5) B.box(fr, 0, h, 0, tw * 0.6, 4 + rnd() * 8, td * 0.6, 0x9a9a98, 0x6a6a68, WIN_NONE);
          if (h > 120) lights.add(wx, g + h + 6, wz, 0xff2a18, 3.5, rnd());
        } else {
          B.box(fr, 0, 0, 0, bw, h, bd, col, roof, WIN_OFFICE);
          if (detail > 0.5 && rnd() < 0.3) B.box(fr, bw * 0.2, h, -bd * 0.15, bw * 0.3, 3, bd * 0.3, 0x8a8a88, 0x6a6a68);
        }
      }
    }
  }
}

/** Fergusson / Bledisloe container terminal on reclaimed wharves. */
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
  // Container stacks in rows
  const colors = [0xb03a2e, 0x2e5a9a, 0x2f7a4a, 0xd87a2a, 0xe8e6e0, 0x6a6e72, 0x9a2e5a, 0x1f3f6a];
  const rows = detail > 0.5 ? 9 : 6;
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < 14; k++) {
      if (rnd() < 0.18) continue;
      const x = main.x0 + 90 + k * 40;
      const z = main.z0 + 120 + r * 40;
      if (x > main.x1 - 60) continue;
      const hgt = 2.6 * (1 + ((rnd() * 4) | 0));
      B.box(IDENT, x, 3, z, 12.2, hgt, 2.5 * 4 + 1, colors[(rnd() * colors.length) | 0], colors[(rnd() * colors.length) | 0]);
    }
  }
  // Gantry cranes along the north face
  const craneCol = new Color(0xdad8d2);
  const boomCol = new Color(0xc0392b);
  const cranes = detail > 0.5 ? 6 : 4;
  for (let i = 0; i < cranes; i++) {
    const x = main.x0 + 80 + i * ((main.x1 - main.x0 - 160) / (cranes - 1));
    const z = main.z0 + 30;
    const legH = 42;
    for (const ox of [-9, 9]) for (const oz of [-12, 12]) B.beam(IDENT, x + ox, 3, z + oz, x + ox, 3 + legH, z + oz, 1.6, craneCol);
    B.beam(IDENT, x - 9, 3 + legH, z - 12, x + 9, 3 + legH, z - 12, 1.8, craneCol);
    B.beam(IDENT, x - 9, 3 + legH, z + 12, x + 9, 3 + legH, z + 12, 1.8, craneCol);
    // boom out over the water (north = −Z) and backreach
    B.beam(IDENT, x, 3 + legH + 2, z + 40, x, 3 + legH + 2, z - 62, 2.4, boomCol);
    B.box(IDENT, x, 3 + legH - 1, z + 10, 14, 7, 12, craneCol, craneCol, WIN_INDUSTRIAL);
    B.beam(IDENT, x, 3 + legH + 2, z + 8, x, 3 + legH + 20, z + 2, 1.2, craneCol);
    lights.add(x, 3 + legH + 22, z + 2, 0xff2a18, 3, rnd());
  }
  // Sheds
  for (let i = 0; i < 3; i++) B.box(IDENT, main.x1 - 90, 3, main.z1 - 90 - i * 70, 120, 14, 50, 0xbfc3c4, 0x7d8388, WIN_INDUSTRIAL);
  // Flood light towers
  for (let i = 0; i < 6; i++) {
    const x = main.x0 + 60 + i * 130;
    B.beam(IDENT, x, 3, main.z1 - 30, x, 33, main.z1 - 30, 1, 0x9a9a98);
    lights.add(x, 34, main.z1 - 30, 0xfff0d0, 10);
  }
}

/** Westhaven and Viaduct marinas: pontoons with rows of yachts. */
export function buildMarinas(B: GeometryBuilder, lights: LightList, height: HeightFn, detail: number): void {
  const rnd = mulberry32(7);
  const hull = new Color(0xf2f2ee);
  const deckCol = new Color(0x9a8f7c);
  const mast = new Color(0xd0d0cc);
  const marinas = [
    { x0: -1520, x1: -1000, zShore: -1300, zOut: -1620, spacing: 36 }, // Westhaven
    { x0: -440, x1: -250, zShore: -760, zOut: -930, spacing: 30 }, // Viaduct basin
  ];
  for (const m of marinas) {
    for (let x = m.x0; x <= m.x1; x += m.spacing) {
      // pontoon running north from the shore
      const z0 = m.zShore - 10;
      const z1 = m.zOut;
      if (height(x, (z0 + z1) / 2) > 0) continue;
      B.box(IDENT, x, 0, (z0 + z1) / 2, 3, 0.8, Math.abs(z1 - z0), deckCol, deckCol);
      for (let z = z0 - 6; z > z1 + 6; z -= 6.5) {
        for (const side of [-1, 1]) {
          if (rnd() < 0.15 || height(x + side * 9, z) > -0.3) continue;
          const L = 9 + rnd() * 6;
          const bx = x + side * (2 + L / 2);
          B.box(IDENT, bx, 0, z, L, 1.6, 3.2, hull, hull);
          if (detail > 0.3 && rnd() < 0.7) B.beam(IDENT, bx, 1.6, z, bx, 1.6 + L * 1.3, z, 0.22, mast);
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
