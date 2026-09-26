/**
 * "Planar-by-facing" atlas UV mapping + a canvas painter working in MODEL coordinates.
 *
 * Every triangle picks a projection from its face normal:
 *   top (n.y > T)      → planform |x|,z   atlas u∈[0.00,0.25]
 *   bottom (n.y < -T)  → planform |x|,z   atlas u∈[0.25,0.50]
 *   left side (n.x<0)  → z,y              atlas u∈[0.5,1], v∈[0,0.25]
 *   right side (n.x>0) → z,y              atlas u∈[0.5,1], v∈[0.25,0.5]
 *   front/back         → |x|,y            atlas u∈[0.5,1], v∈[0.5,1]
 * so a livery (panel lines, camouflage, insignia, numbers) can be painted once in model space and it
 * lands coherently on the fuselage, wings and tails.
 */
import type { BufferGeometry } from 'three';

export interface AtlasBounds {
  /** Max |x| (half span incl. margin). */
  xMax: number;
  zMin: number;
  zMax: number;
  yMin: number;
  yMax: number;
}

export type AtlasRegion = 'top' | 'bottom' | 'left' | 'right' | 'front';

const T = 0.55;
const PAD = 0.004;

/** UV rectangles [u0, v0, uw, vh] per region. */
export const REGION_RECT: Record<AtlasRegion, [number, number, number, number]> = {
  top: [0, 0, 0.25, 1],
  bottom: [0.25, 0, 0.25, 1],
  left: [0.5, 0, 0.5, 0.25],
  right: [0.5, 0.25, 0.5, 0.25],
  front: [0.5, 0.5, 0.5, 0.5],
};

/** Assign atlas UVs to a canonical (non-indexed) geometry in model space. */
export function applyAtlasUVs(geo: BufferGeometry, b: AtlasBounds): BufferGeometry {
  const p = geo.attributes.position.array as Float32Array;
  const uv = geo.attributes.uv.array as Float32Array;
  const L = b.zMax - b.zMin;
  const H = b.yMax - b.yMin;
  for (let t = 0; t < p.length / 9; t++) {
    const o = t * 9;
    // face normal
    const ax = p[o + 3] - p[o];
    const ay = p[o + 4] - p[o + 1];
    const az = p[o + 5] - p[o + 2];
    const bx = p[o + 6] - p[o];
    const by = p[o + 7] - p[o + 1];
    const bz = p[o + 8] - p[o + 2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    let region: AtlasRegion;
    if (ny > T) region = 'top';
    else if (ny < -T) region = 'bottom';
    else if (Math.abs(nx) >= Math.abs(nz) * 0.9) region = nx < 0 ? 'left' : 'right';
    else region = 'front';
    const [u0, v0, uw, vh] = REGION_RECT[region];
    for (let k = 0; k < 3; k++) {
      const x = p[o + k * 3];
      const y = p[o + k * 3 + 1];
      const z = p[o + k * 3 + 2];
      let s: number;
      let r: number;
      if (region === 'top' || region === 'bottom') {
        s = Math.abs(x) / b.xMax;
        r = (z - b.zMin) / L;
      } else if (region === 'front') {
        s = Math.abs(x) / b.xMax;
        r = (y - b.yMin) / H;
      } else {
        s = (z - b.zMin) / L;
        r = (y - b.yMin) / H;
      }
      s = Math.min(1 - PAD, Math.max(PAD, s));
      r = Math.min(1 - PAD, Math.max(PAD, r));
      const idx = (t * 3 + k) * 2;
      uv[idx] = u0 + s * uw;
      uv[idx + 1] = v0 + r * vh;
    }
  }
  geo.attributes.uv.needsUpdate = true;
  return geo;
}

/* ───────────────────────── canvas helpers (node-safe) ───────────────────────── */

export type Canvas2D = HTMLCanvasElement | OffscreenCanvas;
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Create a 2D canvas, or null when no DOM/OffscreenCanvas exists (unit tests in node). */
export function createCanvas(w: number, h: number): Canvas2D | null {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  return null;
}

/** Deterministic PRNG for painters. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Paints into atlas regions using model coordinates. `with(region, fn)` sets a canvas transform so
 * that drawing at (a, b) means: top/bottom → (|x|, z); left/right → (z, y); front → (|x|, y).
 */
export class AtlasPainter {
  readonly W: number;
  readonly H: number;
  constructor(
    readonly ctx: Ctx2D,
    readonly b: AtlasBounds,
  ) {
    this.W = ctx.canvas.width;
    this.H = ctx.canvas.height;
  }

  /** Pixels per model metre (approx) in a region along its first axis. */
  pxPerM(region: AtlasRegion): number {
    const [, , uw] = REGION_RECT[region];
    const span = region === 'left' || region === 'right' ? this.b.zMax - this.b.zMin : this.b.xMax;
    return (uw * this.W) / span;
  }

  with(region: AtlasRegion, fn: (ctx: Ctx2D) => void, clip = true): void {
    const { ctx, W, H, b } = this;
    const [u0, v0, uw, vh] = REGION_RECT[region];
    const L = b.zMax - b.zMin;
    const HY = b.yMax - b.yMin;
    ctx.save();
    // clip to the region's pixel rectangle
    if (clip) {
      ctx.beginPath();
      ctx.rect(u0 * W, (1 - v0 - vh) * H, uw * W, vh * H);
      ctx.clip();
    }
    // canvas px = (u*W, (1-v)*H)
    if (region === 'top' || region === 'bottom') {
      // a=|x| → u, b=z → v
      const sx = (uw * W) / b.xMax;
      const sz = (vh * H) / L;
      ctx.setTransform(sx, 0, 0, -sz, u0 * W, (1 - v0) * H + b.zMin * sz);
    } else if (region === 'front') {
      const sx = (uw * W) / b.xMax;
      const sy = (vh * H) / HY;
      ctx.setTransform(sx, 0, 0, -sy, u0 * W, (1 - v0) * H + b.yMin * sy);
    } else {
      const sz = (uw * W) / L;
      const sy = (vh * H) / HY;
      ctx.setTransform(sz, 0, 0, -sy, u0 * W - b.zMin * sz, (1 - v0) * H + b.yMin * sy);
    }
    fn(ctx);
    ctx.restore();
  }

  /** Fill every region with a colour. */
  fillAll(color: string): void {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, this.W, this.H);
  }

  /** Polygon in the current region's model coordinates. */
  static poly(ctx: Ctx2D, pts: [number, number][], fill?: string, stroke?: string, lw = 0.02): void {
    ctx.beginPath();
    pts.forEach(([a, c], i) => (i === 0 ? ctx.moveTo(a, c) : ctx.lineTo(a, c)));
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = lw;
      ctx.stroke();
    }
  }

  static line(ctx: Ctx2D, pts: [number, number][], stroke: string, lw = 0.02): void {
    ctx.beginPath();
    pts.forEach(([a, c], i) => (i === 0 ? ctx.moveTo(a, c) : ctx.lineTo(a, c)));
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.stroke();
  }

  /** Sawtooth outline of a rectangle [a0,a1]×[c0,c1] with teeth along the c-edges (front/back). */
  static sawRect(ctx: Ctx2D, a0: number, a1: number, c0: number, c1: number, teeth: number, depth: number, stroke: string, lw = 0.02): void {
    ctx.beginPath();
    const w = (a1 - a0) / teeth;
    ctx.moveTo(a0, c0);
    for (let i = 0; i < teeth; i++) {
      ctx.lineTo(a0 + (i + 0.5) * w, c0 - depth);
      ctx.lineTo(a0 + (i + 1) * w, c0);
    }
    ctx.lineTo(a1, c1);
    for (let i = teeth - 1; i >= 0; i--) {
      ctx.lineTo(a0 + (i + 0.5) * w, c1 + depth);
      ctx.lineTo(a0 + i * w, c1);
    }
    ctx.closePath();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw;
    ctx.stroke();
  }

  /** Five-pointed star centred at (a, c) with outer radius r (model units). */
  static star(ctx: Ctx2D, a: number, c: number, r: number, fill: string, border?: string, borderW = 0): void {
    const pts: [number, number][] = [];
    for (let i = 0; i < 10; i++) {
      const ang = Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 === 0 ? r : r * 0.4;
      pts.push([a + Math.cos(ang) * rr, c + Math.sin(ang) * rr]);
    }
    if (border && borderW > 0) AtlasPainter.poly(ctx, pts, undefined, border, borderW);
    AtlasPainter.poly(ctx, pts, fill);
  }

  /**
   * Text at (a, c) with glyph height h (model units). `mirror` flips horizontally (use it on the
   * RIGHT side region so the text reads correctly there).
   */
  static text(ctx: Ctx2D, str: string, a: number, c: number, h: number, fill: string, mirror = false, font = 'bold'): void {
    ctx.save();
    ctx.translate(a, c);
    ctx.scale(mirror ? -1 : 1, -1); // region transforms flip y; undo it for glyphs
    ctx.font = `${font} 100px sans-serif`;
    const k = h / 72;
    ctx.scale(k, k);
    ctx.fillStyle = fill;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(str, 0, 0);
    ctx.restore();
  }

  /** Soft random mottle over the whole canvas (brightness variation). */
  mottle(seed: number, count: number, alpha: number, minR = 0.02, maxR = 0.08): void {
    const r = rng(seed);
    const { ctx, W, H } = this;
    for (let i = 0; i < count; i++) {
      const x = r() * W;
      const y = r() * H;
      const rad = (minR + r() * (maxR - minR)) * W;
      const light = r() > 0.5;
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      const c = light ? '255,255,255' : '0,0,0';
      g.addColorStop(0, `rgba(${c},${alpha})`);
      g.addColorStop(1, `rgba(${c},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
  }

  /** Fine per-pixel noise (grain) — cheap: random 1-px dots. */
  grain(seed: number, density: number, alpha: number): void {
    const r = rng(seed);
    const { ctx, W, H } = this;
    const n = Math.floor(W * H * density);
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = r() > 0.5 ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha})`;
      ctx.fillRect(Math.floor(r() * W), Math.floor(r() * H), 1 + Math.floor(r() * 2), 1);
    }
  }

  /**
   * Camouflage blobs in a region: random smooth blobs of the given colours (model coordinates,
   * blob size in metres).
   */
  camo(region: AtlasRegion, seed: number, colors: string[], count: number, size: number, bounds: [number, number, number, number]): void {
    const r = rng(seed);
    this.with(region, (ctx) => {
      for (let i = 0; i < count; i++) {
        ctx.fillStyle = colors[i % colors.length];
        const cx = bounds[0] + r() * (bounds[2] - bounds[0]);
        const cy = bounds[1] + r() * (bounds[3] - bounds[1]);
        const s = size * (0.5 + r());
        ctx.beginPath();
        const pts = 9;
        for (let k = 0; k <= pts; k++) {
          const a = (k / pts) * Math.PI * 2;
          const rr = s * (0.55 + 0.45 * r());
          const px = cx + Math.cos(a) * rr * 1.4;
          const py = cy + Math.sin(a) * rr;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.quadraticCurveTo(cx + Math.cos(a - 0.35) * rr * 1.9, cy + Math.sin(a - 0.35) * rr * 1.3, px, py);
        }
        ctx.closePath();
        ctx.fill();
      }
    });
  }
}
