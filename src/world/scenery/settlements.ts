/**
 * Generic settlement builders for scenery features: city / town / village centres (weatherboard
 * walls, iron roofs, a church spire), industrial zones (warehouses, tank farms, striped chimneys)
 * and ports (piers into the nearest water, gantry cranes, containers). Suburban houses around them
 * come from the instanced scatter (scatter.ts) following the same street grid the terrain shader
 * paints.
 *
 * This is not Auckland's scenery: the real city comes from aucklandSites.ts (the CBD, the port).
 * Since the procedural theatres were removed (#73) no shipped mission places a city, town,
 * village or port feature (only airbase and industrial ones), so of these builders only
 * buildIndustrial runs today. The others stay reachable from the mission schema
 * (SceneryFeatureType) until they are removed separately, together with the farmland / forest
 * paths in terrain/bake.ts and terrain/vegetation.ts.
 */
import { Color } from 'three';
import type { SceneryFeature } from '../../core/contracts';
import type { TheaterId } from '../../core/types';
import { mulberry32 } from '../../core/math';
import { footprintOf } from '../terrain/features';
import { frameFromHeading, GeometryBuilder, WIN_HOME, WIN_INDUSTRIAL, WIN_NONE, WIN_OFFICE, type Frame } from './GeometryBuilder';
import { LightList, type HeightFn } from './builders';
import { BLOCK_D, BLOCK_W, ROAD_HALF, blockHash, districtAt, toLocal, toWorld } from './urbanGrid';

interface Style {
  walls: number[];
  roofs: number[];
  glass: number[];
}

const STYLE: Style = { walls: [0xd8d0c0, 0xc4bcad], roofs: [0x8c3b30, 0x4f5a62], glass: [0x5d7887] };

export function buildSettlement(f: SceneryFeature, _theater: TheaterId, B: GeometryBuilder, lights: LightList, height: HeightFn, detail: number): void {
  const st = STYLE;
  const fp = footprintOf(f);
  const rnd = mulberry32(((f.x * 73856093) ^ (f.z * 19349663)) >>> 0);
  switch (f.type) {
    case 'city':
    case 'town':
    case 'village':
      buildCentre(f.type, fp.x, fp.z, fp.radius, st, B, lights, height, rnd, detail);
      break;
    case 'industrial':
      buildIndustrial(fp.x, fp.z, fp.radius, B, lights, height, rnd, detail);
      break;
    case 'port':
      buildPortFeature(fp.x, fp.z, fp.radius, B, lights, height, rnd, detail);
      break;
    default:
      break;
  }
}

function buildCentre(
  type: 'city' | 'town' | 'village',
  cx: number,
  cz: number,
  radius: number,
  st: Style,
  B: GeometryBuilder,
  lights: LightList,
  height: HeightFn,
  rnd: () => number,
  detail: number,
): void {
  const core = type === 'city' ? radius * 0.45 : type === 'town' ? radius * 0.4 : radius * 0.55;
  const hMax = type === 'city' ? 110 : type === 'town' ? 26 : 10;
  const done = new Set<string>();
  const pick = <T>(a: T[]) => a[(rnd() * a.length) | 0];
  for (let z = cz - core; z <= cz + core; z += 30) {
    for (let x = cx - core; x <= cx + core; x += 30) {
      const r = Math.hypot(x - cx, z - cz);
      if (r > core) continue;
      const d = districtAt(x, z);
      const [px, pz] = toLocal(d, x, z);
      const bx = Math.floor(px / BLOCK_W);
      const bz = Math.floor(pz / BLOCK_D);
      const key = `${d.cx | 0}:${d.cz | 0}:${bx}:${bz}`;
      if (done.has(key)) continue;
      done.add(key);
      if (blockHash(d, bx, bz) >= 0.9 || d.border < 50) continue;
      const x0 = bx * BLOCK_W + ROAD_HALF + 1;
      const x1 = (bx + 1) * BLOCK_W - ROAD_HALF - 1;
      const z0 = bz * BLOCK_D + ROAD_HALF + 1;
      const z1 = (bz + 1) * BLOCK_D - ROAD_HALF - 1;
      const parts = type === 'village' ? 2 : 3;
      const w = (x1 - x0) / parts;
      for (let k = 0; k < parts; k++) {
        for (const zz of type === 'city' ? [(z0 + z1) / 2] : [z0 + (z1 - z0) * 0.27, z0 + (z1 - z0) * 0.73]) {
          const [wx, wz] = toWorld(d, x0 + w * (k + 0.5), zz);
          const rr = Math.hypot(wx - cx, wz - cz);
          if (rr > core || rnd() < (type === 'village' ? 0.45 : 0.12)) continue;
          const g = height(wx, wz) - 2;
          if (g < -1) continue;
          const fr = frameFromHeading(wx, g, wz, d.angle);
          const falloff = Math.exp(-((rr / core) ** 2) * 1.6);
          let h = Math.max(6, hMax * falloff * (0.35 + 0.65 * rnd()));
          const bw = w - 2 - rnd() * 5;
          const bd = type === 'city' ? z1 - z0 - rnd() * 8 : (z1 - z0) / 2 - 3 - rnd() * 4;
          const glassy = type === 'city' && h > 45;
          const wall = glassy ? pick(st.glass) : pick(st.walls);
          const roof = pick(st.roofs);
          if (!glassy && h < 16) {
            h = Math.max(5, h * 0.7);
            B.box(fr, 0, 0, 0, bw, h, bd, wall, roof, WIN_HOME);
            B.gable(fr, 0, h, 0, bw, bd, Math.min(bw, bd) * 0.35, roof);
          } else {
            B.box(fr, 0, 0, 0, bw, h, bd, wall, new Color(wall).multiplyScalar(0.7), glassy ? WIN_OFFICE : WIN_HOME);
            if (h > 60) lights.add(wx, g + h + 3, wz, 0xff2a18, 3, rnd());
          }
        }
      }
    }
  }
  // Church spire near the centre
  const g = height(cx, cz) - 1;
  const fr: Frame = { ox: cx + 40, oy: g, oz: cz - 30, c: 1, s: 0 };
  B.box(fr, 0, 0, 0, 14, 12, 30, 0xe4e0d6, 0x7a3a2c, WIN_NONE);
  B.gable(fr, 0, 12, 0, 14, 30, 7, 0x7a3a2c);
  B.box(fr, 0, 0, -18, 7, 22, 7, 0xe4e0d6, 0xe4e0d6);
  B.cylinder({ ...fr, c: Math.SQRT1_2, s: Math.SQRT1_2 }, 0, 22, -18, 4.8, 0.3, 16, 4, 0x4a4c50, WIN_NONE, true);
  // Water tower
  if (type !== 'city' && detail > 0.3) {
    const wx = cx - core * 0.8;
    const wz = cz + core * 0.3;
    const wg = height(wx, wz) - 1;
    const wf: Frame = { ox: wx, oy: wg, oz: wz, c: 1, s: 0 };
    B.cylinder(wf, 0, 0, 0, 2, 2, 22, 8, 0xb8b4ac, WIN_NONE, false);
    B.cylinder(wf, 0, 22, 0, 7, 7, 8, 12, 0xd8d4cc, WIN_NONE, true);
    lights.add(wx, wg + 31, wz, 0xff2a18, 3, 0.7);
  }
}

function buildIndustrial(cx: number, cz: number, radius: number, B: GeometryBuilder, lights: LightList, height: HeightFn, rnd: () => number, detail: number): void {
  const heading = rnd() * Math.PI;
  const g = height(cx, cz) - 1.5;
  const fr = frameFromHeading(cx, g, cz, heading);
  const R = radius * 0.8;
  // Warehouses
  const sheds = detail > 0.5 ? 9 : 6;
  for (let i = 0; i < sheds; i++) {
    const lx = -R * 0.6 + (i % 3) * R * 0.45;
    const lz = -R * 0.5 + Math.floor(i / 3) * R * 0.38;
    const w = 50 + rnd() * 50;
    const d = 30 + rnd() * 40;
    const h = 10 + rnd() * 10;
    const col = [0xb8bcc0, 0x9aa2a8, 0xc8c0b0, 0x8a9296][(rnd() * 4) | 0];
    B.box(fr, lx, 0, lz, w, h, d, col, 0x70787e, WIN_INDUSTRIAL);
    B.gable(fr, lx, h, lz, w, d, 3, 0x70787e);
  }
  // Tank farm
  for (let i = 0; i < 6; i++) {
    const lx = R * 0.55 + (i % 2) * 34;
    const lz = -R * 0.4 + Math.floor(i / 2) * 34;
    B.cylinder(fr, lx, 0, lz, 13, 13, 14, 14, 0xe6e6e2, WIN_NONE, true, 0xcfd0cc);
  }
  // Striped chimneys with aviation lights
  for (let i = 0; i < 2; i++) {
    const lx = -R * 0.1 + i * 40;
    const lz = R * 0.55;
    const hgt = 70 + rnd() * 40;
    for (let s = 0; s < 6; s++) {
      const y0 = (s * hgt) / 6;
      const r0 = 5.5 - (s * 2.2) / 6;
      const r1 = 5.5 - ((s + 1) * 2.2) / 6;
      B.cylinder(fr, lx, y0, lz, r0, r1, hgt / 6, 10, s % 2 ? 0xe8e6e0 : 0xb0302a, WIN_NONE, s === 5);
    }
    const [wx, wz] = [fr.ox + lx * fr.c + lz * fr.s, fr.oz - lx * fr.s + lz * fr.c];
    lights.add(wx, g + hgt + 2, wz, 0xff2a18, 4, rnd());
  }
  // Pipe racks
  B.beam(fr, -R * 0.2, 6, R * 0.2, R * 0.5, 6, R * 0.2, 1.6, 0x8a7a6a);
  B.beam(fr, -R * 0.2, 8, R * 0.24, R * 0.5, 8, R * 0.24, 1.2, 0x8a8a88);
  for (let i = 0; i < 8; i++) {
    const lx = -R * 0.6 + i * R * 0.18;
    const [wx, wz] = [fr.ox + lx * fr.c + R * 0.1 * fr.s, fr.oz - lx * fr.s + R * 0.1 * fr.c];
    lights.add(wx, g + 16, wz, 0xffa040, 7);
  }
}

function buildPortFeature(cx: number, cz: number, radius: number, B: GeometryBuilder, lights: LightList, height: HeightFn, rnd: () => number, detail: number): void {
  // Find the direction of the nearest water.
  let best = -1;
  let bestD = Infinity;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    for (let d = 100; d < 5000; d += 100) {
      if (height(cx + Math.sin(a) * d, cz - Math.cos(a) * d) < -1) {
        if (d < bestD) {
          bestD = d;
          best = a;
        }
        break;
      }
    }
  }
  const g = height(cx, cz) - 1;
  const heading = best < 0 ? rnd() * Math.PI * 2 : best;
  const fr = frameFromHeading(cx, 0, cz, heading); // local −Z towards the water
  const quay = best < 0 ? radius * 0.5 : bestD;
  // Warehouses on land
  for (let i = 0; i < 4; i++) B.box({ ...fr, oy: g }, -150 + i * 100, 0, 60, 80, 14, 45, 0xb4b8bc, 0x6a7278, WIN_INDUSTRIAL);
  if (best < 0) return;
  // Piers from the shore into the water, cranes and containers on them
  const pierLen = 320;
  for (let p = 0; p < 3; p++) {
    const lx = -160 + p * 160;
    B.box(fr, lx, -2.5, -quay - pierLen / 2 + 40, 50, 5.5, pierLen, 0x8f8c86, 0x8f8c86);
    for (let c = 0; c < (detail > 0.5 ? 2 : 1); c++) {
      const lz = -quay - 60 - c * 120;
      for (const ox of [-8, 8]) B.beam(fr, lx + ox, 3, lz - 10, lx + ox, 40, lz - 10, 1.4, 0xdad8d2);
      B.beam(fr, lx - 30, 42, lz - 10, lx + 34, 42, lz - 10, 2.2, 0xc0392b);
      const [wx, wz] = [fr.ox + lx * fr.c + lz * fr.s, fr.oz - lx * fr.s + lz * fr.c];
      lights.add(wx, 46, wz, 0xff2a18, 3, rnd());
    }
    for (let k = 0; k < 8; k++) {
      const lz = -quay - 30 - k * 32;
      const col = [0xb03a2e, 0x2e5a9a, 0x2f7a4a, 0xd87a2a, 0xe8e6e0][(rnd() * 5) | 0];
      B.box(fr, lx + (k % 2 ? 12 : -12), 3, lz, 12, 2.6 * (1 + ((rnd() * 3) | 0)), 10, col, col);
    }
    const [ex, ez] = [fr.ox + lx * fr.c + (-quay - pierLen + 45) * fr.s, fr.oz - lx * fr.s + (-quay - pierLen + 45) * fr.c];
    lights.add(ex, 5, ez, 0x40ff70, 3, 0.2);
  }
}
