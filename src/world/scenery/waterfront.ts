/**
 * Auckland's waterfront and strategic sites from OpenStreetMap (Open data 2, issue #33): the Ports of Auckland
 * wharves, every pier, pontoon and breakwater in the theatre, the marinas with their yachts, Devonport Naval Base
 * (Calliope wharves, Calliope Dock, base buildings, dock cranes), the storage tanks of the Wiri oil terminal and Eden
 * Park. Geometry comes from the baked OSM layer (aucklandOsm.ts); cranes, container stacks, sheds, yachts and the
 * stadium's stands stay procedural, placed on the real outlines. The large ships at berth are sim entities
 * (missions/runtime/shipping.ts PORT_BERTHS), never scenery.
 *
 * Without the OSM file Scenery.ts keeps the hand-placed port and marinas (auckland.ts buildPort / buildMarinas),
 * and the sites that do not need it are built from the core tables: the Wiri tanks (core/aucklandSites.ts) and Eden
 * Park round its landmark.
 */
import { Color } from 'three';
import { AKL } from '../../core/auckland';
import { WIRI_TANKS } from '../../core/aucklandSites';
import { AIRFIELD_IDS } from '../../core/airfields';
import { mulberry32 } from '../../core/math';
import { frameFromHeading, IDENT_FRAME, WIN_INDUSTRIAL, WIN_NONE, WIN_OFFICE, type GeometryBuilder } from './GeometryBuilder';
import type { HeightFn, LightList } from './builders';
import {
  airfieldLayout,
  aucklandOsm,
  distToPath,
  osmLayer,
  OSM_BREAKWATER,
  OSM_BUILDING,
  OSM_CRANE,
  OSM_DOCK,
  OSM_MARINA,
  OSM_MILITARY,
  OSM_NAVAL,
  OSM_PIER,
  OSM_PITCH,
  OSM_PORT,
  OSM_STADIUM,
  OSM_TANK,
  pointInRing,
  type OsmFeature,
} from './aucklandOsm';

/** A flat pad the terrain levels under a mission's ground target (missions/pads.ts). */
export interface Pad {
  x: number;
  z: number;
  radius: number;
}

export interface WaterfrontStats {
  /** Pier / pontoon / breakwater features built. */
  piers: number;
  yachts: number;
  cranes: number;
  /** Container stack blocks on the Fergusson terminal. */
  stacks: number;
  tanks: number;
  /** Tanks left out because a mission target's pad covers them. */
  tanksUnderPads: number;
  navalBuildings: number;
  /** Wharf deck slabs (OSM port land). */
  decks: number;
}

/** Wharf deck level (m): the reclaimed port land and the fixed wharves. */
export const WHARF_TOP = 3;
const PONTOON_TOP = 0.6;
const BREAKWATER_TOP = 2.2;

const DECK = 0x8f8c86;
const PONTOON = 0xb9b2a2;
const ROCK = 0x5d5a55;

/* ───────────────────────────── ring helpers ───────────────────────────── */

export function ringArea(r: ArrayLike<number>): number {
  let a = 0;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += r[j * 2] * r[i * 2 + 1] - r[i * 2] * r[j * 2 + 1];
  return Math.abs(a / 2);
}

export function ringCentre(r: ArrayLike<number>): [number, number] {
  let sx = 0;
  let sz = 0;
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    sx += r[i * 2];
    sz += r[i * 2 + 1];
  }
  return [sx / n, sz / n];
}

/** Unit vector from (x, z) towards the nearest point of a ring / polyline, and the distance. */
function towardsNearest(pts: ArrayLike<number>, x: number, z: number, closed: boolean): [number, number, number] {
  const n = pts.length / 2;
  let best = Infinity;
  let bx = 0;
  let bz = 0;
  const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % n;
    const ax = pts[i * 2];
    const az = pts[i * 2 + 1];
    const dx = pts[j * 2] - ax;
    const dz = pts[j * 2 + 1] - az;
    const l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
    const px = ax + dx * t;
    const pz = az + dz * t;
    const d = Math.hypot(px - x, pz - z);
    if (d < best) {
      best = d;
      bx = px;
      bz = pz;
    }
  }
  return best > 0 ? [(bx - x) / best, (bz - z) / best, best] : [0, -1, 0];
}

/** Heading (rad) of a ring's longest edge. */
function longAxis(r: ArrayLike<number>): number {
  const n = r.length / 2;
  let best = -1;
  let h = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = r[j * 2] - r[i * 2];
    const dz = r[j * 2 + 1] - r[i * 2 + 1];
    const l = Math.hypot(dx, dz);
    if (l > best) {
      best = l;
      h = Math.atan2(dx, -dz);
    }
  }
  return h;
}

/** A box along the segment a → b (width across, from y0 up to top). */
function segmentBox(B: GeometryBuilder, ax: number, az: number, bx: number, bz: number, w: number, y0: number, top: number, color: number): void {
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 0.5) return;
  const fr = frameFromHeading((ax + bx) / 2, 0, (az + bz) / 2, Math.atan2(bx - ax, -(bz - az)));
  B.box(fr, 0, y0, 0, w, top - y0, len + w * 0.5, color);
}

/** Quad with its normal turned towards `side` (world, IDENT frame): for hand-wound stands and roofs. */
function facing(B: GeometryBuilder, p: number[], side: [number, number, number], color: Color | number, win = WIN_NONE): void {
  const ax = p[3] - p[0], ay = p[4] - p[1], az = p[5] - p[2];
  const bx = p[9] - p[0], by = p[10] - p[1], bz = p[11] - p[2];
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  if (nx * side[0] + ny * side[1] + nz * side[2] >= 0) B.quad(IDENT_FRAME, p, color, win);
  else B.quad(IDENT_FRAME, [p[9], p[10], p[11], p[6], p[7], p[8], p[3], p[4], p[5], p[0], p[1], p[2]], color, win);
}

const inAny = (rings: OsmFeature[], x: number, z: number, grow = 0) =>
  rings.some((f) => pointInRing(f.pts, x, z) || (grow > 0 && distToPath(f.pts, x, z, true) < grow));

/* ───────────────────────────── entry point ───────────────────────────── */

/**
 * Builds the waterfront from the OSM layer; null when it is not installed (the caller keeps the hand-placed port
 * and marinas, then calls buildStrategicSites for the sites that have a core-table fallback).
 */
export function buildWaterfront(B: GeometryBuilder, lights: LightList, height: HeightFn, detail: number, pads: readonly Pad[] = []): WaterfrontStats | null {
  if (!aucklandOsm()) return null;
  const st: WaterfrontStats = { piers: 0, yachts: 0, cranes: 0, stacks: 0, tanks: 0, tanksUnderPads: 0, navalBuildings: 0, decks: 0 };
  const rnd = mulberry32(3301);
  buildPortLand(B, lights, height, detail, rnd, st);
  buildPiers(B, lights, height, detail, st);
  buildMarinaYachts(B, height, detail, rnd, st);
  buildNavalBase(B, lights, height, st);
  const sites = buildStrategicSites(B, lights, height, detail, pads);
  st.tanks = sites.tanks;
  st.tanksUnderPads = sites.tanksUnderPads;
  return st;
}

/* ───────────────────────────── port ───────────────────────────── */

function buildPortLand(B: GeometryBuilder, lights: LightList, height: HeightFn, detail: number, rnd: () => number, st: WaterfrontStats): void {
  const port = osmLayer(OSM_PORT);
  // a port polygon inside a bigger one (the Fergusson terminal inside the Port of Auckland) is not a second deck
  const byArea = port.slice().sort((a, b) => ringArea(b.pts) - ringArea(a.pts));
  const decks: OsmFeature[] = [];
  for (const f of byArea) {
    const [cx, cz] = ringCentre(f.pts);
    if (!decks.some((d) => pointInRing(d.pts, cx, cz))) decks.push(f);
  }
  for (const d of decks) {
    // the slab covers the reclamations the LINZ coastline predates; on higher ground it is buried in the terrain
    B.prism(d.pts, -5, () => WHARF_TOP, DECK, DECK);
    st.decks++;
  }
  const terminal = port.find((f) => /container terminal/i.test(f.name));
  if (terminal) buildContainerYard(B, lights, terminal, detail, rnd, st);
  // quay cranes on their real positions, booms out over the nearest wharf face
  for (const c of osmLayer(OSM_CRANE)) {
    if (!c.container) continue;
    const x = c.pts[0];
    const z = c.pts[1];
    const deck = decks.find((d) => pointInRing(d.pts, x, z)) ?? decks[0];
    if (!deck) continue;
    const [ux, uz] = towardsNearest(deck.pts, x, z, true);
    quayCrane(B, lights, x, z, Math.atan2(ux, -uz), rnd() < 0.25);
    st.cranes++;
  }
  // sheds on the open wharves away from the stacks and beyond the LINZ CBD buildings (which stop at x ≈ 1,090 m)
  for (const d of decks) {
    const head = longAxis(terminal?.pts ?? d.pts);
    const fr0 = frameFromHeading(0, 0, 0, head);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < d.pts.length; i += 2) {
      x0 = Math.min(x0, d.pts[i]);
      x1 = Math.max(x1, d.pts[i]);
      z0 = Math.min(z0, d.pts[i + 1]);
      z1 = Math.max(z1, d.pts[i + 1]);
    }
    for (let z = z0 + 45; z < z1; z += 95) {
      for (let x = x0 + 45; x < x1; x += 95) {
        if (x < 1100 || rnd() > 0.5 * Math.max(0.4, detail)) continue;
        if (!pointInRing(d.pts, x, z) || distToPath(d.pts, x, z, true) < 40) continue;
        if (terminal && (pointInRing(terminal.pts, x, z) || distToPath(terminal.pts, x, z, true) < 30)) continue;
        if (height(x, z) > 6) continue; // inland, off the wharf
        const fr = { ...fr0, ox: x, oz: z };
        B.box(fr, 0, WHARF_TOP - 0.5, 0, 34 + rnd() * 30, 9 + rnd() * 6, 22 + rnd() * 16, 0xbfc3c4, 0x7d8388, WIN_INDUSTRIAL);
      }
    }
  }
}

function buildContainerYard(B: GeometryBuilder, lights: LightList, t: OsmFeature, detail: number, rnd: () => number, st: WaterfrontStats): void {
  const head = longAxis(t.pts);
  const fr = frameFromHeading(0, 0, 0, head);
  // terminal-aligned local frame: u across the long axis, v along it (local −Z = head)
  const toLocal = (x: number, z: number): [number, number] => [x * fr.c - z * fr.s, x * fr.s + z * fr.c];
  const toWorld = (u: number, v: number): [number, number] => [u * fr.c + v * fr.s, -u * fr.s + v * fr.c];
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let i = 0; i < t.pts.length; i += 2) {
    const [u, v] = toLocal(t.pts[i], t.pts[i + 1]);
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  const colors = [0xb03a2e, 0x2e5a9a, 0x2f7a4a, 0xd87a2a, 0xe8e6e0, 0x6a6e72, 0x9a2e5a, 0x1f3f6a, 0x8a6a3a, 0x3a8a9a];
  const pitchV = detail > 0.5 ? 34 : 48;
  for (let v = v0 + 20; v < v1; v += pitchV) {
    for (let u = u0 + 20; u < u1; u += 30) {
      const [x, z] = toWorld(u, v);
      // clear of the quay crane aprons along the wharf faces and of the gate / road side
      if (!pointInRing(t.pts, x, z) || distToPath(t.pts, x, z, true) < 60 || rnd() < 0.12) continue;
      const tiers = 1 + ((rnd() * 4) | 0);
      const f = { ...fr, ox: x, oz: z };
      for (let c = 0; c < 2; c++) {
        const col = colors[(rnd() * colors.length) | 0];
        B.box(f, (c - 0.5) * 12.5, WHARF_TOP, 0, 12, 2.6 * tiers, 24.4, col, new Color(col).multiplyScalar(0.8));
      }
      st.stacks++;
    }
  }
  // flood light masts on a 150 m grid
  for (let v = v0 + 60; v < v1; v += 150) {
    for (let u = u0 + 60; u < u1; u += 150) {
      const [x, z] = toWorld(u, v);
      if (!pointInRing(t.pts, x, z) || distToPath(t.pts, x, z, true) < 40) continue;
      B.beam(IDENT_FRAME, x, WHARF_TOP, z, x, WHARF_TOP + 32, z, 1, 0x9a9a98);
      lights.add(x, WHARF_TOP + 33, z, 0xfff0d0, 10);
    }
  }
}

/** Ship-to-shore container crane: legs straddling the quay, boom along local −Z (`heading`, out over the water). */
function quayCrane(B: GeometryBuilder, lights: LightList, x: number, z: number, heading: number, raised: boolean): void {
  const f = frameFromHeading(x, WHARF_TOP, z, heading);
  const legs = new Color(0xdad8d2);
  const boom = new Color(0xc0392b);
  const legH = 44;
  // legs 30 m apart across the rails (local Z), 18 m along the quay (local X); the seaward rail ≈ 10 m from the face
  for (const ox of [-9, 9]) for (const oz of [-25, 5]) B.beam(f, ox, 0, oz, ox, legH, oz, 1.6, legs);
  for (const oz of [-25, 5]) B.beam(f, -9, legH, oz, 9, legH, oz, 1.8, legs);
  for (const ox of [-9, 9]) {
    B.beam(f, ox, legH, -25, ox, legH, 5, 1.8, legs);
    B.beam(f, ox, 16, -25, ox, 16, 5, 1.2, legs);
  }
  if (raised) B.beam(f, 0, legH + 2, -20, 0, legH + 58, -40, 2.4, boom);
  else B.beam(f, 0, legH + 2, 30, 0, legH + 2, -75, 2.4, boom);
  B.box(f, 0, legH - 1, 0, 14, 7, 12, legs, legs, WIN_INDUSTRIAL);
  B.beam(f, 0, legH + 2, -2, 0, legH + 20, -8, 1.2, legs);
  const [wx, wz] = [f.ox - 8 * f.s, f.oz + 8 * f.c];
  lights.add(wx, WHARF_TOP + legH + 22, wz, 0xff2a18, 3, (x * 0.013) % 1);
}

/** Yard / dock gantry crane (yellow portal). */
function dockCrane(B: GeometryBuilder, x: number, y: number, z: number, heading: number): void {
  const f = frameFromHeading(x, y, z, heading);
  const yel = new Color(0xd8b02a);
  for (const ox of [-11, 11]) {
    for (const oz of [-4, 4]) B.beam(f, ox, 0, oz, ox, 20, oz, 1.1, yel);
    B.beam(f, ox, 20, -4, ox, 20, 4, 1.2, yel);
  }
  B.beam(f, -13, 21, 0, 13, 21, 0, 2.2, yel);
  B.box(f, 4, 21.5, 0, 4, 3, 3.5, yel, yel, WIN_INDUSTRIAL);
}

/* ───────────────────────────── piers, pontoons, breakwaters ───────────────────────────── */

/**
 * A pier / breakwater line that closes on itself round a real area (Calliope Wharf, the training jetty: OSM closed
 * ways without area=yes) is a deck, not a ring-shaped walkway.
 */
function closedArea(f: OsmFeature): boolean {
  const n = f.pts.length / 2;
  if (f.area) return true;
  if (n < 4) return false;
  const closed = Math.hypot(f.pts[0] - f.pts[(n - 1) * 2], f.pts[1] - f.pts[(n - 1) * 2 + 1]) < 1;
  return closed && ringArea(f.pts) > 300;
}

function buildPiers(B: GeometryBuilder, lights: LightList, height: HeightFn, detail: number, st: WaterfrontStats): void {
  for (const f of osmLayer(OSM_PIER)) {
    const top = f.floating ? PONTOON_TOP : WHARF_TOP;
    const y0 = f.floating ? -0.4 : -3;
    const col = f.floating ? PONTOON : DECK;
    if (closedArea(f)) {
      if (ringArea(f.pts) < 4) continue;
      B.prism(f.pts, y0, () => top, col, col);
    } else {
      // small jetties and pontoon walkways mapped as lines
      const w = f.floating ? 2.6 : 4;
      if (detail < 0.4 && f.pts.length / 2 < 3 && Math.hypot(f.pts[2] - f.pts[0], f.pts[3] - f.pts[1]) < 12) continue;
      for (let i = 0; i + 3 < f.pts.length; i += 2) segmentBox(B, f.pts[i], f.pts[i + 1], f.pts[i + 2], f.pts[i + 3], w, y0, top, col);
    }
    st.piers++;
    // a light at the seaward end of the longer wharves
    if (!f.floating && !closedArea(f) && f.pts.length >= 4) {
      const n = f.pts.length / 2;
      const [x, z] = [f.pts[(n - 1) * 2], f.pts[(n - 1) * 2 + 1]];
      if (height(x, z) < 0) lights.add(x, top + 4, z, 0xfff0d0, 2.5);
    }
  }
  for (const f of osmLayer(OSM_BREAKWATER)) {
    if (closedArea(f)) B.prism(f.pts, -4, () => BREAKWATER_TOP, ROCK, ROCK);
    else for (let i = 0; i + 3 < f.pts.length; i += 2) segmentBox(B, f.pts[i], f.pts[i + 1], f.pts[i + 2], f.pts[i + 3], 7, -4, BREAKWATER_TOP, ROCK);
    st.piers++;
  }
}

/* ───────────────────────────── marinas: yachts on the real pontoons ───────────────────────────── */

/** Occupancy grid over a marina (1 m cells): pontoons first, then each yacht claims its hull. */
class Occupancy {
  private readonly cells: Uint8Array;
  constructor(
    private readonly x0: number,
    private readonly z0: number,
    private readonly nx: number,
    private readonly nz: number,
  ) {
    this.cells = new Uint8Array(nx * nz);
  }
  static readonly CELL = 1;
  private idx(x: number, z: number): number {
    const i = Math.floor((x - this.x0) / Occupancy.CELL);
    const k = Math.floor((z - this.z0) / Occupancy.CELL);
    return i < 0 || k < 0 || i >= this.nx || k >= this.nz ? -1 : k * this.nx + i;
  }
  taken(x: number, z: number): boolean {
    const i = this.idx(x, z);
    return i < 0 || this.cells[i] !== 0;
  }
  mark(x: number, z: number): void {
    const i = this.idx(x, z);
    if (i >= 0) this.cells[i] = 1;
  }
  /** Marks a ring's inside (scanline, one row per cell) and a `skin` (m) along its edges. */
  fillRing(r: ArrayLike<number>, skin: number): void {
    const C = Occupancy.CELL;
    const n = r.length / 2;
    let zMin = Infinity, zMax = -Infinity;
    for (let i = 0; i < n; i++) {
      zMin = Math.min(zMin, r[i * 2 + 1]);
      zMax = Math.max(zMax, r[i * 2 + 1]);
    }
    const xs: number[] = [];
    for (let z = Math.floor((zMin - this.z0) / C) * C + this.z0 + C / 2; z <= zMax; z += C) {
      xs.length = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const zi = r[i * 2 + 1], zj = r[j * 2 + 1];
        if (zi > z !== zj > z) xs.push(r[i * 2] + ((z - zi) / (zj - zi)) * (r[j * 2] - r[i * 2]));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) for (let x = xs[k]; x <= xs[k + 1]; x += C) this.mark(x, z);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = r[i * 2], az = r[i * 2 + 1];
      const dx = r[j * 2] - ax, dz = r[j * 2 + 1] - az;
      const L = Math.hypot(dx, dz) || 1;
      for (let t = 0; t <= L; t += 1) for (const o of [-skin, 0, skin]) this.mark(ax + (dx * t) / L - (dz / L) * o, az + (dz * t) / L + (dx / L) * o);
    }
  }
}

function buildMarinaYachts(B: GeometryBuilder, height: HeightFn, detail: number, rnd: () => number, st: WaterfrontStats): void {
  const marinas = osmLayer(OSM_MARINA);
  const piers = osmLayer(OSM_PIER);
  const fill = 0.55 + 0.3 * Math.min(1, detail);
  for (const m of marinas) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < m.pts.length; i += 2) {
      x0 = Math.min(x0, m.pts[i]);
      x1 = Math.max(x1, m.pts[i]);
      z0 = Math.min(z0, m.pts[i + 1]);
      z1 = Math.max(z1, m.pts[i + 1]);
    }
    x0 -= 30;
    z0 -= 30;
    x1 += 30;
    z1 += 30;
    const own = piers.filter((p) => {
      const [cx, cz] = ringCentre(p.pts);
      return cx > x0 && cx < x1 && cz > z0 && cz < z1 && (pointInRing(m.pts, cx, cz) || distToPath(m.pts, cx, cz, true) < 25);
    });
    if (!own.length) continue;
    const C = Occupancy.CELL;
    const occ = new Occupancy(x0, z0, Math.ceil((x1 - x0) / C), Math.ceil((z1 - z0) / C));
    // rasterise the pontoons (with a 1 m skin) and the land
    for (let z = z0 + 1; z < z1; z += 2) {
      for (let x = x0 + 1; x < x1; x += 2) {
        if (height(x, z) > 0.5) for (const [dx, dz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) occ.mark(x + dx, z + dz);
      }
    }
    for (const p of own) {
      if (closedArea(p)) occ.fillRing(p.pts, 0.4);
      else {
        for (let i = 0; i + 3 < p.pts.length; i += 2) {
          const ax = p.pts[i], az = p.pts[i + 1], bx = p.pts[i + 2], bz = p.pts[i + 3];
          const L = Math.hypot(bx - ax, bz - az);
          const nx = -(bz - az) / (L || 1);
          const nz = (bx - ax) / (L || 1);
          for (let s = 0; s <= L; s += 1) for (const o of [-2.3, 0, 2.3]) occ.mark(ax + ((bx - ax) * s) / (L || 1) + nx * o, az + ((bz - az) * s) / (L || 1) + nz * o);
        }
      }
    }
    // along each pontoon's long axis, both sides: march out to the pontoon's edge; where that is the walkway (not a
    // finger) the slot beyond takes a yacht, bow to the pontoon
    for (const p of own) {
      const ax = pontoonAxis(p);
      if (!ax) continue;
      const { ox, oz, ux, uz, s0, s1 } = ax;
      for (const side of [-1, 1]) {
        const nx = -uz * side;
        const nz = ux * side;
        // edge distance from the axis every metre; runs where it is short are the slots between the fingers
        const edgeAt = (s: number): number => {
          if (!closedArea(p)) return 1.3;
          let e = 0;
          while (e < 8 && pointInRing(p.pts, ox + ux * s + nx * e, oz + uz * s + nz * e)) e += 0.5;
          return e;
        };
        const slots: [number, number, number][] = [];
        let open = -1;
        let deep = 0;
        for (let s = s0 + 1; s <= s1 - 1; s += 1) {
          const e = edgeAt(s);
          if (e < 4.5) {
            if (open < 0) open = s;
            deep = Math.max(deep, e);
          } else if (open >= 0) {
            slots.push([open, s - 1, deep]);
            open = -1;
            deep = 0;
          }
        }
        if (open >= 0) slots.push([open, s1 - 1, deep]);
        for (const [a0, a1, edge] of slots) {
          const w = a1 - a0 + 1;
          const k = w >= 3.6 ? Math.max(1, Math.floor(w / 4.4)) : 0;
          for (let q = 0; q < k; q++) {
            const s = a0 - 0.5 + (w * (q + 0.5)) / k;
            const len = 9 + rnd() * 7;
            const px = ox + ux * s;
            const pz = oz + uz * s;
            const cx = px + nx * (edge + 1.2 + len / 2);
            const cz = pz + nz * (edge + 1.2 + len / 2);
            if (!pointInRing(m.pts, cx, cz) && distToPath(m.pts, cx, cz, true) > 15) continue;
            // the hull (5 points along, 3 across) must be on free water
            let free = true;
            for (let a = -len / 2; a <= len / 2 && free; a += len / 4) for (const b of [-1, 0, 1]) if (occ.taken(cx + nx * a - nz * b, cz + nz * a + nx * b)) free = false;
            if (!free) continue;
            for (let a = -len / 2; a <= len / 2; a += 1) for (const b of [-1.2, 0, 1.2]) occ.mark(cx + nx * a - nz * b, cz + nz * a + nx * b);
            if (rnd() > fill) continue; // an empty berth
            yacht(B, cx, cz, Math.atan2(-nx, nz), len, detail, rnd);
            st.yachts++;
          }
        }
      }
    }
  }
}

/** A pontoon's long axis: origin, unit direction and the extent along it (principal axis of its vertices). */
function pontoonAxis(p: OsmFeature): { ox: number; oz: number; ux: number; uz: number; s0: number; s1: number } | null {
  const n = p.pts.length / 2;
  if (n < 2) return null;
  const [ox, oz] = ringCentre(p.pts);
  let sxx = 0, sxz = 0, szz = 0;
  for (let i = 0; i < n; i++) {
    const dx = p.pts[i * 2] - ox;
    const dz = p.pts[i * 2 + 1] - oz;
    sxx += dx * dx;
    sxz += dx * dz;
    szz += dz * dz;
  }
  const th = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const ux = Math.cos(th);
  const uz = Math.sin(th);
  let s0 = Infinity, s1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const s = (p.pts[i * 2] - ox) * ux + (p.pts[i * 2 + 1] - oz) * uz;
    s0 = Math.min(s0, s);
    s1 = Math.max(s1, s);
  }
  return s1 - s0 > 12 ? { ox, oz, ux, uz, s0, s1 } : null;
}

const HULL = new Color(0xf2f2ee);
const HULL_SIDE = new Color(0xd8d8d2);
const MAST = new Color(0xd0d0cc);

/** A yacht (≈ 8 triangles): deck, two sloped sides meeting at the keel line, mast. `heading` = bow direction. */
function yacht(B: GeometryBuilder, x: number, z: number, heading: number, L: number, detail: number, rnd: () => number): void {
  const f = frameFromHeading(x, 0, z, heading);
  const hw = 1.6 + L * 0.05;
  // local −Z = bow; hull deck at 1.6 m, keel line at the waterline
  B.quad(f, [-hw, 1.6, L / 2, hw, 1.6, L / 2, hw * 0.4, 1.6, -L / 2, -hw * 0.4, 1.6, -L / 2], HULL);
  B.quad(f, [hw, 1.6, L / 2, 0, 0, L / 2 - 1, 0, 0, -L / 2 + 1, hw * 0.4, 1.6, -L / 2], HULL_SIDE);
  B.quad(f, [-hw * 0.4, 1.6, -L / 2, 0, 0, -L / 2 + 1, 0, 0, L / 2 - 1, -hw, 1.6, L / 2], HULL_SIDE);
  if (detail > 0.3 && rnd() < 0.75) {
    const mh = 1.6 + L * 1.3;
    B.quad(f, [-0.15, 1.6, 0, 0.15, 1.6, 0, 0.1, mh, 0, -0.1, mh, 0], MAST);
  }
}

/* ───────────────────────────── Devonport Naval Base ───────────────────────────── */

function buildNavalBase(B: GeometryBuilder, lights: LightList, height: HeightFn, st: WaterfrontStats): void {
  const military = [...osmLayer(OSM_MILITARY), ...osmLayer(OSM_NAVAL)];
  // the base buildings (and those of the other military sites outside the airfields)
  for (const b of osmLayer(OSM_BUILDING)) {
    const area = ringArea(b.pts);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < b.pts.length; i += 2) {
      const y = height(b.pts[i], b.pts[i + 1]);
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    const h = b.width > 0 ? b.width : area > 3000 ? 14 : area > 800 ? 10 : 7;
    const naval = lo < 25; // the waterside base: naval grey; the hill sites in cream
    B.prism(b.pts, lo - 1.5, () => Math.max(hi, lo) + h, naval ? 0xa9adb0 : 0xd8d2c2, 0x6f7376, area > 1500 ? WIN_INDUSTRIAL : WIN_OFFICE);
    st.navalBuildings++;
  }
  // Calliope Dock: the dry dock seen from above — a deep basin (dark floor), a concrete coping round it and the
  // caisson gate on the side that opens to the harbour
  for (const d of osmLayer(OSM_DOCK)) {
    // at the wharf: the lowest ground on its rim (the coarse terrain mesh climbs the cliff behind the base)
    let g = Infinity;
    for (let i = 0; i < d.pts.length; i += 2) g = Math.min(g, height(d.pts[i], d.pts[i + 1]));
    g = Math.max(WHARF_TOP, g);
    B.prism(d.pts, g - 1, () => g + 0.35, 0x3d5660, 0x3d5660);
    const n = d.pts.length / 2;
    let gate = -1;
    let gateLow = Infinity;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = d.pts[i * 2], az = d.pts[i * 2 + 1], bx = d.pts[j * 2], bz = d.pts[j * 2 + 1];
      segmentBox(B, ax, az, bx, bz, 2.4, g - 1, g + 1.4, 0xb8b6ae);
      const mx = (ax + bx) / 2;
      const mz = (az + bz) / 2;
      const len = Math.hypot(bx - ax, bz - az);
      // the gate: the edge of at least 20 m whose outside is lowest (towards the water)
      const [ux, uz] = [(bz - az) / (len || 1), -(bx - ax) / (len || 1)];
      const out = Math.min(height(mx + ux * 25, mz + uz * 25), height(mx - ux * 25, mz - uz * 25));
      if (len > 20 && out < gateLow) {
        gateLow = out;
        gate = i;
      }
    }
    if (gate >= 0) {
      const j = (gate + 1) % n;
      segmentBox(B, d.pts[gate * 2], d.pts[gate * 2 + 1], d.pts[j * 2], d.pts[j * 2 + 1], 6, g - 1, g + 2.2, 0x55616a);
    }
    for (let i = 0; i < n; i += 2) lights.add(d.pts[i * 2], g + 8, d.pts[i * 2 + 1], 0xfff0d0, 4);
  }
  // dock and wharf gantries (the yellow cranes on the Calliope wharves): the non-container cranes on military land
  for (const c of osmLayer(OSM_CRANE)) {
    if (c.container) continue;
    const x = c.pts[0];
    const z = c.pts[1];
    if (!inAny(military, x, z, 120)) continue;
    const pier = osmLayer(OSM_PIER).find((p) => closedArea(p) && pointInRing(p.pts, x, z));
    const y = pier ? WHARF_TOP : Math.max(WHARF_TOP, height(x, z));
    dockCrane(B, x, y, z, pier ? longAxis(pier.pts) : 0);
    st.cranes++;
  }
}

/* ───────────────────────────── Wiri tanks, other storage tanks, Eden Park ───────────────────────────── */

/**
 * The sites with a core-table fallback: the storage tanks (OSM's outside the airfields, else the Wiri table) and
 * Eden Park. A tank under a mission target's pad is left out — the target's own model stands there.
 */
export function buildStrategicSites(B: GeometryBuilder, lights: LightList, height: HeightFn, detail: number, pads: readonly Pad[] = []): SitesStats {
  let tanks = 0;
  let tanksUnderPads = 0;
  const list: { x: number; z: number; d: number }[] = [];
  if (aucklandOsm()) {
    // the airfield fuel farms are drawn with their airfield (airbase.ts buildRealAirfield)
    const onAirfield = new Set<OsmFeature>();
    for (const id of AIRFIELD_IDS) for (const t of airfieldLayout(id)?.tanks ?? []) onAirfield.add(t);
    for (const t of osmLayer(OSM_TANK)) {
      if (onAirfield.has(t)) continue;
      const [x, z] = ringCentre(t.pts);
      list.push({ x, z, d: 2 * Math.sqrt(ringArea(t.pts) / Math.PI) });
    }
  } else list.push(...WIRI_TANKS);
  for (const t of list) {
    const r = t.d / 2;
    if (pads.some((p) => Math.hypot(p.x - t.x, p.z - t.z) < p.radius)) {
      tanksUnderPads++;
      continue;
    }
    const y = height(t.x, t.z) - 0.5;
    const h = Math.max(8, Math.min(18, t.d * 0.55));
    B.cylinder(IDENT_FRAME, t.x, y, t.z, r, r, h, r > 12 ? 20 : 14, 0xe4e4e0, WIN_NONE, false);
    B.cylinder(IDENT_FRAME, t.x, y + h, t.z, r, r * 0.25, Math.min(3, r * 0.15), r > 12 ? 20 : 14, 0xcfd0cc, WIN_NONE, true);
    // a low bund wall round the larger tanks
    if (r > 9 && detail > 0.4) B.cylinder(IDENT_FRAME, t.x, y - 0.5, t.z, r + 6, r + 6, 2, 16, 0x9a978f, WIN_NONE, false);
    tanks++;
  }
  // aviation obstruction lights on the Wiri terminal
  const w = AKL.wiri_terminal;
  if (w) lights.add(w.x, height(w.x, w.z) + 22, w.z, 0xff2a18, 3, 0.3);
  const eden = buildEdenPark(B, lights, height);
  return { tanks, tanksUnderPads, eden };
}

export interface SitesStats {
  tanks: number;
  tanksUnderPads: number;
  /** Where Eden Park's pitch was placed, and whether from the OSM pitch (else the landmark fallback). */
  eden: { x: number; z: number; osm: boolean } | null;
}

/** Eden Park's Main Oval when OSM is missing: centre = AKL.eden_park, long axis 105° true, 119 × 71 m. */
const EDEN_FALLBACK = { heading: (104.6 * Math.PI) / 180, a: 59.5, b: 35.5 };

/** Eden Park: a bowl of stands round the Main Oval (OSM pitch, else the fallback above), roofs over the long sides. */
export function buildEdenPark(B: GeometryBuilder, lights: LightList, height: HeightFn): SitesStats['eden'] {
  const E = AKL.eden_park;
  if (!E) return null;
  let { heading, a, b } = EDEN_FALLBACK;
  let cx = E.x;
  let cz = E.z;
  let pitch: OsmFeature | undefined;
  for (const p of osmLayer(OSM_PITCH)) {
    const [px, pz] = ringCentre(p.pts);
    if (Math.hypot(px - E.x, pz - E.z) < 60 && (!pitch || ringArea(p.pts) > ringArea(pitch.pts))) pitch = p;
  }
  if (pitch) {
    [cx, cz] = ringCentre(pitch.pts);
    heading = longAxis(pitch.pts);
    const hx = Math.sin(heading);
    const hz = -Math.cos(heading);
    a = 0;
    b = 0;
    for (let i = 0; i < pitch.pts.length; i += 2) {
      const dx = pitch.pts[i] - cx;
      const dz = pitch.pts[i + 1] - cz;
      a = Math.max(a, Math.abs(dx * hx + dz * hz)); // along the long axis
      b = Math.max(b, Math.abs(-dx * hz + dz * hx)); // across it
    }
    a = Math.max(a, 40);
    b = Math.max(b, 25);
  }
  const g = height(cx, cz);
  const ux = Math.sin(heading);
  const uz = -Math.cos(heading);
  // ellipse point at angle t, semi-axes along (along-heading A, across B), grown by `grow`
  const at = (t: number, grow: number): [number, number] => {
    const A = a + grow;
    const Bb = b + grow;
    const p = Math.cos(t) * A;
    const q = Math.sin(t) * Bb;
    return [cx + ux * p - uz * q, cz + uz * p + ux * q];
  };
  const seg = 40;
  const seats = new Color(0x5a6168);
  const wall = new Color(0xd6d2c8);
  const roof = new Color(0xe8e8e4);
  B.prism(
    Array.from({ length: seg }, (_, i) => at((i / seg) * Math.PI * 2, 6)).flat(),
    g - 1,
    () => g + 0.25,
    0x4f8a3a,
    0x4f8a3a,
  );
  for (let i = 0; i < seg; i++) {
    const t0 = (i / seg) * Math.PI * 2;
    const t1 = ((i + 1) / seg) * Math.PI * 2;
    // the long sides (the West and South stands) are the tall ones
    const side = (t: number) => Math.abs(Math.sin(t));
    const h0 = 16 + 14 * side(t0);
    const h1 = 16 + 14 * side(t1);
    const [ix0, iz0] = at(t0, 14);
    const [ix1, iz1] = at(t1, 14);
    const [ox0, oz0] = at(t0, 62);
    const [ox1, oz1] = at(t1, 62);
    const mid = at((t0 + t1) / 2, 38);
    const inward: [number, number, number] = [cx - mid[0], 0, cz - mid[1]];
    const outward: [number, number, number] = [mid[0] - cx, 0, mid[1] - cz];
    // raked seating (faces the pitch and up), the back wall, and a roof over the tall stands
    facing(B, [ix0, g + 3, iz0, ix1, g + 3, iz1, ox1, g + h1, oz1, ox0, g + h0, oz0], [inward[0], 60, inward[2]], seats);
    facing(B, [ox0, g - 1, oz0, ox1, g - 1, oz1, ox1, g + h1 + 4, oz1, ox0, g + h0 + 4, oz0], outward, wall, WIN_OFFICE);
    facing(B, [ix0, g + 3, iz0, ix1, g + 3, iz1, ix1, g - 1, iz1, ix0, g - 1, iz0], inward, wall);
    if (side(t0) > 0.6 && side(t1) > 0.6) {
      const [rx0, rz0] = at(t0, 30);
      const [rx1, rz1] = at(t1, 30);
      facing(B, [rx0, g + h0 + 6, rz0, rx1, g + h1 + 6, rz1, ox1, g + h1 + 4, oz1, ox0, g + h0 + 4, oz0], [0, 1, 0], roof);
      facing(B, [rx0, g + h0 + 6, rz0, rx1, g + h1 + 6, rz1, ox1, g + h1 + 4, oz1, ox0, g + h0 + 4, oz0], [0, -1, 0], roof);
    }
    if (i % 5 === 0) {
      const [lx, lz] = at(t0, 32);
      lights.add(lx, g + 16 + 14 * side(t0) + 8, lz, 0xfff6e0, 9);
    }
  }
  return { x: cx, z: cz, osm: !!pitch };
}

/* ───────────────────────────── scatter keep-out ───────────────────────────── */

/**
 * Where the procedural houses and trees must not stand: military and naval land (the base buildings), stadiums,
 * port land and the Wiri tank farm (every tank grown by 30 m). Without OSM: the Wiri table and a 160 m disc round
 * Eden Park. Returns a fast point test (bounding boxes first).
 */
export function waterfrontKeepOut(): (x: number, z: number) => boolean {
  const rings: { pts: ArrayLike<number>; x0: number; x1: number; z0: number; z1: number }[] = [];
  const addRing = (pts: ArrayLike<number>) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      x0 = Math.min(x0, pts[i]);
      x1 = Math.max(x1, pts[i]);
      z0 = Math.min(z0, pts[i + 1]);
      z1 = Math.max(z1, pts[i + 1]);
    }
    rings.push({ pts, x0, x1, z0, z1 });
  };
  const discs: [number, number, number][] = [];
  if (aucklandOsm()) {
    for (const layer of [OSM_MILITARY, OSM_NAVAL, OSM_STADIUM, OSM_PORT]) for (const f of osmLayer(layer)) if (f.area) addRing(f.pts);
  } else if (AKL.eden_park) discs.push([AKL.eden_park.x, AKL.eden_park.z, 160]);
  for (const t of WIRI_TANKS) discs.push([t.x, t.z, t.d / 2 + 30]);
  return (x, z) => {
    for (const [cx, cz, r] of discs) if ((x - cx) ** 2 + (z - cz) ** 2 < r * r) return true;
    for (const r of rings) if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1 && pointInRing(r.pts, x, z)) return true;
    return false;
  };
}
