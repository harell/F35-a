/**
 * F35-A — Auckland Harbour Bridge mesh, from the measured shape in core/harbourBridge.ts (LINZ 2024 LiDAR, OSM piers,
 * published spans; prototype tools/hero/examples/harbour-bridge.html):
 *  - the deck on its measured profile (±5 % grades, 46.4 m crest), 35.2 m wide, the original 4-lane deck between the
 *    trusses and the two clip-on box girders with their haunches at the main piers;
 *  - two steel trusses at t = ±7.5 m on ~15.25 m panels: a deck truss under the road the whole way, rising above it
 *    as the through truss over the main span (top chord measured, 64.4 m at the crest), lateral bracing on top;
 *  - six concrete piers on the OSM footprints with steel caps and the clip-ons' brackets, two abutments, and approach
 *    viaducts down to the game's abutment points (AKL.bridge_s / bridge_n, where the motorway ribbons start);
 *  - lamp posts on both edges, the four sign gantries, the two flags on the crest; night lights.
 * Everything is built in the bridge frame (local x = t, local −z = s), one merged mesh with the other scenery.
 */
import { Color } from 'three';
import { AKL } from '../../core/auckland';
import {
  HB_DIR, HB_FLAGS, HB_GANTRIES, HB_HALF_WIDTH, HB_ORIGIN, HB_PIERS, HB_S_NORTH, HB_S_SOUTH, HB_TRUSS_T,
  hbAt, hbChord, hbClipDepth, hbDeck, hbFrame, hbPanelNodes, hbTrussDepth,
} from '../../core/harbourBridge';
import { frameFromHeading, type Frame, type GeometryBuilder } from './GeometryBuilder';
import type { HeightFn, LightList } from './builders';

const COL = {
  road: new Color(0x55585b),
  truss: new Color(0xb4bbbb),
  girder: new Color(0xa9b0b1),
  barrier: new Color(0xcfd2cd),
  concrete: new Color(0xb6ad9b),
  cap: new Color(0x8f989a),
  steel: new Color(0x7f8789),
  sign: new Color(0x1f6b45),
  flag: new Color(0x1d2f6b),
};

type P3 = [number, number, number];

/** Quad a, b, c, d (bridge-local [t, y, s]) facing away from `inside`: the game's building material is front-facing only. */
function face(B: GeometryBuilder, f: Frame, q: P3[], inside: P3, col: Color): void {
  const L = q.map(([t, y, s]) => [t, y, -s]);
  const ax = L[1][0] - L[0][0], ay = L[1][1] - L[0][1], az = L[1][2] - L[0][2];
  const bx = L[3][0] - L[0][0], by = L[3][1] - L[0][1], bz = L[3][2] - L[0][2];
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const cx = (L[0][0] + L[2][0]) / 2 - inside[0], cy = (L[0][1] + L[2][1]) / 2 - inside[1], cz = (L[0][2] + L[2][2]) / 2 + inside[2];
  const P = nx * cx + ny * cy + nz * cz >= 0 ? L : [L[0], L[3], L[2], L[1]];
  B.quad(f, P.flat(), col);
}

/** A closed polygon section (bridge-local [t, y] at s0 → s1) lofted between two stations, faces outward. */
function loft(B: GeometryBuilder, f: Frame, sec0: [number, number][], s0: number, sec1: [number, number][], s1: number, col: Color): void {
  const n = sec0.length;
  const ct = sec0.reduce((a, p) => a + p[0], 0) / n, cy = sec0.reduce((a, p) => a + p[1], 0) / n;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    face(B, f, [[sec0[i][0], sec0[i][1], s0], [sec0[j][0], sec0[j][1], s0], [sec1[j][0], sec1[j][1], s1], [sec1[i][0], sec1[i][1], s1]], [ct, cy, (s0 + s1) / 2], col);
  }
}

const beam = (B: GeometryBuilder, f: Frame, a: P3, b: P3, w: number, col: Color) => B.beam(f, a[0], a[1], -a[2], b[0], b[1], -b[2], w, col);
/** Box in the bridge frame: t0..t1 across, y0..y1, s0..s1 along. */
const box = (B: GeometryBuilder, f: Frame, t0: number, t1: number, y0: number, y1: number, s0: number, s1: number, col: Color) =>
  B.box(f, (t0 + t1) / 2, y0, -(s0 + s1) / 2, t1 - t0, y1 - y0, Math.abs(s1 - s0), col, col);

export function buildHarbourBridge(B: GeometryBuilder, lights: LightList, height: HeightFn, detail = 1): void {
  const f = frameFromHeading(HB_ORIGIN.x, 0, HB_ORIGIN.z, Math.atan2(HB_DIR[0], -HB_DIR[1]));
  const W = HB_HALF_WIDTH;
  const ground = (s: number, t = 0) => height(...hbAt(s, t));
  // approach ramps: from the abutments down to the game's abutment points, where the motorway ribbons start
  const sS = hbFrame(AKL.bridge_s.x, AKL.bridge_s.z)[0];
  const ySS = Math.max(4, ground(sS)) + 1;
  // north: the real deck reaches Northcote Point 34 m up and carries on as a viaduct; the ribbon starts on the ground
  // under it, so the approach viaduct runs on north along the axis at 10 % until it meets the terrain
  const RAMP = 0.1; // steeper than the real approach: the game's terrain at Northcote Point is ~10 m below the LiDAR ground
  let sN = HB_S_NORTH;
  while (sN < HB_S_NORTH + 400 && hbDeck(HB_S_NORTH) - RAMP * (sN - HB_S_NORTH) > ground(sN) + 1) sN += 5;
  const deck = (s: number) =>
    s < HB_S_SOUTH ? ySS + ((hbDeck(HB_S_SOUTH) - ySS) * (s - sS)) / (HB_S_SOUTH - sS) : s > HB_S_NORTH ? Math.max(ground(s) + 1, hbDeck(HB_S_NORTH) - RAMP * (s - HB_S_NORTH)) : hbDeck(s);

  // ── deck: road, original slab, clip-on girders, parapets ──
  const step = detail > 0.5 ? 5 : 10;
  const st: number[] = [];
  for (let s = sS; s < sN; s += step) st.push(s);
  st.push(sN);
  for (let i = 0; i + 1 < st.length; i++) {
    const s0 = st[i], s1 = st[i + 1], y0 = deck(s0), y1 = deck(s1);
    const onBridge = s1 > HB_S_SOUTH && s0 < HB_S_NORTH;
    face(B, f, [[-W, y0, s0], [W, y0, s0], [W, y1, s1], [-W, y1, s1]], [0, y0 - 5, (s0 + s1) / 2], COL.road);
    if (!onBridge) {
      // approach viaduct: a 1.8 m concrete deck girder on column pairs every 30 m
      loft(B, f, [[-W, y0 - 1.8], [W, y0 - 1.8], [W, y0 - 0.05], [-W, y0 - 0.05]], s0, [[-W, y1 - 1.8], [W, y1 - 1.8], [W, y1 - 0.05], [-W, y1 - 0.05]], s1, COL.concrete);
      if (Math.floor(s1 / 30) !== Math.floor(s0 / 30) && y1 - ground(s1) > 3) for (const t of [-9, 9]) box(B, f, t - 1.2, t + 1.2, ground(s1, t) - 1, y1 - 1.8, s1 - 1.2, s1 + 1.2, COL.concrete);
      continue;
    }
    loft(B, f, [[-7, y0 - 1.1], [7, y0 - 1.1], [7, y0 - 0.05], [-7, y0 - 0.05]], s0, [[-7, y1 - 1.1], [7, y1 - 1.1], [7, y1 - 0.05], [-7, y1 - 0.05]], s1, COL.girder);
    for (const sg of [-1, 1]) {
      const sec = (s: number, y: number): [number, number][] => {
        const h = hbClipDepth(s);
        return [[7.9 * sg, y - 0.05], [W * sg, y - 0.05], [16.4 * sg, y - h], [9.3 * sg, y - h]];
      };
      loft(B, f, sec(s0, y0), s0, sec(s1, y1), s1, COL.girder);
      loft(B, f, [[(W - 0.35) * sg, y0], [W * sg, y0], [W * sg, y0 + 1.05], [(W - 0.35) * sg, y0 + 1.05]], s0, [[(W - 0.35) * sg, y1], [W * sg, y1], [W * sg, y1 + 1.05], [(W - 0.35) * sg, y1 + 1.05]], s1, COL.barrier);
    }
  }

  // ── trusses ──
  const nodes = hbPanelNodes();
  const sup = [HB_S_SOUTH, ...HB_PIERS, HB_S_NORTH];
  const top = (s: number) => Math.max(hbChord(s), hbDeck(s) - 1.2);
  const bot = (s: number) => hbDeck(s) - hbTrussDepth(s);
  const through = (s: number) => hbChord(s) > hbDeck(s) + 1.5;
  for (const tt of [-HB_TRUSS_T, HB_TRUSS_T]) {
    for (let i = 0; i < nodes.length; i++) {
      const s = nodes[i];
      beam(B, f, [tt, bot(s), s], [tt, top(s), s], 0.7, COL.truss);
      if (i + 1 >= nodes.length) continue;
      const s2 = nodes[i + 1];
      beam(B, f, [tt, top(s), s], [tt, top(s2), s2], 1.1, COL.truss);
      beam(B, f, [tt, bot(s), s], [tt, bot(s2), s2], 1.1, COL.truss);
      // diagonals slope down towards the nearest support (Pratt-like), as in the photos
      const mid = (s + s2) / 2;
      const near = sup.reduce((m, v) => (Math.abs(v - mid) < Math.abs(m - mid) ? v : m), sup[0]);
      if (near < mid) beam(B, f, [tt, bot(s), s], [tt, top(s2), s2], 0.6, COL.truss);
      else beam(B, f, [tt, top(s), s], [tt, bot(s2), s2], 0.6, COL.truss);
    }
  }
  for (let i = 0; i + 1 < nodes.length; i++) {
    const s = nodes[i], s2 = nodes[i + 1];
    if (through(s) && through(s2)) {
      beam(B, f, [-HB_TRUSS_T, top(s), s], [HB_TRUSS_T, top(s2), s2], 0.45, COL.truss);
      beam(B, f, [HB_TRUSS_T, top(s), s], [-HB_TRUSS_T, top(s2), s2], 0.45, COL.truss);
    }
    if (through(s)) beam(B, f, [-HB_TRUSS_T, top(s), s], [HB_TRUSS_T, top(s), s], 0.6, COL.truss);
    if (detail > 0.5) {
      beam(B, f, [-HB_TRUSS_T, bot(s), s], [HB_TRUSS_T, bot(s2), s2], 0.4, COL.truss);
      beam(B, f, [HB_TRUSS_T, bot(s), s], [-HB_TRUSS_T, bot(s2), s2], 0.4, COL.truss);
    }
  }

  // ── piers, caps, clip-on brackets; abutments ──
  for (const p of HB_PIERS) {
    const y1 = bot(p) - 2.4;
    const y0 = Math.min(-2, ground(p)) - 12;
    const fp = (w: number, d: number): [number, number][] => [[-w, 0], [w, 0], [w, 0], [-w, 0]].map(([t], i) => [t, i < 2 ? -d : d]) as [number, number][];
    // shaft: flared at the base (7.6 × 4.0 half-sizes) to the OSM footprint at the top (6.55 × 3.4)
    const base = fp(7.6, 4.0), head = fp(6.55, 3.4);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      face(B, f, [[base[i][0], y0, p + base[i][1]], [base[j][0], y0, p + base[j][1]], [head[j][0], y1, p + head[j][1]], [head[i][0], y1, p + head[i][1]]], [0, (y0 + y1) / 2, p], COL.concrete);
    }
    box(B, f, -8.6, 8.6, y1, bot(p) + 0.2, p - 4.2, p + 4.2, COL.cap);
    for (const sg of [-1, 1]) for (const ds of [-3, 3]) beam(B, f, [sg * 6.2, y1 + 0.6, p + ds], [sg * 12.8, hbDeck(p) - hbClipDepth(p) + 0.2, p + ds], 1.2, COL.cap);
  }
  box(B, f, -18, 18, Math.min(0, ground(HB_S_SOUTH)) - 3, hbDeck(HB_S_SOUTH) - 0.1, HB_S_SOUTH - 10, HB_S_SOUTH + 0.5, COL.concrete);
  box(B, f, -18, 18, ground(HB_S_NORTH) - 3, hbDeck(HB_S_NORTH) - 0.1, HB_S_NORTH - 0.5, HB_S_NORTH + 12, COL.concrete);

  // ── lamps, gantries, flags; night lights ──
  for (let s = HB_S_SOUTH + 12; s < HB_S_NORTH - 5; s += 33) {
    for (const sg of [-1, 1]) {
      const y = hbDeck(s);
      if (detail > 0.5) {
        beam(B, f, [sg * 17.9, y, s], [sg * 17.9, y + 11, s], 0.3, COL.steel);
        beam(B, f, [sg * 17.9, y + 11, s], [sg * 15.6, y + 11.4, s], 0.22, COL.steel);
      }
      const [x, z] = hbAt(s, sg * 15.4);
      lights.add(x, y + 11.1, z, 0xffb060, 5);
    }
  }
  for (const s of HB_GANTRIES) {
    const y = hbDeck(s);
    for (const t of [-17.9, 17.9]) beam(B, f, [t, y, s], [t, y + 8.6, s], 0.6, COL.steel);
    box(B, f, -17.9, 17.9, y + 8.2, y + 9.0, s - 0.6, s + 0.6, COL.steel);
    for (const sg of [-1, 1]) box(B, f, sg > 0 ? 9.5 : -16.5, sg > 0 ? 16.5 : -9.5, y + 5.6, y + 8.2, s - 0.25, s + 0.15, COL.sign);
  }
  for (const sg of [-1, 1]) {
    const s = HB_FLAGS.s, y = top(s);
    beam(B, f, [sg * HB_TRUSS_T, y, s], [sg * 8.5, HB_FLAGS.top, s], 0.25, COL.steel);
    box(B, f, sg > 0 ? 8.6 : -13.4, sg > 0 ? 13.4 : -8.6, HB_FLAGS.top - 3.2, HB_FLAGS.top - 0.6, s - 0.05, s + 0.05, COL.flag);
  }
  // aviation light on the crest, channel lights under the main span
  const sm = (HB_PIERS[4] + HB_PIERS[5]) / 2;
  {
    const [x, z] = hbAt(sm, 0);
    lights.add(x, top(sm) + 1.5, z, 0xff2a18, 4, 0.2);
    lights.add(x, bot(sm) - 1, z, 0x40ff70, 3.5);
  }
}
