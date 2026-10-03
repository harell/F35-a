/**
 * Spark Arena: the hand-built landmark east of the CBD (shape data in core/sparkArena.ts, from the
 * LINZ LiDAR and aerial photo; facade from photos of the west plaza on Mahuhu Crescent).
 *
 *  - Roof: the two lens-shaped planes in light silver standing-seam metal (WIN_RIBS), their charcoal
 *    fascia with a white upturned rim, charcoal undersides where the tips cantilever past the drum
 *    wall, and the white walkway roof between and round them.
 *  - Drum wall (from Mapillary street imagery, CC BY-SA 4.0): a light base, terracotta and red-brown precast bands with a
 *    ribbon of blue windows at 8–10 m on the north and east, a pale band from 14 m up to the dark
 *    roof soffit; set back under the roof (most under the west tips, which white tubular struts
 *    carry from the drum at 18–24 m).
 *  - West foyer, in layers: recessed dark glass entrances under a white-soffit canopy (0–5 m), a
 *    curtain-wall band of blue glass on a mullion grid bulging slightly outward (5–16 m, WIN_LOBBY:
 *    lit warm and purple from inside at night), and white panels above.
 *  - The low south-west wing with its glazed ridge, and the plant deck on the east.
 *
 * Everything but the signs goes into the merged CBD mesh (no draw call of its own); the three
 * "Spark ARENA" signs (west foyer, north wall, north-west wall) are one small mesh with a canvas
 * texture (createSignMaterial): cream letters by day, purple LED at night, the white starburst.
 */
import { BufferAttribute, BufferGeometry, CanvasTexture, ShapeUtils, Vector2 } from 'three';
import {
  ARENA_LENSES,
  SPARK_ARENA,
  SPARK_ARENA_FOYER,
  SPARK_ARENA_PLANT,
  SPARK_ARENA_WING,
  inRing,
  lensHalfWidth,
  lensHeight,
  lensPoint,
  runsToRing,
  sparkArenaRoof,
  sparkArenaRuns,
  walkwayHeight,
  type ArenaBlock,
  type ArenaLens,
  type ArenaRun,
} from '../../core/sparkArena';
import { mulberry32 } from '../../core/math';
import { GeometryBuilder, IDENT_FRAME, WIN_LOBBY, WIN_NONE, WIN_RIBS, type Frame } from './GeometryBuilder';
import type { HeightFn, LightList } from './builders';

const COL = {
  roof: 0xcdd1d4, // light silver standing seam
  fascia: 0x2a2d31, // charcoal lens edges and undersides
  rim: 0xeceae4, // white upturned rim
  walkway: 0xe6e4de,
  base: 0xdedcd6, // white / light-grey base of the drum (0–3 m)
  terracotta: 0xc98a6b, // precast bands
  redBrown: 0x9a5a48,
  ribbon: 0x5a7f9c, // blue-tinted window ribbon (8–10 m, north and east)
  pale: 0xe6e6e2, // pale grey band up to the roof
  panel: 0xe2e3e0, // the foyer drum's white panels above the glass
  curtain: 0x5a8db5, // blue-tinted curtain wall
  entrance: 0x2a343b, // recessed dark glass
  soffit: 0xeeece6,
  canopyTop: 0x9a9fa3,
  strut: 0xf2f2ee,
  plant: 0xa7aaa8,
  plantTop: 0x8f9496,
} as const;

/** Roof thickness: the underside of a lens or the walkway sits this far under its top (m). */
const ROOF_DEPTH = 0.8;
/** How far the drum wall is set back under the roof's edge (m), and more under the lens tips. */
const SETBACK = 0.8;
const TIP_SETBACK = { west: 9, east: 4, reach: 25 } as const;

const X = SPARK_ARENA.x;
const Z = SPARK_ARENA.z;

/** Ground (world y) the arena's heights are measured from: the terrain at its centre. */
export function sparkArenaGround(height: HeightFn): number {
  return height(X, Z);
}

/**
 * Triangle or quad (world points, flat xyz) turned to face the direction (ox, oy, oz).
 */
function face(B: GeometryBuilder, p: number[], color: number, win: number, ox: number, oy: number, oz: number): void {
  const n = p.length / 3;
  const ax = p[3] - p[0], ay = p[4] - p[1], az = p[5] - p[2];
  const bx = p[(n - 1) * 3] - p[0], by = p[(n - 1) * 3 + 1] - p[1], bz = p[(n - 1) * 3 + 2] - p[2];
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  let q = p;
  if (nx * ox + ny * oy + nz * oz < 0) {
    q = [];
    for (let i = n - 1; i >= 0; i--) q.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
  }
  if (n === 4) B.quad(IDENT_FRAME, q, color, win);
  else B.tri(IDENT_FRAME, q, color, win);
}

/** Cosine-spaced stations along a lens (as lensArc's), m from its middle. */
function stations(l: ArenaLens, segs: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= segs; i++) out.push(-l.half * Math.cos((Math.PI * i) / segs));
  return out;
}

/** One lens: silver top, charcoal underside, charcoal fascia with a white rim; walkway heights on its edges. */
function buildLens(B: GeometryBuilder, l: ArenaLens, g: number, segs: number, detail: number): void {
  const st = stations(l, segs);
  const P = (s: number, side: number) => {
    const [x, z] = lensPoint(l, s, side * lensHalfWidth(l, s));
    return [X + x, g + lensHeight(l, x, z), Z + z];
  };
  const down = (p: number[], d: number) => [p[0], p[1] - d, p[2]];
  for (let i = 0; i < segs; i++) {
    const a = P(st[i], -1), b = P(st[i + 1], -1), c = P(st[i + 1], 1), d = P(st[i], 1);
    for (const under of [false, true]) {
      const off = under ? ROOF_DEPTH : 0;
      const col = under ? COL.fascia : COL.roof;
      const win = under ? WIN_NONE : WIN_RIBS;
      const oy = under ? -1 : 1;
      if (i === 0) face(B, [...down(a, off), ...down(b, off), ...down(c, off)], col, win, 0, oy, 0);
      else if (i === segs - 1) face(B, [...down(a, off), ...down(b, off), ...down(d, off)], col, win, 0, oy, 0);
      else face(B, [...down(a, off), ...down(b, off), ...down(c, off), ...down(d, off)], col, win, 0, oy, 0);
    }
  }
  // edge: charcoal fascia (down to the walkway on the inner side), white rim on top
  const mx = X + l.mx;
  const mz = Z + l.mz;
  for (const side of [-1, 1]) {
    const inner = side !== l.def.outer;
    for (let i = 0; i < segs; i++) {
      const p = P(st[i], side);
      const q = P(st[i + 1], side);
      const ox = (p[0] + q[0]) / 2 - mx;
      const oz = (p[2] + q[2]) / 2 - mz;
      const lowP = inner ? Math.min(p[1] - ROOF_DEPTH, edgeWalk(l, p) - 0.1) : p[1] - ROOF_DEPTH;
      const lowQ = inner ? Math.min(q[1] - ROOF_DEPTH, edgeWalk(l, q) - 0.1) : q[1] - ROOF_DEPTH;
      const rim = 0.6;
      face(B, [p[0], lowP, p[2], q[0], lowQ, q[2], q[0], q[1] + rim, q[2], p[0], p[1] + rim, p[2]], COL.fascia, WIN_NONE, ox, 0, oz);
      // the rim's top and inner face, 0.5 m in from the edge
      const ip = inward(p, mx, mz, 0.5);
      const iq = inward(q, mx, mz, 0.5);
      face(B, [p[0], p[1] + rim, p[2], q[0], q[1] + rim, q[2], iq[0], iq[1] + rim, iq[2], ip[0], ip[1] + rim, ip[2]], COL.rim, WIN_NONE, 0, 1, 0);
      if (detail >= 0.7) face(B, [ip[0], ip[1], ip[2], iq[0], iq[1], iq[2], iq[0], iq[1] + rim, iq[2], ip[0], ip[1] + rim, ip[2]], COL.rim, WIN_NONE, -ox, 0, -oz);
    }
  }
}

/** A lens edge point moved `d` m toward the lens's middle (same height). */
function inward(p: number[], mx: number, mz: number, d: number): number[] {
  const dx = mx - p[0];
  const dz = mz - p[2];
  const l = Math.hypot(dx, dz) || 1;
  return [p[0] + (dx / l) * d, p[1], p[2] + (dz / l) * d];
}

/** Walkway height (world y) on a lens's inner edge: under the lens's fascia. */
function edgeWalk(l: ArenaLens, p: number[]): number {
  const dx = p[0] - X;
  const dz = p[2] - Z;
  const g = p[1] - lensHeight(l, dx, dz);
  return g + Math.min(walkwayHeight(dx, dz), lensHeight(l, dx, dz) - ROOF_DEPTH - 0.1);
}

/** The walkway roof (offsets polygon between the lenses and the east wall / foyer edges). */
function buildWalkway(B: GeometryBuilder, runs: readonly ArenaRun[], g: number, segs: number): void {
  const [N, S] = ARENA_LENSES;
  const ring: number[] = [];
  const h: number[] = [];
  const edge: boolean[] = []; // the edge from this vertex to the next is the building's outside
  const push = (pts: number[], height: (x: number, z: number) => number, outside: boolean, skipLast = true) => {
    for (let i = 0; i < pts.length - (skipLast ? 2 : 0); i += 2) {
      ring.push(pts[i], pts[i + 1]);
      h.push(height(pts[i], pts[i + 1]));
      edge.push(outside);
    }
  };
  const lensEdge = (l: ArenaLens) => (x: number, z: number) => Math.min(walkwayHeight(x, z), lensHeight(l, x, z) - ROOF_DEPTH - 0.1);
  const east = runs.find((r) => r.kind === 'east')!.pts;
  const foyer = runs.find((r) => r.kind === 'foyer')!.pts;
  const arc = (l: ArenaLens, reverse: boolean) => {
    const st = stations(l, segs);
    const pts: number[] = [];
    for (const s of reverse ? [...st].reverse() : st) pts.push(...lensPoint(l, s, -l.def.outer * lensHalfWidth(l, s)));
    return pts;
  };
  push(east, walkwayHeight, true);
  push(arc(S, true), lensEdge(S), false);
  push(foyer, walkwayHeight, true);
  push(arc(N, false), lensEdge(N), false);
  const n = ring.length / 2;
  const pts: Vector2[] = [];
  for (let i = 0; i < n; i++) pts.push(new Vector2(ring[i * 2], ring[i * 2 + 1]));
  const V = (k: number, off = 0) => [X + ring[k * 2], g + h[k] - off, Z + ring[k * 2 + 1]];
  for (const [a, b, c] of ShapeUtils.triangulateShape(pts, [])) {
    face(B, [...V(a), ...V(b), ...V(c)], COL.walkway, WIN_NONE, 0, 1, 0);
    face(B, [...V(a, ROOF_DEPTH), ...V(b, ROOF_DEPTH), ...V(c, ROOF_DEPTH)], COL.fascia, WIN_NONE, 0, -1, 0);
  }
  // fascia along the outside edges (east wall and foyer)
  for (let i = 0; i < n; i++) {
    if (!edge[i]) continue;
    const j = (i + 1) % n;
    const [ox, oz] = outwardOf(ring, i, j);
    const p = V(i);
    const q = V(j);
    face(B, [p[0], p[1] - ROOF_DEPTH, p[2], q[0], q[1] - ROOF_DEPTH, q[2], q[0], q[1] + 0.3, q[2], p[0], p[1] + 0.3, p[2]], COL.fascia, WIN_NONE, ox, 0, oz);
  }
}

/** Outward horizontal normal of the ring's edge i → j (offsets ring). */
function outwardOf(ring: ArrayLike<number>, i: number, j: number): [number, number] {
  const dx = ring[j * 2] - ring[i * 2];
  const dz = ring[j * 2 + 1] - ring[i * 2 + 1];
  const l = Math.hypot(dx, dz) || 1;
  let nx = dz / l;
  let nz = -dx / l;
  const mx = (ring[i * 2] + ring[j * 2]) / 2;
  const mz = (ring[i * 2 + 1] + ring[j * 2 + 1]) / 2;
  if (inRing(ring, mx + nx * 0.3, mz + nz * 0.3)) {
    nx = -nx;
    nz = -nz;
  }
  return [nx, nz];
}

interface DrumPoint {
  x: number;
  z: number;
  kind: ArenaRun['kind'];
  /** Outward horizontal normal (per vertex). */
  nx: number;
  nz: number;
  /** Distance along the drum from its start (m). */
  along: number;
}

/**
 * The drum wall's line: the perimeter set back under the roof, by SETBACK and, near the lens tips, by
 * up to TIP_SETBACK (the cantilevered tips). One point per perimeter vertex, in ring order.
 */
function drumLine(runs: readonly ArenaRun[]): DrumPoint[] {
  const ring = runsToRing(runs);
  const kinds: ArenaRun['kind'][] = [];
  const tipAt: { i: number; extra: number }[] = [];
  for (const r of runs) {
    // a run starts at a tip: north at the north lens's west tip, east at its east tip, south at the
    // south lens's east tip, foyer at the south lens's west tip
    tipAt.push({ i: kinds.length, extra: r.kind === 'north' || r.kind === 'foyer' ? TIP_SETBACK.west : TIP_SETBACK.east });
    for (let i = 0; i < r.pts.length - 2; i += 2) kinds.push(r.kind);
  }
  const n = ring.length / 2;
  const cum: number[] = [0];
  for (let i = 1; i <= n; i++) cum.push(cum[i - 1] + Math.hypot(ring[(i % n) * 2] - ring[(i - 1) * 2], ring[(i % n) * 2 + 1] - ring[(i - 1) * 2 + 1]));
  const total = cum[n];
  const out: DrumPoint[] = [];
  for (let i = 0; i < n; i++) {
    let set = SETBACK;
    for (const t of tipAt) {
      const d0 = Math.abs(cum[i] - cum[t.i]);
      const d = Math.min(d0, total - d0);
      const f = Math.max(0, 1 - d / TIP_SETBACK.reach);
      set = Math.max(set, SETBACK + t.extra * f * f);
    }
    const x = ring[i * 2];
    const z = ring[i * 2 + 1];
    const l = Math.hypot(x, z) || 1;
    out.push({ x: x - (x / l) * set, z: z - (z / l) * set, kind: kinds[i], nx: 0, nz: 0, along: 0 });
  }
  // per-vertex outward normals and lengths along the drum line
  const dring: number[] = [];
  for (const p of out) dring.push(p.x, p.z);
  for (let i = 0; i < n; i++) {
    const [ax, az] = outwardOf(dring, (i - 1 + n) % n, i);
    const [bx, bz] = outwardOf(dring, i, (i + 1) % n);
    const l = Math.hypot(ax + bx, az + bz) || 1;
    out[i].nx = (ax + bx) / l;
    out[i].nz = (az + bz) / l;
    if (i) out[i].along = out[i - 1].along + Math.hypot(out[i].x - out[i - 1].x, out[i].z - out[i - 1].z);
  }
  return out;
}

/** Roof underside (world y) over a drum point. */
function underRoof(g: number, x: number, z: number): number {
  const r = sparkArenaRoof(x, z);
  return g + (r > 0 ? r : walkwayHeight(x, z)) - ROOF_DEPTH;
}

/**
 * Horizontal bands of the drum (m above the ground, colour, window style; each up to the next one's
 * start, the last up to the roof), from Mapillary street imagery: a light base, terracotta and red-brown precast
 * bands with a window ribbon at 8–10 m on the north and east, a pale band from 14 m. The low tier
 * keeps the base, one terracotta band and the pale one.
 */
function drumBands(ribbon: boolean, detail: number): [number, number, number][] {
  const mid: [number, number, number][] =
    detail >= 0.7
      ? [[3, COL.terracotta, WIN_NONE], [5, COL.redBrown, WIN_NONE], [7, COL.terracotta, WIN_NONE], [8, ribbon ? COL.ribbon : COL.redBrown, ribbon ? WIN_LOBBY : WIN_NONE], [10, COL.terracotta, WIN_NONE], [12, COL.redBrown, WIN_NONE]]
      : ribbon
        ? [[3, COL.terracotta, WIN_NONE], [8, COL.ribbon, WIN_LOBBY], [10, COL.terracotta, WIN_NONE]]
        : [[3, COL.terracotta, WIN_NONE]];
  return [[-50, COL.base, WIN_NONE], ...mid, [14, COL.pale, WIN_NONE]];
}

/** The drum wall: banded precast panels, and the layered foyer on the west. */
function buildDrum(B: GeometryBuilder, lights: LightList | null, drum: readonly DrumPoint[], g: number, height: HeightFn, detail: number): void {
  const F = SPARK_ARENA_FOYER;
  const n = drum.length;
  const W = (p: DrumPoint, off: number) => [X + p.x + p.nx * off, Z + p.z + p.nz * off] as const;
  for (let i = 0; i < n; i++) {
    const p = drum[i];
    const q = drum[(i + 1) % n];
    const [px, pz] = W(p, 0);
    const [qx, qz] = W(q, 0);
    const ox = p.nx + q.nx;
    const oz = p.nz + q.nz;
    const topP = underRoof(g, p.x, p.z);
    const topQ = underRoof(g, q.x, q.z);
    const botP = height(px, pz) - 1.5;
    const botQ = height(qx, qz) - 1.5;
    const wall = (y0p: number, y0q: number, y1p: number, y1q: number, offP: number, offQ: number, offP1: number, offQ1: number, color: number, win: number) => {
      const [ax, az] = W(p, offP);
      const [bx, bz] = W(q, offQ);
      const [cx, cz] = W(q, offQ1);
      const [dx, dz] = W(p, offP1);
      face(B, [ax, y0p, az, bx, y0q, bz, cx, y1q, cz, dx, y1p, dz], color, win, ox, 0, oz);
    };
    const foyer = p.kind === 'foyer' && (q.kind === 'foyer' || i === n - 1);
    if (!foyer) {
      // (the window ribbon runs round the north and east, not on the south-facing wall)
      const bands = drumBands((p.kind === 'north' || p.kind === 'east') && p.nz < 0.3, detail);
      for (let b = 0; b < bands.length; b++) {
        const lo = g + bands[b][0];
        const hi = b + 1 < bands.length ? g + bands[b + 1][0] : Infinity;
        const y0p = Math.min(Math.max(lo, botP), topP);
        const y0q = Math.min(Math.max(lo, botQ), topQ);
        const y1p = Math.min(hi, topP);
        const y1q = Math.min(hi, topQ);
        if (y1p - y0p < 0.01 && y1q - y0q < 0.01) continue;
        wall(y0p, y0q, Math.max(y0p, y1p), Math.max(y0q, y1q), 0, 0, 0, 0, bands[b][1], bands[b][2]);
      }
      continue;
    }
    const y5 = g + F.canopy;
    const y6 = y5 + F.canopyThick;
    const mid = (y6 + g + F.glassTop) / 2;
    const yTop = g + F.glassTop;
    // recessed entrances under the canopy
    wall(botP, botQ, y5, y5, -F.recess, -F.recess, -F.recess, -F.recess, COL.entrance, WIN_LOBBY);
    // canopy: white soffit, grey top, white front edge
    {
      const [ax, az] = W(p, -F.recess);
      const [bx, bz] = W(q, -F.recess);
      const [cx, cz] = W(q, F.overhang);
      const [dx, dz] = W(p, F.overhang);
      face(B, [ax, y5, az, bx, y5, bz, cx, y5, cz, dx, y5, dz], COL.soffit, WIN_NONE, 0, -1, 0);
      face(B, [ax, y6, az, bx, y6, bz, cx, y6, cz, dx, y6, dz], COL.canopyTop, WIN_NONE, 0, 1, 0);
      wall(y5, y5, y6, y6, F.overhang, F.overhang, F.overhang, F.overhang, COL.soffit, WIN_NONE);
    }
    // curtain wall, bulging outward at mid-height
    wall(y6, y6, mid, mid, 0, 0, F.bulge, F.bulge, COL.curtain, WIN_LOBBY);
    wall(mid, mid, yTop, yTop, F.bulge, F.bulge, 0, 0, COL.curtain, WIN_LOBBY);
    // the drum above: white panels
    wall(yTop, yTop, topP, topQ, 0, 0, 0, 0, COL.panel, WIN_NONE);
    // canopy downlights and the lit lobby behind the glass
    if (lights && i % 2 === 0) {
      const [lx, lz] = W(p, 0.8);
      lights.add(lx, y5 - 0.4, lz, 0xfff1d6, 1.4);
      if (i % 4 === 0) {
        const [ix, iz] = W(p, -1.5);
        lights.add(ix, g + 10.5, iz, i % 8 === 0 ? 0xa65cff : 0xffd9a8, 2.2);
      }
    }
  }
  // close the recess at both ends of the foyer
  for (let i = 0; i < n; i++) {
    const p = drum[i];
    const prev = drum[(i - 1 + n) % n];
    const next = drum[(i + 1) % n];
    const start = p.kind === 'foyer' && prev.kind !== 'foyer';
    const end = p.kind !== 'foyer' && prev.kind === 'foyer';
    if (!start && !end) continue;
    const [ax, az] = W(p, 0);
    const [bx, bz] = W(p, -F.recess);
    const away = start ? prev : next;
    const ox = X + away.x - ax;
    const oz = Z + away.z - az;
    const bot = height(ax, az) - 1.5;
    face(B, [ax, bot, az, bx, bot, bz, bx, g + F.canopy, bz, ax, g + F.canopy, az], COL.base, WIN_NONE, ox, 0, oz);
  }
}

/**
 * The white tubular struts under each west lens tip: they fan from the tip's underside down to the
 * drum wall at 18–24 m, from just south of the tip round to its outer arc.
 */
function buildStruts(B: GeometryBuilder, drum: readonly DrumPoint[], g: number): void {
  for (const l of ARENA_LENSES) {
    const [tx, tz] = l.def.a;
    // the drum points nearest the tip, ±14 m along the drum
    let k = 0;
    let best = Infinity;
    drum.forEach((p, i) => {
      const d = Math.hypot(p.x - tx, p.z - tz);
      if (d < best) {
        best = d;
        k = i;
      }
    });
    const total = drum[drum.length - 1].along;
    const at = (along: number) => {
      let a = ((along % total) + total) % total;
      let i = 0;
      while (i < drum.length - 1 && drum[i + 1].along < a) i++;
      const p = drum[i];
      const q = drum[(i + 1) % drum.length];
      const seg = Math.max(1e-6, (i + 1 < drum.length ? q.along : total) - p.along);
      a = Math.min(1, Math.max(0, (a - p.along) / seg));
      return [p.x + (q.x - p.x) * a + p.nx * 0.3, p.z + (q.z - p.z) * a + p.nz * 0.3];
    };
    const count = 6;
    for (let i = 0; i < count; i++) {
      const u = i / (count - 1);
      const [ax, az] = lensPoint(l, -l.half + 2 + u * 9, 0);
      const ay = g + lensHeight(l, ax, az) - ROOF_DEPTH - 0.2;
      // (mostly onto the north wall, clear of the sign over the foyer)
      const [dx, dz] = at(drum[k].along - 6 + u * 24);
      const dy = g + 18 + 6 * (1 - Math.abs(u - 0.5) * 2);
      B.beam(IDENT_FRAME, X + ax, ay, Z + az, X + dx, dy, Z + dz, 0.6, COL.strut);
    }
  }
}

function blockFrame(b: ArenaBlock): Frame {
  return { ox: X + b.x, oy: 0, oz: Z + b.z, c: Math.cos(b.rot), s: Math.sin(b.rot) };
}

/**
 * Spark Arena into the merged CBD mesh (`B`), its fixtures into `lights` (null: no night lights).
 * `detail` = the tier's sceneryDensity: the low tier halves the arcs and drops the rims' inner faces
 * and the plant deck's units.
 */
export function buildSparkArena(B: GeometryBuilder, lights: LightList | null, height: HeightFn, detail: number): void {
  const g = sparkArenaGround(height);
  const segs = detail >= 0.7 ? 40 : 20;
  const runs = sparkArenaRuns(segs, detail >= 0.7 ? 24 : 12);
  for (const l of ARENA_LENSES) buildLens(B, l, g, segs, detail);
  buildWalkway(B, runs, g, segs);
  const drum = drumLine(runs);
  buildDrum(B, lights, drum, g, height, detail);
  buildStruts(B, drum, g);
  // the south-west wing (glazed ridge) and the plant deck
  const wing = SPARK_ARENA_WING;
  const wf = blockFrame(wing);
  const wb = height(wf.ox, wf.oz) - 2;
  B.box(wf, 0, wb, 0, wing.w, g + wing.h - wb, wing.d, COL.panel, COL.walkway);
  B.box(wf, 0, g + wing.h, 0, wing.w - 4, 0.7, 3.5, COL.curtain, COL.curtain, WIN_LOBBY);
  const plant = SPARK_ARENA_PLANT;
  const pf = blockFrame(plant);
  const pb = height(pf.ox, pf.oz) - 2;
  B.box(pf, 0, pb, 0, plant.w, g + plant.h - pb, plant.d, COL.plant, COL.plantTop);
  if (detail >= 0.7) {
    const rnd = mulberry32(2007);
    for (let i = 0; i < 6; i++) B.box(pf, -3 + (i % 2) * 6, g + plant.h, -10 + Math.floor(i / 2) * 9, 3.5, 1.4 + rnd() * 0.6, 4, 0xc7cacb, 0xb0b4b6);
  }
  // the north sign's starburst stands on its own pole, left of the letters
  {
    const at = signStrip(drum, SPARK_ARENA_SIGNS[1], g);
    const m = at.point(0.06, 1.6);
    B.beam(IDENT_FRAME, m.x, height(m.x, m.z) - 1, m.z, m.x, at.bottom + at.height * 0.5, m.z, 0.35, COL.strut);
  }
  if (lights) {
    lights.add(X + 66, g + 6, Z - 6, 0xffc070, 2.2);
    lights.add(X + 50, g + 6, Z + 30, 0xffc070, 2.2);
  }
}

/* ───────────────────────────── Sign ───────────────────────────── */

export interface ArenaSignDef {
  /** The drum run it hangs on, and its middle's position along that run (fraction, in drum order). */
  run: ArenaRun['kind'];
  at: number;
  /** Width (m; the height follows the texture's aspect) and the height of its top, under the roof. */
  width: number;
  top: number;
}

/** The texture's width : height. */
export const SPARK_ARENA_SIGN_ASPECT = 24 / 4.15;

/**
 * The three "Spark ARENA" signs (Mapillary street imagery): over the west foyer glass facing the plaza, on the
 * north wall facing the railway and the motorway (west of the middle of the north arc, the starburst
 * on its own pole), and on the north-west wall above the elevated walkway.
 */
export const SPARK_ARENA_SIGNS: readonly ArenaSignDef[] = [
  { run: 'foyer', at: 0.5, width: 24, top: 21.35 },
  { run: 'north', at: 0.42, width: 26, top: 15.5 },
  { run: 'north', at: 0.14, width: 22, top: 12 },
];

/** Where a sign sits: point(u, out) on its strip (u = 0 at the text's start, `out` m proud of the drum). */
function signStrip(drumAll: readonly DrumPoint[], def: ArenaSignDef, g: number) {
  const drum = drumAll.filter((p) => p.kind === def.run);
  const len: number[] = [0];
  for (let i = 1; i < drum.length; i++) len.push(len[i - 1] + Math.hypot(drum[i].x - drum[i - 1].x, drum[i].z - drum[i - 1].z));
  const centre = len[len.length - 1] * def.at;
  const at = (d: number) => {
    let i = 0;
    while (i < drum.length - 2 && len[i + 1] < d) i++;
    const f = Math.min(1, Math.max(0, (d - len[i]) / (len[i + 1] - len[i] || 1)));
    const p = drum[i];
    const q = drum[i + 1];
    const nx = p.nx + (q.nx - p.nx) * f;
    const nz = p.nz + (q.nz - p.nz) * f;
    const nl = Math.hypot(nx, nz) || 1;
    return { x: p.x + (q.x - p.x) * f, z: p.z + (q.z - p.z) * f, nx: nx / nl, nz: nz / nl, tx: q.x - p.x, tz: q.z - p.z };
  };
  // read left to right from outside: the viewer's right is (nz, −nx); the text runs that way
  const c = at(centre);
  const dir = c.tx * c.nz - c.tz * c.nx >= 0 ? 1 : -1;
  const height = def.width / SPARK_ARENA_SIGN_ASPECT;
  // (clear of the roof's underside over it)
  const top = Math.min(g + def.top, underRoof(g, c.x, c.z) - 0.4);
  return {
    bottom: top - height,
    height,
    point(u: number, out: number) {
      const p = at(centre + dir * (u - 0.5) * def.width);
      return { x: X + p.x + p.nx * out, z: Z + p.z + p.nz * out, nx: p.nx, nz: p.nz };
    },
  };
}

/**
 * The "Spark ARENA" sign's canvas: the text in the red channel, the starburst in the green one
 * (createSignMaterial colours them: cream letters by day, purple LED at night, a white mark).
 */
export function drawSparkArenaSign(canvas: HTMLCanvasElement): void {
  const w = canvas.width;
  const h = canvas.height;
  const c = canvas.getContext('2d')!;
  c.clearRect(0, 0, w, h);
  // the starburst: radiating scribbled strokes
  const sx = h * 0.55;
  const sy = h * 0.5;
  const rnd = mulberry32(2007);
  c.strokeStyle = '#00ff00';
  c.lineCap = 'round';
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2 + (rnd() - 0.5) * 0.35;
    const r0 = h * (0.02 + rnd() * 0.08);
    const r1 = h * (0.3 + rnd() * 0.17);
    c.lineWidth = h * (0.025 + rnd() * 0.025);
    c.beginPath();
    c.moveTo(sx + Math.cos(a) * r0, sy + Math.sin(a) * r0);
    c.lineTo(sx + Math.cos(a + (rnd() - 0.5) * 0.15) * r1, sy + Math.sin(a + (rnd() - 0.5) * 0.15) * r1);
    c.stroke();
  }
  // the name: "Spark" and "ARENA", condensed to fit right of the mark
  c.fillStyle = '#ff0000';
  c.textBaseline = 'middle';
  const size = Math.round(h * 0.85);
  c.font = `bold ${size}px "Helvetica Neue", Arial, sans-serif`;
  const text = 'Spark ARENA';
  const x0 = h * 1.2;
  const room = w - x0 - h * 0.1;
  const tw = c.measureText(text).width;
  c.save();
  c.translate(x0, h * 0.54);
  c.scale(Math.min(1, room / tw), 1);
  c.fillText(text, 0, 0);
  c.restore();
}

/**
 * The signs' geometry (world coordinates, uv, normals), one merged mesh: strips following the curved
 * drum 0.35 m proud of it, facing out. The texture is drawn by the caller (drawSparkArenaSign on a
 * canvas), so this stays testable without a DOM.
 */
export function buildSparkArenaSignGeometry(height: HeightFn): BufferGeometry {
  const g = sparkArenaGround(height);
  const drum = drumLine(sparkArenaRuns(40, 24));
  const K = 10;
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (const def of SPARK_ARENA_SIGNS) {
    const strip = signStrip(drum, def, g);
    const v0 = pos.length / 3;
    for (let i = 0; i <= K; i++) {
      const u = i / K;
      const p = strip.point(u, 0.35);
      pos.push(p.x, strip.bottom, p.z, p.x, strip.bottom + strip.height, p.z);
      nrm.push(p.nx, 0, p.nz, p.nx, 0, p.nz);
      uv.push(u, 0, u, 1);
      if (!i) continue;
      const a = v0 + (i - 1) * 2;
      // facing out: the quad's normal (b − a) × (c − a) along +n, with u running to the viewer's right
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

/** The sign's canvas texture (browser only). */
export function createSparkArenaSignTexture(anisotropy: number): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = Math.round(1024 / SPARK_ARENA_SIGN_ASPECT);
  drawSparkArenaSign(canvas);
  const tex = new CanvasTexture(canvas);
  tex.anisotropy = anisotropy;
  return tex;
}
