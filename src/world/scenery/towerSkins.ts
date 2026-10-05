/**
 * The CBD tower kit's skins (core/cbdTowerSkins.ts) in the scenery: walls painted by zone (by face and height, split
 * where a zone starts or ends, so the facade shaders' world-anchored patterns run on across the joins), bracing as
 * beams on the outermost wall of each face, and the crown signs as one small mesh with a logo atlas (canvas texture,
 * createLogoMaterial). Built from the same terraces the sim collides with.
 */
import { BufferAttribute, BufferGeometry, CanvasTexture, SRGBColorSpace } from 'three';
import type { SkinFinish, SkinLogo, SkinZone, TowerSkin } from '../../core/cbdTowerSkins';
import { GeometryBuilder, IDENT_FRAME, WIN_BANDS, WIN_CURTAIN, WIN_FLOOD, WIN_GLOW, WIN_HERITAGE, WIN_NONE, WIN_OFFICE } from './GeometryBuilder';

const FINISH_WIN: Record<SkinFinish, number> = { glass: WIN_CURTAIN, bands: WIN_BANDS, punched: WIN_OFFICE, plain: WIN_FLOOD, glow: WIN_GLOW, none: WIN_NONE, stone: WIN_HERITAGE };

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

/** The skin's bracing as beams 0.5 m proud of the outermost wall, in pieces of about 3 m that follow it. */
export function buildBraces(B: GeometryBuilder, skin: TowerSkin, parts: readonly SkinPart[], g: number): void {
  const half = [0, 1, 2, 3].map((k) => boxHalf(skin, parts, k));
  for (const br of skin.braces ?? []) {
    const k = faceOf(skin, br.face);
    const [t0, t1] = br.t;
    const yOf = (h: number) => g + h + skin.dy;
    // an X per module: two diagonals from edge to edge between nodes a module apart
    const segs: [number, number, number, number][] = [];
    const first = br.node - Math.ceil((br.node - br.h[0]) / br.module) * br.module;
    for (let h = first; h < br.h[1]; h += br.module) {
      segs.push([t0, h, t1, h + br.module]);
      segs.push([t1, h, t0, h + br.module]);
    }
    // the mullion where the X's cross
    segs.push([(t0 + t1) / 2, br.h[0], (t0 + t1) / 2, br.h[1]]);
    for (const [ta, ha, tb, hb] of segs) {
      // clip to the band's heights
      const c0 = Math.max(br.h[0], Math.min(ha, hb)), c1 = Math.min(br.h[1], Math.max(ha, hb));
      if (c1 <= c0) continue;
      const at = (h: number) => ta + ((tb - ta) * (h - ha)) / (hb - ha || 1);
      const pieces = Math.max(1, Math.ceil(Math.hypot(at(c1) - at(c0), c1 - c0) / 3));
      let prev: [number, number, number, number] | null = null;
      for (let i = 0; i <= pieces; i++) {
        const h = ha === hb ? c0 : c0 + ((c1 - c0) * i) / pieces;
        const t = ha === hb ? ta + ((tb - ta) * i) / pieces : at(h);
        const y = yOf(h);
        const s = outerWall(skin, parts, k, t, y);
        // only on the face itself (a wall set far back is another face's), and broken where the wall steps
        if (s === null || s < half[k] - 6) {
          prev = null;
          continue;
        }
        const [x, z] = facePoint(skin, k, t, s + 0.5);
        if (prev && Math.abs(prev[3] - s) < 1.5) B.beam(IDENT_FRAME, prev[0], prev[1], prev[2], x, y, z, br.width, br.colour);
        prev = [x, y, z, s];
      }
    }
  }
}

/* ───────────────────────────── Signs ───────────────────────────── */

/** A logo's place in the atlas (uv, v up) and its width : height. */
interface AtlasSlot {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  aspect: number;
}

const ATLAS = 1024;
const ROW = 160;
const LOGO_ASPECT: Record<SkinLogo, number> = { hsbc: 3.3, anz: 2.8, vero: 3.2, pwc: 1.6, qbe: 3.4, waitemata: 5 };
const LOGOS = Object.keys(LOGO_ASPECT) as SkinLogo[];

function slot(logo: SkinLogo): AtlasSlot {
  const row = LOGOS.indexOf(logo);
  const aspect = LOGO_ASPECT[logo];
  const w = Math.min(ATLAS, Math.round(ROW * aspect));
  const top = row * ROW;
  // a pixel's margin keeps the mips of the next row out
  return { u0: 1 / ATLAS, u1: (w - 1) / ATLAS, v0: 1 - (top + ROW - 1) / ATLAS, v1: 1 - (top + 1) / ATLAS, aspect };
}

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
    const sl = slot(s.logo);
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

/**
 * The logo atlas: each sign drawn as text with a simple stand-in mark, in full colour on a clear ground (alpha-tested
 * by createLogoMaterial), one row of ROW px each.
 */
export function drawTowerLogos(canvas: HTMLCanvasElement): void {
  const c = canvas.getContext('2d')!;
  c.clearRect(0, 0, canvas.width, canvas.height);
  const font = (px: number, weight = 'bold') => `${weight} ${Math.round(px)}px "Helvetica Neue", Arial, sans-serif`;
  const text = (s: string, x: number, y: number, size: number, room: number, fill: string, weight = 'bold') => {
    c.font = font(size, weight);
    c.fillStyle = fill;
    c.textBaseline = 'middle';
    const tw = c.measureText(s).width;
    c.save();
    c.translate(x, y);
    c.scale(Math.min(1, room / tw), 1);
    c.fillText(s, 0, 0);
    c.restore();
  };
  for (const logo of LOGOS) {
    const top = LOGOS.indexOf(logo) * ROW;
    const w = Math.round(ROW * LOGO_ASPECT[logo]);
    const H = ROW;
    const mid = top + H / 2;
    c.save();
    switch (logo) {
      case 'hsbc': {
        // a red and white hexagon (two red wedges each side of a white bow tie), black letters
        const r = H * 0.42;
        const hx = H * 0.55;
        c.fillStyle = '#ffffff';
        c.beginPath();
        c.moveTo(hx - r * 1.3, mid);
        c.lineTo(hx - r * 0.65, mid - r);
        c.lineTo(hx + r * 0.65, mid - r);
        c.lineTo(hx + r * 1.3, mid);
        c.lineTo(hx + r * 0.65, mid + r);
        c.lineTo(hx - r * 0.65, mid + r);
        c.closePath();
        c.fill();
        c.fillStyle = '#db0011';
        for (const s of [-1, 1]) {
          c.beginPath();
          c.moveTo(hx + s * r * 1.3, mid);
          c.lineTo(hx + s * r * 0.65, mid - r);
          c.lineTo(hx, mid);
          c.lineTo(hx + s * r * 0.65, mid + r);
          c.closePath();
          c.fill();
          c.beginPath();
          c.moveTo(hx - r * 0.65, mid + s * r);
          c.lineTo(hx + r * 0.65, mid + s * r);
          c.lineTo(hx, mid);
          c.closePath();
          c.fill();
        }
        text('HSBC', H * 1.25, mid + H * 0.03, H * 0.62, w - H * 1.35, '#1a1a1a');
        break;
      }
      case 'anz': {
        // white letters and a round figure mark, for the blue crown box
        text('ANZ', H * 0.08, mid + H * 0.03, H * 0.8, w - H * 1.1, '#ffffff', '900');
        const mx = w - H * 0.55;
        c.fillStyle = '#ffffff';
        c.beginPath();
        c.arc(mx, mid - H * 0.2, H * 0.13, 0, Math.PI * 2);
        c.fill();
        c.beginPath();
        c.ellipse(mx, mid + H * 0.17, H * 0.3, H * 0.2, 0, Math.PI, 0);
        c.fill();
        break;
      }
      case 'vero':
        // lower-case red letters and a tick
        text('vero', H * 0.05, mid, H * 0.95, w - H * 0.7, '#d8436f', '600');
        c.strokeStyle = '#d8436f';
        c.lineWidth = H * 0.08;
        c.beginPath();
        c.moveTo(w - H * 0.55, mid - H * 0.25);
        c.lineTo(w - H * 0.38, mid + H * 0.2);
        c.lineTo(w - H * 0.12, mid - H * 0.4);
        c.stroke();
        break;
      case 'pwc': {
        // stacked warm blocks over pale letters
        const cols = ['#ffb600', '#eb8c00', '#e0301e', '#d93954'];
        cols.forEach((col, i) => {
          c.fillStyle = col;
          c.fillRect(w * (0.42 + i * 0.07), top + H * (0.06 + i * 0.07), w * 0.36, H * 0.13);
        });
        text('pwc', w * 0.08, top + H * 0.7, H * 0.5, w * 0.84, '#f4f4f2');
        break;
      }
      case 'qbe':
        // a blue disc and white letters, for the dark crown
        c.fillStyle = '#2e9be6';
        c.beginPath();
        c.arc(H * 0.45, mid, H * 0.36, 0, Math.PI * 2);
        c.fill();
        text('QBE', H * 1.0, mid + H * 0.03, H * 0.75, w - H * 1.05, '#ffffff', '900');
        break;
      case 'waitemata': {
        // the station's name in white beside a yellow roundel with a dark train front (a stand-in for the transport
        // mark), over the Glasshouse's canopy
        const r = H * 0.36;
        const cx = H * 0.45;
        c.fillStyle = '#ffd200';
        c.beginPath();
        c.arc(cx, mid, r, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = '#1d1d1b';
        c.fillRect(cx - r * 0.42, mid - r * 0.55, r * 0.84, r * 0.85);
        c.fillRect(cx - r * 0.5, mid + r * 0.42, r * 0.22, r * 0.2);
        c.fillRect(cx + r * 0.28, mid + r * 0.42, r * 0.22, r * 0.2);
        c.fillStyle = '#ffd200';
        c.fillRect(cx - r * 0.3, mid - r * 0.42, r * 0.6, r * 0.32);
        text('Waitematā', H * 1.0, mid + H * 0.03, H * 0.62, w - H * 1.05, '#ffffff', '600');
        break;
      }
    }
    c.restore();
  }
}

/** The logo atlas texture (browser only). */
export function createTowerLogoTexture(anisotropy: number): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS;
  canvas.height = ATLAS;
  drawTowerLogos(canvas);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = anisotropy;
  return tex;
}

/** The parts of a kit tower as the skin sees them (world roofs), for placing braces and signs. */
export function skinParts(prisms: readonly { ring: ArrayLike<number>; h: number; kind?: string }[], g: number): SkinPart[] {
  return prisms.filter((p) => p.kind !== 'podium').map((p) => ({ ring: p.ring, top: g + p.h }));
}

