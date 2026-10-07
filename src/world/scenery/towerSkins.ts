/**
 * The CBD tower kit's skins (core/cbdTowerSkins.ts) in the scenery: walls painted by zone (by face and height, split
 * where a zone starts or ends, so the facade shaders' world-anchored patterns run on across the joins), bracing as
 * beams on the outermost wall of each face (and so are drawn lines: the Pacifica's white twist), and the crown signs as
 * one small mesh with the logo atlas (towerLogos.ts, createLogoMaterial). Built from the same terraces the sim collides with.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import type { SkinFinish, SkinZone, TowerSkin } from '../../core/cbdTowerSkins';
import { logoSlot } from './towerLogos';
import { GeometryBuilder, IDENT_FRAME, WIN_BANDS, WIN_CURTAIN, WIN_EMPTY, WIN_FLOOD, WIN_GLOW, WIN_HERITAGE, WIN_NONE, WIN_OFFICE } from './GeometryBuilder';

const FINISH_WIN: Record<SkinFinish, number> = { glass: WIN_CURTAIN, bands: WIN_BANDS, punched: WIN_OFFICE, plain: WIN_FLOOD, glow: WIN_GLOW, none: WIN_NONE, stone: WIN_HERITAGE, dark: WIN_EMPTY };

export function finishWin(f: SkinFinish): number {
  return FINISH_WIN[f];
}

const RAD = Math.PI / 180;

/** The box face (0–3) whose outside heading is nearest `heading` (deg). */
function faceOf(skin: TowerSkin, heading: number): number {
  const d = (((heading - skin.box.face) % 360) + 360) % 360;
  return Math.round(d / 90) % 4;
}

/** Outward normal (x, z) and the viewer's right (x, z) of box face k. */
function faceAxes(skin: TowerSkin, k: number): { nx: number; nz: number; rx: number; rz: number } {
  const a = (skin.box.face + 90 * k) * RAD;
  const nx = Math.sin(a);
  const nz = -Math.cos(a);
  return { nx, nz, rx: nz, rz: -nx };
}

/** A part of the tower as the skin sees it: its ring and the world height of its roof. */
export interface SkinPart {
  ring: ArrayLike<number>;
  top: number;
}

/**
 * The walls of one terrace, painted by the skin's zones (`base` where no zone applies), from y0 up to `roof`. Walls
 * above `crownFrom` (a crown terrace over the shaft) take `crown` instead. `g` is the tower's ground (world y).
 */
export function paintedWalls(
  B: GeometryBuilder,
  skin: TowerSkin,
  ring: ArrayLike<number>,
  y0: number,
  roof: (x: number, z: number) => number,
  g: number,
  base: { colour: number; win: number },
  crown: { from: number; colour: number; win: number } | null = null,
): void {
  const n = ring.length / 2;
  if (n < 3) return;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
  const cx = skin.box.x;
  const cz = skin.box.z;
  const yOf = (h: number) => g + h + skin.dy;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [a, b] = area > 0 ? [j, i] : [i, j];
    const ax = ring[a * 2], az = ring[a * 2 + 1], bx = ring[b * 2], bz = ring[b * 2 + 1];
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    // the quad's outward normal is (−dz, dx) (GeometryBuilder.prism's winding)
    const k = faceOf(skin, Math.atan2(-dz, -dx) / RAD);
    const ax_ = faceAxes(skin, k);
    const ta = (ax - cx) * ax_.rx + (az - cz) * ax_.rz;
    const tb = (bx - cx) * ax_.rx + (bz - cz) * ax_.rz;
    const zones = skin.zones.filter((z) => z.face === undefined || faceOf(skin, z.face) === k);
    const topA = roof(ax, az);
    const topB = roof(bx, bz);
    // breaks along the edge (fractions) where a zone's side falls, and up it where a zone starts or ends
    const ss = new Set<number>([0, 1]);
    if (Math.abs(tb - ta) > 1e-6) {
      for (const z of zones) {
        if (!z.t) continue;
        for (const t of z.t) {
          const s = (t - ta) / (tb - ta);
          if (s > 1e-4 && s < 1 - 1e-4) ss.add(s);
        }
      }
    }
    const sl = [...ss].sort((p, q) => p - q);
    const yTop = Math.max(topA, topB);
    const ys = new Set<number>([y0]);
    for (const z of zones)
      for (const h of z.h) {
        // (a zone from 0 reaches down to the walls' foot: the mesh's ground and the kit's differ by dy)
        const y = h <= 0 ? -Infinity : yOf(h);
        if (y > y0 + 1e-3 && y < yTop - 1e-3) ys.add(y);
      }
    if (crown && crown.from > y0 && crown.from < yTop) ys.add(crown.from);
    const yl = [...ys].sort((p, q) => p - q);
    for (let si = 0; si + 1 < sl.length; si++) {
      const s0 = sl[si], s1 = sl[si + 1];
      const p0x = ax + dx * s0, p0z = az + dz * s0, p1x = ax + dx * s1, p1z = az + dz * s1;
      const t0 = topA + (topB - topA) * s0, t1 = topA + (topB - topA) * s1;
      const tm = ta + (tb - ta) * ((s0 + s1) / 2);
      for (let yi = 0; yi < yl.length; yi++) {
        const lo = yl[yi];
        const hi = yi + 1 < yl.length ? yl[yi + 1] : Infinity;
        const h0 = Math.min(hi, t0), h1 = Math.min(hi, t1);
        if (h0 <= lo + 1e-3 && h1 <= lo + 1e-3) continue;
        const ym = (lo + Math.min(hi, Math.max(t0, t1))) / 2;
        let colour = base.colour;
        let win = base.win;
        if (crown && ym > crown.from) {
          colour = crown.colour;
          win = crown.win;
        } else {
          const z = zoneAt(zones, tm, ym - g - skin.dy);
          if (z) {
            colour = z.colour;
            win = FINISH_WIN[z.finish];
          }
        }
        B.quad(IDENT_FRAME, [p0x, lo, p0z, p1x, lo, p1z, p1x, Math.max(lo, h1), p1z, p0x, Math.max(lo, h0), p0z], colour, win);
      }
    }
  }
}

/** The last zone holding (t, h) (h in mesh m). */
function zoneAt(zones: readonly SkinZone[], t: number, h: number): SkinZone | null {
  for (let i = zones.length - 1; i >= 0; i--) {
    const z = zones[i];
    if ((z.h[0] > 0 && h < z.h[0]) || h > z.h[1]) continue;
    if (z.t && (t < z.t[0] || t > z.t[1])) continue;
    return z;
  }
  return null;
}

/**
 * How far out (m from the box's centre, along face k's normal) the tower's outermost wall stands at `t` across the
 * face, among the parts whose roof is at least `y` (null: no wall there).
 */
export function outerWall(skin: TowerSkin, parts: readonly SkinPart[], k: number, t: number, y: number): number | null {
  const { nx, nz, rx, rz } = faceAxes(skin, k);
  const ox = skin.box.x + rx * t;
  const oz = skin.box.z + rz * t;
  let best: number | null = null;
  for (const p of parts) {
    if (p.top < y) continue;
    const r = p.ring;
    const m = r.length / 2;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      const ex = r[j * 2] - r[i * 2], ez = r[j * 2 + 1] - r[i * 2 + 1];
      // o + s·n = r_i + u·e
      const den = nx * -ez - nz * -ex;
      if (Math.abs(den) < 1e-9) continue;
      const qx = r[i * 2] - ox, qz = r[i * 2 + 1] - oz;
      const s = (qx * -ez - qz * -ex) / den;
      const u = (nx * qz - nz * qx) / den;
      if (u < 0 || u > 1) continue;
      if (best === null || s > best) best = s;
    }
  }
  return best;
}

/** How far face k of the box stands from its centre: the furthest any part reaches along its normal (m). */
function boxHalf(skin: TowerSkin, parts: readonly SkinPart[], k: number): number {
  const { nx, nz } = faceAxes(skin, k);
  let m = -Infinity;
  for (const p of parts) for (let i = 0; i < p.ring.length; i += 2) m = Math.max(m, (p.ring[i] - skin.box.x) * nx + (p.ring[i + 1] - skin.box.z) * nz);
  return m;
}

/** World point at (t across, s out) on face k. */
function facePoint(skin: TowerSkin, k: number, t: number, s: number): [number, number] {
  const { nx, nz, rx, rz } = faceAxes(skin, k);
  return [skin.box.x + rx * t + nx * s, skin.box.z + rz * t + nz * s];
}

/**
 * Segments (t, h → t, h in mesh m) on face k as beams 0.5 m proud of the outermost wall (or, `ribbon`, flat strips
 * 0.3 m proud: drawn lines), following it in steps of about 3 m and merged into one member wherever the wall is one
 * plane, clipped to [hMin, hMax]: only on the face itself (a wall set far back is another face's), and broken where
 * the wall steps.
 */
function faceBeams(
  B: GeometryBuilder,
  skin: TowerSkin,
  parts: readonly SkinPart[],
  g: number,
  k: number,
  half: number,
  segs: readonly (readonly [number, number, number, number])[],
  hMin: number,
  hMax: number,
  width: number,
  colour: number,
  ribbon = false,
): void {
  const yOf = (h: number) => g + h + skin.dy;
  const { nx, nz } = faceAxes(skin, k);
  type P = [number, number, number, number];
  // one member from a to b: a box beam, or a flat ribbon facing out (a drawn line: 2 triangles, not 8)
  const member = (a: P, b: P) => {
    if (a === b) return;
    if (!ribbon) {
      B.beam(IDENT_FRAME, a[0], a[1], a[2], b[0], b[1], b[2], width, colour);
      return;
    }
    // across the line in the wall's plane: (b − a) × n
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    let sx = dy * nz, sy = dz * nx - dx * nz, sz = -dy * nx;
    const l = Math.hypot(sx, sy, sz) || 1;
    sx *= width / 2 / l;
    sy *= width / 2 / l;
    sz *= width / 2 / l;
    const q = [a[0] - sx, a[1] - sy, a[2] - sz, b[0] - sx, b[1] - sy, b[2] - sz, b[0] + sx, b[1] + sy, b[2] + sz, a[0] + sx, a[1] + sy, a[2] + sz];
    // facing out: (p1 − p0) × (p3 − p0) along +n
    const ux = q[3] - q[0], uy = q[4] - q[1], uz = q[5] - q[2], vx = q[9] - q[0], vy = q[10] - q[1], vz = q[11] - q[2];
    const out = (uy * vz - uz * vy) * nx + (ux * vy - uy * vx) * nz;
    B.quad(IDENT_FRAME, out >= 0 ? q : [...q.slice(9, 12), ...q.slice(6, 9), ...q.slice(3, 6), ...q.slice(0, 3)], colour);
  };
  for (const [ta, ha, tb, hb] of segs) {
    const c0 = Math.max(hMin, Math.min(ha, hb)), c1 = Math.min(hMax, Math.max(ha, hb));
    if (c1 < c0 || (c1 === c0 && ha !== hb)) continue;
    const at = (h: number) => ta + ((tb - ta) * (h - ha)) / (hb - ha || 1);
    const flat = ha === hb;
    const pieces = Math.max(1, Math.ceil((flat ? Math.abs(tb - ta) : Math.hypot(at(c1) - at(c0), c1 - c0)) / 3));
    // walk the segment in ~3 m steps on the outermost wall; pieces on one wall plane merge into one member
    let start: P | null = null;
    let last: P | null = null;
    for (let i = 0; i <= pieces; i++) {
      const h = flat ? c0 : c0 + ((c1 - c0) * i) / pieces;
      const t = flat ? ta + ((tb - ta) * i) / pieces : at(h);
      const y = yOf(h);
      const s = outerWall(skin, parts, k, t, y);
      let p: P | null = null;
      if (s !== null && s >= half - 6) {
        const [x, z] = facePoint(skin, k, t, s + (ribbon ? 0.3 : 0.5));
        p = [x, y, z, s];
      }
      if (!p || !last || Math.abs(p[3] - last[3]) >= 1.5) {
        // a break: off the face, or where the wall steps
        if (start && last) member(start, last);
        start = last = p;
        continue;
      }
      if (Math.abs(p[3] - start![3]) < 0.05 && Math.abs(last[3] - start![3]) < 0.05) {
        last = p;
        continue;
      }
      member(start!, last);
      if (Math.abs(p[3] - last[3]) >= 0.05) {
        member(last, p);
        start = last = p;
      } else {
        start = last;
        last = p;
      }
    }
    if (start && last) member(start, last);
  }
}

/** The skin's bracing (an X per module and the mullion where they cross) and its drawn lines, as beams on the walls. */
export function buildBraces(B: GeometryBuilder, skin: TowerSkin, parts: readonly SkinPart[], g: number): void {
  const half = [0, 1, 2, 3].map((k) => boxHalf(skin, parts, k));
  for (const br of skin.braces ?? []) {
    const k = faceOf(skin, br.face);
    const [t0, t1] = br.t;
    const segs: [number, number, number, number][] = [];
    const first = br.node - Math.ceil((br.node - br.h[0]) / br.module) * br.module;
    for (let h = first; h < br.h[1]; h += br.module) {
      segs.push([t0, h, t1, h + br.module]);
      segs.push([t1, h, t0, h + br.module]);
    }
    if (!br.noMullion) segs.push([(t0 + t1) / 2, br.h[0], (t0 + t1) / 2, br.h[1]]);
    faceBeams(B, skin, parts, g, k, half[k], segs, br.h[0], br.h[1], br.width, br.colour);
  }
  for (const ln of skin.lines ?? []) {
    const k = faceOf(skin, ln.face);
    const segs: [number, number, number, number][] = [];
    for (let i = 0; i + 3 < ln.pts.length; i += 2) segs.push([ln.pts[i], ln.pts[i + 1], ln.pts[i + 2], ln.pts[i + 3]]);
    faceBeams(B, skin, parts, g, k, half[k], segs, -Infinity, Infinity, ln.width, ln.colour, true);
  }
}

/* ───────────────────────────── Signs ───────────────────────────── */

/** Sign geometry (world positions, normals, uv) of the skinned towers, and each sign's vertex range by building. */
export interface TowerSignData {
  pos: number[];
  nrm: number[];
  uv: number[];
  idx: number[];
  /** [building index, v0, v1) of each tower's signs. */
  ranges: [number, number, number][];
}

export function emptySigns(): TowerSignData {
  return { pos: [], nrm: [], uv: [], idx: [], ranges: [] };
}

/** One tower's signs, 0.3 m proud of its outermost wall at each sign's middle. */
export function addTowerSigns(out: TowerSignData, building: number, skin: TowerSkin, parts: readonly SkinPart[], g: number): void {
  const v0 = out.pos.length / 3;
  for (const s of skin.signs ?? []) {
    const k = faceOf(skin, s.face);
    const sl = logoSlot(s.logo);
    const h = s.w / sl.aspect;
    const y = g + s.h + skin.dy;
    // in front of the wall across its whole width (a terrace standing proud of its middle would cut it)
    let out_: number | null = null;
    for (let i = 0; i <= 8; i++) {
      const o = outerWall(skin, parts, k, s.t + s.w * (i / 8 - 0.5), y);
      if (o !== null) out_ = out_ === null ? o : Math.max(out_, o);
    }
    if (out_ === null) continue;
    const { nx, nz } = faceAxes(skin, k);
    const [l0, l1] = [facePoint(skin, k, s.t - s.w / 2, out_ + 0.3), facePoint(skin, k, s.t + s.w / 2, out_ + 0.3)];
    const a = out.pos.length / 3;
    // left-bottom, right-bottom, right-top, left-top as seen from outside (t grows to the viewer's right)
    out.pos.push(l0[0], y - h / 2, l0[1], l1[0], y - h / 2, l1[1], l1[0], y + h / 2, l1[1], l0[0], y + h / 2, l0[1]);
    for (let i = 0; i < 4; i++) out.nrm.push(nx, 0, nz);
    out.uv.push(sl.u0, sl.v0, sl.u1, sl.v0, sl.u1, sl.v1, sl.u0, sl.v1);
    // facing out: (b − a) × (d − a) along +n
    out.idx.push(a, a + 1, a + 2, a, a + 2, a + 3);
  }
  const v1 = out.pos.length / 3;
  if (v1 > v0) out.ranges.push([building, v0, v1]);
}

export function towerSignGeometry(d: TowerSignData): BufferGeometry | null {
  if (!d.idx.length) return null;
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(d.pos), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(d.nrm), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(d.uv), 2));
  geo.setIndex(d.idx);
  geo.computeBoundingSphere();
  return geo;
}

/** The parts of a kit tower as the skin sees them (world roofs), for placing braces and signs. */
export function skinParts(prisms: readonly { ring: ArrayLike<number>; h: number; kind?: string }[], g: number): SkinPart[] {
  return prisms.filter((p) => p.kind !== 'podium').map((p) => ({ ring: p.ring, top: g + p.h }));
}

